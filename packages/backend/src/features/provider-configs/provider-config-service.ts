/**
 * ProviderConfig 服务（P7 渠道线 · t63，t57 设计 §2）。
 *
 * owner 隔离：所有查询 WHERE teacherId = 调用者（requireAuth 后由路由传入）；
 * apiKey 只写不回：写入时 AES-256-GCM 加密落 apiKeyEnc，任何返回只含 apiKeyMasked；
 * primary 唯一化：设为 primary 时先清同教师其他 primary；删 primary 提升其一，无剩余回退默认。
 */

import { err, ok, validationError, notFound, internalError, type Result, type CommonError } from '@teacher-platform/contracts';
import type { Prisma, PrismaClient } from '@prisma/client';
import { decryptApiKey, encryptApiKey, maskApiKey } from '../../shared/llm-provider-compat/api-key-crypto.js';
import { providerError, type ProviderError } from '../../shared/llm-provider-compat/types.js';
import { assertEndpointAllowed, assertEndpointStaticallyAllowed, parseAllowedCidrs, type AllowedCidr, type DnsLookup } from '../../shared/ssrf/endpoint-guard.js';
import { createLogger } from '../../shared/logger/index.js';

const logger = createLogger();

/** 解析 PROVIDER_BASEURL_ALLOWED_IPS env（非法条目忽略 + warn；缺省全禁 fail-closed）。 */
function resolveAllowedCidrs(explicit: AllowedCidr[] | undefined): AllowedCidr[] {
  if (explicit) return explicit;
  const parsed = parseAllowedCidrs(process.env.PROVIDER_BASEURL_ALLOWED_IPS);
  for (const entry of parsed.invalid) {
    logger.warn(`PROVIDER_BASEURL_ALLOWED_IPS 非法条目已忽略：${entry}`);
  }
  return parsed.allowed;
}

