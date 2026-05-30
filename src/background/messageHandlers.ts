/**
 * @file background/messageHandlers.ts
 *
 * Registers the chrome.runtime.onMessage listener and dispatches incoming
 * popup commands to their dedicated handlers.
 */

import { fetchDriveTokenWithFallback } from './driveAuth';
import { handleMeetingEndedMessage } from './recordingAutoStop';
import { isMeetingEndedMessage, isPerfEventMessage, isPopupToBgMessage, type CommandResult } from '../shared/protocol';
import { toStatusView } from '../shared/recording';
import { type PerfEventEntry } from '../shared/perf';
import type { RecordingController } from './RecordingController';
import type { RecordingSession } from './RecordingSession';
import type { PerfDebugStore } from './PerfDebugStore';

export type MessageHandlersDeps = {
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  session: RecordingSession;
  perfDebugStore: PerfDebugStore;
  controller: RecordingController;
};

/**
 * Registers the chrome.runtime.onMessage listener that dispatches popup
 * commands to PERF_EVENT, GET_DRIVE_TOKEN, START_RECORDING, STOP_RECORDING,
 * and GET_RECORDING_STATUS handlers.
 */
export function registerMessageHandlers({ L, session, perfDebugStore, controller }: MessageHandlersDeps) {
  chrome.runtime.onMessage.addListener((
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ) => {
    if (isPerfEventMessage(msg)) {
      perfDebugStore.record(msg.entry as PerfEventEntry);
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
      if (msg.type === 'GET_RECORDING_STATUS') { sendResponse({ session: toStatusView(session.getSnapshot()) }); return; }
    })().catch((err) => {
      console.error('[background] top-level error', err);
      session.fail(String(err));
      sendResponse({ ok: false, error: String(err), session: toStatusView(session.getSnapshot()) } satisfies CommandResult);
    });

    return true;
  });
}
