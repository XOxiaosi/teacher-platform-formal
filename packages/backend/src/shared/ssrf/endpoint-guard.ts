/**
 * Provider 端点 SSRF 守卫（安全审查 t2 确认 P0，契约 reports/security/ssrf-provider-baseurl-fix-contract.md）。
 *
 * 三层防护中的纯函数核心（L1 静态校验 / L2 运行时守卫共用）：
 * - parseEndpointUrl：WHATWG URL 语法层规则 S1–S8（协议/主机/userinfo/端口/query-fragment/长度/规范化）；
 * - isForbiddenAddress：网络层禁段判定（IPv4 禁段 + IPv6 禁段 + IPv4-mapped 归一）；
 * - parseAllowedCidrs：PROVIDER_BASEURL_ALLOWED_IPS 白名单解析（非法条目忽略，不 crash 不放行）；
 * - assertEndpointAllowed：完整守卫——语法 + hostname 静态禁词 + 字面 IP 静态判定 + hostname 运行时 DNS
 *   逐 IP 判定（任一命中禁段且不在白名单 → 拒绝；DNS 抛错 fail-closed）。
 *
 * 本模块为纯函数（除注入的 dnsLookup 外无 I/O、无 Date、无日志）；白名单非法条目的 warn 由调用方负责。
 * 自包含实现（不依赖 wechat ip-whitelist；仅参考其 CIDR 数学思路）。
 */

import { promises as dnsPromises } from 'node:dns';

// ---- 语法层常量（S7） ----

const MAX_URL_LENGTH = 2048;

// ---- 网络层禁段（§1.2） ----

/** IPv4 禁段（network, maskBits）。 */
const FORBIDDEN_IPV4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 未指定
  [0x0a000000, 8], // 10.0.0.0/8 RFC1918
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local（含云元数据 169.254.169.254）
  [0xac100000, 12], // 172.16.0.0/12 RFC1918
  [0xc0a80000, 16], // 192.168.0.0/16 RFC1918
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 保留
];

/** IPv6 禁段（network, maskBits）。 */
const FORBIDDEN_IPV6: ReadonlyArray<readonly [bigint, number]> = [
  [0x00000000000000000000000000000000n, 128], // :: 未指定
  [0x00000000000000000000000000000001n, 128], // ::1 loopback
  [0xfe800000000000000000000000000000n, 10], // fe80::/10 link-local
  [0xfc000000000000000000000000000000n, 7], // fc00::/7 unique-local
  [0xff000000000000000000000000000000n, 8], // ff00::/8 multicast
];

// ---- 基础 IP 解析（自包含实现） ----

/** 归一 IP：剥 IPv4-mapped IPv6 前缀（::ffff:x.x.x.x → x.x.x.x）；其余原样。 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

/**
 * IPv4-mapped IPv6 → IPv4 文本；非 mapped 返回 null。
 * 兼容两种形态：点分尾（::ffff:127.0.0.1）与 WHATWG URL 解析器的十六进制尾（::ffff:7f00:1），
 * 后者是 `new URL('http://[::ffff:127.0.0.1]/').hostname` 的归一结果——必须同样识别。
 */
export function mappedToIpv4(ip: string): string | null {
  const match = ip.trim().match(/^::ffff:([0-9a-fA-F.:]+)$/);
  if (!match) return null;
  const tail = match[1];
  if (tail.includes('.')) return tail;
  const groups = tail.split(':');
  if (groups.length !== 2) return null;
  const nums = groups.map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 0xffff)) return null;
  return `${(nums[0] >>> 8) & 0xff}.${nums[0] & 0xff}.${(nums[1] >>> 8) & 0xff}.${nums[1] & 0xff}`;
}

