import { err, validationError } from '@teacher-platform/contracts';

/**
 * 对外完课入口必须先拥有可核验的实际出勤与扣课影响预览。
 * 旧完成用例仍保留给未来接入该闭环，不能由任何当前可达入口绕过。
 */
export const COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE = '完课前需核对每位学生的实际出勤、拟扣课时和余额变化；当前暂不能确认完课。';
export const LESSON_STATUS_CORRECTION_REQUIRED_MESSAGE = '出勤状态更正需先预览课时和余额影响，请在课程详情中使用“出勤状态更正”。';

export function completionEntrypointUnavailable() {
  return err(validationError(COMPLETION_ENTRYPOINT_UNAVAILABLE_MESSAGE, 'completion'));
}

export function lessonStatusCorrectionRequired() {
  return err(validationError(LESSON_STATUS_CORRECTION_REQUIRED_MESSAGE, 'lessonStatus'));
}
