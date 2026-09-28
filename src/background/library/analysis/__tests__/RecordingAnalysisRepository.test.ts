import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { RecordingAnalysisRepository } from '../RecordingAnalysisRepository';
import { RecordingAnalysisWorkRepository } from '../RecordingAnalysisWorkRepository';
import { RecordingTranscriptRepository } from '../../transcript/RecordingTranscriptRepository';
import { RecordingNotationRepository } from '../../notations/RecordingNotationRepository';
import { PIPELINE_VERSION, type AnalysisProvenance } from '../../../../shared/analysis/provenance';
import type { StoredAnalysis } from '../../../../shared/analysis/storedAnalysis';
import {
  openRecordingHistoryDatabase,
  RECORDINGS_STORE,
} from '../../RecordingLibraryDatabase';

const v = (...values: number[]) => Float32Array.from(values);

const analysis = (over: Partial<StoredAnalysis> = {}): StoredAnalysis => ({
  provenance: {
    transcriptGeneration: 'generation-1',
    transcriptRevision: 1,
    transcriptHash: 'transcript-hash-1',
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

  it('publishes a completed result and durable outcome in one repository transaction', async () => {
    const completed = analysis({ completedAt: 2_000 });
    await expect(repository.putCompleted('rec:1', completed, {
      status: 'completed',
      jobId: 'job:1',
      startedAt: 1_000,
      updatedAt: 2_000,
    })).resolves.toBe(true);

    await expect(repository.getSnapshot('rec:1')).resolves.toEqual({
      analysis: expect.objectContaining({ completedAt: 2_000 }),
      outcome: {
        status: 'completed',
        jobId: 'job:1',
        startedAt: 1_000,
        updatedAt: 2_000,
      },
    });
  });

  it('publishes only the exact claimed epoch/token and marks its work satisfied', async () => {
    const transcripts = new RecordingTranscriptRepository(factory, () => 100, () => 'generation-1');
    const work = new RecordingAnalysisWorkRepository(factory, () => 200, () => 'attempt-1');
    const environment = {
      pipelineVersion: PIPELINE_VERSION,
      embeddingModel: 'Xenova/multilingual-e5-small',
      embeddingModelRevision: '761b726d',
      embeddingDimensions: 3,
      embeddingDtype: 'q8' as const,
      configHash: 'abc12345',
    };
    const hash = 'a'.repeat(64);
    const snapshot = await transcripts.replaceAndRequestAnalysis('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 1_000, text: 'words' }],
    }, hash, environment);
    const claim = await work.claim('rec:1', { now: 200 });
    const provenance: AnalysisProvenance = {
      ...environment,
      transcriptGeneration: snapshot.generation,
      transcriptRevision: snapshot.revision,
      transcriptHash: hash,
    };
    const completed = analysis({ provenance, completedAt: 300 });
    const job = {
      id: claim!.claim.attemptToken,
      requestEpoch: claim!.requestEpoch,
      historyId: 'rec:1',
      status: 'completed' as const,
      progress: 1,
      startedAt: 200,
      finishedAt: 300,
    };

    await expect(repository.publishAttemptResult('rec:1', job, completed, {
      status: 'completed',
      jobId: job.id,
      startedAt: 200,
      updatedAt: 300,
    }, provenance)).resolves.toBe(true);

    await expect(repository.get('rec:1')).resolves.toMatchObject({ completedAt: 300, provenance });
    await expect(repository.getOutcome('rec:1')).resolves.toMatchObject({
      status: 'completed',
      jobId: 'attempt-1',
    });
    await expect(work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: 1,
      disposition: 'satisfied',
    });
    expect((await work.get('rec:1'))?.claim).toBeUndefined();
  });

  it('rejects a superseded attempt without changing analysis, outcome, or newer work', async () => {
    const transcripts = new RecordingTranscriptRepository(factory, () => 100, (() => {
      let generation = 0;
      return () => `generation-${++generation}`;
    })());
    const work = new RecordingAnalysisWorkRepository(factory, () => 200, () => 'attempt-a');
    const environment = {
      pipelineVersion: PIPELINE_VERSION,
      embeddingModel: 'Xenova/multilingual-e5-small',
      embeddingModelRevision: '761b726d',
      embeddingDimensions: 3,
      embeddingDtype: 'q8' as const,
      configHash: 'abc12345',
    };
    const first = await transcripts.replaceAndRequestAnalysis('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 1_000, text: 'A' }],
    }, 'a'.repeat(64), environment);
    const claim = await work.claim('rec:1', { now: 200 });
    const provenance: AnalysisProvenance = {
      ...environment,
      transcriptGeneration: first.generation,
      transcriptRevision: first.revision,
      transcriptHash: 'a'.repeat(64),
    };
    await transcripts.replaceAndRequestAnalysis('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 1_000, text: 'B' }],
    }, 'b'.repeat(64), environment);
    const job = {
      id: claim!.claim.attemptToken,
      requestEpoch: claim!.requestEpoch,
      historyId: 'rec:1',
      status: 'completed' as const,
      progress: 1,
      startedAt: 200,
      finishedAt: 300,
    };

    await expect(repository.publishAttemptResult(
      'rec:1',
      job,
      analysis({ provenance, completedAt: 300 }),
      { status: 'completed', jobId: job.id, startedAt: 200, updatedAt: 300 },
      provenance,
    )).resolves.toBe(false);

    await expect(repository.getSnapshot('rec:1')).resolves.toMatchObject({
      analysis: undefined,
      outcome: undefined,
      work: {
        requestEpoch: 2,
        transcriptHash: 'b'.repeat(64),
        disposition: 'pending',
      },
    });
    await expect(work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: 2,
      transcriptHash: 'b'.repeat(64),
      disposition: 'pending',
    });
  });

  it('rejects publication when the recording is tombstoned', async () => {
    const transcripts = new RecordingTranscriptRepository(factory, () => 100, () => 'generation-1');
    const work = new RecordingAnalysisWorkRepository(factory, () => 200, () => 'attempt-1');
    const environment = {
      pipelineVersion: PIPELINE_VERSION,
      embeddingModel: 'Xenova/multilingual-e5-small',
      embeddingModelRevision: '761b726d',
      embeddingDimensions: 3,
      embeddingDtype: 'q8' as const,
      configHash: 'abc12345',
    };
    const hash = 'a'.repeat(64);
    const snapshot = await transcripts.replaceAndRequestAnalysis('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 1_000, text: 'words' }],
    }, hash, environment);
    const claim = await work.claim('rec:1', { now: 200 });
    const database = await openRecordingHistoryDatabase(factory);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RECORDINGS_STORE, 'readwrite');
      transaction.objectStore(RECORDINGS_STORE).put({
        id: 'rec:1',
        name: 'Deleted recording',
        createdAt: 1,
        storageMode: 'local',
        status: 'complete',
        deletedAt: 250,
        files: [{
          id: 'file:1',
          stream: 'tab',
          filename: 'recording.webm',
          mimeType: 'video/webm',
          locations: [],
          delivery: { requested: 'local', status: 'downloaded' },
          destination: 'local',
          status: 'available',
        }],
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const provenance: AnalysisProvenance = {
      ...environment,
      transcriptGeneration: snapshot.generation,
      transcriptRevision: snapshot.revision,
      transcriptHash: hash,
    };
    const job = {
      id: claim!.claim.attemptToken,
      requestEpoch: claim!.requestEpoch,
      historyId: 'rec:1',
      status: 'completed' as const,
      progress: 1,
      startedAt: 200,
      finishedAt: 300,
    };

    await expect(repository.publishAttemptResult(
      'rec:1',
      job,
      analysis({ provenance, completedAt: 300 }),
      { status: 'completed', jobId: job.id, startedAt: 200, updatedAt: 300 },
      provenance,
    )).resolves.toBe(false);
    await expect(repository.get('rec:1')).resolves.toBeUndefined();
  });

  it('does not let a replayed older job replace a newer durable outcome', async () => {
    await repository.putOutcome('rec:1', {
      status: 'analyzing',
      jobId: 'job:new',
      startedAt: 2_000,
      updatedAt: 2_100,
    });
    await repository.putOutcome('rec:1', {
      status: 'failed',
      jobId: 'job:old',
      error: 'late replay',
      startedAt: 1_000,
      updatedAt: 3_000,
    });

    await expect(repository.getOutcome('rec:1')).resolves.toEqual({
      status: 'analyzing',
      jobId: 'job:new',
      startedAt: 2_000,
      updatedAt: 2_100,
    });
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

  it('removes analysis and outcome together for recording cleanup', async () => {
    await repository.putCompleted('rec:1', analysis(), {
      status: 'completed',
      startedAt: 1,
      updatedAt: 2,
    });

    await repository.removeAll('rec:1');
    await expect(repository.getSnapshot('rec:1')).resolves.toEqual({
      analysis: undefined,
      outcome: undefined,
    });
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
