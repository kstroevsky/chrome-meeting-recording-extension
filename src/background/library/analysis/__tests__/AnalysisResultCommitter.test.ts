import type { AnalysisJob } from '../../../../shared/analysis/job';
import type { AnalysisProvenance } from '../../../../shared/analysis/provenance';
import { toWireAnalysis } from '../../../../shared/analysis/storedAnalysis';
import type { RecordingAnalysisService } from '../RecordingAnalysisService';
import { AnalysisResultCommitter } from '../AnalysisResultCommitter';

const JOB: AnalysisJob = {
  id: 'job-1',
  historyId: 'recording-1',
  status: 'completed',
  progress: 1,
  startedAt: 1,
  finishedAt: 2,
};

const PROVENANCE: AnalysisProvenance = {
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

function analyses(overrides: Record<string, unknown> = {}): RecordingAnalysisService {
  return {
    save: jest.fn().mockResolvedValue(undefined),
    removeAll: jest.fn().mockResolvedValue(undefined),
    provenanceForNewRun: jest.fn(() => PROVENANCE),
    ...overrides,
  } as unknown as RecordingAnalysisService;
}

describe('AnalysisResultCommitter', () => {
  it('does not settle the offscreen result until persistence has completed', async () => {
    let finishSave!: () => void;
    const save = jest.fn(() => new Promise<unknown>((resolve) => {
      finishSave = () => resolve({});
    }));
    const settle = jest.fn();
    const committer = new AnalysisResultCommitter({
      analyses: analyses({ save }),
      isRecordingDeleted: jest.fn().mockResolvedValue(false),
      isPurged: () => false,
      fallbackProvenance: () => PROVENANCE,
      settle,
    });

    const commit = committer.commit(JOB, WIRE);
    await Promise.resolve();

    expect(save).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();

    finishSave();
    await commit;
    expect(settle).toHaveBeenCalledWith(JOB);
  });

  it('keeps a transiently failed result unacknowledged so replay can retry it', async () => {
    const settle = jest.fn();
    const save = jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const committer = new AnalysisResultCommitter({
      analyses: analyses({ save }),
      isRecordingDeleted: jest.fn().mockResolvedValue(false),
      isPurged: () => false,
      fallbackProvenance: () => PROVENANCE,
      settle,
    });

    await committer.commit(JOB, WIRE);
    expect(settle).not.toHaveBeenCalled();
  });
});
