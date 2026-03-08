import { RecordingFinalizer } from '../src/offscreen/RecordingFinalizer';
import { DriveTarget } from '../src/offscreen/DriveTarget';

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
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
});
