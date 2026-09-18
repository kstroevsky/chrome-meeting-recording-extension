import { IDBFactory } from 'fake-indexeddb';
import { UploadJobStateOutbox, type UploadJobStateStorageArea } from '../UploadJobStateOutbox';
import { createIndexedDbKeyValueArea } from '../../storage/indexedDbKeyValueArea';

function fakeArea() {
  const data: Record<string, unknown> = {};
  const area: UploadJobStateStorageArea & { data: Record<string, unknown> } = {
    data,
    getAll: async () => ({ ...data }),
    set: async (items) => { Object.assign(data, items); },
    remove: async (key) => { delete data[key]; },
  };
  return area;
}

const terminalJob = {
  id: 'job-1',
  historyId: 'recording:1',
  label: 'Meeting',
  status: 'completed' as const,
  progress: 1,
  files: [{ stream: 'tab' as const, filename: 'tab.webm', status: 'uploaded' as const }],
  startedAt: 1,
  finishedAt: 2,
};

describe('UploadJobStateOutbox', () => {
  it('persists a terminal job until the background acknowledges it', async () => {
    const area = fakeArea();
    const outbox = new UploadJobStateOutbox(area);

    await outbox.put(terminalJob);
    expect(await outbox.list()).toEqual([terminalJob]);

    await outbox.remove('job-1');
    expect(await outbox.list()).toEqual([]);
  });
});

describe('the store the offscreen document can actually write', () => {
  /**
   * ADR-0004's durability was written against `chrome.storage.local`, which the
   * offscreen document does not have — and `platform/chrome/storage.ts`
   * deliberately degrades to a no-op instead of throwing, so every write
   * silently succeeded and stored nothing. These pin the replacement.
   */
  const area = (factory: IDBFactory) =>
    createIndexedDbKeyValueArea({ databaseName: 'upload-job-outbox', storeName: 'jobs', factory });

  it('round-trips a terminal job through IndexedDB', async () => {
    const factory = new IDBFactory();
    await new UploadJobStateOutbox(area(factory)).put(terminalJob);

    expect(await new UploadJobStateOutbox(area(factory)).list()).toEqual([terminalJob]);
  });

  it('survives the document that wrote it — that is the whole point', async () => {
    // A fresh area over the same database is what a restarted offscreen
    // document sees, and what background replays from after a worker death.
    const factory = new IDBFactory();
    await new UploadJobStateOutbox(area(factory)).put(terminalJob);
    await new UploadJobStateOutbox(area(factory)).remove('job-1');

    expect(await new UploadJobStateOutbox(area(factory)).list()).toEqual([]);
  });

  it('keeps concurrent settlements apart, one key per job', async () => {
    const factory = new IDBFactory();
    const outbox = new UploadJobStateOutbox(area(factory));
    await Promise.all([
      outbox.put(terminalJob),
      outbox.put({ ...terminalJob, id: 'job-2', status: 'failed' as const }),
    ]);

    expect((await outbox.list()).map((job) => job.id).sort()).toEqual(['job-1', 'job-2']);
  });

  it('reports a failing store instead of pretending the write happened', async () => {
    // The defect this replaces was silence. A real failure must be visible, so
    // a caller can hold the state and retry rather than assume it is durable.
    const broken = {
      open: () => {
        const request: any = {};
        setTimeout(() => { request.error = new Error('disk I/O error'); request.onerror?.(); }, 0);
        return request;
      },
    } as unknown as IDBFactory;

    await expect(new UploadJobStateOutbox(area(broken)).put(terminalJob)).rejects.toThrow('disk I/O error');
  });
});
