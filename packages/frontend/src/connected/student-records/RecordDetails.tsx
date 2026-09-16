const businessLabels: Record<string, string> = {
  text: '补充内容', summary: '补充摘要', observation: '观察内容', note: '备注', goal: '学习目标',
  action: '已采取行动', followUp: '后续跟进', examName: '考试名称', subject: '科目', score: '得分',
  fullScore: '满分', homework: '作业内容', lessonContent: '课程内容', occurredAt: '发生时间',
};
const traceLabels: Record<string, string> = {
  captureEventId: '来源材料编号', captureCandidateId: '核对条目编号', candidateVersion: '核对条目版本',
  captureCandidateVersion: '核对条目版本', scheduleId: '关联课程编号', lessonId: '关联上课记录编号',
};
const printable = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value);

export function RecordDetails({ data, version, supersedesId }: {
  data: Record<string, unknown> | null; version: string; supersedesId: string | null;
}) {
  const entries = Object.entries(data ?? {});
  const business = entries.filter(([key, value]) => businessLabels[key] && printable(value));
  const trace = entries.filter(([key, value]) => traceLabels[key] && printable(value));
  return <>
    {business.length > 0 && <section><h4>补充信息</h4><dl>{business.map(([key, value]) => <div key={key}><dt>{businessLabels[key]}</dt><dd className="record-full-text">{String(value)}</dd></div>)}</dl></section>}
    <details className="record-version"><summary>记录版本与修订关系</summary>
      <p>当前版本：{version}</p><p>{supersedesId ? `本记录修订自：${supersedesId}` : '本记录没有替代的旧记录。'}</p>
      {trace.map(([key, value]) => <p key={key}>{traceLabels[key]}：{String(value)}</p>)}
      {entries.length > business.length + trace.length && <p>此记录还保留了其他结构化字段，未转换为教师正文。</p>}
    </details>
  </>;
}
