import {
  PendingUploadStore,
  type PendingUpload,
  type PendingUploadStorageArea,
} from '../src/offscreen/drive/PendingUploadStore';

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
