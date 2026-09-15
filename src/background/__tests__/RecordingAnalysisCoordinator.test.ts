import { RecordingAnalysisCoordinator, type AnalysisDataPlane } from '../RecordingAnalysisCoordinator';
import { RecordingAnalysisService } from '../RecordingAnalysisService';
import { CANDIDATE_ANALYSIS_CONFIG } from '../../shared/analysis/candidateConfig';
import { hashAnalysisConfig, PIPELINE_VERSION, type AnalysisProvenance } from '../../shared/analysis/provenance';
import { toWireAnalysis, type WireAnalysis } from '../../shared/analysis/storedAnalysis';
import type { StoredAnalysis } from '../../shared/analysis/storedAnalysis';
import type { AnalysisJob } from '../../shared/analysis/job';
import type { Transcript } from '../../shared/transcript';
import type { ConversationSegment, Topic } from '../../shared/analysis/types';

const PROVENANCE: AnalysisProvenance = {
  pipelineVersion: PIPELINE_VERSION,
  embeddingModel: 'Xenova/multilingual-e5-small',
  embeddingModelRevision: 'rev',
  embeddingDimensions: 2,
  embeddingDtype: 'q8',
  configHash: hashAnalysisConfig(CANDIDATE_ANALYSIS_CONFIG),
};

function topic(id: string): Topic {
  return { id, centroid: Float32Array.from([1, 0]), segments: ['seg_1'], keywords: ['redis'], importance: 0.5 };
}

function segment(topicId: string): ConversationSegment {
  return {
    id: 'seg_1',
    tStartMs: 0,
    tEndMs: 60_000,
    embedding: Float32Array.from([1, 0]),
    localTopicId: topicId,
    startWindow: 0,
    endWindow: 4,
  };
}

const RESULT = { segments: [segment('topic_1')], topics: [topic('topic_1')], utteranceCount: 12 };

const JOB: AnalysisJob = {
  id: 'ana_1',
  historyId: 'rec_1',
  status: 'completed',
  progress: 1,
  startedAt: 1_000,
  finishedAt: 2_000,
};

const TRANSCRIPT: Transcript = {
  source: 'meet-captions',
  segments: [{ tStartMs: 0, tEndMs: 2_000, speaker: 'Ada', text: 'the redis pool is saturated' }],
};

function harness(options: {
  transcript?: Transcript;
  stored?: StoredAnalysis;
  analyzeAnswer?: { ok: boolean; jobId?: string; error?: string };
  ensureReadyThrows?: Error;
  saveThrows?: Error;
} = {}) {
  const rows = new Map<string, StoredAnalysis>();
  if (options.stored) rows.set('rec_1', options.stored);

  const calls: { analyze: unknown[]; cancel: string[]; ack: string[] } = { analyze: [], cancel: [], ack: [] };
  const dataPlane: AnalysisDataPlane = {
    ensureReady: async () => {
      if (options.ensureReadyThrows) throw options.ensureReadyThrows;
    },
    analyzeTranscript: async (historyId, transcript, config) => {
      calls.analyze.push({ historyId, transcript, config });
      return options.analyzeAnswer ?? { ok: true, jobId: 'ana_1' };
    },
    cancelAnalysis: async (jobId) => { calls.cancel.push(jobId); return { ok: true }; },
    acknowledgeAnalysisState: (jobId) => { calls.ack.push(jobId); },
  };

  const analyses = new RecordingAnalysisService(
    {
      get: async (id) => rows.get(id),
      put: async (id, analysis) => {
        if (options.saveThrows) throw options.saveThrows;
        rows.set(id, analysis);
      },
      remove: async (id) => { rows.delete(id); },
    },
    () => PROVENANCE,
  );

  const changed: AnalysisJob[] = [];
  const coordinator = new RecordingAnalysisCoordinator({
    dataPlane,
    analyses,
    readTranscript: async () => options.transcript,
    config: () => CANDIDATE_ANALYSIS_CONFIG,
    onJobChanged: (job) => changed.push(job),
    now: () => 5_000,
  });

  return { coordinator, calls, rows, changed };
}

