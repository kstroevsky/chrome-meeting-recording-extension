/**
 * @file offscreen/rpcHandlers.ts
 *
 * Wires the RPC and runtime message handlers for background -> offscreen
 * commands. Separated from offscreen.ts so the entrypoint stays focused on
 * setup, ports, and sampling.
 */

import { createPortRpcServer } from '../shared/rpc';
import { normalizeRecorderRuntimeSettingsSnapshot } from '../shared/settings';
import { isBusyPhase, parseRunConfig, type RecordingPhase, type RecordingRunConfig } from '../shared/recording';
import { isBgToOffscreenRuntimeMessage } from '../shared/protocol';
import { applyPerfSettings } from '../shared/perf';
import type {
  BgToOffscreenOneWay,
  BgToOffscreenRpc,
  BgToOffscreenRuntime,
  OffscreenPhaseUpdate,
  RpcResponse,
} from '../shared/protocol';
import type { RecorderEngine } from './RecorderEngine';
import { describeRuntimeError } from './errors';
import { removeByKey } from './storage/opfsLayout';
import type { DriveRenameResource } from './drive/DriveMetadataRenamer';

export type RpcHandlerDeps = {
  engine: RecorderEngine;
  getPort: () => chrome.runtime.Port;
  connectPort: () => chrome.runtime.Port;
  currentPhase: () => RecordingPhase;
  isFinalizing: () => boolean;
  onStartRequested: (runConfig: RecordingRunConfig, storageMode: 'local' | 'drive', epoch: number, historyId: string, telemetryRunId?: string) => void;
  onStopRequested: (notesSidecar?: { vtt: string }) => void;
  onDiscardRequested: () => Promise<void>;
  /** Re-uploads a failed/partial background upload job; false when not retryable (ADR-0004). */
  retryUpload: (jobId: string) => boolean;
  /** Reads retained library bytes back so a deferred delivery can be written. */
  openRetained?: (key: string) => Promise<File | null>;
  /** Cancels an active/queued upload and starts local fallback downloads. */
  cancelUpload: (jobId: string) => boolean;
  acknowledgeUploadState: (jobId: string) => Promise<void>;
  renameDriveResources?: (resources: DriveRenameResource[]) => Promise<DriveRenameResource[]>;
  pushState: (
    phase: RecordingPhase,
    extra?: Pick<OffscreenPhaseUpdate, 'uploadSummary' | 'error' | 'tabResolution'>
  ) => void;
  clearWarnings: () => void;
  log: (...a: any[]) => void;
  error: (...a: any[]) => void;
};

/** Sends a one-shot RPC response back through the background port. */
export function respond(getPort: () => chrome.runtime.Port, reqId: string, payload: any) {
  const msg: RpcResponse<unknown> = { __respFor: reqId, payload };
  getPort().postMessage(msg);
}

async function handleOffscreenStart(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_START' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  const streamId = msg.streamId as string | undefined;
  const meetingSlug = typeof msg.meetingSlug === 'string' ? msg.meetingSlug : '';
  const runConfig = parseRunConfig(msg.runConfig);
  const recorderSettings = normalizeRecorderRuntimeSettingsSnapshot(msg.recorderSettings);

  if (!streamId)        return { ok: false, error: 'Missing streamId' };
  if (!runConfig)       return { ok: false, error: 'Missing run configuration' };
  if (!recorderSettings) return { ok: false, error: 'Missing or invalid recorder settings snapshot' };
  const currentPhase = deps.currentPhase();
  if (isBusyPhase(currentPhase) || deps.isFinalizing()) {
    return { ok: false, error: `Recorder is busy (${currentPhase})` };
  }

  deps.clearWarnings();
  applyPerfSettings(msg.perfSettings);
  deps.onStartRequested(runConfig, runConfig.storageMode, msg.epoch, msg.historyId, msg.telemetryRunId);
  deps.pushState('starting');

  try {
    await deps.engine.startFromStreamId(streamId, runConfig, recorderSettings, meetingSlug);
    return { ok: true };
  } catch (e: any) {
    const error = `${e?.name || 'Error'}: ${e?.message || e}`;
    deps.pushState('failed', { error });
    return { ok: false, error };
  }
}

