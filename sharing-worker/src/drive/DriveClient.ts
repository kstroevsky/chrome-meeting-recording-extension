const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API_ORIGIN = 'https://www.googleapis.com';
const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_SKEW_SECONDS = 60;
const CONTROL_MAX_ATTEMPTS = 4;

type DriveServiceEnv = Env & {
  GOOGLE_DRIVE_READER_EMAIL: string;
  GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  /** Test/local override. Production omits this and uses Google's API origin. */
  GOOGLE_DRIVE_API_ORIGIN?: string;
  /** Test/local override. Production omits this and uses Google's OAuth token URL. */
  GOOGLE_DRIVE_TOKEN_URL?: string;
};

export type DriveRevisionMetadata = {
  id: string;
  size: number;
  mimeType: string;
  md5Checksum?: string;
  keepForever: boolean;
};

type CachedToken = {
  token: string;
  expiresAt: number;
  email: string;
};

let cachedToken: CachedToken | null = null;
let pendingToken: Promise<CachedToken> | null = null;

export function driveReaderEmail(env: Env): string {
  const email = (env as DriveServiceEnv).GOOGLE_DRIVE_READER_EMAIL?.trim();
  if (!email || !email.includes('@')) throw new Error('GOOGLE_DRIVE_READER_EMAIL is not configured');
  return email;
}

export async function getDriveRevisionMetadata(
  env: Env,
  fileId: string,
  revisionId: string,
): Promise<DriveRevisionMetadata> {
  const response = await controlRequest(
    env,
    `/drive/v3/files/${segment(fileId)}/revisions/${segment(revisionId)}?fields=id%2Csize%2CmimeType%2Cmd5Checksum%2CkeepForever`,
  );
  const body = await response.json() as Record<string, unknown>;
  const size = Number(body.size);
  if (body.id !== revisionId
    || !Number.isSafeInteger(size)
    || size < 0
    || typeof body.mimeType !== 'string') {
    throw new Error('Drive returned invalid revision metadata');
  }
  return {
    id: revisionId,
    size,
    mimeType: body.mimeType,
    ...(typeof body.md5Checksum === 'string' ? { md5Checksum: body.md5Checksum } : {}),
    keepForever: body.keepForever === true,
  };
}

/**
 * Performs exactly one Drive media request. A playback request never retries a
 * Drive byte fetch, which keeps the 8 MiB/request egress ceiling strict.
 */
export async function fetchDriveRevisionRange(
  env: Env,
  fileId: string,
  revisionId: string,
  start: number,
  end: number,
): Promise<Response> {
  const token = await getServiceAccountAccessToken(env);
  return await fetch(
    `${driveApiOrigin(env)}/drive/v3/files/${segment(fileId)}/revisions/${segment(revisionId)}?alt=media`,
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        range: `bytes=${start}-${end}`,
      },
      cache: 'no-store',
    },
  );
}

async function controlRequest(env: Env, path: string): Promise<Response> {
  let attempt = 1;
  while (true) {
    const token = await getServiceAccountAccessToken(env, attempt > 1);
    let response: Response;
    try {
      response = await fetch(driveApiOrigin(env) + path, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
    } catch (error) {
      if (attempt >= CONTROL_MAX_ATTEMPTS) throw error;
      await delay(backoffMs(attempt++));
      continue;
    }
    if (response.ok) return response;
    if (response.status === 401 && attempt < 2) {
      invalidateToken();
      attempt += 1;
      continue;
    }
    if ((response.status === 408 || response.status === 429 || response.status >= 500)
      && attempt < CONTROL_MAX_ATTEMPTS) {
      await delay(backoffMs(attempt++));
      continue;
    }
    const detail = await response.text().catch(() => '');
    throw Object.assign(
      new Error(`Drive revision metadata request failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`),
      { status: response.status },
    );
  }
}

async function getServiceAccountAccessToken(env: Env, forceRefresh = false): Promise<string> {
  const email = driveReaderEmail(env);
  const now = Math.floor(Date.now() / 1000);
  if (!forceRefresh && cachedToken?.email === email && cachedToken.expiresAt - TOKEN_SKEW_SECONDS > now) {
    return cachedToken.token;
  }
  if (forceRefresh) invalidateToken();
  if (!pendingToken) {
    const request = mintToken(env, email)
      .then((token) => {
        cachedToken = token;
        return token;
      })
      .finally(() => {
        if (pendingToken === request) pendingToken = null;
      });
    pendingToken = request;
  }
  return (await pendingToken).token;
}

async function mintToken(env: Env, email: string): Promise<CachedToken> {
  const now = Math.floor(Date.now() / 1000);
  const tokenUrl = driveTokenUrl(env);
  const assertion = await signJwt(env, email, now, tokenUrl);
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Service-account token exchange failed (${response.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`);
  }
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new Error('Service-account token exchange returned no access token');
  }
  const expiresIn = Number(payload.expires_in);
  return {
    token: payload.access_token,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 3600),
    email,
  };
}

async function signJwt(env: Env, email: string, now: number, audience: string): Promise<string> {
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iss: email,
    scope: DRIVE_READONLY_SCOPE,
    aud: audience,
    iat: now,
    exp: now + 3600,
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBytes((env as DriveServiceEnv).GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

function pemToBytes(value: string | undefined): ArrayBuffer {
  if (!value) throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY is not configured');
  const normalized = value.replace(/\\n/g, '\n');
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!base64) throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_PRIVATE_KEY is invalid');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function invalidateToken(): void {
  cachedToken = null;
  pendingToken = null;
}

function driveApiOrigin(env: Env): string {
  const configured = (env as DriveServiceEnv).GOOGLE_DRIVE_API_ORIGIN?.trim();
  if (!configured) return DRIVE_API_ORIGIN;
  const url = new URL(configured);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:')
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('GOOGLE_DRIVE_API_ORIGIN must be a bare HTTP(S) origin');
  }
  return url.origin;
}

function driveTokenUrl(env: Env): string {
  const configured = (env as DriveServiceEnv).GOOGLE_DRIVE_TOKEN_URL?.trim();
  if (!configured) return GOOGLE_TOKEN_URL;
  const url = new URL(configured);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.hash) {
    throw new Error('GOOGLE_DRIVE_TOKEN_URL must be an HTTP(S) URL without credentials or fragments');
  }
  return url.toString();
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * (2 ** Math.max(0, attempt - 1)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
