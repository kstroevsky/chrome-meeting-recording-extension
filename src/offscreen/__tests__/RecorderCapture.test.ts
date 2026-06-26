import { captureTabStreamFromId, maybeGetSelfVideoStream } from '../RecorderCapture';
import {
  resetExtensionSettingsToDefaults,
  saveExtensionSettingsToStorage,
} from '../../shared/settings';
import {
  formatSelfVideoProfile,
  SELF_VIDEO_CONSTRAINTS,
  SELF_VIDEO_PROFILE,
} from '../RecorderProfiles';

function makeVideoTrack(
  settings: MediaTrackSettings,
  capabilities?: MediaTrackCapabilities
) {
  return {
    kind: 'video',
    muted: false,
    enabled: true,
    stop: jest.fn(),
    addEventListener: jest.fn(),
    getSettings: () => settings,
    getCapabilities: jest.fn(() => capabilities),
  };
}

function makeStream(track: any): MediaStream {
  return {
    getAudioTracks: () => [],
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as any;
}

describe('RecorderCapture', () => {
  const deps = {
    log: jest.fn(),
    warn: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockReset();
    await resetExtensionSettingsToDefaults();
  });

  it('requests tab acquisition at the selected capture ceiling', async () => {
    const tabStream = makeStream(
      makeVideoTrack({ width: 1920, height: 1080, frameRate: 24 })
    );
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(tabStream);
    await saveExtensionSettingsToStorage({
      professional: {
        tabResolutionPreset: '640x360',
        tabMaxFrameRate: 24,
      },
    });

    const result = await captureTabStreamFromId('stream-id', deps);

    expect(result).toBe(tabStream);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({
          mandatory: expect.objectContaining({
            chromeMediaSourceId: 'stream-id',
            maxWidth: 640,
            maxHeight: 360,
            maxFrameRate: 24,
          }),
        }),
      })
    );
  });

  it('reports both tab and desktop capture failures', async () => {
    (navigator.mediaDevices.getUserMedia as jest.Mock)
      .mockRejectedValueOnce(new DOMException('tab unavailable', 'NotReadableError'))
      .mockRejectedValueOnce(new DOMException('desktop unavailable', 'AbortError'));

    await expect(captureTabStreamFromId('stream-id', deps)).rejects.toThrow(
      /tab=NotReadableError: tab unavailable.*desktop=AbortError: desktop unavailable/
    );
  });

  it('requests the deterministic camera constraint ladder and logs delivered settings', async () => {
    const stream = makeStream(
      makeVideoTrack(
        { width: 1280, height: 720, frameRate: 30, deviceId: 'camera-1' },
        { width: { min: 640, max: 1920 }, height: { min: 480, max: 1080 }, frameRate: { min: 1, max: 30 } }
      )
    );
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const result = await maybeGetSelfVideoStream(true, deps);

    expect(result).toBe(stream);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({
          width: { exact: 1920 },
          height: { exact: 1080 },
          frameRate: { exact: 24 },
        }),
      })
    );
    // Assert the diagnostic contract the debug dashboard relies on, without
    // pinning every echoed capability field (which would break on any addition).
    expect(deps.log).toHaveBeenCalledWith('self video stream acquired:', expect.objectContaining({
      ok: true,
      requestStrategy: 'exact-size-and-fps',
      requestedWidth: SELF_VIDEO_PROFILE.width,
      requestedHeight: SELF_VIDEO_PROFILE.height,
      requestedFrameRate: SELF_VIDEO_PROFILE.frameRate,
      width: 1280,
      height: 720,
      frameRate: 30,
      deviceId: 'camera-1',
    }));
    expect(deps.warn).toHaveBeenCalledWith(
      `self video preferred ${formatSelfVideoProfile()} but browser delivered 1280x720`
    );
  });

  it('falls back through exact-size and best-effort camera constraints', async () => {
    const stream = makeStream(
      makeVideoTrack(
        { width: 1920, height: 1080, frameRate: 30, deviceId: 'camera-1' },
        { width: { min: 640, max: 1920 }, height: { min: 480, max: 1080 }, frameRate: { min: 1, max: 30 } }
      )
    );
    (navigator.mediaDevices.getUserMedia as jest.Mock)
      .mockRejectedValueOnce(new Error('exact size busy'))
      .mockRejectedValueOnce(new Error('exact fps unsupported'))
      .mockResolvedValue(stream);

    const result = await maybeGetSelfVideoStream(true, deps);

    expect(result).toBe(stream);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({
          width: { exact: 1920 },
          height: { exact: 1080 },
          frameRate: { exact: 24 },
        }),
      })
    );
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({
          width: { exact: 1920 },
          height: { exact: 1080 },
          frameRate: { ideal: 24, max: 24 },
        }),
      })
    );
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        audio: false,
        video: SELF_VIDEO_CONSTRAINTS,
      })
    );
    expect(deps.log).toHaveBeenCalledWith(
      'self video getUserMedia attempt failed; retrying with fallback',
      expect.objectContaining({
        requestStrategy: 'exact-size-and-fps',
      })
    );
    expect(deps.log).toHaveBeenCalledWith(
      'self video getUserMedia attempt failed; retrying with fallback',
      expect.objectContaining({
        requestStrategy: 'exact-size',
      })
    );
    expect(deps.log).toHaveBeenCalledWith('self video stream acquired:', expect.objectContaining({
      ok: true,
      requestStrategy: 'best-effort',
      requestedWidth: SELF_VIDEO_PROFILE.width,
      requestedHeight: SELF_VIDEO_PROFILE.height,
      requestedFrameRate: SELF_VIDEO_PROFILE.frameRate,
      width: 1920,
      height: 1080,
      frameRate: 30,
      deviceId: 'camera-1',
    }));
  });

  it('returns null when webcam acquisition fails', async () => {
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockRejectedValue(new Error('no camera'));

    const result = await maybeGetSelfVideoStream(true, deps);

    expect(result).toBeNull();
    expect(deps.warn).toHaveBeenCalledWith(
      'self video getUserMedia failed (continuing without self video):',
      expect.stringContaining('no camera')
    );
  });
});
