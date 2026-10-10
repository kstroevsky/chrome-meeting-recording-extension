/** Signed connection-test capability discovery. Data from the receiver remains untrusted. */
export type MediaCapability = {
  version: 1;
  apiBase: string;
  upload: { strategy: 'multipart-put-v1'; origins: string[] };
  playback: { strategy: 'refreshable-url-v1' };
};

const PROTOCOL = 'io.github.kstroevsky.meeting-recorder.service.v1';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function parseMediaCapability(value: unknown, webhookEndpoint: string): MediaCapability | undefined {
  const document = record(value);
  const capabilities = record(document?.capabilities);
  const media = record(capabilities?.media);
  const upload = record(media?.upload);
  const playback = record(media?.playback);
  if (document?.protocol !== PROTOCOL || media?.version !== 1 ||
      upload?.strategy !== 'multipart-put-v1' || playback?.strategy !== 'refreshable-url-v1' ||
      typeof media?.apiBase !== 'string' || !Array.isArray(upload?.origins) ||
      upload.origins.length < 1 || upload.origins.length > 8) return undefined;

  let endpoint: URL;
  let base: URL;
  try {
    endpoint = new URL(webhookEndpoint);
    base = new URL(media.apiBase);
  } catch { return undefined; }
  // An independent receiver cannot introduce another credential-bearing control origin.
  if (endpoint.protocol !== 'https:' || base.protocol !== 'https:' ||
      base.origin !== endpoint.origin || base.username || base.password ||
      base.search || base.hash || !base.pathname.startsWith('/')) return undefined;

  const origins: string[] = [];
  for (const raw of upload.origins) {
    if (typeof raw !== 'string') return undefined;
    let url: URL;
    try { url = new URL(raw); } catch { return undefined; }
    // Only exact HTTPS origins, never wildcard, subpath or embedded credentials.
    if (raw !== url.origin || url.protocol !== 'https:' || url.hostname.includes('*') ||
        url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash || origins.includes(raw)) return undefined;
    origins.push(raw);
  }
  return {
    version: 1,
    apiBase: base.href,
    upload: { strategy: 'multipart-put-v1', origins },
    playback: { strategy: 'refreshable-url-v1' },
  };
}

/** Re-check a capability retrieved from IndexedDB before it reaches the network. */
export function normalizeStoredMediaCapability(value: unknown, endpoint: string): MediaCapability | undefined {
  return parseMediaCapability({ protocol: PROTOCOL, capabilities: { media: value } }, endpoint);
}
