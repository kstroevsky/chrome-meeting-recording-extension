import { setSessionStorageValuesStrict } from '../../platform/chrome/storage';

/**
 * The startup pass normally runs once per browser session. Explicit retained
 * media release is a new crash boundary inside that session, so invalidate the
 * marker before its durable history mutation. If the worker dies before bytes
 * are removed, the next worker startup runs reconciliation again.
 */
export const RETAINED_MEDIA_RECONCILED_KEY = 'retainedMediaReconciled';

export async function requireRetainedMediaRecovery(): Promise<void> {
  await setSessionStorageValuesStrict({ [RETAINED_MEDIA_RECONCILED_KEY]: false });
}
