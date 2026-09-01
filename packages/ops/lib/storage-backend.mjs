/**
 * 备份/媒体存储抽象（P7 B1，t12 设计 §3.1 + P11 t2 对象存储落地）。
 *
 * StorageBackend 接口：put/get/list/delete，与设计一致——
 * 阶段一实现 LocalDirStorage；阶段二 S3/OSS 实现即插即用，备份/媒体逻辑零改动。
 *
 * P11 t2：新增 S3 兼容对象存储实现（createS3Storage）+ env 选择（createStorageBackendFromEnv，
 * STORAGE_BACKEND=local|s3，缺省 local 零破坏）。S3 adapter 用 node 内置 fetch + 手写 SigV4
 * （lib/s3-signer.mjs，node:crypto）——零新增依赖（不引入 @aws-sdk/client-s3，避免体积/供应链面；
 * 协议面窄：PutObject/GetObject/ListObjectsV2/DeleteObject，SigV4 为 AWS 公开规范）。
 *
 * 安全（两实现同纪律，与 verify 脚本严谨风格一致）：key 必须是相对路径（禁止 .. 段、绝对路径、
 * Windows 盘符、反斜杠注入）；LocalDirStorage 解析后断言仍在 rootDir 内（路径穿越防护）。
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { signRequestV4 } from './s3-signer.mjs';

/**
 * @typedef {{
 *   kind?: string,
 *   bucket?: string,
 *   put(key: string, content: Buffer): Promise<void>,
 *   get(key: string): Promise<Buffer>,
 *   list(prefix: string): Promise<string[]>,
 *   delete(key: string): Promise<void>,
 * }} StorageBackend
 */

/** 跨实现公共 key 安全校验（本地/S3 同纪律）：非空、正斜杠、无 .. 段、相对路径、无盘符。 */
export function assertStorageKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('SAFETY_BLOCK: storage key must be a non-empty string');
  }
  if (key.includes('\\')) {
    throw new Error('SAFETY_BLOCK: storage key must use forward slashes');
  }
  if (key.split('/').includes('..')) {
    throw new Error('SAFETY_BLOCK: storage key must not contain .. traversal');
  }
  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) {
    throw new Error('SAFETY_BLOCK: storage key must be relative');
  }
}

/** 校验 key 为 rootDir 内安全相对路径，返回绝对路径。 */
function assertSafeLocalKey(root, key) {
  assertStorageKey(key);
  const normalized = key.replaceAll('/', sep);
  const full = resolve(root, normalized);
  if (full !== root && !full.startsWith(`${root}${sep}`)) {
    throw new Error('SAFETY_BLOCK: storage key escapes root directory');
  }
  return full;
}

/** 本地目录存储（阶段一）。list(prefix) 返回 prefix + 文件名（仅当前层级文件）。 */
export function createLocalDirStorage(rootDir) {
  const root = resolve(rootDir);
  return {
    kind: 'local',
    async put(key, content) {
      const full = assertSafeLocalKey(root, key);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    },
    async get(key) {
      const full = assertSafeLocalKey(root, key);
      return readFile(full);
    },
    async list(prefix) {
      const dir = assertSafeLocalKey(root, prefix);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (error && error.code === 'ENOENT') return [];
        throw error;
      }
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => `${prefix}${entry.name}`);
    },
    async delete(key) {
      const full = assertSafeLocalKey(root, key);
      await unlink(full);
    },
  };
}

/** S3 错误 XML <Error><Code>..</Code> 提取（缺省返回状态文本）。 */
function extractS3ErrorCode(status, body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
  const match = /<Code>([^<]+)<\/Code>/.exec(text);
  return match ? match[1] : `HTTP_${status}`;
}

/** 构造带 S3 错误码的 Error（get/delete 缺失 → NoSuchKey，与本地 ENOENT 语义对齐）。 */
function s3Error(status, body, message) {
  const code = extractS3ErrorCode(status, body);
  const error = new Error(`${message}（S3 ${code}）`);
  error.code = code;
  return error;
}

/** ListObjectsV2 XML 解析：<Contents><Key>..</Key> 列表 + 续页 token（键做 XML 实体反转义）。 */
function parseListXml(xml) {
  const unescape = (value) => value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
  const keys = [];
  const contentsPattern = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentsPattern.exec(xml)) !== null) {
    const block = match[1];
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(block);
    if (keyMatch) keys.push(unescape(keyMatch[1]));
  }
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { keys, nextToken: tokenMatch ? unescape(tokenMatch[1]) : null };
}

