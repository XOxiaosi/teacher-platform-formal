import { err, internalError, notFound, ok, validationError } from '@teacher-platform/contracts';
import type { ChatMessage } from '../../../shared/ai-client/types.js';
import type { FeedbackEvidenceItem } from '../assemble-parent-feedback-context/types.js';
import type {
  CreateGenerateFeedbackDraftUseCaseOptions,
  GenerateFeedbackDraftUseCase,
  GenerateFeedbackDraftInput,
  FeedbackClassSize,
  FeedbackParentType,
  FeedbackFocus,
} from './types.js';

interface StudentRecord {
  id: string;
  name: string;
  grade: string;
  stageGoal: string | null;
}

interface LessonRecord {
  id: string;
  dateTs: Date;
  progress: string | null;
  studentState: string | null;
  homework: string | null;
  teacherNote: string | null;
}

interface HistoryFeedbackItem {
  title: string;
  content: string;
}

export function createGenerateFeedbackDraftUseCase(
  options: CreateGenerateFeedbackDraftUseCaseOptions,
): GenerateFeedbackDraftUseCase {
  const getClient = options.getClient ?? (async () => options.prisma);
  const { aiClient, context } = options;

  return {
    async execute(input: GenerateFeedbackDraftInput) {
      const prisma = await getClient();
      const student = await prisma.student.findUnique({ where: { id: input.studentId } });
      if (!student || student.teacherId !== input.teacherId) {
        return err(notFound('学生不存在'));
      }

      const assembled = await context.execute({
        teacherId: input.teacherId,
        studentId: input.studentId,
      });
      if (!assembled.ok) return assembled;

      let finalEvidence = [...assembled.value.evidence];
      let finalLessons: LessonRecord[];
      let finalLessonIds: string[];

      if (input.lessonIds && input.lessonIds.length > 0) {
        const selected = await findSelectedLessons(prisma, input);
        if (!selected.ok) return selected;
        finalLessons = selected.value;
        finalLessonIds = finalLessons.map((l) => l.id);

        // Replace lesson evidence entries with the selected lessons; keep records/assessments intact
        const nonLessonEvidence = finalEvidence.filter((e) => e.type !== 'lesson');
        const selectedLessonEvidence = finalLessons.map(lessonToEvidence);
        finalEvidence = [...nonLessonEvidence, ...selectedLessonEvidence];
        finalEvidence.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      } else {
        // Use lessons from assembled evidence
        const lessonEvidence = finalEvidence.filter((e) => e.type === 'lesson');
        finalLessonIds = lessonEvidence.map((e) => e.id);
        finalLessons = []; // not needed in full form; build from evidence if needed below

        // Validate: at least some basis (lessons OR records) to generate from
        const hasAnyBasis = finalEvidence.length > 0;
        if (!hasAnyBasis) {
          return err(validationError('没有可用于生成反馈的课程或学生记录', 'lessonIds'));
        }
      }

      // 反雷同：查询该生最近 3 条历史反馈
      const historyFeedback = await fetchRecentHistoryFeedback(prisma, input.teacherId, input.studentId);

      const messages = buildMessages({
        student,
        lessons: finalLessons,
        evidence: finalEvidence,
        tone: input.tone ?? 'warm',
        classSize: input.classSize,
        parentType: input.parentType,
        focus: input.focus,
        historyFeedback,
      });

      const response = await aiClient.chat(messages, []);
      if (!response.ok) {
        return err(internalError(response.error.message));
      }

      const parsed = parseDraft(response.value.content, student.name);

      return ok({
        studentId: student.id,
        lessonIds: finalLessonIds,
        title: parsed.title,
        content: parsed.content,
        rationale: parsed.rationale,
        source: 'ai' as const,
        evidence: finalEvidence,
        windowStart: assembled.value.windowStart,
        windowEnd: assembled.value.windowEnd,
        classSize: input.classSize,
        parentType: input.parentType,
        focus: input.focus,
      });
    },
  };
}

async function fetchRecentHistoryFeedback(
  prisma: CreateGenerateFeedbackDraftUseCaseOptions['prisma'],
  teacherId: string,
  studentId: string,
): Promise<HistoryFeedbackItem[]> {
  const records = await prisma.parentFeedback.findMany({
    where: {
      teacherId,
      studentId,
      status: { in: ['draft', 'reviewed', 'sent'] },
    },
    orderBy: { createdAtTs: 'desc' },
    take: 3,
    select: { title: true, content: true },
  });
  return records.map((r) => ({ title: r.title, content: r.content }));
}

function lessonToEvidence(lesson: LessonRecord): FeedbackEvidenceItem {
  const summary = lesson.progress ?? lesson.studentState ?? lesson.teacherNote ?? lesson.homework ?? null;
  return {
    id: lesson.id,
    type: 'lesson',
    occurredAt: lesson.dateTs.toISOString(),
    category: null,
    summary,
    examName: null,
    subject: null,
    score: null,
    fullScore: null,
    previousScore: null,
  };
}

