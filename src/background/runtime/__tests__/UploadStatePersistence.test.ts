import type { UploadJob } from '../../../shared/recording';
import { UploadStatePersistence } from '../UploadStatePersistence';

const uploadJob = (status: UploadJob['status']): UploadJob => ({
  id: 'job-1',
  historyId: 'history-1',
  label: 'Meeting upload',
  status,
  progress: status === 'uploading' ? 0.5 : 1,
  files: [],
  startedAt: 1,
  ...(status === 'uploading' ? {} : { finishedAt: 2 }),
});

describe('UploadStatePersistence', () => {
  const logger = { warn: jest.fn() };

  beforeEach(() => logger.warn.mockReset());

  const createHarness = () => {
    const order: string[] = [];
    const session = {
      upsertUploadJob: jest.fn(() => { order.push('session-upsert'); }),
      flush: jest.fn(async () => { order.push('session-flush'); }),
      runDurationMs: jest.fn(() => 42_000),
    };
    const history = {
      applyUploadJob: jest.fn(async () => { order.push('history-apply'); }),
      setDuration: jest.fn(async () => { order.push('history-duration'); }),
    };
    const offscreen = {
      acknowledgeUploadState: jest.fn(async () => { order.push('ack'); }),
    };
    const telemetry = {
      bindUploadJob: jest.fn(),
      runIdForUploadJob: jest.fn(() => undefined),
      receive: jest.fn(async () => undefined),
      flushRun: jest.fn(async () => undefined),
      recordRecoveredUploadOutcome: jest.fn(async () => undefined),
    };
    const persistence = new UploadStatePersistence(
      session as any,
      history as any,
      offscreen as any,
      telemetry as any,
      logger,
    );
    return { order, session, history, offscreen, telemetry, persistence };
  };

  it('persists an uploading job to the session before history', async () => {
    const { order, offscreen, persistence } = createHarness();

    persistence.handleChanged(uploadJob('uploading'));
    await persistence.flush();

    expect(order).toEqual(['session-upsert', 'session-flush', 'history-apply', 'history-duration']);
    expect(offscreen.acknowledgeUploadState).not.toHaveBeenCalled();
  });

  it('persists a terminal job before acknowledging the offscreen replay item', async () => {
    const { order, offscreen, persistence } = createHarness();

    persistence.handleChanged(uploadJob('completed'));
    await persistence.flush();

    expect(order).toEqual(['history-apply', 'session-upsert', 'session-flush', 'history-duration', 'ack']);
    expect(offscreen.acknowledgeUploadState).toHaveBeenCalledWith('job-1');
  });

  it('does not acknowledge when durable session persistence fails', async () => {
    const { session, history, offscreen, persistence } = createHarness();
    session.flush.mockRejectedValueOnce(new Error('storage failed'));

    persistence.handleChanged(uploadJob('completed'));
    await persistence.flush();

    expect(history.applyUploadJob).toHaveBeenCalledTimes(1);
    expect(offscreen.acknowledgeUploadState).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Could not persist upload state:', expect.any(Error));
  });
});
