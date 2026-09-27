import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { CANDIDATE_ANALYSIS_CONFIG } from '../../../../shared/analysis/candidateConfig';
import type { AnalysisJob } from '../../../../shared/analysis/job';
import type { AnalysisEnvironmentProvenance, AnalysisProvenance } from '../../../../shared/analysis/provenance';
import { toWireAnalysis } from '../../../../shared/analysis/storedAnalysis';
import type { ConversationSegment, Topic } from '../../../../shared/analysis/types';
import type { Transcript } from '../../../../shared/transcript';
import { RecordingTranscriptRepository } from '../../transcript/RecordingTranscriptRepository';
import { RecordingTranscriptService } from '../../transcript/RecordingTranscriptService';
import {
  RecordingAnalysisCoordinator,
  type AnalysisDataPlane,
} from '../RecordingAnalysisCoordinator';
import { RecordingAnalysisRepository } from '../RecordingAnalysisRepository';
import { RecordingAnalysisService } from '../RecordingAnalysisService';
import { RecordingAnalysisWorkRepository } from '../RecordingAnalysisWorkRepository';

const ENVIRONMENT: AnalysisEnvironmentProvenance = {
  pipelineVersion: 2,
  embeddingModel: 'test/model',
  embeddingModelRevision: 'revision',
  embeddingDimensions: 2,
  embeddingDtype: 'q8',
  configHash: 'config-a',
};

const TRANSCRIPT: Transcript = {
  source: 'meet-captions',
  segments: [{ tStartMs: 0, tEndMs: 2_000, speaker: 'Ada', text: 'the redis pool is saturated' }],
};

function topic(id: string): Topic {
  return { id, centroid: Float32Array.from([1, 0]), segments: ['seg_1'], keywords: ['redis'], importance: 0.5 };
}

function segment(topicId: string): ConversationSegment {
  return {
    id: 'seg_1',
    tStartMs: 0,
    tEndMs: 2_000,
    embedding: Float32Array.from([1, 0]),
    localTopicId: topicId,
    startWindow: 0,
    endWindow: 1,
  };
}

const RESULT = {
  segments: [segment('topic_1')],
  topics: [topic('topic_1')],
  utteranceCount: 1,
};

type AnalysisCall = {
  attemptToken: string;
  requestEpoch: number;
  historyId: string;
  transcript: Transcript['segments'];
  provenance: AnalysisProvenance;
};

