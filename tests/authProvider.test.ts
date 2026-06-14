import { ChromeIdentityAuthProvider } from '../src/platform/capabilities/auth/ChromeIdentityAuthProvider';
import {
  WebAuthFlowAuthProvider,
  buildAuthUrl,
  parseAccessToken,
} from '../src/platform/capabilities/auth/WebAuthFlowAuthProvider';
import { createAuthProvider } from '../src/platform/capabilities/auth/createAuthProvider';

describe('ChromeIdentityAuthProvider', () => {
  beforeEach(() => jest.clearAllMocks());

  it('delegates getToken to chrome.identity.getAuthToken', async () => {
    (chrome.identity.getAuthToken as jest.Mock).mockImplementation((_d: any, cb: (t?: string) => void) => {
      (chrome.runtime as any).lastError = undefined;
      cb('chrome-token');
    });

    const provider = new ChromeIdentityAuthProvider();

    await expect(provider.getToken({ interactive: true })).resolves.toBe('chrome-token');
    expect(chrome.identity.getAuthToken).toHaveBeenCalledWith({ interactive: true }, expect.any(Function));
  });

  it('delegates invalidateToken to removeCachedAuthToken', async () => {
    await new ChromeIdentityAuthProvider().invalidateToken('old-token');
    expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith(
      { token: 'old-token' },
      expect.any(Function)
    );
  });
});

describe('WebAuthFlowAuthProvider helpers', () => {
  const config = {
    clientId: 'web-client-id',
    scopes: ['https://www.googleapis.com/auth/drive.file', 'email'],
    redirectUri: 'https://abc.chromiumapp.org/',
  };

  it('builds a Google implicit-flow auth URL with silent prompt', () => {
    const url = new URL(buildAuthUrl(config, false));
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('web-client-id');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.get('redirect_uri')).toBe('https://abc.chromiumapp.org/');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file email');
    expect(url.searchParams.get('prompt')).toBe('none');
  });

  it('uses an interactive consent prompt when interactive', () => {
    expect(new URL(buildAuthUrl(config, true)).searchParams.get('prompt')).toBe('consent');
  });

  it('parses the access token from the redirect fragment', () => {
    expect(
      parseAccessToken('https://abc.chromiumapp.org/#access_token=tok-123&token_type=Bearer&expires_in=3599')
    ).toBe('tok-123');
    expect(parseAccessToken('https://abc.chromiumapp.org/#error=access_denied')).toBeNull();
    expect(parseAccessToken('https://abc.chromiumapp.org/')).toBeNull();
  });
});

describe('WebAuthFlowAuthProvider', () => {
  const config = { clientId: 'web-client-id', scopes: ['s'], redirectUri: 'https://abc.chromiumapp.org/' };

  it('launches the flow and resolves with the access token', async () => {
    const launch = jest.fn().mockResolvedValue('https://abc.chromiumapp.org/#access_token=flow-token&token_type=Bearer');
    const provider = new WebAuthFlowAuthProvider(config, launch);

    await expect(provider.getToken({ interactive: false })).resolves.toBe('flow-token');
    expect(launch).toHaveBeenCalledWith(expect.stringContaining('client_id=web-client-id'), false);
  });

  it('fails fast when the client ID is not configured', async () => {
    const provider = new WebAuthFlowAuthProvider({ ...config, clientId: '' }, jest.fn());
    await expect(provider.getToken({ interactive: true })).rejects.toThrow(/client ID is not configured/);
  });

  it('rejects when the redirect carries no access token', async () => {
    const launch = jest.fn().mockResolvedValue('https://abc.chromiumapp.org/#error=access_denied');
    const provider = new WebAuthFlowAuthProvider(config, launch);
    await expect(provider.getToken({ interactive: false })).rejects.toThrow(/no access token/);
  });

  it('treats invalidateToken as a no-op', async () => {
    await expect(new WebAuthFlowAuthProvider(config, jest.fn()).invalidateToken('t')).resolves.toBeUndefined();
  });
});

describe('createAuthProvider', () => {
  it('selects ChromeIdentity when getAuthToken is available', () => {
    expect(createAuthProvider()).toBeInstanceOf(ChromeIdentityAuthProvider);
  });

  it('falls back to WebAuthFlow when getAuthToken is unavailable', () => {
    const original = chrome.identity.getAuthToken;
    delete (chrome.identity as any).getAuthToken;
    try {
      expect(createAuthProvider()).toBeInstanceOf(WebAuthFlowAuthProvider);
    } finally {
      (chrome.identity as any).getAuthToken = original;
    }
  });

  it('selects WebAuthFlow for a non-Chrome build target even when getAuthToken exists', () => {
    (globalThis as any).__BROWSER_TARGET__ = 'edge';
    try {
      expect(createAuthProvider()).toBeInstanceOf(WebAuthFlowAuthProvider);
    } finally {
      delete (globalThis as any).__BROWSER_TARGET__;
    }
  });
});
