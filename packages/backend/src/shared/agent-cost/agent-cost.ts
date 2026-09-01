/**
 * Agent 成本控制 · token 预算模块（P2 · t48，D50 §5.3）。
 *
 * 三个能力：
 * 1. estimateTokens(text)：近似 token 估算（零依赖——字符数/4 启发式，
 *    对中文约 1 字 ≈ 1 token，对英文约 4 字符 ≈ 1 token，取两者上限的折中；
 *    用于预算记账与截断决策，非精确计费）。
 * 2. createBudgetTracker({ dailyTokenLimit, perTurnTokenLimit })：内存记账
 *    Map<teacherId, { usedToday, dateKey }>，按本地日期窗口重置；
 *    checkAndConsume(teacherId, tokens) 返回 { ok, remaining, exceeded? }。
 * 3. truncateHistory(turns, maxTokens)：超预算时丢弃最旧回合，保留
 *    system 首条 + 最近回合（对话上下文关键性：越新越相关）。
 *
 * env（装配时由调用方读取，本模块只收参数）：
 *   AGENT_DAILY_TOKEN_LIMIT  默认 50000
 *   AGENT_TURN_TOKEN_LIMIT   默认 8000
 *
 * 装配交接（t48）：agent-converse 用例入口调用 budgetTracker.checkAndConsume
 * 超限返回 contracts.budgetExceeded（code='BUDGET_EXCEEDED'）；index.ts 装配线
 * 归 backend3，本模块与测试独立交付。
 */

/** 近似 token 估算：CJK 字符 ≈ 1 token，其余字符按 4 字符 ≈ 1 token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK 统一表意文字 + 全角标点 + 韩文/日文假名区间（近似）
    if (
      (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0x3000 && code <= 0x303f)
      || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x3040 && code <= 0x30ff)
    ) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return cjkCount + Math.ceil(otherCount / 4);
}

export interface BudgetConfig {
  dailyTokenLimit: number;
  perTurnTokenLimit: number;
}

export interface ConsumeResult {
  ok: boolean;
  usedToday: number;
  remaining: number;
  /** 本轮请求 token 数是否超过单轮上限。 */
  turnExceeded: boolean;
  /** 本轮消耗后是否超过每日预算（ok=false 的原因）。 */
  dailyExceeded: boolean;
}

export interface BudgetTracker {
  /** 检查并记账：返回消耗结果；每日超限返回 ok=false（不记账）。 */
  checkAndConsume(teacherId: string, tokens: number, now?: Date): ConsumeResult;
  /** 当前已用（当日）。 */
  usedToday(teacherId: string, now?: Date): number;
  /** 重置某教师当日记账（测试/运维用）。 */
  reset(teacherId: string): void;
}

/** 本地日期键（YYYY-MM-DD），窗口重置基准。 */
export function dateKeyOf(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function createBudgetTracker(config: BudgetConfig): BudgetTracker {
  const state = new Map<string, { usedToday: number; dateKey: string }>();

  function entryFor(teacherId: string, now: Date): { usedToday: number; dateKey: string } {
    const key = dateKeyOf(now);
    const existing = state.get(teacherId);
    if (existing && existing.dateKey === key) return existing;
    const fresh = { usedToday: 0, dateKey: key };
    state.set(teacherId, fresh);
    return fresh;
  }

  return {
    checkAndConsume(teacherId: string, tokens: number, now = new Date()) {
      if (tokens < 0) tokens = 0;
      const entry = entryFor(teacherId, now);
      const turnExceeded = tokens > config.perTurnTokenLimit;
      const nextUsed = entry.usedToday + tokens;
      const dailyExceeded = nextUsed > config.dailyTokenLimit;

      if (turnExceeded || dailyExceeded) {
        return {
          ok: false,
          usedToday: entry.usedToday,
          remaining: Math.max(0, config.dailyTokenLimit - entry.usedToday),
          turnExceeded,
          dailyExceeded,
        };
      }

      entry.usedToday = nextUsed;
      return {
        ok: true,
        usedToday: entry.usedToday,
        remaining: config.dailyTokenLimit - entry.usedToday,
        turnExceeded: false,
        dailyExceeded: false,
      };
    },
    usedToday(teacherId: string, now = new Date()) {
      return entryFor(teacherId, now).usedToday;
    },
    reset(teacherId: string) {
      state.delete(teacherId);
    },
  };
}

export interface TruncatableTurn {
  role: string;
  content: string;
}

/**
 * 截断策略：总 token 超 maxTokens 时**丢弃最旧回合**，保留：
 * - 第一条 system（上下文锚点，如时间/规则）恒在首位；
 * - 最近的回合优先（对话相关性随时间衰减——保留最新上下文）。
 * 返回截断后的回合数组（保持原始顺序）。
 */
export function truncateHistory(
  turns: TruncatableTurn[],
  maxTokens: number,
  estimate = estimateTokens,
): TruncatableTurn[] {
  if (turns.length === 0) return turns;
  const total = turns.reduce((sum, turn) => sum + estimate(turn.content), 0);
  if (total <= maxTokens) return turns;

  // 第一条 system（若存在）恒保留在首位
  const keepSystem = turns[0]?.role === 'system' ? turns[0] : undefined;
  const tailStart = keepSystem ? 1 : 0;
  const tail = turns.slice(tailStart);

  // 从尾部（最新）向前累计预算
  const keptTail: TruncatableTurn[] = [];
  let used = keepSystem ? estimate(keepSystem.content) : 0;
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const turn = tail[index];
    const cost = estimate(turn.content);
    if (used + cost > maxTokens) break;
    keptTail.unshift(turn);
    used += cost;
  }

  // 兜底：预算极小导致空上下文时，至少保留最新一条（system 或最后回合）
  if (keptTail.length === 0 && keepSystem) {
    keptTail.push(tail[tail.length - 1]);
  }
  if (keptTail.length === 0 && tail.length > 0) {
    keptTail.push(tail[tail.length - 1]);
  }

  return keepSystem ? [keepSystem, ...keptTail] : keptTail;
}

/** 从 env 读取预算配置（默认 50000/8000）。 */
export function budgetConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BudgetConfig {
  const daily = Number(env.AGENT_DAILY_TOKEN_LIMIT ?? 50000);
  const perTurn = Number(env.AGENT_TURN_TOKEN_LIMIT ?? 8000);
  return {
    dailyTokenLimit: Number.isFinite(daily) && daily > 0 ? daily : 50000,
    perTurnTokenLimit: Number.isFinite(perTurn) && perTurn > 0 ? perTurn : 8000,
  };
}
