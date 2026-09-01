/**
 * 回调 IP 白名单（设计 p7-wechat-ilink-design.md §6.3）。
 * - env WECHAT_ILINK_ALLOWED_IPS（逗号分隔 CIDR/单 IP，IPv4 与 IPv6 混合多组）；未配置 → 空列表 → fail-closed 全拒；
 * - 依赖 trust proxy 'loopback'（index.ts 已就位）：req.ip 即真实客户端 IP，外部伪造 X-Forwarded-* 无效；
 * - 支持 IPv4-mapped IPv6（::ffff:127.0.0.1 → 127.0.0.1）归一，IP 侧与 CIDR 侧对称；
 * - P14 t6 扩展：IPv6 CIDR 匹配（含 :: 压缩、尾段 IPv4、隐式 /128；mask 0..128）——
 *   IPv4 路径保持原有实现不变（additive），IPv6 地址/CIDR 走 BigInt 128 位匹配。
 * - 纯函数（无 I/O、无 Date）；非法输入一律返回 false（fail-closed 不误放行）。
 */

/** 归一 IP：剥 IPv4-mapped IPv6 前缀（::ffff:x.x.x.x → x.x.x.x）；其余原样。 */
export function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

/**
 * 归一 CIDR：剥 IPv4-mapped IPv6 前缀并换算掩码（::ffff:x.x.x.x/n → x.x.x.x/(n-96)），
 * 与 IP 侧 normalizeIp 对称。IPv4-mapped 空间固定 /96 前缀：
 * - ::ffff:x.x.x.x（隐式 /128）→ x.x.x.x（隐式 /32）
 * - ::ffff:x.x.x.x/120 → x.x.x.x/24（120-96）
 * - 掩码 <96（覆盖非 mapped 地址）无法精确映射 → 原样返回（按 IPv6 路径 fail-closed，不误放行）
 * - 剥后非 IPv4（非常规形态）→ 原样返回
 */
export function normalizeCidr(cidr: string): string {
  const trimmed = cidr.trim();
  if (!trimmed.startsWith('::ffff:')) return trimmed;
  const slash = trimmed.indexOf('/');
  const ipPart = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const maskPart = slash === -1 ? '' : trimmed.slice(slash);
  const normalized = normalizeIp(ipPart);
  if (!normalized.includes('.')) return trimmed; // 剥后非 IPv4 → 原样（IPv6 路径，fail-closed）
  if (maskPart === '') return normalized; // 隐式 /128 → IPv4 隐式 /32
  const maskBits = Number(maskPart.slice(1));
  if (Number.isInteger(maskBits) && maskBits >= 96 && maskBits <= 128) {
    return `${normalized}/${maskBits - 96}`;
  }
  return trimmed; // 掩码 <96 或非法：原样走 IPv6 路径（parseIpv6Cidr 亦失败 → fail-closed）
}

/** IPv4 → 32 位整数；非法返回 null。 */
export function ipToInt(ip: string): number | null {
  const parts = normalizeIp(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** IPv4 CIDR 解析（a.b.c.d/n；无 / 视为 /32）；非法返回 null。 */
export function parseCidr(cidr: string): { network: number; maskBits: number } | null {
  const normalized = cidr.trim();
  const slash = normalized.indexOf('/');
  const ipPart = slash === -1 ? normalized : normalized.slice(0, slash);
  const maskBits = slash === -1 ? 32 : Number(normalized.slice(slash + 1));
  const network = ipToInt(ipPart);
  if (network === null || !Number.isInteger(maskBits) || maskBits < 0 || maskBits > 32) return null;
  return { network, maskBits };
}

/**
 * IPv6 文本 → 128 位 BigInt；非法返回 null。
 * 支持：完整 8 组 / :: 压缩（至多一次）/ 尾段 IPv4（2001:db8::192.168.1.1）/ 隐式 IPv4-mapped（::ffff:x.x.x.x，normalizeIp 已剥）。
 */
export function ipv6ToBigInt(ip: string): bigint | null {
  let address = normalizeIp(ip);
  // 尾段 IPv4（如 ::ffff:192.168.1.1 / 2001:db8::192.168.1.1）→ 补成两段 16-bit
  const lastColon = address.lastIndexOf(':');
  if (lastColon !== -1) {
    const tail = address.slice(lastColon + 1);
    if (tail.includes('.')) {
      const v4 = ipToInt(tail);
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
    if (missing < 1) return null; // 两个 :: 或段数超 8 → 非法
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

/** IPv6 CIDR 解析（x:x::/n；无 / 视为 /128）；非法返回 null。纯 IPv6——IPv4-mapped CIDR 由 isIpAllowed 调度层 normalizeCidr 归一到 IPv4 路径。 */
export function parseIpv6Cidr(cidr: string): { network: bigint; maskBits: number } | null {
  const normalized = cidr.trim();
  const slash = normalized.indexOf('/');
  const ipPart = slash === -1 ? normalized : normalized.slice(0, slash);
  const maskBits = slash === -1 ? 128 : Number(normalized.slice(slash + 1));
  const network = ipv6ToBigInt(ipPart);
  if (network === null || !Number.isInteger(maskBits) || maskBits < 0 || maskBits > 128) return null;
  return { network, maskBits };
}

/** 单 IP 是否落在 IPv4 CIDR 内。 */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr);
  const value = ipToInt(ip);
  if (!parsed || value === null) return false;
  const mask = parsed.maskBits === 0 ? 0 : (0xffffffff << (32 - parsed.maskBits)) >>> 0;
  return (value & mask) === (parsed.network & mask);
}

/** 单 IP 是否落在 IPv6 CIDR 内。 */
export function ipv6MatchesCidr(ip: string, cidr: string): boolean {
  const parsed = parseIpv6Cidr(cidr);
  const value = ipv6ToBigInt(ip);
  if (!parsed || value === null) return false;
  const { network, maskBits } = parsed;
  const mask = maskBits === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - maskBits)) - 1n);
  return (value & mask) === (network & mask);
}

/** 白名单判定（IPv4/IPv6/IPv4-mapped 统一入口）：空列表一律拒绝（fail-closed）。 */
export function isIpAllowed(ip: string, allowedIps: string[]): boolean {
  if (allowedIps.length === 0) return false;
  const normalized = normalizeIp(ip);
  return allowedIps.some((cidr) => {
    const normalizedCidr = normalizeCidr(cidr);
    // IPv6 CIDR（含 ':'）→ IPv6 匹配；否则 IPv4 匹配（IPv4-mapped IP 已归一为 IPv4）
    return normalizedCidr.includes(':')
      ? ipv6MatchesCidr(normalized, normalizedCidr)
      : ipMatchesCidr(normalized, normalizedCidr);
  });
}
