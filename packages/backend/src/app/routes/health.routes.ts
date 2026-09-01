import { Router, Request, Response } from 'express';
import { Prisma, type PrismaClient } from '@prisma/client';
import { internalError, type SuccessResponse } from '@teacher-platform/contracts';
import type { DatabaseClientPool } from '../../shared/database-pool/index.js';
import type { Logger } from '../../shared/logger/index.js';

/** readiness 只需要 $queryRaw（SELECT 1），收窄依赖面便于单测 mock。 */
type HealthPrismaClient = Pick<PrismaClient, '$queryRaw'>;

/** 健康路由工厂选项（T8b 设计 §3）。 */
export interface HealthRouterOptions {
  /** 共享库 client（TeacherRegistry/SessionStore）：/health/ready 必查 SELECT 1 */
  registryPrisma?: HealthPrismaClient;
  /** 教师库连接池（可选）：/health/ready 验证池状态（size()）；缺省跳过 */
  pool?: DatabaseClientPool;
  /** 结构化日志（可选）：记录连接池状态验证结果 */
  logger?: Logger;
}

/** 健康检查处理函数（导出用于测试）。保持现状不动：等价 liveness。 */
export function healthHandler(_req: Request, res: Response): void {
  const response: SuccessResponse<{ status: string; timestamp: string }> = {
    ok: true,
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
    },
  };
  res.json(response);
}

/** readiness 成功响应（200，status='ready'；与 /health 同构，探针只看状态码）。 */
function readinessResponse(res: Response): void {
  const response: SuccessResponse<{ status: string; timestamp: string }> = {
    ok: true,
    data: {
      status: 'ready',
      timestamp: new Date().toISOString(),
    },
  };
  res.json(response);
}

/**
 * 健康检查路由工厂（T8b 设计 §3）：
 * - GET /health      —— 纯进程存活（保持现状，现有测试零改动）
 * - GET /health/live —— liveness：进程存活（同 /health 语义）
 * - GET /health/ready—— readiness：共享库 SELECT 1（必查）+ 连接池状态验证（可选）
 *   - 共享库不可达 → 503 + JSON 错误体（服务实际不可用）
 *   - 连接池仅验证状态（size()），不逐库查 500 个教师库（个别库故障是租户问题）
 *   - registryPrisma/pool 均未注入 → 503（无法判定就绪，探针安全侧）
 */
export function createHealthRouter(options: HealthRouterOptions = {}): Router {
  const router = Router();

  router.get('/health', healthHandler);
  router.get('/health/live', healthHandler);

  router.get('/health/ready', async (_req, res) => {
    if (options.registryPrisma) {
      try {
        await options.registryPrisma.$queryRaw(Prisma.sql`SELECT 1`);
      } catch {
        res.status(503).json({
          ok: false,
          error: internalError('共享数据库不可达：readiness 检查失败'),
        });
        return;
      }
    } else {
      res.status(503).json({
        ok: false,
        error: internalError('readiness 检查未配置依赖（registryPrisma）'),
      });
      return;
    }

    if (options.pool) {
      // G2 范围：仅验证连接池状态（现有接口 size()），不逐库查 500 个教师库。
      // 热库抽查（最近活跃库 SELECT 1）待 S3 装配时扩展池接口 healthProbe 再启用
      // （T8b 设计 §3.2 实现提示；池接口扩展属连接池模块，避免并发冲突）。
      const hotDbCount = options.pool.size();
      options.logger?.info('readiness pool state', {
        path: '/api/v1/health/ready',
        hotDbCount,
      });
    }

    readinessResponse(res);
  });

  return router;
}

// 向后兼容默认导出：无依赖实例（/health、/health/live 可用；/health/ready 因缺依赖返回 503）
export default createHealthRouter();
