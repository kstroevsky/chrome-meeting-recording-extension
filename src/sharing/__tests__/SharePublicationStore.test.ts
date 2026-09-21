import type { SharePublicationStorageArea } from '../SharePublicationStore';
import { SharePublicationStore } from '../SharePublicationStore';

function memoryArea(): SharePublicationStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    getAll: async () => structuredClone(data),
    set: async (items) => { Object.assign(data, structuredClone(items)); },
    remove: async (key) => { delete data[key]; },
  };
}

const publication = {
  id: 'share-1',
  status: 'draft' as const,
  manifest: { id: 'share-1', createdAt: 1, recordings: [] },
  plans: [],
  sourceRecordingIds: ['private-recording'],
  createdAt: 1,
  updatedAt: 1,
};

describe('SharePublicationStore', () => {
  it('persists and clones long-lived publication state', async () => {
    const area = memoryArea();
    const store = new SharePublicationStore(area);

    await store.put(publication);
    const first = await store.get('share-1');
    expect(first).toEqual(publication);

    first!.sourceRecordingIds.push('mutated');
    expect((await store.get('share-1'))?.sourceRecordingIds).toEqual(['private-recording']);
  });

  it('ignores malformed or mismatched persisted records', async () => {
    const area = memoryArea();
    area.data['sharePublication:wrong'] = {
      ...publication,
      id: 'wrong',
      manifest: { ...publication.manifest, id: 'different' },
    };
    area.data['other:key'] = publication;

    await expect(new SharePublicationStore(area).list()).resolves.toEqual([]);
  });
});
