import type { AgentTurnDto, ConfirmationStatus, ConfirmationTurnDto, ObjectReferenceDto } from '../../api/conversations';
import type { PresentationDocument } from '@teacher-platform/contracts';
import type { ReactNode } from 'react';
import { formatDateTime } from '../../shared/date-format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { CheckCircle2, FileCheck2, Pencil } from 'lucide-react';

function collapseRepeatedBlocks(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const generatedStarts = [...normalized.matchAll(/(?:已查询完毕|查完了|核对结果如下|结论：这两位目前不在系统里)/g)].map(match => match.index ?? -1).filter(index => index >= 0);
  if (generatedStarts.length >= 2 && generatedStarts[1]! - generatedStarts[0]! > 200) {
    return `${normalized.slice(0, generatedStarts[1]).trim()}\n\n（重复结果已折叠，以上结论保留一次。）`;
  }
  const duplicateMarkers = ['已查询完毕，说明如下。', '查完了，先说结论：', '核对结果如下（均为只读查询）：', '结论：这两位目前不在系统里，我也无法把他们录入。'];
  for (const marker of duplicateMarkers) {
    const first = content.indexOf(marker);
    const second = first < 0 ? -1 : content.indexOf(marker, first + marker.length);
    if (second > first) return `${content.slice(0, second).trim()}\n\n（重复结果已折叠，以上结论保留一次。）`;
  }
  const blocks = content.split(/\n{2,}/);
  for (let size = Math.floor(blocks.length / 2); size >= 2; size -= 1) {
    const first = blocks.slice(0, size).join('\n\n');
    const second = blocks.slice(size, size * 2).join('\n\n');
    if (first && first === second) return [...blocks.slice(0, size), ...blocks.slice(size * 2)].join('\n\n');
  }
  return content;
}

function inlineText(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

function MarkdownContent({ content }: { content: string }) {
  const lines = collapseRepeatedBlocks(content).split('\n');
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]?.trimEnd() ?? '';
    if (!line.trim()) { index += 1; continue; }
    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) { blocks.push(heading[1].length === 2 ? <h3 key={index}>{inlineText(heading[2])}</h3> : <h4 key={index}>{inlineText(heading[2])}</h4>); index += 1; continue; }
    if (/^[-*]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]?.trim() ?? '')) {
        items.push(<li key={index}>{inlineText((lines[index] ?? '').trim().replace(/^[-*]\s+/, ''))}</li>); index += 1;
      }
      blocks.push(<ul key={`list-${index}`}>{items}</ul>); continue;
    }
    if (line.includes('|') && lines[index + 1]?.includes('|') && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1] ?? '')) {
      const parseRow = (value: string) => value.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const headers = parseRow(line); index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]?.includes('|') && lines[index]?.trim()) { rows.push(parseRow(lines[index] ?? '')); index += 1; }
      blocks.push(<table key={`table-${index}`}><thead><tr>{headers.map((header, cellIndex) => <th key={cellIndex}>{inlineText(header)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineText(row[cellIndex] ?? '')}</td>)}</tr>)}</tbody></table>); continue;
    }
    const paragraph: string[] = [line]; index += 1;
    while (index < lines.length && lines[index]?.trim() && !/^#{2,4}\s+/.test(lines[index] ?? '') && !/^[-*]\s+/.test(lines[index] ?? '')) { paragraph.push((lines[index] ?? '').trimEnd()); index += 1; }
    blocks.push(<p key={index}>{inlineText(paragraph.join('\n'))}</p>);
  }
  return <div className="assistant-markdown">{blocks}</div>;
}

