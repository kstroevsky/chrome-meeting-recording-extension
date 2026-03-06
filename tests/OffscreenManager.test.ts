import { OffscreenManager } from '../src/background/OffscreenManager';
import { TIMEOUTS } from '../src/shared/timeouts';

describe('OffscreenManager', () => {
    let manager: OffscreenManager;
    let mockPort: any;

    beforeEach(() => {
        manager = new OffscreenManager();
        mockPort = {
            name: 'offscreen',
            onMessage: { addListener: jest.fn() },
            onDisconnect: { addListener: jest.fn() },
            postMessage: jest.fn()
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('creates offscreen document if it does not exist', async () => {
        const createDocumentSpy = jest.spyOn(chrome.offscreen, 'createDocument')
            .mockImplementation(async () => {});

        // We don't want ensureReady to hang waiting for the port ready signal
        // We simulate the port attaching and signaling ready immediately
        const ensureReadyPromise = manager.ensureReady();
        
        // Simulate extension messaging behavior
        manager.attachPort(mockPort);
        
        // Find the onMessage listener attached inside attachPort
        const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];
        onMessageListener({ type: 'OFFSCREEN_READY' });

        await ensureReadyPromise;

        expect(createDocumentSpy).toHaveBeenCalled();
        expect(createDocumentSpy.mock.calls[0][0]).toMatchObject({
            url: 'chrome-extension://mock-id/offscreen.html',
            reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
            justification: 'Record tab audio+video in offscreen using MediaRecorder'
        });
    });

    it('syncs recording state from offscreen to badge and background', () => {
        manager.attachPort(mockPort);
        const onMessageListener = mockPort.onMessage.addListener.mock.calls[0][0];

        // Ensure badge tracking works
        const setBadgeTextSpy = jest.spyOn(chrome.action, 'setBadgeText');
        
        // Invoke mock message
        onMessageListener({ type: 'RECORDING_STATE', recording: true });

        expect(manager.getRecordingStatus()).toBe(true);
        expect(setBadgeTextSpy).toHaveBeenCalledWith({ text: 'REC' });
        expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'RECORDING_STATE', recording: true });
    });

    it('gracefully handles port disconnects', () => {
        manager.attachPort(mockPort);
        expect((manager as any).port).toBe(mockPort);

        const disconnectListener = mockPort.onDisconnect.addListener.mock.calls[0][0];
        disconnectListener();

        expect((manager as any).port).toBe(null);
        expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' }); // clears REC badge
    });
});
