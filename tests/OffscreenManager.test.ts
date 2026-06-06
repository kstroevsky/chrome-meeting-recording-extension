import { OffscreenManager } from '../src/background/OffscreenManager';
import { getBuildId } from '../src/shared/build';

describe('OffscreenManager', () => {
  let manager: OffscreenManager;
  let mockPort: any;

  beforeEach(() => {
    manager = new OffscreenManager();
    mockPort = {
      name: 'offscreen',
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('creates offscreen document if it does not exist', async () => {
    const createDocumentSpy = jest
      .spyOn(chrome.offscreen, 'createDocument')
      .mockImplementation(async () => {});

    const ensureReadyPromise = manager.ensureReady();
    manager.attachPort(mockPort);

    const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];
    onMessageListener({ type: 'OFFSCREEN_READY', version: getBuildId() });

    await ensureReadyPromise;

    expect(createDocumentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'chrome-extension://mock-id/offscreen.html',
        reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      })
    );
  });

  it('requests a reconnect when an offscreen document exists without a ready port', async () => {
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(true);

    const ensureReadyPromise = manager.ensureReady();
    await Promise.resolve();
    await Promise.resolve();

    manager.attachPort(mockPort);
    const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];
    onMessageListener({ type: 'OFFSCREEN_READY', version: getBuildId() });

    await ensureReadyPromise;

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'OFFSCREEN_CONNECT' });
    expect(chrome.offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('recreates a stale offscreen document whose READY reports a mismatched version', async () => {
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    const createDocumentSpy = jest
      .spyOn(chrome.offscreen, 'createDocument')
      .mockImplementation(async () => {});
    const closeDocumentSpy = jest
      .spyOn(chrome.offscreen, 'closeDocument')
      .mockImplementation(async () => {});

    const ensureReadyPromise = manager.ensureReady();
    manager.attachPort(mockPort);

    // A stale offscreen (old build) connects and reports an outdated version.
    const staleListener = mockPort.onMessage.addListener.mock.calls[0][0];
    staleListener({ type: 'OFFSCREEN_READY', version: '0.0.1-old' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The manager should have closed the stale doc and created a fresh one,
    // without resolving ensureReady yet.
    expect(closeDocumentSpy).toHaveBeenCalledTimes(1);
    expect(createDocumentSpy).toHaveBeenCalledTimes(2);

    // The fresh document connects and reports the current version → ready resolves.
    const freshPort: any = {
      name: 'offscreen',
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    };
    manager.attachPort(freshPort);
    const freshListener = freshPort.onMessage.addListener.mock.calls[0][0];
    freshListener({ type: 'OFFSCREEN_READY', version: getBuildId() });

    await expect(ensureReadyPromise).resolves.toBeUndefined();
  });

  it('rejects ensureReady when recreating a stale offscreen fails (no deadlock)', async () => {
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    jest
      .spyOn(chrome.offscreen, 'createDocument')
      .mockImplementationOnce(async () => {}) // initial create succeeds
      .mockImplementation(async () => { throw new Error('create failed'); }); // recreate fails
    jest.spyOn(chrome.offscreen, 'closeDocument').mockImplementation(async () => {});

    const ensureReadyPromise = manager.ensureReady();
    manager.attachPort(mockPort);
    const listener = mockPort.onMessage.addListener.mock.calls[0][0];
    listener({ type: 'OFFSCREEN_READY', version: '0.0.1-old' }); // mismatch → recreate → create throws

    await expect(ensureReadyPromise).rejects.toThrow('create failed');
  });

  it('recreates at most once even if the fresh offscreen also mismatches (no loop)', async () => {
    (chrome.offscreen.hasDocument as jest.Mock).mockResolvedValue(false);
    jest.spyOn(chrome.offscreen, 'createDocument').mockImplementation(async () => {});
    const closeDocumentSpy = jest
      .spyOn(chrome.offscreen, 'closeDocument')
      .mockImplementation(async () => {});

    const ensureReadyPromise = manager.ensureReady();
    manager.attachPort(mockPort);
    const staleListener = mockPort.onMessage.addListener.mock.calls[0][0];
    staleListener({ type: 'OFFSCREEN_READY', version: 'stale-1' }); // mismatch → recreate
    await new Promise((resolve) => setTimeout(resolve, 0));

    const freshPort: any = {
      name: 'offscreen',
      onMessage: { addListener: jest.fn() },
      onDisconnect: { addListener: jest.fn() },
      postMessage: jest.fn(),
    };
    manager.attachPort(freshPort);
    const freshListener = freshPort.onMessage.addListener.mock.calls[0][0];
    // Even though this id still mismatches, the recreate-once guard accepts it.
    freshListener({ type: 'OFFSCREEN_READY', version: 'stale-2' });

    await expect(ensureReadyPromise).resolves.toBeUndefined();
    expect(closeDocumentSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses to close the offscreen document for update while work is in flight', async () => {
    const closeDocumentSpy = jest
      .spyOn(chrome.offscreen, 'closeDocument')
      .mockImplementation(async () => {});

    manager.hydratePhase('recording');

    await expect(manager.closeForUpdate()).resolves.toBe(false);
    expect(closeDocumentSpy).not.toHaveBeenCalled();
  });

  it('closes the offscreen document for update when idle', async () => {
    const closeDocumentSpy = jest
      .spyOn(chrome.offscreen, 'closeDocument')
      .mockImplementation(async () => {});

    manager.hydratePhase('idle');

    await expect(manager.closeForUpdate()).resolves.toBe(true);
    expect(closeDocumentSpy).toHaveBeenCalledTimes(1);
  });

  it('syncs phase updates from offscreen to the badge and listener callback', () => {
    manager.attachPort(mockPort);
    manager.onStateChanged = jest.fn();
    const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];
    const setBadgeTextSpy = jest.spyOn(chrome.action, 'setBadgeText');

    onMessageListener({ type: 'OFFSCREEN_STATE', phase: 'uploading' });

    expect(manager.getRecordingStatus()).toBe('uploading');
    expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: 'UP' });
    expect(manager.onStateChanged).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OFFSCREEN_STATE', phase: 'uploading' })
    );
  });

  it('gracefully handles port disconnects', () => {
    manager.attachPort(mockPort);
    expect((manager as any).port).toBe(mockPort);

    const disconnectListener = mockPort.onDisconnect.addListener.mock.calls[0][0];
    disconnectListener();

    expect((manager as any).port).toBe(null);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('forwards blob cleanup requests back to the offscreen port', () => {
    manager.attachPort(mockPort);

    manager.revokeBlobUrl('blob:ok', 'ok.webm');
    manager.revokeBlobUrl('blob:fail');

    expect(mockPort.postMessage).toHaveBeenCalledWith({
      type: 'REVOKE_BLOB_URL',
      blobUrl: 'blob:ok',
      opfsFilename: 'ok.webm',
    });
    expect(mockPort.postMessage).toHaveBeenCalledWith({
      type: 'REVOKE_BLOB_URL',
      blobUrl: 'blob:fail',
      opfsFilename: undefined,
    });
  });
});
