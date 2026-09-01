/**
 * 媒体路由（P8 S3 多媒体证据链阶段一 · t8 + P9 阶段二 · t3/t6 + P11 A2，设计 p7-media-evidence-design.md §4 上传契约）。
 *
 * POST /api/v1/media                          multipart 上传（requireAuth + owner 隔离；类型/大小/幂等校验在服务层）
 * GET  /api/v1/media/:assetId/file            受控下载（owner + S1 校验；Content-Type 取自元数据表）
 * POST /api/v1/media/:assetId/transcription   提交异步转写作业（t6：仅 audio 且 none/failed 可提交 → pending）
 * GET  /api/v1/media/:assetId/transcription   轮询转写状态（t6：DB 状态权威 + 内存作业瞬态进度）
 * POST /api/v1/media/:assetId/ocr             提交异步 OCR 作业（P11 A2：仅 image/screenshot 且 none/failed 可提交 → pending）
 * GET  /api/v1/media/:assetId/ocr             轮询 OCR 状态（P11 A2：DB 状态权威 + 内存作业瞬态进度）
 * POST /api/v1/media/:assetId/scan            提交异步扫描作业（P12 A3/C：skipped/clean/error 可提交 → pending）
 * GET  /api/v1/media/:assetId/scan            轮询扫描状态（P12 A3/C：DB 状态权威 + 内存作业瞬态进度；
 *                                               infected 隔离资产仍可查元数据——管理端可查看，文件本体被拒）
 *
 * multipart 解析用 formidable（直接依赖，流式 + maxFileSize 超限中断）；解析产出的临时文件
 * 在读取后立即清理。路由只做解析与 HTTP 映射，业务校验/落盘全在服务层。
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { readFile, rm } from 'node:fs/promises';
import { formidable } from 'formidable';
import { ok, err, validationError, type CommonError, type Result } from '@teacher-platform/contracts';
import type { AuthService } from '../../features/auth/index.js';
import { createRequireAuth, type AuthenticatedRequest } from '../middleware/require-auth.js';
import { PHASE2_MAX_AUDIO_BYTES } from '../../features/media/index.js';
import type { MediaAssetService } from '../../features/media/index.js';

function statusFromError(error: CommonError): number {
  if (error.code === 'VALIDATION_ERROR') return 400;
  if (error.code === 'PERMISSION_DENIED') return 401;
  if (error.code === 'NOT_FOUND') return 404;
  return 500;
}

function sendError(res: Response, error: CommonError): void {
  res.status(statusFromError(error)).json({ ok: false, error });
}

function readStringField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function parseOptionalOccurredAt(value: string | undefined): Result<Date | undefined, CommonError> {
  if (value === undefined || value.trim() === '') return ok(undefined);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return err(validationError('occurredAt 必须是带时区的 RFC3339 时间', 'occurredAt'));
  }
  return ok(new Date(parsed));
}

interface ParsedUpload {
  mediaType: string;
  originalFilename: string;
  mimeType: string;
  content: Buffer;
  studentId?: string;
  occurredAt?: Date;
}

/** formidable 流式解析 + 大小超限中断；读取临时文件后立即清理。
 *  粗上限 = 阶段二 audio 30MB（类型精确上限由服务层校验：image 10MB / audio 30MB）。 */
async function parseMultipartUpload(req: Request): Promise<Result<ParsedUpload, CommonError>> {
  const form = formidable({
    maxFileSize: PHASE2_MAX_AUDIO_BYTES,
    maxTotalFileSize: PHASE2_MAX_AUDIO_BYTES,
    maxFields: 20,
    multiples: false,
    allowEmptyFiles: false,
  });

  return new Promise((resolvePromise) => {
    form.parse(req, (error, fields, files) => {
      if (error) {
        const message = error.message ?? String(error);
        const isSizeError = /maxFileSize|maxTotalFileSize|aborted/i.test(message);
        resolvePromise(err(validationError(
          isSizeError ? `文件超过大小上限 ${PHASE2_MAX_AUDIO_BYTES / 1024 / 1024}MB` : `multipart 解析失败：${message}`,
          'file',
        )));
        return;
      }
      const fileEntry = files.file;
      const file = Array.isArray(fileEntry) ? fileEntry[0] : fileEntry;
      if (!file) {
        resolvePromise(err(validationError('缺少 file 字段', 'file')));
        return;
      }

      const mediaType = readStringField(fields as unknown as Record<string, unknown>, 'mediaType') ?? '';
      const studentId = readStringField(fields as unknown as Record<string, unknown>, 'studentId');
      const occurredAtRaw = readStringField(fields as unknown as Record<string, unknown>, 'occurredAt');
      const occurredAt = parseOptionalOccurredAt(occurredAtRaw);
      if (!occurredAt.ok) {
        resolvePromise(occurredAt);
        return;
      }

      readFile(file.filepath)
        .then((content) => {
          rm(file.filepath, { force: true }).catch(() => {});
          resolvePromise(ok({
            mediaType,
            originalFilename: file.originalFilename ?? '',
            mimeType: file.mimetype ?? '',
            content,
            studentId,
            occurredAt: occurredAt.value,
          }));
        })
        .catch(() => {
          rm(file.filepath, { force: true }).catch(() => {});
          resolvePromise(err(validationError('读取上传文件失败', 'file')));
        });
    });
  });
}

