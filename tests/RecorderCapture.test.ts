import { captureTabStreamFromId, maybeGetSelfVideoStream } from '../src/offscreen/RecorderCapture';
import {
  resetExtensionSettingsToDefaults,
  saveExtensionSettingsToStorage,
} from '../src/shared/extensionSettings';
import {
  formatSelfVideoProfile,
  SELF_VIDEO_CONSTRAINTS,
  SELF_VIDEO_PROFILE,
} from '../src/offscreen/RecorderProfiles';

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

  it('keeps tab acquisition at the high-ceiling capture size regardless of output preset', async () => {
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
            maxWidth: 1920,
            maxHeight: 1080,
            maxFrameRate: 24,
          }),
        }),
      })
    );
  });

  it('requests a best-effort 1080p webcam stream and logs delivered settings', async () => {
    const stream = makeStream(
      makeVideoTrack(
        { width: 1280, height: 720, frameRate: 30, deviceId: 'camera-1' },
        { width: { min: 640, max: 1920 }, height: { min: 480, max: 1080 }, frameRate: { min: 1, max: 30 } }
      )
    );
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockResolvedValue(stream);

    const result = await maybeGetSelfVideoStream(true, deps, 'best-effort');

    expect(result).toBe(stream);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: false,
        video: SELF_VIDEO_CONSTRAINTS,
      })
    );
    expect(deps.log).toHaveBeenCalledWith('self video stream acquired:', {
      ok: true,
      requestedMode: 'best-effort',
      requestStrategy: 'best-effort',
      requestedWidth: SELF_VIDEO_PROFILE.width,
      requestedHeight: SELF_VIDEO_PROFILE.height,
      requestedFrameRate: SELF_VIDEO_PROFILE.frameRate,
      width: 1280,
      height: 720,
      frameRate: 30,
      deviceId: 'camera-1',
      capabilityWidth: { min: 640, max: 1920 },
      capabilityHeight: { min: 480, max: 1080 },
      capabilityFrameRate: { min: 1, max: 30 },
      muted: false,
      enabled: true,
    });
    expect(deps.warn).toHaveBeenCalledWith(
      `self video preferred ${formatSelfVideoProfile()} but browser delivered 1280x720`
    );
  });

  it('tries strict self-video constraints first when Meet camera is off, then falls back', async () => {
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

    const result = await maybeGetSelfVideoStream(true, deps, 'strict-preferred');

    expect(result).toBe(stream);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({
          width: { exact: 1920 },
          height: { exact: 1080 },
          frameRate: { exact: 30 },
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
          frameRate: { ideal: 30, max: 30 },
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
        requestedMode: 'strict-preferred',
        requestStrategy: 'strict-exact',
      })
    );
    expect(deps.log).toHaveBeenCalledWith(
      'self video getUserMedia attempt failed; retrying with fallback',
      expect.objectContaining({
        requestedMode: 'strict-preferred',
        requestStrategy: 'strict-size',
      })
    );
    expect(deps.log).toHaveBeenCalledWith('self video stream acquired:', {
      ok: true,
      requestedMode: 'strict-preferred',
      requestStrategy: 'best-effort',
      requestedWidth: SELF_VIDEO_PROFILE.width,
      requestedHeight: SELF_VIDEO_PROFILE.height,
      requestedFrameRate: SELF_VIDEO_PROFILE.frameRate,
      width: 1920,
      height: 1080,
      frameRate: 30,
      deviceId: 'camera-1',
      capabilityWidth: { min: 640, max: 1920 },
      capabilityHeight: { min: 480, max: 1080 },
      capabilityFrameRate: { min: 1, max: 30 },
      muted: false,
      enabled: true,
    });
  });

  it('returns null when webcam acquisition fails', async () => {
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockRejectedValue(new Error('no camera'));

    const result = await maybeGetSelfVideoStream(true, deps, 'best-effort');

    expect(result).toBeNull();
    expect(deps.warn).toHaveBeenCalledWith(
      'self video getUserMedia failed (continuing without self video):',
      expect.stringContaining('no camera')
    );
  });
});
