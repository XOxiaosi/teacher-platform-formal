import type { AgentTurnDto, ObjectReferenceDto } from '../../api/conversations';
import type { PresentationDocument } from '@teacher-platform/contracts';
import type { ReactNode } from 'react';
import { formatDateTime } from '../../shared/date-format';

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

function References({ references }: { references: ObjectReferenceDto[] }) {
  // Only app-local routes are navigable. Labels remain visible for unsupported routes.
  return <ul className="assistant-references">{references.map(reference => <li key={`${reference.type}:${reference.id}`}>
    {/^\/?(?:students|schedules|lessons|payments|memos|feedback)(?:\/[^?#]*)?$/.test(reference.route)
      ? <a href={`#/${reference.route.replace(/^\//, '')}`}>{reference.label}</a> : <span>{reference.label}</span>}
  </li>)}</ul>;
}
function Presentation({ document, showSummary = true }: { document: PresentationDocument; showSummary?: boolean }) {
  return <div>{document.title && <h3>{document.title}</h3>}{showSummary && <MarkdownContent content={document.summary} />}
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
  const presentation = turn.kind === 'assistant' ? turn.presentation : undefined;
  const presentationSummaryIsTurnContent = turn.kind === 'assistant' && presentation
    ? presentation.summary.trim() === turn.content.trim()
    : false;
  return <article className={`assistant-turn assistant-turn-${turn.kind}`}>
    <header><strong>{turn.kind === 'user' ? '我' : '教学助手'}</strong><time dateTime={turn.createdAt}>{formatDateTime(turn.createdAt)}</time></header>
    {(turn.kind === 'user' || turn.kind === 'assistant') && (turn.kind === 'assistant' ? <MarkdownContent content={turn.content} /> : <p>{turn.content}</p>)}
    {turn.kind === 'assistant' && <>{presentation && <Presentation document={presentation} showSummary={!presentationSummaryIsTurnContent} />}<References references={turn.references} /></>}
    {turn.kind === 'error' && <p role="status">这一步未完成。已保存的会话仍可回看。</p>}
    {turn.kind === 'confirmation' && <>
      <h3>历史操作记录</h3>
      {turn.beforeSummary && <p>原有内容：{turn.beforeSummary}</p>}
      <p>拟调整为：{turn.afterSummary}</p>
      <p>{turn.status === 'consumed' ? '历史记录显示此操作已处理。' : '此历史操作不能在这里继续确认，请重新提出要求并核对当前资料。'}</p>
    </>}
  </article>;
}
