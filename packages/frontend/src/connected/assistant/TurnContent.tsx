import type { AgentTurnDto, ObjectReferenceDto } from '../../api/conversations';
import type { PresentationDocument } from '@teacher-platform/contracts';

function References({ references }: { references: ObjectReferenceDto[] }) {
  // Only app-local routes are navigable. Labels remain visible for unsupported routes.
  return <ul className="assistant-references">{references.map(reference => <li key={`${reference.type}:${reference.id}`}>
    {/^\/?(?:students|schedules|lessons|payments|memos|feedback)(?:\/[^?#]*)?$/.test(reference.route)
      ? <a href={`#/${reference.route.replace(/^\//, '')}`}>{reference.label}</a> : <span>{reference.label}</span>}
  </li>)}</ul>;
}
function Presentation({ document }: { document: PresentationDocument }) {
  return <div>{document.title && <h3>{document.title}</h3>}<p>{document.summary}</p>
    {document.sections.map(section => <section key={section.id}>
      {section.heading && <h4>{section.heading}</h4>}
      {section.kind === 'text' && <p>{section.text}</p>}
      {section.kind === 'facts' && <dl>{section.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
      {section.kind === 'list' && <ul>{section.items.map(item => <li key={item.id}>{item.label}{item.detail && <p>{item.detail}</p>}</li>)}</ul>}
    </section>)}
  </div>;
}
export function TurnContent({ turn }: { turn: AgentTurnDto }) {
  if (turn.kind === 'tool') return null;
  return <article className={`assistant-turn assistant-turn-${turn.kind}`}>
    <header><strong>{turn.kind === 'user' ? '我' : '教学助手'}</strong><time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleString('zh-CN')}</time></header>
    {(turn.kind === 'user' || turn.kind === 'assistant') && <p>{turn.content}</p>}
    {turn.kind === 'assistant' && <>{turn.presentation && <Presentation document={turn.presentation} />}<References references={turn.references} /></>}
    {turn.kind === 'error' && <p role="status">这一步未完成。已保存的会话仍可回看。</p>}
    {turn.kind === 'confirmation' && <>
      <h3>历史操作记录</h3>
      {turn.beforeSummary && <p>原有内容：{turn.beforeSummary}</p>}
      <p>拟调整为：{turn.afterSummary}</p>
      <p>{turn.status === 'consumed' ? '历史记录显示此操作已处理。' : '此历史操作不能在这里继续确认，请重新提出要求并核对当前资料。'}</p>
    </>}
  </article>;
}
