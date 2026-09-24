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

const cleanupClaim = {
  ...descriptor,
  candidateId: 'candidate-1',
  leaseId: 'lease-1',
  leaseToken: 'token-1',
  kind: 'permission' as const,
};

describe('ShareOriginCleanupCoordinator', () => {
  it('keeps Drive cleanup pending without failing a successful public revoke', async () => {
    const store = new ShareOriginCleanupStore(memoryArea());
    const revokeShare = jest.fn(async () => {
      expect((await store.get('share-1'))?.stage).toBe('server-action');
    });
    const cleanupDriveClaim = jest.fn()
      .mockRejectedValueOnce(new Error('Drive unavailable'))
      .mockResolvedValueOnce(undefined);
    const completeDriveOriginCleanup = jest.fn(async () => {});
    const coordinator = new ShareOriginCleanupCoordinator({
      store,
      api: {
        getShareDriveOrigins: async () => [descriptor],
        revokeShare,
        deleteShare: async () => {},
        claimDriveOriginCleanup: async () => ({ claims: [cleanupClaim], pending: false }),
        claimPendingDriveOriginCleanup: async () => ({ claims: [], pending: false }),
        completeDriveOriginCleanup,
      },
      origins: { cleanupClaim: cleanupDriveClaim },
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
    expect(cleanupDriveClaim).toHaveBeenCalledTimes(2);
    expect(completeDriveOriginCleanup).toHaveBeenCalledTimes(1);
  });

  it('replays an interrupted server delete before releasing Drive publication data', async () => {
    const store = new ShareOriginCleanupStore(memoryArea());
    const deleteShare = jest.fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(undefined);
    const cleanupDriveClaim = jest.fn(async () => {});
    const completeDriveOriginCleanup = jest.fn(async () => {});
    const coordinator = new ShareOriginCleanupCoordinator({
      store,
      api: {
        getShareDriveOrigins: async () => [descriptor],
        revokeShare: async () => {},
        deleteShare,
        claimDriveOriginCleanup: async () => ({
          claims: [{ ...cleanupClaim, kind: 'revision' as const }],
          pending: false,
        }),
        claimPendingDriveOriginCleanup: async () => ({ claims: [], pending: false }),
        completeDriveOriginCleanup,
      },
      origins: { cleanupClaim: cleanupDriveClaim },
    });

    await expect(coordinator.run('share-1', 'delete')).rejects.toThrow('lost response');
    expect((await store.get('share-1'))?.stage).toBe('server-action');
    expect(cleanupDriveClaim).not.toHaveBeenCalled();

    await coordinator.resumePending();
    expect(deleteShare).toHaveBeenCalledTimes(2);
    expect(cleanupDriveClaim).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'revision',
      fileId: descriptor.fileId,
      revisionId: descriptor.revisionId,
    }));
    expect(completeDriveOriginCleanup).toHaveBeenCalledTimes(1);
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
    const cleanupDriveClaim = jest.fn(async () => {});
    const coordinator = new ShareOriginCleanupCoordinator({
      store,
      api: {
        getShareDriveOrigins: async () => { throw new Error('must reuse persisted descriptors'); },
        revokeShare: async () => {},
        deleteShare,
        claimDriveOriginCleanup: async (_shareId, action) => ({
          claims: action === 'delete' ? [{ ...cleanupClaim, kind: 'revision' as const }] : [],
          pending: false,
        }),
        claimPendingDriveOriginCleanup: async () => ({ claims: [], pending: false }),
        completeDriveOriginCleanup: async () => {},
      },
      origins: { cleanupClaim: cleanupDriveClaim },
      now: () => 20,
    });

    await coordinator.run('share-1', 'delete');

    expect(deleteShare).toHaveBeenCalledTimes(1);
    expect(cleanupDriveClaim).toHaveBeenCalledWith(expect.objectContaining({ kind: 'revision' }));
    expect(await store.get('share-1')).toBeUndefined();
  });

  it('drains server-only cleanup claims that have no local cleanup job', async () => {
    const store = new ShareOriginCleanupStore(memoryArea());
    const claimPendingDriveOriginCleanup = jest.fn()
      .mockResolvedValueOnce({ claims: [cleanupClaim], pending: true })
      .mockResolvedValueOnce({ claims: [], pending: false });
    const cleanupDriveClaim = jest.fn(async () => {});
    const completeDriveOriginCleanup = jest.fn(async () => {});
    const coordinator = new ShareOriginCleanupCoordinator({
      store,
      api: {
        getShareDriveOrigins: async () => [],
        revokeShare: async () => {},
        deleteShare: async () => {},
        claimDriveOriginCleanup: async () => ({ claims: [], pending: false }),
        claimPendingDriveOriginCleanup,
        completeDriveOriginCleanup,
      },
      origins: { cleanupClaim: cleanupDriveClaim },
    });

    await coordinator.drainServerPending();

    expect(await store.list()).toEqual([]);
    expect(cleanupDriveClaim).toHaveBeenCalledWith(cleanupClaim);
    expect(completeDriveOriginCleanup).toHaveBeenCalledWith(cleanupClaim);
    expect(claimPendingDriveOriginCleanup).toHaveBeenCalledTimes(2);
  });

  it('does not spin when pending server cleanup is leased elsewhere', async () => {
    const store = new ShareOriginCleanupStore(memoryArea());
    const claimPendingDriveOriginCleanup = jest.fn(async () => ({ claims: [], pending: true }));
    const coordinator = new ShareOriginCleanupCoordinator({
      store,
      api: {
        getShareDriveOrigins: async () => [],
        revokeShare: async () => {},
        deleteShare: async () => {},
        claimDriveOriginCleanup: async () => ({ claims: [], pending: false }),
        claimPendingDriveOriginCleanup,
        completeDriveOriginCleanup: async () => {},
      },
      origins: { cleanupClaim: async () => {} },
    });

    await coordinator.drainServerPending();

    expect(claimPendingDriveOriginCleanup).toHaveBeenCalledTimes(1);
  });
});
