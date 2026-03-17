import { RecordingFinalizer } from '../src/offscreen/RecordingFinalizer';
import { DriveTarget } from '../src/offscreen/DriveTarget';
import { DriveFolderResolver } from '../src/offscreen/drive/DriveFolderResolver';
import type {
  CompletedRecordingArtifact,
  RecordingArtifactFinalizePlan,
  RecordingArtifactRole,
  SealedStorageFile,
} from '../src/offscreen/RecorderEngine';
import type { RecorderVideoContainer } from '../src/offscreen/RecorderProfiles';
import {
  buildRecorderRuntimeSettingsSnapshot,
  DEFAULT_EXTENSION_SETTINGS,
} from '../src/shared/extensionSettings';
import type { RecordingStream } from '../src/shared/recording';
import { PERF_FLAGS, resetPerfFlags } from '../src/shared/perf';

function inferMimeType(filename: string): string {
  if (filename.endsWith('.mp4')) return 'video/mp4';
  if (filename.startsWith('mic')) return 'audio/webm';
  return 'video/webm';
}

function makeArtifact(options: {
  filename: string;
  contents?: string;
  mimeType?: string;
  opfsFilename?: string;
}): SealedStorageFile & { cleanup: jest.Mock } {
  const {
    filename,
    contents = 'data',
    mimeType = inferMimeType(filename),
    opfsFilename = filename,
  } = options;

  return {
    filename,
    file: new File([contents], filename, { type: mimeType }),
    opfsFilename,
    cleanup: jest.fn().mockResolvedValue(undefined),
  };
}

function makeCompletedArtifact(options: {
  stream: RecordingStream;
  artifact: SealedStorageFile;
  container?: RecorderVideoContainer;
  role?: RecordingArtifactRole;
  finalize?: RecordingArtifactFinalizePlan;
}): CompletedRecordingArtifact {
  return {
    stream: options.stream,
    artifact: options.artifact,
    container: options.container ?? 'webm',
    role: options.role ?? 'master',
    finalize: options.finalize,
  };
}

