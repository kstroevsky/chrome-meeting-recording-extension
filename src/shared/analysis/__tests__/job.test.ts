import { isTerminalAnalysisJob, normalizeAnalysisJob, type AnalysisJob } from '../job';

const JOB: AnalysisJob = {
  id: 'ana_1',
  historyId: 'rec_1',
  status: 'completed',
  progress: 1,
  windowsTotal: 45,
  windowsEncoded: 45,
  topicCount: 3,
  segmentCount: 5,
  device: 'webgpu',
  startedAt: 1_000,
  finishedAt: 9_000,
};

describe('isTerminalAnalysisJob', () => {
  it('treats every stopped state as terminal and only `analyzing` as running', () => {
    expect(isTerminalAnalysisJob({ ...JOB, status: 'analyzing' })).toBe(false);
    for (const status of ['completed', 'failed', 'canceled', 'unsupported'] as const) {
      expect(isTerminalAnalysisJob({ ...JOB, status })).toBe(true);
    }
  });
});

describe('normalizeAnalysisJob', () => {
  it('round-trips a complete job', () => {
    expect(normalizeAnalysisJob(JSON.parse(JSON.stringify(JOB)))).toEqual(JOB);
  });

  it('discards a row that could never be acknowledged', () => {
    expect(normalizeAnalysisJob(undefined)).toBeUndefined();
    expect(normalizeAnalysisJob('ana_1')).toBeUndefined();
    expect(normalizeAnalysisJob({ ...JOB, id: '' })).toBeUndefined();
    expect(normalizeAnalysisJob({ ...JOB, id: '   ' })).toBeUndefined();
    expect(normalizeAnalysisJob({ ...JOB, historyId: undefined })).toBeUndefined();
    expect(normalizeAnalysisJob({ ...JOB, status: 'uploading' })).toBeUndefined();
    expect(normalizeAnalysisJob({ ...JOB, startedAt: 'soon' })).toBeUndefined();
  });

  it('keeps an addressable job whose reporting fields are damaged', () => {
    // A broken progress number must not cost the background the knowledge that
    // this run finished.
    const recovered = normalizeAnalysisJob({
      ...JOB,
      progress: Number.NaN,
      windowsTotal: -4,
      topicCount: 'three',
      device: 'cuda',
      error: '   ',
    });

    expect(recovered).toMatchObject({ id: 'ana_1', status: 'completed', progress: 0 });
    expect(recovered?.windowsTotal).toBeUndefined();
    expect(recovered?.topicCount).toBeUndefined();
    expect(recovered?.device).toBeUndefined();
    expect(recovered?.error).toBeUndefined();
  });

  it('clamps a progress fraction into [0, 1]', () => {
    expect(normalizeAnalysisJob({ ...JOB, progress: 4 })?.progress).toBe(1);
    expect(normalizeAnalysisJob({ ...JOB, progress: -2 })?.progress).toBe(0);
    expect(normalizeAnalysisJob({ ...JOB, progress: 0.5 })?.progress).toBe(0.5);
  });

  it('omits absent optional fields rather than writing undefined into storage', () => {
    const minimal = normalizeAnalysisJob({ id: 'a', historyId: 'r', status: 'failed', startedAt: 1 });
    expect(Object.keys(minimal!).sort()).toEqual(['historyId', 'id', 'progress', 'startedAt', 'status']);
  });

  it('keeps the lost-result marker, and only when it is exactly true', () => {
    expect(normalizeAnalysisJob({ ...JOB, status: 'failed', lostResult: true })?.lostResult).toBe(true);
    // A truthy non-boolean is not the marker: it would trigger a re-run.
    expect(normalizeAnalysisJob({ ...JOB, status: 'failed', lostResult: 'yes' })?.lostResult).toBeUndefined();
    expect(normalizeAnalysisJob({ ...JOB, status: 'failed' })?.lostResult).toBeUndefined();
  });
});