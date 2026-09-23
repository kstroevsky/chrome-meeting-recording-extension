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
  OffscreenFinalizationCommandResult,
  OffscreenPhaseUpdate,
  RpcResponse,
} from '../shared/protocol';
import type { RecorderEngine } from './RecorderEngine';
import { describeRuntimeError } from './errors';
import { removeByKey } from './storage/opfsLayout';
import type { DriveRenameResource } from './drive/DriveMetadataRenamer';
import type { OffscreenFinalizationState } from './OffscreenController';

export type RpcHandlerDeps = {
  engine: RecorderEngine;
  getPort: () => chrome.runtime.Port;
  connectPort: () => chrome.runtime.Port;
  currentPhase: () => RecordingPhase;
  currentEpoch: () => number;
  isFinalizing: () => boolean;
  currentFinalization: () => OffscreenFinalizationState | null;
  onStartRequested: (runConfig: RecordingRunConfig, storageMode: 'local' | 'drive', epoch: number, historyId: string, telemetryRunId?: string) => void;
  onStopRequested: (sidecars?: { notes?: { vtt: string }; transcript?: { vtt: string } }, driveRootFolderName?: string) => Promise<void> | void;
  onDiscardRequested: () => Promise<void>;
  /** Re-uploads a failed/partial background upload job; false when not retryable (ADR-0004). */
  retryUpload: (jobId: string) => boolean | Promise<boolean>;
  /** Reads retained library bytes back so a deferred delivery can be written. */
  openRetained?: (key: string) => Promise<File | null>;
  /** Lists what a crash left in OPFS, for the popup to offer (8D). */
  listUnsaved?: () => Promise<import('./storage/recoverOrphanRecordings').UnsavedRecording[]>;
  /** Saves one of those under a name, or throws it away (8D). */
  resolveUnsaved?: (key: string, action: 'save' | 'discard', name?: string, storageMode?: 'local' | 'drive') => Promise<void>;
  /** Cancels an active/queued upload and starts local fallback downloads. */
  cancelUpload: (jobId: string) => boolean;
  acknowledgeUploadState: (jobId: string) => Promise<void>;
  /** Queues topic analysis for a recording; returns the new job's id (HOST-01). */
  analyzeTranscript?: (
    historyId: string,
    transcript: import('../shared/transcript').TranscriptSegment[],
    config: import('../shared/analysis/types').AnalysisConfig,
    provenance: import('../shared/analysis/provenance').AnalysisProvenance,
  ) => string;
  /** Ids of every job still making the data plane busy, held results included. */
  listAnalysisWork?: () => string[];
  /** Aborts a queued/running analysis; false when it is no longer active. */
  cancelAnalysis?: (jobId: string) => boolean;
  /** Releases a completed analysis the background has now persisted (HOST-03). */
  acknowledgeAnalysisState?: (jobId: string) => Promise<void>;
  renameDriveResources?: (resources: DriveRenameResource[]) => Promise<DriveRenameResource[]>;
  publishShare?: (
    recordings: import('../sharing/PublishedManifestBuilder').PublishedRecordingInput[],
    options: import('../sharing/PublishedManifestBuilder').PublishRecordingOptions,
  ) => Promise<string>;
  shareSnapshot?: () => Promise<import('../sharing/ShareRuntime').ShareRuntimeSnapshot>;
  revokeShare?: (shareId: string) => Promise<void>;
  deleteShare?: (shareId: string) => Promise<void>;
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
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_STOP' }>,
  deps: RpcHandlerDeps
): Promise<OffscreenFinalizationCommandResult> {
  const reconciled = reconcileFinalizationCommand(msg.epoch, 'kept', deps);
  if (reconciled) return reconciled;
  if (!deps.engine.isRecording()) {
    return { ok: false, error: 'Stop requested but recorder is not active' };
  }
  deps.pushState('stopping');
  void deps.onStopRequested({
    ...(msg.notesSidecar ? { notes: msg.notesSidecar } : {}),
    ...(msg.transcriptSidecar ? { transcript: msg.transcriptSidecar } : {}),
  }, msg.driveRootFolderName);
  return { ok: true };
}

async function handleOffscreenDiscard(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_DISCARD' }>,
  deps: RpcHandlerDeps
): Promise<OffscreenFinalizationCommandResult> {
  const reconciled = reconcileFinalizationCommand(msg.epoch, 'discarded', deps);
  if (reconciled) return reconciled;
  if (!deps.engine.isRecording()) {
    return { ok: false, error: 'Discard requested but recorder is not active' };
  }
  deps.pushState('stopping');
  await deps.onDiscardRequested();
  return { ok: true };
}

