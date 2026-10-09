import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import https from 'node:https';
import { Webhook } from 'standardwebhooks';
import { ReferenceReceiverStateStore } from './state-store.mjs';

export const MEDIA_PROTOCOL = 'io.github.kstroevsky.meeting-recorder.service.v1';

const MiB = 1024 * 1024;
const ALLOWED_ROLES = new Set(['tab-recording', 'microphone-recording', 'self-video']);
const ALLOWED_MIME = new Set(['video/webm', 'video/mp4', 'audio/webm', 'audio/mp4']);
const MAX_PARTS = 10_000;
const MAX_ETAG_BYTES = 1024;
const MAX_JSON_BYTES = 16 * MiB;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_REQUESTS_PER_MINUTE = 600;
const MAX_ACTIVE_UPLOADS = 4;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function httpError(status, code) {
  return new HttpError(status, code);
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
  return cleaned && cleaned.length <= maxLength ? cleaned : undefined;
}

function canonicalMime(value) {
  if (typeof value !== 'string') return undefined;
  const base = value.split(';', 1)[0]?.trim().toLowerCase();
  return ALLOWED_MIME.has(base) ? base : undefined;
}

function createFingerprint(input) {
  return createHash('sha256').update(JSON.stringify({
    recordingId: input.recordingId,
    role: input.artifact.role,
    filename: input.artifact.filename,
    mimeType: input.artifact.mimeType,
    bytes: input.artifact.bytes,
  })).digest('hex');
}