async function handleOffscreenStop(
  msg: { notesSidecar?: { vtt: string } },
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.engine.isRecording()) {
    return { ok: false, error: 'Stop requested but recorder is not active' };
  }
  deps.pushState('stopping');
  void deps.onStopRequested(msg.notesSidecar);
  return { ok: true };
}

async function handleOffscreenDiscard(
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.engine.isRecording()) {
    return { ok: false, error: 'Discard requested but recorder is not active' };
  }
  deps.pushState('stopping');
  await deps.onDiscardRequested();
  return { ok: true };
}

async function handleOffscreenSetMicMuted(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_SET_MIC_MUTED' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.engine.isRecording()) {
    return { ok: false, error: 'Mic mute requested but recorder is not active' };
  }
  deps.engine.setMicMuted(msg.muted === true);
  return { ok: true };
}

async function handleOffscreenSetCameraMuted(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_SET_CAMERA_MUTED' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.engine.isRecording()) {
    return { ok: false, error: 'Camera hide requested but recorder is not active' };
  }
  deps.engine.setCameraMuted(msg.muted === true);
  return { ok: true };
}

async function handleOffscreenSetInputDevice(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_SET_INPUT_DEVICE' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; label?: string; error?: string }> {
  if (deps.engine.getDebugState() !== 'recording') {
    return { ok: false, error: 'Input device can only be changed while recording' };
  }
  if ((msg.device !== 'microphone' && msg.device !== 'camera') || typeof msg.deviceId !== 'string' || !msg.deviceId) {
    return { ok: false, error: 'Missing or invalid input device' };
  }
  try {
    const label = await deps.engine.setInputDevice(msg.device, msg.deviceId);
    return { ok: true, label };
  } catch (error) {
    return { ok: false, error: describeRuntimeError(error) };
  }
}

async function handleOffscreenSetPaused(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_SET_PAUSED' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.engine.isRecording()) {
    return { ok: false, error: 'Pause requested but recorder is not active' };
  }
  deps.engine.setPaused(msg.paused === true);
  return { ok: true };
}

async function handleOffscreenOpenRetained(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_OPEN_RETAINED' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; blobUrl?: string; error?: string }> {
  if (typeof msg.key !== 'string' || !msg.key) return { ok: false, error: 'Missing key' };
  const file = await deps.openRetained?.(msg.key);
  if (!file) return { ok: false, error: 'Those bytes are no longer in the library' };
  return { ok: true, blobUrl: URL.createObjectURL(file) };
}

async function handleOffscreenRetryUpload(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_RETRY_UPLOAD' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (typeof msg.jobId !== 'string') return { ok: false, error: 'Missing jobId' };
  const retried = deps.retryUpload(msg.jobId);
  return retried ? { ok: true } : { ok: false, error: 'Upload is no longer retryable' };
}

async function handleOffscreenCancelUpload(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_CANCEL_UPLOAD' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (typeof msg.jobId !== 'string') return { ok: false, error: 'Missing jobId' };
  const canceled = deps.cancelUpload(msg.jobId);
  return canceled ? { ok: true } : { ok: false, error: 'Upload is no longer active' };
}

async function handleOffscreenRenameDriveResources(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_RENAME_DRIVE_RESOURCES' }>,
  deps: RpcHandlerDeps,
): Promise<{ ok: boolean; resources?: DriveRenameResource[]; error?: string; rollbackIncomplete?: boolean }> {
  if (!deps.renameDriveResources) return { ok: false, error: 'Drive rename is unavailable' };
  try {
    return { ok: true, resources: await deps.renameDriveResources(msg.resources) };
  } catch (error: any) {
    return {
      ok: false,
      error: describeRuntimeError(error),
      ...(Array.isArray(error?.currentResources) ? { resources: error.currentResources } : {}),
      ...(error?.rollbackIncomplete === true ? { rollbackIncomplete: true } : {}),
    };
  }
}