export interface ProviderConfigCreateInput {
  providerKind: string;
  providerName: string;
  displayName?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface ProviderConfigUpdateInput {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  status?: string;
  isPrimary?: boolean;
}

/** 对外返回 DTO：绝不含 apiKeyEnc / 明文。 */
export interface ProviderConfigDto {
  id: string;
  providerKind: string;
  providerName: string;
  displayName: string | null;
  baseUrl: string;
  apiKeyMasked: string;
  model: string;
  isPrimary: boolean;
  status: string;
  createdAtTs: string;
  updatedAtTs: string;
}

export interface ProviderConfigService {
  capabilities(): ProviderConfigCapabilities;
  list(teacherId: string): Promise<Result<ProviderConfigDto[], CommonError>>;
  create(teacherId: string, input: ProviderConfigCreateInput): Promise<Result<ProviderConfigDto, CommonError>>;
  update(teacherId: string, id: string, input: ProviderConfigUpdateInput): Promise<Result<ProviderConfigDto, CommonError>>;
  remove(teacherId: string, id: string): Promise<Result<{ removed: boolean }, CommonError>>;
  testConnection(teacherId: string, id: string): Promise<Result<{ ok: boolean; providerName?: string; model?: string; providerError?: ProviderError }, CommonError>>;
}

export interface ProviderConfigCapabilities {
  configurationEnabled: boolean;
  runtimeEnabled: boolean;
  connectionTestEnabled: boolean;
  endpointValidation: 'static' | 'dns-guarded';
}

export interface CreateProviderConfigServiceOptions {
  prisma: PrismaClient;
  /** 连通性测试：仅显式注入时才调用真实 provider；缺省始终不发网络请求。 */
  chatProbe?: (config: {
    providerKind: string;
    baseUrl: string;
    apiKey: string;
    model: string;
  }) => Promise<{ ok: true } | { ok: false; providerError: ProviderError }>;
  /** SSRF 守卫：白名单 CIDR（缺省从 PROVIDER_BASEURL_ALLOWED_IPS env 解析；空=全禁 fail-closed）。 */
  allowedCidrs?: AllowedCidr[];
  /** SSRF 守卫：DNS 解析注入（测试用；缺省 node dns all:true）。 */
  dnsLookup?: DnsLookup;
  /** 本机安全模式只做静态 SSRF 校验，不进行 DNS。 */
  endpointValidation?: 'static' | 'dns-guarded';
  /** 运行开关只影响 capabilities/探测，配置 CRUD 始终受 owner 隔离保护。 */
  runtimeEnabled?: boolean;
}

function toDto(row: {
  id: string;
  providerKind: string;
  providerName: string;
  displayName: string | null;
  baseUrl: string;
  apiKeyEnc: string;
  model: string;
  isPrimary: boolean;
  status: string;
  createdAtTs: Date;
  updatedAtTs: Date;
}): ProviderConfigDto {
  const plain = decryptApiKey(row.apiKeyEnc);
  return {
    id: row.id,
    providerKind: row.providerKind,
    providerName: row.providerName,
    displayName: row.displayName,
    baseUrl: row.baseUrl,
    apiKeyMasked: maskApiKey(plain),
    model: row.model,
    isPrimary: row.isPrimary,
    status: row.status,
    createdAtTs: row.createdAtTs.toISOString(),
    updatedAtTs: row.updatedAtTs.toISOString(),
  };
}

export function createProviderConfigService(options: CreateProviderConfigServiceOptions): ProviderConfigService {
  const { prisma } = options;
  const allowedCidrs = resolveAllowedCidrs(options.allowedCidrs);
  const dnsLookup = options.dnsLookup;
  const endpointValidation = options.endpointValidation ?? 'dns-guarded';
  const runtimeEnabled = options.runtimeEnabled ?? true;
  const capabilities: ProviderConfigCapabilities = {
    configurationEnabled: true,
    runtimeEnabled,
    connectionTestEnabled: runtimeEnabled && Boolean(options.chatProbe),
    endpointValidation,
  };

  /**
   * ProviderConfig 没有「每教师唯一 primary」的可迁移数据库约束；同一教师的
   * primary 决策必须全部通过同一事务 advisory lock 串行化。锁随事务提交/回滚释放。
   */
  async function withTeacherConfigLock<T>(teacherId: string, operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`provider-config:${teacherId}`}))`;
      return operation(tx);
    });
  }

  async function assertOwner(client: Prisma.TransactionClient | PrismaClient, teacherId: string, id: string) {
    return client.providerConfig.findFirst({ where: { id, teacherId } });
  }

  /** L1 静态校验（契约 §3）：失败返回校验错误，成功返回规范化 URL 落库值。 */
  async function validateBaseUrl(baseUrl: string): Promise<Result<string, CommonError>> {
    const guard = endpointValidation === 'static'
      ? assertEndpointStaticallyAllowed(baseUrl, allowedCidrs)
      : await assertEndpointAllowed(baseUrl, allowedCidrs, { dnsLookup });
    if (!guard.ok) {
      return err(validationError(`baseUrl 不合法：${guard.reason}`, 'baseUrl'));
    }
    return ok(guard.normalizedUrl);
  }

  return {
    capabilities() {
      return capabilities;
    },

    async list(teacherId) {
      const rows = await prisma.providerConfig.findMany({
        where: { teacherId },
        orderBy: [{ isPrimary: 'desc' }, { createdAtTs: 'asc' }],
      });
      return ok(rows.map(toDto));
    },

    async create(teacherId, input) {
      if (!input.providerKind || !input.providerName || !input.baseUrl || !input.apiKey || !input.model?.trim()) {
        return err(validationError('providerKind/providerName/baseUrl/apiKey/model 必填', 'body'));
      }
      if (!['openai', 'anthropic'].includes(input.providerKind)) {
        return err(validationError('providerKind 必须是 openai | anthropic', 'providerKind'));
      }
      const baseUrlGuard = await validateBaseUrl(input.baseUrl);
      if (!baseUrlGuard.ok) return baseUrlGuard;
      try {
        return await withTeacherConfigLock(teacherId, async (tx) => {
          const existing = await tx.providerConfig.count({ where: { teacherId } });
          const row = await tx.providerConfig.create({
            data: {
              teacherId,
              providerKind: input.providerKind,
              providerName: input.providerName,
              displayName: input.displayName ?? null,
              baseUrl: baseUrlGuard.value,
              apiKeyEnc: encryptApiKey(input.apiKey),
              model: input.model.trim(),
              isPrimary: existing === 0, // first creates only after the teacher lock
              status: 'active',
            },
          });
          return ok(toDto(row));
        });
      } catch (error) {
        return err(internalError(`创建 provider 配置失败：${error instanceof Error ? error.message : String(error)}`));
      }
    },

    async update(teacherId, id, input) {
      const data: Record<string, unknown> = {};
      if (input.displayName !== undefined) data.displayName = input.displayName;
      if (input.baseUrl !== undefined) {
        const baseUrlGuard = await validateBaseUrl(input.baseUrl);
        if (!baseUrlGuard.ok) return baseUrlGuard;
        data.baseUrl = baseUrlGuard.value;
      }
      if (input.model !== undefined) {
        const model = input.model.trim();
        if (!model) return err(validationError('model 不能为空', 'model'));
        data.model = model;
      }
      if (input.status !== undefined) {
        if (!['active', 'disabled'].includes(input.status)) {
          return err(validationError('status 必须是 active | disabled', 'status'));
        }
        data.status = input.status;
      }
      if (input.apiKey !== undefined) {
        if (!input.apiKey) return err(validationError('apiKey 不能为空', 'apiKey'));
        data.apiKeyEnc = encryptApiKey(input.apiKey);
      }
      try {
        return await withTeacherConfigLock(teacherId, async (tx) => {
          const row = await assertOwner(tx, teacherId, id);
          if (!row) return err(notFound('provider 配置不存在'));

          const resultingStatus = input.status ?? row.status;
          if ((input.isPrimary === true && resultingStatus === 'disabled') || (row.isPrimary && input.status === 'disabled')) {
            return err(validationError('disabled 配置不能设为默认模型', 'isPrimary'));
          }
          if (input.isPrimary === true) {
            // Clear then promote in this same teacher-serialized transaction.
            await tx.providerConfig.updateMany({ where: { teacherId, id: { not: id } }, data: { isPrimary: false } });
            const promoted = await tx.providerConfig.updateMany({ where: { id, teacherId }, data: { ...data, isPrimary: true } });
            if (promoted.count === 0) return err(notFound('provider 配置不存在'));
          } else {
            const updated = await tx.providerConfig.updateMany({ where: { id, teacherId }, data });
            if (updated.count === 0) return err(notFound('provider 配置不存在'));
          }
          const fresh = await assertOwner(tx, teacherId, id);
          return ok(toDto(fresh!));
        });
      } catch (error) {
        return err(internalError(`更新 provider 配置失败：${error instanceof Error ? error.message : String(error)}`));
      }
    },

    async remove(teacherId, id) {
      try {
        return await withTeacherConfigLock(teacherId, async (tx) => {
          const row = await assertOwner(tx, teacherId, id);
          if (!row) return err(notFound('provider 配置不存在'));

          const wasPrimary = row.isPrimary;
          // 删除带 teacherId 纵深（契约 §5）：ID 已知也无法删他人配置
          const deleted = await tx.providerConfig.deleteMany({ where: { id, teacherId } });
          if (deleted.count === 0) return err(notFound('provider 配置不存在'));

          if (wasPrimary) {
            // 删除 primary：提升最新一条为 primary；无剩余则保持无配置（路由回退默认）
            const next = await tx.providerConfig.findFirst({
              where: { teacherId },
              orderBy: { createdAtTs: 'desc' },
            });
            if (next) {
              await tx.providerConfig.update({ where: { id: next.id }, data: { isPrimary: true } });
            }
          }
          return ok({ removed: true });
        });
      } catch (error) {
        return err(internalError(`删除 provider 配置失败：${error instanceof Error ? error.message : String(error)}`));
      }
    },

    async testConnection(teacherId, id) {
      const row = await assertOwner(prisma, teacherId, id);
      if (!row) return err(notFound('provider 配置不存在'));

      if (!capabilities.connectionTestEnabled || !options.chatProbe) {
        return ok({
          ok: false,
          providerName: row.providerName,
          model: row.model,
          providerError: providerError(
            'unknown',
            0,
            runtimeEnabled
              ? '连接检测未运行：未配置探测器，未发起网络请求'
              : '连接检测未运行：本机安全模式已禁用真实调用，未发起网络请求',
          ),
        });
      }

      const plainKey = decryptApiKey(row.apiKeyEnc);
      const probe = await options.chatProbe({
        providerKind: row.providerKind,
        baseUrl: row.baseUrl,
        apiKey: plainKey,
        model: row.model,
      });
      if (probe.ok) {
        return ok({ ok: true, providerName: row.providerName, model: row.model });
      }
      return ok({ ok: false, providerError: probe.providerError });
    },
  };
}
