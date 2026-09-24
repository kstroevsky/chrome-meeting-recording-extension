import {
  ShareOriginCleanupCoordinator,
  ShareOriginCleanupStore,
  type ShareOriginCleanupStorageArea,
} from '../ShareOriginCleanupQueue';

function memoryArea(): ShareOriginCleanupStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    getAll: async () => structuredClone(data),
    set: async (items) => { Object.assign(data, structuredClone(items)); },
    remove: async (key) => { delete data[key]; },
  };
}

const descriptor = {
  fileId: 'drive-file',
  revisionId: 'revision-1',
  permissionId: 'permission-1',
};

describe('ShareOriginCleanupCoordinator', () => {
  it('keeps Drive cleanup pending without failing a successful public revoke', async () => {
    const store = new ShareOriginCleanupStore(memoryArea());
    const revokeShare = jest.fn(async () => {
      expect((await store.get('share-1'))?.stage).toBe('server-action');
    });
    const cleanupPermissions = jest.fn()
      .mockRejectedValueOnce(new Error('Drive unavailable'))
      .mockResolvedValueOnce(undefined);
    const coordinator = new ShareOriginCleanupCoordinator({
      store,
      api: {
        getShareDriveOrigins: async () => [descriptor],
        revokeShare,
        deleteShare: async () => {},
      },
      origins: { cleanupPermissions, cleanupPublishedData: async () => {} },
      now: () => 10,
    });

    await expect(coordinator.run('share-1', 'revoke')).resolves.toBeUndefined();
    expect(await store.get('share-1')).toEqual(expect.objectContaining({
      action: 'revoke',
      stage: 'drive-cleanup',
      origins: [descriptor],
    }));

    await coordinator.resumePending();
    expect(await store.get('share-1')).toBeUndefined();
    expect(revokeShare).toHaveBeenCalledTimes(1);
    expect(cleanupPermissions).toHaveBeenCalledTimes(2);
  });

  it('replays an interrupted server delete before releasing Drive publication data', async () => {
    const store = new ShareOriginCleanupStore(memoryArea());
    const deleteShare = jest.fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(undefined);
    const cleanupPublishedData = jest.fn(async () => {});
    const coordinator = new ShareOriginCleanupCoordinator({
      store,
      api: {
        getShareDriveOrigins: async () => [descriptor],
        revokeShare: async () => {},
        deleteShare,
      },
      origins: { cleanupPermissions: async () => {}, cleanupPublishedData },
    });

    await expect(coordinator.run('share-1', 'delete')).rejects.toThrow('lost response');
    expect((await store.get('share-1'))?.stage).toBe('server-action');
    expect(cleanupPublishedData).not.toHaveBeenCalled();

    await coordinator.resumePending();
    expect(deleteShare).toHaveBeenCalledTimes(2);
    expect(cleanupPublishedData).toHaveBeenCalledWith([descriptor]);
    expect(await store.get('share-1')).toBeUndefined();
  });

  it('upgrades a pending revoke to full delete cleanup', async () => {
    const store = new ShareOriginCleanupStore(memoryArea());
    await store.put({
      shareId: 'share-1',
      action: 'revoke',
      stage: 'drive-cleanup',
      origins: [descriptor],
      updatedAt: 1,
    });
    const deleteShare = jest.fn(async () => {});
    const cleanupPublishedData = jest.fn(async () => {});
    const coordinator = new ShareOriginCleanupCoordinator({
      store,
      api: {
        getShareDriveOrigins: async () => { throw new Error('must reuse persisted descriptors'); },
        revokeShare: async () => {},
        deleteShare,
      },
      origins: { cleanupPermissions: async () => {}, cleanupPublishedData },
      now: () => 20,
    });

    await coordinator.run('share-1', 'delete');

    expect(deleteShare).toHaveBeenCalledTimes(1);
    expect(cleanupPublishedData).toHaveBeenCalledWith([descriptor]);
    expect(await store.get('share-1')).toBeUndefined();
  });
});