async function findSelectedLessons(prisma: CreateGenerateFeedbackDraftUseCaseOptions['prisma'], input: GenerateFeedbackDraftInput) {
  const lessonIds = input.lessonIds ?? [];
  const lessons = await prisma.lesson.findMany({
    where: {
      id: { in: lessonIds },
      teacherId: input.teacherId,
      studentId: input.studentId,
    },
    orderBy: { dateTs: 'desc' },
  });

  if (lessons.length !== lessonIds.length) {
    return err(notFound('课程记录不存在'));
  }
  if (lessons.length === 0) {
    return err(validationError('lessonIds 不能为空', 'lessonIds'));
  }

  return ok(lessons.map(toLessonRecord));
}

function toLessonRecord(record: LessonRecord): LessonRecord {
  return {
    id: record.id,
    dateTs: record.dateTs,
    progress: record.progress,
    studentState: record.studentState,
    homework: record.homework,
    teacherNote: record.teacherNote,
  };
}

function formatEvidenceItem(item: FeedbackEvidenceItem): string {
  const typeLabel = item.type === 'assessment' ? '成绩' : item.type === 'record' ? '档案' : '课程';
  const parts: string[] = [];
  parts.push(`[${typeLabel}] ${item.occurredAt}`);
  if (item.category) parts.push(`类别：${item.category}`);
  if (item.summary) parts.push(`摘要：${item.summary}`);
  if (item.examName) parts.push(`考试：${item.examName}`);
  if (item.subject) parts.push(`科目：${item.subject}`);
  if (item.score !== null) {
    const scoreParts: string[] = [`分数：${item.score}`];
    if (item.fullScore !== null) scoreParts.push(`满分：${item.fullScore}`);
    if (item.previousScore !== null) scoreParts.push(`上次：${item.previousScore}`);
    parts.push(scoreParts.join(' / '));
  }
  if (item.parentConcerns?.length) {
    parts.push(`关注点：${item.parentConcerns.join('、')}`);
  }
  if (item.followUps?.length) {
    parts.push(`待办：${item.followUps.join('、')}`);
  }
  return parts.join(' | ');
}

const SYSTEM_PROMPT = `你是嵌入教师平台的「课后反馈助手」。你的唯一目标：帮老师在 1 分钟内，基于老师提供的真实课堂事实，生成一条让家长获得确定感、且绝不千篇一律的课后反馈。你不是替老师代教，是帮老师把已经看到的事实，快速写成家长看得懂、信得过的反馈。

【事实来源铁律】
模型收到的所有事实/数据只能来自下面提供的"学生可信记录"与"课程记录"段。成绩/科目/分数/考试名必须与提供的一致，不得编造改动数字，不得凭空添加学生没有的经历。

【必须内化的方法论】
1. 确定感铁律：家长在看到成绩前，只能靠过程信息判断"钱值不值"。反馈的价值，就是填这段等待期的真空，让家长觉得"这节课没白上"。
2. 万能三要素（每条反馈都要有）：事实（具体情景+细节）+ 判断（孩子的状态/问题本质）+ 下一步动作（老师怎么带 / 家长怎么配合）。
3. 家长三问：发生了什么？→ 这意味着什么？→ 接下来怎么办？依次答上，确定感就成立。

【灵活度约束——重点：绝不能千篇一律】
- 同一学生多次反馈，必须体现"进展或变化"，禁止重复同一句式、同一问题表述。每次只抓 1–2 个点。
- 与近期历史反馈对比，避免同一切入点/句式重复。
- 按场景自动切换骨架：
  · 高光/进步：情境+具体行为+这说明什么（夸要有事实，不空泛）
  · 发现问题：具体事实+我的判断+下一步怎么带（严禁只批评不给方案）
  · 需家长配合：具体问题+老师动作+家长一件轻量小事
  · 阶段小结：亮点变化+仍需练习+下阶段计划（可到 150 字）
- 按班型与对象调整语气与结构：
  · 1对1：深入、亲切、个性化
  · 小班：关注个体+轻量共性
  · 大班：先共性群发引导，再抽样私聊；按问题类型"归类"套模板，不一人一稿
  · 家长类型：对"只认分"的家长直接挂数据（分数/排名/稳不稳），少写主观评价；对"玻璃心"家长先肯定再轻点，或主动建议降低沟通密度
- 长度：日常反馈 60–100 字为主；阶段小结可至 150 字。语气随老师风格走，不强制热情，但必须真诚、具体。
- 语言自然轮换：开头、连接词、收尾要多样，禁止每次都用"特别为 TA 高兴""收到请回复"等固定套话。

【红线——出现即重写】
1. 只罗列知识点/今天学了什么当主角（只能当背景）
2. 无事实支撑的空泛夸（"很棒""很认真"无场景）
3. 只批评、甩问题，不给解决方案
4. 班课时默认只群发不私聊（需提示老师补私聊覆盖）

【引导机制——信息不足时如何交互】
绝不替学生编造没发生的事。事实只能来自老师输入。当信息不够影响写法时，用「最少问题」反问，只问影响反馈结构的事：
- 缺具体事实 → 提示："请给我 1 个今天课堂上真实发生的细节（比如 TA 做了什么/卡在哪）"
- 缺班型或家长类型 → 给 1–2 个选项让老师点
- 不确定焦点 → 给 2–3 个反馈目标选项（高光/问题/配合/小结）让老师选
反问一次最多 2 个问题，保持轻量。

【输出格式（必须严格遵守）】
标题：一句话概括本反馈主题
内容：可直接发给家长的反馈文本（日常60-100字，阶段小结可至150字）
所以这样写：一行大白话说明这条抓住哪个点、为何给家长确定感（仅老师看，不发送）

【反千篇一律自检（生成前默念）】
这条和上次给同一家长的反馈，切入点或句式是否雷同？雷同就换切入点、换结构、换开头。保持新鲜感。`;

