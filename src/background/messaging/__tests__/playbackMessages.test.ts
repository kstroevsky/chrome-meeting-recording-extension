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

describe('external playback capability authorization', () => {
  const artifactId = 'media_12345678-1234-1234-1234-123456789abc';
  const mediaClient = jest.fn();
  const playback = { getManifest: jest.fn() };
  const prepare = (overrides: Record<string, unknown> = {}) => ({
    type: 'PREPARE_EXTERNAL_PLAYBACK_SOURCE', recordingId: 'r1', fileId: 'r1:tab',
    destinationId: 'destination_1', artifactId, ...overrides,
  });
  const manifest = { recordingId: 'r1', tracks: [{
    fileId: 'r1:tab', sources: [
      { kind: 'external', destinationId: 'destination_1', artifactId },
    ],
  }] };

  beforeEach(() => {
    playback.getManifest.mockReset().mockResolvedValue(manifest);
    mediaClient.mockReset().mockResolvedValue({ playback: jest.fn().mockResolvedValue({
      url: 'https://storage.example.test/presigned?signature=1', expiresAt: '2026-10-09T00:00:00Z',
    }) });
  });

  async function send(msg = prepare(), from = sender) {
    const response = jest.fn();
    const handled = await handlePlaybackMessage(msg as never, from, response, {
      playback, integrations: { mediaClient },
    } as never);
    expect(handled).toBe(true);
    return response;
  }

  it('mints a URL only for a live track and returns no bearer credential', async () => {
    const response = await send();
    expect(mediaClient).toHaveBeenCalledWith('destination_1');
    expect(response).toHaveBeenCalledWith({
      ok: true, url: 'https://storage.example.test/presigned?signature=1',
    });
    expect(JSON.stringify(response.mock.calls)).not.toContain('Bearer');
  });

  it.each([
    ['wrong extension ID', { ...sender, id: 'another-extension' }],
    ['unrelated extension page', { ...sender, url: 'chrome-extension://ext-id/settings.html' }],
    ['page name in query', { ...sender, url: 'chrome-extension://ext-id/settings.html?path=/recordings.html' }],
    ['no tab', { ...sender, tab: undefined }],
    ['external webpage', { ...sender, url: 'https://ext-id/recordings.html' }],
  ])('rejects %s', async (_reason, from) => {
    const response = await send(prepare(), from as chrome.runtime.MessageSender);
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(mediaClient).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong recording', { recordingId: 'r2' }],
    ['wrong file', { fileId: 'r1:mic' }],
    ['wrong destination', { destinationId: 'destination_2' }],
    ['wrong artifact', { artifactId: 'media_ffffffff-ffff-ffff-ffff-ffffffffffff' }],
    ['malformed ID', { artifactId: {} }],
  ])('rejects %s association', async (_reason, override) => {
    const response = await send(prepare(override));
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(mediaClient).not.toHaveBeenCalled();
  });

  it('rejects deleted or tombstoned recordings before obtaining a client', async () => {
    playback.getManifest.mockResolvedValue(undefined);
    const response = await send();
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(mediaClient).not.toHaveBeenCalled();
  });
});
