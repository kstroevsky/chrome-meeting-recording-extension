import {
  DEFAULT_RECORDING_RUN_CONFIG,
  createDefaultRunConfig,
  getRunConfigOrDefault,
  hasUploadsInFlight,
  isBusyPhase,
  isStoppablePhase,
  normalizeMicMode,
  normalizeSessionSnapshot,
  normalizeUploadJobs,
  normalizeUploadSummary,
  normalizeWarnings,
  toStatusView,
} from '../recording';
import type { DesiredState, ObservedState, RecordingPhase, UploadJob } from '../recording';

describe('shared/recording helpers', () => {
  it('preserves micMode=off during normalization', () => {
    expect(normalizeMicMode('off')).toBe('off');
  });

  it('returns a cloned default run config when normalization fails', () => {
    const fallback = getRunConfigOrDefault(null);

    expect(fallback).toEqual(DEFAULT_RECORDING_RUN_CONFIG);
    expect(fallback).not.toBe(DEFAULT_RECORDING_RUN_CONFIG);
    expect(createDefaultRunConfig()).toEqual(DEFAULT_RECORDING_RUN_CONFIG);
  });

  it('parses the per-recording tabContentType and defaults invalid/missing values to screen', () => {
    expect(getRunConfigOrDefault({ tabContentType: 'video' }).tabContentType).toBe('video');
    expect(getRunConfigOrDefault({ tabContentType: 'bogus' }).tabContentType).toBe('screen');
    expect(getRunConfigOrDefault({}).tabContentType).toBe('screen');
  });

  it('treats only active capture phases as stoppable', () => {
    expect((['starting', 'recording', 'stopping'] as const).map(isStoppablePhase)).toEqual([true, true, true]);
    expect((['idle', 'failed'] as const).map(isStoppablePhase)).toEqual([false, false]);
  });

  it('treats every non-terminal working phase as busy', () => {
    expect((['starting', 'recording', 'stopping'] as const).map(isBusyPhase)).toEqual([true, true, true]);
    expect((['idle', 'failed'] as const).map(isBusyPhase)).toEqual([false, false]);
  });

  it('normalizes warning lists into trimmed unique entries', () => {
    expect(normalizeWarnings(['  first ', '', 'first', 123, 'second'])).toEqual(['first', 'second']);
    expect(normalizeWarnings('not-an-array')).toBeUndefined();
  });

  it('filters invalid upload summary entries and trims filenames', () => {
    expect(
      normalizeUploadSummary({
        uploaded: [
          { stream: 'tab', filename: ' meeting.webm ' },
          { stream: 'tab', filename: '   ' },
        ],
        localFallbacks: [
          { stream: 'unexpected', filename: ' fallback.webm ', error: ' failed ' },
          null,
        ],
      })
    ).toEqual({
      uploaded: [{ stream: 'tab', filename: 'meeting.webm' }],
      localFallbacks: [{ stream: 'tab', filename: 'fallback.webm', error: 'failed' }],
    });
  });
});

describe('session snapshot micMuted', () => {
  const active = (extra: Record<string, unknown> = {}) => ({
    phase: 'recording',
    runConfig: { storageMode: 'local', micMode: 'separate', recordSelfVideo: false },
    updatedAt: 1,
    ...extra,
  });

  it('keeps micMuted only while a recording is active', () => {
    expect(normalizeSessionSnapshot(active({ micMuted: true })).micMuted).toBe(true);
    expect(normalizeSessionSnapshot(active()).micMuted).toBeUndefined();
    expect(normalizeSessionSnapshot({ phase: 'idle', micMuted: true, updatedAt: 1 }).micMuted).toBeUndefined();
  });

  it('projects micMuted onto the popup status view', () => {
    expect(toStatusView(active({ micMuted: true }) as any).micMuted).toBe(true);
    expect(toStatusView(active() as any).micMuted).toBeUndefined();
  });
});

describe('session snapshot cameraMuted', () => {
  const active = (extra: Record<string, unknown> = {}) => ({
    phase: 'recording',
    runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: true },
    updatedAt: 1,
    ...extra,
  });

  it('keeps cameraMuted only while a recording is active', () => {
    expect(normalizeSessionSnapshot(active({ cameraMuted: true })).cameraMuted).toBe(true);
    expect(normalizeSessionSnapshot(active()).cameraMuted).toBeUndefined();
    expect(normalizeSessionSnapshot({ phase: 'idle', cameraMuted: true, updatedAt: 1 }).cameraMuted).toBeUndefined();
  });

  it('projects cameraMuted onto the popup status view', () => {
    expect(toStatusView(active({ cameraMuted: true }) as any).cameraMuted).toBe(true);
    expect(toStatusView(active() as any).cameraMuted).toBeUndefined();
  });
});