/** IPv4 文本 → 32 位无符号整数；非法返回 null。 */
export function ipv4ToInt(ip: string): number | null {
  const parts = normalizeIp(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/**
 * IPv6 文本 → 128 位 BigInt；非法返回 null。
 * 支持：[] 括号剥除 / :: 压缩（至多一次）/ 尾段 IPv4（2001:db8::192.168.1.1）。
 * IPv4-mapped（::ffff:x.x.x.x）由调用方先 normalizeIp 归一到 IPv4 路径。
 */
export function ipv6ToBigInt(ip: string): bigint | null {
  let address = normalizeIp(ip);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  // 尾段 IPv4（如 ::ffff:192.168.1.1 / 2001:db8::192.168.1.1）→ 补成两段 16-bit
  const lastColon = address.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = address.slice(lastColon + 1);
    if (tail.includes('.')) {
      const v4 = ipv4ToInt(tail);
      if (v4 === null) return null;
      const hi = (v4 >>> 16) & 0xffff;
      const lo = v4 & 0xffff;
      address = `${address.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
    }
  }
  // 展开 ::（至多一次；段数不得超 8）
  const doubleColon = address.indexOf('::');
  if (doubleColon !== -1) {
    const left = address.slice(0, doubleColon);
    const right = address.slice(doubleColon + 2);
    const leftGroups = left ? left.split(':') : [];
    const rightGroups = right ? right.split(':') : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing < 1) return null;
    address = [...leftGroups, ...Array(missing).fill('0'), ...rightGroups].join(':');
  }
  const groups = address.split(':');
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

// ---- 禁段判定 ----

/** 单 IP 是否命中任一 IPv4 禁段。 */
export function isForbiddenIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return FORBIDDEN_IPV4.some(([network, maskBits]) => ipv4InCidr(value, network, maskBits));
}

/** 单 IP 是否命中任一 IPv6 禁段。 */
export function isForbiddenIpv6(ip: string): boolean {
  const value = ipv6ToBigInt(ip);
  if (value === null) return false;
  return FORBIDDEN_IPV6.some(([network, maskBits]) => ipv6InCidr(value, network, maskBits));
}

/** 统一禁段判定：IPv4 / IPv6 / IPv4-mapped（mapped 先归一为 IPv4 再判定，含 URL 解析器十六进制尾形态）。 */
export function isForbiddenAddress(ip: string): boolean {
  const bare = ip.trim();
  const mapped = mappedToIpv4(bare);
  if (mapped) return isForbiddenIpv4(mapped);
  return bare.includes(':') ? isForbiddenIpv6(bare) : isForbiddenIpv4(bare);
}

function ipv4InCidr(value: number, network: number, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6InCidr(value: bigint, network: bigint, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - maskBits)) - 1n);
  return (value & mask) === (network & mask);
}

// ---- 白名单（PROVIDER_BASEURL_ALLOWED_IPS） ----

/** 白名单条目（解析后的 CIDR）。 */
export type AllowedCidr =
  | { kind: 'ipv4'; network: number; maskBits: number }
  | { kind: 'ipv6'; network: bigint; maskBits: number };

/**
 * 归一 CIDR：剥 IPv4-mapped IPv6 前缀并换算掩码（::ffff:x.x.x.x/n → x.x.x.x/(n-96)）。
 * 掩码 <96（无法精确映射）或剥后非 IPv4 → 原样返回（后续按 IPv6 路径解析，非法即忽略）。
 */
export function normalizeCidr(cidr: string): string {
  const trimmed = cidr.trim();
  if (!trimmed.startsWith('::ffff:')) return trimmed;
  const slash = trimmed.indexOf('/');
  const ipPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const maskPart = slash === -1 ? '' : trimmed.slice(slash);
  const normalized = normalizeIp(ipPart);
  if (!normalized.includes('.')) return trimmed;
  if (maskPart === '') return normalized;
  const maskBits = Number(maskPart.slice(1));
  if (Number.isInteger(maskBits) && maskBits >= 96 && maskBits <= 128) {
    return `${normalized}/${maskBits - 96}`;
  }
  return trimmed;
}

function parseAllowedCidr(entry: string): AllowedCidr | null {
  const normalized = normalizeCidr(entry);
  const slash = normalized.indexOf('/');
  const ipPart = slash === -1 ? normalized : normalized.slice(0, slash);
  const rawMask = slash === -1 ? undefined : normalized.slice(slash + 1);
  if (normalized.includes(':')) {
    const value = ipv6ToBigInt(ipPart);
    if (value === null) return null;
    const maskBits = rawMask === undefined ? 128 : Number(rawMask);
    if (!Number.isInteger(maskBits) || maskBits < 0 || maskBits > 128) return null;
    return { kind: 'ipv6', network: value, maskBits };
  }
  const value = ipv4ToInt(ipPart);
  if (value === null) return null;
  const maskBits = rawMask === undefined ? 32 : Number(rawMask);
  if (!Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) return null;
  return { kind: 'ipv4', network: value, maskBits };
}

/**
 * 解析白名单 env：逗号分隔 CIDR/IP；空/未配置 → 全禁（fail-closed）。
 * 非法条目忽略并放入 invalid（调用方负责 warn）——不 crash、不放行任何东西。
 */
export function parseAllowedCidrs(raw: string | undefined): { allowed: AllowedCidr[]; invalid: string[] } {
  const allowed: AllowedCidr[] = [];
  const invalid: string[] = [];
  if (!raw || raw.trim() === '') return { allowed, invalid };
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const parsed = parseAllowedCidr(trimmed);
    if (parsed) allowed.push(parsed);
    else invalid.push(trimmed);
  }
  return { allowed, invalid };
}

/** 单 IP 是否落在白名单任一 CIDR 内（mapped 先归一 IPv4；IPv4/IPv6 按地址族匹配）。 */
export function isAllowedAddress(ip: string, allowed: AllowedCidr[]): boolean {
  if (allowed.length === 0) return false;
  const bare = ip.trim();
  const mapped = mappedToIpv4(bare);
  const normalized = mapped ?? bare;
  const isV6 = normalized.includes(':');
  for (const cidr of allowed) {
    if (isV6) {
      if (cidr.kind !== 'ipv6') continue;
      const value = ipv6ToBigInt(normalized);
      if (value !== null && ipv6InCidr(value, cidr.network, cidr.maskBits)) return true;
    } else {
      if (cidr.kind !== 'ipv4') continue;
      const value = ipv4ToInt(normalized);
      if (value !== null && ipv4InCidr(value, cidr.network, cidr.maskBits)) return true;
    }
  }
  return false;
}

// ---- 语法层（S1–S8） ----

export type EndpointUrlParseResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/** 语法层静态校验：S1–S8（纯函数，无 I/O）。通过后 url.toString() 即规范化落库值。 */
export function parseEndpointUrl(value: unknown): EndpointUrlParseResult {
  if (typeof value !== 'string') return { ok: false, reason: 'URL 解析失败' };
  if (value.length > MAX_URL_LENGTH) return { ok: false, reason: 'URL 过长' };
  // S1 补充：http:///path 这类空 authority 会被 WHATWG 解析器静默重写为 http://path/——
  // 必须显式拒绝（authority 必须以非 /?# 字符开头）
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]/.test(value)) {
    return { ok: false, reason: 'URL 解析失败' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'URL 解析失败' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '仅支持 http/https 协议' };
  }
  if (url.hostname === '') return { ok: false, reason: '缺少主机名' };
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: '不允许包含用户名密码' };
  }
  if (url.port !== '') {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return { ok: false, reason: '端口超出范围' };
    }
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'URL 不能包含查询参数或片段' };
  }
  return { ok: true, url };
}

/** hostname 静态禁词：精确 localhost、后缀 .localhost、后缀 .local（mDNS）。 */
export function isForbiddenHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local');
}

// ---- 运行时 DNS ----

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

/** 缺省 DNS 解析：dns.promises.lookup all:true + verbatim（契约 §3 L2）。 */
export function defaultDnsLookup(hostname: string): Promise<Array<{ address: string }>> {
  return dnsPromises.lookup(hostname, { all: true, verbatim: true }).then((entries) =>
    entries.map((entry) => ({ address: entry.address })),
  );
}

export type EndpointGuardResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; reason: string };

/** host 是否字面 IP（IPv4 dotted-quad 或 IPv6 括号形式）。 */
function isLiteralIpHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
}

/**
 * 只做不会触发网络 I/O 的端点校验：语法、保留 hostname 和字面 IP 禁段。
 * 本机安全模式允许保存经此校验的 hostname，但绝不把静态通过当作可连接保证。
 */
export function assertEndpointStaticallyAllowed(
  value: unknown,
  allowedCidrs: AllowedCidr[],
): EndpointGuardResult {
  const parsed = parseEndpointUrl(value);
  if (!parsed.ok) return parsed;
  const url = parsed.url;
  const host = url.hostname;

  if (isForbiddenHostname(host)) {
    return { ok: false, reason: '内网/保留地址不可访问' };
  }

  if (isLiteralIpHost(host)) {
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (isForbiddenAddress(bare) && !isAllowedAddress(bare, allowedCidrs)) {
      return { ok: false, reason: '内网/保留地址不可访问' };
    }
  }
  return { ok: true, normalizedUrl: url.toString() };
}

/**
 * 完整端点守卫（L1/L2 共用）：
 * 1. 语法层 S1–S8；2. hostname 静态禁词；3. 字面 IP → 静态禁段/白名单判定；
 * 4. hostname → 运行时 DNS 逐 IP 判定（任一命中禁段且不在白名单 → 拒绝；DNS 抛错 fail-closed）。
 */
export async function assertEndpointAllowed(
  value: unknown,
  allowedCidrs: AllowedCidr[],
  deps: { dnsLookup?: DnsLookup } = {},
): Promise<EndpointGuardResult> {
  const staticGuard = assertEndpointStaticallyAllowed(value, allowedCidrs);
  if (!staticGuard.ok) return staticGuard;
  const parsed = parseEndpointUrl(value);
  // assertEndpointStaticallyAllowed has already checked this input.
  if (!parsed.ok) return parsed;
  const url = parsed.url;
  const host = url.hostname;

  if (isLiteralIpHost(host)) {
    return staticGuard;
  }

  // hostname → 运行时 DNS（fail-closed）
  const lookup = deps.dnsLookup ?? defaultDnsLookup;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch {
    return { ok: false, reason: '域名解析失败（fail-closed）' };
  }
  for (const { address } of addresses) {
    if (isForbiddenAddress(address) && !isAllowedAddress(address, allowedCidrs)) {
      return { ok: false, reason: '内网/保留地址不可访问' };
    }
  }
  return { ok: true, normalizedUrl: url.toString() };
}
