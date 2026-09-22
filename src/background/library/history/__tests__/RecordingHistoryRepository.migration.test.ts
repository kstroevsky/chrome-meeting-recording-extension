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
    expect(database.version).toBe(6);
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
