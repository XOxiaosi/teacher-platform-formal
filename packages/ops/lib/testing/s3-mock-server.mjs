/**
 * S3 兼容 mock 服务器（P11 t2 测试基建；仅测试使用，不入生产）。
 *
 * 实现 PutObject / GetObject / DeleteObject / ListObjectsV2 最小协议面（内存 Map 存储），
 * 并**校验 SigV4 签名**（用与客户端共享的密钥重算签名比对 + x-amz-content-sha256 与请求体哈希比对）——
 * 证明 createS3Storage 产出的请求是「自洽可验」的 SigV4 请求（与 MinIO/AWS 同规范）。
 *
 * P14 t4：验签改为**独立规范对照**——本文件内嵌一份独立 SigV4 规范实现（canonicalUri 先
 * decode 再按段单编码），**不复用被测 s3-signer.mjs**。原因：旧版 mock 用同一签名器验签，
 * 与生产「自洽」→ canonicalUri 双编码缺陷被掩盖，只有真实 MinIO 暴露（qa5 t3 实测 403
 * SignatureDoesNotMatch）。独立规范验签让 mock 具备独立于被测实现的判断力，双编码一旦回归
 * 即在单测层报 403 拒绝（见 tests/storage-backend.test.mjs 非 ASCII key 用例）。
 *
 * P15 t1：验签时间语义修复——**用请求携带的 x-amz-date 重算签名**（真实 S3/AWS 语义：
 * 签名按请求自身时间戳校验，时钟偏差单独容限，默认 ±15 分钟），而非服务器墙钟。旧实现用
 * 服务器当前时间重算，签名→验签跨秒（全量负载下偶发 >1s 延迟）即误杀自洽请求 403
 * （实测：2s 前签名 / 签名后延迟 1.1s 送达 → 403；见 .data/t1-probe-s3-clock.mjs）。
 * 同时保留「签名时间超出偏差容限 → 403」语义（既有用例：固定 2020 时间注入 → 403）。
 *
 * 用法：
 *   const server = await startMockS3Server({ accessKeyId, secretAccessKey, region });
 *   // server.url 为端点；server.bucketKeys(prefix) 直读内存；server.close() 关闭。
 */

import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

// ── 独立 SigV4 规范实现（P14 t4：不复用被测 s3-signer.mjs，防止 mock 与生产自洽掩盖缺陷）──

/** AWS URI 编码：除 [A-Za-z0-9-._~] 外全部百分号编码（encodeSlash=true 时 / 也编码——query 值用）。 */
function specUriEncode(value, encodeSlash = false) {
  let encoded = encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => (
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  if (!encodeSlash) encoded = encoded.replace(/%2F/gi, '/');
  return encoded;
}

/** 规范 Canonical URI：按 '/' 分段，每段先 decodeURIComponent 还原、再单编码后重组（AWS 服务端行为）。 */
function specCanonicalUri(pathname) {
  const path = pathname === '' ? '/' : pathname;
  return path.split('/').map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // 孤立 % 等非法序列：保留原样（specUriEncode 会把字面 % 编码为 %25，与 AWS 一致）
    }
    return specUriEncode(decoded);
  }).join('/');
}

