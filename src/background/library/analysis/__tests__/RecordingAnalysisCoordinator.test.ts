import { RecordingAnalysisCoordinator, type AnalysisDataPlane } from '../RecordingAnalysisCoordinator';
import { RecordingAnalysisService } from '../RecordingAnalysisService';
import { CANDIDATE_ANALYSIS_CONFIG } from '../../../../shared/analysis/candidateConfig';
import { hashAnalysisConfig, PIPELINE_VERSION, type AnalysisProvenance } from '../../../../shared/analysis/provenance';
import { toWireAnalysis, type WireAnalysis } from '../../../../shared/analysis/storedAnalysis';
import type { StoredAnalysis } from '../../../../shared/analysis/storedAnalysis';
import type { AnalysisJob } from '../../../../shared/analysis/job';
import type { RecordingAnalysisOutcome } from '../RecordingAnalysisOutcome';
import type { Transcript } from '../../../../shared/transcript';
import type { ConversationSegment, Topic } from '../../../../shared/analysis/types';

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
  saveThrows?: Error | (() => Error | undefined);
  /** Answers the deletion fence; defaults to reading `tombstones`. */
  isRecordingDeleted?: (historyId: string) => Promise<boolean>;
} = {}) {
  // Durable state: survives a "service-worker restart" (a fresh coordinator).
  const rows = new Map<string, StoredAnalysis>();
  const outcomes = new Map<string, RecordingAnalysisOutcome>();
  const tombstones = new Set<string>();
  /** Mutable "conditions right now", so a test can change them mid-run. */
  const current = { provenance: PROVENANCE };
  if (options.stored) rows.set('rec_1', options.stored);

  const calls: { analyze: unknown[]; cancel: string[]; ack: string[] } = { analyze: [], cancel: [], ack: [] };
  const dataPlane: AnalysisDataPlane = {
    ensureReady: async () => {
      if (options.ensureReadyThrows) throw options.ensureReadyThrows;
    },
    analyzeTranscript: async (historyId, transcript, config, provenance) => {
      calls.analyze.push({ historyId, transcript, config, provenance });
      return options.analyzeAnswer ?? { ok: true, jobId: 'ana_1' };
    },
    cancelAnalysis: async (jobId) => { calls.cancel.push(jobId); return { ok: true }; },
    acknowledgeAnalysisState: (jobId) => { calls.ack.push(jobId); },
  };

  const analyses = new RecordingAnalysisService(
    {
      get: async (id) => rows.get(id),
      getOutcome: async (id) => outcomes.get(id),
      getSnapshot: async (id) => ({ analysis: rows.get(id), outcome: outcomes.get(id) }),
      put: async (id, analysis) => {
        const failure = typeof options.saveThrows === 'function' ? options.saveThrows() : options.saveThrows;
        if (failure) throw failure;
        rows.set(id, analysis);
      },
      putOutcome: async (id, outcome) => { outcomes.set(id, outcome); },
      putCompleted: async (id, analysis, outcome) => {
        const failure = typeof options.saveThrows === 'function' ? options.saveThrows() : options.saveThrows;
        if (failure) throw failure;
        rows.set(id, analysis);
        outcomes.set(id, outcome);
        return true;
      },
      remove: async (id) => { rows.delete(id); },
      removeAll: async (id) => { rows.delete(id); outcomes.delete(id); },
    },
    () => current.provenance,
  );

  const changed: AnalysisJob[] = [];
  const settled: number[] = [];
  /**
   * A coordinator over the same durable state. Calling it again is what a
   * service-worker restart looks like: every in-memory map starts empty.
   */
  const freshCoordinator = () => new RecordingAnalysisCoordinator({
    dataPlane,
    analyses,
    readTranscript: async () => options.transcript,
    isRecordingDeleted: options.isRecordingDeleted ?? (async (id) => tombstones.has(id)),
    config: () => CANDIDATE_ANALYSIS_CONFIG,
    onJobChanged: (job) => changed.push(job),
    onSettled: () => { settled.push(Date.now()); },
    now: () => 5_000,
  });
  const coordinator = freshCoordinator();

  return { coordinator, freshCoordinator, calls, rows, outcomes, tombstones, changed, settled, current, analyses };
}

