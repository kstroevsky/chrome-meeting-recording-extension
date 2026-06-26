/**
 * @file background/sessionLifecycle.ts
 *
 * Manages the service-worker keep-alive loop and perf diagnostics clearing
 * that are driven by recording session phase transitions.
 */

import { pokeRuntime } from '../platform/chrome/runtime';
import { awaitDownloadSettled, downloadFile } from '../platform/chrome/downloads';
import { isBusyPhase, type RecordingPhase } from '../shared/recording';
import { broadcastToPopup } from '../shared/messages';
import type { OffscreenManager } from './OffscreenManager';
import { debugPerf, nowMs, roundMs } from '../shared/perf';

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
      const downloadStartedAt = nowMs();
      let downloadId: number | undefined;

      try {
        downloadId = await downloadFile({ url: blobUrl, filename: resolvedFilename, saveAs: false });
        debugPerf(L.log, 'finalizer', 'download_complete', {
          filename: resolvedFilename,
          durationMs: roundMs(nowMs() - downloadStartedAt),
          stream: resolvedFilename.endsWith('-mic.webm')
            ? 'mic'
            : resolvedFilename.endsWith('-self-video.webm')
              ? 'self-video'
              : 'tab',
        });
        await broadcastToPopup({ type: 'RECORDING_SAVED', filename: resolvedFilename });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        L.warn('downloads.download error:', message);
        await broadcastToPopup({ type: 'RECORDING_SAVE_ERROR', filename: resolvedFilename, error: message });
        // The download never started: free the in-memory URL but keep the OPFS
        // source so crash recovery can retry it on a later launch.
        offscreen.revokeBlobUrl(blobUrl);
        return;
      }

      // Clean up only once the download has *actually* settled. Event-driven, so a
      // suspended worker can't drop the cleanup the way the old blind 10s timer
      // could — which would leak a correctly-saved file into OPFS forever. The
      // OPFS source is deleted ONLY on confirmed completion; an interrupted (or
      // never-settling) download keeps it so crash recovery can reclaim it.
      const settled = downloadId != null ? await awaitDownloadSettled(downloadId) : 'timeout';
      if (settled === 'complete') {
        offscreen.revokeBlobUrl(blobUrl, opfsFilename);
      } else if (settled === 'interrupted') {
        offscreen.revokeBlobUrl(blobUrl);
      }
      // 'timeout': the download may still be writing — leave both the URL and the
      // OPFS file untouched; recovery reclaims the file later if it was saved.
    })();
  };
}

/**
 * True when a phase transition begins a fresh recording, so the previous run's
 * diagnostics should be reset. Clearing at start — rather than on idle — lets a
 * finished run's diagnostics survive until the next recording begins, so the
 * debug dashboard can be opened and exported after the fact even if it was never
 * open during the run.
 */
export function isFreshRecordingStart(previousPhase: RecordingPhase, nextPhase: RecordingPhase): boolean {
  return !isBusyPhase(previousPhase) && isBusyPhase(nextPhase);
}
