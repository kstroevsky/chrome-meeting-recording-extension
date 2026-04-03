/**
 * @file background/messageHandlers.ts
 *
 * Registers the chrome.runtime.onMessage listener and dispatches incoming
 * popup commands to their dedicated handlers.
 */

import { fetchDriveTokenWithFallback } from './driveAuth';
import { isPerfEventMessage, isPopupToBgMessage, type CommandResult } from '../shared/protocol';
import { type PerfEventEntry } from '../shared/perf';
import type { OffscreenManager } from './OffscreenManager';
import type { RecordingSession } from './RecordingSession';
import type { PerfDebugStore } from './PerfDebugStore';
import { handleStartRecording } from './commands/handleStartRecording';
import { handleStopRecording } from './commands/handleStopRecording';

export type MessageHandlersDeps = {
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  offscreen: OffscreenManager;
  session: RecordingSession;
  perfDebugStore: PerfDebugStore;
};

/**
 * Registers the chrome.runtime.onMessage listener that dispatches popup
 * commands to PERF_EVENT, GET_DRIVE_TOKEN, START_RECORDING, STOP_RECORDING,
 * and GET_RECORDING_STATUS handlers.
 */
export function registerMessageHandlers({ L, offscreen, session, perfDebugStore }: MessageHandlersDeps) {
  chrome.runtime.onMessage.addListener((
    msg: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    if (isPerfEventMessage(msg)) {
      perfDebugStore.record(msg.entry as PerfEventEntry);
      sendResponse({ ok: true });
      return false;
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

    const deps = { L, offscreen, session, perfDebugStore };
    const send = sendResponse as (r: CommandResult) => void;

    (async () => {
      if (msg.type === 'START_RECORDING')    return handleStartRecording(msg, deps, send);
      if (msg.type === 'STOP_RECORDING')     return handleStopRecording(deps, send);
      if (msg.type === 'GET_RECORDING_STATUS') { sendResponse({ session: session.getSnapshot() }); return; }
    })().catch((err) => {
      console.error('[background] top-level error', err);
      session.fail(String(err));
      sendResponse({ ok: false, error: String(err), session: session.getSnapshot() } satisfies CommandResult);
    });

    return true;
  });
}
