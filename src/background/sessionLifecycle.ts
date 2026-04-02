/**
 * @file background/sessionLifecycle.ts
 *
 * Manages the service-worker keep-alive loop and perf diagnostics clearing
 * that are driven by recording session phase transitions.
 */

import { pokeRuntime } from '../platform/chrome/runtime';
import { downloadFile } from '../platform/chrome/downloads';
import { isBusyPhase } from '../shared/recording';
import { broadcastToPopup } from '../shared/messages';
import type { RecordingSession } from './RecordingSession';
import type { PerfDebugStore } from './PerfDebugStore';
import type { OffscreenManager } from './OffscreenManager';

export type SessionLifecycleDeps = {
  session: RecordingSession;
  perfDebugStore: PerfDebugStore;
  isSessionHydrated: () => boolean;
  getActiveDebugDashboards: () => number;
};

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** Keeps the MV3 service worker alive while recording or upload work is active. */
export function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => pokeRuntime(), 20_000);
}

/** Stops the keep-alive loop once no busy work remains. */
export function stopKeepAlive() {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/**
 * Wires the offscreen OFFSCREEN_SAVE callback, triggering a background-side
 * download and broadcasting the outcome to the popup.
 */
export function registerSaveHandler(
  offscreen: OffscreenManager,
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void }
) {
  offscreen.onSaveRequested = ({ filename, blobUrl, opfsFilename }) => {
    const resolvedFilename =
      typeof filename === 'string' && filename.trim()
        ? filename
        : `google-meet-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? 'T' : ''))}-recording.webm`;

    if (!blobUrl) return;

    L.log('Saving OFFSCREEN_SAVE via blobUrl', resolvedFilename);
    void (async () => {
      let cleanupOpfsFilename: string | undefined;

      try {
        await downloadFile({ url: blobUrl, filename: resolvedFilename, saveAs: false });
        cleanupOpfsFilename = opfsFilename;
        await broadcastToPopup({ type: 'RECORDING_SAVED', filename: resolvedFilename });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        L.warn('downloads.download error:', message);
        await broadcastToPopup({ type: 'RECORDING_SAVE_ERROR', filename: resolvedFilename, error: message });
      } finally {
        setTimeout(() => {
          offscreen.revokeBlobUrl(blobUrl, cleanupOpfsFilename);
        }, 10_000);
      }
    })();
  };
}

/**
 * Clears stored diagnostics only when the session is idle and no debug dashboard
 * is open. Called after phase changes and after initial hydration.
 */
export function maybeClearPerfDiagnostics(deps: SessionLifecycleDeps) {
  if (!deps.isSessionHydrated()) return;
  if (deps.getActiveDebugDashboards() > 0) return;
  if (isBusyPhase(deps.session.getSnapshot().phase)) return;
  deps.perfDebugStore.clear();
}
