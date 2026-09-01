import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../app/teacher-context';
import { ApiError } from '../../api/client';
import {
  deactivate,
  exportDownloadZip,
  exportPrivacy,
  exportStatus,
  type PrivacyExportJobResult,
} from '../../api/privacy';
import './privacy.css';

interface PrivacyPageProps {
  teacherId: string;
}

/**
 * 隐私与数据自助服务页（/settings/privacy，p7-privacy-compliance-plan.md §2/§3；P9 接线；P14 t5 zip）。
 *
 * - 数据导出（导出权）：POST /api/v1/privacy/export {format:'zip'} → jobId → 轮询
 *   GET /export/status → succeeded 后 GET /export/download 取 application/zip 单包
 *   （export-<teacherId>.zip，含 manifest/account/tables/media 文件本体）并触发浏览器下载。
 *   全程 owner 隔离（session cookie，后端 requireAuth）；前端不传 teacherId。
 * - 账号注销（删除权）：POST /api/v1/privacy/deactivate {email,password,confirm}
 *   （邮箱=注册邮箱、密码登录验证、confirm=再次输入邮箱）→ 成功提示「账号已注销，即将退出」+ logout。
 *   安全红线：**前端只调用后端 API**，真实删除由服务端 deactivate-teacher --confirm 门禁执行。
 */

/** 导出轮询参数（后台 spawn 任务，前端轮询终态；测试可引用）。 */
export const PRIVACY_POLL = {
  intervalMs: 2000,
  maxAttempts: 30,
  /** 轮询超过该时长（media 段多时导出更久）提示大文件文案；默认 4 次轮询 ≈ 8 秒 */
  slowHintAfterMs: 8000,
};

type ExportPhase = 'idle' | 'running' | 'done' | 'error';

