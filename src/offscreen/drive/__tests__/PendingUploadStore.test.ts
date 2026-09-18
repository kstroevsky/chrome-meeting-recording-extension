import { IDBFactory } from 'fake-indexeddb';
import { createIndexedDbKeyValueArea } from '../../storage/indexedDbKeyValueArea';
import {
  PendingUploadStore,
  type PendingUpload,
  type PendingUploadStorageArea,
} from '../PendingUploadStore';

function fakeArea() {
  const data: Record<string, unknown> = {};
  const area: PendingUploadStorageArea & { data: Record<string, unknown> } = {
    data,
    getAll: async () => ({ ...data }),
    set: async (items) => { Object.assign(data, items); },
    remove: async (key) => { delete data[key]; },
  };
  return area;
}

const entry = (opfsFilename: string): PendingUpload => ({
  opfsFilename,
  filename: opfsFilename,
  stream: 'tab',
  recordingFolderName: 'google-meet-folder',
});

describe('PendingUploadStore', () => {
  it('puts entries under prefix-namespaced keys and lists them back', async () => {
    const area = fakeArea();
    const store = new PendingUploadStore(area);

    await store.put(entry('a.webm'));
    await store.put(entry('b.webm'));

    expect(Object.keys(area.data).every((k) => k.startsWith('pendingDriveUpload:'))).toBe(true);
    const list = await store.list();
    expect(list.map((e) => e.opfsFilename).sort()).toEqual(['a.webm', 'b.webm']);
  });

  it('removes one entry without disturbing the others', async () => {
    const store = new PendingUploadStore(fakeArea());
    await store.put(entry('a.webm'));
    await store.put(entry('b.webm'));

    await store.remove('a.webm');

    const list = await store.list();
    expect(list.map((e) => e.opfsFilename)).toEqual(['b.webm']);
  });

  it('ignores unrelated storage keys and malformed marker values', async () => {
    const area = fakeArea();
    area.data['perfSettings'] = { concurrency: 2 };
    area.data['pendingDriveUpload:corrupt'] = { opfsFilename: 123 };
    const store = new PendingUploadStore(area);

    await store.put(entry('good.webm'));

    const list = await store.list();
    expect(list.map((e) => e.opfsFilename)).toEqual(['good.webm']);
  });

  it('returns an empty list when nothing is pending', async () => {
    const store = new PendingUploadStore(fakeArea());
    expect(await store.list()).toEqual([]);
  });
});

describe('the store the offscreen document can actually write', () => {
  /**
   * A marker exists so a crash mid-upload is recoverable on the next launch.
   * Written against `chrome.storage.local` — absent in an offscreen document,
   * and no-opped rather than thrown by `platform/chrome/storage.ts` — every
   * marker was silently discarded, so no interrupted upload was ever
   * recoverable while the code read as though they were.
   */
  const area = (factory: IDBFactory) =>
    createIndexedDbKeyValueArea({ databaseName: 'pending-drive-uploads', storeName: 'markers', factory });

  it('leaves a marker the next launch can find', async () => {
    const factory = new IDBFactory();
    await new PendingUploadStore(area(factory)).put(entry('staging/tab.webm'));

    // A fresh store over the same database is the next launch.
    expect(await new PendingUploadStore(area(factory)).list())
      .toEqual([entry('staging/tab.webm')]);
  });

  it('clears a marker once its upload finishes', async () => {
    const factory = new IDBFactory();
    const store = new PendingUploadStore(area(factory));
    await store.put(entry('staging/tab.webm'));
    await store.remove('staging/tab.webm');

    expect(await new PendingUploadStore(area(factory)).list()).toEqual([]);
  });

  it('keeps one key per file, so concurrent uploads cannot lose each other', async () => {
    const factory = new IDBFactory();
    const store = new PendingUploadStore(area(factory));
    await Promise.all([
      store.put(entry('staging/tab.webm')),
      store.put(entry('staging/mic.webm')),
    ]);
    await store.remove('staging/tab.webm');

    expect((await store.list()).map((marker) => marker.opfsFilename)).toEqual(['staging/mic.webm']);
  });

  it('reports a failing store rather than pretending the marker was written', async () => {
    const broken = {
      open: () => {
        const request: any = {};
        setTimeout(() => { request.error = new Error('disk I/O error'); request.onerror?.(); }, 0);
        return request;
      },
    } as unknown as IDBFactory;

    await expect(new PendingUploadStore(area(broken)).put(entry('staging/tab.webm')))
      .rejects.toThrow('disk I/O error');
  });
});