function reconcileFinalizationCommand(
  epoch: number,
  disposition: 'kept' | 'discarded',
  deps: Pick<RpcHandlerDeps, 'currentEpoch' | 'currentFinalization'>,
): OffscreenFinalizationCommandResult | null {
  const currentEpoch = deps.currentEpoch();
  if (!Number.isInteger(epoch) || epoch !== currentEpoch) {
    return {
      ok: false,
      error: `Stale finalization command for epoch ${String(epoch)}; current epoch is ${currentEpoch}`,
    };
  }

  const current = deps.currentFinalization();
  if (!current || current.epoch !== epoch) return null;
  if (current.disposition !== disposition) {
    return {
      ok: false,
      error: `Finalization conflict for epoch ${epoch}: ${current.disposition} is already ${current.status}`,
      finalizationDisposition: current.disposition,
    };
  }
  if (current.status === 'running' || current.status === 'completed') return { ok: true };
  return {
    ok: false,
    error: current.error || `Finalization for epoch ${epoch} already failed`,
  };
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

async function handleOffscreenListUnsaved(
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; recordings?: import('./storage/recoverOrphanRecordings').UnsavedRecording[] }> {
  return { ok: true, recordings: (await deps.listUnsaved?.()) ?? [] };
}

async function handleOffscreenResolveUnsaved(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_RESOLVE_UNSAVED' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (typeof msg.key !== 'string' || !msg.key) return { ok: false, error: 'Missing key' };
  if (msg.action !== 'save' && msg.action !== 'discard') return { ok: false, error: 'Unknown action' };
  if (!deps.resolveUnsaved) return { ok: false, error: 'Recovery is unavailable' };
  try {
    await deps.resolveUnsaved(msg.key, msg.action, msg.name, msg.storageMode);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function handleOffscreenRetryUpload(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_RETRY_UPLOAD' }>,
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (typeof msg.jobId !== 'string') return { ok: false, error: 'Missing jobId' };
  const retried = await deps.retryUpload(msg.jobId);
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

async function handleOffscreenAnalyzeTranscript(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_ANALYZE_TRANSCRIPT' }>,
  deps: RpcHandlerDeps,
): Promise<{ ok: boolean; jobId?: string; error?: string }> {
  if (!deps.analyzeTranscript) return { ok: false, error: 'Topic analysis is unavailable' };
  if (typeof msg.historyId !== 'string' || !msg.historyId) return { ok: false, error: 'Missing historyId' };
  if (!Array.isArray(msg.transcript)) return { ok: false, error: 'Missing transcript' };
  if (!msg.config || typeof msg.config !== 'object') return { ok: false, error: 'Missing analysis configuration' };
  // Refused rather than defaulted: a run without its enqueue-time provenance
  // would come back unable to say what produced it.
  if (!msg.provenance || typeof msg.provenance !== 'object') return { ok: false, error: 'Missing analysis provenance' };
  try {
    return { ok: true, jobId: deps.analyzeTranscript(msg.historyId, msg.transcript, msg.config, msg.provenance) };
  } catch (error) {
    // A rejected config (an out-of-range window, say) is a caller error, not a
    // session failure: answer it rather than throwing into the RPC server.
    return { ok: false, error: describeRuntimeError(error) };
  }
}

async function handleOffscreenListAnalysisWork(
  deps: RpcHandlerDeps,
): Promise<{ ok: boolean; jobIds?: string[]; error?: string }> {
  // A runtime with no analysis manager has no analysis work, which is an
  // answer rather than an error: the caller is deciding whether it may reload.
  return { ok: true, jobIds: deps.listAnalysisWork?.() ?? [] };
}

async function handleOffscreenCancelAnalysis(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_CANCEL_ANALYSIS' }>,
  deps: RpcHandlerDeps,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof msg.jobId !== 'string') return { ok: false, error: 'Missing jobId' };
  const canceled = deps.cancelAnalysis?.(msg.jobId) ?? false;
  return canceled ? { ok: true } : { ok: false, error: 'Analysis is no longer active' };
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

async function handleAcknowledgeAnalysisState(
  msg: Extract<BgToOffscreenOneWay, { type: 'OFFSCREEN_ACK_ANALYSIS_STATE' }>,
  deps: RpcHandlerDeps,
): Promise<void> {
  if (typeof msg.jobId === 'string' && msg.jobId) await deps.acknowledgeAnalysisState?.(msg.jobId);
}

async function handleSharePublish(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_SHARE_PUBLISH' }>,
  deps: RpcHandlerDeps,
): Promise<{ ok: true; shareId: string } | { ok: false; error: string }> {
  if (!deps.publishShare) return { ok: false, error: 'Sharing is not configured for this build' };
  try {
    return { ok: true, shareId: await deps.publishShare(msg.recordings, msg.options) };
  } catch (error) {
    return { ok: false, error: describeRuntimeError(error) };
  }
}

async function handleShareSnapshot(
  deps: RpcHandlerDeps,
): Promise<{ ok: true; snapshot: import('../sharing/ShareRuntime').ShareRuntimeSnapshot } | { ok: false; error: string }> {
  if (!deps.shareSnapshot) return { ok: false, error: 'Sharing is not configured for this build' };
  try {
    return { ok: true, snapshot: await deps.shareSnapshot() };
  } catch (error) {
    return { ok: false, error: describeRuntimeError(error) };
  }
}

async function handleShareRevoke(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_SHARE_REVOKE' }>,
  deps: RpcHandlerDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!deps.revokeShare) return { ok: false, error: 'Sharing is not configured for this build' };
  try {
    await deps.revokeShare(msg.shareId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeRuntimeError(error) };
  }
}

async function handleShareDelete(
  msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_SHARE_DELETE' }>,
  deps: RpcHandlerDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!deps.deleteShare) return { ok: false, error: 'Permanent published-data deletion is not configured' };
  try {
    await deps.deleteShare(msg.shareId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeRuntimeError(error) };
  }
}

/** Registers RPC and one-way port handlers for background -> offscreen commands. */
export function wirePortHandlers(port: chrome.runtime.Port, deps: RpcHandlerDeps) {
  createPortRpcServer(
    port,
    {
      OFFSCREEN_START:   (msg) => handleOffscreenStart(msg, deps),
      OFFSCREEN_STOP:    (msg) => handleOffscreenStop(msg, deps),
      OFFSCREEN_DISCARD: (msg) => handleOffscreenDiscard(msg, deps),
      OFFSCREEN_SET_MIC_MUTED: (msg) => handleOffscreenSetMicMuted(msg, deps),
      OFFSCREEN_SET_CAMERA_MUTED: (msg) => handleOffscreenSetCameraMuted(msg, deps),
      OFFSCREEN_SET_INPUT_DEVICE: (msg) => handleOffscreenSetInputDevice(msg, deps),
      OFFSCREEN_SET_PAUSED: (msg) => handleOffscreenSetPaused(msg, deps),
      OFFSCREEN_OPEN_RETAINED: (msg) => handleOffscreenOpenRetained(msg, deps),
      OFFSCREEN_LIST_UNSAVED: () => handleOffscreenListUnsaved(deps),
      OFFSCREEN_RESOLVE_UNSAVED: (msg) => handleOffscreenResolveUnsaved(msg, deps),
      OFFSCREEN_RETRY_UPLOAD: (msg) => handleOffscreenRetryUpload(msg, deps),
      OFFSCREEN_CANCEL_UPLOAD: (msg) => handleOffscreenCancelUpload(msg, deps),
      OFFSCREEN_RENAME_DRIVE_RESOURCES: (msg) => handleOffscreenRenameDriveResources(msg, deps),
      REVOKE_BLOB_URL:   (msg) => handleRevokeBlobUrl(msg, deps),
      OFFSCREEN_ACK_UPLOAD_STATE: (msg) => handleAcknowledgeUploadState(msg, deps),
      OFFSCREEN_ANALYZE_TRANSCRIPT: (msg) => handleOffscreenAnalyzeTranscript(msg, deps),
      OFFSCREEN_CANCEL_ANALYSIS: (msg) => handleOffscreenCancelAnalysis(msg, deps),
      OFFSCREEN_SHARE_PUBLISH: (msg) => handleSharePublish(msg, deps),
      OFFSCREEN_SHARE_SNAPSHOT: () => handleShareSnapshot(deps),
      OFFSCREEN_SHARE_REVOKE: (msg) => handleShareRevoke(msg, deps),
      OFFSCREEN_SHARE_DELETE: (msg) => handleShareDelete(msg, deps),
      OFFSCREEN_LIST_ANALYSIS_WORK: () => handleOffscreenListAnalysisWork(deps),
      OFFSCREEN_ACK_ANALYSIS_STATE: (msg) => handleAcknowledgeAnalysisState(msg, deps),
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
