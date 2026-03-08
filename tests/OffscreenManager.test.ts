import { OffscreenManager } from '../src/background/OffscreenManager';

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
    onMessageListener({ type: 'OFFSCREEN_READY' });

    await ensureReadyPromise;

    expect(createDocumentSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'chrome-extension://mock-id/offscreen.html',
        reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      })
    );
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