/** 规范 Canonical query string：键/值各自编码（含 /），按编码后键名排序。 */
function specCanonicalQuery(search) {
  const raw = search.replace(/^\?/, '');
  if (raw === '') return '';
  const params = [...new URLSearchParams(raw).entries()]
    .map(([key, value]) => [specUriEncode(key, true), specUriEncode(value, true)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return params.map(([key, value]) => `${key}=${value}`).join('&');
}

/** 规范 Canonical headers：小写名、值去首尾空白并折叠内部连续空白、按名排序。 */
function specCanonicalHeaders(headerMap) {
  const entries = Object.entries(headerMap)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders: entries.map(([name]) => name).join(';'),
  };
}

/**
 * 独立重算 SigV4 签名（规范实现；now 缺省当前时间——模拟服务器时钟，
 * 客户端注入固定过期时间 → 重算不一致 → 403，与真实服务端时间偏差拒绝语义一致）。
 */
function recomputeSignature(options) {
  const {
    method,
    url,
    body = Buffer.alloc(0),
    accessKeyId,
    secretAccessKey,
    region = 'us-east-1',
    now = new Date(),
  } = options;
  const content = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(content);

  const parsed = new URL(url);
  const { canonical, signedHeaders } = specCanonicalHeaders({
    host: parsed.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  });

  const canonicalRequest = [
    method,
    specCanonicalUri(parsed.pathname),
    specCanonicalQuery(parsed.search),
    canonical,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    payloadHash,
  };
}

/** XML 转义（ListObjectsV2 响应中的 key）。 */
function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function xmlError(status, code, message) {
  return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
}

function listObjectsXml(objects) {
  const contents = objects
    .map((key) => (
      `<Contents><Key>${xmlEscape(key)}</Key><Size>0</Size><StorageClass>STANDARD</StorageClass></Contents>`
    ))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

/**
 * 解析 SigV4 x-amz-date 头（YYYYMMDD'T'HHMMSS'Z'）→ Date；非法返回 null。
 * P15 t1：真实 S3 用请求携带的 x-amz-date 重算签名（另设时钟偏差容限），见 verifySignature 注释。
 */
function parseAmzDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 时钟偏差容限：与 AWS 同语义（X-Amz-Date 必须在服务器时间 ±15 分钟内）。
 * 只做「远时间戳」拒绝（既有用例：注入 2020 时间 → 403），近秒差异（负载跨秒）放行。
 */
const SKEW_TOLERANCE_MS = 15 * 60 * 1000;

/**
 * 启动内存 S3 mock。
 * @param {object} options
 * @param {string} options.accessKeyId
 * @param {string} options.secretAccessKey
 * @param {string} [options.region='us-east-1']
 * @param {string} [options.bucket='test-bucket']
 */
export async function startMockS3Server(options) {
  const { accessKeyId, secretAccessKey, region = 'us-east-1', bucket = 'test-bucket' } = options;
  /** @type {Map<string, Buffer>} key → 内容 */
  const objects = new Map();

  function verifySignature(req, chunks, url, method) {
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=')) return 'missing Authorization';
    // P15 t1：用请求携带的 x-amz-date 重算签名（真实 S3 语义）。旧实现用服务器墙钟重算，
    // 签名→验签跨秒即 403（全量负载下偶发）；服务器时钟只用于偏差容限判定。
    const clientAmzDate = parseAmzDate(req.headers['x-amz-date']);
    if (!clientAmzDate) return 'missing/invalid x-amz-date';
    if (Math.abs(Date.now() - clientAmzDate.getTime()) > SKEW_TOLERANCE_MS) {
      return `request time outside ${SKEW_TOLERANCE_MS / 60000}min skew tolerance`;
    }
    const expected = recomputeSignature({
      method,
      url,
      body: Buffer.concat(chunks),
      accessKeyId,
      secretAccessKey,
      region,
      now: clientAmzDate,
    });
    if (auth !== expected.authorization) return 'signature mismatch';
    const sentPayloadHash = req.headers['x-amz-content-sha256'];
    if (sentPayloadHash !== expected.payloadHash) return 'payload hash mismatch';
    return null;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const path = req.url ?? '/';
      // 重组完整 URL（host 取请求头，与客户端签名一致）
      const url = `http://${req.headers.host}${path}`;
      const signedUrl = new URL(url);
      const segments = signedUrl.pathname.split('/').filter(Boolean);

      const sigError = verifySignature(req, chunks, url, method);
      if (sigError) {
        res.writeHead(403, { 'Content-Type': 'application/xml' });
        res.end(xmlError(403, 'SignatureDoesNotMatch', `mock: ${sigError}`));
        return;
      }

      // GET /{bucket}?list-type=2&prefix=... → ListObjectsV2
      if (method === 'GET' && segments.length === 1 && segments[0] === bucket) {
        const params = new URLSearchParams(signedUrl.search);
        if (params.get('list-type') === '2') {
          const prefix = params.get('prefix') ?? '';
          const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end(listObjectsXml(keys));
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/xml' });
        res.end(xmlError(400, 'InvalidRequest', 'mock: unsupported list params'));
        return;
      }

      // /{bucket}/{key...}
      if (segments.length < 2 || segments[0] !== bucket) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end(xmlError(404, 'NoSuchBucket', 'mock: bucket not found'));
        return;
      }
      const key = segments.slice(1).map(decodeURIComponent).join('/');

      if (method === 'PUT') {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { ETag: `"${sha256Hex(Buffer.concat(chunks)).slice(0, 16)}"` });
        res.end();
        return;
      }
      if (method === 'GET') {
        const content = objects.get(key);
        if (content === undefined) {
          res.writeHead(404, { 'Content-Type': 'application/xml' });
          res.end(xmlError(404, 'NoSuchKey', 'mock: key not found'));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(content.length) });
        res.end(content);
        return;
      }
      if (method === 'DELETE') {
        if (!objects.delete(key)) {
          res.writeHead(404, { 'Content-Type': 'application/xml' });
          res.end(xmlError(404, 'NoSuchKey', 'mock: key not found'));
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(405, { 'Content-Type': 'application/xml' });
      res.end(xmlError(405, 'MethodNotAllowed', `mock: ${method}`));
    });
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    bucket,
    /** 直读内存对象（测试断言用）。 */
    bucketKeys(prefix = '') {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    objectCount() {
      return objects.size;
    },
    close() {
      return new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}
