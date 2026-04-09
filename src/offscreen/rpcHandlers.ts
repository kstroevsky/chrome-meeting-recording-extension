/**
 * @file offscreen/rpcHandlers.ts
 *
 * Wires the RPC and runtime message handlers for background -> offscreen
 * commands. Separated from offscreen.ts so the entrypoint stays focused on
 * setup, ports, and sampling.
 */

import { createPortRpcServer } from '../shared/rpc';
import { normalizeRecorderRuntimeSettingsSnapshot } from '../shared/extensionSettings';
import { parseRunConfig, type RecordingPhase, type RecordingRunConfig } from '../shared/recording';
import { isBgToOffscreenRuntimeMessage } from '../shared/protocol';
import type {
  BgToOffscreenOneWay,
  BgToOffscreenRpc,
  BgToOffscreenRuntime,
  RpcResponse,
} from '../shared/protocol';
import type { RecorderEngine } from './RecorderEngine';
import { describeRuntimeError } from './errors';

export type RpcHandlerDeps = {
  engine: RecorderEngine;
  getPort: () => chrome.runtime.Port;
  connectPort: () => chrome.runtime.Port;
  currentPhase: () => RecordingPhase;
  isFinalizing: () => boolean;
  onStartRequested: (runConfig: RecordingRunConfig, storageMode: 'local' | 'drive') => void;
  onStopRequested: () => void;
  pushState: (phase: RecordingPhase, extra?: Record<string, any>) => void;
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
  if (deps.currentPhase() !== 'idle' || deps.isFinalizing()) {
    return { ok: false, error: `Recorder is busy (${deps.currentPhase()})` };
  }

  deps.clearWarnings();
  deps.onStartRequested(runConfig, runConfig.storageMode);
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
  deps: RpcHandlerDeps
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.engine.isRecording()) {
    return { ok: false, error: 'Stop requested but recorder is not active' };
  }
  deps.pushState('stopping');
  void deps.onStopRequested();
  return { ok: true };
}

async function handleRevokeBlobUrl(
  msg: Extract<BgToOffscreenOneWay, { type: 'REVOKE_BLOB_URL' }>,
  deps: RpcHandlerDeps
): Promise<void> {
  const { blobUrl, opfsFilename } = msg;
  if (typeof blobUrl === 'string') deps.engine.revokeBlobUrl(blobUrl);

  if (typeof opfsFilename === 'string') {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(opfsFilename);
      deps.log('Cleaned up OPFS file', opfsFilename);
    } catch (e) {
      deps.error('Failed to cleanup OPFS file', describeRuntimeError(e));
    }
  }
}

/** Registers RPC and one-way port handlers for background -> offscreen commands. */
export function wirePortHandlers(port: chrome.runtime.Port, deps: RpcHandlerDeps) {
  createPortRpcServer(
    port,
    {
      OFFSCREEN_START:   (msg) => handleOffscreenStart(msg, deps),
      OFFSCREEN_STOP:    ()    => handleOffscreenStop(deps),
      REVOKE_BLOB_URL:   (msg) => handleRevokeBlobUrl(msg, deps),
    },
    (reqId, payload) => respond(deps.getPort, reqId, payload),
    deps.error
  );
}

/** Registers the direct runtime message listener for the OFFSCREEN_PING reconnect signal. */
export function wireRuntimeListener(
  connectPort: () => chrome.runtime.Port,
  sendResponse: (response?: unknown) => void
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
