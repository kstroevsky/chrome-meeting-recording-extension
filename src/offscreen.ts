/**
 * @context  Offscreen Document (MV3)
 * @role     Recording studio and post-stop uploader.
 */
import { makeLogger } from './shared/logger';
import { createPortRpcServer } from './shared/rpc';
import type {
  BgToOffscreenOneWay,
  BgToOffscreenRpc,
  BgToOffscreenRuntime,
  RecordingPhase,
  RecordingStream,
  RpcResponse,
  UploadSummary,
} from './shared/protocol';
import {
  RecorderEngine,
  type CompletedRecordingArtifact,
  type SealedStorageFile,
} from './offscreen/RecorderEngine';
import { LocalFileTarget } from './offscreen/LocalFileTarget';
import { DriveTarget } from './offscreen/DriveTarget';
import { DRIVE_ROOT_FOLDER_NAME } from './offscreen/drive/constants';
import { inferDriveRecordingFolderName } from './offscreen/drive/folderNaming';

const L = makeLogger('offscreen');
const STREAM_ORDER: RecordingStream[] = ['tab', 'mic', 'selfVideo'];

function describeRuntimeError(err: unknown): string {
  const e = err as any;
  const name = e?.name || 'Error';
  const message = e?.message || String(e);
  const code = e?.code != null ? ` code=${e.code}` : '';
  return `${name}: ${message}${code}`;
}

window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', (e as any)?.message, (e as any)?.error);
});
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e);
});
L.log('script loaded');

let portRef: chrome.runtime.Port | null = null;
let reconnectEnabled = true;
let currentStorageMode: 'local' | 'drive' = 'local';
let currentDriveRecordingFolderName: string | null = null;
let currentPhase: RecordingPhase = 'idle';
let finalizeRunPromise: Promise<void> | null = null;

function connectPort(retryDelay = 1_000): chrome.runtime.Port {
  try { portRef?.disconnect(); } catch {}
  const port = chrome.runtime.connect({ name: 'offscreen' });
  wirePortHandlers(port);

  port.onDisconnect.addListener(() => {
    L.warn('Port disconnected');
    portRef = null;
    if (reconnectEnabled) {
      L.log(`Scheduling port reconnect in ${retryDelay} ms`);
      setTimeout(() => connectPort(Math.min(retryDelay * 2, 30_000)), retryDelay);
    }
  });

  port.postMessage({ type: 'OFFSCREEN_READY' });
  port.postMessage({ type: 'RECORDING_STATE', phase: currentPhase });
  L.log('READY signaled via Port');

  portRef = port;
  return port;
}

function getPort(): chrome.runtime.Port {
  return portRef ?? connectPort();
}

function respond(reqId: string, payload: any) {
  const msg: RpcResponse<unknown> = { __respFor: reqId, payload };
  getPort().postMessage(msg);
}

function pushState(phase: RecordingPhase, extra?: Record<string, any>) {
  currentPhase = phase;
  try {
    (chrome.storage as any)?.session?.set?.({ phase }).catch?.((e: any) => {
      L.warn('storage.session.set failed — phase will not persist across SW restarts:', e);
    });
  } catch {}
  getPort().postMessage({ type: 'RECORDING_STATE', phase, ...(extra ?? {}) });
}

function requestSave(filename: string, blobUrl: string, opfsFilename?: string) {
  getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl, opfsFilename });
}

async function getDriveToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_DRIVE_TOKEN' }, (res) => {
      if (!res) return reject(new Error('No response to GET_DRIVE_TOKEN'));
      if (!res.ok) return reject(new Error(`Token fetch failed: ${res.error}`));
      resolve(res.token);
    });
  });
}

function sortArtifacts(artifacts: CompletedRecordingArtifact[]): CompletedRecordingArtifact[] {
  return [...artifacts].sort(
    (a, b) => STREAM_ORDER.indexOf(a.stream) - STREAM_ORDER.indexOf(b.stream)
  );
}

function saveArtifactLocally(artifact: SealedStorageFile) {
  const blobUrl = URL.createObjectURL(artifact.file);
  requestSave(artifact.filename, blobUrl, artifact.opfsFilename);
}

async function cleanupArtifact(artifact: SealedStorageFile) {
  try {
    await artifact.cleanup();
    if (artifact.opfsFilename) {
      L.log('Cleaned up OPFS file', artifact.opfsFilename);
    }
  } catch (e) {
    L.warn('Failed to cleanup artifact', artifact.filename, describeRuntimeError(e));
  }
}

async function uploadArtifactsToDrive(
  artifacts: CompletedRecordingArtifact[],
  recordingFolderName: string
): Promise<UploadSummary> {
  const summary: UploadSummary = {
    uploaded: [],
    localFallbacks: [],
  };

  for (const entry of sortArtifacts(artifacts)) {
    const { artifact, stream } = entry;
    const driveTarget = new DriveTarget(
      artifact.filename,
      getDriveToken,
      (filename) => L.log('Drive target complete:', filename),
      {
        rootFolderName: DRIVE_ROOT_FOLDER_NAME,
        recordingFolderName,
      }
    );

    try {
      await driveTarget.upload(artifact.file);
      summary.uploaded.push({ stream, filename: artifact.filename });
      await cleanupArtifact(artifact);
    } catch (e) {
      const error = describeRuntimeError(e);
      L.warn('Drive upload failed; falling back to local download', artifact.filename, error);
      summary.localFallbacks.push({ stream, filename: artifact.filename, error });
      saveArtifactLocally(artifact);
    }
  }

  return summary;
}