function opaqueId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function sameSecret(actual, expected) {
  const a = Buffer.from(actual ?? '', 'utf8');
  const b = Buffer.from(expected ?? '', 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function validateCreate(value, maxArtifactBytes) {
  const body = asObject(value);
  const artifact = asObject(body?.artifact);
  const clientTransferId = cleanText(body?.clientTransferId, 255);
  const recordingId = cleanText(body?.recordingId, 255);
  const role = cleanText(artifact?.role, 64);
  const filename = cleanText(artifact?.filename, 255);
  const mimeType = canonicalMime(artifact?.mimeType);
  const bytes = artifact?.bytes;
  if (!clientTransferId || !recordingId || !role || !filename || !mimeType ||
      !ALLOWED_ROLES.has(role) || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw httpError(422, 'INVALID_ARTIFACT');
  }
  if (bytes > maxArtifactBytes) throw httpError(413, 'ARTIFACT_TOO_LARGE');
  return {
    clientTransferId,
    recordingId,
    artifact: { role, filename, mimeType, bytes },
  };
}

function validateManifest(value, expectedParts) {
  const body = asObject(value);
  if (!Array.isArray(body?.parts) || body.parts.length !== expectedParts || expectedParts > MAX_PARTS) {
    throw httpError(422, 'INVALID_PARTS');
  }
  return body.parts.map((raw, index) => {
    const part = asObject(raw);
    const etag = part?.etag;
    if (part?.partNumber !== index + 1 || typeof etag !== 'string' || !etag || /[\r\n]/.test(etag) ||
        Buffer.byteLength(etag, 'utf8') > MAX_ETAG_BYTES) {
      throw httpError(422, 'INVALID_PARTS');
    }
    return { partNumber: index + 1, etag };
  });
}

function findByUploadId(state, uploadId) {
  return Object.values(state.artifacts).find((artifact) => artifact.upload?.id === uploadId);
}

function findByArtifactId(state, artifactId) {
  return Object.values(state.artifacts).find((artifact) => artifact.artifactId === artifactId);
}

function uploadResponse(artifact) {
  return {
    artifactId: artifact.artifactId,
    uploadId: artifact.upload.id,
    state: 'uploading',
    strategy: 'multipart-put-v1',
    partSize: artifact.upload.partSize,
    maxConcurrency: artifact.upload.maxConcurrency,
  };
}

function readyResponse(artifact) {
  return { artifactId: artifact.artifactId, state: 'ready' };
}

function exactPartSize(artifact, partNumber) {
  const start = (partNumber - 1) * artifact.upload.partSize;
  return Math.min(artifact.upload.partSize, artifact.bytes - start);
}

function assertAuthoritativeParts(artifact, manifest, providerParts) {
  if (providerParts.length !== manifest.length) throw httpError(409, 'PARTS_MISMATCH');
  for (let index = 0; index < manifest.length; index += 1) {
    const expected = manifest[index];
    const actual = providerParts[index];
    if (!actual || actual.partNumber !== expected.partNumber || actual.etag !== expected.etag ||
        actual.size !== exactPartSize(artifact, expected.partNumber)) {
      throw httpError(409, 'PARTS_MISMATCH');
    }
  }
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw httpError(413, 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function jsonBody(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw httpError(422, 'INVALID_JSON');
  }
}

function responseHeaders(extra = {}) {
  return {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, webhook-id, webhook-timestamp, webhook-signature',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    ...extra,
  };
}

function sendJson(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, responseHeaders({
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encoded),
  }));
  response.end(encoded);
}

function sendEmpty(response, status = 204) {
  response.writeHead(status, responseHeaders());
  response.end();
}

function normalizedHeader(request, name) {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function publicOriginFromServer(server, host) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Reference receiver did not bind a TCP port');
  const hostname = host.includes(':') ? `[${host}]` : host;
  return `https://${hostname}:${address.port}`;
}

/**
 * Independent protocol receiver. `storage` is the only provider-specific seam;
 * its implementation lives outside the extension and can be swapped freely.
 */
export async function startReferenceMediaReceiver(options) {
  if (!options?.tls?.key || !options?.tls?.cert) throw new Error('TLS key and certificate are required');
  if (!options.storage?.uploadOrigin) throw new Error('Storage upload origin is required');
  const partSize = options.partSize ?? 32 * MiB;
  const maxConcurrency = options.maxConcurrency ?? 3;
  const maxArtifactBytes = options.maxArtifactBytes ?? 8 * 1024 * MiB;
  const attemptTtlMs = options.attemptTtlMs ?? 24 * 60 * 60 * 1000;
  const completionLeaseMs = options.completionLeaseMs ?? 5_000;
  if (!Number.isSafeInteger(partSize) || partSize < 5 * MiB || partSize > 256 * MiB ||
      !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 3 ||
      !Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) {
    throw new Error('Invalid receiver upload policy');
  }

  const store = new ReferenceReceiverStateStore(options.statePath);
  await store.open();
  let webhookSecret = options.webhookSecret;
  let mediaBearer = options.mediaBearer;
  const counters = {
    testEvents: 0,
    createCalls: 0,
    uploadAttempts: 0,
    partSigns: 0,
    playbackSigns: 0,
  };
  let requestWindowStartedAt = Date.now();
  let requestCount = 0;
  let partSignDelayUsed = false;
  const sockets = new Set();
  let publicOrigin;

  const server = https.createServer(options.tls, async (request, response) => {
    try {
      if (request.method === 'OPTIONS') {
        sendEmpty(response);
        return;
      }
      const url = new URL(request.url ?? '/', 'https://reference.invalid');
      if (url.search || url.hash) throw httpError(404, 'NOT_FOUND');
      if (url.pathname === '/webhook' && request.method === 'POST') {
        const raw = await readBody(request, MAX_WEBHOOK_BYTES);
        if (!webhookSecret) throw httpError(503, 'WEBHOOK_NOT_CONFIGURED');
        const verifier = new Webhook(webhookSecret);
        let event;
        try {
          event = verifier.verify(raw, {
            'webhook-id': normalizedHeader(request, 'webhook-id') ?? '',
            'webhook-timestamp': normalizedHeader(request, 'webhook-timestamp') ?? '',
            'webhook-signature': normalizedHeader(request, 'webhook-signature') ?? '',
          });
        } catch {
          throw httpError(401, 'INVALID_WEBHOOK_SIGNATURE');
        }
        if (event?.specversion !== '1.0' || typeof event?.type !== 'string') {
          throw httpError(422, 'INVALID_CLOUD_EVENT');
        }
        if (event.type.endsWith('.integration.test.v1') && event?.data?.test === true) {
          counters.testEvents += 1;
          sendJson(response, 200, {
            protocol: MEDIA_PROTOCOL,
            capabilities: {
              media: {
                version: 1,
                apiBase: `${publicOrigin}/media`,
                upload: { strategy: 'multipart-put-v1', origins: [options.storage.uploadOrigin] },
                playback: { strategy: 'refreshable-url-v1' },
              },
            },
          });
          return;
        }
        sendEmpty(response);
        return;
      }

      if (!url.pathname.startsWith('/media/v1/')) throw httpError(404, 'NOT_FOUND');
      if (!mediaBearer || !sameSecret(normalizedHeader(request, 'authorization'), `Bearer ${mediaBearer}`)) {
        throw httpError(401, 'INVALID_MEDIA_CREDENTIAL');
      }
      const now = Date.now();
      if (now - requestWindowStartedAt >= 60_000) {
        requestWindowStartedAt = now;
        requestCount = 0;
      }
      requestCount += 1;
      if (requestCount > MAX_REQUESTS_PER_MINUTE) throw httpError(429, 'RATE_LIMITED');

      if (url.pathname === '/media/v1/uploads' && request.method === 'POST') {
        counters.createCalls += 1;
        const input = validateCreate(jsonBody(await readBody(request, MAX_JSON_BYTES)), maxArtifactBytes);
        const result = await store.transaction(async (state) => {
          const fingerprint = createFingerprint(input);
          let artifact = state.artifacts[input.clientTransferId];
          if (artifact && artifact.fingerprint !== fingerprint) throw httpError(409, 'TRANSFER_CONFLICT');
          if (artifact?.state === 'ready') return readyResponse(artifact);
          if (artifact?.state === 'completing') {
            const head = await options.storage.head(artifact.objectKey);
            if (head?.bytes === artifact.bytes && head.contentType === artifact.mimeType) {
              artifact.state = 'ready';
              artifact.readyAt = now;
              return readyResponse(artifact);
            }
          }
          if (!artifact) {
            const active = Object.values(state.artifacts).filter((candidate) =>
              candidate.state !== 'ready' && candidate.upload && now - candidate.upload.createdAt <= attemptTtlMs).length;
            if (active >= MAX_ACTIVE_UPLOADS) throw httpError(429, 'TOO_MANY_ACTIVE_UPLOADS');
            const artifactId = opaqueId('media');
            artifact = {
              artifactId,
              clientTransferId: input.clientTransferId,
              recordingId: input.recordingId,
              role: input.artifact.role,
              filename: input.artifact.filename,
              mimeType: input.artifact.mimeType,
              bytes: input.artifact.bytes,
              fingerprint,
              objectKey: `meeting-recordings/${artifactId}`,
              state: 'uploading',
            };
            state.artifacts[input.clientTransferId] = artifact;
          }
          const expired = artifact.upload && now - artifact.upload.createdAt > attemptTtlMs;
          if (artifact.upload && !expired && artifact.state !== 'completing') return uploadResponse(artifact);
          if (artifact.upload && expired) {
            await options.storage.abortMultipart(artifact.objectKey, artifact.upload.providerUploadId).catch(() => undefined);
          }
          const providerUploadId = await options.storage.createMultipart(artifact.objectKey, artifact.mimeType);
          artifact.state = 'uploading';
          artifact.completingAt = undefined;
          artifact.upload = {
            id: opaqueId('upload'),
            providerUploadId,
            createdAt: now,
            partSize,
            maxConcurrency,
          };
          counters.uploadAttempts += 1;
          return uploadResponse(artifact);
        });
        sendJson(response, 200, result);
        return;
      }

      const statusMatch = url.pathname.match(/^\/media\/v1\/uploads\/(upload_[0-9a-f-]{36})$/i);
      if (statusMatch && request.method === 'GET') {
        const result = await store.read(async (state) => {
          const artifact = findByUploadId(state, statusMatch[1]);
          if (!artifact) throw httpError(410, 'UPLOAD_EXPIRED');
          if (artifact.state === 'ready') return readyResponse(artifact);
          if (Date.now() - artifact.upload.createdAt > attemptTtlMs) throw httpError(410, 'UPLOAD_EXPIRED');
          if (artifact.state === 'completing') {
            const head = await options.storage.head(artifact.objectKey);
            if (head?.bytes === artifact.bytes && head.contentType === artifact.mimeType) {
              await store.transaction((draft) => {
                const current = findByUploadId(draft, statusMatch[1]);
                if (current) { current.state = 'ready'; current.readyAt = Date.now(); }
              });
              return readyResponse(artifact);
            }
            throw httpError(409, 'MEDIA_UPLOAD_COMPLETING');
          }
          const parts = await options.storage.listParts(artifact.objectKey, artifact.upload.providerUploadId);
          return {
            state: 'uploading',
            artifactId: artifact.artifactId,
            uploadedParts: parts.map(({ partNumber, etag }) => ({ partNumber, etag })),
          };
        });
        sendJson(response, 200, result);
        return;
      }

      const partMatch = url.pathname.match(/^\/media\/v1\/uploads\/(upload_[0-9a-f-]{36})\/parts\/(\d+)$/i);
      if (partMatch && request.method === 'POST') {
        const result = await store.read(async (state) => {
          const artifact = findByUploadId(state, partMatch[1]);
          if (!artifact || Date.now() - artifact.upload.createdAt > attemptTtlMs) throw httpError(410, 'UPLOAD_EXPIRED');
          if (artifact.state !== 'uploading') throw httpError(409, 'WRONG_UPLOAD_STATE');
          const partNumber = Number(partMatch[2]);
          const count = Math.ceil(artifact.bytes / artifact.upload.partSize);
          if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count || count > MAX_PARTS) {
            throw httpError(422, 'INVALID_PART');
          }
          const signed = await options.storage.signUploadPart(
            artifact.objectKey,
            artifact.upload.providerUploadId,
            partNumber,
          );
          counters.partSigns += 1;
          if (partNumber === 1 && !partSignDelayUsed && (options.partSignResponseDelayMsOnce ?? 0) > 0) {
            partSignDelayUsed = true;
            await new Promise((resolve) => setTimeout(resolve, options.partSignResponseDelayMsOnce));
          }
          return { method: 'PUT', url: signed.url, headers: {}, expiresAt: signed.expiresAt };
        });
        sendJson(response, 200, result);
        return;
      }

      const completeMatch = url.pathname.match(/^\/media\/v1\/uploads\/(upload_[0-9a-f-]{36})\/complete$/i);
      if (completeMatch && request.method === 'POST') {
        const rawManifest = jsonBody(await readBody(request, MAX_JSON_BYTES));
        const prepared = await store.transaction(async (state) => {
          const artifact = findByUploadId(state, completeMatch[1]);
          if (!artifact) throw httpError(410, 'UPLOAD_EXPIRED');
          if (artifact.state === 'ready') return { ready: true, artifact: structuredClone(artifact) };
          if (Date.now() - artifact.upload.createdAt > attemptTtlMs) throw httpError(410, 'UPLOAD_EXPIRED');
          const expectedParts = Math.ceil(artifact.bytes / artifact.upload.partSize);
          const manifest = validateManifest(rawManifest, expectedParts);
          if (artifact.state === 'completing' && Date.now() - (artifact.completingAt ?? 0) < completionLeaseMs) {
            throw httpError(409, 'MEDIA_UPLOAD_COMPLETING');
          }
          const head = artifact.state === 'completing' ? await options.storage.head(artifact.objectKey) : null;
          if (head) {
            if (head.bytes !== artifact.bytes || head.contentType !== artifact.mimeType) {
              throw httpError(409, 'OBJECT_VERIFICATION_FAILED');
            }
            artifact.state = 'ready';
            artifact.readyAt = Date.now();
            return { ready: true, artifact: structuredClone(artifact) };
          }
          const providerParts = await options.storage.listParts(artifact.objectKey, artifact.upload.providerUploadId);
          assertAuthoritativeParts(artifact, manifest, providerParts);
          artifact.state = 'completing';
          artifact.completingAt = Date.now();
          return { ready: false, artifact: structuredClone(artifact), manifest };
        });
        if (prepared.ready) {
          sendJson(response, 200, readyResponse(prepared.artifact));
          return;
        }
        await options.storage.completeMultipart(
          prepared.artifact.objectKey,
          prepared.artifact.upload.providerUploadId,
          prepared.manifest,
        );
        const head = await options.storage.head(prepared.artifact.objectKey);
        if (!head || head.bytes !== prepared.artifact.bytes || head.contentType !== prepared.artifact.mimeType) {
          throw httpError(409, 'OBJECT_VERIFICATION_FAILED');
        }
        const completed = await store.transaction((state) => {
          const artifact = findByUploadId(state, completeMatch[1]);
          if (!artifact) throw httpError(410, 'UPLOAD_EXPIRED');
          artifact.state = 'ready';
          artifact.readyAt = Date.now();
          return structuredClone(artifact);
        });
        sendJson(response, 200, readyResponse(completed));
        return;
      }

      const playbackMatch = url.pathname.match(/^\/media\/v1\/artifacts\/(media_[0-9a-f-]{36})\/playback$/i);
      if (playbackMatch && request.method === 'POST') {
        const result = await store.read(async (state) => {
          const artifact = findByArtifactId(state, playbackMatch[1]);
          if (!artifact) throw httpError(404, 'ARTIFACT_NOT_FOUND');
          if (artifact.state !== 'ready') throw httpError(409, 'ARTIFACT_NOT_READY');
          const head = await options.storage.head(artifact.objectKey);
          if (!head || head.bytes !== artifact.bytes || head.contentType !== artifact.mimeType) {
            throw httpError(409, 'OBJECT_VERIFICATION_FAILED');
          }
          counters.playbackSigns += 1;
          return options.storage.signPlayback(artifact.objectKey);
        });
        sendJson(response, 200, await result);
        return;
      }

      throw httpError(404, 'NOT_FOUND');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
      sendJson(response, status, { code });
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  publicOrigin = options.publicOrigin ?? publicOriginFromServer(server, options.host ?? '127.0.0.1');
  const parsedOrigin = new URL(publicOrigin);
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== publicOrigin) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('publicOrigin must be an exact HTTPS origin');
  }

  return {
    origin: publicOrigin,
    webhookUrl: `${publicOrigin}/webhook`,
    apiBase: `${publicOrigin}/media`,
    setWebhookSecret(secret) { webhookSecret = secret; },
    setMediaBearer(token) { mediaBearer = token; },
    stats() { return structuredClone(counters); },
    async artifacts() {
      return store.read((state) => Object.values(state.artifacts).map((artifact) => ({
        artifactId: artifact.artifactId,
        recordingId: artifact.recordingId,
        role: artifact.role,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
        state: artifact.state,
        uploadId: artifact.upload?.id,
      })));
    },
    async cleanup() {
      const artifacts = await store.read((state) => Object.values(state.artifacts));
      for (const artifact of artifacts) {
        if (artifact.state !== 'ready' && artifact.upload) {
          await options.storage.abortMultipart(artifact.objectKey, artifact.upload.providerUploadId).catch(() => undefined);
        }
        if (artifact.state === 'ready') {
          await options.storage.deleteObject(artifact.objectKey).catch(() => undefined);
        }
      }
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
