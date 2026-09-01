/**
 * ProviderConfig 服务（P7 渠道线 · t63，t57 设计 §2）。
 *
 * owner 隔离：所有查询 WHERE teacherId = 调用者（requireAuth 后由路由传入）；
 * apiKey 只写不回：写入时 AES-256-GCM 加密落 apiKeyEnc，任何返回只含 apiKeyMasked；
 * primary 唯一化：设为 primary 时先清同教师其他 primary；删 primary 提升其一，无剩余回退默认。
 */

import { err, ok, validationError, notFound, internalError, type Result, type CommonError } from '@teacher-platform/contracts';
import type { PrismaClient } from '@prisma/client';
import { decryptApiKey, encryptApiKey, maskApiKey } from '../../shared/llm-provider-compat/api-key-crypto.js';
import type { ProviderError } from '../../shared/llm-provider-compat/types.js';
import { assertEndpointAllowed, parseAllowedCidrs, type AllowedCidr, type DnsLookup } from '../../shared/ssrf/endpoint-guard.js';
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
  list(teacherId: string): Promise<Result<ProviderConfigDto[], CommonError>>;
  create(teacherId: string, input: ProviderConfigCreateInput): Promise<Result<ProviderConfigDto, CommonError>>;
  update(teacherId: string, id: string, input: ProviderConfigUpdateInput): Promise<Result<ProviderConfigDto, CommonError>>;
  remove(teacherId: string, id: string): Promise<Result<{ removed: boolean }, CommonError>>;
  testConnection(teacherId: string, id: string): Promise<Result<{ ok: boolean; providerName?: string; model?: string; providerError?: ProviderError }, CommonError>>;
}

export interface CreateProviderConfigServiceOptions {
  prisma: PrismaClient;
  /** 连通性测试：调用真实 provider 最小 chat（缺省不做网络调用，返回配置有效）。 */
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

  async function assertOwner(teacherId: string, id: string) {
    const row = await prisma.providerConfig.findFirst({ where: { id, teacherId } });
    return row;
  }

  /** L1 静态校验（契约 §3）：失败返回校验错误，成功返回规范化 URL 落库值。 */
  async function validateBaseUrl(baseUrl: string): Promise<Result<string, CommonError>> {
    const guard = await assertEndpointAllowed(baseUrl, allowedCidrs, { dnsLookup });
    if (!guard.ok) {
      return err(validationError(`baseUrl 不合法：${guard.reason}`, 'baseUrl'));
    }
    return ok(guard.normalizedUrl);
  }

  return {
    async list(teacherId) {
      const rows = await prisma.providerConfig.findMany({
        where: { teacherId },
        orderBy: [{ isPrimary: 'desc' }, { createdAtTs: 'asc' }],
      });
      return ok(rows.map(toDto));
    },

    async create(teacherId, input) {
      if (!input.providerKind || !input.providerName || !input.baseUrl || !input.apiKey || !input.model) {
        return err(validationError('providerKind/providerName/baseUrl/apiKey/model 必填', 'body'));
      }
      if (!['openai', 'anthropic'].includes(input.providerKind)) {
        return err(validationError('providerKind 必须是 openai | anthropic', 'providerKind'));
      }
      const baseUrlGuard = await validateBaseUrl(input.baseUrl);
      if (!baseUrlGuard.ok) return baseUrlGuard;
      try {
        const existing = await prisma.providerConfig.count({ where: { teacherId } });
        const row = await prisma.providerConfig.create({
          data: {
            teacherId,
            providerKind: input.providerKind,
            providerName: input.providerName,
            displayName: input.displayName ?? null,
            baseUrl: baseUrlGuard.value,
            apiKeyEnc: encryptApiKey(input.apiKey),
            model: input.model,
            isPrimary: existing === 0, // 首条自动 isPrimary
            status: 'active',
          },
        });
        return ok(toDto(row));
      } catch (error) {
        return err(internalError(`创建 provider 配置失败：${error instanceof Error ? error.message : String(error)}`));
      }
    },

    async update(teacherId, id, input) {
      const row = await assertOwner(teacherId, id);
      if (!row) return err(notFound('provider 配置不存在'));

      const data: Record<string, unknown> = {};
      if (input.displayName !== undefined) data.displayName = input.displayName;
      if (input.baseUrl !== undefined) {
        const baseUrlGuard = await validateBaseUrl(input.baseUrl);
        if (!baseUrlGuard.ok) return baseUrlGuard;
        data.baseUrl = baseUrlGuard.value;
      }
      if (input.model !== undefined) data.model = input.model;
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
      if (input.isPrimary !== undefined && input.isPrimary === true) {
        // 主 LLM 唯一化：先清同教师其他 primary（事务内）；写入带 teacherId 纵深（契约 §5）
        const [, promoted] = await prisma.$transaction([
          prisma.providerConfig.updateMany({ where: { teacherId, id: { not: id } }, data: { isPrimary: false } }),
          prisma.providerConfig.updateMany({ where: { id, teacherId }, data: { isPrimary: true } }),
        ]);
        if (promoted.count === 0) return err(notFound('provider 配置不存在'));
        const updated = await assertOwner(teacherId, id);
        return ok(toDto(updated!));
      }

      const updated = await prisma.providerConfig.updateMany({ where: { id, teacherId }, data });
      if (updated.count === 0) return err(notFound('provider 配置不存在'));
      const fresh = await assertOwner(teacherId, id);
      return ok(toDto(fresh!));
    },

    async remove(teacherId, id) {
      const row = await assertOwner(teacherId, id);
      if (!row) return err(notFound('provider 配置不存在'));

      const wasPrimary = row.isPrimary;
      // 删除带 teacherId 纵深（契约 §5）：ID 已知也无法删他人配置
      const deleted = await prisma.providerConfig.deleteMany({ where: { id, teacherId } });
      if (deleted.count === 0) return err(notFound('provider 配置不存在'));

      if (wasPrimary) {
        // 删除 primary：提升最新一条为 primary；无剩余则保持无配置（路由回退默认）
        const next = await prisma.providerConfig.findFirst({
          where: { teacherId },
          orderBy: { createdAtTs: 'desc' },
        });
        if (next) {
          await prisma.providerConfig.update({ where: { id: next.id }, data: { isPrimary: true } });
        }
      }
      return ok({ removed: true });
    },

    async testConnection(teacherId, id) {
      const row = await assertOwner(teacherId, id);
      if (!row) return err(notFound('provider 配置不存在'));

      if (!options.chatProbe) {
        // 未注入探针：静态校验（配置存在且可解密即视为 ok）
        try {
          decryptApiKey(row.apiKeyEnc);
        } catch (error) {
          return err(internalError(`apiKey 解密失败：${error instanceof Error ? error.message : String(error)}`));
        }
        return ok({ ok: true, providerName: row.providerName, model: row.model });
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
