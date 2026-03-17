import {
  DEFAULT_RECORDING_RUN_CONFIG,
  createDefaultRunConfig,
  getRunConfigOrDefault,
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
