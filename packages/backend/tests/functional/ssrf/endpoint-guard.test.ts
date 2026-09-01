import { describe, expect, it } from 'vitest';
import {
  assertEndpointAllowed,
  isForbiddenAddress,
  parseAllowedCidrs,
  parseEndpointUrl,
  type DnsLookup,
} from '../../../src/shared/ssrf/endpoint-guard.js';

/** 测试用 DNS：hostname 一律解析到公网 TEST-NET（93.184.216.34 = example.com）。 */
const publicDns: DnsLookup = async () => [{ address: '93.184.216.34' }];

function allowed(raw: string) {
  return parseAllowedCidrs(raw).allowed;
}

async function expectRejected(value: unknown, rawAllowed = ''): Promise<void> {
  const result = await assertEndpointAllowed(value, allowed(rawAllowed), { dnsLookup: publicDns });
  expect(result.ok).toBe(false);
}

describe('endpoint-guard 语法层（S1–S8）', () => {
  it('合法 URL：http/https + 公开 host + 自定义端口 + 任意路径', () => {
    expect(parseEndpointUrl('https://api.openai.com/v1').ok).toBe(true);
    expect(parseEndpointUrl('http://api.deepseek.com').ok).toBe(true);
    expect(parseEndpointUrl('https://openai.example.com:8443/v1').ok).toBe(true);
    expect(parseEndpointUrl('http://192.0.2.1').ok).toBe(true); // TEST-NET 公网
    expect(parseEndpointUrl('https://[2001:db8::1]/').ok).toBe(true); // doc 段公网
  });

  it('协议白名单：非 http/https 拒绝（S2）', () => {
    expect(parseEndpointUrl('ftp://x').ok).toBe(false);
    expect(parseEndpointUrl('file:///etc/passwd').ok).toBe(false);
    expect(parseEndpointUrl('gopher://x').ok).toBe(false);
    expect(parseEndpointUrl('javascript:alert(1)').ok).toBe(false);
    expect(parseEndpointUrl('httpx://h').ok).toBe(false);
  });

  it('缺失主机 / userinfo / 非法端口 / query-fragment / 超长（S1/S3/S4/S5/S6/S7）', () => {
    expect(parseEndpointUrl('http://').ok).toBe(false);
    expect(parseEndpointUrl('http://?q=1').ok).toBe(false);
    expect(parseEndpointUrl('//host/path').ok).toBe(false);
    expect(parseEndpointUrl('http:///path').ok).toBe(false);
    expect(parseEndpointUrl('http://user:pass@host/').ok).toBe(false);
    expect(parseEndpointUrl('http://token@host/').ok).toBe(false);
    // 端口 0 可解析但拒绝（S5 显式端口 1–65535）
    const portZero = parseEndpointUrl('http://host:0/');
    expect(portZero.ok).toBe(false);
    // 端口 >65535 / 非数字 → WHATWG 解析失败（S1 兜底，同样拒绝）
    expect(parseEndpointUrl('http://host:99999/').ok).toBe(false);
    expect(parseEndpointUrl('http://host:abc/').ok).toBe(false);
    expect(parseEndpointUrl('http://host?q=1').ok).toBe(false);
    expect(parseEndpointUrl('http://host#frag').ok).toBe(false);
    expect(parseEndpointUrl('').ok).toBe(false);
    expect(parseEndpointUrl(null).ok).toBe(false);
    expect(parseEndpointUrl(undefined).ok).toBe(false);
    expect(parseEndpointUrl('http://' + 'a'.repeat(2050)).ok).toBe(false);
  });

  it('规范化（S8）：大写域名 → 小写 + 尾斜杠', () => {
    const result = parseEndpointUrl('http://EXAMPLE.com');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url.toString()).toBe('http://example.com/');
  });
});

