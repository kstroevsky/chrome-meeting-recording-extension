import {
  DEFAULT_RECORDING_RUN_CONFIG,
  createDefaultRunConfig,
  getRunConfigOrDefault,
  isBusyPhase,
  isStoppablePhase,
  normalizeMicMode,
  normalizeSessionSnapshot,
  normalizeUploadSummary,
  normalizeWarnings,
  toStatusView,
} from '../src/shared/recording';

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

  it('treats only active capture phases as stoppable', () => {
    expect((['starting', 'recording', 'stopping'] as const).map(isStoppablePhase)).toEqual([true, true, true]);
    expect((['idle', 'uploading', 'failed'] as const).map(isStoppablePhase)).toEqual([false, false, false]);
  });

  it('treats every non-terminal working phase as busy', () => {
    expect((['starting', 'recording', 'stopping', 'uploading'] as const).map(isBusyPhase)).toEqual([true, true, true, true]);
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
