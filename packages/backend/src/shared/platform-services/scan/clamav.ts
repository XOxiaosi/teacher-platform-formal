/**
 * 病毒扫描真实供应商骨架：ClamAV 自建（clamd）——不出域默认路径（P13 评估 §5 D5 + §8.3）。
 *
 * 红线：用户确认前**不实现真实调用**（T9 资源确认：clamd 安装 + freshclam 定时更新病毒库；
 * 不出域但属运维资源投入，仍需确认）。本骨架只做：
 * - 工厂 `createClamavScanAdapter(env)`（契约 §8.3，替换 `scan/placeholder.ts` 装配分支）；
 * - 读 env：PLATFORM_SCAN_CLAMAV_HOST（缺省 127.0.0.1）/ PLATFORM_SCAN_CLAMAV_PORT（缺省 3310）
 *   （复用 config.ts 既有 env 契约）；
 * - 未确认降级：scan 返回 { status: 'error', message }——**不静默放行（绝不伪造 clean）也不误杀
 *   （绝不伪造 infected）**，交由 scanStatus=error 表达「扫描未实际执行，可重扫」（同占位安全语义）。
 *
 * 用户确认 T9 后接真实调用的接入点（见文件尾部 TODO）：clamd INSTREAM 协议（socket/网络流式送 Buffer）→
 * FOUND → { status:'infected', threatName }（写回 MediaAsset.scanThreatName，触发隔离）；OK → { status:'clean' }；
 * 连接失败/引擎错误 → { status:'error', message }（scanStatus=error 可重扫）或 ProviderError。零新依赖。
 */

import type { ScanAdapter, ScanRequest, ScanResponse } from '../types.js';
import { PLATFORM_SCAN_CLAMAV_HOST_ENV, PLATFORM_SCAN_CLAMAV_PORT_ENV } from '../config.js';

/** ClamAV 骨架配置（env 读取结果；host 缺省 127.0.0.1，port 缺省 3310）。 */
export interface ClamavScanConfig {
  /** clamd 地址（缺省 127.0.0.1）。 */
  host: string;
  /** clamd 端口（缺省 3310；非法值回落 3310）。 */
  port: number;
}

/** 读 ClamAV 配置（纯函数，测试可注入 env；与 parsePlatformServicesEnv 的 host/port 解析一致）。 */
export function readClamavScanConfig(env: NodeJS.ProcessEnv = process.env): ClamavScanConfig {
  const host = (env[PLATFORM_SCAN_CLAMAV_HOST_ENV] ?? '127.0.0.1').trim() || '127.0.0.1';
  const portRaw = Number(env[PLATFORM_SCAN_CLAMAV_PORT_ENV] ?? '3310');
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw < 65536 ? portRaw : 3310;
  return { host, port };
}

/** 未确认降级消息（含 PLATFORM_SCAN_PROVIDER=clamav + 「用户确认后」标注——既有测试断言这两处）。 */
export const CLAMAV_PENDING_CONFIRMATION_MESSAGE =
  'PLATFORM_SCAN_PROVIDER=clamav 已配置但未确认（T9 资源确认：clamd 安装 + freshclam 定时更新）——真实调用未启用（用户确认后接入 clamd INSTREAM 协议）';

/**
 * 创建 ClamAV 扫描 adapter（骨架）。
 * @param env 进程 env（测试可注入）；读取 PLATFORM_SCAN_CLAMAV_HOST / PLATFORM_SCAN_CLAMAV_PORT
 */
export function createClamavScanAdapter(env: NodeJS.ProcessEnv = process.env): ScanAdapter {
  const config = readClamavScanConfig(env);
  return {
    provider: 'clamav',
    async scan(_input: ScanRequest): Promise<ScanResponse> {
      // 未确认降级：不实际扫描——返回 error（不伪造 clean 放行，也不伪造 infected 误杀）
      return {
        status: 'error',
        message: `${CLAMAV_PENDING_CONFIRMATION_MESSAGE}（target=${config.host}:${config.port}）`,
      };
    },
  };
}

// TODO(user-confirmed · T9)：用户确认资源后在此接入 clamd INSTREAM 协议——
//   net 连接 `${config.host}:${config.port}` → 发送 zINSTREAM + 分块 Buffer → 读响应。
//   FOUND → { status:'infected', threatName }；OK → { status:'clean' }；
//   连接失败/引擎错误 → { status:'error', message }（scanStatus=error 可重扫）。
//   本骨架阶段以上代码不落地（红线：用户确认前不接任何服务）。
