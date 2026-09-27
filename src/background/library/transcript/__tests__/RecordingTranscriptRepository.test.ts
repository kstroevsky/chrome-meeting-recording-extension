import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { RecordingTranscriptRepository } from '../RecordingTranscriptRepository';
import { RecordingNotationRepository } from '../../notations/RecordingNotationRepository';
import { openRecordingHistoryDatabase, TRANSCRIPTS_STORE } from '../../RecordingLibraryDatabase';
import type { Transcript, TranscriptSegment } from '../../../../shared/transcript';
import {
  TRANSCRIPT_CANONICALIZATION_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
} from '../../../../shared/transcriptIdentity';

const segment = (tStartMs: number, text: string, speaker = 'Ada'): TranscriptSegment =>
  ({ tStartMs, tEndMs: tStartMs + 500, speaker, text });

const transcript = (segments: TranscriptSegment[]): Transcript =>
  ({ source: 'meet-captions', segments });

describe('RecordingTranscriptRepository', () => {
  let factory: IDBFactory;
  let repository: RecordingTranscriptRepository;

  beforeEach(() => {
    factory = new IDBFactory();
    repository = new RecordingTranscriptRepository(factory, () => 1_000);
  });

  it('reads nothing for an unknown recording', async () => {
    await expect(repository.get('rec:missing')).resolves.toBeUndefined();
  });

  it('writes and reads back a transcript', async () => {
    await repository.update('rec:1', () => transcript([segment(0, 'first'), segment(1_000, 'second')]));
    await expect(repository.get('rec:1')).resolves.toMatchObject({
      revision: 1,
      committedAt: 1_000,
      transcript: transcript([segment(0, 'first'), segment(1_000, 'second')]),
    });
  });

  it('normalizes the mutator result on the way to disk', async () => {
    await repository.update('rec:1', () => ({
      source: 'meet-captions',
      // Out of order, one unusable record, one with no words.
      segments: [
        { tStartMs: 900, tEndMs: 950, text: 'later' },
        { tStartMs: -1, tEndMs: 0, text: 'dropped' },
        { tStartMs: 10, tEndMs: 20, text: 'earlier' },
        { tStartMs: 30, tEndMs: 40, text: '  ' },
      ] as TranscriptSegment[],
    }));

    await expect(repository.get('rec:1')).resolves.toMatchObject({
      transcript: {
        source: 'meet-captions',
        segments: [
          { tStartMs: 10, tEndMs: 20, text: 'earlier' },
          { tStartMs: 900, tEndMs: 950, text: 'later' },
        ],
      },
    });
  });

  it('treats an emptied transcript as a deletion rather than an empty row', async () => {
    await repository.update('rec:1', () => transcript([segment(0, 'first')]));
    await expect(repository.update('rec:1', () => transcript([]))).resolves.toBeUndefined();
    await expect(repository.get('rec:1')).resolves.toBeUndefined();
  });

  it('serializes concurrent appends so neither is lost', async () => {
    await Promise.all([
      repository.update('rec:1', (current) => transcript([...(current?.segments ?? []), segment(0, 'a')])),
      repository.update('rec:1', (current) => transcript([...(current?.segments ?? []), segment(1_000, 'b')])),
      repository.update('rec:1', (current) => transcript([...(current?.segments ?? []), segment(2_000, 'c')])),
    ]);

    const stored = await repository.get('rec:1');
    expect(stored?.transcript.segments.map((s) => s.text)).toEqual(['a', 'b', 'c']);
  });

  it('aborts without writing when the mutator throws', async () => {
    await repository.update('rec:1', () => transcript([segment(0, 'kept')]));
    await expect(repository.update('rec:1', () => { throw new Error('nope'); })).rejects.toThrow('nope');
    await expect(repository.get('rec:1')).resolves.toMatchObject({ transcript: transcript([segment(0, 'kept')]) });
  });

  it('removes a transcript', async () => {
    await repository.update('rec:1', () => transcript([segment(0, 'first')]));
    await repository.remove('rec:1');
    await expect(repository.get('rec:1')).resolves.toBeUndefined();
    // Removing again is not an error.
    await expect(repository.remove('rec:1')).resolves.toBeUndefined();
  });

  it('upgrades a v4 profile in place, keeping its notations', async () => {
    // A profile that predates ADR-0007 already holds recordings and notations at
    // version 4. Opening it must add the transcripts store without disturbing them.
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('recording-history', 4);
      request.onupgradeneeded = () => {
        const database = request.result;
        const recordings = database.createObjectStore('recordings', { keyPath: 'id' });
        recordings.createIndex('createdAtId', ['createdAt', 'id'], { unique: true });
        recordings.createIndex('activeCreatedAtId', ['activeCreatedAt', 'id'], { unique: true });
        database.createObjectStore('notations', { keyPath: 'recordingId' });
      };
      request.onsuccess = () => {
        const database = request.result;
        const store = database.transaction('notations', 'readwrite').objectStore('notations');
        store.put({ recordingId: 'rec:legacy', notations: [{ id: 'notation:1', tStartMs: 5, text: 'kept' }], updatedAt: 1 });
        database.transaction('notations', 'readonly').oncomplete = () => {
          database.close();
          resolve();
        };
      };
      request.onerror = () => reject(request.error);
    });

    // First touch through the app opens at v5 and runs the upgrade.
    await repository.update('rec:legacy', () => transcript([segment(0, 'new words')]));

    await expect(repository.get('rec:legacy')).resolves.toMatchObject({ transcript: transcript([segment(0, 'new words')]) });
    await expect(new RecordingNotationRepository(factory, () => 1_000).list('rec:legacy'))
      .resolves.toEqual([{ id: 'notation:1', tStartMs: 5, text: 'kept' }]);
  });

  it('shares one database with the notation repository without blocking its upgrade', async () => {
    const notations = new RecordingNotationRepository(factory, () => 1_000);
    await notations.update('rec:1', () => [{ id: 'notation:1', tStartMs: 5, text: 'mark' }]);
    await repository.update('rec:1', () => transcript([segment(0, 'words')]));

    await expect(notations.list('rec:1')).resolves.toHaveLength(1);
    await expect(repository.get('rec:1')).resolves.toMatchObject({ transcript: transcript([segment(0, 'words')]) });
  });

  it('increments revisions only when transcript content changes', async () => {
    const first = await repository.update('rec:1', () => transcript([segment(0, 'same')]));
    const duplicate = await repository.update('rec:1', (current) => current);
    const changed = await repository.update('rec:1', (current) => transcript([
      ...(current?.segments ?? []),
      segment(1_000, 'new'),
    ]));

    expect(first?.revision).toBe(1);
    expect(duplicate?.revision).toBe(1);
    expect(changed?.revision).toBe(2);
  });

  it('lazily migrates a legacy flattened transcript when its hash is cached', async () => {
    const legacyTranscript = transcript([segment(0, 'legacy words')]);
    const database = await openRecordingHistoryDatabase(factory);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(TRANSCRIPTS_STORE, 'readwrite');
      transaction.objectStore(TRANSCRIPTS_STORE).put({
        recordingId: 'rec:legacy-flat',
        ...legacyTranscript,
        updatedAt: 77,
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });

    await expect(repository.get('rec:legacy-flat')).resolves.toMatchObject({
      revision: 1,
      contentHash: '',
      committedAt: 77,
      transcript: legacyTranscript,
    });
    const migrated = await repository.get('rec:legacy-flat');
    const hash = 'a'.repeat(64);
    await repository.cacheContentHash('rec:legacy-flat', migrated!.generation, 1, hash);

    const raw = await new Promise<any>((resolve, reject) => {
      const transaction = database.transaction(TRANSCRIPTS_STORE, 'readonly');
      const request = transaction.objectStore(TRANSCRIPTS_STORE).get('rec:legacy-flat');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(raw).toEqual({
      recordingId: 'rec:legacy-flat',
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      canonicalizationVersion: TRANSCRIPT_CANONICALIZATION_VERSION,
      generation: migrated!.generation,
      revision: 1,
      contentHash: hash,
      committedAt: 77,
      transcript: legacyTranscript,
    });
  });

  it('rejects a delayed hash from a deleted-and-recreated transcript with a reused revision', async () => {
    let generation = 0;
    repository = new RecordingTranscriptRepository(factory, () => 1_000, () => `generation:${++generation}`);
    const first = await repository.update('rec:aba', () => transcript([segment(0, 'A')]));
    await repository.remove('rec:aba');
    const second = await repository.update('rec:aba', () => transcript([segment(0, 'B')]));

    expect(first?.revision).toBe(1);
    expect(second?.revision).toBe(1);
    expect(second?.generation).not.toBe(first?.generation);

    await repository.cacheContentHash('rec:aba', first!.generation, first!.revision, 'a'.repeat(64));
    await expect(repository.get('rec:aba')).resolves.toMatchObject({
      generation: second!.generation,
      revision: 1,
      contentHash: '',
      transcript: transcript([segment(0, 'B')]),
    });
  });

  it('pages recording ids so bounded reconciliation can progress across startups', async () => {
    for (const id of ['rec:c', 'rec:a', 'rec:b']) {
      await repository.update(id, () => transcript([segment(0, id)]));
    }

    await expect(repository.listRecordingIds(2)).resolves.toEqual({
      recordingIds: ['rec:a', 'rec:b'],
      nextCursor: 'rec:b',
    });
    await expect(repository.listRecordingIds(2, 'rec:b')).resolves.toEqual({
      recordingIds: ['rec:c'],
    });
  });
});