describe('RecordingFinalizer', () => {
  let deps: any;
  let finalizer: RecordingFinalizer;
  const recorderSettings = buildRecorderRuntimeSettingsSnapshot(DEFAULT_EXTENSION_SETTINGS);

  beforeEach(() => {
    deps = {
      log: jest.fn(),
      warn: jest.fn(),
      requestSave: jest.fn(),
      getDriveToken: jest.fn().mockResolvedValue('token'),
      reportWarning: jest.fn(),
      getRecorderSettings: jest.fn(() => recorderSettings),
      postprocessVideoArtifact: jest.fn(),
    };
    finalizer = new RecordingFinalizer(deps);
    (URL as any).createObjectURL = jest.fn((blob: Blob) => `blob:${blob.size}`);
    global.fetch = jest.fn();
    resetPerfFlags();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    resetPerfFlags();
  });

  it('requests local downloads in deterministic stream order', async () => {
    const mic = makeCompletedArtifact({
      stream: 'mic',
      artifact: makeArtifact({ filename: 'mic.webm' }),
    });
    const tab = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
    });

    const summary = await finalizer.finalize({
      storageMode: 'local',
      artifacts: [mic, tab],
    });

    expect(summary).toBeUndefined();
    expect(deps.requestSave).toHaveBeenNthCalledWith(1, 'tab.webm', 'blob:4', 'tab.webm');
    expect(deps.requestSave).toHaveBeenNthCalledWith(2, 'mic.webm', 'blob:4', 'mic.webm');
  });

  it('prefers a live tab MP4 delivery artifact and cleans up the WebM master', async () => {
    const tabMaster = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
      finalize: {
        outputContainer: 'mp4',
        resizeTabOutput: false,
      },
    });
    const tabDelivery = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.mp4', contents: 'mp4-data' }),
      container: 'mp4',
      role: 'delivery',
    });

    const summary = await finalizer.finalize({
      storageMode: 'local',
      artifacts: [tabMaster, tabDelivery],
    });

    expect(summary).toBeUndefined();
    expect(deps.postprocessVideoArtifact).not.toHaveBeenCalled();
    expect(deps.requestSave).toHaveBeenCalledWith('tab.mp4', 'blob:8', 'tab.mp4');
    expect(tabMaster.artifact.cleanup).toHaveBeenCalledTimes(1);
    expect(tabDelivery.artifact.cleanup).not.toHaveBeenCalled();
  });

  it('postprocesses the tab WebM master to a resized WebM before local save', async () => {
    const original = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
      finalize: {
        outputContainer: 'webm',
        resizeTabOutput: true,
        outputTarget: { width: 640, height: 360, frameRate: 24 },
      },
    });
    const processed = makeArtifact({
      filename: 'tab.webm',
      contents: 'processed',
      opfsFilename: 'tab-resized.webm',
    });
    deps.postprocessVideoArtifact.mockResolvedValue(processed);

    const summary = await finalizer.finalize({
      storageMode: 'local',
      artifacts: [original],
    });

    expect(summary).toBeUndefined();
    expect(deps.postprocessVideoArtifact).toHaveBeenCalledWith(original.artifact, {
      stream: 'tab',
      outputContainer: 'webm',
      outputTarget: { width: 640, height: 360, frameRate: 24 },
      chunking: recorderSettings.chunking,
    });
    expect(deps.requestSave).toHaveBeenCalledWith('tab.webm', 'blob:9', 'tab-resized.webm');
  });

  it('postprocesses the tab WebM master to a resized MP4 when resize and MP4 are both requested', async () => {
    const original = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
      finalize: {
        outputContainer: 'mp4',
        resizeTabOutput: true,
        outputTarget: { width: 640, height: 360, frameRate: 24 },
      },
    });
    const processed = makeArtifact({
      filename: 'tab.mp4',
      contents: 'processed-mp4',
      mimeType: 'video/mp4',
      opfsFilename: 'tab-resized.mp4',
    });
    deps.postprocessVideoArtifact.mockResolvedValue(processed);

    const summary = await finalizer.finalize({
      storageMode: 'local',
      artifacts: [original],
    });

    expect(summary).toBeUndefined();
    expect(deps.postprocessVideoArtifact).toHaveBeenCalledWith(original.artifact, {
      stream: 'tab',
      outputContainer: 'mp4',
      outputTarget: { width: 640, height: 360, frameRate: 24 },
      chunking: recorderSettings.chunking,
    });
    expect(deps.requestSave).toHaveBeenCalledWith('tab.mp4', 'blob:13', 'tab-resized.mp4');
  });

  it('postprocesses the self-video WebM master to MP4 when requested', async () => {
    const original = makeCompletedArtifact({
      stream: 'selfVideo',
      artifact: makeArtifact({ filename: 'camera.webm' }),
      finalize: {
        outputContainer: 'mp4',
        resizeTabOutput: false,
      },
    });
    const processed = makeArtifact({
      filename: 'camera.mp4',
      contents: 'camera-mp4',
      mimeType: 'video/mp4',
      opfsFilename: 'camera-converted.mp4',
    });
    deps.postprocessVideoArtifact.mockResolvedValue(processed);

    const summary = await finalizer.finalize({
      storageMode: 'local',
      artifacts: [original],
    });

    expect(summary).toBeUndefined();
    expect(deps.postprocessVideoArtifact).toHaveBeenCalledWith(original.artifact, {
      stream: 'selfVideo',
      outputContainer: 'mp4',
      outputTarget: undefined,
      chunking: recorderSettings.chunking,
    });
    expect(deps.requestSave).toHaveBeenCalledWith('camera.mp4', 'blob:10', 'camera-converted.mp4');
  });

  it('keeps the original WebM master and reports a warning when video postprocess fails', async () => {
    const original = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
      finalize: {
        outputContainer: 'mp4',
        resizeTabOutput: true,
        outputTarget: { width: 640, height: 360, frameRate: 24 },
      },
    });
    const staleDelivery = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.mp4', contents: 'stale-mp4' }),
      container: 'mp4',
      role: 'delivery',
    });
    deps.postprocessVideoArtifact.mockRejectedValue(new Error('transcode failed'));

    const summary = await finalizer.finalize({
      storageMode: 'local',
      artifacts: [original, staleDelivery],
    });

    expect(summary).toBeUndefined();
    expect(deps.requestSave).toHaveBeenCalledWith('tab.webm', 'blob:4', 'tab.webm');
    expect(deps.reportWarning).toHaveBeenCalledWith(
      expect.stringContaining('Saving the original WebM recording instead.')
    );
    expect(staleDelivery.artifact.cleanup).toHaveBeenCalledTimes(1);
  });

  it('continues Drive uploads after one file falls back locally', async () => {
    jest.spyOn(DriveFolderResolver.prototype, 'resolveUploadParentId').mockResolvedValue('folder-1');
    const uploadSpy = jest.spyOn(DriveTarget.prototype, 'upload').mockImplementation(function (this: any) {
      if (this.filename === 'tab.webm') {
        return Promise.reject(new DOMException('network timeout', 'AbortError'));
      }
      return Promise.resolve();
    });

    const mic = makeCompletedArtifact({
      stream: 'mic',
      artifact: makeArtifact({ filename: 'mic.webm' }),
    });
    const tab = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
    });

    const summary = await finalizer.finalize({
      storageMode: 'drive',
      artifacts: [mic, tab],
    });

    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({
      uploaded: [{ stream: 'mic', filename: 'mic.webm' }],
      localFallbacks: [
        {
          stream: 'tab',
          filename: 'tab.webm',
          error: 'AbortError: network timeout code=20',
        },
      ],
    });
    expect(deps.requestSave).toHaveBeenCalledWith('tab.webm', 'blob:4', 'tab.webm');
    expect(tab.artifact.cleanup).not.toHaveBeenCalled();
    expect(mic.artifact.cleanup).toHaveBeenCalledTimes(1);
  });

  it('reuses one cached Drive token across a finalize run', async () => {
    jest.spyOn(DriveFolderResolver.prototype, 'resolveUploadParentId').mockResolvedValue('folder-1');
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ Location: 'https://session-1' }),
      })
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ Location: 'https://session-2' }),
      })
      .mockResolvedValueOnce({ status: 200 });

    const tab = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
    });
    const mic = makeCompletedArtifact({
      stream: 'mic',
      artifact: makeArtifact({ filename: 'mic.webm' }),
    });

    const summary = await finalizer.finalize({
      storageMode: 'drive',
      artifacts: [tab, mic],
    });

    expect(summary).toEqual({
      uploaded: [
        { stream: 'tab', filename: 'tab.webm' },
        { stream: 'mic', filename: 'mic.webm' },
      ],
      localFallbacks: [],
    });
    expect(deps.getDriveToken).toHaveBeenCalledTimes(1);
  });

  it('can upload two finalized artifacts in parallel behind the feature flag', async () => {
    resetPerfFlags();
    PERF_FLAGS.parallelUploadConcurrency = 2;
    jest.spyOn(DriveFolderResolver.prototype, 'resolveUploadParentId').mockResolvedValue('folder-1');

    let activeUploads = 0;
    let maxActiveUploads = 0;
    let releaseUploads!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });

    const uploadSpy = jest.spyOn(DriveTarget.prototype, 'upload').mockImplementation(async function () {
      activeUploads += 1;
      maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
      await releasePromise;
      activeUploads -= 1;
    });

    const mic = makeCompletedArtifact({
      stream: 'mic',
      artifact: makeArtifact({ filename: 'mic.webm' }),
    });
    const tab = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
    });
    const finalizePromise = finalizer.finalize({
      storageMode: 'drive',
      artifacts: [mic, tab],
    });

    await Promise.resolve();
    await Promise.resolve();
    releaseUploads();

    const summary = await finalizePromise;

    expect(uploadSpy).toHaveBeenCalledTimes(2);
    expect(maxActiveUploads).toBe(2);
    expect(summary).toEqual({
      uploaded: [
        { stream: 'tab', filename: 'tab.webm' },
        { stream: 'mic', filename: 'mic.webm' },
      ],
      localFallbacks: [],
    });
  });

  it('falls back every artifact locally when shared Drive setup fails before uploads start', async () => {
    jest.spyOn(DriveFolderResolver.prototype, 'resolveUploadParentId').mockRejectedValue(new Error('folder lookup failed'));
    const uploadSpy = jest.spyOn(DriveTarget.prototype, 'upload');

    const tab = makeCompletedArtifact({
      stream: 'tab',
      artifact: makeArtifact({ filename: 'tab.webm' }),
    });
    const mic = makeCompletedArtifact({
      stream: 'mic',
      artifact: makeArtifact({ filename: 'mic.webm' }),
    });

    const summary = await finalizer.finalize({
      storageMode: 'drive',
      artifacts: [tab, mic],
    });

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(summary).toEqual({
      uploaded: [],
      localFallbacks: [
        { stream: 'tab', filename: 'tab.webm', error: 'Error: folder lookup failed' },
        { stream: 'mic', filename: 'mic.webm', error: 'Error: folder lookup failed' },
      ],
    });
    expect(deps.requestSave).toHaveBeenNthCalledWith(1, 'tab.webm', 'blob:4', 'tab.webm');
    expect(deps.requestSave).toHaveBeenNthCalledWith(2, 'mic.webm', 'blob:4', 'mic.webm');
  });
});