function References({ references, studentLinkLabel = false }: { references: ObjectReferenceDto[]; studentLinkLabel?: boolean }) {
  // Only app-local routes are navigable. Labels remain visible for unsupported routes.
  return <ul className="assistant-references">{references.map(reference => <li key={`${reference.type}:${reference.id}`}>
    {/^\/?(?:students|schedules|lessons|payments|memos|feedback)(?:\/[^?#]*)?$/.test(reference.route)
      ? <a href={`#/${reference.route.replace(/^\//, '')}`}>{studentLinkLabel && reference.type === 'Student' ? '查看学生' : reference.label}</a> : <span>{reference.label}</span>}
  </li>)}</ul>;
}
function Presentation({ document, showSummary = true }: { document: PresentationDocument; showSummary?: boolean }) {
  return <div className="assistant-presentation">{document.title && <h3>{document.title}</h3>}{showSummary && <MarkdownContent content={document.summary} />}
    {document.sections.map(section => <section key={section.id}>
      {section.heading && <h4>{section.heading}</h4>}
      {section.kind === 'text' && <p>{section.text}</p>}
      {section.kind === 'facts' && <dl>{section.items.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>}
      {section.kind === 'list' && <ul>{section.items.map(item => <li key={item.id}>{item.label}{item.detail && <p>{item.detail}</p>}</li>)}</ul>}
    </section>)}
  </div>;
}
interface ConfirmationActionProps {
  status?: ConfirmationStatus;
  busy?: boolean;
  error?: string;
  receipt?: string;
  modifying?: boolean;
  onConfirm?: () => void;
  onModify?: () => void;
}

const confirmableActions = new Set(['scheduling.create', 'memos.create']);

function confirmationIsExpired(turn: ConfirmationTurnDto): boolean {
  const expiresAt = Date.parse(turn.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function ConfirmationContent({ turn, action, testOnlyMode = false, demoMode = false }: { turn: ConfirmationTurnDto; action?: ConfirmationActionProps; testOnlyMode?: boolean; demoMode?: boolean }) {
  const status = action?.status ?? turn.status;
  const isConfirmableAction = confirmableActions.has(turn.actionName);
  const cannotVerifyTestOnlyResult = testOnlyMode && isConfirmableAction;
  const eligible = !cannotVerifyTestOnlyResult && isConfirmableAction && status === 'pending' && Boolean(turn.actionToken) && !confirmationIsExpired(turn);
  const saved = !cannotVerifyTestOnlyResult && status === 'consumed' && isConfirmableAction;
  const cancelled = !cannotVerifyTestOnlyResult && status === 'cancelled' && isConfirmableAction;
  const destination = turn.actionName === 'scheduling.create'
    ? { href: '#/schedules', label: '查看课表' }
    : { href: '#/today', label: '查看待办' };
  return <Card className="assistant-confirmation"><CardContent>
    <div className="assistant-confirmation-heading"><span className="assistant-confirmation-icon">{saved ? <CheckCircle2 size={17} /> : <FileCheck2 size={17} />}</span><div><h3>{cannotVerifyTestOnlyResult ? '无法核实保存状态' : eligible ? demoMode ? '演示确认' : '确认变更' : saved ? demoMode ? '演示已确认' : '变更已保存' : '变更记录'}</h3><p>{cannotVerifyTestOnlyResult ? '当前教学 AI 未启用正式服务，无法核实此项变更是否已保存。请在课表或相关资料中确认实际状态。' : demoMode ? '演示确认仅改变本页状态，不写入正式资料。' : eligible ? '确认后才会保存到教学资料。' : ''}</p></div></div>
    {turn.beforeSummary && <p className="assistant-change-before">原有内容：{turn.beforeSummary}</p>}
    <p className="assistant-change-after"><span>拟调整为</span>{turn.afterSummary}</p>
    {eligible && <div className="assistant-confirmation-actions">
      <p>{demoMode ? '这是演示数据，不会写入资料。' : '请核对具体内容后确认。'}</p>
      {action?.error && <p role="alert">{action.error}</p>}
      <div><Button type="button" disabled={action?.busy} onClick={action?.onConfirm}><CheckCircle2 size={16} />{action?.busy ? demoMode ? '正在演示确认…' : '正在保存…' : demoMode ? '演示确认' : '确认'}</Button>
      <Button type="button" variant="ghost" disabled={action?.busy || action?.modifying} onClick={action?.onModify}><Pencil size={16} />{action?.busy && action?.modifying ? '正在修改…' : '修改'}</Button></div>
    </div>}
    {saved && <p>{demoMode ? '演示已确认，未写入正式资料。' : <>{action?.receipt || `已保存：${turn.afterSummary}`} <a href={destination.href}>{destination.label}</a></>}</p>}
    {cancelled && <p>该操作已取消。不会写入资料。</p>}
    {!cannotVerifyTestOnlyResult && !eligible && !saved && !cancelled && <p>{confirmationIsExpired(turn) ? '这项确认已过期，请重新核对后提出。' : '这项变更暂时无法确认，请重新提出要求。'}</p>}
  </CardContent></Card>;
}

export function TurnContent({ turn, confirmation, testOnlyMode = false, demoMode = false }: { turn: AgentTurnDto; confirmation?: ConfirmationActionProps; testOnlyMode?: boolean; demoMode?: boolean }) {
  const presentation = turn.kind === 'assistant' ? turn.presentation : undefined;
  const presentationSummaryIsTurnContent = turn.kind === 'assistant' && presentation
    ? presentation.summary.trim() === turn.content.trim()
    : false;
  return <article className={`assistant-turn assistant-turn-${turn.kind}`}>
    {(turn.kind === 'user' || turn.kind === 'assistant') && (turn.kind === 'assistant' ? <MarkdownContent content={turn.content} /> : <p>{turn.content}</p>)}
    {turn.kind === 'assistant' && <>{presentation && <><Separator className="assistant-turn-separator" /><Presentation document={presentation} showSummary={!presentationSummaryIsTurnContent} /></>}<References references={turn.references} /></>}
    {turn.kind === 'tool' && (turn.resultSummary || turn.references.length > 0) && <div className="assistant-tool-result">{turn.resultSummary && <p>{turn.resultSummary}</p>}<References references={turn.references} studentLinkLabel /></div>}
    {turn.kind === 'tool' && turn.status === 'failed' && !turn.resultSummary && <p className="assistant-turn-note" role="status">这次没有取得结果，可以调整要求后重试。</p>}
    {turn.kind === 'error' && <p className="assistant-turn-note" role="status">这次没有生成回复，可以稍后重试。</p>}
    {turn.kind === 'confirmation' && <ConfirmationContent turn={turn} action={confirmation} testOnlyMode={testOnlyMode} demoMode={demoMode} />}
    {['user', 'assistant'].includes(turn.kind) && <time className="assistant-turn-time" dateTime={turn.createdAt}>{formatDateTime(turn.createdAt)}</time>}
  </article>;
}
