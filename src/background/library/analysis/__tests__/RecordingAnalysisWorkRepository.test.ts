import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { RecordingTranscriptRepository } from '../../transcript/RecordingTranscriptRepository';
import { RecordingAnalysisWorkRepository } from '../RecordingAnalysisWorkRepository';

const ENVIRONMENT = {
  pipelineVersion: 2,
  embeddingModel: 'test/model',
  embeddingModelRevision: 'revision',
  embeddingDimensions: 384,
  embeddingDtype: 'q8' as const,
  configHash: 'config',
};

const transcript = (text: string) => ({
  source: 'meet-captions' as const,
  segments: [{ tStartMs: 0, tEndMs: 1_000, text }],
});

describe('RecordingAnalysisWorkRepository', () => {
  let factory: IDBFactory;
  let transcripts: RecordingTranscriptRepository;
  let tokens: string[];
  let work: RecordingAnalysisWorkRepository;

  beforeEach(() => {
    factory = new IDBFactory();
    transcripts = new RecordingTranscriptRepository(factory, () => 100);
    tokens = ['attempt-a', 'attempt-b', 'attempt-c'];
    work = new RecordingAnalysisWorkRepository(factory, () => 1_000, () => tokens.shift()!);
  });

  it('durably claims a due request before dispatch', async () => {
    await transcripts.replaceAndRequestAnalysis('rec:1', transcript('A'), 'a'.repeat(64), ENVIRONMENT);

    await expect(work.claim('rec:1', { now: 1_000, leaseMs: 500 })).resolves.toMatchObject({
      recordingId: 'rec:1',
      requestEpoch: 1,
      disposition: 'claimed',
      attemptCount: 1,
      nextAttemptAt: 1_500,
      claim: {
        attemptToken: 'attempt-a',
        claimedAt: 1_000,
        leaseUntil: 1_500,
      },
    });
  });

  it('reclaims an expired lease with a new attempt token', async () => {
    await transcripts.replaceAndRequestAnalysis('rec:1', transcript('A'), 'a'.repeat(64), ENVIRONMENT);
    await work.claim('rec:1', { now: 1_000, leaseMs: 500 });

    await expect(work.claim('rec:1', { now: 1_499, leaseMs: 500 })).resolves.toBeUndefined();
    await expect(work.claim('rec:1', { now: 1_500, leaseMs: 500 })).resolves.toMatchObject({
      requestEpoch: 1,
      attemptCount: 2,
      claim: { attemptToken: 'attempt-b' },
    });
  });

  it('does not let A failure overwrite newer desired work B', async () => {
    await transcripts.replaceAndRequestAnalysis('rec:1', transcript('A'), 'a'.repeat(64), ENVIRONMENT);
    const claimedA = await work.claim('rec:1', { now: 1_000, leaseMs: 500 });

    await transcripts.replaceAndRequestAnalysis('rec:1', transcript('B'), 'b'.repeat(64), ENVIRONMENT);
    await expect(work.retryClaim(
      'rec:1',
      claimedA!.requestEpoch,
      claimedA!.claim.attemptToken,
      'A failed late',
      2_000,
    )).resolves.toBe(false);

    await expect(work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: 2,
      transcriptHash: 'b'.repeat(64),
      disposition: 'pending',
      attemptCount: 0,
      nextAttemptAt: 0,
    });
  });

  it('returns a matching failure to retry-wait without losing the request', async () => {
    await transcripts.replaceAndRequestAnalysis('rec:1', transcript('A'), 'a'.repeat(64), ENVIRONMENT);
    const claimed = await work.claim('rec:1', { now: 1_000, leaseMs: 500 });

    await expect(work.retryClaim(
      'rec:1',
      claimed!.requestEpoch,
      claimed!.claim.attemptToken,
      'offscreen unavailable',
      2_500,
    )).resolves.toBe(true);
    await expect(work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: 1,
      disposition: 'retry-wait',
      nextAttemptAt: 2_500,
      error: 'offscreen unavailable',
    });
    expect((await work.get('rec:1'))?.claim).toBeUndefined();
  });

  it('claims only rows whose retry time is due', async () => {
    await transcripts.replaceAndRequestAnalysis('rec:a', transcript('A'), 'a'.repeat(64), ENVIRONMENT);
    await transcripts.replaceAndRequestAnalysis('rec:b', transcript('B'), 'b'.repeat(64), ENVIRONMENT);
    const claimA = await work.claim('rec:a', { now: 1_000 });
    await work.retryClaim('rec:a', claimA!.requestEpoch, claimA!.claim.attemptToken, 'retry', 5_000);

    const due = await work.claimDue(10, { now: 1_000, leaseMs: 500 });
    expect(due.map((row) => row.recordingId)).toEqual(['rec:b']);
  });
});
