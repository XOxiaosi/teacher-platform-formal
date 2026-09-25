import type { ScheduleData, StudentData } from '../api/types';
import { formatDateTime } from './date-format';

export interface CourseScheduleFieldValues {
  time: string;
  location: string;
  participants: string;
  classFormat: string;
  note: string;
}

/** 课程排期的唯一数据展示边界；兼容标题、科目和授课内容不得进入此处。 */
export function courseScheduleFields(
  schedule: Pick<ScheduleData, 'scheduledStart' | 'scheduledEnd' | 'location' | 'classFormat' | 'operationalNote' | 'participants' | 'participantIds' | 'studentId'>,
  students: readonly Pick<StudentData, 'id' | 'name'>[] = [],
): CourseScheduleFieldValues {
  const participantNames = schedule.participants?.map((participant) => clean(participant.name)).filter(isPresent)
    || schedule.participantIds?.map((id) => clean(students.find((student) => student.id === id)?.name)).filter(isPresent)
    || (schedule.studentId ? [clean(students.find((student) => student.id === schedule.studentId)?.name)].filter(isPresent) : []);
  return {
    time: `${formatDateTime(schedule.scheduledStart)} – ${formatDateTime(schedule.scheduledEnd)}`,
    location: clean(schedule.location) ?? '地点待补充',
    participants: participantNames.join('、') || '参与人待补充',
    classFormat: schedule.classFormat === 'small_group' ? '小班' : schedule.classFormat === 'one_to_one' ? '一对一' : '形式待补充',
    note: clean(schedule.operationalNote) ?? '暂无备注',
  };
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 160) : null;
}

function isPresent(value: string | null): value is string {
  return value !== null;
}
