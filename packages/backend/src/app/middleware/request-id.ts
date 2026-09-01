import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../../shared/logger/index.js';

/**
 * 请求上下文中间件（P7 G1，T8b 设计 §5.1）。
 *
 * createRequestIdMiddleware：
 * - 读取入站 x-request-id 头；合法（安全字符白名单）则复用（分布式链路透传），
 *   否则生成 `req_<hex>`；响应头 x-request-id 回传（P1 追踪基础）；
 * - 通过 RequestIdRequest.requestId 类型扩展传递（禁止 any，与 requireAuth 同风格）。
 *
 * createRequestLogMiddleware：
 * - 挂在 requestId 中间件之后；请求完成（res 'finish'）时写一行
 *   `request completed` JSON 日志（method/path/status/durationMs/requestId/teacherId）。
 */

export interface RequestIdRequest extends Request {
  requestId?: string;
}

/** x-request-id 安全字符白名单（防响应头注入/超长）。 */
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function generateRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

export function createRequestIdMiddleware() {
  return function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    const requestId = incoming && SAFE_REQUEST_ID_PATTERN.test(incoming) ? incoming : generateRequestId();
    (req as RequestIdRequest).requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  };
}

export function createRequestLogMiddleware(logger: Logger) {
  return function requestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const teacherId = (req as Request & { teacherId?: string }).teacherId;
      logger.info('request completed', {
        requestId: (req as RequestIdRequest).requestId,
        teacherId,
        method: req.method,
        path: req.originalUrl ?? req.url,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
      });
    });
    next();
  };
}
