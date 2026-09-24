import { INTEGRATION_DELIVERY_ALARM, IntegrationScheduler } from '../IntegrationScheduler';
import type { IntegrationDelivery } from '../persistence';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../policy';

function delivery(
  id: string,
  state: IntegrationDelivery['state'],
  nextAttemptAt?: number,
): IntegrationDelivery {
  return {
    id,
    destinationId: 'destination_1',
    recordingId: `recording_${id}`,
    externalRecordingId: `external_${id}`,
    eventId: `event_${id}`,
    eventType: 'recording.ready.v1',
    revision: 1,
    eventTime: 1,
    connectionVersion: 1,
    allowedPolicy: { ...CONSERVATIVE_INTEGRATION_POLICY, metadata: true },
    state,
    attemptCount: state === 'pending' ? 0 : 1,
    ...(nextAttemptAt != null ? { nextAttemptAt } : {}),
    bodyHash: 'a'.repeat(64),
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('IntegrationScheduler', () => {
  it('reconstructs stranded startup work and schedules only the next durable wake-up', async () => {
    const rows = [
      delivery('pending', 'pending'),
      delivery('delivering', 'delivering'),
      delivery('due', 'retrying', 900),
      delivery('future', 'retrying', 5_000),
      delivery('done', 'delivered'),
    ];
    const dispatch = jest.fn(async (id: string) => ({ ...rows.find((row) => row.id === id)!, state: 'delivered' as const }));
    const createAlarm = jest.fn(async () => {});
    const scheduler = new IntegrationScheduler({
      deliveries: {
        list: async () => rows,
        listDue: async () => [],
        earliestNextAttemptAt: async () => 5_000,
      },
      dispatcher: { dispatch },
      createAlarm,
      getAlarm: async () => undefined,
      clearAlarm: async () => true,
      now: () => 1_000,
    });

    await scheduler.reconcile();

    expect(dispatch.mock.calls.map(([id]) => id).sort()).toEqual(['delivering', 'due', 'pending']);
    expect(createAlarm).toHaveBeenCalledTimes(1);
    expect(createAlarm).toHaveBeenCalledWith(INTEGRATION_DELIVERY_ALARM, { when: 5_000 });
  });

  it('does not recreate an alarm that already matches the durable next attempt', async () => {
    const createAlarm = jest.fn(async () => {});
    const scheduler = new IntegrationScheduler({
      deliveries: {
        list: async () => [],
        listDue: async () => [],
        earliestNextAttemptAt: async () => 5_000,
      },
      dispatcher: { dispatch: jest.fn() },
      createAlarm,
      getAlarm: async () => ({ name: INTEGRATION_DELIVERY_ALARM, scheduledTime: 5_000 }),
      clearAlarm: async () => true,
      now: () => 1_000,
    });

    await scheduler.ensureAlarm();
    expect(createAlarm).not.toHaveBeenCalled();
  });

  it('dispatches newly due durable work without depending on a zero-delay Chrome alarm', async () => {
    const due = [delivery('due-now', 'retrying', 1_000)];
    const dispatch = jest.fn(async () => ({ ...due[0], state: 'delivered' as const }));
    const clearAlarm = jest.fn(async () => true);
    let earliest: number | undefined = 1_000;
    const scheduler = new IntegrationScheduler({
      deliveries: {
        list: async () => due,
        listDue: async () => {
          earliest = undefined;
          return due;
        },
        earliestNextAttemptAt: async () => earliest,
      },
      dispatcher: { dispatch },
      createAlarm: jest.fn(async () => {}),
      getAlarm: async () => ({ name: INTEGRATION_DELIVERY_ALARM, scheduledTime: 1_000 }),
      clearAlarm,
      now: () => 1_000,
    });

    await scheduler.stateChanged();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(clearAlarm).toHaveBeenCalledWith(INTEGRATION_DELIVERY_ALARM);
    expect(dispatch).toHaveBeenCalledWith('due-now');
  });

  it('clears the integration alarm when no durable work remains', async () => {
    const clearAlarm = jest.fn(async () => true);
    const scheduler = new IntegrationScheduler({
      deliveries: {
        list: async () => [],
        listDue: async () => [],
        earliestNextAttemptAt: async () => undefined,
      },
      dispatcher: { dispatch: jest.fn() },
      createAlarm: async () => {},
      getAlarm: async () => ({ name: INTEGRATION_DELIVERY_ALARM, scheduledTime: 5_000 }),
      clearAlarm,
      now: () => 1_000,
    });

    await scheduler.ensureAlarm();
    expect(clearAlarm).toHaveBeenCalledWith(INTEGRATION_DELIVERY_ALARM);
  });

  it('processes only indexed due work when the alarm fires and then rebuilds the next alarm', async () => {
    const due = [delivery('a', 'retrying', 1_000), delivery('b', 'retrying', 1_000)];
    const dispatch = jest.fn(async (id: string) => ({ ...due.find((row) => row.id === id)!, state: 'delivered' as const }));
    const createAlarm = jest.fn(async () => {});
    const scheduler = new IntegrationScheduler({
      deliveries: {
        list: async () => [],
        listDue: async (now, limit) => {
          expect(now).toBe(1_000);
          expect(limit).toBe(50);
          return due;
        },
        earliestNextAttemptAt: async () => 8_000,
      },
      dispatcher: { dispatch },
      createAlarm,
      getAlarm: async () => undefined,
      clearAlarm: async () => true,
      now: () => 1_000,
    });

    await scheduler.runDue();

    expect(dispatch.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b']);
    expect(createAlarm).toHaveBeenCalledWith(INTEGRATION_DELIVERY_ALARM, { when: 8_000 });
  });
});
