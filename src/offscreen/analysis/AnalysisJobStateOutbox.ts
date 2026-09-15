/**
 * @file offscreen/analysis/AnalysisJobStateOutbox.ts
 *
 * Durable terminal-state outbox for analysis jobs (HOST-03), mirroring
 * `UploadJobStateOutbox` exactly — including the one-key-per-job layout, which
 * is there to avoid a read-modify-write race between two jobs settling at once.
 *
 * **Why this exists at all.** The offscreen document outlives the service
 * worker, so a job can finish while nothing is listening. Without the outbox
 * the result would be computed, stored, and then silently never announced —
 * the surface would show "analyzing" until the next run. An entry is written
 * before delivery is attempted and removed only after the background
 * acknowledges it, so the only failure mode left is announcing twice, which is
 * idempotent.
 */

import {
  getAllLocalStorageValues,
  removeLocalStorageValues,
  setLocalStorageValues,
} from '../../platform/chrome/storage';
import { isTerminalAnalysisJob, normalizeAnalysisJob, type AnalysisJob } from '../../shared/analysis/job';

const TERMINAL_ANALYSIS_STATE_PREFIX = 'analysisJobState:';

export interface AnalysisJobStateStorageArea {
  getAll(): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class AnalysisJobStateOutbox {
  constructor(private readonly area: AnalysisJobStateStorageArea) {}

  async put(job: AnalysisJob): Promise<void> {
    if (!isTerminalAnalysisJob(job)) throw new Error('Only terminal analysis jobs belong in the outbox');
    await this.area.set({ [TERMINAL_ANALYSIS_STATE_PREFIX + job.id]: job });
  }

  async remove(jobId: string): Promise<void> {
    await this.area.remove(TERMINAL_ANALYSIS_STATE_PREFIX + jobId);
  }

  async list(): Promise<AnalysisJob[]> {
    const all = await this.area.getAll();
    const jobs: AnalysisJob[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(TERMINAL_ANALYSIS_STATE_PREFIX)) continue;
      const job = normalizeAnalysisJob(value);
      // A row that survived but is no longer terminal is a damaged write, not a
      // running job: dropping it is safer than replaying "analyzing" forever.
      if (job && isTerminalAnalysisJob(job)) jobs.push(job);
    }
    return jobs;
  }
}

export function createChromeAnalysisJobStateOutbox(): AnalysisJobStateOutbox {
  return new AnalysisJobStateOutbox({
    getAll: () => getAllLocalStorageValues(),
    set: (items) => setLocalStorageValues(items),
    remove: (key) => removeLocalStorageValues(key),
  });
}
