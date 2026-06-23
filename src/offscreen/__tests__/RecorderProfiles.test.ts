import {
  formatSelfVideoProfile,
  getChunkTimesliceMs,
  getSelfVideoConstraintRequests,
  getDefaultSelfVideoBitrate,
  matchesSelfVideoProfile,
  resolveSelfVideoBitrate,
  SELF_VIDEO_CONSTRAINTS,
  SELF_VIDEO_PROFILE,
} from '../RecorderProfiles';
import { PERF_FLAGS, resetPerfFlags } from '../../shared/perf';

describe('RecorderProfiles', () => {
  afterEach(() => {
    resetPerfFlags();
  });

  it('exports the best-effort self-video profile and constraints', () => {
    expect(SELF_VIDEO_PROFILE).toEqual({
      width: 1920,
      height: 1080,
      frameRate: 30,
      aspectRatio: 16 / 9,
      defaultBitsPerSecond: 3_000_000,
    });
    expect(SELF_VIDEO_CONSTRAINTS).toEqual(
      expect.objectContaining({
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
        aspectRatio: { ideal: 16 / 9 },
      })
    );
    expect(formatSelfVideoProfile()).toBe('1920x1080');
    expect(getDefaultSelfVideoBitrate()).toBe(3_000_000);
    expect(matchesSelfVideoProfile({ width: 1920, height: 1080 })).toBe(true);
    expect(matchesSelfVideoProfile({ width: 1280, height: 720 })).toBe(false);
  });

  it('keeps the tab and self-video recorders on the longer default cadence', () => {
    expect(getChunkTimesliceMs('tab')).toBe(4000);
    expect(getChunkTimesliceMs('mic')).toBe(2000);
    expect(getChunkTimesliceMs('self-video')).toBe(4000);
  });

  it('extends only the microphone chunks when the perf flag is enabled', () => {
    PERF_FLAGS.extendedTimeslice = true;

    expect(getChunkTimesliceMs('tab')).toBe(4000);
    expect(getChunkTimesliceMs('mic')).toBe(4000);
    expect(getChunkTimesliceMs('self-video')).toBe(4000);
  });

  it('adapts self-video bitrate within the allowed ceiling when profiling is enabled', () => {
    PERF_FLAGS.adaptiveSelfVideoProfile = true;

    // Factor-bound (the binding case): 1280x720x30 * 0.05 quality factor.
    expect(resolveSelfVideoBitrate(3_000_000, { width: 1280, height: 720, frameRate: 30 })).toBe(1_382_400);
    // Floor- and ceiling-bound cases clamp regardless of the factor.
    expect(resolveSelfVideoBitrate(3_000_000, { width: 640, height: 360, frameRate: 15 })).toBe(1_000_000);
    expect(resolveSelfVideoBitrate(3_000_000, { width: 3840, height: 2160, frameRate: 60 })).toBe(3_000_000);
    expect(resolveSelfVideoBitrate(3_000_000, undefined)).toBe(3_000_000);
  });

  it('returns the fallback bitrate unchanged when adaptive profiling is disabled', () => {
    PERF_FLAGS.adaptiveSelfVideoProfile = false;

    expect(resolveSelfVideoBitrate(3_000_000, { width: 1280, height: 720, frameRate: 30 })).toBe(3_000_000);
  });

  it('builds a deterministic self-video constraint fallback ladder', () => {
    expect(getSelfVideoConstraintRequests()).toEqual([
      expect.objectContaining({
        label: 'exact-size-and-fps',
        constraints: expect.objectContaining({
          width: { exact: 1920 },
          height: { exact: 1080 },
          frameRate: { exact: 30 },
        }),
      }),
      expect.objectContaining({
        label: 'exact-size',
        constraints: expect.objectContaining({
          width: { exact: 1920 },
          height: { exact: 1080 },
          frameRate: { ideal: 30, max: 30 },
        }),
      }),
      {
        label: 'best-effort',
        constraints: SELF_VIDEO_CONSTRAINTS,
      },
    ]);
  });
});
