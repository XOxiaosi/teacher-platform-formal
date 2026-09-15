/**
 * 媒体资产服务的公共装配入口。
 *
 * 文件、证据与所有权操作在 media-asset-file-operations；状态流转与异步处理任务在
 * media-asset-processing-operations；worker、加密读取和供应商调用在
 * media-asset-processing-jobs。此处只组合既有接口，保持路由和组合层的 API 不变。
 */

import { createMediaAssetFileOperations } from './media-asset-file-operations.js';
import type { CreateMediaAssetServiceOptions } from './media-asset-service-options.js';
import { createMediaAssetProcessingOperations } from './media-asset-processing-operations.js';
import { createMediaAssetServiceRuntime } from './media-asset-service-runtime.js';
import type { MediaAssetService } from './types.js';

export type { CreateMediaAssetServiceOptions } from './media-asset-service-options.js';

export function createMediaAssetService(options: CreateMediaAssetServiceOptions): MediaAssetService {
  const runtime = createMediaAssetServiceRuntime(options);
  return {
    ...createMediaAssetFileOperations(runtime),
    ...createMediaAssetProcessingOperations(runtime),
  };
}
