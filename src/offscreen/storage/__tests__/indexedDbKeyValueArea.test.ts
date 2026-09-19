import { IDBFactory } from 'fake-indexeddb';
import { createIndexedDbKeyValueArea } from '../indexedDbKeyValueArea';

const area = (factory?: IDBFactory) =>
  createIndexedDbKeyValueArea({ databaseName: 'test-area', storeName: 'entries', factory });

describe('createIndexedDbKeyValueArea', () => {
  it('stores, reads back and removes by key', async () => {
    const store = area(new IDBFactory());
    await store.set({ a: { n: 1 }, b: { n: 2 } });

    expect(await store.getAll()).toEqual({ a: { n: 1 }, b: { n: 2 } });
    await store.remove('a');
    expect(await store.getAll()).toEqual({ b: { n: 2 } });
  });

  it('shares its data across separate areas over one database', async () => {
    // The property the offscreen document needs: what it writes, the service
    // worker and extension pages read.
    const factory = new IDBFactory();
    await area(factory).set({ a: 1 });
    expect(await area(factory).getAll()).toEqual({ a: 1 });
  });

  it('removing an absent key succeeds', async () => {
    const store = area(new IDBFactory());
    await expect(store.remove('missing')).resolves.toBeUndefined();
  });

  it('opens the database once, however many operations run', async () => {
    const factory = new IDBFactory();
    const open = jest.spyOn(factory, 'open');
    const store = createIndexedDbKeyValueArea({ databaseName: 'once', storeName: 'entries', factory });

    await Promise.all([store.set({ a: 1 }), store.set({ b: 2 }), store.getAll()]);
    await store.getAll();

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('holds nothing and fails nothing where IndexedDB does not exist', async () => {
    const store = area(undefined);
    await expect(store.set({ a: 1 })).resolves.toBeUndefined();
    expect(await store.getAll()).toEqual({});
  });

  it('rejects a failing write rather than reporting success', async () => {
    const broken = {
      open: () => {
        const request: any = {};
        setTimeout(() => { request.error = new Error('disk I/O error'); request.onerror?.(); }, 0);
        return request;
      },
    } as unknown as IDBFactory;

    await expect(area(broken).set({ a: 1 })).rejects.toThrow('disk I/O error');
  });
});
