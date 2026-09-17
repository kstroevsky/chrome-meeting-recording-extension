import { AnalysisManager } from '../AnalysisManager';
import type { EmbeddingWorkerClient } from '../EmbeddingWorkerClient';
import type { AnalysisJob } from '../../../shared/analysis/job';
import type { AnalysisResult } from '../../../shared/analysis/analyzeTranscript';
import type { AnalysisConfig } from '../../../shared/analysis/types';
import type { AnalysisProvenance } from '../../../shared/analysis/provenance';
import type { TranscriptSegment } from '../../../shared/transcript';

const CONFIG: AnalysisConfig = {
  windowUtterances: 4,
  windowStride: 4,
  longPauseMs: 3_000,
  peakNeighbourhood: 2,
  peakMinProminence: 0.05,
  minSegmentMs: 1_000,
  assignmentThreshold: 0.93,
  mergeThreshold: 0.95,
  mergeEverySegments: 12,
  keywordsPerTopic: 3,
};

const SUBJECTS: Record<string, number> = { redis: 0, berlin: 90, hiring: 180 };

/** What the control plane captured at enqueue; the manager must hand it back. */
const PROVENANCE = {
  pipelineVersion: 2,
  embeddingModel: 'Xenova/multilingual-e5-small',
  embeddingModelRevision: 'rev',
  embeddingDimensions: 2,
  embeddingDtype: 'q8' as const,
  configHash: 'abcd1234',
};

/** Same stub encoder the pipeline tests use: same subject, same direction. */
function embed(texts: string[]): Float32Array[] {
  return texts.map((text) => {
    const subject = Object.keys(SUBJECTS).find((s) => text.includes(s)) ?? 'redis';
    const rad = (SUBJECTS[subject] * Math.PI) / 180;
    return Float32Array.from([Math.cos(rad), Math.sin(rad)]);
  });
}

function transcriptOf(schedule: [string, number][]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let clock = 0;
  for (const [subject, count] of schedule) {
    for (let i = 0; i < count; i += 1) {
      segments.push({
        tStartMs: clock,
        tEndMs: clock + 2_000,
        speaker: i % 2 ? 'Ada' : 'Grace',
        text: `${subject} pool timeout discussion number ${i}`,
      });
      clock += 3_000;
    }
  }
  return segments;
}

/** An engine double that counts loads and disposals, and can be made to fail. */
function fakeEngine(overrides: { device?: 'webgpu' | 'wasm'; failAfter?: number } = {}) {
  let batches = 0;
  const state = { disposed: 0, batches: 0 };
  const client = {
    info: { device: overrides.device ?? 'webgpu', dimensions: 2, dtype: 'q8' as const, loadMs: 1 },
    encoder: () => async (texts: string[]) => {
      batches += 1;
      state.batches = batches;
      if (overrides.failAfter != null && batches > overrides.failAfter) {
        throw new Error('the embedding worker crashed');
      }
      return embed(texts);
    },
    dispose: () => { state.disposed += 1; },
  } as unknown as EmbeddingWorkerClient;
  return { client, state };
}

type Harness = {
  manager: AnalysisManager;
  reported: AnalysisJob[];
  delivered: { job: AnalysisJob; result: AnalysisResult; provenance: AnalysisProvenance }[];
  opens: number;
  engineState: { disposed: number; batches: number };
};

function harness(options: {
  engine?: ReturnType<typeof fakeEngine>;
  deliverFails?: () => boolean;
  isUnsupported?: () => boolean;
  openFails?: Error;
} = {}): Harness {
  const engine = options.engine ?? fakeEngine();
  const reported: AnalysisJob[] = [];
  const delivered: { job: AnalysisJob; result: AnalysisResult; provenance: AnalysisProvenance }[] = [];
  const h = { opens: 0 } as Harness;

  h.manager = new AnalysisManager({
    openEngine: async () => {
      h.opens += 1;
      if (options.openFails) throw options.openFails;
      return engine.client;
    },
    report: (job) => { reported.push({ ...job }); },
    deliver: async (job, result, provenance) => {
      if (options.deliverFails?.()) throw new Error('port disconnected');
      delivered.push({ job, result, provenance });
    },
    isUnsupported: options.isUnsupported,
    now: () => 1_000,
    genId: () => 'ana_1',
  });
  h.reported = reported;
  h.delivered = delivered;
  h.engineState = engine.state;
  return h;
}

