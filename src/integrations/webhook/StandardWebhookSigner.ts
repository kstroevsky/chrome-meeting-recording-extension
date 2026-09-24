const SECRET_PREFIX = 'whsec_';
const MIN_SECRET_BYTES = 24;
const MAX_SECRET_BYTES = 64;
const DEFAULT_SECRET_BYTES = 32;

export function createStandardWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(DEFAULT_SECRET_BYTES));
  return `${SECRET_PREFIX}${bytesToBase64(bytes)}`;
}

export async function signStandardWebhook(input: {
  secret: string;
  eventId: string;
  timestamp: number;
  body: string;
}): Promise<string> {
  if (!input.eventId.trim()) throw new Error('Webhook event id is required');
  if (!Number.isInteger(input.timestamp) || input.timestamp < 0) throw new Error('Webhook timestamp is invalid');
  const keyBytes = decodeSecret(input.secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new TextEncoder().encode(`${input.eventId}.${input.timestamp}.${input.body}`);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  return `v1,${bytesToBase64(signature)}`;
}

function decodeSecret(secret: string): Uint8Array {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error('Webhook signing secret must use whsec_ format');
  const encoded = secret.slice(SECRET_PREFIX.length);
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error('Webhook signing secret is not valid base64');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) {
    throw new Error('Webhook signing secret must contain 24 to 64 bytes');
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
