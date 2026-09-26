import type { IntegrationStream } from './persistence';

export const INTEGRATION_READINESS_ALARM = 'integration-readiness';

type SchedulerDeps = {
  streams: { list(): Promise<IntegrationStream[]> };
  consider(destinationId: string, recordingId: string): Promise<void>;
  createAlarm(name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void>;
  getAlarm(name: string): Promise<chrome.alarms.Alarm | undefined>;
  clearAlarm(name: string): Promise<boolean>;
  now?: () => number;
  warn?: (...args: unknown[]) => void;
};

/** Rebuildable wake-up scheduler for durable readiness deadlines. */
export class IntegrationReadinessScheduler {
  private readonly now: () => number;
  private readonly warn: (...args: unknown[]) => void;
  private runQueued = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? (() => {});
  }

  async stateChanged(): Promise<void> {
    const next = await this.earliestDeadline();
    if (next != null && next <= this.now()) {
      const alarm = await this.deps.getAlarm(INTEGRATION_READINESS_ALARM);
      if (alarm) await this.deps.clearAlarm(INTEGRATION_READINESS_ALARM);
      this.queueRun();
      return;
    }
    await this.ensureAlarmAt(next);
  }

  async reconcile(): Promise<void> {
    await this.runDue();
  }

  handleAlarm(alarm: { name: string }): void {
    if (alarm.name !== INTEGRATION_READINESS_ALARM) return;
    void this.runDue().catch((error) => this.warn('Integration readiness alarm failed:', error));
  }

  async runDue(): Promise<void> {
    const now = this.now();
    const streams = await this.deps.streams.list();
    const due = streams.filter((stream) => stream.readyDeadlineAt != null && stream.readyDeadlineAt <= now);
    const results = await Promise.allSettled(
      due.map((stream) => this.deps.consider(stream.destinationId, stream.recordingId)),
    );
    for (const result of results) {
      if (result.status === 'rejected') this.warn('Integration readiness consideration failed:', result.reason);
    }
    await this.ensureAlarmAt(await this.earliestDeadline());
  }

  private async earliestDeadline(): Promise<number | undefined> {
    const streams = await this.deps.streams.list();
    let earliest: number | undefined;
    for (const stream of streams) {
      if (stream.readyDeadlineAt == null) continue;
      earliest = earliest == null ? stream.readyDeadlineAt : Math.min(earliest, stream.readyDeadlineAt);
    }
    return earliest;
  }

  private async ensureAlarmAt(next: number | undefined): Promise<void> {
    const alarm = await this.deps.getAlarm(INTEGRATION_READINESS_ALARM);
    if (next == null) {
      if (alarm) await this.deps.clearAlarm(INTEGRATION_READINESS_ALARM);
      return;
    }
    const when = Math.max(this.now(), next);
    if (alarm && Math.abs(alarm.scheduledTime - when) < 1_000) return;
    await this.deps.createAlarm(INTEGRATION_READINESS_ALARM, { when });
  }

  private queueRun(): void {
    if (this.runQueued) return;
    this.runQueued = true;
    queueMicrotask(() => {
      this.runQueued = false;
      void this.runDue().catch((error) => this.warn('Integration readiness run failed:', error));
    });
  }
}
