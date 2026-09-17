import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { RecordingTranscriptRepository } from '../RecordingTranscriptRepository';
import { RecordingNotationRepository } from '../RecordingNotationRepository';
import type { Transcript, TranscriptSegment } from '../../shared/transcript';

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
    await expect(repository.get('rec:1')).resolves.toEqual(
      transcript([segment(0, 'first'), segment(1_000, 'second')]),
    );
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

    await expect(repository.get('rec:1')).resolves.toEqual({
      source: 'meet-captions',
      segments: [
        { tStartMs: 10, tEndMs: 20, text: 'earlier' },
        { tStartMs: 900, tEndMs: 950, text: 'later' },
      ],
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
    expect(stored?.segments.map((s) => s.text)).toEqual(['a', 'b', 'c']);
  });

  it('aborts without writing when the mutator throws', async () => {
    await repository.update('rec:1', () => transcript([segment(0, 'kept')]));
    await expect(repository.update('rec:1', () => { throw new Error('nope'); })).rejects.toThrow('nope');
    await expect(repository.get('rec:1')).resolves.toEqual(transcript([segment(0, 'kept')]));
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

    await expect(repository.get('rec:legacy')).resolves.toEqual(transcript([segment(0, 'new words')]));
    await expect(new RecordingNotationRepository(factory, () => 1_000).list('rec:legacy'))
      .resolves.toEqual([{ id: 'notation:1', tStartMs: 5, text: 'kept' }]);
  });

  it('shares one database with the notation repository without blocking its upgrade', async () => {
    const notations = new RecordingNotationRepository(factory, () => 1_000);
    await notations.update('rec:1', () => [{ id: 'notation:1', tStartMs: 5, text: 'mark' }]);
    await repository.update('rec:1', () => transcript([segment(0, 'words')]));

    await expect(notations.list('rec:1')).resolves.toHaveLength(1);
    await expect(repository.get('rec:1')).resolves.toEqual(transcript([segment(0, 'words')]));
  });
});
