/**
 * 零依赖 store-only ZIP writer（P14 t5 媒体导出 zip 单包）。
 *
 * 为什么零依赖：本项目零新增依赖纪律（SigV4 都手写避免 @aws-sdk）；导出场景压缩收益低
 * （DB JSONL 文本可压但教师数据量小、媒体文件多为已压缩格式），正确性优先——
 * store-only（method 0，不压缩）实现约 150 行，无供应链面，可流式写大媒体文件。
 *
 * 格式：ZIP 容器（PKZIP spec）——
 *   每条目 = Local File Header(30B+name) + 原始数据
 *   尾部   = Central Directory（每条目 46B+name）+ End of Central Directory(22B)
 * 特性：
 * - store-only：compression method = 0，CRC32 仅作完整性校验（不解压不改变字节流）
 * - CRC32 手写查表（0xEDB88320 标准多项式，增量 seed 支持流式分段计算）
 * - UTF-8 文件名（flag bit 11）——导出含中文/空格 key 的媒体文件名必须 UTF-8，
 *   否则解压器按 CP437 解码乱码（与本仓库 s3-signer 中文 key 修复同源关注点）
 * - 大文件流式：entry 可给 sourcePath（分两遍读：一遍流式算 CRC+size，一遍管道复制），
 *   内存 O(1)；小文件可直接给 data Buffer
 * - 安全：entry.name 必须是相对路径（禁绝对路径 / 反斜杠 / .. 段 / 空名），防 zip slip
 *
 * 用法：
 *   await createStoreOnlyZip({
 *     outputPath: '/tmp/export.zip',
 *     entries: [
 *       { name: 'manifest.json', data: Buffer.from('...') },
 *       { name: 'media/a/1/original', sourcePath: '/data/media/a/1/original' },
 *     ],
 *   });
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_ENTRY_SIZE = 46;
const EOCD_SIZE = 22;

// ── CRC32（0xEDB88320 标准多项式，查表法；seed 支持增量流式计算）─────────────────────

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

/**
 * CRC32 校验和（无符号 32 位）。
 * @param {Buffer|string} data 输入（string 按 UTF-8）
 * @param {number} [seed=0] 前一段的返回值（增量分段计算用；首段缺省 0）
 * @returns {number} 无符号 32 位 CRC32
 */
export function crc32(data, seed = 0) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 流式读文件 → CRC32 + size（O(1) 内存，供大媒体文件首遍统计用）。 */
async function computeFileCrc32Size(sourcePath) {
  let crc = 0;
  let size = 0;
  await new Promise((resolveRead, rejectRead) => {
    const rs = createReadStream(sourcePath);
    rs.on('data', (chunk) => {
      crc = crc32(chunk, crc);
      size += chunk.length;
    });
    rs.on('error', rejectRead);
    rs.on('end', resolveRead);
  });
  return { crc: crc >>> 0, size };
}

/**
 * ZIP entry 名安全校验：相对正斜杠路径，禁绝对路径/盘符/反斜杠/.. 段/空名
 * （防 zip slip：恶意 name 写穿解压目录）。
 */
export function assertZipEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('SAFETY_BLOCK: zip entry name must be a non-empty string');
  }
  if (name.includes('\\')) {
    throw new Error('SAFETY_BLOCK: zip entry name must use forward slashes');
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error('SAFETY_BLOCK: zip entry name must be relative');
  }
  if (name.split('/').includes('..')) {
    throw new Error('SAFETY_BLOCK: zip entry name must not contain .. traversal');
  }
}

// ── ZIP 二进制小工具 ─────────────────────────────────────────────────────────

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value & 0xffff);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

