import type { TokenProvider } from '../offscreen/drive/request';
import { normalizeServiceOrigin } from './ShareServiceClient';

type OwnerSessionResponse = {
  token: string;
  expiresAt: number;
};

export type ShareOwnerSessionDeps = {
  fetch?: typeof fetch;
  now?: () => number;
};

const EXPIRY_SKEW_MS = 30_000;

/** Exchanges a Google identity token for a short-lived sharing-service session. */
export class ShareOwnerSession {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private cached: OwnerSessionResponse | null = null;
  private pending: Promise<OwnerSessionResponse> | null = null;

  constructor(
    baseUrl: string,
    private readonly getIdentityToken: TokenProvider,
    deps: ShareOwnerSessionDeps = {},
  ) {
    this.origin = normalizeServiceOrigin(baseUrl);
    this.fetcher = deps.fetch ?? fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
  }

  async headers(options?: { refresh?: boolean }): Promise<HeadersInit> {
    if (options?.refresh) {
      this.cached = null;
      this.pending = null;
    }
    const session = await this.session(options?.refresh === true);
    return { authorization: `Bearer ${session.token}` };
  }

  private async session(forceIdentityRefresh: boolean): Promise<OwnerSessionResponse> {
    if (!forceIdentityRefresh && this.cached && !this.expired(this.cached)) return this.cached;
    if (!this.pending) {
      const request = this.exchange(forceIdentityRefresh).finally(() => {
        if (this.pending === request) this.pending = null;
      });
      this.pending = request;
    }
    const session = await this.pending;
    this.cached = session;
    return session;
  }

  private expired(session: OwnerSessionResponse): boolean {
    return session.expiresAt * 1000 <= this.now() + EXPIRY_SKEW_MS;
  }

  private async exchange(forceIdentityRefresh: boolean): Promise<OwnerSessionResponse> {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refresh = forceIdentityRefresh || attempt > 0;
      const identityToken = await this.getIdentityToken(refresh ? { refresh: true } : undefined);
      const response = await this.fetcher(`${this.origin}/api/auth/session`, {
        method: 'POST',
        headers: { authorization: `Bearer ${identityToken}` },
        cache: 'no-store',
      });
      lastStatus = response.status;
      if (response.status === 401 && attempt === 0 && !forceIdentityRefresh) continue;
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Sharing identity exchange failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`);
      }
      const body = await response.json().catch(() => null) as Partial<OwnerSessionResponse> | null;
      if (!body || typeof body.token !== 'string' || !body.token.trim()
        || !Number.isInteger(body.expiresAt) || Number(body.expiresAt) <= 0) {
        throw new Error('Sharing identity exchange returned an invalid session');
      }
      return { token: body.token.trim(), expiresAt: Number(body.expiresAt) };
    }
    throw new Error(`Sharing identity exchange failed (${lastStatus || 401})`);
  }
}
