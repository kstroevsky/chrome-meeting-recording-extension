import {
  DEFAULT_RECORDING_RUN_CONFIG,
  createDefaultRunConfig,
  getRunConfigOrDefault,
  isBusyPhase,
  isStoppablePhase,
  normalizeMicMode,
  normalizeUploadSummary,
  normalizeWarnings,
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
