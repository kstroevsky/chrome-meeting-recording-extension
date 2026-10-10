import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { R2Storage } from './r2-storage.mjs';
import { startReferenceMediaReceiver } from './server.mjs';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const storage = new R2Storage({
  endpoint: required('S3_ENDPOINT'),
  region: process.env.S3_REGION || 'auto',
  bucket: required('S3_BUCKET'),
  accessKeyId: required('AWS_ACCESS_KEY_ID'),
  secretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  uploadOrigin: process.env.S3_UPLOAD_ORIGIN || undefined,
  uploadUrlTtlSeconds: positiveInteger('UPLOAD_URL_TTL_SECONDS', 900),
  playbackUrlTtlSeconds: positiveInteger('PLAYBACK_URL_TTL_SECONDS', 1800),
});

const receiver = await startReferenceMediaReceiver({
  host: process.env.HOST || '127.0.0.1',
  port: positiveInteger('PORT', 3444),
  publicOrigin: process.env.PUBLIC_ORIGIN || undefined,
  tls: {
    key: await fs.readFile(required('TLS_KEY_PATH')),
    cert: await fs.readFile(required('TLS_CERT_PATH')),
  },
  storage,
  statePath: process.env.STATE_PATH || path.join(root, 'state', 'receiver.json'),
  webhookSecret: required('WEBHOOK_SECRET'),
  mediaBearer: required('MEDIA_BEARER'),
  capabilityApiBase: process.env.CONFORMANCE_CAPABILITY_API_BASE || undefined,
  partSize: positiveInteger('PART_SIZE_BYTES', 32 * 1024 * 1024),
  maxConcurrency: positiveInteger('MAX_CONCURRENCY', 3),
  maxArtifactBytes: positiveInteger('MAX_ARTIFACT_BYTES', 8 * 1024 * 1024 * 1024),
  attemptTtlMs: positiveInteger('UPLOAD_ATTEMPT_TTL_MS', 24 * 60 * 60 * 1000),
  partSignResponseDelayMsOnce: positiveInteger('PART_SIGN_RESPONSE_DELAY_MS_ONCE', 0),
});

console.log(`Reference media receiver listening at ${receiver.origin}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (process.env.CLEANUP_ON_EXIT === '1') await receiver.cleanup();
  await receiver.stop();
}
process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
