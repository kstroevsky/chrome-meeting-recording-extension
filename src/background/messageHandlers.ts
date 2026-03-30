/**
 * @file background/messageHandlers.ts
 *
 * Handles incoming popup-to-background Chrome runtime messages.
 * Routes START_RECORDING, STOP_RECORDING, GET_RECORDING_STATUS, and
 * GET_DRIVE_TOKEN commands to their respective handlers.
 */

import { fetchDriveTokenWithFallback } from './driveAuth';
import { downloadFile } from '../platform/chrome/downloads';
import { getCapturedTabs, getMediaStreamIdForTab } from '../platform/chrome/tabs';
import { broadcastToPopup } from '../shared/messages';
import {
  buildRecorderRuntimeSettingsSnapshot,
  loadExtensionSettingsFromStorage,
} from '../shared/extensionSettings';
import { isPerfEventMessage, isPopupToBgMessage, type CommandResult } from '../shared/protocol';
import { type PerfEventEntry } from '../shared/perf';
import { isBusyPhase, normalizeRunConfig } from '../shared/recording';
import type { OffscreenManager } from './OffscreenManager';
import type { RecordingSession } from './RecordingSession';
import type { PerfDebugStore } from './PerfDebugStore';

export type MessageHandlersDeps = {
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void; error: (...a: any[]) => void };
  offscreen: OffscreenManager;
  session: RecordingSession;
  perfDebugStore: PerfDebugStore;
};

/** Builds a success command result from the latest canonical session snapshot. */
export function successResult(session: RecordingSession): CommandResult {
  return { ok: true, session: session.getSnapshot() };
}

/** Builds a failure command result while preserving the latest canonical session snapshot. */
export function failureResult(error: string, session: RecordingSession): CommandResult {
  return { ok: false, error, session: session.getSnapshot() };
}

/** Checks for an existing tab capture that would conflict with a new recording start. */
async function findTabCaptureConflict(
  tabId: number,
  L: MessageHandlersDeps['L']
): Promise<chrome.tabCapture.CaptureInfo | null> {
  try {
    const captures = await getCapturedTabs();
    return captures.find(
      (capture) => capture.tabId === tabId && capture.status !== 'stopped' && capture.status !== 'error'
    ) ?? null;
  } catch (error) {
    L.warn('tabCapture.getCapturedTabs preflight failed; continuing without conflict check', error);
    return null;
  }
}

/**
 * Registers the chrome.runtime.onMessage listener that dispatches popup commands.
 * Handles PERF_EVENT, GET_DRIVE_TOKEN, START_RECORDING, STOP_RECORDING, and
 * GET_RECORDING_STATUS messages.
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

    if (!isPopupToBgMessage(msg)) {
      return false;
    }

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

    (async () => {
      if (msg.type === 'START_RECORDING') {
        if (typeof msg.tabId !== 'number') {
          sendResponse(failureResult('Missing tabId', session));
          return;
        }

        const runConfig = normalizeRunConfig(msg.runConfig);
        if (!runConfig) {
          sendResponse(failureResult('Missing or invalid run configuration', session));
          return;
        }

        const captureConflict = await findTabCaptureConflict(msg.tabId, L);
        if (captureConflict) {
          sendResponse(
            failureResult(
              `This tab already has an active tab capture (${captureConflict.status}). Stop the existing capture and try again.`,
              session
            )
          );
          return;
        }

        let recorderSettings: ReturnType<typeof buildRecorderRuntimeSettingsSnapshot>;
        try {
          const extensionSettings = await loadExtensionSettingsFromStorage();
          recorderSettings = buildRecorderRuntimeSettingsSnapshot(extensionSettings);
        } catch (e: any) {
          const error = `Failed to load recorder settings: ${e?.message || e}`;
          L.error(error);
          sendResponse(failureResult(error, session));
          return;
        }

        session.start(runConfig);
        L.log('Popup requested START_RECORDING for tabId', msg.tabId);

        try {
          await offscreen.ensureReady();
          L.log('ensureReady() completed');
        } catch (e: any) {
          session.fail(`Offscreen not ready: ${e?.message || e}`);
          sendResponse(failureResult(`Offscreen not ready: ${e?.message || e}`, session));
          return;
        }

        try {
          const streamId = await getMediaStreamIdForTab(msg.tabId);
          const r = await offscreen.rpc<{ ok: boolean; error?: string }>({
            type: 'OFFSCREEN_START',
            streamId,
            runConfig,
            recorderSettings,
          });

          L.log('rpc(OFFSCREEN_START) response', r);
          if (r?.ok) {
            sendResponse(successResult(session));
          } else {
            session.fail(r?.error || 'Failed to start');
            sendResponse(failureResult(r?.error || 'Failed to start', session));
          }
        } catch (e: any) {
          L.error('OFFSCREEN_START failed', e);
          session.fail(`OFFSCREEN_START failed: ${e?.message || e}`);
          sendResponse(failureResult(`OFFSCREEN_START failed: ${e?.message || e}`, session));
        }
        return;
      }

      if (msg.type === 'STOP_RECORDING') {
        const snapshot = session.getSnapshot();
        if (!isBusyPhase(snapshot.phase)) {
          sendResponse(failureResult('Stop requested but no recording session is active', session));
          return;
        }
        session.markStopping();

        try {
          await offscreen.ensureReady();
          const r = await offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_STOP' });
          if (!r?.ok) {
            session.fail(r?.error || 'Stop failed in offscreen');
            sendResponse(failureResult(r?.error || 'Stop failed in offscreen', session));
            return;
          }
          sendResponse(successResult(session));
        } catch (e: any) {
          session.fail(`STOP failed: ${e?.message || e}`);
          sendResponse(failureResult(`STOP failed: ${e?.message || e}`, session));
        }
        return;
      }

      if (msg.type === 'GET_RECORDING_STATUS') {
        sendResponse({ session: session.getSnapshot() });
        return;
      }
    })().catch((err) => {
      console.error('[background] top-level error', err);
      session.fail(String(err));
      sendResponse(failureResult(String(err), session));
    });

    return true;
  });
}

/**
 * Registers the offscreen OFFSCREEN_SAVE handler on the offscreen manager.
 * Triggers a background-side download and broadcasts the outcome to the popup.
 */
export function registerSaveHandler(
  offscreen: OffscreenManager,
  L: MessageHandlersDeps['L']
) {
  offscreen.onSaveRequested = ({ filename, blobUrl, opfsFilename }) => {
    const resolvedFilename =
      typeof filename === 'string' && filename.trim()
        ? filename
        : `google-meet-recording-${Date.now()}.webm`;

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
