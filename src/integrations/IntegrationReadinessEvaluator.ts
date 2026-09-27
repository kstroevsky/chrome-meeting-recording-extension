import type { AnalysisJobStatus } from '../shared/analysis/job';
import type { RecordingHistoryEntry } from '../shared/recordingHistory';
import type { Transcript } from '../shared/transcript';
import type {
  IntegrationDataPolicy,
  IntegrationReadinessEvaluation,
  IntegrationReadinessPending,
} from './contracts';

export type IntegrationReadinessAnalysisState = {
  status: AnalysisJobStatus | 'none' | 'stale';
};

export type IntegrationReadinessSource = {
  history: RecordingHistoryEntry;
  transcript?: Transcript;
  analysis?: IntegrationReadinessAnalysisState;
};

/** Evaluates only destination-requested data; release timing belongs to the planner. */
export class IntegrationReadinessEvaluator {
  evaluate(
    source: IntegrationReadinessSource,
    policy: IntegrationDataPolicy,
  ): IntegrationReadinessEvaluation {
    const pending: IntegrationReadinessPending[] = [];
    // A transcript is never waited for. Captions are written by the time the
    // recording is finished, so none now usually means none will come; one that
    // arrives later (imported, or transcribed after the call) goes out as an
    // update, like any other change.
    if (
      policy.analysis
      && (!source.analysis || source.analysis.status === 'none' || source.analysis.status === 'analyzing')
    ) {
      pending.push('analysis');
    }
    if (
      policy.artifactMetadata
      && policy.artifactLinks
      && source.history.files.some((file) => (
        file.delivery.status === 'pending'
        && !file.locations.some((location) => location.kind === 'drive' && location.webViewLink)
      ))
    ) {
      pending.push('artifact-delivery');
    }
    return { complete: pending.length === 0, pending };
  }
}
