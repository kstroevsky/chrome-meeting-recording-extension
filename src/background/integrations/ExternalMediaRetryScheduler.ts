import { clearAlarm, createAlarm, getAlarm } from '../../platform/chrome/alarms';
import type { ExternalMediaTransferView } from '../../shared/protocol';

const ALARM_NAME = 'external-media-retry';

/** Wakes background after durable retry-wait state survives a worker/offscreen restart. */
export class ExternalMediaRetryScheduler {
  constructor(private readonly onDue: () => Promise<void>) {}

  async sync(transfers: readonly ExternalMediaTransferView[]): Promise<void> {
    const next = earliestRetry(transfers);
    if (next == null) {
      await clearAlarm(ALARM_NAME);
      return;
    }
    await createAlarm(ALARM_NAME, { when: next });
  }

  async observe(transfer: ExternalMediaTransferView): Promise<void> {
    if (transfer.state !== 'retry-wait' || transfer.nextAttemptAt == null) return;
    const current = await getAlarm(ALARM_NAME);
    if (current?.scheduledTime != null && current.scheduledTime <= transfer.nextAttemptAt) return;
    await createAlarm(ALARM_NAME, { when: transfer.nextAttemptAt });
  }

  handleAlarm(alarm: { name: string }): void {
    if (alarm.name !== ALARM_NAME) return;
    void this.onDue();
  }
}

function earliestRetry(transfers: readonly ExternalMediaTransferView[]): number | undefined {
  let earliest: number | undefined;
  for (const transfer of transfers) {
    if (transfer.state !== 'retry-wait' || transfer.nextAttemptAt == null) continue;
    earliest = earliest == null ? transfer.nextAttemptAt : Math.min(earliest, transfer.nextAttemptAt);
  }
  return earliest;
}