function harness(options: {
  ensureReady?: () => Promise<void>;
  analyze?: (call: AnalysisCall) => Promise<{ ok: boolean; jobId?: string; error?: string }>;
  finalized?: () => Promise<boolean>;
} = {}) {
  const factory = new IDBFactory();
  let now = 1_000;
  let environment = { ...ENVIRONMENT };
  let token = 0;
  const transcriptRepository = new RecordingTranscriptRepository(factory, () => now, () => `generation-${++token}`);
  const transcripts = new RecordingTranscriptService(
    transcriptRepository,
    undefined,
    undefined,
    () => environment,
  );
  const analysisRepository = new RecordingAnalysisRepository(factory);
  const analyses = new RecordingAnalysisService(
    analysisRepository,
    () => environment,
    async (recordingId) => {
      const snapshot = await transcripts.getSnapshot(recordingId);
      return snapshot
        ? {
            generation: snapshot.generation,
            revision: snapshot.revision,
            contentHash: snapshot.contentHash,
          }
        : undefined;
    },
  );
  const attemptTokens = ['attempt-a', 'attempt-b', 'attempt-c', 'attempt-d', 'attempt-e'];
  const work = new RecordingAnalysisWorkRepository(factory, () => now, () => attemptTokens.shift()!);
  const calls: { analyze: AnalysisCall[]; cancel: string[]; ack: string[]; wakeAt: number[] } = {
    analyze: [],
    cancel: [],
    ack: [],
    wakeAt: [],
  };

  const dataPlane: AnalysisDataPlane = {
    ensureReady: options.ensureReady ?? (async () => {}),
    analyzeTranscript: async (attemptToken, requestEpoch, historyId, transcript, _config, provenance) => {
      const call = { attemptToken, requestEpoch, historyId, transcript, provenance };
      calls.analyze.push(call);
      return options.analyze?.(call) ?? { ok: true, jobId: attemptToken };
    },
    cancelAnalysis: async (jobId) => {
      calls.cancel.push(jobId);
      return { ok: true };
    },
    acknowledgeAnalysisState: (jobId) => { calls.ack.push(jobId); },
  };

  const settled: string[] = [];
  const coordinator = new RecordingAnalysisCoordinator({
    dataPlane,
    analyses,
    work,
    readTranscript: (recordingId) => transcripts.getSnapshot(recordingId),
    requestAnalysis: (recordingId, requestOptions) => transcripts.requestAnalysis(recordingId, requestOptions),
    ...(options.finalized ? { isRecordingFinalized: async () => options.finalized!() } : {}),
    config: () => CANDIDATE_ANALYSIS_CONFIG,
    scheduleWake: (when) => { calls.wakeAt.push(when); },
    onSettled: () => { settled.push('settled'); },
    now: () => now,
  });

  return {
    factory,
    transcripts,
    analyses,
    analysisRepository,
    work,
    coordinator,
    calls,
    settled,
    setNow(value: number) { now = value; },
    setEnvironment(value: AnalysisEnvironmentProvenance) { environment = value; },
  };
}

function jobFor(call: AnalysisCall, status: AnalysisJob['status'] = 'completed'): AnalysisJob {
  return {
    id: call.attemptToken,
    requestEpoch: call.requestEpoch,
    historyId: call.historyId,
    status,
    progress: status === 'completed' ? 1 : 0.5,
    startedAt: 1_000,
    ...(status === 'completed' ? { finishedAt: 2_000 } : {}),
  };
}

