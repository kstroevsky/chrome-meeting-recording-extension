import type { AnalysisJob } from '../../../shared/analysis/job';
import type { AnalysisProvenance } from '../../../shared/analysis/provenance';
import {
  fromWireAnalysis,
  fromWireProvenance,
  type WireAnalysis,
} from '../../../shared/analysis/storedAnalysis';
import { makeLogger } from '../../../shared/logger';
import type { RecordingAnalysisService } from './RecordingAnalysisService';

const L = makeLogger('background');

export type AnalysisResultCommitterDeps = {
  analyses: RecordingAnalysisService;
  isRecordingDeleted: (historyId: string) => Promise<boolean>;
  isPurged: (historyId: string) => boolean;
  fallbackProvenance: (jobId: string) => AnalysisProvenance | undefined;
  settle: (job: AnalysisJob) => void;
  now?: () => number;
};

/**
 * Persists completed analysis results before allowing their offscreen state to
 * be acknowledged. A transient storage failure is the only path that keeps a
 * valid result unacknowledged so replay can retry it after reconnect.
 */
export class AnalysisResultCommitter {
  constructor(private readonly deps: AnalysisResultCommitterDeps) {}

  async commit(job: AnalysisJob, wire: WireAnalysis, wireProvenance?: unknown): Promise<void> {
    if (this.deps.isPurged(job.historyId) || await this.deps.isRecordingDeleted(job.historyId)) {
      L.log(`Discarding an analysis for deleted recording ${job.historyId}`);
      this.deps.settle(job);
      return;
    }

    const result = fromWireAnalysis(wire);
    if (!result) {
      L.warn('Discarding an incoherent analysis result', job.historyId, job.id);
      this.deps.settle(job);
      return;
    }

    const provenance = fromWireProvenance(wireProvenance)
      ?? this.deps.fallbackProvenance(job.id)
      ?? this.deps.analyses.provenanceForNewRun();

    try {
      await this.deps.analyses.save(job.historyId, result, provenance, this.deps.now?.());
    } catch (error) {
      if (!isQuotaExceeded(error)) {
        L.warn('Could not store an analysis result', job.historyId, error);
        return;
      }
      L.warn(
        `Discarding the analysis for ${job.historyId}: storage is full. `
        + 'The recording is unaffected and can be analysed again after freeing space.',
      );
      this.deps.settle(job);
      return;
    }

    // Deletion can race the write, so fence once more before acknowledging.
    if (await this.deps.isRecordingDeleted(job.historyId)) {
      await this.deps.analyses.removeAll(job.historyId).catch(() => {});
    }
    this.deps.settle(job);
  }
}

function isQuotaExceeded(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
