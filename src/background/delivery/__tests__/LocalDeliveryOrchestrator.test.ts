import { registerSaveHandler } from '../LocalDeliveryRuntime';
import { LocalDeliveryOrchestrator } from '../LocalDeliveryOrchestrator';

jest.mock('../LocalDeliveryRuntime', () => ({
  registerSaveHandler: jest.fn(),
}));

describe('LocalDeliveryOrchestrator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (registerSaveHandler as jest.Mock).mockReturnValue({
      deliverDeferred: jest.fn().mockResolvedValue([]),
    });
  });

  function create() {
    return new LocalDeliveryOrchestrator(
      {} as never,
      {} as never,
      { listPage: jest.fn(), get: jest.fn() } as never,
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
});
