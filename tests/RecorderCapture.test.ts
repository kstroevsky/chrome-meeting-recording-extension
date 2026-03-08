import { maybeGetSelfVideoStream } from '../src/offscreen/RecorderCapture';
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

  beforeEach(() => {
    jest.clearAllMocks();
    (navigator.mediaDevices.getUserMedia as jest.Mock).mockReset();
  });

  it('requests a best-effort 1080p webcam stream and logs delivered settings', async () => {
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
        video: SELF_VIDEO_CONSTRAINTS,
      })
    );
    expect(deps.log).toHaveBeenCalledWith('self video stream acquired:', {
      ok: true,
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
