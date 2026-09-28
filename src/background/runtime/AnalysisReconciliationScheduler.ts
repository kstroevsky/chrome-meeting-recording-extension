export const ANALYSIS_RECONCILIATION_ALARM = 'analysis-reconciliation:v1';
export const ANALYSIS_RECONCILIATION_CURSOR_KEY = 'analysisReconciliationCursor:v1';

const DEFAULT_BATCH_SIZE = 25;
const CONTINUATION_DELAY_MS = 1_000;
const FAILURE_RETRY_MS = 60_000;
const FULL_SWEEP_INTERVAL_MS = 15 * 60_000;

type ReconciliationPage = {
  recordingIds: string[];
  nextCursor?: string;
};

type AnalysisReconciliationSchedulerDeps = {
  listRecordingIds(limit: number, after?: string): Promise<ReconciliationPage>;
  reconcile(recordingIds: string[]): Promise<void>;
  readCursor(): Promise<string | undefined>;
  writeCursor(cursor: string | undefined): Promise<void>;
  createAlarm(name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void>;
  getAlarm(name: string): Promise<chrome.alarms.Alarm | undefined>;
  now?: () => number;
  batchSize?: number;
};

/**
 * Advances the durable analysis repair sweep one bounded page per wake.
 *
 * Ordinary transcript commits create desired work transactionally. This sweep
 * is the repair path for legacy rows, changed analysis environments and work
 * stranded by an older build, so it must eventually cover the whole library
 * without keeping one MV3 event alive for an unbounded scan.
 */
export class AnalysisReconciliationScheduler {
  private readonly now: () => number;
  private readonly batchSize: number;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: AnalysisReconciliationSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.batchSize = Math.max(1, Math.floor(deps.batchSize ?? DEFAULT_BATCH_SIZE));
  }

  /** Runs exactly one page and leaves the next wake durable in Chrome alarms. */
  async runSlice(): Promise<void> {
    if (this.inFlight) return await this.inFlight;
    const run = this.runSliceOnce();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async runSliceOnce(): Promise<void> {
    try {
      const cursor = await this.deps.readCursor();
      const page = await this.deps.listRecordingIds(this.batchSize, cursor);
      await this.deps.reconcile(page.recordingIds);

      await this.deps.writeCursor(page.nextCursor);
      await this.ensureAlarmAt(
        this.now() + (page.nextCursor ? CONTINUATION_DELAY_MS : FULL_SWEEP_INTERVAL_MS),
      );
    } catch (error) {
      // The cursor is advanced only after a page reconciles successfully. A
      // retry therefore repeats the same page instead of silently skipping it.
      await this.ensureAlarmAt(this.now() + FAILURE_RETRY_MS).catch(() => {});
      throw error;
    }
  }

  private async ensureAlarmAt(when: number): Promise<void> {
    const existing = await this.deps.getAlarm(ANALYSIS_RECONCILIATION_ALARM);
    if (existing?.scheduledTime != null && Math.abs(existing.scheduledTime - when) < 1_000) return;
    await this.deps.createAlarm(ANALYSIS_RECONCILIATION_ALARM, { when });
  }
}
