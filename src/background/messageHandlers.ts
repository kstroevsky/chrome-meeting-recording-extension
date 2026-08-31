/**
 * @file background/messageHandlers.ts
 *
 * Registers the chrome.runtime.onMessage listener and dispatches incoming
 * popup commands to their dedicated handlers.
 */

import { fetchDriveTokenWithFallback } from './driveAuth';
import { isE2EMockDriveBuild } from '../shared/build';
import { handleMeetingEndedMessage } from './recordingAutoStop';
import {
  isE2EDriveFetchMessage,
  isMeetingEndedMessage,
  isPerfEventMessage,
  isPopupToBgMessage,
  type CommandResult,
} from '../shared/protocol';
import { toStatusView } from '../shared/recording';
import { type PerfEventEntry } from '../shared/perf';
import type { RecordingController } from './RecordingController';
import type { RecordingSession } from './RecordingSession';
import type { PerfDebugStore } from './PerfDebugStore';
import type { CpuSampler } from './perf/CpuSampler';
import type { RecordingHistoryService } from './RecordingHistoryService';
import type { TelemetryRuntime } from './TelemetryRuntime';
import { isRecordingHistoryMessage } from '../shared/recordingHistory';
import { isRecordingNotationMessage } from '../shared/notations';
import {
  NON_SESSION_RESPONSE_MESSAGE_TYPES,
  RECORDING_HISTORY_MESSAGE_TYPES,
  RECORDING_NOTATION_MESSAGE_TYPES,
} from '../shared/protocolMessageTypes';
import type { RecordingNotationService } from './RecordingNotationService';

const includes = (types: readonly string[], type: string) => types.includes(type);

/** True when a failure must answer `{ ok: false, error }` instead of failing the session. */
function isNonSessionResponse(type: string): boolean {
  return includes(NON_SESSION_RESPONSE_MESSAGE_TYPES, type);
}

export type MessageHandlersDeps = {
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  session: RecordingSession;
  perfDebugStore: PerfDebugStore;
  controller: RecordingController;
  /** Dev-only system CPU sampler; null in production (no `system.cpu` permission). */
  cpuSampler?: CpuSampler | null;
  history?: RecordingHistoryService;
  notations?: RecordingNotationService;
  telemetry?: TelemetryRuntime;
};

/**
 * Registers the chrome.runtime.onMessage listener that dispatches popup
 * commands to PERF_EVENT, GET_DRIVE_TOKEN, START_RECORDING, STOP_RECORDING,
 * and GET_RECORDING_STATUS handlers.
 */
