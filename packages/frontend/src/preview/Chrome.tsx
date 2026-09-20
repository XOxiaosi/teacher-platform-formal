import { Children, Fragment, isValidElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { BookOpen, CalendarDays, ChevronDown, GraduationCap, LayoutDashboard, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen, Settings, Users, Wallet, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetDescription, SheetTrigger } from '@/components/ui/sheet';
import { Dialog as BaseDialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

export const icons = { today: LayoutDashboard, ai: MessageSquare, students: Users, schedule: CalendarDays, finance: Wallet, feedback: BookOpen, settings: Settings } satisfies Record<string, LucideIcon>;
const nav = [
  { key: 'agent', label: 'AI 助手', icon: 'ai' },
  { key: 'today', label: '今日工作台', icon: 'today' },
  { key: 'students', label: '我的学生', icon: 'students' },
  { key: 'schedules', label: '日程安排', icon: 'schedule' },
  { key: 'finance', label: '缴费课时', icon: 'finance' },
  { key: 'feedback', label: '家长反馈', icon: 'feedback' },
  { key: 'settings', label: '设置', icon: 'settings' },
] as const;
export function Icon({ name }: { name: keyof typeof icons }) { const Glyph = icons[name]; return <Glyph aria-hidden="true" size={19} strokeWidth={1.7} />; }

function Brand({ studioName }: { studioName: string }) {
  return <a className="studio-brand" href="#/today" aria-label={`${studioName}首页`}><span className="studio-mark"><GraduationCap size={24} strokeWidth={1.6} /></span><span className="studio-brand-copy"><strong>{studioName}</strong><small>TEACHING WORKSPACE</small></span></a>;
}
function Navigation({ page, compact = false, onNavigate }: { page: string; compact?: boolean; onNavigate?: () => void }) {
  return <nav className="studio-navigation" aria-label="主要导航">{nav.map(({ key, label, icon }, index) => <div key={key}>
    {(index === 2 || index === 6) && <Separator className="studio-nav-divider" />}
    <Tooltip><TooltipTrigger asChild><Button asChild variant="ghost" className={`studio-nav-link${page === key ? ' is-active' : ''}`}>
      <a href={`#/${key}`} aria-label={label} aria-current={page === key ? 'page' : undefined} onClick={onNavigate}><Icon name={icon} /><span className="studio-nav-label">{label}</span>{key === 'agent' && <span className="studio-ai-tag">AI</span>}</a>
    </Button></TooltipTrigger>{compact && <TooltipContent side="right">{label}</TooltipContent>}</Tooltip>
  </div>)}</nav>;
}
function AccountActions({ children }: { children: ReactNode }) {
  return Children.map(children, child => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return child;
    if (child.type === Fragment) return <AccountActions>{child.props.children}</AccountActions>;
    return child.type === 'button' || child.type === 'a'
      ? <DropdownMenuItem asChild>{child}</DropdownMenuItem>
      : <DropdownMenuLabel>{child}</DropdownMenuLabel>;
  });
}
export function Shell({ page, children, studioName, displayName = '教师', accountActions }: { page: string; children: ReactNode; studioName: string; displayName?: string; accountActions?: ReactNode }) {
  const [compact, setCompact] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const title = nav.find(item => item.key === page)?.label ?? (page === 'captures' ? '待核对材料' : '工作空间');
  useEffect(() => { setMobileOpen(false); }, [page]);
  return <TooltipProvider delayDuration={250}><div className={`preview-app studio-shell${compact ? ' studio-compact' : ''}`}>
    <aside className="studio-sidebar"><Brand studioName={studioName} /><p className="studio-nav-caption">我的工作空间</p><Navigation page={page} compact={compact} />
      <div className="studio-sidebar-bottom"><Separator /><div className="studio-identity"><span className="studio-avatar">{displayName.slice(0, 1)}</span><span><strong>{displayName}</strong><small>个人教师工作空间</small></span></div>
      <Button className="studio-collapse" variant="ghost" onClick={() => setCompact(value => !value)} aria-label={compact ? '展开导航' : '收起导航'} aria-expanded={!compact}>{compact ? <PanelLeftOpen /> : <><PanelLeftClose /><span>收起侧栏</span></>}</Button></div>
    </aside>
    <div className="studio-body"><header className="studio-topbar">
      <div className="studio-breadcrumb"><Sheet open={mobileOpen} onOpenChange={setMobileOpen}><SheetTrigger asChild><Button variant="ghost" size="icon" className="studio-mobile-menu" aria-label="打开导航"><Menu /></Button></SheetTrigger><SheetContent side="left" className="studio-mobile-sheet" aria-describedby="navigation-description"><SheetTitle className="sr-only">工作空间导航</SheetTitle><SheetDescription id="navigation-description" className="sr-only">选择要打开的教师工作页面。</SheetDescription><Brand studioName={studioName} /><Navigation page={page} onNavigate={() => setMobileOpen(false)} /></SheetContent></Sheet><span className="studio-breadcrumb-root">工作空间</span><span className="studio-breadcrumb-slash">/</span><strong>{title}</strong></div>
      <div className="studio-topbar-end"><span className="studio-private-label">个人空间</span>{accountActions ? <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" className="studio-account-button" aria-label="账号菜单"><span className="studio-avatar small">{displayName.slice(0, 1)}</span><span>{displayName}</span><ChevronDown size={14} /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="studio-account-menu"><DropdownMenuLabel>我的账号</DropdownMenuLabel><DropdownMenuSeparator /><div className="studio-account-actions"><AccountActions>{accountActions}</AccountActions></div></DropdownMenuContent></DropdownMenu> : <span className="studio-avatar small" aria-label={displayName}>{displayName.slice(0, 1)}</span>}</div>
    </header><main className={`preview-main studio-main${page === 'agent' ? ' studio-main-assistant' : ''}`} id="workspace-content">{children}</main></div>
  </div></TooltipProvider>;
}

export function Dialog({ title, children, onClose, disabled = false }: { title: string; children: ReactNode; onClose: () => void; disabled?: boolean }) {
  const close = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => { close.current?.focus(); }, [title]);
  const trap = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'));
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  return <BaseDialog open onOpenChange={open => { if (!open && !disabled) onClose(); }}><DialogContent className="dialog studio-dialog" showCloseButton={false} aria-describedby={undefined} inert={disabled || undefined} aria-busy={disabled} onCloseAutoFocus={event => { event.preventDefault(); previousFocus.current?.focus(); }} onOpenAutoFocus={event => { event.preventDefault(); close.current?.focus(); }} onKeyDown={trap}>
    <div className="dialog-head"><DialogTitle>{title}</DialogTitle><Button ref={close} type="button" variant="ghost" size="icon" aria-label="关闭" disabled={disabled} onClick={onClose}><X /></Button></div>{children}
  </DialogContent></BaseDialog>;
}
export function Notice({ children }: { children: ReactNode }) { return <p className="notice" role="status">{children}</p>; }
