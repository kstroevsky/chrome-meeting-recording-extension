import type { AnalysisJob } from '../../../shared/analysis/job';
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
  retry: (job: AnalysisJob, error: string) => Promise<boolean>;
  settle: (job: AnalysisJob) => void;
  wake: (historyId: string) => void;
  now?: () => number;
};

/**
 * Publishes results through the repository's single fenced transaction.
 * Storage failures remain unacknowledged so the offscreen-held payload can be
 * replayed; incoherent payloads are retried as fresh work.
 */
export class AnalysisResultCommitter {
  constructor(private readonly deps: AnalysisResultCommitterDeps) {}

  async commit(job: AnalysisJob, wire: WireAnalysis, wireProvenance?: unknown): Promise<void> {
    if (!job.requestEpoch) {
      this.deps.settle(job);
      this.deps.wake(job.historyId);
      return;
    }

    const result = fromWireAnalysis(wire);
    const provenance = fromWireProvenance(wireProvenance);
    if (!result || !provenance) {
      const error = !result
        ? 'The completed analysis result was invalid and could not be stored.'
        : 'The completed analysis result did not include valid input provenance.';
      L.warn('Discarding an incoherent analysis result', job.historyId, job.id);
      await this.deps.retry(job, error);
      this.deps.settle(job);
      return;
    }

    try {
      const { committed } = await this.deps.analyses.saveAttempt(
        job.historyId,
        result,
        provenance,
        job,
        this.deps.now?.(),
      );
      this.deps.settle(job);
      if (!committed) this.deps.wake(job.historyId);
    } catch (error) {
      // The held result and terminal outbox row remain unacknowledged. Replay
      // retries the exact same fenced transaction after a worker restart.
      L.warn('Could not store an analysis result', job.historyId, error);
    }
  }
}
