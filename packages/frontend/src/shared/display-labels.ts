const scheduleStatusLabels: Record<string, string> = {
  planned: '计划中',
  completed: '已完成',
  cancelled: '已取消',
  missed: '未到',
  rescheduled: '已改期',
  extra: '加课',
};

const scheduleTypeLabels: Record<string, string> = {
  lesson: '课程',
  prep: '备课',
  meeting: '会议',
  call: '电话沟通',
  other: '其他',
};

const lessonStatusLabels: Record<string, string> = {
  attended: '已上课',
  absent: '请假/缺席',
  pending: '待确认',
};

const studentStatusLabels: Record<string, string> = {
  active: '在读',
  paused: '暂停',
  archived: '已归档',
};

const aiIntentLabels: Record<string, string> = {
  lesson_record: '课堂记录',
  schedule_request: '排课线索',
  payment_note: '缴费备注',
  general_note: '普通记录',
};

export function scheduleStatusLabel(status: string): string {
  return scheduleStatusLabels[status] ?? status;
}

export function scheduleTypeLabel(type: string): string {
  return scheduleTypeLabels[type] ?? type;
}

export function lessonStatusLabel(status: string): string {
  return lessonStatusLabels[status] ?? status;
}

export function studentStatusLabel(status: string): string {
  return studentStatusLabels[status] ?? status;
}

export function aiIntentLabel(intent: string): string {
  return aiIntentLabels[intent] ?? intent;
}
