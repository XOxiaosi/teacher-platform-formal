/**
 * 平台预配服务契约（P10 平台预配线 · t6，设计 p10-platform-services-design.md）。
 *
 * 边界：语音 ASR / 图片 OCR / 病毒扫描 / 文本审核 = 平台统一预配（env 级），
 * 不进教师 ProviderConfig（provider-configs 表/路由均不涉及，D51 §5.3）。
 *
 * A1 切片只落 ASR 转写接口：统一输入输出契约 + 错误归一复用 llm-provider-compat 的
 * ProviderError 心智（kind/status/message/retryable，零新错误类型）。
 * A2（P11）扩展 OCR 接口（ocr-client）+ 文本审核占位（moderation-client，默认 off）：
 * 同构契约——adapter 只见解密后明文 Buffer（密钥——mediaCipher 永不出媒体服务层）。
 * A3/C（P12）扩展病毒扫描接口（scan-client）：scan(buffer) → {status: clean|infected|error, threatName?}，
 * 驱动 MediaAsset.scanStatus（skipped→pending→clean|infected|error）；infected 触发隔离语义（下载拒绝 +
 * 证据关联拒绝）；未配置/未装 clamd 占位降级不崩服。
 */

// 错误归一：直接复用 llm-provider-compat 的 ProviderError（kind/status/message/retryable，设计 §3.1）
export { ProviderError, providerError } from '../llm-provider-compat/types.js';
export type { ProviderError as PlatformServiceError } from '../llm-provider-compat/types.js';

/** 平台服务种类（A1 asr + A2 ocr/moderation；scan 阶段三-C 预留）。 */
export type PlatformServiceKind = 'asr' | 'ocr' | 'scan' | 'moderation';

/** ASR 转写请求（统一内部模型；content = 解密后明文）。 */
export interface TranscribeRequest {
  /** 媒体资产 id（审计/日志关联）。 */
  assetId: string;
  /** 明文 sha256（作业幂等键——同一文件不重复转写）。 */
  sha256: string;
  /** 解密后的音频内容（adapter 只见明文 Buffer，密钥不出服务层）。 */
  content: Buffer;
  /** audio/mpeg | audio/wav | audio/mp4（上传白名单嗅探结果）。 */
  mimeType: string;
  /** 可选语言提示（如 'zh-CN'）。 */
  languageHint?: string;
}

/** ASR 转写响应。 */
export interface TranscribeResponse {
  /** 转写全文（写回 MediaAsset.transcriptionText / StudentSourceRecord.rawText）。 */
  text: string;
  /** 置信度（0..1；占位 adapter 返回 0）。 */
  confidence?: number;
}

/** ASR adapter（每供应商一个实现；A1 只有占位实现，真实供应商待用户确认后启用）。 */
export interface AsrAdapter {
  /** 供应商标识：placeholder | tencent | whisper | ...（PLATFORM_ASR_PROVIDER 映射）。 */
  provider: string;
  /**
   * 转写。失败抛 ProviderError（retryable 驱动指数退避重试，设计 §6）；
   * 非 ProviderError 异常按不可重试处理（快速失败，不烧重试次数）。
   */
  transcribe(input: TranscribeRequest): Promise<TranscribeResponse>;
}

/** OCR 请求（统一内部模型；content = 解密后明文，adapter 只见明文 Buffer，密钥不出服务层）。 */
export interface OcrRequest {
  /** 媒体资产 id（审计/日志关联）。 */
  assetId: string;
  /** 明文 sha256（作业幂等键——同一文件不重复识别）。 */
  sha256: string;
  /** 解密后的图片内容。 */
  content: Buffer;
  /** image/png | image/jpeg | image/webp（上传白名单嗅探结果）。 */
  mimeType: string;
}

/** OCR 版面块（MediaAnalysis.layoutBlocks 输入；bbox=null 表示无位置信息）。 */
export interface OcrLayoutBlock {
  text: string;
  bbox: { x: number; y: number; w: number; h: number } | null;
}

/** OCR 响应（写回 MediaAsset.ocrText / ocrLayoutBlocks）。 */
export interface OcrResponse {
  /** 识别全文（版面拼接顺序）。 */
  text: string;
  /** 版面块（bounding box，区域证据 D40 §5.5 输入）；占位 adapter 返回 []。 */
  blocks?: OcrLayoutBlock[];
  /** 置信度（0..1；占位 adapter 返回 0）。 */
  confidence?: number;
}