async function handleRevokeBlobUrl(
  msg: Extract<BgToOffscreenOneWay, { type: 'REVOKE_BLOB_URL' }>,
  deps: RpcHandlerDeps
): Promise<void> {
  const { blobUrl, opfsFilename } = msg;
  if (typeof blobUrl === 'string') deps.engine.revokeBlobUrl(blobUrl);

  if (typeof opfsFilename === 'string') {
    try {
      await removeByKey(await navigator.storage.getDirectory(), opfsFilename);
      deps.log('Cleaned up OPFS file', opfsFilename);
    } catch (e) {
      deps.error('Failed to cleanup OPFS file', describeRuntimeError(e));
    }
  }
}

async function handleAcknowledgeUploadState(
  msg: Extract<BgToOffscreenOneWay, { type: 'OFFSCREEN_ACK_UPLOAD_STATE' }>,
  deps: RpcHandlerDeps,
): Promise<void> {
  if (typeof msg.jobId === 'string' && msg.jobId) await deps.acknowledgeUploadState(msg.jobId);
}

/** Registers RPC and one-way port handlers for background -> offscreen commands. */
export function wirePortHandlers(port: chrome.runtime.Port, deps: RpcHandlerDeps) {
  createPortRpcServer(
    port,
    {
      OFFSCREEN_START:   (msg) => handleOffscreenStart(msg, deps),
      OFFSCREEN_STOP:    (msg) => handleOffscreenStop(msg, deps),
      OFFSCREEN_DISCARD: ()    => handleOffscreenDiscard(deps),
      OFFSCREEN_SET_MIC_MUTED: (msg) => handleOffscreenSetMicMuted(msg, deps),
      OFFSCREEN_SET_CAMERA_MUTED: (msg) => handleOffscreenSetCameraMuted(msg, deps),
      OFFSCREEN_SET_INPUT_DEVICE: (msg) => handleOffscreenSetInputDevice(msg, deps),
      OFFSCREEN_SET_PAUSED: (msg) => handleOffscreenSetPaused(msg, deps),
      OFFSCREEN_OPEN_RETAINED: (msg) => handleOffscreenOpenRetained(msg, deps),
      OFFSCREEN_RETRY_UPLOAD: (msg) => handleOffscreenRetryUpload(msg, deps),
      OFFSCREEN_CANCEL_UPLOAD: (msg) => handleOffscreenCancelUpload(msg, deps),
      OFFSCREEN_RENAME_DRIVE_RESOURCES: (msg) => handleOffscreenRenameDriveResources(msg, deps),
      REVOKE_BLOB_URL:   (msg) => handleRevokeBlobUrl(msg, deps),
      OFFSCREEN_ACK_UPLOAD_STATE: (msg) => handleAcknowledgeUploadState(msg, deps),
    },
    (reqId, payload) => respond(deps.getPort, reqId, payload),
    deps.error
  );
}

/** Registers the direct runtime message listener for the OFFSCREEN_CONNECT reconnect signal. */
export function wireRuntimeListener(
  connectPort: () => chrome.runtime.Port
) {
  chrome.runtime.onMessage.addListener((
    msg: BgToOffscreenRuntime,
    _sender: chrome.runtime.MessageSender,
    sendResponseFn: (response?: unknown) => void
  ) => {
    try {
      if (isBgToOffscreenRuntimeMessage(msg)) {
        connectPort();
        sendResponseFn({ ok: true });
        return true;
      }
    } catch (e) {
      sendResponseFn({ ok: false, error: String(e) });
    }
    return false;
  });
}
