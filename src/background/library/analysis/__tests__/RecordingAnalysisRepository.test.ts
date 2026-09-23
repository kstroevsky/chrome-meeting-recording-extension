import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { RecordingAnalysisRepository } from '../RecordingAnalysisRepository';
import { RecordingTranscriptRepository } from '../../transcript/RecordingTranscriptRepository';
import { RecordingNotationRepository } from '../../notations/RecordingNotationRepository';
import { PIPELINE_VERSION } from '../../../../shared/analysis/provenance';
import type { StoredAnalysis } from '../../../../shared/analysis/storedAnalysis';

const v = (...values: number[]) => Float32Array.from(values);

const analysis = (over: Partial<StoredAnalysis> = {}): StoredAnalysis => ({
  provenance: {
    pipelineVersion: PIPELINE_VERSION,
    embeddingModel: 'Xenova/multilingual-e5-small',
    embeddingModelRevision: '761b726d',
    embeddingDimensions: 384,
    embeddingDtype: 'q8',
    configHash: 'abc12345',
  },
  segments: [{ id: 'segment:1', tStartMs: 0, tEndMs: 10_000, embedding: v(1, 0, 0), localTopicId: 'topic:1', startWindow: 0, endWindow: 4 }],
  topics: [{ id: 'topic:1', centroid: v(1, 0, 0), segments: ['segment:1'], keywords: ['redis'], importance: 0.9 }],
  utteranceCount: 24,
  completedAt: 1_700_000,
  ...over,
});

describe('RecordingAnalysisRepository', () => {
  let factory: IDBFactory;
  let repository: RecordingAnalysisRepository;

  beforeEach(() => {
    factory = new IDBFactory();
    repository = new RecordingAnalysisRepository(factory);
  });

  it('reads nothing for a recording that was never analysed', async () => {
    await expect(repository.get('rec:missing')).resolves.toBeUndefined();
  });

  it('round-trips an analysis, keeping the embeddings as typed arrays', async () => {
    await repository.put('rec:1', analysis());
    const stored = await repository.get('rec:1');

    expect(stored?.topics[0].keywords).toEqual(['redis']);
    // The vectors are the expensive part and the reason the row exists at all
    // (ARCH-08): they must survive the round trip as numbers, not as JSON.
    expect(stored?.segments[0].embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(stored!.segments[0].embedding)).toEqual([1, 0, 0]);
  });

  it('replaces a previous analysis rather than accumulating', async () => {
    await repository.put('rec:1', analysis());
    await repository.put('rec:1', analysis({ utteranceCount: 99, completedAt: 1_800_000 }));

    const stored = await repository.get('rec:1');
    expect(stored?.utteranceCount).toBe(99);
    expect(stored?.completedAt).toBe(1_800_000);
  });

  it('refuses a result that does not decode, before it reaches disk', async () => {
    const incoherent = analysis({ topics: [] }); // segment names a topic that is gone
    await expect(repository.put('rec:1', incoherent)).rejects.toThrow(/does not decode/);
    await expect(repository.get('rec:1')).resolves.toBeUndefined();
  });

  it('discards a damaged row rather than returning half a topic graph', async () => {
    await repository.put('rec:1', analysis());
    // Corrupt the stored provenance the way a partial write or an older build
    // might. An analysis is derived, so the answer is to recompute, not repair.
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('recording-history');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('analyses', 'readwrite');
        const store = tx.objectStore('analyses');
        const read = store.get('rec:1');
        read.onsuccess = () => {
          store.put({ ...read.result, provenance: { pipelineVersion: 1 } });
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      open.onerror = () => reject(open.error);
    });

    await expect(repository.get('rec:1')).resolves.toBeUndefined();
  });

  it('refuses a segment with no readable window coverage', async () => {
    // Without it a topic cannot be mapped back to words, so c-TF-IDF has
    // nothing to label with and the row is useless.
    const broken = analysis({
      segments: [{ ...analysis().segments[0], startWindow: 4, endWindow: 4 }],
    });
    await expect(repository.put('rec:1', broken)).rejects.toThrow(/does not decode/);
  });

  it('removes an analysis, and removing again is not an error', async () => {
    await repository.put('rec:1', analysis());
    await repository.remove('rec:1');
    await expect(repository.get('rec:1')).resolves.toBeUndefined();
    await expect(repository.remove('rec:1')).resolves.toBeUndefined();
  });

  it('shares one database with the notation and transcript repositories', async () => {
    const notations = new RecordingNotationRepository(factory, () => 1_000);
    const transcripts = new RecordingTranscriptRepository(factory, () => 1_000);

    await notations.update('rec:1', () => [{ id: 'notation:1', tStartMs: 5, text: 'mark' }]);
    await transcripts.update('rec:1', () => ({
      source: 'meet-captions',
      segments: [{ tStartMs: 0, tEndMs: 500, text: 'words' }],
    }));
    await repository.put('rec:1', analysis());

    await expect(notations.list('rec:1')).resolves.toHaveLength(1);
    await expect(transcripts.get('rec:1')).resolves.toBeDefined();
    await expect(repository.get('rec:1')).resolves.toBeDefined();
  });
});
