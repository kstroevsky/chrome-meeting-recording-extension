import { fetchDriveTokenWithFallback } from '../src/background/driveAuth';

type AuthReply = { token?: string; error?: string };

function mockAuthReplies(replies: AuthReply[]) {
  (chrome.identity.getAuthToken as jest.Mock).mockImplementation((_details: any, cb: (token?: string) => void) => {
    const reply = replies.shift();
    if (!reply) throw new Error('No mocked auth replies left');
    (chrome.runtime as any).lastError = reply.error ? { message: reply.error } : undefined;
    cb(reply.token);
    (chrome.runtime as any).lastError = undefined;
  });
}

describe('driveAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (chrome.runtime as any).id = 'abcdefghabcdefghabcdefghabcdefgh';
    (chrome.runtime.getManifest as jest.Mock).mockReturnValue({
      oauth2: {
        client_id: 'manifest-client-id.apps.googleusercontent.com',
      },
    });
    (chrome.identity.removeCachedAuthToken as jest.Mock).mockImplementation((_details: any, cb?: () => void) => cb?.());
  });

  it('returns token when silent auth succeeds', async () => {
    mockAuthReplies([{ token: 'silent-token' }]);

    const result = await fetchDriveTokenWithFallback();

    expect(result).toEqual({ ok: true, token: 'silent-token' });
    expect(chrome.identity.getAuthToken).toHaveBeenCalledTimes(1);
    expect(chrome.identity.getAuthToken).toHaveBeenNthCalledWith(1, { interactive: false }, expect.any(Function));
  });

  it('retries with interactive auth when silent auth fails', async () => {
    mockAuthReplies([
      { error: 'OAuth2 not granted yet' },
      { token: 'interactive-token' },
    ]);

    const result = await fetchDriveTokenWithFallback();

    expect(result).toEqual({ ok: true, token: 'interactive-token' });
    expect(chrome.identity.getAuthToken).toHaveBeenCalledTimes(2);
    expect(chrome.identity.getAuthToken).toHaveBeenNthCalledWith(1, { interactive: false }, expect.any(Function));
    expect(chrome.identity.getAuthToken).toHaveBeenNthCalledWith(2, { interactive: true }, expect.any(Function));
  });

  it('returns actionable error for bad client id', async () => {
    mockAuthReplies([
      { error: "OAuth2 request failed: Service responded with error: 'bad client id: 908748525392-0mjfkrpc11tvssqjg7mlsbf621f51eq4.apps.googleusercontent.com'" },
    ]);

    const result = await fetchDriveTokenWithFallback();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Google OAuth is misconfigured');
      expect(result.error).toContain('Current extension ID: abcdefghabcdefghabcdefghabcdefgh');
      expect(result.error).toContain('Manifest client ID: manifest-client-id.apps.googleusercontent.com');
      expect(result.error).toContain('Chrome Extension');
    }
    expect(chrome.identity.getAuthToken).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cached auth token before a forced refresh', async () => {
    mockAuthReplies([
      { token: 'cached-token' },
      { token: 'refreshed-token' },
    ]);

    const first = await fetchDriveTokenWithFallback();
    const second = await fetchDriveTokenWithFallback({ refresh: true });

    expect(first).toEqual({ ok: true, token: 'cached-token' });
    expect(second).toEqual({ ok: true, token: 'refreshed-token' });
    expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith(
      { token: 'cached-token' },
      expect.any(Function)
    );
  });
});