/** 对象 key → URL 路径段编码（保留 '/' 层级）。 */
function encodeKeyPath(key) {
  return key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * S3 兼容对象存储（阶段二；MinIO/AWS S3/腾讯 COS 等 SigV4 兼容端点）。
 * @param {object} options
 * @param {string} options.endpoint      端点（如 http://127.0.0.1:9000）
 * @param {string} options.bucket        桶名
 * @param {string} options.accessKeyId   访问密钥 id
 * @param {string} options.secretAccessKey 访问密钥
 * @param {string} [options.region='us-east-1']
 * @param {boolean} [options.forcePathStyle=true] 路径风格（MinIO/自建必 true；AWS 虚拟主机风格可 false）
 * @param {() => Date} [options.now]     签名时间（协议墙钟；测试可注入固定时间）
 */
export function createS3Storage(options) {
  const {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region = 'us-east-1',
    forcePathStyle = true,
    now,
  } = options;
  if (!endpoint || !/^https?:\/\//.test(endpoint)) {
    throw new Error('SAFETY_BLOCK: STORAGE_S3_ENDPOINT 必须是 http(s):// 端点（缺省 local 不校验）');
  }
  if (!bucket) throw new Error('SAFETY_BLOCK: STORAGE_S3_BUCKET 未配置');
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('SAFETY_BLOCK: STORAGE_S3_ACCESS_KEY_ID / STORAGE_S3_SECRET_ACCESS_KEY 未配置');
  }
  const baseUrl = endpoint.replace(/\/+$/, '');
  const signNow = now ?? (() => new Date());

  async function request(method, path, query, body) {
    const url = query ? `${baseUrl}${path}?${query}` : `${baseUrl}${path}`;
    const { headers } = signRequestV4({
      method,
      url,
      body,
      accessKeyId,
      secretAccessKey,
      region,
      now: signNow(),
    });
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : body,
    });
    // arrayBuffer 读体：二进制内容（加密媒体/备份文件）不得经 UTF-8 文本往返（text() 会损坏二进制）
    const bodyBuffer = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: bodyBuffer };
  }

  return {
    kind: 's3',
    bucket,
    async put(key, content) {
      assertStorageKey(key);
      const { status, body } = await request('PUT', `/${bucket}/${encodeKeyPath(key)}`, '', content);
      if (status !== 200) throw s3Error(status, body, `S3 上传失败: ${key}`);
    },
    async get(key) {
      assertStorageKey(key);
      const { status, body } = await request('GET', `/${bucket}/${encodeKeyPath(key)}`, '', undefined);
      if (status === 200) return body;
      if (status === 404) throw s3Error(status, body, `S3 对象不存在: ${key}`);
      throw s3Error(status, body, `S3 读取失败: ${key}`);
    },
    async list(prefix) {
      assertStorageKey(prefix);
      const keys = [];
      let token = null;
      // 分页循环（ListObjectsV2 默认每页 1000 个；上限 100 页防异常死循环）
      for (let page = 0; page < 100; page += 1) {
        const queryParams = [
          'list-type=2',
          `prefix=${encodeURIComponent(prefix)}`,
          ...(token ? [`continuation-token=${encodeURIComponent(token)}`] : []),
        ].join('&');
        const { status, body } = await request('GET', `/${bucket}`, queryParams, undefined);
        if (status !== 200) throw s3Error(status, body, `S3 列表失败: ${prefix}`);
        const parsed = parseListXml(body.toString('utf8'));
        keys.push(...parsed.keys);
        if (!parsed.nextToken) break;
        token = parsed.nextToken;
      }
      return keys;
    },
    async delete(key) {
      assertStorageKey(key);
      const { status, body } = await request('DELETE', `/${bucket}/${encodeKeyPath(key)}`, '', undefined);
      if (status === 204 || status === 200) return;
      if (status === 404) throw s3Error(status, body, `S3 对象不存在: ${key}`);
      throw s3Error(status, body, `S3 删除失败: ${key}`);
    },
  };
}

/**
 * 存储后端工厂（按配置选择实现；两实现同接口，业务零改动）。
 * @param {object} config
 * @param {'local'|'s3'} config.backend
 * @param {string} [config.rootDir] local 时本地根目录（缺省 .data）；s3 时见 createS3Storage options
 */
export function createStorageBackend(config) {
  if (config.backend === 's3') {
    return createS3Storage(config);
  }
  return createLocalDirStorage(config.rootDir ?? '.data');
}

/**
 * env 选择存储后端（P11 t2 存储选择；缺省 local 零破坏）：
 * - STORAGE_BACKEND=local（缺省）→ LocalDirStorage（STORAGE_LOCAL_ROOT ?? defaultLocalRoot）
 * - STORAGE_BACKEND=s3 → createS3Storage（STORAGE_S3_* env；配置缺失/非法 → SAFETY_BLOCK 快速失败，
 *   绝不静默回退本地——S3 模式写本地会造成数据分散）
 * - 未知值 → 按 local 处理（宽容降级不崩服）
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [defaultLocalRoot='.data']
 */
export function createStorageBackendFromEnv(env = process.env, defaultLocalRoot = '.data') {
  const backend = (env.STORAGE_BACKEND ?? 'local').trim().toLowerCase();
  if (backend === 's3') {
    return createS3Storage({
      endpoint: env.STORAGE_S3_ENDPOINT,
      bucket: env.STORAGE_S3_BUCKET,
      accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
      region: env.STORAGE_S3_REGION ?? 'us-east-1',
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE !== 'false',
    });
  }
  return createLocalDirStorage(env.STORAGE_LOCAL_ROOT ?? defaultLocalRoot);
}
