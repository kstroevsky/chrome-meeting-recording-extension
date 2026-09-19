/**
 * @file offscreen/analysis/AnalysisSealLedger.ts
 *
 * What happened when a finished job's terminal state was written, remembered
 * once per job — and what acknowledging it should therefore do.
 *
 * **One sealing outcome per job, not one per call site.** Reporting a terminal
 * state and delivering its result both need the state on disk, and an earlier
 * version let each of them run its own bounded retry: three attempts became
 * six, and the "three attempts" the tests proved was a property of the helper
 * rather than of the flow. The seal is now a single promise per job that both
 * callers await.
 *
 * **Acknowledgement follows what actually happened.** The normal path is
 * HOST-03's: remove the durable row, then release the held result, and keep
 * both if the removal fails so a reconnect can retry. But a result delivered
 * *deliberately unsealed* has no row — and asking the same broken store to
 * remove one fails, which under the normal rule would hold the payload
 * forever, keep the document busy forever, and block every extension update.
 * That is the exact liveness the degraded path exists to preserve, so a job
 * known to be unsealed releases without touching the outbox at all.
 *
 * ```text
 * normal    row → deliver → persist → ack → remove row → release payload
 * degraded  3 failed attempts → deliver → persist → ack → release payload
 *                                                          (no row to remove)
 * ```
 */

import { acknowledgeAnalysisJob, sealAnalysisJob, type AnalysisJobStateOutbox, type SealOptions } from './AnalysisJobStateOutbox';
import type { AnalysisJob } from '../../shared/analysis/job';

/** The part of `AnalysisManager` this needs: releasing a held result. */
export interface HeldResults {
  acknowledge(jobId: string): void;
}

export class AnalysisSealLedger {
  /** Job id → the one sealing attempt made for it, shared by every caller. */
  private readonly seals = new Map<string, Promise<boolean>>();

  constructor(
    private readonly outbox: Pick<AnalysisJobStateOutbox, 'put' | 'remove'>,
    private readonly held: HeldResults,
    private readonly options: SealOptions = {},
  ) {}

  /**
   * Seals this job's terminal state, or joins the attempt already under way.
   * Resolves true when it is durable.
   */
  ensureSealed(job: AnalysisJob): Promise<boolean> {
    let pending = this.seals.get(job.id);
    if (!pending) {
      pending = sealAnalysisJob(this.outbox, job, this.options);
      this.seals.set(job.id, pending);
    }
    return pending;
  }

  /**
   * Hands a completed job's result over once its state is sealed — or once
   * sealing has demonstrably failed, which is the documented trade of crash
   * durability for liveness. See the file docblock.
   */
  async deliver(job: AnalysisJob, post: () => void): Promise<boolean> {
    const sealed = await this.ensureSealed(job);
    if (!sealed) {
      this.options.warn?.(
        `Delivering the analysis for ${job.historyId} without a durable terminal state; `
        + 'it will need recomputing if this document dies before background stores it',
        job.id,
      );
    }
    post();
    return sealed;
  }

  /**
   * Applies background's acknowledgement. Returns whether the job was released.
   *
   * A job this ledger has no record of — replayed from the outbox after this
   * document restarted — takes the normal path, because its row is real.
   */
  async acknowledge(jobId: string): Promise<boolean> {
    const sealed = await this.seals.get(jobId);
    if (sealed === false) {
      // Nothing was written, so there is nothing to remove and no consistency
      // to protect. Releasing is the whole point of the degraded path.
      this.held.acknowledge(jobId);
      this.seals.delete(jobId);
      return true;
    }
    const released = await acknowledgeAnalysisJob(this.outbox, this.held, jobId, this.options.warn);
    if (released) this.seals.delete(jobId);
    return released;
  }

  /** Forgets a job's outcome — for a run that never reached delivery. */
  forget(jobId: string): void {
    this.seals.delete(jobId);
  }
}
