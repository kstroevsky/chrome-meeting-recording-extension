import type { PlaybackTrack } from '../../shared/playback';
import type { PublishedRecordingPlan } from '../PublishedManifestBuilder';
import { SharePublicationCoordinator } from '../SharePublicationCoordinator';
import {
  SharePublicationStore,
  type SharePublication,
  type SharePublicationStorageArea,
} from '../SharePublicationStore';

function memoryArea(): SharePublicationStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    getAll: async () => structuredClone(data),
    set: async (items) => { Object.assign(data, structuredClone(items)); },
    remove: async (key) => { delete data[key]; },
  };
}

function sourceTrack(): PlaybackTrack {
  return {
    fileId: 'private-file-id',
    stream: 'tab',
    filename: 'private.webm',
    mimeType: 'video/webm',
    bytes: 10,
    captureStartOffsetMs: 0,
    sources: [{ kind: 'opfs', key: 'library/private-history/tab.webm' }],
  };
}

function plan(): PublishedRecordingPlan {
  const published = {
    id: 'public-track',
    stream: 'tab' as const,
    mimeType: 'video/webm',
    bytes: 10,
    captureStartOffsetMs: 0,
    mediaEndpoint: '/media/recordings/public-recording/tracks/public-track',
  };
  return {
    sourceRecordingId: 'private-history',
    recording: {
      id: 'public-recording',
      title: 'Demo',
      createdAt: 1,
      tracks: [published],
      downloadsEnabled: false,
    },
    tracks: [{ source: sourceTrack(), published }],
  };
}

function publication(status: SharePublication['status'], overrides: Partial<SharePublication> = {}): SharePublication {
  const plans = [plan()];
  return {
    id: 'share-control-id',
    status,
    manifest: {
      id: 'share-control-id',
      createdAt: 2,
      recordings: plans.map((entry) => structuredClone(entry.recording)),
    },
    plans,
    sourceRecordingIds: ['private-history'],
    createdAt: 2,
    updatedAt: 2,
    ...overrides,
  };
}