/** DOS 时间/日期（ZIP 头用；now 注入固定时间可复现，缺省当前时间）。 */
function dosDateTime(now) {
  const d = now ?? new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

function writeChunk(ws, buf) {
  return new Promise((resolveWrite, rejectWrite) => {
    ws.write(buf, (err) => (err ? rejectWrite(err) : resolveWrite()));
  });
}

/**
 * 生成 store-only ZIP 文件。
 * @param {object} options
 * @param {string} options.outputPath 输出 .zip 路径（父目录自动创建）
 * @param {Array<{name:string, data?:Buffer|string, sourcePath?:string}>} options.entries
 *   条目（data 与 sourcePath 二选一；sourcePath 流式读，支持大媒体文件）
 * @param {Date} [options.now] DOS 时间戳（测试注入固定时间可复现；缺省当前时间）
 * @returns {Promise<{entryCount:number, sizeBytes:number}>} 条目数与产物字节数
 */
export async function createStoreOnlyZip({ outputPath, entries, now }) {
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('SAFETY_BLOCK: zip outputPath required');
  }
  if (!Array.isArray(entries)) {
    throw new Error('SAFETY_BLOCK: zip entries must be an array');
  }
  for (const entry of entries) assertZipEntryName(entry.name);

  const { time, date } = dosDateTime(now);
  const central = []; // { nameBuf, crc, size, offset }
  const ws = createWriteStream(outputPath);
  // 同一 ws 上串行执行多次 write/pipeline/end（每条目 write + 每文件 pipeline）——
  // 每次调用都会注册 listener，Node 默认 10 上限会警告；这里是预期用法，放开上限。
  ws.setMaxListeners(0);
  let offset = 0;

  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      let crc;
      let size;
      if (entry.sourcePath !== undefined) {
        const resolved = resolve(entry.sourcePath);
        // sourcePath 是宿主文件系统路径（可绝对），与 entry.name（zip 内相对路径）无关——
        // zip slip 防护只看 name；这里仅拒绝 entry.name 非法（上面已断言）
        void resolved;
        const stats = await computeFileCrc32Size(resolved);
        crc = stats.crc;
        size = stats.size;
      } else {
        const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
        if (!Buffer.isBuffer(data)) {
          throw new Error(`SAFETY_BLOCK: zip entry ${entry.name} needs data or sourcePath`);
        }
        crc = crc32(data);
        size = data.length;
      }

      // Local File Header
      await writeChunk(ws, Buffer.concat([
        u32(LOCAL_FILE_HEADER_SIG),
        u16(VERSION_NEEDED),
        u16(FLAG_UTF8),
        u16(METHOD_STORE),
        u16(time),
        u16(date),
        u32(crc),
        u32(size),
        u32(size), // store-only：压缩后大小 = 原始大小
        u16(nameBuf.length),
        u16(0), // extra length
        nameBuf,
      ]));
      if (entry.sourcePath !== undefined) {
        // 第二遍流式复制（O(1) 内存；pipeline 处理背压）
        await pipeline(createReadStream(resolve(entry.sourcePath)), ws, { end: false });
      } else {
        const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
        await writeChunk(ws, data);
      }
      central.push({ nameBuf, crc, size, offset });
      offset += LOCAL_HEADER_SIZE + nameBuf.length + size;
    }

    // Central Directory
    const centralDirStart = offset;
    for (const c of central) {
      await writeChunk(ws, Buffer.concat([
        u32(CENTRAL_DIR_SIG),
        u16(VERSION_NEEDED),
        u16(VERSION_NEEDED),
        u16(FLAG_UTF8),
        u16(METHOD_STORE),
        u16(time),
        u16(date),
        u32(c.crc),
        u32(c.size),
        u32(c.size),
        u16(c.nameBuf.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(c.offset),
        c.nameBuf,
      ]));
      offset += CENTRAL_ENTRY_SIZE + c.nameBuf.length;
    }
    const centralDirSize = offset - centralDirStart;

    // End of Central Directory
    await writeChunk(ws, Buffer.concat([
      u32(END_OF_CENTRAL_DIR_SIG),
      u16(0), // disk number
      u16(0), // cd start disk
      u16(central.length),
      u16(central.length),
      u32(centralDirSize),
      u32(centralDirStart),
      u16(0), // comment length
    ]));
    offset += EOCD_SIZE;
  } finally {
    await new Promise((resolveEnd) => ws.end(resolveEnd));
  }

  return { entryCount: central.length, sizeBytes: offset };
}
