import { act, fireEvent, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrivacyPage,
  PRIVACY_POLL,
  describeMedia,
  formatExportBytes,
} from './PrivacyPage';
import * as privacyApi from '../../api/privacy';
import * as authApi from '../../api/auth';
import { ApiError } from '../../api/client';
import { demoMe, renderWithAuth } from '../../test/render-with-auth';

vi.mock('../../api/auth');
vi.mock('../../api/privacy', () => ({
  exportPrivacy: vi.fn(),
  exportStatus: vi.fn(),
  exportDownloadZip: vi.fn(),
  deactivate: vi.fn(),
}));

/** P14 t5：zip 单包下载结果（blob 直存 + Content-Disposition 文件名）。 */
const zipBlob = new Blob(['PK\x03\x04zip-bytes'], { type: 'application/zip' });

beforeEach(() => {
  vi.mocked(privacyApi.exportPrivacy).mockReset().mockResolvedValue({ jobId: 'job_export_1' });
  vi.mocked(privacyApi.exportStatus)
    .mockReset()
    .mockResolvedValue({ jobId: 'job_export_1', status: 'succeeded', result: { tool: 'export-teacher-data' } });
  vi.mocked(privacyApi.exportDownloadZip).mockReset().mockResolvedValue({
    blob: zipBlob,
    filename: 'export-demo-teacher.zip',
  });
  vi.mocked(privacyApi.deactivate).mockReset().mockResolvedValue({ jobId: 'job_d1', status: 'succeeded' });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPage() {
  return renderWithAuth(<PrivacyPage teacherId="demo-teacher" />, { meValue: demoMe });
}

function fillDeactivateForm(email = 'demo@example.com', password = 'secret-pass', confirm = email) {
  fireEvent.change(screen.getByLabelText('注册邮箱'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('再次输入注册邮箱确认'), { target: { value: confirm } });
}

/** 导出成功路径需要的浏览器下载桩（jsdom 未实现 createObjectURL）。 */
function stubDownload() {
  const createUrlSpy = vi.fn(() => 'blob:mock-url');
  const revokeUrlSpy = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL: createUrlSpy, revokeObjectURL: revokeUrlSpy });
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  return { createUrlSpy, revokeUrlSpy, clickSpy };
}

describe('PrivacyPage（/settings/privacy，P9 接线 + P14 t5 zip 单包：导出 jobId 轮询下载 zip + 注销双验证）', () => {
  it('渲染三大区块：我的数据 / 数据导出 / 账号注销（含后果说明与安全红线文案）', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: '隐私与数据' })).toBeInTheDocument();
    expect(screen.getByText('我的数据')).toBeInTheDocument();
    expect(screen.getByText('数据导出（导出权）')).toBeInTheDocument();
    expect(screen.getByText('账号注销（删除权 · 高风险）')).toBeInTheDocument();
    expect(screen.getByText(/不含密码哈希与会话令牌/)).toBeInTheDocument();
    expect(screen.getByText(/真实删除由服务端执行/)).toBeInTheDocument();
    expect(screen.getByText(/前端永不直接删除/)).toBeInTheDocument();
    // zip 单包文案出现在「我的数据」说明与导出指引两处
    expect(screen.getAllByText(/zip 单包/).length).toBeGreaterThanOrEqual(2);
  });

  it('P14 t5 zip 导出全流程：POST {format:"zip"} → 202 jobId → 轮询 → download zip blob → 浏览器下载 export-<id>.zip', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(privacyApi.exportStatus)
      .mockResolvedValueOnce({ jobId: 'job_export_1', status: 'running' })
      .mockResolvedValueOnce({ jobId: 'job_export_1', status: 'succeeded', result: { tool: 'export-teacher-data' } });
    const { createUrlSpy, revokeUrlSpy, clickSpy } = stubDownload();

    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    // 初始渲染完成后再启用假定时器（避免 RTL waitFor 与假定时器互锁）
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));

    // 首轮轮询（running）→ 进入 interval 等待
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    // 推进等待 → 次轮 succeeded → 下载 + 成功提示
    await act(async () => { await vi.advanceTimersByTimeAsync(PRIVACY_POLL.intervalMs); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('zip 单包'));
    expect(privacyApi.exportPrivacy).toHaveBeenCalledTimes(1);
    expect(privacyApi.exportPrivacy).toHaveBeenCalledWith({ format: 'zip' });
    expect(privacyApi.exportStatus).toHaveBeenNthCalledWith(1, 'job_export_1');
    expect(privacyApi.exportStatus).toHaveBeenNthCalledWith(2, 'job_export_1');
    expect(privacyApi.exportDownloadZip).toHaveBeenCalledWith('job_export_1');
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    expect(createUrlSpy).toHaveBeenCalledWith(zipBlob);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeUrlSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/导出完成，已下载 export-demo-teacher\.zip/)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('P14 t5：download 无 Content-Disposition 文件名 → 兜底 export-<teacherId>.zip 仍触发下载', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(privacyApi.exportDownloadZip).mockResolvedValue({ blob: zipBlob, filename: null });
    const { createUrlSpy } = stubDownload();

    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));

    expect(await screen.findByText(/导出完成，已下载 export-demo-teacher\.zip/)).toBeInTheDocument();
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('导出进行中：按钮禁用且文案为「导出中…」，pending 状态提示可见', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    // 任务一直不进入终态：轮询保持 running，导出按钮应持续禁用
    vi.mocked(privacyApi.exportStatus).mockResolvedValue({ jobId: 'job_export_1', status: 'running' });

    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    vi.useFakeTimers();
    const button = screen.getByRole('button', { name: '导出我的数据' });
    fireEvent.click(button);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(screen.getByRole('button', { name: '导出中…' })).toBeDisabled();
    expect(screen.getByText('正在生成导出包，请稍候…')).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  it('P14 t7：轮询偏久（media 段多）→ 提示「媒体文件较多，导出可能需要更久」；下载完成提示消失', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { createUrlSpy } = stubDownload();
    // 前 4 次轮询 running（每 2s 一次），第 5 次 succeeded（含媒体统计）
    vi.mocked(privacyApi.exportStatus)
      .mockResolvedValueOnce({ jobId: 'job_export_1', status: 'running' })
      .mockResolvedValueOnce({ jobId: 'job_export_1', status: 'running' })
      .mockResolvedValueOnce({ jobId: 'job_export_1', status: 'running' })
      .mockResolvedValueOnce({ jobId: 'job_export_1', status: 'running' })
      .mockResolvedValueOnce({
        jobId: 'job_export_1',
        status: 'succeeded',
        result: { tool: 'export-teacher-data', mediaFiles: 2, mediaBytes: 2048 },
      });

    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
    // attempt 0：elapsed 2s < 8s → 常规 pending 文案
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('正在生成导出包，请稍候…')).toBeInTheDocument();

    // attempt 1/2（elapsed 4s/6s）：仍未超阈值，无大文件提示
    for (let i = 0; i < 2; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(PRIVACY_POLL.intervalMs); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    }
    expect(screen.queryByText(/媒体文件较多，导出可能需要更久/)).not.toBeInTheDocument();

    // attempt 3（elapsed 8s ≥ slowHintAfterMs）：出现大文件提示
    await act(async () => { await vi.advanceTimersByTimeAsync(PRIVACY_POLL.intervalMs); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(/媒体文件较多，导出可能需要更久/)).toBeInTheDocument();

    // attempt 4 → succeeded → 下载 zip + 媒体统计摘要；大文件提示消失
    await act(async () => { await vi.advanceTimersByTimeAsync(PRIVACY_POLL.intervalMs); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText(/媒体文件较多，导出可能需要更久/)).not.toBeInTheDocument();
    expect(screen.getByText(/导出完成，已下载 export-demo-teacher\.zip（含 2 个媒体文件，共 2 KB）。/)).toBeInTheDocument();
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('P14 t7：下载完成后「知道了」→ 清理态（完成提示收起，按钮回到可再次导出）', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    stubDownload();
    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
    expect(await screen.findByText(/导出完成，已下载 export-demo-teacher\.zip/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '知道了' }));

    expect(screen.queryByText(/导出完成，已下载/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导出我的数据' })).toBeEnabled();
    // 清理态后可再次发起导出（confirm 再次询问），全流程再次走通
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/导出完成，已下载 export-demo-teacher\.zip/)).toBeInTheDocument();
    confirmSpy.mockRestore();
  });

  describe('P14 t7：导出完成摘要（formatExportBytes / describeMedia）', () => {
    it('formatExportBytes：<1MB 用 KB（最小 1），≥1MB 用 MB 保留 1 位，非法输入为空', () => {
      expect(formatExportBytes(45)).toBe('1 KB');
      expect(formatExportBytes(2048)).toBe('2 KB');
      expect(formatExportBytes(5 * 1024 * 1024)).toBe('5.0 MB');
      expect(formatExportBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
      expect(formatExportBytes(-1)).toBe('');
      expect(formatExportBytes(Number.NaN)).toBe('');
    });

    it('describeMedia：mediaFiles>0 带数量/体积；无 media 段返回空串', () => {
      expect(describeMedia({ mediaFiles: 3, mediaBytes: 5 * 1024 * 1024 })).toBe('（含 3 个媒体文件，共 5.0 MB）');
      expect(describeMedia({ mediaFiles: 1, mediaBytes: 45 })).toBe('（含 1 个媒体文件，共 1 KB）');
      expect(describeMedia({ mediaFiles: 0, mediaBytes: 0 })).toBe('');
      expect(describeMedia(undefined)).toBe('');
      expect(describeMedia({})).toBe('');
    });
  });

  it('导出轮询中卸载组件：停止轮询、不触发下载、不更新已卸载页面', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { createUrlSpy } = stubDownload();
    vi.mocked(privacyApi.exportStatus).mockResolvedValue({ jobId: 'job_export_1', status: 'running' });

    const view = renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const pollsBeforeUnmount = vi.mocked(privacyApi.exportStatus).mock.calls.length;
    expect(pollsBeforeUnmount).toBe(1);

    // 卸载（导航离开/组件销毁）→ cancelledRef 置位，轮询应停止
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(PRIVACY_POLL.intervalMs * 3); });

    expect(vi.mocked(privacyApi.exportStatus).mock.calls.length).toBe(pollsBeforeUnmount);
    expect(privacyApi.exportDownloadZip).not.toHaveBeenCalled();
    expect(createUrlSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('导出失败：轮询终态 failed → 展示失败提示且不下载', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(privacyApi.exportStatus).mockResolvedValue({
      jobId: 'job_export_1',
      status: 'failed',
      error: '后台任务退出码 1：stderr: boom',
    });
    const { createUrlSpy } = stubDownload();

    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));

    expect(await screen.findByText(/导出失败：后台任务退出码 1/)).toBeInTheDocument();
    expect(privacyApi.exportDownloadZip).not.toHaveBeenCalled();
    expect(createUrlSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('导出 429 限流：export 被拒 → 提示操作过于频繁', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(privacyApi.exportPrivacy).mockRejectedValue(
      new ApiError({ code: 'RATE_LIMITED', message: '操作过于频繁，请稍后重试', field: 'rate' }, 429),
    );

    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });
    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));

    expect(await screen.findByText('导出失败：操作过于频繁，请稍后重试')).toBeInTheDocument();
    expect(privacyApi.exportStatus).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('注销成功：邮箱+密码+confirm 提交 → 调后端 API（无 teacherId 字段）→ 成功提示 + logout', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    fillDeactivateForm();
    fireEvent.click(screen.getByRole('button', { name: '申请注销账号' }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('永久删除'));
    expect(privacyApi.deactivate).toHaveBeenCalledWith({
      email: 'demo@example.com',
      password: 'secret-pass',
      confirm: 'demo@example.com',
    });
    expect(await screen.findByText('账号已注销，即将退出…')).toBeInTheDocument();
    expect(vi.mocked(authApi.logout)).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('注销 400：邮箱/密码/confirm 后端拒绝 → 展示对应错误，不调用 logout', async () => {
    const cases: Array<{ field: string; message: string }> = [
      { field: 'email', message: '邮箱与当前账号不匹配' },
      { field: 'password', message: '邮箱或密码错误' },
      { field: 'confirm', message: '二次确认不匹配（需输入邮箱或确认短语）' },
    ];
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    for (const item of cases) {
      vi.mocked(privacyApi.deactivate).mockRejectedValueOnce(
        new ApiError({ code: 'VALIDATION_ERROR', message: item.message, field: item.field }, 400),
      );
      const view = renderPage();
      await screen.findByRole('heading', { name: '隐私与数据' });
      fillDeactivateForm();
      fireEvent.click(screen.getByRole('button', { name: '申请注销账号' }));

      expect(await screen.findByText(item.message)).toBeInTheDocument();
      expect(vi.mocked(authApi.logout)).not.toHaveBeenCalled();
      view.unmount();
    }
    confirmSpy.mockRestore();
  });

  it('注销 429 限流：RATE_LIMITED → 提示操作过于频繁，不调用 logout', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(privacyApi.deactivate).mockRejectedValue(
      new ApiError({ code: 'RATE_LIMITED', message: '操作过于频繁，请稍后重试', field: 'rate' }, 429),
    );
    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    fillDeactivateForm();
    fireEvent.click(screen.getByRole('button', { name: '申请注销账号' }));

    expect(await screen.findByText('操作过于频繁，请稍后重试')).toBeInTheDocument();
    expect(vi.mocked(authApi.logout)).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('本地校验：空字段 / 邮箱与当前账号不一致 / confirm 与邮箱不一致 → 本地拦截，不调 API', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    // 空字段（required 原生校验在 jsdom 中拦截点击提交，用 fireEvent.submit 直连表单校验分支）
    const form = document.querySelector('form')!;
    fireEvent.submit(form);
    expect(screen.getByText('请输入注册邮箱。')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    // 邮箱与当前登录账号不一致
    fillDeactivateForm('other@example.com', 'secret-pass', 'other@example.com');
    fireEvent.click(screen.getByRole('button', { name: '申请注销账号' }));
    expect(screen.getByText('邮箱与当前登录账号不一致，请核对后重试。')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    // confirm 与邮箱不一致
    fillDeactivateForm('demo@example.com', 'secret-pass', 'demo@example.org');
    fireEvent.click(screen.getByRole('button', { name: '申请注销账号' }));
    expect(screen.getByText('二次确认的邮箱与注册邮箱不一致，请核对后重试。')).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    expect(privacyApi.deactivate).not.toHaveBeenCalled();
    expect(vi.mocked(authApi.logout)).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('安全红线：导出/注销只经 api 封装调后端（owner 由后端 session 保证），页面不直接 fetch、无本地删除', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    stubDownload();
    renderPage();
    await screen.findByRole('heading', { name: '隐私与数据' });

    fireEvent.click(screen.getByRole('button', { name: '导出我的数据' }));
    expect(await screen.findByText(/导出完成，已下载 export-demo-teacher\.zip/)).toBeInTheDocument();

    fillDeactivateForm();
    fireEvent.click(screen.getByRole('button', { name: '申请注销账号' }));
    expect(await screen.findByText('账号已注销，即将退出…')).toBeInTheDocument();

    // 页面不直接发网络请求（下载走 api 封装 exportDownloadZip）；删除动作完全由后端 deactivate API 承担
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(privacyApi.exportPrivacy).toHaveBeenCalledTimes(1);
    expect(privacyApi.exportDownloadZip).toHaveBeenCalledTimes(1);
    expect(privacyApi.deactivate).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});