/** OCR adapter（每供应商一个实现；A2 只有占位实现，真实供应商待用户确认后启用）。 */
export interface OcrAdapter {
  /** 供应商标识：placeholder | tencent | ...（PLATFORM_OCR_PROVIDER 映射）。 */
  provider: string;
  /**
   * 图片识别。失败抛 ProviderError（retryable 驱动指数退避重试，设计 §6）；
   * 非 ProviderError 异常按不可重试处理（快速失败，不烧重试次数）。
   */
  ocr(input: OcrRequest): Promise<OcrResponse>;
}

/** 文本审核请求（阶段三-D 可选；默认 off）。 */
export interface ModerationRequest {
  text: string;
  /** 场景标签（审核策略可区分）。 */
  scene: 'student_source' | 'feedback' | 'chat' | 'communication';
}

/** 文本审核响应。 */
export interface ModerationResponse {
  /** review → 人工复核；block → 拒写入证据链。 */
  verdict: 'pass' | 'review' | 'block';
  labels: string[];
  /**
   * 本地规则命中标记（D 切片）：true = 内置规则引擎命中（reasons 给出原因）；
   * false/undefined = 未命中（pass）或未实际审核（占位 review）。
   */
  flagged?: boolean;
  /** 命中原因（本地规则：规则组 id + 中文描述，如 'violence（暴力/威胁言论）'）；未命中 = []。 */
  reasons?: string[];
}

/** 文本审核 adapter（默认 off——PLATFORM_MODERATION_PROVIDER=none 不实例化）。 */
export interface ModerationAdapter {
  provider: string;
  moderateText(input: ModerationRequest): Promise<ModerationResponse>;
}

/** 病毒扫描请求（统一内部模型；content = 解密后明文，adapter 只见明文 Buffer，密钥不出服务层）。 */
export interface ScanRequest {
  /** 媒体资产 id（审计/日志关联）。 */
  assetId: string;
  /** 明文 sha256（幂等键——同一文件不重复扫描）。 */
  sha256: string;
  /** 解密后的文件内容。 */
  content: Buffer;
  /** image/png | image/jpeg | image/webp | audio/mpeg | audio/wav | audio/mp4（上传白名单嗅探结果）。 */
  mimeType: string;
}

/** 病毒扫描响应（阶段三-C 契约：status 三态；infected 时携带威胁名）。 */
export interface ScanResponse {
  /** clean=未检出；infected=命中威胁（触发隔离语义）；error=引擎级失败（未完成扫描，可重扫）。 */
  status: 'clean' | 'infected' | 'error';
  /** infected 时：命中威胁名（写回 MediaAsset.scanThreatName，管理端可查看）。 */
  threatName?: string;
  /** status='error' 时：原因说明（仅日志/作业错误展示，非业务数据）。 */
  message?: string;
}

/** 病毒扫描 adapter（每供应商一个实现；阶段三-C 只有占位实现，真实 ClamAV 待用户确认后启用）。 */
export interface ScanAdapter {
  /** 供应商标识：placeholder | clamav | tencent | ...（PLATFORM_SCAN_PROVIDER 映射）。 */
  provider: string;
  /**
   * 扫描。失败抛 ProviderError（retryable 驱动指数退避重试，设计 §6）；
   * 非 ProviderError 异常按不可重试处理（快速失败，不烧重试次数）；
   * 引擎级失败也可返回 { status: 'error', message }（不抛错，同样落 scanStatus=error 可重扫）。
   */
  scan(input: ScanRequest): Promise<ScanResponse>;
}

/** 平台服务门面（业务层只依赖本集合；未启用的服务不实例化 = undefined，调用方走降级）。 */
export interface PlatformServices {
  asr?: AsrAdapter;
  ocr?: OcrAdapter;
  /** 阶段三-C：病毒扫描。provider=none（缺省）不实例化——上传保持 skipped（基线零破坏）；
   *  clamav/tencent 已配置但真实 adapter 未实现 → 占位降级（scan 返回 status='error'，不静默放行）。 */
  scan?: ScanAdapter;
  moderation?: ModerationAdapter; // 阶段三-D（可选；默认 off）
}
