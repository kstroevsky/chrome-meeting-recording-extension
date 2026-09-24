import type { IntegrationDelivery } from './persistence';

export const INTEGRATION_DELIVERY_ALARM = 'integration-delivery';
const DUE_BATCH_SIZE = 50;

type SchedulerDeps = {
  deliveries: {
    list(): Promise<IntegrationDelivery[]>;
    listDue(now: number, limit?: number): Promise<IntegrationDelivery[]>;
    earliestNextAttemptAt(): Promise<number | undefined>;
  };
  dispatcher: {
    dispatch(deliveryId: string): Promise<IntegrationDelivery>;
  };
  createAlarm(name: string, info: chrome.alarms.AlarmCreateInfo): Promise<void>;
  getAlarm(name: string): Promise<chrome.alarms.Alarm | undefined>;
  clearAlarm(name: string): Promise<boolean>;
  now?: () => number;
  warn?: (...args: unknown[]) => void;
};

/** Keeps one Chrome alarm aligned with the durable outbox's earliest retry. */
export class IntegrationScheduler {
  private readonly now: () => number;
  private readonly warn: (...args: unknown[]) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? (() => {});
  }

  async ensureAlarm(): Promise<void> {
    const nextAttemptAt = await this.deps.deliveries.earliestNextAttemptAt();
    const alarm = await this.deps.getAlarm(INTEGRATION_DELIVERY_ALARM);
    if (nextAttemptAt == null) {
      if (alarm) await this.deps.clearAlarm(INTEGRATION_DELIVERY_ALARM);
      return;
    }

    const when = Math.max(this.now(), nextAttemptAt);
    if (alarm && Math.abs(alarm.scheduledTime - when) < 1_000) return;
    await this.deps.createAlarm(INTEGRATION_DELIVERY_ALARM, { when });
  }

  async reconcile(): Promise<void> {
    const now = this.now();
    const rows = await this.deps.deliveries.list();
    const stranded = rows.filter((delivery) => (
      delivery.state === 'pending'
      || delivery.state === 'delivering'
      || (delivery.state === 'retrying' && (delivery.nextAttemptAt ?? 0) <= now)
    ));
    await this.dispatchAll(stranded);
    await this.ensureAlarm();
  }

  handleAlarm(alarm: { name: string }): void {
    if (alarm.name !== INTEGRATION_DELIVERY_ALARM) return;
    void this.runDue().catch((error) => {
      this.warn('Integration delivery alarm failed:', error);
    });
  }

  async runDue(): Promise<void> {
    const due = await this.deps.deliveries.listDue(this.now(), DUE_BATCH_SIZE);
    await this.dispatchAll(due);
    await this.ensureAlarm();
  }

  private async dispatchAll(deliveries: IntegrationDelivery[]): Promise<void> {
    if (!deliveries.length) return;
    const results = await Promise.allSettled(
      deliveries.map((delivery) => this.deps.dispatcher.dispatch(delivery.id)),
    );
    for (const result of results) {
      if (result.status === 'rejected') this.warn('Integration delivery dispatch failed:', result.reason);
    }
  }
}