describe('RecordingAnalysisCoordinator', () => {
  it('reads the transcript and hands its segments to the data plane', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: true, jobId: 'ana_1' });

    // Background owns `recording-history`; the data plane is told, never asked.
    expect(h.calls.analyze).toEqual([
      // Provenance travels with the job, captured before it starts.
      { historyId: 'rec_1', transcript: TRANSCRIPT.segments, config: CANDIDATE_ANALYSIS_CONFIG, provenance: PROVENANCE },
    ]);
  });

  it('refuses a recording with no transcript, rather than starting an empty run', async () => {
    const missing = harness({});
    await expect(missing.coordinator.analyze('rec_1'))
      .resolves.toEqual({ ok: false, reason: 'no-transcript' });
    await expect(missing.analyses.exportState('rec_1')).resolves.toEqual({
      status: 'unsupported',
      error: 'Analysis is unavailable because the recording has no transcript.',
    });

    const empty = harness({ transcript: { source: 'meet-captions', segments: [] } });
    await expect(empty.coordinator.analyze('rec_1'))
      .resolves.toEqual({ ok: false, reason: 'no-transcript' });
    await expect(empty.analyses.exportState('rec_1')).resolves.toEqual({
      status: 'unsupported',
      error: 'Analysis is unavailable because the recording has no transcript.',
    });
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

  it('fences concurrent enqueue attempts before the first job id exists', async () => {
    const h = harness({ transcript: TRANSCRIPT });

    const first = h.coordinator.analyze('rec_1');
    const second = h.coordinator.analyze('rec_1');

    await expect(second).resolves.toEqual({ ok: false, reason: 'busy' });
    await expect(first).resolves.toEqual({ ok: true, jobId: 'ana_1' });
    expect(h.calls.analyze).toHaveLength(1);
  });

  it('reports a data plane that refuses the job', async () => {
    const h = harness({ transcript: TRANSCRIPT, analyzeAnswer: { ok: false, error: 'Topic analysis is unavailable' } });
    await expect(h.coordinator.analyze('rec_1'))
      .resolves.toEqual({ ok: false, reason: 'failed', error: 'Topic analysis is unavailable' });
    await expect(h.analyses.exportState('rec_1')).resolves.toEqual({
      status: 'failed',
      error: 'Topic analysis is unavailable',
    });
  });

  it('reports an offscreen document that will not come up', async () => {
    const h = harness({ transcript: TRANSCRIPT, ensureReadyThrows: new Error('Offscreen ready timed out') });
    await expect(h.coordinator.analyze('rec_1'))
      .resolves.toEqual({ ok: false, reason: 'failed', error: 'Offscreen ready timed out' });
    await expect(h.analyses.exportState('rec_1')).resolves.toEqual({
      status: 'failed',
      error: 'Offscreen ready timed out',
    });
  });

  it('does not overwrite a running durable outcome when a duplicate start is busy', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.handleJobState({ ...JOB, status: 'analyzing' });

    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'busy' });
    await expect(h.analyses.exportState('rec_1')).resolves.toEqual({ status: 'analyzing' });
  });

  it('acknowledges a job that ended without a result, so its outbox row drains', async () => {
    // The P0 this pins: the outbox is drained by acknowledgement and by nothing
    // else. `failed`, `canceled` and `unsupported` never reach `handleResult`,
    // so without an ack here their `analysisJobState:` keys replay on every
    // reconnect for the life of the profile.
    for (const status of ['failed', 'canceled', 'unsupported'] as const) {
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.handleJobState({ ...JOB, status, error: 'whatever' });
      expect(h.calls.ack).toEqual(['ana_1']);
      expect(h.outcomes.get('rec_1')).toMatchObject({ status, error: 'whatever' });
    }
  });

  it('does not acknowledge a completed job until its result is stored', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.handleJobState({ ...JOB, status: 'completed' });

    // `completed` defers to handleResult, which waits for the row to land.
    expect(h.calls.ack).toEqual([]);
    await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));
    expect(h.calls.ack).toEqual(['ana_1']);
  });

  it('does not acknowledge a job that is still running', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.handleJobState({ ...JOB, status: 'analyzing' });
    expect(h.calls.ack).toEqual([]);
    expect(h.outcomes.get('rec_1')).toMatchObject({ status: 'analyzing' });
  });

  it('releases the recording when a job ends without delivering anything', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.analyze('rec_1');

    await h.coordinator.handleJobState({ ...JOB, status: 'failed', error: 'no backend' });
    expect(h.changed).toHaveLength(1);

    // A failed run must not leave the recording permanently un-analysable.
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: true, jobId: 'ana_1' });
  });

  it('keeps the recording locked while its job is still running', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.handleJobState({ ...JOB, status: 'analyzing' });
    await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'busy' });
  });

  it('ignores a terminal state for a job it is no longer tracking', async () => {
    const h = harness({ transcript: TRANSCRIPT });
    await h.coordinator.analyze('rec_1');
    // A replayed state for a superseded job must not unlock the current run.
    await h.coordinator.handleJobState({ ...JOB, id: 'ana_stale', status: 'canceled' });
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
    await h.coordinator.handleJobState({ ...JOB, status: 'completed' });
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

  describe('provenance describes the run, not the moment it was saved', () => {
    it('stamps the conditions captured when the job was enqueued', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.analyze('rec_1');

      // The configuration changes while the analysis is still computing.
      h.current.provenance = { ...PROVENANCE, configHash: 'deadbeef' };
      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));

      // The row says what actually produced it, so it reads as stale against
      // the new configuration rather than masquerading as current.
      expect(h.rows.get('rec_1')!.provenance.configHash).toBe(PROVENANCE.configHash);
      expect(await h.analyses.get('rec_1')).toBeUndefined();
      expect((await h.analyses.state('rec_1')).status).toBe('stale');
    });

    it('falls back to current conditions for a job it no longer remembers', async () => {
      // A service-worker restart loses the in-memory map; falling back to
      // current conditions is what the old code always did, so no worse.
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));
      expect(h.rows.get('rec_1')!.provenance).toEqual(PROVENANCE);
    });
  });

  describe('a deleted recording', () => {
    it('cancels a running analysis and removes what is stored', async () => {
      const h = harness({ transcript: TRANSCRIPT, stored: { ...RESULT, provenance: PROVENANCE, completedAt: 1 } });
      await h.coordinator.analyze('rec_1', { force: true });

      await h.coordinator.purge('rec_1');

      expect(h.calls.cancel).toEqual(['ana_1']);
      expect(h.rows.has('rec_1')).toBe(false);
    });

    it('refuses a result that arrives after the recording is gone', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.analyze('rec_1');
      await h.coordinator.purge('rec_1');

      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));

      // Not stored — a row for a deleted recording would never be cleaned up.
      expect(h.rows.has('rec_1')).toBe(false);
      // But acknowledged, so the data plane stops holding it.
      expect(h.calls.ack).toContain('ana_1');
    });

    it('accepts results again once the recording is analysed afresh', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.purge('rec_1');
      await h.coordinator.analyze('rec_1');

      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));
      expect(h.rows.has('rec_1')).toBe(true);
    });
  });

  describe('the recording stays held until its result is settled', () => {
    it('refuses a second run while a completed result waits to be stored', async () => {
      // `completed` means computed, not persisted. A run started in between
      // would repeat the whole computation — and after a reconnect, when
      // delivery lags by seconds, "in between" is not small.
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.analyze('rec_1');
      await h.coordinator.handleJobState({ ...JOB, status: 'completed' });

      await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'busy' });
      expect(h.calls.analyze).toHaveLength(1);
    });

    it('re-establishes the hold from a replayed completed state after a restart', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      const restarted = h.freshCoordinator();
      await restarted.handleJobState({ ...JOB, status: 'completed' });

      await expect(restarted.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'busy' });
    });

    it('keeps holding through a transient storage failure, and releases once stored', async () => {
      let failing = true;
      const aborted = Object.assign(new Error('transaction aborted'), { name: 'AbortError' });
      const h = harness({ transcript: TRANSCRIPT, saveThrows: () => (failing ? aborted : undefined) });
      await h.coordinator.analyze('rec_1');
      await h.coordinator.handleJobState({ ...JOB, status: 'completed' });

      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));
      // The result will be re-offered; starting another run now would be waste.
      await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'busy' });

      failing = false;
      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));
      // Released — and now stored, so a plain request finds nothing to do.
      await expect(h.coordinator.analyze('rec_1')).resolves.toEqual({ ok: false, reason: 'already-analyzed' });
    });
  });

  describe('the deletion fence is durable', () => {
    it('refuses a late result after the worker that purged the recording is gone', async () => {
      // The P1: the purge marker lived only in service-worker memory. A result
      // replayed to a restarted worker was written back for a deleted recording.
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.analyze('rec_1');
      h.tombstones.add('rec_1'); // what RecordingHistoryService.remove writes first
      await h.coordinator.purge('rec_1');

      const restarted = h.freshCoordinator();
      await restarted.handleResult(JOB, toWireAnalysis(RESULT));

      expect(h.rows.has('rec_1')).toBe(false);
      expect(h.calls.ack).toContain('ana_1');
    });

    it('still saves a result whose history row does not exist yet', async () => {
      // Delivery and analysis settle independently, so "no row" is an
      // ordinary state for a short recording — not a deletion.
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));
      expect(h.rows.has('rec_1')).toBe(true);
    });

    it('removes a row written in the instant the recording was deleted', async () => {
      // Deleted after the pre-write check, before the write landed.
      let checks = 0;
      const h = harness({ transcript: TRANSCRIPT, isRecordingDeleted: async () => (checks += 1) > 1 });
      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT));

      expect(h.rows.has('rec_1')).toBe(false);
      expect(h.calls.ack).toEqual(['ana_1']);
    });
  });

  describe('provenance that travels with the job', () => {
    it('persists the provenance that came back with the result, even after a restart', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      const atRunTime = { ...PROVENANCE, configHash: 'run0time', embeddingDevice: 'wasm' as const };
      h.current.provenance = { ...PROVENANCE, configHash: 'now0diff' };

      await h.freshCoordinator().handleResult(JOB, toWireAnalysis(RESULT), atRunTime);

      // Not the current conditions, and not a guess: exactly what ran.
      expect(h.rows.get('rec_1')!.provenance).toEqual(atRunTime);
    });

    it('falls back when the provenance that came back cannot be read', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      await h.coordinator.handleResult(JOB, toWireAnalysis(RESULT), { configHash: 42 });
      expect(h.rows.get('rec_1')!.provenance).toEqual(PROVENANCE);
    });
  });

  describe('a result lost with its offscreen document', () => {
    const LOST: AnalysisJob = {
      ...JOB,
      status: 'failed',
      lostResult: true,
      error: 'result lost when the offscreen document restarted',
    };

    it('analyses the recording again, and acknowledges only once that is queued', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      void h.coordinator.handleJobState(LOST);

      // The race this pins: acknowledging on arrival ends the job's claim on
      // the runtime while the replacement exists nowhere, so a deferred reload
      // could be applied in the gap and destroy the analysis for good.
      expect(h.calls.ack).toEqual([]);

      await new Promise(process.nextTick);
      expect(h.calls.analyze).toHaveLength(1);
      expect(h.calls.ack).toEqual(['ana_1']);
    });

    it('keeps the durable state when the replacement cannot be started', async () => {
      // The row is the recovery token: unacknowledged, it is replayed on the
      // next reconnect and tried again.
      const h = harness({ transcript: TRANSCRIPT, analyzeAnswer: { ok: false, error: 'offscreen is gone' } });
      void h.coordinator.handleJobState(LOST);
      await new Promise(process.nextTick);

      expect(h.calls.ack).toEqual([]);
    });

    it('acknowledges when a current result already exists', async () => {
      const h = harness({
        transcript: TRANSCRIPT,
        stored: { ...RESULT, provenance: PROVENANCE, completedAt: 1 },
      });
      void h.coordinator.handleJobState(LOST);
      await new Promise(process.nextTick);

      // Nothing to recover — someone stored one meanwhile.
      expect(h.calls.analyze).toEqual([]);
      expect(h.calls.ack).toEqual(['ana_1']);
    });

    it('acknowledges when there is no transcript left to analyse', async () => {
      const h = harness({});
      void h.coordinator.handleJobState(LOST);
      await new Promise(process.nextTick);

      expect(h.calls.ack).toEqual(['ana_1']);
    });

    it('reports that work settled, which no session transition would', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      void h.coordinator.handleJobState(LOST);
      await new Promise(process.nextTick);

      expect(h.settled).toHaveLength(1);
    });

    it('does not re-run an ordinary failure', async () => {
      const h = harness({ transcript: TRANSCRIPT });
      void h.coordinator.handleJobState({ ...JOB, status: 'failed', error: 'no backend' });
      await new Promise(process.nextTick);
      expect(h.calls.analyze).toEqual([]);
    });
  });
});
