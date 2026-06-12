/**
 * @file e2eRecoveryBridge.ts
 *
 * E2E-ONLY test bridge. The mock e2e harness hosts the recorder in a tab
 * (`offscreen.html?runtime=tab`) that lacks `chrome.storage`, so crash recovery
 * cannot run there. This exposes the recovery entry points on `window` from a
 * page that DOES have `chrome.storage` + OPFS (the settings/control page), so a
 * Playwright test can drive them against real OPFS, real `chrome.storage`
 * markers, real `webm-duration-fix`, and the Drive simulator.
 *
 * Installed only in e2e builds and dynamically imported (see settings.ts), so it
 * never ships in production bundles.
 */

import { createChromePendingUploadStore } from '../../../src/offscreen/drive/PendingUploadStore';
import { resumePendingDriveUploadsWithChrome } from '../../../src/offscreen/drive/resumePendingUploads';
import { recoverOrphanRecordingsWithChrome } from '../../../src/offscreen/storage/recoverOrphanRecordings';

export function installRecoveryTestBridge(): void {
  const store = createChromePendingUploadStore();
  const log = (...a: any[]) => console.log('[recovery]', ...a);
  const warn = (...a: any[]) => console.warn('[recovery]', ...a);

  (globalThis as any).__recoveryTest = {
    /** #1 — resume interrupted Drive uploads (the simulator ignores the token). */
    resumeUploads: () =>
      resumePendingDriveUploadsWithChrome({
        store,
        getDriveToken: async () => 'e2e-recovery-token',
        log,
        warn,
      }),
    /** #2 — recover orphaned recordings, delivering via chrome.downloads. */
    recoverOrphans: (cutoffMs: number) =>
      recoverOrphanRecordingsWithChrome({
        cutoffMs,
        pendingUploads: store,
        requestSave: (filename: string, blobUrl: string) => {
          // Record the recovery output (the assertable signal) and trigger a
          // real download so the end-to-end path is exercised.
          ((globalThis as any).__recoverySaves ??= []).push(filename);
          void chrome.downloads.download({ url: blobUrl, filename });
        },
        log,
        warn,
      }),
  };
}
