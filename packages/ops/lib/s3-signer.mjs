/**
 * AWS Signature V4 请求签名器（P11 t2：对象存储 StorageBackend——S3 兼容 adapter）。
 *
 * 纯 node:crypto 实现（零依赖——不引入 @aws-sdk/client-s3，理由见 storage-backend.mjs 头部）。
 * 按 AWS SigV4 规范（https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html）：
 * canonical request → string to sign → 签名密钥链（HMAC-SHA256）→ Authorization 头。
 *
 * 注意：x-amz-date 是 S3 协议必需的时间戳（协议墙钟，非业务时间；同 wechat signature 心智），
 * 签名器接受调用方注入 now（测试可固定时间），缺省取当前时间。
 */

import { createHash, createHmac } from 'node:crypto';

const SERVICE = 's3';

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

/** AWS URI 编码：除 [A-Za-z0-9-._~] 外全部百分号编码（encodeSlash=true 时 / 也编码——query 值用）。 */
function uriEncode(value, encodeSlash = false) {
  let encoded = encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => (
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  if (!encodeSlash) encoded = encoded.replace(/%2F/gi, '/');
  return encoded;
}

/** Canonical URI：按 '/' 分段，每段先 decodeURIComponent 还原、再按 AWS 规范单编码后重组（路径分隔符保留）。
 *  P14 t4 缺陷修复：旧实现对已百分号编码的 pathname 二次编码（%E5.. → %25E5..），含中文/空格 key 时
 *  与 AWS/MinIO 服务端重算的 canonical request 不一致 → 真实 MinIO 403 SignatureDoesNotMatch
 *  （mock 用同一签名器验签自洽故掩盖）；先还原再单编码与服务端一致。 */
function canonicalUri(pathname) {
  const path = pathname === '' ? '/' : pathname;
  return path.split('/').map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // 孤立 % 等非法序列：保留原样（uriEncode 会把字面 % 编码为 %25，与 AWS 一致）
    }
    return uriEncode(decoded);
  }).join('/');
}

/** Canonical query string：键/值各自编码（含 /），按编码后键名排序。 */
function canonicalQuery(search) {
  const raw = search.replace(/^\?/, '');
  if (raw === '') return '';
  const params = [...new URLSearchParams(raw).entries()]
    .map(([key, value]) => [uriEncode(key, true), uriEncode(value, true)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return params.map(([key, value]) => `${key}=${value}`).join('&');
}

/** Canonical headers：小写名、值去首尾空白并折叠内部连续空白、按名排序。 */
function canonicalHeaders(headerMap) {
  const entries = Object.entries(headerMap)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders: entries.map(([name]) => name).join(';'),
  };
}

/**
 * 生成 SigV4 请求头。
 * @param {object} options
 * @param {string} options.method  HTTP 方法（大写）
 * @param {string} options.url     完整请求 URL（含 query）
 * @param {Buffer|string} [options.body] 请求体（缺省空）
 * @param {string} options.accessKeyId
 * @param {string} options.secretAccessKey
 * @param {string} [options.region='us-east-1']
 * @param {Date} [options.now] 签名时间（协议墙钟；测试可注入固定时间）
 * @returns {{ headers: Record<string,string>, payloadHash: string }} 需附加的请求头 + payload 哈希
 */
export function signRequestV4(options) {
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
  const host = parsed.host;

  const headerMap = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const { canonical, signedHeaders } = canonicalHeaders(headerMap);

  const canonicalRequest = [
    method,
    canonicalUri(parsed.pathname),
    canonicalQuery(parsed.search),
    canonical,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    headers: {
      ...headerMap,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    payloadHash,
  };
}
