import { fetchDriveTokenWithFallback } from '../drive/driveAuth';
import { handleMeetingEndedMessage } from '../recording/recordingAutoStop';
import { isE2EMockDriveBuild } from '../../shared/build';
import type { PerfEventEntry } from '../../shared/perf';
import {
  isE2EDriveFetchMessage,
  isMeetingEndedMessage,
  isPerfEventMessage,
  isTranscriptCaptureStateRequest,
  isTranscriptUtterancesMessage,
  type PopupToBg,
} from '../../shared/protocol';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

export function handleSystemIngress(
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): boolean | undefined {
  const {
    L,
    controller,
    cpuSampler,
    perfDebugStore,
    session,
    telemetry,
    transcriptCapture,
  } = deps;

  if (
    (typeof __E2E_MOCK_CAPTURE_BUILD__ !== 'undefined' && __E2E_MOCK_CAPTURE_BUILD__)
    && msg && typeof msg === 'object' && (msg as any).type === 'E2E_GET_ANALYSIS_WORK'
  ) {
    void Promise.resolve(deps.waitUntilReady?.())
      .then(() => deps.e2eAnalysisWork?.() ?? false)
      .then((active) => sendResponse({ ok: true, active }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (msg && typeof msg === 'object' && (msg as any).type === 'TELEMETRY_SNAPSHOT') {
    void telemetry?.receive((msg as any).snapshot, (msg as any).critical === true)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg && typeof msg === 'object' && (msg as any).type === 'TELEMETRY_FLUSH') {
    void telemetry?.receiveFlush((msg as any).snapshot, (msg as any).reason)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
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
      body: msg.bodyBase64 != null
        ? Uint8Array.from(atob(msg.bodyBase64), (character) => character.charCodeAt(0))
        : msg.body,
    })
      .then(async (response) => {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        sendResponse({
          ok: true,
          status: response.status,
          statusText: response.statusText,
          headers,
          bodyBase64: btoa(binary),
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
  if (isTranscriptUtterancesMessage(msg)) {
    void Promise.resolve(deps.waitUntilReady?.())
      .then(() => transcriptCapture?.receive(msg.runId, msg.utterances))
      .catch((error) => L.warn('Could not record pushed caption utterances:', error));
    return false;
  }
  if (isTranscriptCaptureStateRequest(msg)) {
    if (!deps.waitUntilReady) {
      sendResponse(transcriptCapture?.captureState() ?? { active: false });
      return false;
    }
    void deps.waitUntilReady()
      .then(() => sendResponse(transcriptCapture?.captureState() ?? { active: false }))
      .catch((error) => sendResponse({ active: false, error: String(error) }));
    return true;
  }
  if (isMeetingEndedMessage(msg)) {
    Promise.resolve(deps.waitUntilReady?.())
      .then(() => handleMeetingEndedMessage(msg, sender, { session, controller }))
      .then((result) => sendResponse(result))
      .catch((error: any) => sendResponse({
        ok: false,
        stopped: false,
        error: error?.message || String(error),
      }));
    return true;
  }
  return undefined;
}

export function handleDriveTokenMessage(
  msg: PopupToBg,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): boolean | undefined {
  if (msg.type !== 'GET_DRIVE_TOKEN') return undefined;
  fetchDriveTokenWithFallback({ refresh: msg.refresh === true })
    .then((result) => {
      if (!result.ok) deps.L.warn('GET_DRIVE_TOKEN failed:', result.error);
      sendResponse(result);
    })
    .catch((error: any) => {
      const message = error?.message || String(error);
      deps.L.error('GET_DRIVE_TOKEN unexpected failure:', message);
      sendResponse({ ok: false, error: message });
    });
  return true;
}

export async function handleSystemPopupMessage(
  msg: PopupToBg,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): Promise<boolean> {
  if (msg.type === 'PUBLISH_SHARE') {
    if (!deps.sharing) throw new Error('Sharing is unavailable');
    const result = await deps.sharing.publish(msg.recordings, msg.options);
    sendResponse({ ok: true, shareId: result.shareId });
    return true;
  }
  if (msg.type === 'LIST_SHARES') {
    if (!deps.sharing) throw new Error('Sharing is unavailable');
    sendResponse({ ok: true, snapshot: await deps.sharing.snapshot() });
    return true;
  }
  if (msg.type === 'REVOKE_SHARE') {
    if (!deps.sharing) throw new Error('Sharing is unavailable');
    await deps.sharing.revoke(msg.shareId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'DELETE_SHARE') {
    if (!deps.sharing) throw new Error('Sharing is unavailable');
    await deps.sharing.delete(msg.shareId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'RENAME_DRIVE_ROOT_FOLDER') {
    if (!deps.renameDriveRootFolder) throw new Error('Google Drive is unavailable');
    sendResponse({
      ok: true,
      result: await deps.renameDriveRootFolder(msg.from, msg.to),
    });
    return true;
  }
  if (msg.type === 'GET_STORAGE_USAGE') {
    if (!deps.storageUsage) throw new Error('Storage usage is unavailable');
    sendResponse({ ok: true, usage: await deps.storageUsage() });
    return true;
  }
  if (msg.type === 'LIST_UNSAVED_RECORDINGS') {
    sendResponse({
      ok: true,
      recordings: (await deps.listUnsavedRecordings?.()) ?? [],
    });
    return true;
  }
  if (msg.type === 'RESOLVE_UNSAVED_RECORDING') {
    if (!deps.resolveUnsavedRecording) throw new Error('Recovery is unavailable');
    await deps.resolveUnsavedRecording(msg.key, msg.action, msg.name);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'LIST_PENDING_LOCAL_DELIVERIES') {
    sendResponse({
      ok: true,
      recordings: (await deps.listPendingLocal?.()) ?? [],
    });
    return true;
  }
  if (msg.type === 'DELIVER_LOCAL_RECORDING') {
    if (!deps.deliverLocal) throw new Error('Local delivery is unavailable');
    await deps.deliverLocal(msg.recordingId, msg.folderId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'FILE_RECORDING_TO_DESTINATION') {
    if (!deps.fileToDestination) throw new Error('Drive destinations are unavailable');
    await deps.fileToDestination(msg.recordingId, msg.presetId);
    sendResponse({ ok: true });
    return true;
  }
  return false;
}
