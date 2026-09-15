import { AnalysisJobStateOutbox } from '../AnalysisJobStateOutbox';
import type { AnalysisJob } from '../../../shared/analysis/job';

function memoryArea() {
  const store: Record<string, unknown> = {};
  return {
    store,
    getAll: async () => ({ ...store }),
    set: async (items: Record<string, unknown>) => { Object.assign(store, items); },
    remove: async (key: string) => { delete store[key]; },
  };
}

const JOB: AnalysisJob = {
  id: 'ana_1',
  historyId: 'rec_1',
  status: 'completed',
  progress: 1,
  topicCount: 3,
  segmentCount: 5,
  device: 'webgpu',
  startedAt: 1_000,
  finishedAt: 9_000,
};

describe('AnalysisJobStateOutbox', () => {
  it('keys each job separately, so two settling at once cannot clobber each other', async () => {
    const area = memoryArea();
    const outbox = new AnalysisJobStateOutbox(area);

    await Promise.all([
      outbox.put(JOB),
      outbox.put({ ...JOB, id: 'ana_2', historyId: 'rec_2', status: 'failed', error: 'no backend' }),
    ]);

    expect(Object.keys(area.store).sort()).toEqual(['analysisJobState:ana_1', 'analysisJobState:ana_2']);
    expect((await outbox.list()).map((j) => j.id).sort()).toEqual(['ana_1', 'ana_2']);
  });

  it('refuses a job that has not finished, because it could never be acknowledged', async () => {
    const outbox = new AnalysisJobStateOutbox(memoryArea());
    await expect(outbox.put({ ...JOB, status: 'analyzing' })).rejects.toThrow('terminal');
  });

  it('holds the entry until the background acknowledges it', async () => {
    const area = memoryArea();
    const outbox = new AnalysisJobStateOutbox(area);
    await outbox.put(JOB);

    expect(await outbox.list()).toHaveLength(1);
    await outbox.remove(JOB.id);
    expect(await outbox.list()).toEqual([]);
  });

  it('round-trips every field a surface needs to explain the run', async () => {
    const outbox = new AnalysisJobStateOutbox(memoryArea());
    await outbox.put(JOB);
    expect((await outbox.list())[0]).toEqual(JOB);
  });

  it('ignores foreign keys sharing the storage area', async () => {
    const area = memoryArea();
    area.store['terminalUploadState:upl_1'] = { id: 'upl_1', status: 'completed' };
    area.store.recordingSession = { phase: 'idle' };
    const outbox = new AnalysisJobStateOutbox(area);
    await outbox.put(JOB);

    expect((await outbox.list()).map((j) => j.id)).toEqual(['ana_1']);
  });

  it('discards a damaged row rather than replaying it', async () => {
    const area = memoryArea();
    // No id: nothing could ever acknowledge this, so keeping it would leak a key.
    area.store['analysisJobState:broken'] = { historyId: 'rec_9', status: 'completed', startedAt: 1 };
    // Terminal-looking key holding a running job: a partial write, not a result.
    area.store['analysisJobState:ana_3'] = { ...JOB, id: 'ana_3', status: 'analyzing' };
    const outbox = new AnalysisJobStateOutbox(area);
    await outbox.put(JOB);

    expect((await outbox.list()).map((j) => j.id)).toEqual(['ana_1']);
  });
});
