import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  computeWechatSignature,
  createLoginStateStore,
  ipMatchesCidr,
  ipToInt,
  ipv6MatchesCidr,
  ipv6ToBigInt,
  isIpAllowed,
  isTimestampWithinWindow,
  normalizeCidr,
  normalizeIp,
  parseCidr,
  parseIpv6Cidr,
  parseWechatIlinkEnv,
  parseWechatTimestampMs,
  verifyWechatSignature,
} from '../../../src/features/wechat/index.js';

describe('微信回调验签（signature）', () => {
  const token = 'test-token';
  const timestamp = '1720000000';
  const nonce = 'abc123';

  it('computeWechatSignature = sha1(sort([token,timestamp,nonce]).join())', () => {
    const expected = createHash('sha1')
      .update([token, timestamp, nonce].sort().join(''))
      .digest('hex');
    expect(computeWechatSignature({ token, timestamp, nonce })).toBe(expected);
  });

  it('正确签名通过验签（timingSafeEqual）', () => {
    const signature = computeWechatSignature({ token, timestamp, nonce });
    expect(verifyWechatSignature({ token, timestamp, nonce, signature })).toBe(true);
  });

  it('错误签名 / 篡改字段 / 缺失字段 → false', () => {
    const signature = computeWechatSignature({ token, timestamp, nonce });
    expect(verifyWechatSignature({ token, timestamp, nonce, signature: 'deadbeef' })).toBe(false);
    expect(verifyWechatSignature({ token, timestamp: '1720000001', nonce, signature })).toBe(false);
    expect(verifyWechatSignature({ token, timestamp, nonce: 'other', signature })).toBe(false);
    expect(verifyWechatSignature({ token: 'other-token', timestamp, nonce, signature })).toBe(false);
    expect(verifyWechatSignature({ token, timestamp, nonce, signature: '' })).toBe(false);
  });

  it('parseWechatTimestampMs：秒/毫秒自动识别；非法 → null', () => {
    expect(parseWechatTimestampMs('1720000000')).toBe(1_720_000_000_000);
    expect(parseWechatTimestampMs('1720000000000')).toBe(1_720_000_000_000);
    expect(parseWechatTimestampMs('abc')).toBeNull();
    expect(parseWechatTimestampMs('')).toBeNull();
    expect(parseWechatTimestampMs('9999999999999999')).toBeNull();
  });

  it('isTimestampWithinWindow：±window 内通过，超窗拒绝', () => {
    const now = 1_720_000_000_000;
    expect(isTimestampWithinWindow(now, now, 300_000)).toBe(true);
    expect(isTimestampWithinWindow(now - 300_000, now, 300_000)).toBe(true);
    expect(isTimestampWithinWindow(now + 300_000, now, 300_000)).toBe(true);
    expect(isTimestampWithinWindow(now - 300_001, now, 300_000)).toBe(false);
    expect(isTimestampWithinWindow(now + 600_000, now, 300_000)).toBe(false);
  });
});

