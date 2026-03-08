import { RecordingFinalizer } from '../src/offscreen/RecordingFinalizer';
import { DriveTarget } from '../src/offscreen/DriveTarget';
import { DriveFolderResolver } from '../src/offscreen/drive/DriveFolderResolver';
import { PERF_FLAGS, resetPerfFlags } from '../src/shared/perf';

function makeArtifact(filename: string) {
  return {
    filename,
    file: new File(['data'], filename, { type: 'video/webm' }),
    opfsFilename: filename,
    cleanup: jest.fn().mockResolvedValue(undefined),
  };
}

describe('RecordingFinalizer', () => {
  let deps: any;
  let finalizer: RecordingFinalizer;

  beforeEach(() => {
    deps = {
      log: jest.fn(),
      warn: jest.fn(),
      requestSave: jest.fn(),
      getDriveToken: jest.fn().mockResolvedValue('token'),
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
    const mic = makeArtifact('mic.webm');
    const tab = makeArtifact('tab.webm');

    const summary = await finalizer.finalize({
      storageMode: 'local',
      artifacts: [
        { stream: 'mic', artifact: mic },
        { stream: 'tab', artifact: tab },
      ],
    });

    expect(summary).toBeUndefined();
    expect(deps.requestSave).toHaveBeenNthCalledWith(1, 'tab.webm', 'blob:4', 'tab.webm');
    expect(deps.requestSave).toHaveBeenNthCalledWith(2, 'mic.webm', 'blob:4', 'mic.webm');
  });

  it('continues Drive uploads after one file falls back locally', async () => {
    jest.spyOn(DriveFolderResolver.prototype, 'resolveUploadParentId').mockResolvedValue('folder-1');
    const uploadSpy = jest.spyOn(DriveTarget.prototype, 'upload').mockImplementation(function (this: any) {
      if (this.filename === 'tab.webm') {
        return Promise.reject(new DOMException('network timeout', 'AbortError'));
      }
      return Promise.resolve();
    });

    const tab = makeArtifact('tab.webm');
    const mic = makeArtifact('mic.webm');

    const summary = await finalizer.finalize({
      storageMode: 'drive',
      artifacts: [
        { stream: 'mic', artifact: mic },
        { stream: 'tab', artifact: tab },
      ],
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
    expect(tab.cleanup).not.toHaveBeenCalled();
    expect(mic.cleanup).toHaveBeenCalledTimes(1);
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

    const tab = makeArtifact('tab.webm');
    const mic = makeArtifact('mic.webm');

    const summary = await finalizer.finalize({
      storageMode: 'drive',
      artifacts: [
        { stream: 'tab', artifact: tab },
        { stream: 'mic', artifact: mic },
      ],
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

    const tab = makeArtifact('tab.webm');
    const mic = makeArtifact('mic.webm');
    const finalizePromise = finalizer.finalize({
      storageMode: 'drive',
      artifacts: [
        { stream: 'mic', artifact: mic },
        { stream: 'tab', artifact: tab },
      ],
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

    const tab = makeArtifact('tab.webm');
    const mic = makeArtifact('mic.webm');

    const summary = await finalizer.finalize({
      storageMode: 'drive',
      artifacts: [
        { stream: 'tab', artifact: tab },
        { stream: 'mic', artifact: mic },
      ],
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

  it('preserves deterministic summary order when parallel uploads finish with mixed outcomes', async () => {
    resetPerfFlags();
    PERF_FLAGS.parallelUploadConcurrency = 2;
    jest.spyOn(DriveFolderResolver.prototype, 'resolveUploadParentId').mockResolvedValue('folder-1');
    jest.spyOn(DriveTarget.prototype, 'upload').mockImplementation(function (this: any) {
      if (this.filename === 'tab.webm') {
        return Promise.reject(new DOMException('network timeout', 'AbortError'));
      }
      return Promise.resolve();
    });

    const tab = makeArtifact('tab.webm');
    const mic = makeArtifact('mic.webm');

    const summary = await finalizer.finalize({
      storageMode: 'drive',
      artifacts: [
        { stream: 'mic', artifact: mic },
        { stream: 'tab', artifact: tab },
      ],
    });

    expect(summary).toEqual({
      uploaded: [{ stream: 'mic', filename: 'mic.webm' }],
      localFallbacks: [
        { stream: 'tab', filename: 'tab.webm', error: 'AbortError: network timeout code=20' },
      ],
    });
    expect(deps.requestSave).toHaveBeenCalledWith('tab.webm', 'blob:4', 'tab.webm');
    expect(mic.cleanup).toHaveBeenCalledTimes(1);
    expect(tab.cleanup).not.toHaveBeenCalled();
  });
});
