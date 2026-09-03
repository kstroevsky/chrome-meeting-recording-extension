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
import type { RecordingHistoryService } from './RecordingHistoryService';

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
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void },
  history?: Pick<RecordingHistoryService, 'createPending' | 'localSaveSettled' | 'setDuration'>,
  /** Recorded duration of the run that produced this artifact, for the history row. */
  runDurationMs?: (historyId: string) => number | undefined,
) {
  offscreen.onSaveRequested = ({ historyId, stream, kind, filename, blobUrl, opfsFilename }) => {
    const resolvedFilename =
      typeof filename === 'string' && filename.trim()
        ? filename
        : `google-meet-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? 'T' : ''))}-recording.webm`;

    if (!blobUrl) return;

    L.log('Saving OFFSCREEN_SAVE via blobUrl', resolvedFilename);
    void (async () => {
      const downloadStartedAt = nowMs();
      let downloadId: number | undefined;

      if (historyId) {
        // Establish the row before Chrome can settle the download. Otherwise a
        // fast download can report its terminal status first, be ignored because
        // no row exists yet, then leave a newly-created row stuck at `pending`.
        try {
          // The sidecar rides a media stream, so a stream-keyed id would collide
          // with that stream's media row — and `createPending` skips a known id,
          // which silently dropped the media file from history entirely.
          const fileId = kind === 'notes' ? `${historyId}:notes` : `${historyId}:${stream}`;
          await history?.createPending(
            historyId,
            [{ id: fileId, stream, ...(kind ? { kind } : {}), filename: resolvedFilename }],
            'local',
          );
          // Once the row exists, stamp the run's duration onto it. The session
          // still holds it here: OFFSCREEN_SAVE is dispatched from the finalize
          // path before the offscreen reports `idle`.
          await history?.setDuration(historyId, runDurationMs?.(historyId));
        } catch (error) {
          L.warn('Recording history initialization failed:', error);
        }
      }

      try {
        downloadId = await downloadFile({ url: blobUrl, filename: resolvedFilename, saveAs: false });
        debugPerf(L.log, 'finalizer', 'download_complete', {
          filename: resolvedFilename,
          durationMs: roundMs(nowMs() - downloadStartedAt),
          stream: /-mic\.(?:webm|m4a)$/.test(resolvedFilename)
            ? 'mic'
            : /-self-video\.(?:webm|mp4)$/.test(resolvedFilename)
              ? 'self-video'
              : 'tab',
        });
        await broadcastToPopup({ type: 'RECORDING_SAVED', filename: resolvedFilename });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        debugPerf(L.log, 'finalizer', 'download_failed', {
          durationMs: roundMs(nowMs() - downloadStartedAt),
          stream,
        });
        L.warn('downloads.download error:', message);
        await broadcastToPopup({ type: 'RECORDING_SAVE_ERROR', filename: resolvedFilename, error: message });
        if (historyId) void history?.localSaveSettled(historyId, stream, undefined, 'interrupted', message, kind)
          .catch((historyError) => L.warn('Recording history update failed:', historyError));
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
      if (historyId) void history?.localSaveSettled(historyId, stream, downloadId, settled, undefined, kind)
        .catch((historyError) => L.warn('Recording history update failed:', historyError));
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