export function createMediaRouter(
  service: MediaAssetService,
  authService: AuthService,
): Router {
  const router = Router();
  const requireAuth = createRequireAuth(authService);

  // POST /api/v1/media — multipart 上传（类型白名单/大小/幂等去重/S1 标记/owner 隔离）
  router.post('/media', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const parsed = await parseMultipartUpload(req);
    if (!parsed.ok) {
      sendError(res, parsed.error);
      return;
    }
    const result = await service.upload({
      teacherId: req.teacherId,
      mediaType: parsed.value.mediaType,
      originalFilename: parsed.value.originalFilename,
      mimeType: parsed.value.mimeType,
      content: parsed.value.content,
      studentId: parsed.value.studentId,
      occurredAt: parsed.value.occurredAt,
    });
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(201).json({ ok: true, data: result.value });
  });

  // GET /api/v1/media/:assetId — 元数据（owner 隔离；originalPath 为相对路径，禁绝对路径泄漏）
  router.get('/media/:assetId', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.getOwned(req.teacherId, String(req.params.assetId));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // GET /api/v1/media/:assetId/file — 受控下载（owner + S1 校验）
  router.get('/media/:assetId/file', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.readFile(req.teacherId, String(req.params.assetId));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    const { row, content } = result.value;
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(`media-${row.id}`)}`);
    res.setHeader('Content-Length', String(content.length));
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(content);
  });

  // POST /api/v1/media/:assetId/transcription — 提交异步转写作业（t6）
  // 校验：owner 隔离 + 仅 audio + transcriptionStatus ∈ {none, failed} → pending + 内存作业；202 返回 jobId
  router.post('/media/:assetId/transcription', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.submitTranscription(req.teacherId, String(req.params.assetId));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(202).json({ ok: true, data: result.value });
  });

  // GET /api/v1/media/:assetId/transcription — 轮询转写状态（t6；DB 状态权威 + 内存作业瞬态进度）
  router.get('/media/:assetId/transcription', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.getTranscription(req.teacherId, String(req.params.assetId));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // POST /api/v1/media/:assetId/ocr — 提交异步 OCR 作业（P11 A2）
  // 校验：owner 隔离 + 仅 image/screenshot + ocrStatus ∈ {none, failed} → pending + 内存作业；202 返回 jobId
  router.post('/media/:assetId/ocr', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.submitOcr(req.teacherId, String(req.params.assetId));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(202).json({ ok: true, data: result.value });
  });

  // GET /api/v1/media/:assetId/ocr — 轮询 OCR 状态（P11 A2；DB 状态权威 + 内存作业瞬态进度）
  router.get('/media/:assetId/ocr', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.getOcr(req.teacherId, String(req.params.assetId));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  // POST /api/v1/media/:assetId/scan — 提交异步扫描作业（P12 A3/C）
  // 校验：owner 隔离 + scanStatus ∈ {skipped, clean, error} → pending + 内存作业；202 返回 jobId
  router.post('/media/:assetId/scan', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.submitScan(req.teacherId, String(req.params.assetId));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(202).json({ ok: true, data: result.value });
  });

  // GET /api/v1/media/:assetId/scan — 轮询扫描状态（P12 A3/C；DB 状态权威 + 内存作业瞬态进度；
  // infected 隔离资产元数据仍可查——管理端可查看，文件本体经 readFile 拒绝）
  router.get('/media/:assetId/scan', requireAuth, async (req: AuthenticatedRequest, res) => {
    if (!req.teacherId) {
      sendError(res, validationError('缺少身份信息', 'teacherId'));
      return;
    }
    const result = await service.getScan(req.teacherId, String(req.params.assetId));
    if (!result.ok) {
      sendError(res, result.error);
      return;
    }
    res.status(200).json({ ok: true, data: result.value });
  });

  return router;
}
