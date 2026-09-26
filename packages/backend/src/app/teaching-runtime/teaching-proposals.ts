import { createHash } from 'node:crypto';
import { createDatabaseTrustedClock } from '../../shared/trusted-clock/index.js';
import type { PrismaClient } from '@prisma/client';
import { err, ok, notFound } from '@teacher-platform/contracts';
import { createPendingActionService, type ActionTokenSigner } from '../../features/pending-action/index.js';
import type { ToolRegistry } from '../../shared/tool-registry/types.js';
import type { FieldCipher } from '../../shared/field-encryption/index.js';
import { parseCreateCandidate, type CreateAction } from '../confirmation/teaching-create-actions.js';

interface Options {
  getClient: () => Promise<PrismaClient>; teacherId: string; conversationId: string;
  signer: ActionTokenSigner; cipher: FieldCipher;
}

/** These tools create only a pending proposal. The runtime never gets a token
 * or a confirm executor. Only an authenticated teacher's HTTP confirmation can
 * turn the immutable candidate into a business write. */
export function registerTeachingProposals(registry: ToolRegistry, options: Options): void {
  const { teacherId, conversationId } = options;
  for (const action of ['scheduling.create', 'memos.create'] as const) {
    const schedule = action === 'scheduling.create';
    registry.register({ name: schedule ? 'scheduling.prepare' : 'memos.prepare', sideEffect: 'create',
      description: schedule ? '准备单次或每周重复课程的一张确认卡，不保存课程、不扣课。按已知名单和时间直接准备；地点可待补，形式按人数推定，每周未指定起始日期时按北京时间建议最近未开始的一次；教师确认后保存' : '准备备忘确认卡，不直接保存待办；教师点击确认后才写入',
      parameters: { type: 'object', additionalProperties: false,
        properties: schedule ? {
          day: { type: 'string', description: '北京时间 YYYY-MM-DD；单次必填，每周可省略由可信时钟计算最近一次' }, start: { type: 'string', description: 'HH:mm' }, end: { type: 'string', description: 'HH:mm' },
          location: { type: 'string', description: '未提供可省略，显示待补充，不阻塞排课' }, participants: { type: 'array', items: { type: 'string' } }, format: { type: 'string', enum: ['一对一', '小班'], description: '可省略，一人默认一对一，多人默认小班' },
          recurrence: { type: 'string', enum: ['once', 'weekly'] },
          weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, description: '每周的星期，周一1至周日7；未传时从明确day推定' },
          endDate: { type: 'string', description: '每周重复的可选结束日期 YYYY-MM-DD；未提供不要追问或编造' }, note: { type: 'string' },
        } : { title: { type: 'string' }, content: { type: 'string' }, dueAt: { type: 'string', description: '带时区的明确时间，未明确时不要编造' } },
        required: schedule ? ['start', 'end', 'participants', 'recurrence'] : ['title', 'content'],
      },
    }, async (args, context) => {
      if (context.teacherId !== teacherId) return err(notFound('会话不存在'));
      return prepare(action, args);
    });
  }
  async function prepare(action: CreateAction, args: unknown) {
    const db = await options.getClient();
    const now = await createDatabaseTrustedClock(db).now(); if (!now.ok) return now;
    const parsed = parseCreateCandidate(action, args, now.value); if (!parsed.ok) return parsed;
    const { kind, ...candidate } = parsed.value;
    const students = kind === 'schedule' ? await db.student.findMany({
      where: { teacherId, id: { in: (parsed.value as { participants: string[] }).participants } },
      orderBy: { id: 'asc' }, select: { id: true, name: true, updatedAtTs: true },
    }) : [];
    if (parsed.value.kind === 'schedule' && students.length !== parsed.value.participants.length) return err(notFound('参与学生不存在'));
    const parameters = { candidate, studentVersions: Object.fromEntries(students.map(student => [student.id, student.updatedAtTs.toISOString()])) };
    const candidateKey = `proposal:${createHash('sha256').update(JSON.stringify([teacherId, conversationId, action, parameters])).digest('hex')}`;
    // Reuse a live candidate or a committed receipt, but permit a fresh proposal
    // after cancellation/expiry. Student-version changes produce a new key.
    const previous = await db.pendingAction.findMany({ where: { teacherId, conversationId,
      toolCallId: { startsWith: candidateKey } }, orderBy: { createdAtTs: 'desc' } });
    const reusable = previous.find(row => row.status === 'consumed'
      || row.status === 'executing' || (row.status === 'pending' && row.expiresAtTs > now.value));
    const toolCallId = reusable?.toolCallId ?? `${candidateKey}:${previous.length}`;
    const value = parsed.value;
    const summary = value.kind === 'schedule'
      ? `${value.day}${value.recurrence === 'weekly' ? ` 起，${value.weekdays.map(day => `每周${'一二三四五六日'[day - 1]}`).join('、')}` : ''} ${value.start}–${value.end}（北京时间），${students.map(student => student.name).join('、')}，${value.format}，地点：${value.location}；${value.recurrence === 'weekly' ? value.endDate ? `至 ${value.endDate}` : '未设置结束日期' : '仅本次'}，保存不扣课${value.note ? `；备注：${value.note}` : ''}`
      : `${value.title}：${value.content}${value.dueAt ? `；时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value.dueAt))}（北京时间）` : '；未设置提醒时间'}`;
    const pending = createPendingActionService({ prisma: db, cipher: options.cipher, actionTokenSigner: options.signer,
      conversationOwner: { async getOwnedConversation(input) {
        const row = await db.conversation.findFirst({ where: { id: input.conversationId, teacherId: input.teacherId, status: 'active' } });
        return row ? ok({ id: row.id, status: row.status }) : err(notFound('会话不存在'));
      } },
    });
    const result = await pending.createPendingAction({ teacherId, conversationId, toolCallId, actionName: action,
      target: { type: kind === 'schedule' ? 'Schedule' : 'Memo', id: toolCallId }, parameters,
      beforeSummary: null, afterSummary: summary });
    if (!result.ok) return result;
    return ok({ pendingActionId: result.value.pendingAction.id, toolCallId, summary,
      status: result.value.pendingAction.status === 'consumed' ? 'already_saved'
        : result.value.pendingAction.status === 'pending' ? 'pending_confirmation' : result.value.pendingAction.status,
      saved: result.value.pendingAction.status === 'consumed' });
  }
}