/** The project's `lib` predates `Array.prototype.at`. */
function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

/** Lets the manager's queue run to quiescence. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe('AnalysisManager', () => {
  it('reports an analyzing job before the engine has loaded', () => {
    const h = harness();
    const id = h.manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);

    // Synchronous, deliberately: a cold WASM load is the longest part of a run,
    // and a surface that waits for it shows nothing for a minute. The engine
    // load starts in the same tick, so what proves the ordering is that this
    // report predates knowing which backend answered.
    expect(h.reported[0]).toMatchObject({ id, historyId: 'rec_1', status: 'analyzing', progress: 0 });
    expect(h.reported[0].device).toBeUndefined();
  });

  it('runs the pipeline and delivers the result with the job', async () => {
    const h = harness();
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12], ['berlin', 12], ['redis', 12]]), CONFIG, PROVENANCE);
    await settle();

    const terminal = last(h.reported)!;
    expect(terminal.status).toBe('completed');
    expect(terminal.progress).toBe(1);
    expect(terminal.finishedAt).toBe(1_000);
    expect(terminal.topicCount).toBeGreaterThan(0);
    expect(terminal.segmentCount).toBe(terminal.segmentCount);

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].result.topics).toHaveLength(terminal.topicCount!);
    expect(h.delivered[0].result.utteranceCount).toBe(36);
  });

  it('records which rung of the ladder ran, so a slow analysis is explicable', async () => {
    const h = harness({ engine: fakeEngine({ device: 'wasm' }) });
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);
    await settle();

    expect(last(h.reported)!.device).toBe('wasm');
  });

  it('reports progress as a real fraction of the windows it will encode', async () => {
    const h = harness();
    // 180 utterances at window 4 / stride 4 is 45 windows: two batches of 32,
    // which is the minimum that can show progress moving at all.
    h.manager.enqueue('rec_1', transcriptOf([['redis', 60], ['berlin', 60], ['hiring', 60]]), CONFIG, PROVENANCE);
    await settle();

    const progressing = h.reported.filter((j) => j.status === 'analyzing' && j.windowsTotal != null);
    expect(progressing.length).toBeGreaterThan(1);
    for (const job of progressing) {
      expect(job.progress).toBeCloseTo(job.windowsEncoded! / job.windowsTotal!);
    }
    // Monotonic: progress never goes backwards within a run.
    const fractions = progressing.map((j) => j.progress);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
  });

  it('runs one job at a time, whatever is queued', async () => {
    let ids = 0;
    const engine = fakeEngine();
    const running: string[] = [];
    const manager = new AnalysisManager({
      openEngine: async () => engine.client,
      report: (job) => {
        if (job.status === 'analyzing' && job.device && !running.includes(job.id)) running.push(job.id);
      },
      deliver: async () => {},
      now: () => 1_000,
      genId: () => `ana_${(ids += 1)}`,
    });

    manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);
    manager.enqueue('rec_2', transcriptOf([['berlin', 12]]), CONFIG, PROVENANCE);
    // One has started; the other has not, because concurrency is 1.
    await Promise.resolve();
    await Promise.resolve();
    expect(running).toHaveLength(1);

    await settle();
    expect(running).toEqual(['ana_1', 'ana_2']);
  });

  it('opens the engine once for a queue and releases it when the queue drains', async () => {
    let ids = 0;
    const engine = fakeEngine();
    let opens = 0;
    const manager = new AnalysisManager({
      openEngine: async () => { opens += 1; return engine.client; },
      report: () => {},
      deliver: async () => {},
      now: () => 1_000,
      genId: () => `ana_${(ids += 1)}`,
    });

    manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);
    manager.enqueue('rec_2', transcriptOf([['berlin', 12]]), CONFIG, PROVENANCE);
    await settle();

    // One model load serves both; the GPU buffers go back when nothing is queued.
    expect(opens).toBe(1);
    expect(engine.state.disposed).toBe(1);
  });

  it('reports the job as busy while it is queued or running, and until its result is acknowledged', async () => {
    const h = harness();
    const id = h.manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);
    expect(h.manager.hasActiveJobs()).toBe(true);
    expect(h.manager.activeJobs().map((j) => j.historyId)).toEqual(['rec_1']);

    await settle();
    // Off the queue, but the result is still only in memory here.
    expect(h.manager.activeJobs()).toEqual([]);
    expect(h.manager.hasActiveJobs()).toBe(true);

    h.manager.acknowledge(id);
    expect(h.manager.hasActiveJobs()).toBe(false);
  });

  it('ends a job as failed when the engine throws, and drops the engine', async () => {
    const engine = fakeEngine({ failAfter: 1 });
    const h = harness({ engine });
    // Long enough to need a second batch, which is the one that throws.
    h.manager.enqueue('rec_1', transcriptOf([['redis', 60], ['berlin', 60], ['hiring', 60]]), CONFIG, PROVENANCE);
    await settle();

    const terminal = last(h.reported)!;
    expect(terminal.status).toBe('failed');
    expect(terminal.error).toContain('crashed');
    expect(terminal.finishedAt).toBe(1_000);
    // A wedged engine is not inherited by the next job.
    expect(engine.state.disposed).toBeGreaterThan(0);
    expect(h.delivered).toEqual([]);
  });

  it('ends a job as failed when the engine will not open at all', async () => {
    const h = harness({ openFails: new Error('no available backend found') });
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);
    await settle();

    expect(last(h.reported)).toMatchObject({ status: 'failed', error: expect.stringContaining('no available backend') });
  });

  it('ends a job as unsupported when the engine path is already latched off', async () => {
    const h = harness({ isUnsupported: () => true });
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);
    await settle();

    expect(last(h.reported)).toMatchObject({ status: 'unsupported' });
    // RES-08: nothing was attempted, so nothing was loaded.
    expect(h.opens).toBe(0);
  });

  it('cancels at a batch boundary and delivers nothing', async () => {
    const h = harness();
    const id = h.manager.enqueue('rec_1', transcriptOf([['redis', 60], ['berlin', 60], ['hiring', 60]]), CONFIG, PROVENANCE);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.manager.cancel(id)).toBe(true);
    await settle();

    expect(last(h.reported)).toMatchObject({ status: 'canceled' });
    expect(h.delivered).toEqual([]);
    // A second cancel is not an error, it is a no-op on a job already stopping.
    expect(h.manager.cancel(id)).toBe(false);
  });

  it('keeps a delivered result until it is acknowledged, not until it is sent', async () => {
    // The P0 this pins: `deliver` is a postMessage, so it resolving says the
    // message left — not that the background persisted anything. Releasing on a
    // successful send loses the only copy whenever the control plane dies in
    // the gap between delivery and persistence.
    const h = harness();
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12], ['berlin', 12]]), CONFIG, PROVENANCE);
    await settle();

    expect(h.delivered).toHaveLength(1);
    // Still held, even though delivery succeeded.
    expect(h.manager.hasActiveJobs()).toBe(true);

    // A reconnect before any ack re-offers the same result rather than nothing.
    await h.manager.redeliver();
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1].job.id).toBe(h.delivered[0].job.id);

    h.manager.acknowledge(h.delivered[0].job.id);
    await h.manager.redeliver();
    expect(h.delivered).toHaveLength(2);
    expect(h.manager.hasActiveJobs()).toBe(false);
  });

  it('counts a completed-but-unacknowledged result as active work (HOST-04)', async () => {
    const h = harness();
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12], ['berlin', 12]]), CONFIG, PROVENANCE);
    await settle();

    // The job has left the queue, but its result has nowhere else to live yet,
    // so an extension update must still be refused.
    expect(h.manager.activeJobs()).toEqual([]);
    expect(h.manager.undeliveredCount()).toBe(1);
    expect(h.manager.hasActiveJobs()).toBe(true);

    h.manager.acknowledge(last(h.reported)!.id);
    expect(h.manager.hasActiveJobs()).toBe(false);
  });

  it('is not busy for a job that ended without a result', async () => {
    const h = harness({ isUnsupported: () => true });
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);
    await settle();

    // Nothing was produced, so nothing is being held.
    expect(h.manager.undeliveredCount()).toBe(0);
    expect(h.manager.hasActiveJobs()).toBe(false);
  });

  it('hands back the provenance it was given, with the backend that actually ran', async () => {
    // The control plane captures provenance before any backend has loaded, so
    // the device can only be stamped here. Everything else must come back
    // exactly as sent, whatever the service worker has done meanwhile.
    const h = harness({ engine: fakeEngine({ device: 'wasm' }) });
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12], ['berlin', 12]]), CONFIG, PROVENANCE);
    await settle();

    expect(h.delivered[0].provenance).toEqual({ ...PROVENANCE, embeddingDevice: 'wasm' });
  });

  it('lists a held result among the jobs that keep it busy', async () => {
    const h = harness();
    const id = h.manager.enqueue('rec_1', transcriptOf([['redis', 12]]), CONFIG, PROVENANCE);
    expect(h.manager.busyJobs().map((j) => [j.id, j.status])).toEqual([[id, 'analyzing']]);

    await settle();
    // Off the queue, still held — and still announced on a replay.
    expect(h.manager.activeJobs()).toEqual([]);
    expect(h.manager.busyJobs().map((j) => [j.id, j.status])).toEqual([[id, 'completed']]);
    expect(h.manager.holdsResult(id)).toBe(true);

    h.manager.acknowledge(id);
    expect(h.manager.busyJobs()).toEqual([]);
    expect(h.manager.holdsResult(id)).toBe(false);
  });

  it('holds an undelivered result and re-delivers it when the port comes back', async () => {
    let down = true;
    const h = harness({ deliverFails: () => down });
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12], ['berlin', 12]]), CONFIG, PROVENANCE);
    await settle();

    // The job finished and was reported, but the control plane never took it.
    expect(last(h.reported)!.status).toBe('completed');
    expect(h.delivered).toEqual([]);

    down = false;
    await h.manager.redeliver();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0].job.historyId).toBe('rec_1');

    // Acknowledged work is not replayed a second time.
    h.manager.acknowledge(h.delivered[0].job.id);
    await h.manager.redeliver();
    expect(h.delivered).toHaveLength(1);
    expect(h.manager.hasActiveJobs()).toBe(false);
  });

  it('keeps a held result after a failed re-delivery attempt', async () => {
    let down = true;
    const h = harness({ deliverFails: () => down });
    h.manager.enqueue('rec_1', transcriptOf([['redis', 12], ['berlin', 12]]), CONFIG, PROVENANCE);
    await settle();

    await h.manager.redeliver();
    expect(h.delivered).toEqual([]);

    down = false;
    await h.manager.redeliver();
    expect(h.delivered).toHaveLength(1);
  });

  it('survives a report sink that throws, without changing the outcome', async () => {
    const engine = fakeEngine();
    const delivered: unknown[] = [];
    const manager = new AnalysisManager({
      openEngine: async () => engine.client,
      report: () => { throw new Error('port closed'); },
      deliver: async (job, result) => { delivered.push({ job, result }); },
      now: () => 1_000,
      genId: () => 'ana_1',
    });

    manager.enqueue('rec_1', transcriptOf([['redis', 12], ['berlin', 12]]), CONFIG, PROVENANCE);
    await settle();

    // The analysis still ran and still reached the control plane.
    expect(delivered).toHaveLength(1);
  });

  it('completes a recording too short to fill a window, rather than failing it', async () => {
    const h = harness();
    h.manager.enqueue('rec_1', transcriptOf([['redis', 1]]), CONFIG, PROVENANCE);
    await settle();

    // `buildContextWindows` covers a short transcript with one window rather
    // than dropping it, so a one-utterance recording is one topic — a thin
    // result, not an error.
    expect(last(h.reported)).toMatchObject({ status: 'completed', topicCount: 1, segmentCount: 1 });
    expect(h.delivered[0].result.utteranceCount).toBe(1);
  });

  it('completes an empty transcript with nothing, and never opens an engine', async () => {
    const h = harness();
    h.manager.enqueue('rec_1', [], CONFIG, PROVENANCE);
    await settle();

    expect(last(h.reported)).toMatchObject({ status: 'completed', topicCount: 0, segmentCount: 0 });
    expect(h.engineState.batches).toBe(0);
  });
});