describe('endpoint-guard 网络层禁段（§1.2）', () => {
  it('IPv4 禁段：loopback / RFC1918 / link-local / 云元数据 / CGNAT / 未指定 / multicast / 保留', () => {
    expect(isForbiddenAddress('127.0.0.1')).toBe(true);
    expect(isForbiddenAddress('10.0.0.5')).toBe(true);
    expect(isForbiddenAddress('172.16.0.1')).toBe(true);
    expect(isForbiddenAddress('172.31.255.254')).toBe(true);
    expect(isForbiddenAddress('192.168.1.1')).toBe(true);
    expect(isForbiddenAddress('169.254.169.254')).toBe(true);
    expect(isForbiddenAddress('0.0.0.0')).toBe(true);
    expect(isForbiddenAddress('100.64.0.1')).toBe(true);
    expect(isForbiddenAddress('224.0.0.1')).toBe(true);
    expect(isForbiddenAddress('240.0.0.1')).toBe(true);
    expect(isForbiddenAddress('8.8.8.8')).toBe(false); // 公网
    expect(isForbiddenAddress('192.0.2.1')).toBe(false); // TEST-NET 公网
  });

  it('IPv6 禁段：:: / ::1 / fe80 / fc00 / ff00 / IPv4-mapped 归一', () => {
    expect(isForbiddenAddress('::')).toBe(true);
    expect(isForbiddenAddress('::1')).toBe(true);
    expect(isForbiddenAddress('fe80::1')).toBe(true);
    expect(isForbiddenAddress('fc00::1')).toBe(true);
    expect(isForbiddenAddress('ff02::1')).toBe(true);
    expect(isForbiddenAddress('2001:db8::1')).toBe(false); // doc 段公网
    // IPv4-mapped → 归一为 IPv4 后判定（点分尾形态）
    expect(isForbiddenAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isForbiddenAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isForbiddenAddress('::ffff:8.8.8.8')).toBe(false);
    // WHATWG URL 解析器把 mapped 尾段归一为十六进制（::ffff:127.0.0.1 → ::ffff:7f00:1）——同样拒绝
    expect(isForbiddenAddress('::ffff:7f00:1')).toBe(true);
    expect(isForbiddenAddress('::ffff:a00:1')).toBe(true);
  });
});

describe('endpoint-guard assertEndpointAllowed 全矩阵', () => {
  it('合法端点放行；规范化返回值', async () => {
    const result = await assertEndpointAllowed('http://EXAMPLE.com', allowed(''), { dnsLookup: publicDns });
    expect(result).toEqual({ ok: true, normalizedUrl: 'http://example.com/' });
    expect((await assertEndpointAllowed('http://192.0.2.1', allowed(''), { dnsLookup: publicDns })).ok).toBe(true);
    expect((await assertEndpointAllowed('https://[2001:db8::1]/', allowed(''), { dnsLookup: publicDns })).ok).toBe(true);
    expect((await assertEndpointAllowed('https://api.openai.com/v1', allowed(''), { dnsLookup: publicDns })).ok).toBe(true);
    expect((await assertEndpointAllowed('https://openai.example.com:8443/v1', allowed(''), { dnsLookup: publicDns })).ok).toBe(true);
  });

  it('字面 IP 禁段拒绝（静态层）', async () => {
    await expectRejected('http://127.0.0.1');
    await expectRejected('http://127.0.0.1:5432');
    await expectRejected('http://10.0.0.5');
    await expectRejected('http://172.16.0.1');
    await expectRejected('http://172.31.255.254');
    await expectRejected('http://192.168.1.1');
    await expectRejected('http://169.254.169.254/latest/meta-data/');
    await expectRejected('http://0.0.0.0');
    await expectRejected('http://100.64.0.1');
  });

  it('IPv6 + IPv4-mapped 拒绝', async () => {
    await expectRejected('http://[::1]');
    await expectRejected('http://[fe80::1]');
    await expectRejected('http://[fc00::1]');
    await expectRejected('http://[::]');
    await expectRejected('http://[::ffff:127.0.0.1]'); // mapped → 归一禁
    await expectRejected('http://[::ffff:10.0.0.1]'); // mapped → 归一禁
    await expectRejected('http://[::ffff:7f00:1]'); // URL 解析器十六进制归一形态 → 同样禁
    await expectRejected('http://[::ffff:a00:1]'); // = ::ffff:10.0.0.1
  });

  it('hostname 静态禁词：localhost / *.localhost / *.local', async () => {
    await expectRejected('http://localhost:3000');
    await expectRejected('http://foo.localhost');
    await expectRejected('http://vllm.local');
  });

  it('scheme/格式异常拒绝', async () => {
    await expectRejected('ftp://x');
    await expectRejected('file:///etc/passwd');
    await expectRejected('gopher://x');
    await expectRejected('//host');
    await expectRejected('http://user:pass@host/');
    await expectRejected('http://host:99999/');
    await expectRejected('http://host:0/');
    await expectRejected('http://host?q=1');
    await expectRejected('http://host#frag');
    await expectRejected('http://');
    await expectRejected('');
    await expectRejected(null);
    await expectRejected('http://' + 'a'.repeat(2050));
  });
});

