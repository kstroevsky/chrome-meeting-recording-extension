import {
  INTEGRATION_READINESS_ALARM,
  IntegrationReadinessScheduler,
} from '../IntegrationReadinessScheduler';
import type { IntegrationStream } from '../persistence';

function stream(recordingId: string, readyDeadlineAt?: number): IntegrationStream {
  return {
    destinationId: 'destination_1',
    recordingId,
    externalRecordingId: `external_${recordingId}`,
    nextRevision: 1,
    readyCreated: false,
    everAttempted: false,
    ...(readyDeadlineAt != null ? { readyDeadlineAt } : {}),
  };
}

describe('IntegrationReadinessScheduler', () => {
  it('rebuilds the earliest readiness alarm from durable stream state', async () => {
    const createAlarm = jest.fn(async () => {});
    const scheduler = new IntegrationReadinessScheduler({
      streams: { list: async () => [stream('a', 5_000), stream('b', 3_000)] },
      consider: jest.fn(async () => {}),
      createAlarm,
      getAlarm: async () => undefined,
      clearAlarm: async () => true,
      now: () => 1_000,
    });

    await scheduler.stateChanged();
    expect(createAlarm).toHaveBeenCalledWith(INTEGRATION_READINESS_ALARM, { when: 3_000 });
  });

  it('processes deadlines that expired while the service worker was unavailable', async () => {
    const rows = [stream('due', 900), stream('future', 5_000)];
    const consider = jest.fn(async (_destinationId: string, recordingId: string) => {
      const row = rows.find((candidate) => candidate.recordingId === recordingId);
      if (row) delete row.readyDeadlineAt;
    });
    const createAlarm = jest.fn(async () => {});
    const scheduler = new IntegrationReadinessScheduler({
      streams: { list: async () => rows },
      consider,
      createAlarm,
      getAlarm: async () => undefined,
      clearAlarm: async () => true,
      now: () => 1_000,
    });

    await scheduler.reconcile();

    expect(consider).toHaveBeenCalledWith('destination_1', 'due');
    expect(consider).not.toHaveBeenCalledWith('destination_1', 'future');
    expect(createAlarm).toHaveBeenCalledWith(INTEGRATION_READINESS_ALARM, { when: 5_000 });
  });

  it('clears the readiness alarm when no deadline remains', async () => {
    const clearAlarm = jest.fn(async () => true);
    const scheduler = new IntegrationReadinessScheduler({
      streams: { list: async () => [stream('ready')] },
      consider: jest.fn(async () => {}),
      createAlarm: async () => {},
      getAlarm: async () => ({ name: INTEGRATION_READINESS_ALARM, scheduledTime: 5_000 }),
      clearAlarm,
      now: () => 1_000,
    });

    await scheduler.stateChanged();
    expect(clearAlarm).toHaveBeenCalledWith(INTEGRATION_READINESS_ALARM);
  });
});