describe('RecordingAnalysisCoordinator', () => {
  it('reads the transcript and hands its segments to the data plane', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: true, jobId: 'ana_1' });

    // Background owns `recording-history`; the data plane is told, never asked.
    expect(h.calls.analyze).toEqual([
      { historyId: 'rec_1', transcript: TRANSCRIPT.segments, config: CANDIDATE_ANALYSIS_CONFIG },
    ]);
  });

  it('refuses a recording with no transcript, rather than starting an empty run', async () => {
    await expect(harness({}).coordinator.analyze('rec_1'))
      .resolves.toEqual({ ok: false, reason: 'no-transcript' });
    await expect(harness({ transcript: { source: 'meet-captions', segments: [] } }).coordinator.analyze('rec_1'))
      .resolves.toEqual({ ok: false, reason: 'no-transcript' });
  });

  it('does not recompute a current result (INC-03)', async () => {
    const h = harness({
      transcript: TRANSCRIPT,
      stored: { ...RESULT, provenance: PROVENANCE, completedAt: 1 },
    });
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'already-analyzed' });
    expect(h.calls.analyze).toEqual([]);
  });

  it('does recompute when the stored result was produced under other conditions', async () => {
    const h = harness({
      transcript: TRANSCRIPT,
      stored: {
        ...RESULT,
        provenance: { ...PROVENANCE, configHash: 'deadbeef' },
        completedAt: 1,
      },
    });
    // Stale reads as nothing to show, so the run proceeds without `force`.
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: true, jobId: 'ana_1' });
  });

  it('recomputes a current result when explicitly forced', async () => {
    const h = harness({
      transcript: TRANSCRIPT,
      stored: { ...RESULT, provenance: PROVENANCE, completedAt: 1 },
    });
    await expect(h.coordinator.analyze('rec_1', { force: true })).resolves.toEqual({ ok: true, jobId: 'ana_1' });
  });

  it('refuses a second run for a recording already being analysed', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.analyze('rec_1');
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'busy' });
    expect(h.calls.analyze).toHaveLength(1);
  });

  it('reports a data plane that refuses the job', async () => {
    const h = harness({ transcript: TRANSCRIPT, analyzeAnswer: { ok: false, error: 'Topic analysis is unavailable' } });
    await expect(h.coordinator.analyze('rec_1'))
      .resolves.toEqual({ ok: false, reason: 'failed', error: 'Topic analysis is unavailable' });
  });

  it('reports an offscreen document that will not come up', async () => {
    const h = harness({ transcript: TRANSCRIPT, ensureReadyThrows: new Error('Offscreen ready timed out') });
    await expect(h.coordinator.analyze('rec_1'))
      .resolves.toEqual({ ok: false, reason: 'failed', error: 'Offscreen ready timed out' });
  });

  it('releases the recording when a job ends without delivering anything', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.analyze('rec_1');

    h.coordinator.handleJobState({ ...JOB, status: 'failed', error: 'no backend' });
    expect(h.changed).toHaveLength(1);

    // A failed run must not leave the recording permanently un-analysable.
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: true, jobId: 'ana_1' });
  });

  it('keeps the recording locked while its job is still running', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    h.coordinator.handleJobState({ ...JOB, status: 'analyzing' });
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'busy' });
  });

  it('ignores a terminal state for a job it is no longer tracking', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.analyze('rec_1');
    // A replayed state for a superseded job must not unlock the current run.
    h.coordinator.handleJobState({ ...JOB, id: 'ana_stale', status: 'canceled' });
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'busy' });
  });

  it('stores a delivered result and only then acknowledges it', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));

    const stored = h.rows.get('rec_1')!;
    expect(stored.topics).toHaveLength(1);
    // The vectors came back as real Float32Arrays, not JSON's object form.
    expect(stored.topics[0].centroid).toBeInstanceOf(Float32Array);
    expect(stored.segments[0].embedding).toBeInstanceOf(Float32Array);
    // Provenance is stamped by the service, and the clock is the injected one.
    expect(stored.provenance).toEqual(PROVENANCE);
    expect(stored.completedAt).toBe(5_000);
    expect(h.calls.ack).toEqual(['ana_1']);
  });

  it('holds the acknowledgement when a transient storage failure could clear', async () => {
    const aborted = Object.assign(new Error('transaction aborted'), { name: 'AbortError' });
    const h = harness({ transcript: TRANSCRIPT, saveThrows: aborted });
    await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));

    expect(h.rows.has('rec_1')).toBe(false);
    expect(h.calls.ack).toEqual([]);
  });

  it('gives up and acknowledges when storage is full, rather than retrying forever', async () => {
    const full = Object.assign(new Error('the quota has been exceeded'), { name: 'QuotaExceededError' });
    const h = harness({ transcript: TRANSCRIPT, saveThrows: full });
    await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));

    expect(h.rows.has('rec_1')).toBe(false);
    // Retrying cannot make space, and holding would pin the vectors in the
    // offscreen document for the session. The analysis is re-derivable.
    expect(h.calls.ack).toEqual(['ana_1']);
  });

  it('treats the Firefox spelling of a full disk the same way', async () => {
    const full = Object.assign(new Error('quota reached'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' });
    const h = harness({ transcript: TRANSCRIPT, saveThrows: full });
    await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));

    expect(h.calls.ack).toEqual(['ana_1']);
  });

  it('leaves the recording analysable again after a full disk', async () => {
    const full = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    const h = harness({ transcript: TRANSCRIPT, saveThrows: full });
    await h.coordinator.analyze('rec_1');
    h.coordinator.handleJobState({ ...JOB, status: 'completed' });
    await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));

    // Nothing stored, nothing locked: a re-run is the recovery path.
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: true, jobId: 'ana_1' });
  });

  it('drops an incoherent result but still acknowledges it', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    // A segment naming a topic that is not in the message: a truncated payload.
    const broken = toWireAnalysis({ ...RESULT, topics: [topic('topic_other')] }) as WireAnalysis;
    await h.coordinator.handleResult(JOB, broken);

    expect(h.rows.has('rec_1')).toBe(false);
    // Resending cannot fix it, so holding the ack would replay it forever.
    expect(h.calls.ack).toEqual(['ana_1']);
  });

  it('cancels a running job by the recording it belongs to', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.analyze('rec_1');

    await expect(h.coordinator.cancel('rec_1')).resolves.toBe(true);
    expect(h.calls.cancel).toEqual(['ana_1']);
    await expect(h.coordinator.cancel('rec_2')).resolves.toBe(false);
  });
});
