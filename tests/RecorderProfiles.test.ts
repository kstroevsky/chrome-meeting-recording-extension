import {
  formatSelfVideoProfile,
  getChunkTimesliceMs,
  getSelfVideoConstraintRequests,
  getDefaultSelfVideoBitrate,
  matchesSelfVideoProfile,
  resolveSelfVideoBitrate,
  SELF_VIDEO_CONSTRAINTS,
  SELF_VIDEO_PROFILE,
} from '../src/offscreen/RecorderProfiles';
import { PERF_FLAGS, resetPerfFlags } from '../src/shared/perf';

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
      defaultBitsPerSecond: 6_000_000,
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
    expect(getDefaultSelfVideoBitrate()).toBe(6_000_000);
    expect(matchesSelfVideoProfile({ width: 1920, height: 1080 })).toBe(true);
    expect(matchesSelfVideoProfile({ width: 1280, height: 720 })).toBe(false);
  });

  it('extends the chunk timeslice only when the feature flag and extra streams are active', () => {
    PERF_FLAGS.extendedTimeslice = true;

    expect(getChunkTimesliceMs('off', false)).toBe(2000);
    expect(getChunkTimesliceMs('mixed', false)).toBe(4000);
    expect(getChunkTimesliceMs('off', true)).toBe(4000);
  });

  it('adapts self-video bitrate within the allowed ceiling when profiling is enabled', () => {
    PERF_FLAGS.adaptiveSelfVideoProfile = true;

    expect(resolveSelfVideoBitrate(6_000_000, { width: 640, height: 360, frameRate: 15 })).toBe(1_000_000);
    expect(resolveSelfVideoBitrate(6_000_000, { width: 3840, height: 2160, frameRate: 60 })).toBe(6_000_000);
    expect(resolveSelfVideoBitrate(6_000_000, undefined)).toBe(6_000_000);
  });

  it('builds strict self-video constraint fallbacks only when requested', () => {
    expect(getSelfVideoConstraintRequests('best-effort')).toEqual([
      {
        label: 'best-effort',
        constraints: SELF_VIDEO_CONSTRAINTS,
      },
    ]);
    expect(getSelfVideoConstraintRequests('strict-preferred')).toEqual([
      expect.objectContaining({
        label: 'strict-exact',
        constraints: expect.objectContaining({
          width: { exact: 1920 },
          height: { exact: 1080 },
          frameRate: { exact: 30 },
        }),
      }),
      expect.objectContaining({
        label: 'strict-size',
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