async function finalizeCurrentRecordingRun(): Promise<void> {
  if (finalizeRunPromise) return finalizeRunPromise;

  finalizeRunPromise = (async () => {
    const artifacts = await engine.stop();
    const orderedArtifacts = sortArtifacts(artifacts);

    if (currentStorageMode === 'drive' && orderedArtifacts.length > 0) {
      const firstFilename = orderedArtifacts[0]?.artifact.filename;
      if (!currentDriveRecordingFolderName && firstFilename) {
        currentDriveRecordingFolderName = inferDriveRecordingFolderName(firstFilename);
      }

      pushState('uploading');
      const summary = await uploadArtifactsToDrive(
        orderedArtifacts,
        currentDriveRecordingFolderName ?? `google-meet-${Date.now()}`
      );
      pushState('idle', { uploadSummary: summary });
      currentDriveRecordingFolderName = null;
      return;
    }

    for (const entry of orderedArtifacts) {
      saveArtifactLocally(entry.artifact);
    }

    pushState('idle');
    currentDriveRecordingFolderName = null;
  })()
    .catch((e) => {
      L.error('Stop/finalize pipeline failed', describeRuntimeError(e));
      currentDriveRecordingFolderName = null;
      pushState('idle');
    })
    .finally(() => {
      finalizeRunPromise = null;
    });

  return finalizeRunPromise;
}

const engine = new RecorderEngine({
  log: L.log,
  warn: L.warn,
  error: L.error,
  notifyPhase: pushState,
  enableMicMix: true,
  openTarget: async (filename: string) => {
    try {
      return await LocalFileTarget.create(filename);
    } catch (e) {
      L.warn('OPFS local target create failed', describeRuntimeError(e));
      throw e;
    }
  },
});

function wirePortHandlers(port: chrome.runtime.Port) {
  createPortRpcServer(
    port,
    {
      OFFSCREEN_START: async (msg: Extract<BgToOffscreenRpc, { type: 'OFFSCREEN_START' }>) => {
        const streamId = msg.streamId as string | undefined;
        if (!streamId) return { ok: false, error: 'Missing streamId' };
        if (currentPhase !== 'idle' || finalizeRunPromise) {
          return { ok: false, error: `Recorder is busy (${currentPhase})` };
        }

        currentStorageMode = msg.storageMode === 'drive' ? 'drive' : 'local';
        currentDriveRecordingFolderName = null;
        const recordSelfVideo = !!msg.recordSelfVideo;
        const selfVideoQuality = msg.selfVideoQuality === 'high' ? 'high' : 'standard';

        try {
          await engine.startFromStreamId(streamId, { recordSelfVideo, selfVideoQuality });
          return { ok: true };
        } catch (e: any) {
          pushState('idle');
          return { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` };
        }
      },

      OFFSCREEN_STOP: async () => {
        if (!engine.isRecording()) {
          return { ok: false, error: 'Stop requested but recorder is not active' };
        }

        void finalizeCurrentRecordingRun();
        return { ok: true };
      },

      OFFSCREEN_STATUS: async () => {
        let phase = currentPhase;
        try {
          const res = await (chrome.storage as any)?.session?.get?.(['phase']);
          if (res?.phase === 'idle' || res?.phase === 'recording' || res?.phase === 'uploading') {
            phase = res.phase;
          }
        } catch (e) {
          L.warn('storage.session.get failed — status may be stale:', e);
        }
        return { phase };
      },

      REVOKE_BLOB_URL: async (msg: Extract<BgToOffscreenOneWay, { type: 'REVOKE_BLOB_URL' }>) => {
        const { blobUrl, opfsFilename } = msg;
        if (typeof blobUrl === 'string') engine.revokeBlobUrl(blobUrl);

        if (typeof opfsFilename === 'string') {
          try {
            const root = await navigator.storage.getDirectory();
            await root.removeEntry(opfsFilename);
            L.log('Cleaned up OPFS file', opfsFilename);
          } catch (e) {
            L.warn('Failed to cleanup OPFS file', describeRuntimeError(e));
          }
        }
      },
    },
    (reqId, payload) => respond(reqId, payload),
    L.error
  );
}

getPort();

chrome.runtime.onMessage.addListener((msg: BgToOffscreenRuntime, _sender, sendResponse) => {
  try {
    if ((msg as any)?.type === 'OFFSCREEN_PING') {
      sendResponse({ ok: true, via: 'onMessage' });
      return true;
    }
    if ((msg as any)?.type === 'OFFSCREEN_CONNECT') {
      connectPort();
      sendResponse({ ok: true });
      return true;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return false;
});
