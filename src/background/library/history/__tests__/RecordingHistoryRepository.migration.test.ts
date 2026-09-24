import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { RecordingHistoryRepository } from '../RecordingHistoryRepository';

function seedVersion2(factory: IDBFactory): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open('recording-history', 2);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('recordings', { keyPath: 'id' });
      store.createIndex('createdAtId', ['createdAt', 'id'], { unique: true });
      const active = {
        id: 'active-recording',
        name: 'Active recording',
        createdAt: 20,
        storageMode: 'local',
        status: 'complete',
        files: [{
          id: 'active-recording:tab',
          stream: 'tab',
          filename: 'active-recording.webm',
          destination: 'local',
          status: 'available',
        }],
      };
      store.put(active);
      store.put({
        ...active,
        id: 'deleted-recording',
        name: 'Deleted recording',
        createdAt: 30,
        files: [{
          ...active.files[0],
          id: 'deleted-recording:tab',
          filename: 'deleted-recording.webm',
        }],
        deletedAt: 40,
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe('recording-history v2 migration', () => {
  it('adds the active-history index while preserving tombstones outside visible paging', async () => {
    const factory = new IDBFactory();
    await seedVersion2(factory);

    const repository = new RecordingHistoryRepository(factory);
    await expect(repository.listPage()).resolves.toEqual(expect.objectContaining({
      entries: [expect.objectContaining({ id: 'active-recording' })],
    }));
    await expect(repository.get('deleted-recording')).resolves.toEqual(expect.objectContaining({
      id: 'deleted-recording',
      deletedAt: 40,
    }));

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('recording-history');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(database.version).toBe(7);
    expect(database.objectStoreNames.contains('recordingContexts')).toBe(true);
    expect(database.objectStoreNames.contains('notations')).toBe(true);
    expect(database.objectStoreNames.contains('transcripts')).toBe(true);
    expect(database.objectStoreNames.contains('analyses')).toBe(true);
    const transaction = database.transaction('recordings', 'readonly');
    const store = transaction.objectStore('recordings');
    expect(store.indexNames.contains('activeCreatedAtId')).toBe(true);
    const activeCount = await new Promise<number>((resolve, reject) => {
      const request = store.index('activeCreatedAtId').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(activeCount).toBe(1);
    database.close();
  });
});

describe('a library a newer build has already upgraded', () => {
  /** The profile as an experimental build leaves it: a higher version, an extra store. */
  function seedFromNewerBuild(factory: IDBFactory): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = factory.open('recording-history', 7);
      request.onupgradeneeded = () => {
        const database = request.result;
        const recordings = database.createObjectStore('recordings', { keyPath: 'id' });
        recordings.createIndex('createdAtId', ['createdAt', 'id'], { unique: true });
        recordings.createIndex('activeCreatedAtId', ['activeCreatedAt', 'id'], { unique: true });
        for (const store of ['notations', 'transcripts', 'analyses', 'recordingContexts']) {
          database.createObjectStore(store, { keyPath: 'recordingId' });
        }
        recordings.put({
          id: 'therapy-session',
          name: 'Therapy session',
          createdAt: 50,
          activeCreatedAt: 50,
          storageMode: 'drive',
          status: 'complete',
          files: [{ id: 'therapy-session:tab', stream: 'tab', filename: 'therapy.webm', destination: 'drive', status: 'available' }],
        });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  it('still lists, reads and writes it instead of failing with a VersionError', async () => {
    const factory = new IDBFactory();
    await seedFromNewerBuild(factory);
    const repository = new RecordingHistoryRepository(factory);

    const page = await repository.listPage();
    expect(page.entries.map((entry) => entry.id)).toEqual(['therapy-session']);

    await repository.update('therapy-session', (current) => current && { ...current, note: 'kept' });
    expect((await repository.get('therapy-session'))?.note).toBe('kept');
  });
});

describe('the library size on the first page', () => {
  it('counts the whole library, never deleted rows, and only on the first page', async () => {
    const factory = new IDBFactory();
    const repository = new RecordingHistoryRepository(factory);
    const row = (id: string, createdAt: number, deletedAt?: number) => ({
      id, name: id, createdAt, storageMode: 'local' as const, status: 'complete' as const,
      files: [{ id: `${id}:tab`, stream: 'tab' as const, filename: `${id}.webm`, mimeType: 'video/webm', locations: [],
        delivery: { requested: 'local' as const, status: 'downloaded' as const }, destination: 'local' as const, status: 'available' as const }],
      ...(deletedAt ? { deletedAt } : {}),
    });
    for (let i = 1; i <= 3; i++) await repository.update(`r${i}`, () => row(`r${i}`, i));
    await repository.update('gone', () => row('gone', 9, 10));

    const first = await repository.listPage({ limit: 2 });
    expect(first.entries.map((entry) => entry.id)).toEqual(['r3', 'r2']);
    expect(first.total).toBe(3);
    const second = await repository.listPage({ limit: 2, cursor: first.nextCursor });
    expect(second.total).toBeUndefined();
  });
});