describe('回调 IP 白名单（ip-whitelist，P14 t6 细化）', () => {
  it('normalizeIp 剥 IPv4-mapped IPv6 前缀', () => {
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeIp('240e:390::1')).toBe('240e:390::1'); // 纯 IPv6 原样
  });

  it('normalizeCidr：IPv4-mapped CIDR 换算掩码（/120 → /24；隐式 /128 → /32）', () => {
    expect(normalizeCidr('::ffff:203.0.113.0/120')).toBe('203.0.113.0/24');
    expect(normalizeCidr('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeCidr('203.0.113.0/24')).toBe('203.0.113.0/24'); // 非 mapped 原样
    expect(normalizeCidr('240e:390::/38')).toBe('240e:390::/38'); // 纯 IPv6 原样
    // 掩码 <96（覆盖非 mapped 地址）无法精确映射 → 原样（走 IPv6 路径，fail-closed 不误放行）
    expect(normalizeCidr('::ffff:203.0.113.0/64')).toBe('::ffff:203.0.113.0/64');
  });

  it('ipMatchesCidr：IPv4 单 IP（隐式 /32）与 CIDR 前缀', () => {
    expect(ipMatchesCidr('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(ipMatchesCidr('127.0.0.2', '127.0.0.1')).toBe(false);
    expect(ipMatchesCidr('127.0.0.1', '127.0.0.0/24')).toBe(true);
    expect(ipMatchesCidr('127.0.1.1', '127.0.0.0/24')).toBe(false);
    expect(ipMatchesCidr('::ffff:127.0.0.1', '127.0.0.1')).toBe(true); // mapped 归一
    expect(ipMatchesCidr('203.0.113.9', '203.0.113.0/24')).toBe(true);
    expect(ipMatchesCidr('203.0.114.9', '203.0.113.0/24')).toBe(false);
    expect(ipMatchesCidr('not-an-ip', '127.0.0.1')).toBe(false);
    expect(ipMatchesCidr('127.0.0.1', 'not-cidr')).toBe(false);
    expect(ipMatchesCidr('127.0.0.1', '127.0.0.1/33')).toBe(false); // mask 越界
  });

  it('ipv6ToBigInt：完整组 / :: 压缩 / 尾段 IPv4 / 非法', () => {
    expect(ipv6ToBigInt('::')).toBe(0n);
    expect(ipv6ToBigInt('::1')).toBe(1n);
    expect(ipv6ToBigInt('2001:db8::1')).toBe(0x20010db8000000000000000000000001n);
    expect(ipv6ToBigInt('2001:db8::192.168.1.1')).toBe(0x20010db80000000000000000c0a80101n);
    expect(ipv6ToBigInt('2001:db8:0:0:0:0:0:1')).toBe(0x20010db8000000000000000000000001n);
    expect(ipv6ToBigInt('not-an-ip')).toBeNull();
    expect(ipv6ToBigInt('1:2:3:4:5:6:7')).toBeNull(); // 段数不足（无 ::）
    expect(ipv6ToBigInt('1:2:3:4:5:6:7:8:9')).toBeNull(); // 段数超 8
    expect(ipv6ToBigInt('1::2::3')).toBeNull(); // 两个 ::
    expect(ipv6ToBigInt('gggg::1')).toBeNull(); // 非法 hex
  });

  it('parseIpv6Cidr：隐式 /128 与显式前缀；mask 越界/非法 → null；mapped CIDR 属调度层不在此解析', () => {
    expect(parseIpv6Cidr('2001:db8::1')).toEqual({ network: 0x20010db8000000000000000000000001n, maskBits: 128 });
    expect(parseIpv6Cidr('2001:db8::/32')).toEqual({ network: 0x20010db8000000000000000000000000n, maskBits: 32 });
    expect(parseIpv6Cidr('2001:db8::/129')).toBeNull(); // mask 越界
    expect(parseIpv6Cidr('not-cidr')).toBeNull();
    expect(parseIpv6Cidr('::ffff:203.0.113.0/120')).toBeNull(); // mapped 归一由 isIpAllowed 调度层做（IPv4 路径）
  });

  it('ipv6MatchesCidr：前缀匹配 / 越界 / 隐式 /128', () => {
    expect(ipv6MatchesCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipv6MatchesCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipv6MatchesCidr('2001:db8::1', '2001:db8::1/128')).toBe(true);
    expect(ipv6MatchesCidr('2001:db8::2', '2001:db8::1/128')).toBe(false);
    expect(ipv6MatchesCidr('::1', '::/0')).toBe(true); // /0 全放行
    expect(ipv6MatchesCidr('240e:390:1::1', '240e:390::/38')).toBe(true);
    expect(ipv6MatchesCidr('240e:391::1', '240e:390::/38')).toBe(false);
    expect(ipv6MatchesCidr('not-an-ip', '2001:db8::/32')).toBe(false);
  });

  it('isIpAllowed：空白名单 fail-closed 全拒；IPv4 命中放行', () => {
    expect(isIpAllowed('127.0.0.1', [])).toBe(false);
    expect(isIpAllowed('203.0.113.9', [])).toBe(false);
    expect(isIpAllowed('127.0.0.1', ['127.0.0.1'])).toBe(true);
    expect(isIpAllowed('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(isIpAllowed('198.51.100.7', ['203.0.113.0/24'])).toBe(false);
  });

  it('isIpAllowed：IPv6 命中放行 / 未命中拒绝；IPv4-mapped 归一命中', () => {
    expect(isIpAllowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(isIpAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(isIpAllowed('::1', ['::1'])).toBe(true);
    expect(isIpAllowed('240e:390:1::1', ['240e:390::/38'])).toBe(true);
    expect(isIpAllowed('240e:391::1', ['240e:390::/38'])).toBe(false);
    // IPv4-mapped IP 命中 IPv4 CIDR（normalizeIp 归一）
    expect(isIpAllowed('::ffff:203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    // IPv4-mapped CIDR 命中 IPv4 IP（normalizeCidr 换算）
    expect(isIpAllowed('203.0.113.9', ['::ffff:203.0.113.0/120'])).toBe(true);
  });

  it('isIpAllowed：IPv4/IPv6 混合多组白名单（任一命中放行，均未命中拒绝）', () => {
    const multi = ['127.0.0.1', '203.0.113.0/24', '2001:db8::/32', '240e:390::/38'];
    expect(isIpAllowed('127.0.0.1', multi)).toBe(true);
    expect(isIpAllowed('203.0.113.9', multi)).toBe(true);
    expect(isIpAllowed('2001:db8::1', multi)).toBe(true);
    expect(isIpAllowed('240e:390:1::1', multi)).toBe(true);
    expect(isIpAllowed('198.51.100.7', multi)).toBe(false);
    expect(isIpAllowed('2001:db9::1', multi)).toBe(false);
  });

  it('isIpAllowed：空白名单之外非法 IP 一律拒绝（fail-closed 不误放行）', () => {
    expect(isIpAllowed('not-an-ip', ['127.0.0.1'])).toBe(false);
    expect(isIpAllowed('', ['127.0.0.1'])).toBe(false);
    expect(isIpAllowed('::ffff:not-ip', ['::1'])).toBe(false);
    expect(ipToInt('::ffff:203.0.113.9')).toBe(0xcb007109); // 归一后 IPv4 解析
    expect(parseCidr('::ffff:203.0.113.0/120')).toBeNull(); // parseCidr 只处理 IPv4（mapped 归一由 normalizeCidr/isIpAllowed 层做）
  });
});

describe('登录 state 存储（login-state-store）', () => {
  it('create 生成一次性随机 state；TTL 过期后 get 返回 undefined 并清除', () => {
    let fakeNow = 1_000_000;
    const store = createLoginStateStore({ ttlMs: 1000, nowMs: () => fakeNow, sweepIntervalMs: 60_000 });
    const state = store.create({});
    expect(typeof state).toBe('string');
    expect(state!.length).toBeGreaterThanOrEqual(32);
    expect(store.get(state!)).toBeDefined();

    fakeNow += 1500; // 超 TTL
    expect(store.get(state!)).toBeUndefined();
    expect(store.size()).toBe(0); // 过期即清除
  });

  it('状态机单向流转：pending → confirmed → bound；重放被拒绝', () => {
    let fakeNow = 1_000_000;
    const store = createLoginStateStore({ ttlMs: 60_000, nowMs: () => fakeNow, sweepIntervalMs: 60_000 });
    const state = store.create({ teacherId: 't-1' });
    expect(store.markConfirmed(state!, { externalUserId: 'wx-1' })).toBe(true);
    expect(store.markConfirmed(state!, { externalUserId: 'wx-2' })).toBe(false); // 已 confirmed
    expect(store.markBound(state!)).toBe(true);
    expect(store.markBound(state!)).toBe(false); // 已 bound：重放拒绝
    expect(store.get(state!)!.status).toBe('bound');
  });

  it('create 带 teacherId（已登录发起）；键数上限返回 null', () => {
    const store = createLoginStateStore({ ttlMs: 60_000, maxKeys: 2, sweepIntervalMs: 60_000 });
    const a = store.create({ teacherId: 't-1' });
    const b = store.create({});
    expect(store.get(a!)!.teacherId).toBe('t-1');
    expect(store.get(b!)!.teacherId).toBeUndefined();
    expect(store.create({})).toBeNull(); // 键数达上限
  });

  it('sweep 剪除过期键（unref 定时器由测试手动触发）', () => {
    let fakeNow = 1_000_000;
    const store = createLoginStateStore({ ttlMs: 1000, nowMs: () => fakeNow, sweepIntervalMs: 60_000 });
    store.create({});
    store.create({});
    expect(store.size()).toBe(2);
    fakeNow += 5000;
    store.sweep();
    expect(store.size()).toBe(0);
  });
});

describe('env 配置解析（config）', () => {
  it('默认：enabled=false、白名单空（fail-closed）、保守限流默认值', () => {
    const config = parseWechatIlinkEnv({});
    expect(config.enabled).toBe(false);
    expect(config.allowedIps).toEqual([]);
    expect(config.stateTtlMs).toBe(5 * 60 * 1000);
    expect(config.qrcodeRatePerMin).toBe(20);
    expect(config.callbackRatePerMin).toBe(60);
  });

  it('enabled=true 时关键项缺失 → 启动红线抛错', () => {
    expect(() => parseWechatIlinkEnv({ WECHAT_ILINK_ENABLED: 'true' })).toThrow(/必填/);
    expect(() =>
      parseWechatIlinkEnv({ WECHAT_ILINK_ENABLED: 'true', WECHAT_ILINK_APPID: 'a' }),
    ).toThrow(/必填/);
  });

  it('enabled=true 且关键项齐全 → 通过；IP 白名单解析', () => {
    const config = parseWechatIlinkEnv({
      WECHAT_ILINK_ENABLED: 'true',
      WECHAT_ILINK_APPID: 'appid',
      WECHAT_ILINK_APPSECRET: 'secret',
      WECHAT_ILINK_TOKEN: 'token',
      WECHAT_ILINK_ALLOWED_IPS: '127.0.0.1, 203.0.113.0/24',
      WECHAT_ILINK_QRCODE_RATE_PER_MIN: '5',
    });
    expect(config.enabled).toBe(true);
    expect(config.allowedIps).toEqual(['127.0.0.1', '203.0.113.0/24']);
    expect(config.qrcodeRatePerMin).toBe(5);
  });

  it('非法数值回退默认（parsePositiveInt 纪律）', () => {
    const config = parseWechatIlinkEnv({ WECHAT_ILINK_STATE_TTL_MS: 'abc' });
    expect(config.stateTtlMs).toBe(5 * 60 * 1000);
  });

  it('W0 传输参数：botToken/长轮询 40s/退避序列/连续失败上限/context TTL/出站超时 默认与解析', () => {
    const defaults = parseWechatIlinkEnv({});
    expect(defaults.botToken).toBe(''); // 凭证默认空（fail-closed，不落盘）
    expect(defaults.longPollTimeoutMs).toBe(40_000); // iLink 40s 长轮询（W0 冻结）
    expect(defaults.pollBackoffMs).toEqual([2000, 5000, 30_000]);
    expect(defaults.maxConsecutivePollFailures).toBe(3);
    expect(defaults.contextTokenTtlMs).toBe(24 * 60 * 60 * 1000);
    expect(defaults.outboundTimeoutMs).toBe(15_000);

    const parsed = parseWechatIlinkEnv({
      WECHAT_ILINK_BOT_TOKEN: 'bot-token-1',
      WECHAT_ILINK_LONG_POLL_TIMEOUT_MS: '60000',
      WECHAT_ILINK_POLL_BACKOFF_MS: '1000, 3000',
      WECHAT_ILINK_MAX_POLL_FAILURES: '5',
      WECHAT_ILINK_CONTEXT_TOKEN_TTL_MS: '3600000',
      WECHAT_ILINK_OUTBOUND_TIMEOUT_MS: '8000',
    });
    expect(parsed.botToken).toBe('bot-token-1');
    expect(parsed.longPollTimeoutMs).toBe(60_000);
    expect(parsed.pollBackoffMs).toEqual([1000, 3000]);
    expect(parsed.maxConsecutivePollFailures).toBe(5);
    expect(parsed.contextTokenTtlMs).toBe(3_600_000);
    expect(parsed.outboundTimeoutMs).toBe(8_000);

    // 非法退避序列 → 回退默认
    expect(parseWechatIlinkEnv({ WECHAT_ILINK_POLL_BACKOFF_MS: 'abc' }).pollBackoffMs).toEqual([2000, 5000, 30_000]);
  });
});
