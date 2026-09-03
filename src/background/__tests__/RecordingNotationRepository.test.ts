import 'fake-indexeddb/auto';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';
import { IDBFactory } from 'fake-indexeddb';

import { RecordingNotationRepository } from '../RecordingNotationRepository';
import { RecordingHistoryRepository } from '../RecordingHistoryRepository';
import type { RecordingNotation } from '../../shared/notations';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';

const notation = (id: string, tStartMs: number, text = ''): RecordingNotation => ({ id, tStartMs, text });

const entry = (id: string, createdAt: number): RecordingHistoryEntry => ({
  id,
  name: id,
  createdAt,
  storageMode: 'local',
  status: 'complete',
  files: [historyFile({ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination: 'local', status: 'available' })],
});

describe('RecordingNotationRepository', () => {
  let factory: IDBFactory;
  let repository: RecordingNotationRepository;

  beforeEach(() => {
    factory = new IDBFactory();
    repository = new RecordingNotationRepository(factory, () => 1_000);
  });

  it('reads an empty list for an unknown recording', async () => {
    await expect(repository.list('recording:missing')).resolves.toEqual([]);
  });

  it('round-trips notations in chronological order', async () => {
    await repository.update('recording:1', () => [notation('notation:b', 9_000, 'second'), notation('notation:a', 1_000, 'first')]);
    await expect(repository.list('recording:1')).resolves.toEqual([
      notation('notation:a', 1_000, 'first'),
      notation('notation:b', 9_000, 'second'),
    ]);
  });

  it('keeps recordings isolated from each other', async () => {
    await repository.update('recording:1', () => [notation('notation:a', 0)]);
    await repository.update('recording:2', () => [notation('notation:b', 0)]);
    await expect(repository.list('recording:1')).resolves.toEqual([notation('notation:a', 0)]);
    await expect(repository.list('recording:2')).resolves.toEqual([notation('notation:b', 0)]);
  });

  it('sees the current list inside the mutator and returns what it committed', async () => {
    await repository.update('recording:1', () => [notation('notation:a', 1_000)]);
    const seen: RecordingNotation[][] = [];
    const result = await repository.update('recording:1', (current) => {
      seen.push(current);
      return [...current, notation('notation:b', 2_000)];
    });
    expect(seen).toEqual([[notation('notation:a', 1_000)]]);
    expect(result).toEqual([notation('notation:a', 1_000), notation('notation:b', 2_000)]);
  });

  it('normalizes what the mutator returns before committing it', async () => {
    const result = await repository.update('recording:1', () => ([
      { id: 'notation:a', tStartMs: 0, text: '  padded  ' },
      { id: '', tStartMs: 5 },
    ] as RecordingNotation[]));
    expect(result).toEqual([notation('notation:a', 0, 'padded')]);
    await expect(repository.list('recording:1')).resolves.toEqual([notation('notation:a', 0, 'padded')]);
  });

  it('aborts without committing when the mutator throws', async () => {
    await repository.update('recording:1', () => [notation('notation:a', 1_000)]);
    await expect(repository.update('recording:1', () => { throw new Error('nope'); })).rejects.toThrow('nope');
    await expect(repository.list('recording:1')).resolves.toEqual([notation('notation:a', 1_000)]);
  });

  it('treats an emptied list as a deletion', async () => {
    await repository.update('recording:1', () => [notation('notation:a', 1_000)]);
    await expect(repository.update('recording:1', () => [])).resolves.toEqual([]);
    await expect(repository.list('recording:1')).resolves.toEqual([]);
  });

  it('removes a recording’s notations', async () => {
    await repository.update('recording:1', () => [notation('notation:a', 1_000)]);
    await repository.remove('recording:1');
    await expect(repository.list('recording:1')).resolves.toEqual([]);
  });

  it('removing an unknown recording is a no-op', async () => {
    await expect(repository.remove('recording:missing')).resolves.toBeUndefined();
  });

  it('shares one database with the history repository without blocking either', async () => {
    const history = new RecordingHistoryRepository(factory);
    await history.update('recording:1', () => entry('recording:1', 10));
    await repository.update('recording:1', () => [notation('notation:a', 1_000)]);

    await expect(history.get('recording:1')).resolves.toMatchObject({ id: 'recording:1' });
    await expect(repository.list('recording:1')).resolves.toEqual([notation('notation:a', 1_000)]);
  });
});

describe('recording-history v3 → v4 upgrade', () => {
  /** Builds the pre-notations schema so the upgrade runs against real v3 data. */
  function seedVersion3(factory: IDBFactory, rows: RecordingHistoryEntry[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = factory.open('recording-history', 3);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('recordings', { keyPath: 'id' });
        store.createIndex('createdAtId', ['createdAt', 'id'], { unique: true });
        store.createIndex('activeCreatedAtId', ['activeCreatedAt', 'id'], { unique: true });
        for (const row of rows) store.put({ ...row, activeCreatedAt: row.createdAt });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
  }

  it('adds the notations store and preserves existing history rows', async () => {
    const factory = new IDBFactory();
    await seedVersion3(factory, [entry('recording:1', 10), entry('recording:2', 20)]);

    const history = new RecordingHistoryRepository(factory);
    const page = await history.listPage();
    expect(page.entries.map((row) => row.id)).toEqual(['recording:2', 'recording:1']);

    const notations = new RecordingNotationRepository(factory, () => 1_000);
    await notations.update('recording:1', () => [notation('notation:a', 1_000)]);
    await expect(notations.list('recording:1')).resolves.toEqual([notation('notation:a', 1_000)]);
  });
});
