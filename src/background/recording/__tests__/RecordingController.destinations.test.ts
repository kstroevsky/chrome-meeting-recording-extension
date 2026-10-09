import { RecordingController } from '../RecordingController';
import { RecordingSession } from '../session/RecordingSession';
import type { OffscreenManager } from '../../offscreen/OffscreenManager';
import type { RecordingDestinationProfile } from '../../../shared/recordingDestinations';

jest.mock('../../../platform/chrome/tabs', () => ({
  activateTab: jest.fn().mockResolvedValue(undefined),
  getCapturedTabs: jest.fn().mockResolvedValue([]),
  getMediaStreamIdForTab: jest.fn().mockResolvedValue('stream-xyz'),
  getTab: jest.fn().mockResolvedValue({ url: 'https://meet.google.com/abc-defg-hij', title: 'Meet' }),
  sendTabMessage: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../shared/settings', () => ({
  loadRecorderRuntimeSettingsSnapshot: jest.fn().mockResolvedValue({ recorder: 'snapshot' }),
}));

const CRM: RecordingDestinationProfile = {
  id: 'profile-crm',
  name: 'CheekyCheeseIT',
  mediaTarget: { kind: 'local' },
  dataRoutes: [{ destinationId: 'destination_crm', mode: 'auto' }],
};

