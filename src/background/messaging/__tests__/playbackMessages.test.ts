import { handlePlaybackMessage } from '../playbackMessages';

jest.mock('../../../platform/chrome/runtime', () => ({
  getRuntimeId: () => 'ext-id',
  getRuntimeUrl: (path: string) => `chrome-extension://ext-id/${path}`,
}));

const sender = {
  id: 'ext-id',
  url: 'chrome-extension://ext-id/recordings.html?id=r1',
  tab: { id: 7 },
} as chrome.runtime.MessageSender;

describe('playback message lease handoff', () => {
  it('revalidates the recording after acquiring a retained-media lease', async () => {
    const firstManifest = {
      recordingId: 'r1',
      title: 'demo',
      createdAt: 1,
      transcriptStatus: 'none',
      notations: [],
      topics: [],
      tracks: [{
        fileId: 'r1:tab',
        stream: 'tab',
        filename: 'tab.webm',
        mimeType: 'video/webm',
        captureStartOffsetMs: 0,
        sources: [{ kind: 'opfs', key: 'library/r1/tab.webm' }],
      }],
    };
    const playback = {
      getManifest: jest.fn()
        .mockResolvedValueOnce(firstManifest)
        .mockResolvedValueOnce(undefined),
    };
    const playbackLeases = {
      acquire: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(0),
    };
    const sendResponse = jest.fn();

    await expect(handlePlaybackMessage(
      { type: 'GET_RECORDING_PLAYBACK_MANIFEST', recordingId: 'r1' },
      sender,
      sendResponse,
      { playback, playbackLeases } as never,
    )).resolves.toBe(true);

    expect(playbackLeases.acquire).toHaveBeenCalledWith(7, 'r1', ['library/r1/tab.webm']);
    expect(playbackLeases.release).toHaveBeenCalledWith(7, 'r1');
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: 'This recording is no longer available',
    });
  });
});