describe('session snapshot paused', () => {
  const active = (extra: Record<string, unknown> = {}) => ({
    phase: 'recording',
    runConfig: { storageMode: 'local', micMode: 'separate', recordSelfVideo: true },
    updatedAt: 1,
    ...extra,
  });

  it('keeps paused only while a recording is active', () => {
    expect(normalizeSessionSnapshot(active({ paused: true })).paused).toBe(true);
    expect(normalizeSessionSnapshot(active()).paused).toBeUndefined();
    expect(normalizeSessionSnapshot({ phase: 'idle', paused: true, updatedAt: 1 }).paused).toBeUndefined();
  });

  it('projects paused onto the popup status view', () => {
    expect(toStatusView(active({ paused: true }) as any).paused).toBe(true);
    expect(toStatusView(active() as any).paused).toBeUndefined();
  });
});

describe('session snapshot recording timer', () => {
  const active = (extra: Record<string, unknown> = {}) => ({
    phase: 'recording',
    runConfig: { storageMode: 'local', micMode: 'separate', recordSelfVideo: false },
    updatedAt: 1,
    ...extra,
  });

  it('normalizes recordedMs/runningSince while recording and resets at idle', () => {
    const s = normalizeSessionSnapshot(active({ recordedMs: 4200, runningSince: 1000 }));
    expect(s.recordedMs).toBe(4200);
    expect(s.runningSince).toBe(1000);

    // Missing/invalid recordedMs defaults to 0; non-positive runningSince drops to undefined.
    const d = normalizeSessionSnapshot(active({ recordedMs: -5, runningSince: 0 }));
    expect(d.recordedMs).toBe(0);
    expect(d.runningSince).toBeUndefined();

    const idle = normalizeSessionSnapshot({ phase: 'idle', recordedMs: 9, runningSince: 9, updatedAt: 1 });
    expect(idle.recordedMs).toBeUndefined();
    expect(idle.runningSince).toBeUndefined();
  });

  it('projects the timer fields onto the popup status view', () => {
    const view = toStatusView(active({ recordedMs: 7000, runningSince: 1234 }) as any);
    expect(view.recordedMs).toBe(7000);
    expect(view.runningSince).toBe(1234);
  });
});

