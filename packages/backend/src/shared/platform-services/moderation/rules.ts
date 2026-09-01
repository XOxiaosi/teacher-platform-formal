/**
 * 本地文本审核规则引擎（P13 D 切片 · moderation，设计 p10-platform-services-design.md §8.4 D6）。
 *
 * 本地规则优先：内置基础规则集（敏感词/正则）零外部依赖、零出域、零费用——
 * 命中 → { flagged: true, reasons: [...] }（reasons 为规则组 id + 中文描述，供人工复核/审计）。
 * 未命中 → { flagged: false, reasons: [] }。
 *
 * 语义安全：本地规则只做「标记」（flag → 人工复核 review），不做「阻断」（block）——
 * 与既有占位「review 而非 pass/block」心智一致，宁可人工复核不可误杀。
 *
 * 纪律：纯函数（无 I/O、无 Date）；正则全部预编译；白名单防习语/语境误杀。
 */

/** 本地规则组：id / 描述 / 命中正则 / 白名单（整段文本命中白名单 → 该组不标 flag）。 */
export interface LocalRuleGroup {
  /** 规则组 id（写入 reasons，如 'violence'）。 */
  id: string;
  /** 中文描述（写入 reasons，人工复核可读）。 */
  description: string;
  /** 命中正则（任一命中即该组 flagged）。 */
  patterns: RegExp[];
  /** 白名单正则（任一匹配则抑制该组 flag，防习语/语境误杀）。 */
  whitelist?: RegExp[];
}

/**
 * 内置基础规则集（保守：宁可漏标不可误杀；分类：暴力/色情/辱骂/广告引流/隐私泄露）。
 * 说明：
 * - 正则均为预编译字面量（模块加载一次）；
 * - 白名单示例：「打死也不说」习语（violence 组 pattern /打死/ 命中时被白名单抑制）；
 * - 隐私泄露组含手机号/身份证正则——本平台证据链含学生/家长信息，隐私泄露标记得分最高；
 * - 规则集可后续按场景（scene）细化，当前全场景生效（scene 由调用方传入，规则引擎不区分）。
 */
export const LOCAL_MODERATION_RULES: LocalRuleGroup[] = [
  {
    id: 'violence',
    description: '暴力/威胁言论',
    patterns: [/杀人/, /砍死/, /打死/, /弄死/, /捅死/, /绑架/, /炸弹/, /自杀/, /跳楼/],
    whitelist: [/打死也不说/],
  },
  {
    id: 'porn',
    description: '色情内容',
    patterns: [/色情/, /裸照/, /裸体/, /卖淫/, /嫖娼/, /约炮/, /黄色网站/],
  },
  {
    id: 'abuse',
    description: '辱骂/人身攻击',
    patterns: [/傻逼/, /煞笔/, /他妈的/, /操你/, /去死/, /废物/, /贱人/, /滚蛋/],
    whitelist: [/他妈妈/],
  },
  {
    id: 'ad',
    description: '广告/引流',
    patterns: [/加微信/, /加vx/, /加v/, /优惠促销/, /免费领取/, /扫码/, /代购/, /刷单/, /兼职日结/, /qq群/],
  },
  {
    id: 'privacy',
    description: '隐私泄露（手机号/身份证/敏感凭证）',
    patterns: [
      /\b1[3-9]\d{9}\b/,           // 大陆手机号（11 位）
      /\b\d{17}[\dXx]\b/,          // 18 位身份证号
      /身份证号/, /银行卡号/, /信用卡号/, /验证码/, /登录密码/, /支付密码/,
    ],
  },
];

/**
 * 本地规则审核（纯函数）。
 * @param text 待审核文本（原始输入，不 trim——命中判断不依赖首尾空白）
 * @returns { flagged, reasons }：flagged=任一规则组命中；reasons=命中组 id（描述）数组，按规则顺序去重
 */
export function moderateWithLocalRules(text: string): { flagged: boolean; reasons: string[] } {
  if (typeof text !== 'string' || text.length === 0) {
    return { flagged: false, reasons: [] };
  }
  const reasons: string[] = [];
  for (const group of LOCAL_MODERATION_RULES) {
    if (group.whitelist && group.whitelist.some((pattern) => pattern.test(text))) {
      continue; // 白名单命中：抑制该组 flag（防习语/语境误杀）
    }
    if (group.patterns.some((pattern) => pattern.test(text))) {
      reasons.push(`${group.id}（${group.description}）`);
    }
  }
  return { flagged: reasons.length > 0, reasons };
}