describe('RecordingAnalysisCoordinator durable dispatch', () => {
  it('claims work before sending the caller-owned token and epoch to offscreen', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);

    await expect(h.coordinator.wake('rec:1')).resolves.toEqual({ ok: true, jobId: 'attempt-a' });

    expect(h.calls.analyze).toHaveLength(1);
    expect(h.calls.analyze[0]).toMatchObject({
      attemptToken: 'attempt-a',
      requestEpoch: 1,
      historyId: 'rec:1',
      transcript: TRANSCRIPT.segments,
    });
    await expect(h.work.get('rec:1')).resolves.toMatchObject({
      disposition: 'claimed',
      requestEpoch: 1,
      claim: { attemptToken: 'attempt-a' },
    });
  });

  it('does not recompute a current result unless explicitly forced', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    await h.coordinator.wake('rec:1');
    const call = h.calls.analyze[0];
    const job = jobFor(call);
    await h.coordinator.handleResult(job, toWireAnalysis(RESULT), call.provenance);

    await expect(h.coordinator.analyze('rec:1')).resolves.toEqual({
      ok: false,
      reason: 'already-analyzed',
    });
    await expect(h.coordinator.analyze('rec:1', { force: true })).resolves.toEqual({
      ok: true,
      jobId: 'attempt-b',
    });
  });

  it('keeps B durable when A ensureReady fails after B supersedes it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      ensureReady: async () => {
        await gate;
        throw new Error('offscreen unavailable');
      },
    });
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    const dispatchA = h.coordinator.wake('rec:1');
    await Promise.resolve();

    await h.transcripts.replace('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 2_000, text: 'replacement B' }],
    });
    release();

    await expect(dispatchA).resolves.toEqual({
      ok: false,
      reason: 'failed',
      error: 'offscreen unavailable',
    });
    await expect(h.work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: 2,
      disposition: 'retry-wait',
      attemptCount: 1,
    });
  });

  it('keeps B durable when offscreen refuses A after B supersedes it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({
      analyze: async () => {
        await gate;
        return { ok: false, error: 'enqueue refused' };
      },
    });
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    const dispatchA = h.coordinator.wake('rec:1');
    for (let i = 0; i < 4; i += 1) await Promise.resolve();

    await h.transcripts.replace('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 2_000, text: 'replacement B' }],
    });
    release();
    await dispatchA;

    await expect(h.work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: 2,
      disposition: 'retry-wait',
    });
  });

  it('puts a matching dispatch failure into bounded retry-wait', async () => {
    const h = harness({
      ensureReady: async () => { throw new Error('cold-start timeout'); },
    });
    await h.transcripts.replace('rec:1', TRANSCRIPT);

    await expect(h.coordinator.wake('rec:1')).resolves.toMatchObject({
      ok: false,
      reason: 'failed',
    });
    await expect(h.work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: 1,
      disposition: 'retry-wait',
      nextAttemptAt: 2_000,
      error: 'cold-start timeout',
    });
    expect(h.calls.wakeAt).toEqual([2_000]);
  });

  it('does not let a late terminal A state overwrite desired work B', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    await h.coordinator.wake('rec:1');
    const attemptA = h.calls.analyze[0];

    await h.transcripts.replace('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 2_000, text: 'B' }],
    });
    await h.coordinator.handleJobState({
      ...jobFor(attemptA, 'failed'),
      error: 'A failed late',
    });

    await expect(h.work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: 2,
      disposition: 'pending',
    });
    expect(h.calls.ack).toContain('attempt-a');
  });

  it('publishes C and rejects a replayed A result without changing C', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    await h.coordinator.wake('rec:1');
    const attemptA = h.calls.analyze[0];

    await h.transcripts.replace('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 2_000, text: 'B' }],
    });
    await h.coordinator.wake('rec:1');
    await h.transcripts.replace('rec:1', {
      source: 'stt',
      segments: [{ tStartMs: 0, tEndMs: 2_000, text: 'C' }],
    });
    await h.coordinator.wake('rec:1');
    const attemptC = h.calls.analyze[h.calls.analyze.length - 1];

    await h.coordinator.handleResult(jobFor(attemptC), toWireAnalysis(RESULT), attemptC.provenance);
    const c = await h.analysisRepository.get('rec:1');
    expect(c?.provenance.transcriptHash).toBe(attemptC.provenance.transcriptHash);

    await h.coordinator.handleResult(jobFor(attemptA), toWireAnalysis({
      ...RESULT,
      utteranceCount: 99,
    }), attemptA.provenance);

    const afterReplay = await h.analysisRepository.get('rec:1');
    expect(afterReplay?.utteranceCount).toBe(1);
    expect(afterReplay?.provenance.transcriptHash).toBe(attemptC.provenance.transcriptHash);
    await expect(h.work.get('rec:1')).resolves.toMatchObject({
      requestEpoch: attemptC.requestEpoch,
      disposition: 'satisfied',
    });
  });

  it('keeps an unacknowledged completed payload when fenced persistence throws', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    await h.coordinator.wake('rec:1');
    const call = h.calls.analyze[0];
    const saveAttempt = jest.spyOn(h.analyses, 'saveAttempt').mockRejectedValueOnce(
      Object.assign(new Error('transaction aborted'), { name: 'AbortError' }),
    );

    await h.coordinator.handleResult(jobFor(call), toWireAnalysis(RESULT), call.provenance);

    expect(saveAttempt).toHaveBeenCalledTimes(1);
    expect(h.calls.ack).toEqual([]);
  });

  it('turns invalid completed payloads back into durable retry work', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    await h.coordinator.wake('rec:1');
    const call = h.calls.analyze[0];

    await h.coordinator.handleResult(
      jobFor(call),
      toWireAnalysis({ ...RESULT, topics: [topic('topic-other')] }),
      call.provenance,
    );

    await expect(h.work.get('rec:1')).resolves.toMatchObject({
      disposition: 'retry-wait',
      requestEpoch: 1,
    });
    expect(h.calls.ack).toEqual(['attempt-a']);
  });

  it('records canceled and unsupported attempts as terminal durable dispositions', async () => {
    for (const status of ['canceled', 'unsupported'] as const) {
      const h = harness();
      await h.transcripts.replace('rec:1', TRANSCRIPT);
      await h.coordinator.wake('rec:1');
      const call = h.calls.analyze[0];

      await h.coordinator.handleJobState({
        ...jobFor(call, status),
        error: status === 'unsupported' ? 'no backend' : undefined,
      });

      await expect(h.work.get('rec:1')).resolves.toMatchObject({ disposition: status });
      await expect(h.analyses.exportState('rec:1')).resolves.toMatchObject({ status });
      expect(h.calls.ack).toEqual(['attempt-a']);
    }
  });

  it('cancels a currently claimed attempt by its durable token', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    await h.coordinator.wake('rec:1');

    await expect(h.coordinator.cancel('rec:1')).resolves.toBe(true);
    expect(h.calls.cancel).toEqual(['attempt-a']);
    await expect(h.work.get('rec:1')).resolves.toMatchObject({ disposition: 'canceled' });
    await expect(h.analyses.exportState('rec:1')).resolves.toMatchObject({ status: 'canceled' });
  });

  it('cancels pending durable work even when no offscreen attempt exists yet', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);

    await expect(h.coordinator.cancel('rec:1')).resolves.toBe(true);

    expect(h.calls.cancel).toEqual([]);
    await expect(h.work.get('rec:1')).resolves.toMatchObject({ disposition: 'canceled' });
    await expect(h.analyses.exportState('rec:1')).resolves.toMatchObject({ status: 'canceled' });
  });

  it('purge removes durable work before a late result can publish', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    await h.coordinator.wake('rec:1');
    const call = h.calls.analyze[0];

    await h.coordinator.purge('rec:1');
    await h.coordinator.handleResult(jobFor(call), toWireAnalysis(RESULT), call.provenance);

    await expect(h.work.get('rec:1')).resolves.toBeUndefined();
    await expect(h.analysisRepository.get('rec:1')).resolves.toBeUndefined();
    expect(h.calls.cancel).toContain('attempt-a');
  });

  it('supersedes a pending request when the output-affecting environment changes', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);
    await h.coordinator.wake('rec:1');
    const first = h.calls.analyze[0];

    h.setEnvironment({ ...ENVIRONMENT, configHash: 'config-b' });
    await h.coordinator.ensureCurrentAnalysis('rec:1');

    const second = h.calls.analyze[h.calls.analyze.length - 1];
    expect(second.requestEpoch).toBe(first.requestEpoch + 1);
    expect(second.provenance.configHash).toBe('config-b');
  });

  it('startup reconciliation skips live recordings and dispatches finalized durable work', async () => {
    let finalized = false;
    const h = harness({ finalized: async () => finalized });
    await h.transcripts.replace('rec:1', TRANSCRIPT);

    await h.coordinator.reconcile(['rec:1']);
    expect(h.calls.analyze).toHaveLength(0);

    finalized = true;
    await h.coordinator.reconcile(['rec:1']);
    expect(h.calls.analyze).toHaveLength(1);
  });

  it('legacy terminal outbox rows are acknowledged and converted into current durable work', async () => {
    const h = harness();
    await h.transcripts.replace('rec:1', TRANSCRIPT);

    await h.coordinator.handleJobState({
      id: 'legacy-job',
      historyId: 'rec:1',
      status: 'failed',
      progress: 1,
      startedAt: 1,
      finishedAt: 2,
    });

    expect(h.calls.ack).toContain('legacy-job');
    expect(h.calls.analyze).toHaveLength(1);
    expect(h.calls.analyze[0].requestEpoch).toBe(1);
  });
});
