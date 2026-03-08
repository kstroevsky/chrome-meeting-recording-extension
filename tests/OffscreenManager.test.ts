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

  it('syncs phase updates from offscreen to badge and popup broadcast', () => {
    manager.attachPort(mockPort);
    const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];
    const setBadgeTextSpy = jest.spyOn(chrome.action, 'setBadgeText');

    onMessageListener({ type: 'RECORDING_STATE', phase: 'uploading' });

    expect(manager.getRecordingStatus()).toBe('uploading');
    expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: 'UP' });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RECORDING_STATE',
        phase: 'uploading',
      })
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

  it('keeps OPFS cleanup only for successful downloads', () => {
    jest.useFakeTimers();
    manager.attachPort(mockPort);
    const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];

    (chrome.downloads.download as jest.Mock)
      .mockImplementationOnce((_opts: any, cb: Function) => {
        cb();
      })
      .mockImplementationOnce((_opts: any, cb: Function) => {
        (chrome.runtime as any).lastError = { message: 'Download blocked' };
        cb();
        (chrome.runtime as any).lastError = undefined;
      });

    onMessageListener({ type: 'OFFSCREEN_SAVE', filename: 'ok.webm', blobUrl: 'blob:ok', opfsFilename: 'ok.webm' });
    onMessageListener({ type: 'OFFSCREEN_SAVE', filename: 'fail.webm', blobUrl: 'blob:fail', opfsFilename: 'fail.webm' });

    jest.runAllTimers();

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
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'RECORDING_SAVE_ERROR', filename: 'fail.webm' })
    );

    jest.useRealTimers();
  });
});
