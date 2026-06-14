import { ChromeIdentityAuthProvider } from '../src/platform/capabilities/auth/ChromeIdentityAuthProvider';
import {
  WebAuthFlowAuthProvider,
  buildAuthUrl,
  parseAuthRedirect,
  deriveCodeChallenge,
  createPkcePair,
  exchangeAuthCodeForToken,
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

const config = {
  clientId: 'web-client-id',
  clientSecret: 'web-secret',
  scopes: ['https://www.googleapis.com/auth/drive.file', 'email'],
  redirectUri: 'https://abc.chromiumapp.org/',
};

describe('WebAuthFlow PKCE + URL helpers', () => {
  it('derives the RFC 7636 S256 challenge from a verifier', async () => {
    // RFC 7636 Appendix B test vector.
    await expect(
      deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
    ).resolves.toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('creates a url-safe verifier whose challenge derives from it', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toBe(await deriveCodeChallenge(verifier));
  });

  it('builds an authorization-code + PKCE auth URL', () => {
    const url = new URL(buildAuthUrl(config, { codeChallenge: 'CH', state: 'ST', interactive: false }));
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('web-client-id');
    expect(url.searchParams.get('code_challenge')).toBe('CH');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('ST');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file email');
    expect(url.searchParams.get('prompt')).toBe('none');
  });

  it('uses an interactive consent prompt when interactive', () => {
    const url = new URL(buildAuthUrl(config, { codeChallenge: 'CH', state: 'ST', interactive: true }));
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('parses code and state from the redirect query', () => {
    expect(parseAuthRedirect('https://abc.chromiumapp.org/?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseAuthRedirect('https://abc.chromiumapp.org/?error=denied')).toEqual({ code: null, state: null });
    expect(parseAuthRedirect('https://abc.chromiumapp.org/')).toEqual({ code: null, state: null });
  });
});

describe('exchangeAuthCodeForToken', () => {
  afterEach(() => { (global as any).fetch = undefined; });

  it('POSTs code + verifier + secret and returns the access token', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ access_token: 'at-123' }) });

    await expect(exchangeAuthCodeForToken({ code: 'c', codeVerifier: 'v', config })).resolves.toBe('at-123');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.body).toContain('grant_type=authorization_code');
    expect(init.body).toContain('code_verifier=v');
    expect(init.body).toContain('client_secret=web-secret');
  });

  it('throws with detail on a non-OK response', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' });
    await expect(exchangeAuthCodeForToken({ code: 'c', codeVerifier: 'v', config })).rejects.toThrow(/400.*invalid_grant/);
  });

  it('throws when no access_token is returned', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(exchangeAuthCodeForToken({ code: 'c', codeVerifier: 'v', config })).rejects.toThrow(/no access_token/);
  });
});

describe('WebAuthFlowAuthProvider', () => {
  function deps(over: Record<string, unknown> = {}) {
    return {
      launch: jest.fn().mockImplementation((url: string) => {
        const state = new URL(url).searchParams.get('state');
        return Promise.resolve(`https://abc.chromiumapp.org/?code=auth-code&state=${state}`);
      }),
      createPkce: jest.fn().mockResolvedValue({ verifier: 'ver', challenge: 'chal' }),
      exchange: jest.fn().mockResolvedValue('final-token'),
      ...over,
    };
  }

  it('runs code+PKCE and resolves with the exchanged token', async () => {
    const d = deps();
    const provider = new WebAuthFlowAuthProvider(config, d);

    await expect(provider.getToken({ interactive: false })).resolves.toBe('final-token');
    expect(d.launch).toHaveBeenCalledWith(expect.stringContaining('response_type=code'), false);
    expect(d.launch).toHaveBeenCalledWith(expect.stringContaining('code_challenge=chal'), false);
    expect(d.exchange).toHaveBeenCalledWith({ code: 'auth-code', codeVerifier: 'ver', config });
  });

  it('fails fast when the client ID is not configured', async () => {
    const provider = new WebAuthFlowAuthProvider({ ...config, clientId: '' }, deps());
    await expect(provider.getToken({ interactive: true })).rejects.toThrow(/client ID is not configured/);
  });

  it('rejects on a state mismatch (CSRF guard)', async () => {
    const provider = new WebAuthFlowAuthProvider(config, deps({
      launch: jest.fn().mockResolvedValue('https://abc.chromiumapp.org/?code=c&state=WRONG'),
    }));
    await expect(provider.getToken({ interactive: false })).rejects.toThrow(/state mismatch/);
  });

  it('rejects when the redirect carries no authorization code', async () => {
    const provider = new WebAuthFlowAuthProvider(config, deps({
      launch: jest.fn().mockImplementation((url: string) => {
        const state = new URL(url).searchParams.get('state');
        return Promise.resolve(`https://abc.chromiumapp.org/?error=denied&state=${state}`);
      }),
    }));
    await expect(provider.getToken({ interactive: false })).rejects.toThrow(/no authorization code/);
  });

  it('treats invalidateToken as a no-op', async () => {
    await expect(new WebAuthFlowAuthProvider(config, deps()).invalidateToken('t')).resolves.toBeUndefined();
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
