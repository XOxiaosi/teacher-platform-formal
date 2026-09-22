import type { PreviewActions } from './PreviewApp';

/** Keep the in-memory prototype synchronous; connected writes finish only on server success. */
export function commitAction(actions: PreviewActions, work: () => void | Promise<void>, after: () => void = () => undefined): void {
  try {
    const result = work();
    if (result && typeof result.then === 'function') void result.then(after).catch((error: unknown) => actions.toast(error instanceof Error ? error.message : '保存未完成，请重试。', 'warn'));
    else after();
  } catch (error) { actions.toast(error instanceof Error ? error.message : '保存未完成，请重试。', 'warn'); }
}