describe('endpoint-guard 白名单（PROVIDER_BASEURL_ALLOWED_IPS）', () => {
  it('CIDR 放行禁段内 IP；禁段外仍拒；仅豁免禁段判定', async () => {
    expect((await assertEndpointAllowed('http://10.1.2.3:8000', allowed('10.0.0.0/8'), { dnsLookup: publicDns })).ok).toBe(true);
    await expectRejected('http://169.254.169.254', '10.0.0.0/8');
    expect((await assertEndpointAllowed('http://192.168.1.10', allowed('192.168.1.0/24'), { dnsLookup: publicDns })).ok).toBe(true);
    await expectRejected('http://192.168.2.10', '192.168.1.0/24');
    // scheme 语法无条件生效：白名单不能豁免非 http/https
    await expectRejected('ftp://10.1.2.3', '10.0.0.0/8');
    await expectRejected('http://localhost:3000', '10.0.0.0/8'); // hostname 静态禁词不受白名单豁免
  });

  it('IPv6 白名单 CIDR', async () => {
    expect((await assertEndpointAllowed('http://[fd00::1]', allowed('fd00::/8'), { dnsLookup: publicDns })).ok).toBe(true);
    await expectRejected('http://[fd00::1]'); // 无白名单 → 禁
  });

  it('单 IP 白名单（隐式 /32）', async () => {
    expect((await assertEndpointAllowed('http://10.0.0.5', allowed('10.0.0.5'), { dnsLookup: publicDns })).ok).toBe(true);
    await expectRejected('http://10.0.0.6', '10.0.0.5');
  });

  it('空/未配置 → 全禁（fail-closed）；非法条目忽略不 crash', () => {
    expect(parseAllowedCidrs(undefined).allowed).toEqual([]);
    expect(parseAllowedCidrs('').allowed).toEqual([]);
    expect(parseAllowedCidrs('  ,  ').allowed).toEqual([]);
    const parsed = parseAllowedCidrs('garbage,10.0.0.0/33,10.0.0.0/8');
    expect(parsed.invalid).toEqual(['garbage', '10.0.0.0/33']);
    expect(parsed.allowed).toHaveLength(1);
    expect(parsed.allowed[0]).toEqual({ kind: 'ipv4', network: 0x0a000000, maskBits: 8 });
  });

  it('IPv4-mapped CIDR 归一（::ffff:x.x.x.x/n → x.x.x.x/(n-96)）', async () => {
    const parsed = parseAllowedCidrs('::ffff:10.0.0.0/120');
    expect(parsed.invalid).toEqual([]);
    expect(parsed.allowed).toEqual([{ kind: 'ipv4', network: 0x0a000000, maskBits: 24 }]);
    expect((await assertEndpointAllowed('http://10.0.0.7', parsed.allowed, { dnsLookup: publicDns })).ok).toBe(true);
  });

  it('运行时多 IP：任一命中禁段即拒；全公网放行；白名单放行；DNS 抛错 fail-closed', async () => {
    // 任一命中禁段 → 拒
    const mixedDns: DnsLookup = async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }];
    expect((await assertEndpointAllowed('http://api.evil.example', allowed(''), { dnsLookup: mixedDns })).ok).toBe(false);
    // 全公网 → 放行
    const publicOnly: DnsLookup = async () => [{ address: '93.184.216.34' }];
    expect((await assertEndpointAllowed('http://api.evil.example', allowed(''), { dnsLookup: publicOnly })).ok).toBe(true);
    // 白名单放行禁段 IP
    const lanDns: DnsLookup = async () => [{ address: '10.0.0.5' }];
    expect((await assertEndpointAllowed('http://vllm.internal', allowed('10.0.0.0/8'), { dnsLookup: lanDns })).ok).toBe(true);
    // DNS 抛错 → fail-closed 拒绝
    const brokenDns: DnsLookup = async () => { throw new Error('dns timeout'); };
    expect((await assertEndpointAllowed('http://api.evil.example', allowed(''), { dnsLookup: brokenDns })).ok).toBe(false);
  });
});
