/** Owns OFFSCREEN_SAVE delivery into Chrome Downloads and deferred local delivery. */
import { awaitDownloadSettled, downloadFile } from '../../platform/chrome/downloads';
import { broadcastToPopup } from '../../shared/messages';
import { debugPerf, nowMs, roundMs } from '../../shared/perf';
import type { RecordingArtifactKind, RecordingStream } from '../../shared/recording';
import {
  awaitsLocalDelivery,
  recordingHistoryFileId,
  type RecordingHistoryFile,
} from '../../shared/recordingHistory';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';
import type { OffscreenManager } from '../offscreen/OffscreenManager';

/**
 * What actually happened to one artifact. Reported rather than swallowed,
 * because the caller stamps "saved to <folder>" onto the recording and that
 * claim must not outrun a download that failed, stalled, or never began.
 */
export type DeliveryOutcome =
  | { status: 'complete'; downloadId?: number }
  | { status: 'interrupted'; downloadId?: number }
  | { status: 'timeout'; downloadId?: number }
  | { status: 'not-started'; error: string };

/**
 * Wires the offscreen OFFSCREEN_SAVE callback, triggering a background-side
 * download and broadcasting the outcome to the popup.
 */
export function registerSaveHandler(
  offscreen: OffscreenManager,
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void },
  history?: Pick<RecordingHistoryService, 'createPending' | 'localSaveSettled' | 'setDuration' | 'recordArtifactLocation'>,
  /** Recorded duration of the run that produced this artifact, for the history row. */
  runDurationMs?: (historyId: string) => number | undefined,
  /** How many download sub-folders the user has defined; zero means never ask. */
  localFolderCount: () => Promise<number> = async () => 0,
  /** Called when a delivery starts waiting on a folder prompt. */
  onDeliveryDeferred: () => void = () => {},
) {
  /**
   * Writes one artifact to the download directory and reconciles history with
   * what actually happened. Shared by the immediate path and by a delivery the
   * user deferred while choosing a folder, so the settle and cleanup rules
   * cannot drift apart between them.
   */
  const deliver = async (
    args: {
      historyId: string; stream: RecordingStream; kind?: RecordingArtifactKind;
      filename: string; blobUrl: string; retainedKey?: string; opfsFilename?: string;
      /** Prefixed onto the filename, creating a sub-folder of the download directory. */
      folder?: string;
    },
  ): Promise<DeliveryOutcome> => {
    const { historyId, stream, kind, blobUrl, retainedKey, opfsFilename } = args;
    const resolvedFilename = args.folder ? `${args.folder}/${args.filename}` : args.filename;
    const downloadStartedAt = nowMs();
    let downloadId: number | undefined;
    try {
      downloadId = await downloadFile({ url: blobUrl, filename: resolvedFilename, saveAs: false });
      debugPerf(L.log, 'finalizer', 'download_started', {
        filename: resolvedFilename,
        durationMs: roundMs(nowMs() - downloadStartedAt),
        stream,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugPerf(L.log, 'finalizer', 'download_failed', {
        durationMs: roundMs(nowMs() - downloadStartedAt),
        stream,
      });
      L.warn('downloads.download error:', message);
      await broadcastToPopup({ type: 'RECORDING_SAVE_ERROR', filename: resolvedFilename, error: message });
      if (historyId) {
        const update = retainedKey
          ? history?.localSaveSettled(historyId, stream, undefined, 'interrupted', message, kind, true)
          : history?.localSaveSettled(historyId, stream, undefined, 'interrupted', message, kind);
        void update?.catch((historyError) => L.warn('Recording history update failed:', historyError));
      }
      // The download never started: free the in-memory URL but keep the OPFS
      // source so crash recovery can retry it on a later launch.
      offscreen.revokeBlobUrl(blobUrl);
      return { status: 'not-started', error: message };
    }

    // Clean up only once the download has *actually* settled. Event-driven, so a
    // suspended worker can't drop the cleanup the way the old blind 10s timer
    // could — which would leak a correctly-saved file into OPFS forever. The
    // OPFS source is deleted ONLY on confirmed completion; an interrupted (or
    // never-settling) download keeps it so crash recovery can reclaim it.
    const settled = downloadId != null ? await awaitDownloadSettled(downloadId) : 'timeout';
    if (historyId) {
      const retryable = settled === 'interrupted' && Boolean(retainedKey);
      const update = retryable
        ? history?.localSaveSettled(historyId, stream, downloadId, settled, undefined, kind, true)
        : history?.localSaveSettled(historyId, stream, downloadId, settled, undefined, kind);
      void update?.catch((historyError) => L.warn('Recording history update failed:', historyError));
    }
    if (settled === 'complete') {
      await broadcastToPopup({ type: 'RECORDING_SAVED', filename: resolvedFilename });
      // A retained artifact was promoted out of staging before delivery, so
      // the extension owns these bytes now: free the object URL and keep the
      // file. Without one, the pre-ADR-0006 rule still applies — the staging
      // source is temporary and a confirmed download is what retires it.
      offscreen.revokeBlobUrl(blobUrl, retainedKey ? undefined : opfsFilename);
    } else if (settled === 'interrupted') {
      offscreen.revokeBlobUrl(blobUrl);
      await broadcastToPopup({
        type: 'RECORDING_SAVE_ERROR',
        filename: resolvedFilename,
        error: 'Download interrupted',
      });
    }
    // 'timeout': the download may still be writing — leave both the URL and the
    // OPFS file untouched; recovery reclaims the file later if it was saved.
    return { status: settled, ...(downloadId != null ? { downloadId } : {}) };
  };

  offscreen.onSaveRequested = ({ historyId, stream, kind, retainedKey, filename, startOffsetMs, blobUrl, opfsFilename, deferDelivery }) => {
    const resolvedFilename =
      typeof filename === 'string' && filename.trim()
        ? filename
        : `google-meet-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? 'T' : ''))}-recording.webm`;

    if (!blobUrl) return;

    L.log('Saving OFFSCREEN_SAVE via blobUrl', resolvedFilename);
    void (async () => {

      if (historyId) {
        // Establish the row before Chrome can settle the download. Otherwise a
        // fast download can report its terminal status first, be ignored because
        // no row exists yet, then leave a newly-created row stuck at `pending`.
        try {
          // The sidecar rides a media stream, so a stream-keyed id would collide
          // with that stream's media row — and `createPending` skips a known id,
          // which silently dropped the media file from history entirely.
          const fileId = recordingHistoryFileId(historyId, stream, kind);
          await history?.createPending(
            historyId,
            [{ id: fileId, stream, ...(kind ? { kind } : {}), filename: resolvedFilename, ...(startOffsetMs != null ? { captureStartOffsetMs: startOffsetMs } : {}) }],
            'local',
          );
          // Once the row exists, stamp the run's duration onto it. The session
          // still holds it here: OFFSCREEN_SAVE is dispatched from the finalize
          // path before the offscreen reports `idle`.
          await history?.setDuration(historyId, runDurationMs?.(historyId));
          // Persist the retained copy before the download is even attempted, so
          // a failed delivery still leaves a playable recording (ADR-0006).
          if (retainedKey) {
            await history?.recordArtifactLocation(historyId, fileId, {
              kind: 'opfs',
              key: retainedKey,
              retainedAt: Date.now(),
            });
          }
        } catch (error) {
          L.warn('Recording history initialization failed:', error);
        }
      }

      // Deferred: the bytes are recorded in the library above, so the download
      // can wait for the folder the user is about to pick. Nothing is lost if
      // they never answer — the entry has a retained copy and no download
      // replica, which is exactly what the startup reconciler looks for.
      // Two conditions, both about not asking a question that cannot be
      // answered. There must be folders to choose between — a user who never
      // made one is not interrupted — and a popup must be open to be asked in,
      // or the recording would sit in the library awaiting a prompt that is
      // never coming. Either way it is written straight away, as it was before
      // folders existed.
      if (deferDelivery && retainedKey && historyId && (await localFolderCount()) > 0) {
        const asked = await broadcastToPopup({ type: 'RECORDING_AWAITING_DELIVERY', historyId });
        if (asked) {
          offscreen.revokeBlobUrl(blobUrl);
          onDeliveryDeferred();
          return;
        }
      }

      await deliver({ historyId, stream, kind, filename: resolvedFilename, blobUrl, retainedKey, opfsFilename });
    })();
  };

  /**
   * Writes a recording whose delivery was deferred, into an optional sub-folder
   * of the download directory.
   *
   * "Deferred" is not tracked separately: it is any media file that has retained
   * library bytes and no download replica yet. Deriving it from history rather
   * than a parallel list is what makes this survive a worker eviction, a browser
   * restart, and a prompt nobody ever answered.
   */
  const deliverDeferred = async (
    entry: { id: string; files: readonly RecordingHistoryFile[] },
    folder?: string,
  ): Promise<DeliveryOutcome[]> => {
    const outcomes: DeliveryOutcome[] = [];
    for (const file of entry.files) {
      if (!awaitsLocalDelivery(file)) continue;
      const retained = file.locations.find((location) => location.kind === 'opfs');
      if (!retained) continue;
      let blobUrl: string | undefined;
      try {
        blobUrl = await offscreen.openRetained(retained.key);
      } catch (error) {
        const message = `Recording runtime unavailable: ${error instanceof Error ? error.message : String(error)}`;
        L.warn('Deferred delivery could not open retained bytes:', message);
        outcomes.push({ status: 'not-started', error: message });
        continue;
      }
      if (!blobUrl) {
        L.warn('Deferred delivery skipped: retained bytes are gone', retained.key);
        const error = 'Retained recording bytes are unavailable';
        await history?.localSaveSettled(
          entry.id,
          file.stream,
          undefined,
          'interrupted',
          error,
          file.kind,
        ).catch((historyError) => L.warn('Recording history update failed:', historyError));
        outcomes.push({ status: 'not-started', error });
        continue;
      }
      outcomes.push(await deliver({
        historyId: entry.id,
        stream: file.stream,
        ...(file.kind ? { kind: file.kind } : {}),
        filename: file.filename,
        blobUrl,
        retainedKey: retained.key,
        ...(folder ? { folder } : {}),
      }));
    }
    return outcomes;
  };

  return { deliverDeferred };
}
