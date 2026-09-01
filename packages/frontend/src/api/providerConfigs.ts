import { apiRequest } from './client';
import type {
  ProviderConfigDto,
  ProviderConfigKind,
  ProviderTestResult,
  UsageSummary,
} from './types';

/** POST /api/v1/provider-configs 新增（首条自动 isPrimary）。 */
export interface CreateProviderConfigRequest {
  providerKind: ProviderConfigKind;
  providerName: string;
  displayName?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** PATCH /api/v1/provider-configs/:id 更新（apiKey 留空不修改；isPrimary=true 触发唯一化）。 */
export interface UpdateProviderConfigRequest {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  status?: string;
  isPrimary?: boolean;
}

/** GET /api/v1/provider-configs — 列表（含 apiKeyMasked + isPrimary）。 */
export function listProviderConfigs(teacherId: string): Promise<ProviderConfigDto[]> {
  return apiRequest('/provider-configs', { teacherId });
}

/** POST /api/v1/provider-configs — 新增。 */
export function createProviderConfig(
  teacherId: string,
  body: CreateProviderConfigRequest,
): Promise<ProviderConfigDto> {
  return apiRequest('/provider-configs', { method: 'POST', teacherId, body });
}

/** PATCH /api/v1/provider-configs/:id — 更新（apiKey 可更新；更新后 masked 刷新）。 */
export function updateProviderConfig(
  teacherId: string,
  configId: string,
  body: UpdateProviderConfigRequest,
): Promise<ProviderConfigDto> {
  return apiRequest(`/provider-configs/${encodeURIComponent(configId)}`, {
    method: 'PATCH',
    teacherId,
    body,
  });
}

/** DELETE /api/v1/provider-configs/:id — 删除（删 primary → 提升其一，无剩余回退默认）。 */
export function removeProviderConfig(
  teacherId: string,
  configId: string,
): Promise<{ removed: boolean }> {
  return apiRequest(`/provider-configs/${encodeURIComponent(configId)}`, {
    method: 'DELETE',
    teacherId,
  });
}

/** POST /api/v1/provider-configs/:id/test — 连通性测试（返回 ProviderError kind）。 */
export function testProviderConfig(
  teacherId: string,
  configId: string,
): Promise<ProviderTestResult> {
  return apiRequest(`/provider-configs/${encodeURIComponent(configId)}/test`, {
    method: 'POST',
    teacherId,
  });
}

/** 设为 primary：PATCH isPrimary=true（后端先清同教师其他 primary）。 */
export function setPrimaryProviderConfig(
  teacherId: string,
  configId: string,
): Promise<ProviderConfigDto> {
  return updateProviderConfig(teacherId, configId, { isPrimary: true });
}

/** GET /api/v1/usage/summary?from&to — 按教师聚合用量（owner 隔离）。 */
export function getUsageSummary(
  teacherId: string,
  from: string,
  to: string,
): Promise<UsageSummary> {
  const query = new URLSearchParams({ from, to });
  return apiRequest(`/usage/summary?${query.toString()}`, { teacherId });
}
