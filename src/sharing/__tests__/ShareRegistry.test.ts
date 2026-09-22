import type { SharePublicationStorageArea } from '../SharePublicationStore';
import { SharePublicationStore, type SharePublication } from '../SharePublicationStore';
import { ShareRegistry } from '../ShareRegistry';
import type { RemoteShare, ShareRegistryApi } from '../ShareServiceClient';

function memoryArea(): SharePublicationStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    getAll: async () => structuredClone(data),
    set: async (items) => { Object.assign(data, structuredClone(items)); },
    remove: async (key) => { delete data[key]; },
  };
}

function local(overrides: Partial<SharePublication> = {}): SharePublication {
  return {
    id: 'share-1',
    status: 'failed',
    manifest: { id: 'share-1', createdAt: 1, recordings: [] },
    plans: [],
    sourceRecordingIds: ['private-recording'],
    resumeFrom: 'finalizing',
    error: 'response lost',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function remote(overrides: Partial<RemoteShare> = {}): RemoteShare {
  return {
    id: 'share-1',
    status: 'active',
    manifest: { id: 'share-1', createdAt: 1, recordings: [] },
    createdAt: 1,
    updatedAt: 5,
    finalizedAt: 5,
    shareUrl: 'https://share.example/s/viewer-capability',
    ...overrides,
  };
}

function api(shares: RemoteShare[]): ShareRegistryApi {
  return {
    listShares: async () => structuredClone(shares),
    getShare: async (shareId) => {
      const share = shares.find((entry) => entry.id === shareId);
      if (!share) throw new Error('missing');
      return structuredClone(share);
    },
  };
}

describe('ShareRegistry', () => {
  it('repairs a lost finalization response from authoritative active state', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(local());

    const snapshot = await new ShareRegistry(api([remote()]), store).refresh();

    expect(snapshot.local[0]).toMatchObject({
      id: 'share-1',
      status: 'active',
      shareUrl: 'https://share.example/s/viewer-capability',
      updatedAt: 5,
    });
    expect(snapshot.local[0].resumeFrom).toBeUndefined();
    expect(snapshot.local[0].error).toBeUndefined();
  });

  it('observes revocation performed by another owner session', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(local({
      status: 'active',
      resumeFrom: undefined,
      error: undefined,
      shareUrl: 'https://share.example/s/old-capability',
    }));
    const revoked = remote({
      status: 'revoked',
      shareUrl: undefined,
      revokedAt: 8,
      updatedAt: 8,
    });

    const result = await new ShareRegistry(api([revoked]), store).refreshOne('share-1');

    expect(result.local).toMatchObject({ status: 'revoked', updatedAt: 8 });
  });

  it('preserves pending local revocation while the backend still reports active', async () => {
    const store = new SharePublicationStore(memoryArea());
    const pending = local({ status: 'failed', resumeFrom: 'revoking', error: 'offline' });
    await store.put(pending);

    await new ShareRegistry(api([remote()]), store).refresh();

    expect(await store.get('share-1')).toEqual(pending);
  });

  it('returns remote-only shares without inventing resumable local state', async () => {
    const store = new SharePublicationStore(memoryArea());
    const other = remote({ id: 'share-remote', manifest: { id: 'share-remote', createdAt: 9, recordings: [] } });

    const snapshot = await new ShareRegistry(api([other]), store).refresh();

    expect(snapshot.remote).toEqual([other]);
    expect(snapshot.local).toEqual([]);
  });
});