export function registerMessageHandlers({ L, session, perfDebugStore, controller, cpuSampler, history, notations, telemetry }: MessageHandlersDeps) {
  chrome.runtime.onMessage.addListener((
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    if (msg && typeof msg === 'object' && (msg as any).type === 'TELEMETRY_SNAPSHOT') {
      void telemetry?.receive((msg as any).snapshot, (msg as any).critical === true).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (msg && typeof msg === 'object' && (msg as any).type === 'TELEMETRY_FLUSH') {
      void telemetry?.receiveFlush((msg as any).snapshot, (msg as any).reason).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (
      (typeof __E2E_MOCK_DRIVE_BUILD__ !== 'undefined'
        ? __E2E_MOCK_DRIVE_BUILD__
        : isE2EMockDriveBuild())
      && isE2EDriveFetchMessage(msg)
    ) {
      if (!msg.url.startsWith('https://www.googleapis.com/')) {
        sendResponse({ ok: false, error: 'E2E Drive bridge rejected non-Google URL' });
        return false;
      }
      fetch(msg.url, {
        method: msg.method,
        headers: msg.headers,
        body: msg.body,
      })
        .then(async (response) => {
          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            headers[name] = value;
          });
          sendResponse({
            ok: true,
            status: response.status,
            statusText: response.statusText,
            headers,
            body: await response.text(),
          });
        })
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    }

    if (isPerfEventMessage(msg)) {
      const entry = msg.entry as PerfEventEntry;
      perfDebugStore.record(entry);
      // Piggyback a system-CPU read on each runtime sample (dev builds only).
      // chrome.system.cpu lives in the background context, so we sample here on
      // the existing per-sample wake rather than running a separate SW timer.
      if (cpuSampler && entry.scope === 'runtime' && entry.event === 'sample') {
        void cpuSampler.sample().then((cpuPercent) => {
          if (cpuPercent != null) {
            perfDebugStore.record({
              source: entry.source,
              scope: 'runtime',
              event: 'cpu',
              ts: Date.now(),
              fields: { cpuPercent },
            });
          }
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    if (isMeetingEndedMessage(msg)) {
      handleMeetingEndedMessage(msg, sender, { session, controller })
        .then((res) => sendResponse(res))
        .catch((e: any) => sendResponse({ ok: false, stopped: false, error: e?.message || String(e) }));
      return true;
    }

    if (!isPopupToBgMessage(msg)) return false;

    if (msg.type === 'GET_DRIVE_TOKEN') {
      fetchDriveTokenWithFallback({ refresh: msg.refresh === true })
        .then((res) => {
          if (!res.ok) L.warn('GET_DRIVE_TOKEN failed:', res.error);
          sendResponse(res);
        })
        .catch((e: any) => {
          const error = e?.message || String(e);
          L.error('GET_DRIVE_TOKEN unexpected failure:', error);
          sendResponse({ ok: false, error });
        });
      return true;
    }

    const send = sendResponse as (r: CommandResult) => void;

    (async () => {
      if (includes(RECORDING_HISTORY_MESSAGE_TYPES, msg.type) && !isRecordingHistoryMessage(msg)) {
        throw new Error('Malformed recording history request');
      }
      if (includes(RECORDING_NOTATION_MESSAGE_TYPES, msg.type) && !isRecordingNotationMessage(msg)) {
        throw new Error('Malformed recording notation request');
      }
      if (msg.type === 'LIST_RECORDING_HISTORY') {
        if (!history) throw new Error('Recording history is unavailable');
        sendResponse({ ok: true, ...(await history.listPage(msg.cursor)) }); return;
      }
      if (msg.type === 'RENAME_RECORDING_HISTORY') {
        if (!history) throw new Error('Recording history is unavailable');
        const entry = await history.rename(msg.id, msg.name);
        let renamedSnapshot = session.getSnapshot();
        const job = renamedSnapshot.uploadJobs?.find((candidate) => candidate.historyId === msg.id);
        if (entry && job) {
          renamedSnapshot = session.upsertUploadJob({
            ...job,
            label: entry.name,
            namingStatus: 'named',
            driveFolderId: entry.driveFolderId ?? job.driveFolderId,
            driveFolderName: entry.driveFolderName ?? job.driveFolderName,
            folderWebViewLink: entry.folderWebViewLink ?? job.folderWebViewLink,
            files: job.files.map((file) => {
              const renamed = entry.files.find((candidate) => candidate.stream === file.stream);
              return renamed ? { ...file, filename: renamed.filename } : file;
            }),
          });
          await session.flush();
        }
        sendResponse({ ok: true, entry, session: toStatusView(renamedSnapshot) }); return;
      }
      if (msg.type === 'SET_RECORDING_HISTORY_NOTE') {
        if (!history) throw new Error('Recording history is unavailable');
        sendResponse({ ok: true, entry: await history.setNote(msg.id, msg.note) }); return;
      }
      if (msg.type === 'REMOVE_RECORDING_HISTORY') {
        if (!history) throw new Error('Recording history is unavailable');
        sendResponse({ ok: true, removed: await history.remove(msg.id) }); return;
      }
      if (msg.type === 'OPEN_RECORDING_HISTORY_FILE') {
        if (!history) throw new Error('Recording history is unavailable');
        await history.openLocalFile(msg.recordingId, msg.fileId);
        sendResponse({ ok: true }); return;
      }

      // Notation commands (ADR-0005). The two live ones go through the
      // controller, which owns the recording clock; the rest are plain CRUD on
      // a finished recording.
      if (msg.type === 'MARK_NOTATION') {
        sendResponse(await controller.markNotation(msg.text)); return;
      }
      if (msg.type === 'END_NOTATION') {
        sendResponse(await controller.endNotation(msg.id)); return;
      }
      if (msg.type === 'LIST_ACTIVE_NOTATIONS') {
        if (!notations) throw new Error('Recording notations are unavailable');
        const { historyId } = session.getSnapshot();
        sendResponse({ ok: true, notations: historyId ? await notations.list(historyId) : [] }); return;
      }
      if (msg.type === 'LIST_RECORDING_NOTATION_SUMMARIES') {
        if (!notations) throw new Error('Recording notations are unavailable');
        sendResponse({ ok: true, summaries: await notations.summaries(msg.recordingIds) }); return;
      }
      if (msg.type === 'UPDATE_ACTIVE_NOTATION' || msg.type === 'REMOVE_ACTIVE_NOTATION') {
        if (!notations) throw new Error('Recording notations are unavailable');
        const { historyId } = session.getSnapshot();
        if (!historyId) throw new Error('No recording is active');
        sendResponse({
          ok: true,
          notations: msg.type === 'UPDATE_ACTIVE_NOTATION'
            ? await notations.update(historyId, msg.id, { text: msg.text })
            : await notations.remove(historyId, msg.id),
        });
        return;
      }
      if (msg.type === 'LIST_RECORDING_NOTATIONS') {
        if (!notations) throw new Error('Recording notations are unavailable');
        sendResponse({ ok: true, notations: await notations.list(msg.recordingId) }); return;
      }
      if (msg.type === 'ADD_RECORDING_NOTATION') {
        if (!notations) throw new Error('Recording notations are unavailable');
        const notation = await notations.add(msg.recordingId, {
          tStartMs: msg.tStartMs,
          ...(msg.tEndMs != null ? { tEndMs: msg.tEndMs } : {}),
          text: msg.text,
        });
        sendResponse({ ok: true, notation }); return;
      }
      if (msg.type === 'UPDATE_RECORDING_NOTATION') {
        if (!notations) throw new Error('Recording notations are unavailable');
        sendResponse({ ok: true, notations: await notations.update(msg.recordingId, msg.id, msg) }); return;
      }
      if (msg.type === 'REMOVE_RECORDING_NOTATION') {
        if (!notations) throw new Error('Recording notations are unavailable');
        sendResponse({ ok: true, notations: await notations.remove(msg.recordingId, msg.id) }); return;
      }
      if (msg.type === 'START_RECORDING')    { send(await controller.start(msg)); return; }
      if (msg.type === 'STOP_RECORDING')     { send(await controller.stop('popup stop button')); return; }
      if (msg.type === 'DISCARD_RECORDING')  { send(await controller.discard('popup discard button')); return; }
      if (msg.type === 'SET_MIC_MUTED')      { send(await controller.setMicMuted(msg.muted)); return; }
      if (msg.type === 'SET_CAMERA_MUTED')   { send(await controller.setCameraMuted(msg.muted)); return; }
      if (msg.type === 'SET_INPUT_DEVICE')   { send(await controller.setInputDevice(msg.device, msg.deviceId)); return; }
      if (msg.type === 'SET_PAUSED')         { send(await controller.setPaused(msg.paused)); return; }
      if (msg.type === 'GET_RECORDING_STATUS') { sendResponse({ session: toStatusView(session.getSnapshot()) }); return; }
      if (msg.type === 'DISMISS_UPLOAD_JOB')   { sendResponse({ session: toStatusView(session.removeUploadJob(msg.jobId)) }); return; }
      if (msg.type === 'RETRY_UPLOAD_JOB')     { send(await controller.retryUpload(msg.jobId)); return; }
      if (msg.type === 'CANCEL_UPLOAD_JOB')    { send(await controller.cancelUpload(msg.jobId)); return; }
      if (msg.type === 'SKIP_RECORDING_NAMING') {
        const job = session.getSnapshot().uploadJobs?.find((candidate) => candidate.id === msg.jobId);
        if (!job || job.status !== 'completed') { send({ ok: false, error: 'Completed upload was not found', session: toStatusView(session.getSnapshot()) }); return; }
        const skippedSnapshot = session.upsertUploadJob({ ...job, namingStatus: 'skipped' });
        await session.flush();
        send({ ok: true, session: toStatusView(skippedSnapshot) }); return;
      }
    })().catch((err) => {
      console.error('[background] top-level error', err);
      const error = String(err);
      if (isPopupToBgMessage(msg) && isNonSessionResponse(msg.type)) {
        sendResponse({ ok: false, error });
      } else {
        session.fail(error);
        sendResponse({ ok: false, error, session: toStatusView(session.getSnapshot()) } satisfies CommandResult);
      }
    });

    return true;
  });
}
