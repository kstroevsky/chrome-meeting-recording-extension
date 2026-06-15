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

export type MessageHandlersDeps = {
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  session: RecordingSession;
  perfDebugStore: PerfDebugStore;
  controller: RecordingController;
  /** Dev-only system CPU sampler; null in production (no `system.cpu` permission). */
  cpuSampler?: CpuSampler | null;
};

/**
 * Registers the chrome.runtime.onMessage listener that dispatches popup
 * commands to PERF_EVENT, GET_DRIVE_TOKEN, START_RECORDING, STOP_RECORDING,
 * and GET_RECORDING_STATUS handlers.
 */
export function registerMessageHandlers({ L, session, perfDebugStore, controller, cpuSampler }: MessageHandlersDeps) {
  chrome.runtime.onMessage.addListener((
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
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
      if (msg.type === 'START_RECORDING')    { send(await controller.start(msg)); return; }
      if (msg.type === 'STOP_RECORDING')     { send(await controller.stop('popup stop button')); return; }
      if (msg.type === 'SET_MIC_MUTED')      { send(await controller.setMicMuted(msg.muted)); return; }
      if (msg.type === 'SET_CAMERA_MUTED')   { send(await controller.setCameraMuted(msg.muted)); return; }
      if (msg.type === 'SET_PAUSED')         { send(await controller.setPaused(msg.paused)); return; }
      if (msg.type === 'GET_RECORDING_STATUS') { sendResponse({ session: toStatusView(session.getSnapshot()) }); return; }
    })().catch((err) => {
      console.error('[background] top-level error', err);
      session.fail(String(err));
      sendResponse({ ok: false, error: String(err), session: toStatusView(session.getSnapshot()) } satisfies CommandResult);
    });

    return true;
  });
}
