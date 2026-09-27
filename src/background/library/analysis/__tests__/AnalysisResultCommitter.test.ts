import type { AnalysisJob } from '../../../../shared/analysis/job';
import type { AnalysisProvenance } from '../../../../shared/analysis/provenance';
import { toWireAnalysis } from '../../../../shared/analysis/storedAnalysis';
import type { RecordingAnalysisService } from '../RecordingAnalysisService';
import { AnalysisResultCommitter } from '../AnalysisResultCommitter';

const JOB: AnalysisJob = {
  id: 'attempt-1',
  requestEpoch: 1,
  historyId: 'recording-1',
  status: 'completed',
  progress: 1,
  startedAt: 1,
  finishedAt: 2,
};

const PROVENANCE: AnalysisProvenance = {
  transcriptGeneration: 'generation-1',
  transcriptRevision: 1,
  transcriptHash: 'transcript-hash-1',
  pipelineVersion: 2,
  embeddingModel: 'model',
  embeddingModelRevision: 'revision',
  embeddingDimensions: 2,
  embeddingDtype: 'q8',
  configHash: 'config',
};

const WIRE = toWireAnalysis({
  segments: [{
    id: 'segment-1',
    tStartMs: 0,
    tEndMs: 1_000,
    embedding: Float32Array.from([1, 0]),
    localTopicId: 'topic-1',
    startWindow: 0,
    endWindow: 1,
  }],
  topics: [{
    id: 'topic-1',
    centroid: Float32Array.from([1, 0]),
    segments: ['segment-1'],
    keywords: ['topic'],
    importance: 1,
  }],
  utteranceCount: 1,
});

function analyses(saveAttempt: jest.Mock): RecordingAnalysisService {
  return { saveAttempt } as unknown as RecordingAnalysisService;
}

function deps(saveAttempt = jest.fn().mockResolvedValue({ committed: true })) {
  return {
    analyses: analyses(saveAttempt),
    retry: jest.fn().mockResolvedValue(true),
    settle: jest.fn(),
    wake: jest.fn(),
    now: () => 5,
    saveAttempt,
  };
}

describe('AnalysisResultCommitter', () => {
  it('does not acknowledge until the fenced publication transaction completes', async () => {
    let finishSave!: () => void;
    const saveAttempt = jest.fn(() => new Promise((resolve) => {
      finishSave = () => resolve({ committed: true });
    }));
    const d = deps(saveAttempt);
    const committer = new AnalysisResultCommitter(d);

    const commit = committer.commit(JOB, WIRE, PROVENANCE);
    await Promise.resolve();

    expect(saveAttempt).toHaveBeenCalledTimes(1);
    expect(d.settle).not.toHaveBeenCalled();

    finishSave();
    await commit;
    expect(d.settle).toHaveBeenCalledWith(JOB);
  });

  it('keeps a transient storage failure unacknowledged so the held result can replay', async () => {
    const saveAttempt = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const d = deps(saveAttempt);
    const committer = new AnalysisResultCommitter(d);

    await committer.commit(JOB, WIRE, PROVENANCE);

    expect(d.settle).not.toHaveBeenCalled();
    expect(d.retry).not.toHaveBeenCalled();
  });

  it('acknowledges a stale fenced result and wakes newer durable work', async () => {
    const d = deps(jest.fn().mockResolvedValue({ committed: false }));
    const committer = new AnalysisResultCommitter(d);

    await committer.commit(JOB, WIRE, PROVENANCE);

    expect(d.settle).toHaveBeenCalledWith(JOB);
    expect(d.wake).toHaveBeenCalledWith('recording-1');
  });

  it('turns an incoherent payload into a fresh durable retry before acknowledging it', async () => {
    const d = deps();
    const committer = new AnalysisResultCommitter(d);

    const incoherent = toWireAnalysis({
      segments: [{
        id: 'segment-1',
        tStartMs: 0,
        tEndMs: 1_000,
        embedding: Float32Array.from([1, 0]),
        localTopicId: 'missing-topic',
        startWindow: 0,
        endWindow: 1,
      }],
      topics: [],
      utteranceCount: 1,
    });
    await committer.commit(JOB, incoherent, PROVENANCE);

    expect(d.retry).toHaveBeenCalledWith(JOB, expect.stringContaining('invalid'));
    expect(d.settle).toHaveBeenCalledWith(JOB);
    expect(d.saveAttempt).not.toHaveBeenCalled();
  });

  it('acknowledges legacy unfenced results and wakes current durable work', async () => {
    const d = deps();
    const committer = new AnalysisResultCommitter(d);

    await committer.commit({ ...JOB, requestEpoch: undefined }, WIRE, PROVENANCE);

    expect(d.settle).toHaveBeenCalled();
    expect(d.wake).toHaveBeenCalledWith('recording-1');
    expect(d.saveAttempt).not.toHaveBeenCalled();
  });
});