function classSizeLabel(cs?: FeedbackClassSize): string {
  if (!cs) return '未指定，按默认推';
  switch (cs) {
    case '1v1': return '1对1';
    case 'small': return '小班';
    case 'large': return '大班';
    default: return '未指定，按默认推';
  }
}

function parentTypeLabel(pt?: FeedbackParentType): string {
  if (!pt) return '未指定，按默认推';
  switch (pt) {
    case 'normal': return '普通';
    case 'scores': return '只认分';
    case 'sensitive': return '玻璃心';
    default: return '未指定，按默认推';
  }
}

function focusLabel(f?: FeedbackFocus): string {
  if (!f) return '未指定，按默认推';
  switch (f) {
    case 'highlight': return '高光/进步';
    case 'problem': return '发现问题';
    case 'cooperation': return '需家长配合';
    case 'summary': return '阶段小结';
    default: return '未指定，按默认推';
  }
}

function buildMessages(input: {
  student: StudentRecord;
  lessons: LessonRecord[];
  evidence: FeedbackEvidenceItem[];
  tone: string;
  classSize?: FeedbackClassSize;
  parentType?: FeedbackParentType;
  focus?: FeedbackFocus;
  historyFeedback: HistoryFeedbackItem[];
}): ChatMessage[] {
  const lessonText = input.lessons
    .map((lesson, index) => [
      `第 ${index + 1} 节课`,
      `日期：${lesson.dateTs.toISOString()}`,
      `进度：${lesson.progress ?? '未记录'}`,
      `状态：${lesson.studentState ?? '未记录'}`,
      `作业：${lesson.homework ?? '未记录'}`,
      `备注：${lesson.teacherNote ?? '未记录'}`,
    ].join('\n'))
    .join('\n\n');

  const evidenceText = input.evidence.length > 0
    ? input.evidence.map(formatEvidenceItem).join('\n')
    : '（暂无可信记录）';

  const historyText = input.historyFeedback.length > 0
    ? input.historyFeedback.map((h, i) => `第 ${i + 1} 条\n标题：${h.title}\n内容：${h.content}`).join('\n\n')
    : '无';

  return [
    {
      role: 'system',
      content: SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        `学生：${input.student.name}`,
        `年级：${input.student.grade}`,
        `阶段目标：${input.student.stageGoal ?? '未记录'}`,
        `语气：${input.tone}`,
        `班型：${classSizeLabel(input.classSize)}`,
        `家长类型：${parentTypeLabel(input.parentType)}`,
        `反馈目标：${focusLabel(input.focus)}`,
        '课程记录：',
        lessonText || '（未指定具体课程）',
        '',
        '学生可信记录（成绩/档案）：',
        evidenceText,
        '',
        '该生近期历史反馈（避免雷同）：',
        historyText,
      ].join('\n'),
    },
  ];
}

function parseDraft(content: string, studentName: string) {
  const titleMatch = content.match(/标题[:：]\s*(.+)/);
  // 内容：抓取从"内容："后到"所以这样写："之前（含换行）
  const contentMatch = content.match(/内容[:：]\s*([\s\S]*?)(?=\n\s*所以这样写[:：]|$)/);
  const rationaleMatch = content.match(/所以这样写[:：]\s*(.+)/);

  return {
    title: titleMatch?.[1]?.trim() || `${studentName}近期学习反馈`,
    content: contentMatch?.[1]?.trim() || content.trim(),
    rationale: rationaleMatch?.[1]?.trim() || '',
  };
}