describe('SharePublicationCoordinator', () => {
  it('persists the complete publication before the first request and advances durable phases', async () => {
    const store = new SharePublicationStore(memoryArea());
    const calls: string[] = [];
    const createShare = jest.fn(async (publicManifest) => {
      calls.push('create');
      expect((await store.get('share-control-id'))?.status).toBe('draft');
      expect(JSON.stringify(publicManifest)).not.toContain('private-history');
      expect(JSON.stringify(publicManifest)).not.toContain('private-file-id');
      expect(JSON.stringify(publicManifest)).not.toContain('library/');
    });
    const upload = jest.fn(async (shareId, plans) => {
      calls.push('upload');
      expect(shareId).toBe('share-control-id');
      expect((await store.get(shareId))?.status).toBe('uploading');
      expect(plans[0].recording.id).toBe('public-recording');
      expect(plans[0].tracks[0].source.fileId).toBe('private-file-id');
    });
    const finalizeShare = jest.fn(async (shareId) => {
      calls.push('finalize');
      expect((await store.get(shareId))?.status).toBe('finalizing');
      return { shareUrl: 'https://watch.example/s/q4fB9-independent-capability' };
    });
    const clearShare = jest.fn(async (shareId) => {
      calls.push('clear');
      expect((await store.get(shareId))?.status).toBe('active');
    });
    const coordinator = new SharePublicationCoordinator({
      store,
      api: { createShare, finalizeShare, revokeShare: async () => {} },
      uploads: { upload, clearShare },
      now: (() => { let value = 10; return () => value++; })(),
    });

    const input = publication('draft');
    const result = await coordinator.publishNew({ manifest: input.manifest, plans: input.plans });

    expect(calls).toEqual(['create', 'upload', 'finalize', 'clear']);
    expect(result).toMatchObject({
      id: 'share-control-id',
      status: 'active',
      shareUrl: 'https://watch.example/s/q4fB9-independent-capability',
    });
    expect(await store.get('share-control-id')).toEqual(result);
  });

  it('resumes an interrupted upload with the same persisted share, recording and track ids', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(publication('uploading'));
    const createShare = jest.fn(async () => {});
    const upload = jest.fn(async () => {});
    const finalizeShare = jest.fn(async () => ({ shareUrl: 'https://watch.example/s/viewer-token' }));
    const coordinator = new SharePublicationCoordinator({
      store,
      api: { createShare, finalizeShare, revokeShare: async () => {} },
      uploads: { upload, clearShare: async () => {} },
    });

    const [result] = await coordinator.resumePending();

    expect(createShare).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledWith('share-control-id', [expect.objectContaining({
      sourceRecordingId: 'private-history',
      recording: expect.objectContaining({ id: 'public-recording' }),
      tracks: [expect.objectContaining({ published: expect.objectContaining({ id: 'public-track' }) })],
    })]);
    expect(result.status).toBe('active');
  });

  it('replays idempotent finalization after its response is lost', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(publication('finalizing'));
    let finalizedOnServer = false;
    const finalizeShare = jest.fn(async () => {
      if (!finalizedOnServer) {
        finalizedOnServer = true;
        throw new Error('response lost');
      }
      return { shareUrl: 'https://watch.example/s/stable-viewer-token' };
    });
    const deps = {
      store,
      api: { createShare: async () => {}, finalizeShare, revokeShare: async () => {} },
      uploads: { upload: async () => {}, clearShare: jest.fn(async () => {}) },
    };
    const first = new SharePublicationCoordinator(deps);

    await expect(first.resume((await store.get('share-control-id'))!)).rejects.toThrow('response lost');
    expect(await store.get('share-control-id')).toMatchObject({ status: 'failed', resumeFrom: 'finalizing' });

    const [recovered] = await new SharePublicationCoordinator(deps).resumePending();
    expect(finalizeShare).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({
      status: 'active',
      shareUrl: 'https://watch.example/s/stable-viewer-token',
    });
  });

  it('cleans leftover temporary upload jobs for an already-active publication', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(publication('active', { shareUrl: 'https://watch.example/s/token' }));
    const clearShare = jest.fn(async () => {});
    const coordinator = new SharePublicationCoordinator({
      store,
      api: {
        createShare: async () => {},
        finalizeShare: async () => ({ shareUrl: 'unused' }),
        revokeShare: async () => {},
      },
      uploads: { upload: async () => {}, clearShare },
    });

    await coordinator.resumePending();

    expect(clearShare).toHaveBeenCalledWith('share-control-id');
  });

  it('keeps an active publication active when temporary upload cleanup fails', async () => {
    const store = new SharePublicationStore(memoryArea());
    const coordinator = new SharePublicationCoordinator({
      store,
      api: {
        createShare: async () => {},
        finalizeShare: async () => ({ shareUrl: 'https://watch.example/s/token' }),
        revokeShare: async () => {},
      },
      uploads: {
        upload: async () => {},
        clearShare: async () => { throw new Error('IndexedDB cleanup failed'); },
      },
    });
    const input = publication('draft');

    const result = await coordinator.publishNew({ manifest: input.manifest, plans: input.plans });

    expect(result.status).toBe('active');
    expect((await store.get(result.id))?.status).toBe('active');
  });

  it('continues startup recovery after one publication fails', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(publication('uploading'));
    await store.put(publication('finalizing', {
      id: 'share-2',
      manifest: { id: 'share-2', createdAt: 3, recordings: [] },
      plans: [],
      sourceRecordingIds: [],
    }));
    const coordinator = new SharePublicationCoordinator({
      store,
      api: {
        createShare: async () => {},
        finalizeShare: async (shareId) => ({ shareUrl: `https://watch.example/s/${shareId}-viewer` }),
        revokeShare: async () => {},
      },
      uploads: {
        upload: async (shareId) => { if (shareId === 'share-control-id') throw new Error('source missing'); },
        clearShare: async () => {},
      },
    });

    const outcomes = await coordinator.resumePending();

    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'share-control-id', status: 'failed', resumeFrom: 'uploading' }),
      expect.objectContaining({ id: 'share-2', status: 'active' }),
    ]));
  });

  it('persists revoking before the remote revoke and only then marks the share revoked', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(publication('active', { shareUrl: 'https://watch.example/s/token' }));
    const calls: string[] = [];
    const revokeShare = jest.fn(async (shareId) => {
      calls.push('revoke');
      expect(shareId).toBe('share-control-id');
      expect((await store.get(shareId))?.status).toBe('revoking');
    });
    const clearShare = jest.fn(async (shareId) => {
      calls.push('clear');
      expect((await store.get(shareId))?.status).toBe('revoked');
    });
    const coordinator = new SharePublicationCoordinator({
      store,
      api: {
        createShare: async () => {},
        finalizeShare: async () => ({ shareUrl: 'unused' }),
        revokeShare,
      },
      uploads: { upload: async () => {}, clearShare },
    });

    const result = await coordinator.revoke('share-control-id');

    expect(calls).toEqual(['revoke', 'clear']);
    expect(result.status).toBe('revoked');
    expect(await store.get('share-control-id')).toEqual(result);
  });

  it('resumes a revocation left in progress by a browser restart', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(publication('revoking', { shareUrl: 'https://watch.example/s/token' }));
    const revokeShare = jest.fn(async () => {});
    const coordinator = new SharePublicationCoordinator({
      store,
      api: {
        createShare: async () => {},
        finalizeShare: async () => ({ shareUrl: 'unused' }),
        revokeShare,
      },
      uploads: { upload: async () => {}, clearShare: async () => {} },
    });

    const [result] = await coordinator.resumePending();

    expect(revokeShare).toHaveBeenCalledWith('share-control-id');
    expect(result.status).toBe('revoked');
  });

  it('persists failed revocation for retry and resumes it later', async () => {
    const store = new SharePublicationStore(memoryArea());
    await store.put(publication('active', { shareUrl: 'https://watch.example/s/token' }));
    let fail = true;
    const revokeShare = jest.fn(async () => {
      if (fail) throw new Error('revoke response lost');
    });
    const deps = {
      store,
      api: {
        createShare: async () => {},
        finalizeShare: async () => ({ shareUrl: 'unused' }),
        revokeShare,
      },
      uploads: { upload: async () => {}, clearShare: async () => {} },
    };
    const coordinator = new SharePublicationCoordinator(deps);

    await expect(coordinator.revoke('share-control-id')).rejects.toThrow('revoke response lost');
    expect(await store.get('share-control-id')).toMatchObject({
      status: 'failed',
      resumeFrom: 'revoking',
      error: 'revoke response lost',
    });

    fail = false;
    const [result] = await new SharePublicationCoordinator(deps).resumePending();
    expect(revokeShare).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('revoked');
  });

  it('treats an already revoked publication as an idempotent local success', async () => {
    const store = new SharePublicationStore(memoryArea());
    const existing = publication('revoked', { shareUrl: 'https://watch.example/s/token' });
    await store.put(existing);
    const revokeShare = jest.fn(async () => {});
    const coordinator = new SharePublicationCoordinator({
      store,
      api: {
        createShare: async () => {},
        finalizeShare: async () => ({ shareUrl: 'unused' }),
        revokeShare,
      },
      uploads: { upload: async () => {}, clearShare: async () => {} },
    });

    await expect(coordinator.revoke('share-control-id')).resolves.toEqual(existing);
    expect(revokeShare).not.toHaveBeenCalled();
  });
});
