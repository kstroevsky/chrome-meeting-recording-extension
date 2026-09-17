import { IDBFactory } from 'fake-indexeddb';
import {
  acknowledgeAnalysisJob,
  sealAnalysisJob,
  SEAL_ATTEMPTS,
  AnalysisJobStateOutbox,
  createIndexedDbAnalysisJobStateArea,
} from '../AnalysisJobStateOutbox';
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

describe('the IndexedDB storage area', () => {
  /**
   * Why this exists: an offscreen document has no `chrome.storage` — its
   * `chrome` object is `runtime` only. The outbox used `chrome.storage.local`
   * and silently wrote nothing. IndexedDB is shared by the whole extension
   * origin, so it works in the offscreen document and is readable elsewhere.
   */
  const outbox = (factory = new IDBFactory()) =>
    ({ factory, outbox: new AnalysisJobStateOutbox(createIndexedDbAnalysisJobStateArea(factory)) });

  it('round-trips a terminal job', async () => {
    const { outbox: box } = outbox();
    await box.put(JOB);
    expect(await box.list()).toEqual([JOB]);
  });

  it('survives a reopen — it is durable, not a cache', async () => {
    const factory = new IDBFactory();
    await outbox(factory).outbox.put(JOB);

    // A fresh area over the same database: what a restarted document sees.
    expect(await outbox(factory).outbox.list()).toEqual([JOB]);
  });

  it('keeps two jobs settling at once', async () => {
    const { outbox: box } = outbox();
    await Promise.all([
      box.put(JOB),
      box.put({ ...JOB, id: 'ana_2', historyId: 'rec_2', status: 'failed', error: 'no backend' }),
    ]);
    expect((await box.list()).map((j) => j.id).sort()).toEqual(['ana_1', 'ana_2']);
  });

  it('removes on acknowledgement, and tolerates acknowledging twice', async () => {
    const { outbox: box } = outbox();
    await box.put(JOB);
    await box.remove(JOB.id);
    // A replayed acknowledgement after a reconnect must not fail.
    await expect(box.remove(JOB.id)).resolves.toBeUndefined();
    expect(await box.list()).toEqual([]);
  });

  it('holds nothing and fails nothing where IndexedDB does not exist', async () => {
    // No store means no durable row for a held result to disagree with, so an
    // acknowledgement must still be able to release that result.
    const box = new AnalysisJobStateOutbox(createIndexedDbAnalysisJobStateArea(undefined));
    await expect(box.put(JOB)).resolves.toBeUndefined();
    await expect(box.remove(JOB.id)).resolves.toBeUndefined();
    expect(await box.list()).toEqual([]);
  });

  it('reports a store that exists but fails, so the caller can hold on', async () => {
    const broken = {
      open: () => {
        const request: any = {};
        setTimeout(() => { request.error = new Error('disk I/O error'); request.onerror?.(); }, 0);
        return request;
      },
    } as unknown as IDBFactory;
    const box = new AnalysisJobStateOutbox(createIndexedDbAnalysisJobStateArea(broken));
    await expect(box.remove(JOB.id)).rejects.toThrow('disk I/O error');
  });
});

describe('acknowledgeAnalysisJob', () => {
  it('releases the durable row before the held result', async () => {
    const order: string[] = [];
    const released = await acknowledgeAnalysisJob(
      { remove: async () => { order.push('row'); } },
      { acknowledge: () => { order.push('result'); } },
      'ana_1',
    );
    expect(released).toBe(true);
    expect(order).toEqual(['row', 'result']);
  });

  it('keeps the result when the row cannot be removed', async () => {
    // The P1 this pins: releasing the result first left a `completed` row with
    // nothing behind it, which a reconnect would treat as a lost result and
    // recompute from scratch.
    const acknowledge = jest.fn();
    const warn = jest.fn();
    const released = await acknowledgeAnalysisJob(
      { remove: async () => { throw new Error('disk I/O error'); } },
      { acknowledge },
      'ana_1',
      warn,
    );
    expect(released).toBe(false);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('sealing a terminal state', () => {
  /** No real waiting; the point is that the attempts happen, not how long they take. */
  const delay = async () => {};

  it('drives its own retries without needing a reconnect', async () => {
    // The bug this pins: attempts used to be counted across call sites, one per
    // report and one per delivery, with the third left to a later reconnect. On
    // a healthy, continuously connected port that third attempt never came — so
    // the result was held forever and the runtime stayed busy behind it.
    let calls = 0;
    const outbox = {
      put: async () => {
        calls += 1;
        if (calls < 3) throw new Error('disk I/O error');
      },
    };

    await expect(sealAnalysisJob(outbox, JOB, { delay })).resolves.toBe(true);
    expect(calls).toBe(3);
  });

  it('gives up after its bound, rather than retrying a broken store forever', async () => {
    let calls = 0;
    const outbox = { put: async () => { calls += 1; throw new Error('disk I/O error'); } };

    await expect(sealAnalysisJob(outbox, JOB, { delay })).resolves.toBe(false);
    expect(calls).toBe(SEAL_ATTEMPTS);
  });

  it('waits between attempts, and not after the last one', async () => {
    const waits: number[] = [];
    const outbox = { put: async () => { throw new Error('nope'); } };

    await sealAnalysisJob(outbox, JOB, { delay: async (ms) => { waits.push(ms); } });
    expect(waits).toHaveLength(SEAL_ATTEMPTS - 1);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });


});