describe('RecordingController — Save to destination at Start', () => {
  let session: RecordingSession;
  let offscreen: { ensureReady: jest.Mock; rpc: jest.Mock };
  let contexts: { begin: jest.Mock; finish: jest.Mock; remove: jest.Mock };
  let destinations: { resolveForStart: jest.Mock; remember: jest.Mock };
  let routing: { begin: jest.Mock; forget: jest.Mock };
  let order: string[];
  let controller: RecordingController;

  beforeEach(() => {
    jest.clearAllMocks();
    order = [];
    session = new RecordingSession(() => {});
    contexts = {
      begin: jest.fn().mockResolvedValue(undefined),
      finish: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    offscreen = {
      ensureReady: jest.fn().mockResolvedValue(undefined),
      rpc: jest.fn().mockImplementation(async () => { order.push('offscreen'); return { ok: true }; }),
    };
    destinations = {
      resolveForStart: jest.fn().mockResolvedValue({ profile: CRM, requested: CRM, available: true }),
      remember: jest.fn().mockResolvedValue(undefined),
    };
    routing = {
      begin: jest.fn().mockImplementation(async () => { order.push('routing'); }),
      forget: jest.fn().mockResolvedValue(undefined),
    };
    controller = new RecordingController({
      L: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      offscreen: offscreen as unknown as OffscreenManager,
      session,
      recordingContexts: contexts as never,
      destinations,
      routing,
    });
  });

  const start = (runConfig: Record<string, unknown>) => controller.start({
    type: 'START_RECORDING',
    tabId: 42,
    runConfig: { micMode: 'off', recordSelfVideo: false, tabContentType: 'screen', ...runConfig },
  });

  it('takes the storage mode from the stored profile and holds its routes before capture starts', async () => {
    // The popup claims Drive; the stored profile says local, and the profile wins.
    const result = await start({ storageMode: 'drive', destinationProfileId: 'profile-crm' });
    const snapshot = session.getSnapshot();

    expect(result.ok).toBe(true);
    expect(destinations.resolveForStart).toHaveBeenCalledWith('profile-crm', 'drive');
    expect(snapshot.runConfig).toEqual(expect.objectContaining({ storageMode: 'local', destinationProfileId: 'profile-crm' }));
    expect(contexts.begin).toHaveBeenCalledWith(
      snapshot.historyId,
      expect.any(Number),
      expect.anything(),
      'profile-crm',
      { kind: 'local' },
      CRM.dataRoutes,
    );
    expect(routing.begin).toHaveBeenCalledWith(snapshot.historyId, CRM.dataRoutes);
    expect(order).toEqual(['routing', 'offscreen']);
    expect(destinations.remember).toHaveBeenCalledWith('profile-crm');
  });

  it('records an unavailable pick in the context but schedules nothing', async () => {
    destinations.resolveForStart.mockResolvedValueOnce({ profile: CRM, requested: CRM, available: false });

    await expect(start({ storageMode: 'local', destinationProfileId: 'profile-crm' })).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(contexts.begin).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.anything(),
      'profile-crm',
      { kind: 'local' },
      CRM.dataRoutes,
    );
    expect(routing.begin).not.toHaveBeenCalled();
  });

  it('freezes an external primary target and schedules media-only consent when it has no data route', async () => {
    const external: RecordingDestinationProfile = {
      id: 'profile-external',
      name: 'CRM media',
      mediaTarget: { kind: 'external', destinationId: 'destination_crm' },
      dataRoutes: [],
    };
    destinations.resolveForStart.mockResolvedValueOnce({ profile: external, requested: external, available: true });

    await expect(start({ storageMode: 'drive', destinationProfileId: 'profile-external' })).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    const historyId = session.getSnapshot().historyId;
    const expectedRoutes = [{ destinationId: 'destination_crm', mode: 'auto', mediaOnly: true }];
    expect(session.getSnapshot().runConfig).toEqual(expect.objectContaining({
      storageMode: 'local',
      destinationProfileId: 'profile-external',
    }));
    expect(contexts.begin).toHaveBeenCalledWith(
      historyId,
      expect.any(Number),
      expect.anything(),
      'profile-external',
      external.mediaTarget,
      expectedRoutes,
    );
    expect(routing.begin).toHaveBeenCalledWith(historyId, expectedRoutes);
  });

  it('uses one combined route when the external primary receiver also receives data', async () => {
    const combined: RecordingDestinationProfile = {
      id: 'profile-external',
      name: 'CRM media + data',
      mediaTarget: { kind: 'external', destinationId: 'destination_crm' },
      dataRoutes: [{ destinationId: 'destination_crm', mode: 'auto' }],
    };
    destinations.resolveForStart.mockResolvedValueOnce({ profile: combined, requested: combined, available: true });

    await start({ storageMode: 'local', destinationProfileId: 'profile-external' });
    expect(routing.begin).toHaveBeenCalledWith(session.getSnapshot().historyId, combined.dataRoutes);
  });

  it('never fails Start because routing could not be written', async () => {
    routing.begin.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
    await expect(start({ storageMode: 'local', destinationProfileId: 'profile-crm' })).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(offscreen.rpc).toHaveBeenCalled();
  });

  it('still starts when the destination owner itself fails, without routing', async () => {
    destinations.resolveForStart.mockRejectedValueOnce(new Error('settings unreadable'));
    await expect(start({ storageMode: 'local', destinationProfileId: 'profile-crm' })).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(routing.begin).not.toHaveBeenCalled();
  });

  it('forgets the held routes when the offscreen definitively rejects the start', async () => {
    offscreen.rpc.mockResolvedValueOnce({ ok: false, error: 'capture rejected' });
    const result = await start({ storageMode: 'local', destinationProfileId: 'profile-crm' });
    expect(result.ok).toBe(false);
    expect(routing.forget).toHaveBeenCalledWith(session.getSnapshot().historyId);
  });

  it('forgets the held routes when the run is discarded', async () => {
    await start({ storageMode: 'local', destinationProfileId: 'profile-crm' });
    const historyId = session.getSnapshot().historyId!;
    session.applyOffscreenPhase({ phase: 'recording', epoch: session.getSnapshot().epoch });

    await controller.discard();
    expect(routing.forget).toHaveBeenCalledWith(historyId);
  });

  it('does not route a built-in destination', async () => {
    const drive: RecordingDestinationProfile = { id: 'builtin:drive', name: 'Google Drive', mediaTarget: { kind: 'drive' }, dataRoutes: [] };
    destinations.resolveForStart.mockResolvedValueOnce({ profile: drive, requested: drive, available: true });
    await start({ storageMode: 'drive', destinationProfileId: 'builtin:drive' });
    expect(routing.begin).not.toHaveBeenCalled();
    expect(session.getSnapshot().runConfig?.storageMode).toBe('drive');
  });
});