describe('session snapshot desired/observed migration (ADR-0003 Decision 4)', () => {
  it('reconstructs the planes from each legacy phase and round-trips the derived phase', () => {
    const cases: Array<[RecordingPhase, DesiredState, ObservedState, boolean]> = [
      ['idle', 'idle', 'idle', false],
      ['starting', 'recording', 'starting', false],
      ['recording', 'recording', 'recording', false],
      ['stopping', 'idle', 'stopping', false],
      ['failed', 'idle', 'none', true],
    ];

    for (const [phase, desired, observed, failed] of cases) {
      const s = normalizeSessionSnapshot({
        phase,
        runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
        error: failed ? 'boom' : undefined,
        updatedAt: 1,
      });
      expect(s.desired).toBe(desired);
      expect(s.observed).toBe(observed);
      expect(s.failed).toBe(failed);
      // The legacy `phase` is reconstructed exactly (inverse of projectPhase).
      expect(s.phase).toBe(phase);
    }
  });

  it('prefers authoritative planes when present and re-derives the phase from them', () => {
    // A snapshot written by current code: the planes are the source of truth, even
    // if a stale stored `phase` disagrees.
    const s = normalizeSessionSnapshot({
      phase: 'idle', // stale / ignored
      desired: 'recording',
      observed: 'recording',
      failed: false,
      runConfig: { storageMode: 'drive', micMode: 'mixed', recordSelfVideo: true },
      updatedAt: 1,
    });

    expect(s.desired).toBe('recording');
    expect(s.observed).toBe('recording');
    expect(s.phase).toBe('recording'); // planes win over the stale phase
    expect(s.runConfig).toEqual({ storageMode: 'drive', micMode: 'mixed', recordSelfVideo: true, tabContentType: 'screen' });
  });

  it('carries a persisted failed flag and derives the failed phase regardless of the planes', () => {
    const s = normalizeSessionSnapshot({
      phase: 'recording',
      desired: 'recording',
      observed: 'recording',
      failed: true,
      runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      error: 'kaboom',
      updatedAt: 1,
    });

    expect(s.failed).toBe(true);
    expect(s.phase).toBe('failed');
    expect(s.error).toBe('kaboom');
  });

  it('falls back to legacy decomposition when the persisted planes are partial/invalid', () => {
    // Only `desired` is present (no valid `observed`) → the planes are not trustworthy,
    // so rebuild both from the legacy `phase` instead.
    const s = normalizeSessionSnapshot({
      phase: 'recording',
      desired: 'recording',
      runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      updatedAt: 1,
    });

    expect(s.desired).toBe('recording');
    expect(s.observed).toBe('recording'); // reconstructed from legacy phase, not the partial input
    expect(s.phase).toBe('recording');
  });

  it('produces a fully-formed idle session for non-record input', () => {
    const s = normalizeSessionSnapshot(null);
    expect(s.phase).toBe('idle');
    expect(s.desired).toBe('idle');
    expect(s.observed).toBe('idle');
    expect(s.failed).toBe(false);
  });

  it('keeps the control-plane planes out of the popup-facing status view', () => {
    // The popup only ever sees the derived `phase`; the planes it is projected from
    // (and the other control-plane bookkeeping) must never cross the background→popup
    // seam. This locks that boundary so a future field addition cannot leak it.
    const view = toStatusView({
      phase: 'recording',
      desired: 'recording',
      observed: 'recording',
      failed: false,
      runConfig: { storageMode: 'local', micMode: 'off', recordSelfVideo: false },
      epoch: 3,
      targetTabId: 7,
      meetingSlug: 'abc-defg-hij',
      updatedAt: 1,
    });

    expect(view.phase).toBe('recording');
    expect(view).not.toHaveProperty('desired');
    expect(view).not.toHaveProperty('observed');
    expect(view).not.toHaveProperty('failed');
    expect(view).not.toHaveProperty('epoch');
    expect(view).not.toHaveProperty('targetTabId');
    expect(view).not.toHaveProperty('meetingSlug');
  });
});

describe('background upload jobs (ADR-0004)', () => {
  const validJob: UploadJob = {
    id: 'job-1',
    label: 'abc-defg-hij',
    status: 'uploading',
    progress: 0.4,
    files: [{ stream: 'tab', filename: 'tab.webm', status: 'uploading' }],
    startedAt: 1000,
  };

  it('normalizes a valid job list and drops malformed entries', () => {
    const jobs = normalizeUploadJobs([
      validJob,
      { id: '', status: 'uploading' }, // no id → dropped
      { id: 'x', status: 'bogus' }, // bad status → dropped
      { id: 'job-2', status: 'completed', progress: 5, files: 'nope' }, // clamps progress, coerces files
    ]);
    expect(jobs).toHaveLength(2);
    expect(jobs?.[0]).toEqual(validJob);
    expect(jobs?.[1]).toMatchObject({ id: 'job-2', status: 'completed', progress: 1, files: [] });
  });

  it('returns undefined for an empty or non-array list', () => {
    expect(normalizeUploadJobs([])).toBeUndefined();
    expect(normalizeUploadJobs(undefined)).toBeUndefined();
    expect(normalizeUploadJobs('nope')).toBeUndefined();
  });

  it('preserves upload jobs phase-independently, even on an idle snapshot', () => {
    const idle = normalizeSessionSnapshot({ phase: 'idle', uploadJobs: [validJob], updatedAt: 1 });
    expect(idle.phase).toBe('idle');
    // Unlike micMuted/recordedMs, jobs are NOT cleared on idle — they outlive the run.
    expect(idle.uploadJobs).toEqual([validJob]);
  });

  it('hasUploadsInFlight is true only while a job is still uploading', () => {
    expect(hasUploadsInFlight([validJob])).toBe(true);
    expect(hasUploadsInFlight([{ ...validJob, status: 'completed' }])).toBe(false);
    expect(hasUploadsInFlight([])).toBe(false);
    expect(hasUploadsInFlight(undefined)).toBe(false);
  });

  it('projects upload jobs onto the popup-facing status view', () => {
    const view = toStatusView({
      phase: 'recording',
      desired: 'recording',
      observed: 'recording',
      failed: false,
      runConfig: { storageMode: 'drive', micMode: 'off', recordSelfVideo: false },
      uploadJobs: [validJob],
      updatedAt: 1,
    });
    expect(view.uploadJobs).toEqual([validJob]);
  });
});