export function PrivacyPage({ teacherId }: PrivacyPageProps) {
  const { email: currentEmail, logout } = useAuth();
  const [exportPhase, setExportPhase] = useState<ExportPhase>('idle');
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  /** 轮询偏久（media 段多）时的提示：正在生成大导出包 */
  const [exportSlowHint, setExportSlowHint] = useState(false);
  const cancelledRef = useRef(false);

  const [deactivateForm, setDeactivateForm] = useState({ email: '', password: '', confirm: '' });
  const [deactivating, setDeactivating] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const [deactivateSuccess, setDeactivateSuccess] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // ---------- 数据导出：提交(zip) → 轮询 → 下载 zip 单包 ----------
  async function handleRequestExport() {
    if (exportPhase === 'running') return;
    const message = '平台将在后台生成你的全部数据副本（zip 单包：账号信息 + 业务数据 + 媒体文件），'
      + '完成后自动触发浏览器下载。继续？';
    if (!window.confirm(message)) return;
    cancelledRef.current = false;
    setExportInfo(null);
    setExportError(null);
    setExportSlowHint(false);
    setExportPhase('running');
    try {
      const { jobId } = await exportPrivacy({ format: 'zip' });
      await pollAndDownload(jobId);
      if (cancelledRef.current) return;
      setExportPhase('done');
    } catch (error) {
      if (cancelledRef.current) return;
      setExportPhase('error');
      setExportError(messageOf(error));
    }
  }

  /** 下载完成后清理态：收起完成提示，回到可再次导出的 idle。 */
  function dismissExportResult() {
    setExportInfo(null);
    setExportError(null);
    setExportSlowHint(false);
    setExportPhase('idle');
  }

  async function pollAndDownload(jobId: string): Promise<void> {
    const totalSeconds = (PRIVACY_POLL.maxAttempts * PRIVACY_POLL.intervalMs) / 1000;
    for (let attempt = 0; attempt < PRIVACY_POLL.maxAttempts; attempt += 1) {
      // 组件卸载/取消后立即停止：不再轮询、不触发下载、不更新已卸载页面状态
      if (cancelledRef.current) return;
      const job = await exportStatus(jobId);
      if (cancelledRef.current) return;
      if (job.status === 'succeeded') {
        // P14 t5：zip 单包 blob 直存（文件名取 Content-Disposition，兜底 export-<teacherId>.zip）
        const { blob, filename } = await exportDownloadZip(jobId);
        if (cancelledRef.current) return;
        const fileName = filename ?? `export-${teacherId}.zip`;
        savePrivacyExportFile(blob, fileName);
        // media 段多时导出偏久：完成后带上媒体统计摘要（mediaFiles>0 才显示）
        const mediaNote = describeMedia(job.result);
        setExportSlowHint(false);
        setExportInfo(`导出完成，已下载 ${fileName}${mediaNote}。`);
        return;
      }
      if (job.status === 'failed') {
        throw new Error(job.error ?? '导出任务失败，请稍后重试');
      }
      // 轮询偏久 → 提示大导出包（媒体文件较多时后台仍在生成，勿重复点击）
      const elapsedMs = (attempt + 1) * PRIVACY_POLL.intervalMs;
      if (elapsedMs >= PRIVACY_POLL.slowHintAfterMs) {
        setExportSlowHint(true);
      }
      await delay(PRIVACY_POLL.intervalMs);
    }
    throw new Error(`导出超时（超过 ${totalSeconds} 秒），请稍后重试`);
  }

  // ---------- 账号注销：邮箱+密码双验证 + confirm 二次确认 ----------
  async function handleRequestDeactivate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deactivating) return;
    setDeactivateError(null);
    setDeactivateSuccess(null);

    const email = deactivateForm.email.trim();
    const confirm = deactivateForm.confirm.trim();
    if (!email) {
      setDeactivateError('请输入注册邮箱。');
      return;
    }
    if (!deactivateForm.password) {
      setDeactivateError('请输入登录密码。');
      return;
    }
    if (!confirm) {
      setDeactivateError('请再次输入注册邮箱以确认注销。');
      return;
    }
    if (currentEmail !== null && email.toLowerCase() !== currentEmail.toLowerCase()) {
      setDeactivateError('邮箱与当前登录账号不一致，请核对后重试。');
      return;
    }
    if (confirm.toLowerCase() !== email.toLowerCase()) {
      setDeactivateError('二次确认的邮箱与注册邮箱不一致，请核对后重试。');
      return;
    }
    const message = '确认注销账号？此操作将永久删除你的账号与全部数据（学生/日程/缴费/家长沟通/AI 会话等），不可恢复；'
      + '注销前会备份留证。真实删除由服务端执行（--confirm 门禁），本页仅提交注销请求。';
    if (!window.confirm(message)) return;

    setDeactivating(true);
    try {
      await deactivate({ email, password: deactivateForm.password, confirm });
      setDeactivateSuccess('账号已注销，即将退出…');
      setDeactivateForm({ email: '', password: '', confirm: '' });
      await logout();
    } catch (error) {
      setDeactivateError(messageOf(error));
    } finally {
      setDeactivating(false);
    }
  }

  return (
    <section className="privacy-page">
      <header className="page-hero">
        <p className="eyebrow">账户与数据</p>
        <h2>隐私与数据</h2>
        <p>了解平台收集与使用你的哪些数据，行使个人信息保护法赋予的知情、导出与删除权利。</p>
      </header>

      <section className="page-card privacy-section">
        <h3>我的数据</h3>
        <p className="privacy-section-desc">
          平台收集并用于教学工作台功能的个人数据包括：账号信息（邮箱/昵称）、学生信息、教学安排与课程记录、
          缴费记录、家长沟通记录、长期学生档案、AI 交互记录（原始输入/会话/执行日志）、备忘提醒、操作审计。
          数据仅用于提供服务，不向第三方出售或用于广告定向。
        </p>
      </section>

      <section className="page-card privacy-section">
        <h3>数据导出（导出权）</h3>
        <p className="privacy-section-desc">
          你有权获得名下全部数据的结构化副本（zip 单包：manifest 清单 + 账号信息 + 业务表 + 媒体文件），
          可机读、可留档；导出范围含账号公开信息、全部业务数据与媒体文件，
          <strong>不含密码哈希与会话令牌</strong>。
        </p>
        <p className="privacy-note">
          点击「导出我的数据」后，平台在后台生成你的导出包（zip 单包：账号信息 + 业务数据 + 媒体文件，不含密码哈希），
          完成后自动触发浏览器下载。导出约需数秒，期间请勿重复点击。
        </p>
        <button
          type="button"
          className="secondary-action privacy-action"
          onClick={() => void handleRequestExport()}
          disabled={exportPhase === 'running'}
        >
          {exportPhase === 'running' ? '导出中…' : '导出我的数据'}
        </button>
        {exportPhase === 'running' ? (
          <p className="privacy-pending" role="status">
            {exportSlowHint
              ? '正在生成导出包（媒体文件较多，导出可能需要更久，请耐心等待）…'
              : '正在生成导出包，请稍候…'}
          </p>
        ) : null}
        {exportInfo ? (
          <div className="privacy-result">
            <p className="privacy-intent" role="status">{exportInfo}</p>
            <button
              type="button"
              className="privacy-dismiss"
              onClick={dismissExportResult}
            >
              知道了
            </button>
          </div>
        ) : null}
        {exportError ? <p className="privacy-error" role="alert">导出失败：{exportError}</p> : null}
      </section>

      <section className="page-card privacy-section privacy-danger">
        <h3>账号注销（删除权 · 高风险）</h3>
        <div className="privacy-warning" role="alert">
          <strong>注销后果：</strong>
          删除你的账号记录与全部业务数据（学生/日程/缴费/家长沟通/AI 会话/备忘等）、使所有登录会话立即失效；
          执行前会备份留证（备份副本按保留策略在 7 天/12 个月内自然过期，期间不用于业务用途）。
          <strong>此操作不可撤销。</strong>
        </div>
        <ul className="privacy-checklist">
          <li>注销前请先处理待确认操作（PendingAction）与运行中的 Agent 任务。</li>
          <li>注销需服务端校验邮箱 + 密码 + 二次确认（confirm=邮箱），并带 --confirm 门禁在后台执行。</li>
          <li>本页只调用注销 API 提交请求，<strong>真实删除由服务端执行</strong>（安全红线，前端永不直接删除）。</li>
        </ul>
        <form className="privacy-form" onSubmit={(event) => void handleRequestDeactivate(event)}>
          <label className="privacy-field" htmlFor="privacy-email">
            注册邮箱
            <input
              id="privacy-email"
              type="email"
              autoComplete="email"
              value={deactivateForm.email}
              onChange={(event) => {
                setDeactivateForm((form) => ({ ...form, email: event.target.value }));
                setDeactivateError(null);
              }}
              placeholder={currentEmail ?? '你的注册邮箱'}
              required
            />
          </label>
          <label className="privacy-field" htmlFor="privacy-password">
            登录密码
            <input
              id="privacy-password"
              type="password"
              autoComplete="current-password"
              value={deactivateForm.password}
              onChange={(event) => {
                setDeactivateForm((form) => ({ ...form, password: event.target.value }));
                setDeactivateError(null);
              }}
              placeholder="输入登录密码以验证身份"
              required
            />
          </label>
          <label className="privacy-field" htmlFor="privacy-confirm">
            再次输入注册邮箱确认
            <input
              id="privacy-confirm"
              type="email"
              autoComplete="off"
              value={deactivateForm.confirm}
              onChange={(event) => {
                setDeactivateForm((form) => ({ ...form, confirm: event.target.value }));
                setDeactivateError(null);
              }}
              placeholder="再次输入注册邮箱"
              required
            />
          </label>
          {deactivateError ? <p className="privacy-error" role="alert">{deactivateError}</p> : null}
          {deactivateSuccess ? <p className="privacy-intent" role="status">{deactivateSuccess}</p> : null}
          <button type="submit" className="danger-action privacy-action" disabled={deactivating}>
            {deactivating ? '注销中…' : '申请注销账号'}
          </button>
        </form>
      </section>
    </section>
  );
}

/** 触发浏览器下载（blob 直存：zip 单包等二进制附件；一次性产物；测试可直接断言）。 */
export function savePrivacyExportFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 字节数 → 人类可读（<1MB 用 KB；否则 MB 保留 1 位）。测试可直接断言。 */
export function formatExportBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024 * 1024) {
    const kb = Math.max(1, Math.round(bytes / 1024));
    return `${kb} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 完成摘要附注：media 段有文件时提示数量与体积（否则空串）。 */
export function describeMedia(result: PrivacyExportJobResult | undefined): string {
  const files = result?.mediaFiles;
  if (!files || files <= 0) return '';
  const size = typeof result?.mediaBytes === 'number' ? formatExportBytes(result.mediaBytes) : '';
  return `（含 ${files} 个媒体文件${size ? `，共 ${size}` : ''}）`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.error.code === 'RATE_LIMITED') return '操作过于频繁，请稍后重试';
    return error.error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
