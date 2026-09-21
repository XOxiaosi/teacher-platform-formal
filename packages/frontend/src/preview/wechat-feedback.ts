export type WechatFeedbackStatus = '待核对' | '已记录' | '需补充' | '已拒绝' | '失败';

export type WechatFeedback = {
  id: string;
  source: '微信';
  receivedAt: string;
  senderLabel: string;
  status: WechatFeedbackStatus;
  summary: string;
  rawText: string;
  proposedRecord?: string;
  studentId?: string;
  providedStudentName?: string;
  assignment: '已匹配学生' | '待人工确认' | '未识别';
  recordState: '未保存' | '演示已记录' | '无需保存';
  replyState: '未发送' | '未回复' | '发送失败';
  reviewNote?: string;
  failureReason?: string;
  retryRequested?: boolean;
};

export function createDemoWechatFeedbacks(day: string): WechatFeedback[] {
  return [
    {
      id: 'wx-demo-1', source: '微信', receivedAt: `${day}T08:42:00+08:00`, senderLabel: '教师转述 · 李雨桐家长反馈', studentId: 's1',
      status: '待核对', summary: '家长补充了昨晚练习完成情况，等待归入学习记录。',
      rawText: '老师您好，雨桐昨晚把错题重新整理了一遍，函数题还是有两道不太确定，想请您下次课再带她看一下。',
      proposedRecord: '家长反馈：已整理错题；函数题仍有两道待下次课讲解。', assignment: '已匹配学生', recordState: '未保存', replyState: '未回复',
    },
    {
      id: 'wx-demo-2', source: '微信', receivedAt: `${day}T10:16:00+08:00`, senderLabel: '教师转述 · 王浩然家长反馈', studentId: 's2',
      status: '已记录', summary: '请假原因已由教师核对并作为课堂记录保留。',
      rawText: '浩然今天有些发烧，下午的课可能赶不过去，后面状态好些再和您约时间。',
      proposedRecord: '家长告知：因身体不适，今日课程可能无法参加；待教师后续确认安排。', assignment: '已匹配学生', recordState: '演示已记录', replyState: '未发送',
      reviewNote: '这是合成演示状态，不代表已写入真实学生档案。',
    },
    {
      id: 'wx-demo-3', source: '微信', receivedAt: `${day}T11:05:00+08:00`, senderLabel: '教师录入', providedStudentName: '小周',
      status: '需补充', summary: '消息中只出现称呼，无法安全归属到现有学生。',
      rawText: '小周这周的作业已经补好了，麻烦老师有空看一下。',
      proposedRecord: '家长表示本周作业已补齐，待教师核对具体学生与材料。', assignment: '待人工确认', recordState: '未保存', replyState: '未回复',
      reviewNote: '请先人工选择学生；系统不会按相似称呼自动归档。',
    },
    {
      id: 'wx-demo-4', source: '微信', receivedAt: `${day}T12:20:00+08:00`, senderLabel: '教师录入',
      status: '失败', summary: '该条消息内容未能完整读取，尚未形成可核对记录。',
      rawText: '（内容读取失败，未保留可用原话）', assignment: '未识别', recordState: '无需保存', replyState: '发送失败',
      failureReason: '通道返回的消息内容不完整。本演示不会自动重试或把失败标记为已记录。',
    },
  ];
}
