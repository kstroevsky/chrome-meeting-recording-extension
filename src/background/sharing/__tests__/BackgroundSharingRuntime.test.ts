import { IDBFactory } from 'fake-indexeddb';
import type { OffscreenManager } from '../../offscreen/OffscreenManager';
import { createSharePublicationStore, type SharePublication } from '../../../sharing/SharePublicationStore';
import { BackgroundSharingRuntime } from '../BackgroundSharingRuntime';

function publication(status: SharePublication['status']): SharePublication {
  return {
    id: 'share-1',
    status,
    manifest: { id: 'share-1', createdAt: 1, recordings: [] },
    plans: [],
    sourceRecordingIds: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('BackgroundSharingRuntime', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      writable: true,
      value: new IDBFactory(),
    });
  });

  it('wakes the offscreen drain for a revoked share that may have server-only retention cleanup', async () => {
    await createSharePublicationStore().put(publication('revoked'));
    const ensureReady = jest.fn(async () => {});
    const runtime = new BackgroundSharingRuntime({ ensureReady } as unknown as OffscreenManager);

    await runtime.resumeIfPending();

    expect(ensureReady).toHaveBeenCalledTimes(1);
  });

  it('does not wake sharing recovery for a fully active publication alone', async () => {
    await createSharePublicationStore().put(publication('active'));
    const ensureReady = jest.fn(async () => {});
    const runtime = new BackgroundSharingRuntime({ ensureReady } as unknown as OffscreenManager);

    await runtime.resumeIfPending();

    expect(ensureReady).not.toHaveBeenCalled();
  });
});
