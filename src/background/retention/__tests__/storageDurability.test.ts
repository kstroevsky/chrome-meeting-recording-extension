import { ensurePersistentStorage, readStorageUsage } from '../storageDurability';

const withStorage = (storage: unknown) => {
  Object.defineProperty(navigator, 'storage', { value: storage, configurable: true });
};

describe('ensurePersistentStorage', () => {
  let log: jest.Mock;
  let warn: jest.Mock;
  beforeEach(() => { log = jest.fn(); warn = jest.fn(); });

  it('does not re-ask once the grant is already held', async () => {
    const persist = jest.fn();
    withStorage({ persisted: async () => true, persist });
    await expect(ensurePersistentStorage(log, warn)).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('requests the grant when it is not held yet', async () => {
    const persist = jest.fn(async () => true);
    withStorage({ persisted: async () => false, persist });
    await expect(ensurePersistentStorage(log, warn)).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('persistence granted'));
  });

  it('does not warn when the grant is refused, because it is not what protects us', async () => {
    // `unlimitedStorage` exempts extension storage from eviction; the
    // StorageManager grant is a separate mechanism and reads false regardless.
    withStorage({ persisted: async () => false, persist: async () => false });
    await expect(ensurePersistentStorage(log, warn)).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unlimitedStorage still exempts'));
  });

  it('survives a browser with no storage manager at all', async () => {
    withStorage(undefined);
    await expect(ensurePersistentStorage(log, warn)).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('survives the request throwing', async () => {
    withStorage({ persisted: async () => false, persist: async () => { throw new Error('nope'); } });
    await expect(ensurePersistentStorage(log, warn)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('Could not request storage persistence:', expect.any(Error));
  });
});

describe('readStorageUsage', () => {
  it('reports the grant, the estimate, and what the library itself holds', async () => {
    withStorage({
      persisted: async () => true,
      estimate: async () => ({ usage: 25_000_000_000, quota: 100_000_000_000 }),
    });
    await expect(readStorageUsage(async () => 23_400_000_000)).resolves.toEqual({
      persisted: true,
      usageBytes: 25_000_000_000,
      quotaBytes: 100_000_000_000,
      retainedBytes: 23_400_000_000,
    });
  });

  it('omits an estimate the browser will not give, rather than reporting zero', async () => {
    // Zero would read as "nothing stored", which is a different claim.
    withStorage({ persisted: async () => false, estimate: async () => { throw new Error('no'); } });
    const usage = await readStorageUsage(async () => 12);
    expect(usage).toEqual({ persisted: false, retainedBytes: 12 });
  });

  it('reports zero retained when the library cannot be read', async () => {
    withStorage({ persisted: async () => true, estimate: async () => ({ usage: 1, quota: 2 }) });
    const usage = await readStorageUsage(async () => { throw new Error('gone'); });
    expect(usage.retainedBytes).toBe(0);
  });
});
