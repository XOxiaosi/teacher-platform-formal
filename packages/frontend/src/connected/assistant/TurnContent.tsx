import type { AgentTurnDto, ConfirmationStatus, ConfirmationTurnDto, ObjectReferenceDto } from '../../api/conversations';
import type { PresentationDocument } from '@teacher-platform/contracts';
import type { ReactNode } from 'react';
import { formatDateTime } from '../../shared/date-format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { CheckCircle2, CircleAlert, FileCheck2, Sparkles, UserRound, X } from 'lucide-react';

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
  onConfirm?: () => void;
  onCancel?: () => void;
}

const confirmableActions = new Set(['scheduling.create', 'memos.create']);

function confirmationIsExpired(turn: ConfirmationTurnDto): boolean {
  const expiresAt = Date.parse(turn.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= Date.now();
}

function ConfirmationContent({ turn, action, demoMode = false }: { turn: ConfirmationTurnDto; action?: ConfirmationActionProps; demoMode?: boolean }) {
  const status = action?.status ?? turn.status;
  const eligible = confirmableActions.has(turn.actionName) && status === 'pending' && Boolean(turn.actionToken) && !confirmationIsExpired(turn);
  const saved = status === 'consumed' && confirmableActions.has(turn.actionName);
  const cancelled = status === 'cancelled' && confirmableActions.has(turn.actionName);
  const destination = turn.actionName === 'scheduling.create'
    ? { href: '#/schedules', label: '查看课表', savedLabel: '课程已保存。' }
    : { href: '#/today', label: '查看待办', savedLabel: '待办已保存。' };
  return <Card className="assistant-confirmation"><CardContent>
    <div className="assistant-confirmation-heading"><span className="assistant-confirmation-icon">{saved ? <CheckCircle2 size={17} /> : <FileCheck2 size={17} />}</span><div><h3>{eligible ? demoMode ? '演示确认' : '确认保存' : saved ? demoMode ? '演示已确认' : '已保存' : '历史操作记录'}</h3><p>{demoMode ? '演示确认仅改变本页状态，不写入正式资料。' : '这项操作会保存到正式教学资料。'}</p></div></div>
    {turn.beforeSummary && <p className="assistant-change-before">原有内容：{turn.beforeSummary}</p>}
    <p className="assistant-change-after"><span>拟调整为</span>{turn.afterSummary}</p>
    {eligible && <div className="assistant-confirmation-actions">
      <p>{demoMode ? '这是演示数据，不会写入资料。' : '核对无误后再保存到资料中。'}</p>
      {action?.error && <p role="alert">{action.error}</p>}
      <div><Button type="button" disabled={action?.busy} onClick={action?.onConfirm}><CheckCircle2 size={16} />{action?.busy ? demoMode ? '正在演示确认…' : '正在保存…' : demoMode ? '演示确认' : '确认保存'}</Button>
      <Button type="button" variant="ghost" disabled={action?.busy} onClick={action?.onCancel}><X size={16} />取消</Button></div>
    </div>}
    {saved && <p>{demoMode ? '演示已确认，未写入正式资料。' : <>{destination.savedLabel} <a href={destination.href}>{destination.label}</a></>}</p>}
    {cancelled && <p>该操作已取消。不会写入资料。</p>}
    {!eligible && !saved && !cancelled && <p>{status === 'consumed' ? '历史记录显示此操作已处理。' : confirmationIsExpired(turn) ? '确认已过期，请重新提出要求并核对当前资料。' : '此历史操作不能在这里继续确认，请重新提出要求并核对当前资料。'}</p>}
  </CardContent></Card>;
}

export function TurnContent({ turn, pendingLabel, confirmation, demoMode = false }: { turn: AgentTurnDto; pendingLabel?: string; confirmation?: ConfirmationActionProps; demoMode?: boolean }) {
  const presentation = turn.kind === 'assistant' ? turn.presentation : undefined;
  const presentationSummaryIsTurnContent = turn.kind === 'assistant' && presentation
    ? presentation.summary.trim() === turn.content.trim()
    : false;
  const role = turn.kind === 'user' ? '我' : '教学助手';
  return <article className={`assistant-turn assistant-turn-${turn.kind}${pendingLabel ? ' assistant-turn-pending' : ''}`}>
    <header><span className={`assistant-turn-role assistant-turn-role-${turn.kind === 'user' ? 'user' : 'assistant'}`}>{turn.kind === 'user' ? <UserRound size={14} /> : <Sparkles size={14} />}{role}</span><time dateTime={turn.createdAt}>{formatDateTime(turn.createdAt)}</time>{pendingLabel && <Badge variant="secondary" className="assistant-turn-pending-label" role="status">{pendingLabel}</Badge>}</header>
    {(turn.kind === 'user' || turn.kind === 'assistant') && (turn.kind === 'assistant' ? <MarkdownContent content={turn.content} /> : <p>{turn.content}</p>)}
    {turn.kind === 'assistant' && <>{presentation && <><Separator className="assistant-turn-separator" /><Presentation document={presentation} showSummary={!presentationSummaryIsTurnContent} /></>}<References references={turn.references} /></>}
    {turn.kind === 'tool' && <>
      {turn.resultSummary && <Card className="assistant-tool-result"><CardContent><Badge variant={turn.status === 'success' ? 'secondary' : 'outline'}>{turn.status === 'success' ? '已处理' : '处理未完成'}</Badge><p>{turn.resultSummary}</p></CardContent></Card>}
      {turn.status === 'failed' && <p className="assistant-turn-note" role="status"><CircleAlert size={15} />这一步未完成。已保存的会话仍可回看。</p>}
      <References references={turn.references} studentLinkLabel />
    </>}
    {turn.kind === 'error' && <p className="assistant-turn-note" role="status"><CircleAlert size={15} />这一步未完成。已保存的会话仍可回看。</p>}
    {turn.kind === 'confirmation' && <ConfirmationContent turn={turn} action={confirmation} demoMode={demoMode} />}
  </article>;
}
