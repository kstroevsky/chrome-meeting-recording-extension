import type { ExternalMediaTransferView } from '../../../shared/protocol';
import { ExternalMediaRetryScheduler } from '../ExternalMediaRetryScheduler';

function transfer(nextAttemptAt: number): ExternalMediaTransferView {
  return {
    destinationId: 'crm',
    source: { kind: 'opfs', key: 'library/r/f/clip.webm' },
    request: {
      clientTransferId: `transfer-${nextAttemptAt}`,
      recordingId: 'recording_external',
      artifact: { role: 'tab-recording', filename: 'clip.webm', mimeType: 'video/webm', bytes: 1 },
    },
    uploadedParts: [],
    state: 'retry-wait',
    nextAttemptAt,
  };
}

describe('ExternalMediaRetryScheduler', () => {
  beforeEach(() => {
    (chrome.alarms.create as jest.Mock).mockReset().mockResolvedValue(undefined);
    (chrome.alarms.get as jest.Mock).mockReset().mockResolvedValue(undefined);
    (chrome.alarms.clear as jest.Mock).mockReset().mockResolvedValue(true);
  });

  it('arms the earliest durable retry and clears the alarm when none remain', async () => {
    const scheduler = new ExternalMediaRetryScheduler(async () => {});

    await scheduler.sync([transfer(4_000), transfer(2_000)]);
    expect(chrome.alarms.create).toHaveBeenCalledWith('external-media-retry', { when: 2_000 });

    await scheduler.sync([]);
    expect(chrome.alarms.clear).toHaveBeenCalledWith('external-media-retry');
  });

  it('does not replace an earlier alarm and wakes reconciliation only for its own alarm', async () => {
    const onDue = jest.fn(async () => {});
    const scheduler = new ExternalMediaRetryScheduler(onDue);
    (chrome.alarms.get as jest.Mock).mockResolvedValue({
      name: 'external-media-retry',
      scheduledTime: 1_000,
    });

    await scheduler.observe(transfer(2_000));
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    scheduler.handleAlarm({ name: 'other' });
    scheduler.handleAlarm({ name: 'external-media-retry' });
    await Promise.resolve();
    expect(onDue).toHaveBeenCalledTimes(1);
  });
});
