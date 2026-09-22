import { registerSaveHandler } from '../LocalDeliveryRuntime';
import { LocalDeliveryOrchestrator } from '../LocalDeliveryOrchestrator';

jest.mock('../LocalDeliveryRuntime', () => ({
  registerSaveHandler: jest.fn(),
}));

describe('LocalDeliveryOrchestrator', () => {
  let deliverDeferred: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    deliverDeferred = jest.fn().mockResolvedValue([]);
    (registerSaveHandler as jest.Mock).mockReturnValue({
      deliverDeferred,
    });
  });

  function create(overrides: { get?: jest.Mock; history?: Record<string, jest.Mock> } = {}) {
    const history = overrides.history ?? { setLocalFolder: jest.fn() };
    const get = overrides.get ?? jest.fn();
    return new LocalDeliveryOrchestrator(
      {} as never,
      history as never,
      { listPage: jest.fn(), get } as never,
      () => undefined,
      { log: jest.fn(), warn: jest.fn() },
    );
  }

  it('schedules a short recovery alarm when a local delivery is deferred', async () => {
    create();
    const deferred = (registerSaveHandler as jest.Mock).mock.calls[0][5] as () => void;

    deferred();
    await Promise.resolve();

    expect(chrome.alarms.create).toHaveBeenCalledWith(
      'local-delivery-timeout',
      { delayInMinutes: 0.5 },
    );
  });

  it('reconciles only the local-delivery alarm', async () => {
    const orchestrator = create();
    const reconcile = jest.spyOn(orchestrator, 'reconcileAbandoned').mockResolvedValue(undefined);

    orchestrator.handleAlarm({ name: 'other' });
    expect(reconcile).not.toHaveBeenCalled();

    orchestrator.handleAlarm({ name: 'local-delivery-timeout' });
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('rejects a user delivery when no requested artifact was actually attempted', async () => {
    const get = jest.fn().mockResolvedValue({ id: 'r1', files: [], name: 'demo' });
    const orchestrator = create({ get });

    await expect(orchestrator.deliver('r1', null)).rejects.toThrow(
      'This recording has no pending local files to deliver',
    );
  });

  it('rejects a partially failed user delivery instead of returning success', async () => {
    deliverDeferred.mockResolvedValue([
      { status: 'complete', downloadId: 1 },
      { status: 'not-started', error: 'missing' },
    ]);
    const get = jest.fn().mockResolvedValue({ id: 'r1', files: [], name: 'demo' });
    const orchestrator = create({ get });

    await expect(orchestrator.deliver('r1', null)).rejects.toThrow(
      'Local delivery did not fully complete (complete, not-started)',
    );
  });

  it('records the folder only after every requested artifact completes', async () => {
    deliverDeferred.mockResolvedValue([{ status: 'complete', downloadId: 1 }]);
    const history = { setLocalFolder: jest.fn().mockResolvedValue(undefined) };
    const get = jest.fn().mockResolvedValue({ id: 'r1', files: [], name: 'demo' });
    const orchestrator = create({ get, history });

    await expect(orchestrator.deliver('r1', null)).resolves.toBeUndefined();
    expect(history.setLocalFolder).toHaveBeenCalledWith('r1', undefined);
  });
});
