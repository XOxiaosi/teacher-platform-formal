import { useState } from 'react';
import type { PreviewActions } from './PreviewApp';

/** Session-only UI context. Business records remain in DemoData. */
export function usePreviewState<T>(actions: PreviewActions, key: string, initial: T) {
  const [value, setValue] = useState<T>(() => actions.ui && key in actions.ui ? actions.ui[key] as T : initial);
  const update = (next: T) => {
    setValue(next);
    actions.setUi?.((old) => ({ ...old, [key]: next }));
  };
  return [value, update] as const;
}
