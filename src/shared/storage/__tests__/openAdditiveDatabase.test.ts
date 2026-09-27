/**
 * Every case here is a real profile: one database, touched in turn by builds
 * from different branches. What matters is that each build opens it with its
 * own stores present and nobody's rows lost.
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { hasStores, openAdditiveDatabase, type AdditiveDatabaseSchema } from '../openAdditiveDatabase';

const NAME = 'recording-history';

/** A build: a version number and the stores it needs. */
const build = (version: number, stores: string[]): AdditiveDatabaseSchema => ({
  name: NAME,
  version,
  upgrade: (database) => {
    for (const store of stores) {
      if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: 'id' });
    }
  },
  isSatisfied: (database) => hasStores(database, stores),
});

const put = (database: IDBDatabase, store: string, value: { id: string }) => new Promise<void>((resolve, reject) => {
  const transaction = database.transaction(store, 'readwrite');
  transaction.objectStore(store).put(value);
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
});
const getAll = (database: IDBDatabase, store: string) => new Promise<unknown[]>((resolve, reject) => {
  const request = database.transaction(store, 'readonly').objectStore(store).getAll();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const storesOf = (database: IDBDatabase) => Array.from({ length: database.objectStoreNames.length }, (_, i) => database.objectStoreNames.item(i)!).sort();

const STABLE = build(6, ['recordings', 'notations', 'transcripts', 'analyses']);
const EXPERIMENT = build(7, ['recordings', 'notations', 'transcripts', 'analyses', 'recordingContexts']);

describe('opening a database other builds have touched', () => {
  let factory: IDBFactory;
  beforeEach(() => { factory = new IDBFactory(); });

  it('creates and upgrades as usual when the profile is new or older', async () => {
    const database = await openAdditiveDatabase(factory, STABLE);
    expect(database.version).toBe(6);
    expect(storesOf(database)).toEqual(['analyses', 'notations', 'recordings', 'transcripts']);
    database.close();
  });

  it('lets an older build open a database a newer build upgraded, rows intact', async () => {
    const experimental = await openAdditiveDatabase(factory, EXPERIMENT);
    await put(experimental, 'recordings', { id: 'recording:1' });
    experimental.close();

    // Before: VersionError, and the library read as empty.
    const stable = await openAdditiveDatabase(factory, STABLE);
    expect(stable.version).toBe(7);
    expect(await getAll(stable, 'recordings')).toEqual([{ id: 'recording:1' }]);
    await put(stable, 'recordings', { id: 'recording:2' });
    stable.close();

    // And the newer build still finds its own store afterwards.
    const again = await openAdditiveDatabase(factory, EXPERIMENT);
    expect(storesOf(again)).toContain('recordingContexts');
    expect(await getAll(again, 'recordings')).toHaveLength(2);
    again.close();
  });

  it('adds a missing store when another branch used the same version for different stores', async () => {
    const otherBranch = build(7, ['recordings', 'notations', 'transcripts', 'analyses', 'shareDrafts']);
    const first = await openAdditiveDatabase(factory, otherBranch);
    await put(first, 'recordings', { id: 'recording:1' });
    first.close();

    const database = await openAdditiveDatabase(factory, EXPERIMENT);
    expect(database.version).toBe(8);
    expect(storesOf(database)).toEqual(['analyses', 'notations', 'recordingContexts', 'recordings', 'shareDrafts', 'transcripts']);
    expect(await getAll(database, 'recordings')).toEqual([{ id: 'recording:1' }]);
    database.close();

    // Both branches keep working after that, in either order.
    for (const schema of [otherBranch, STABLE, EXPERIMENT]) {
      const reopened = await openAdditiveDatabase(factory, schema);
      expect(schema.isSatisfied(reopened)).toBe(true);
      reopened.close();
    }
  });

  it('still surfaces errors that are not about versions', async () => {
    const broken: AdditiveDatabaseSchema = { ...STABLE, upgrade: () => { throw new Error('boom'); } };
    await expect(openAdditiveDatabase(factory, broken)).rejects.toBeTruthy();
  });
});
