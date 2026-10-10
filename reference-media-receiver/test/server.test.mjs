import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Webhook } from 'standardwebhooks';
import { startReferenceMediaReceiver, MEDIA_PROTOCOL } from '../src/server.mjs';

const MiB = 1024 * 1024;
const SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const BEARER = 'reference-media-bearer';

class FakeStorage {
  uploadOrigin = 'https://objects.example.test';
  uploads = new Map();
  objects = new Map();
  sequence = 0;

  async createMultipart(key, contentType) {
    const id = `provider-${++this.sequence}`;
    this.uploads.set(id, { key, contentType, parts: [] });
    return id;
  }

  async abortMultipart(_key, providerUploadId) {
    this.uploads.delete(providerUploadId);
  }

  async listParts(_key, providerUploadId) {
    const upload = this.uploads.get(providerUploadId);
    if (!upload) throw new Error('missing fake multipart upload');
    return structuredClone(upload.parts);
  }

  async signUploadPart(key, providerUploadId, partNumber) {
    return {
      url: `${this.uploadOrigin}/${encodeURIComponent(key)}?upload=${providerUploadId}&part=${partNumber}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async completeMultipart(key, providerUploadId) {
    const upload = this.uploads.get(providerUploadId);
    if (!upload) throw new Error('missing fake multipart upload');
    this.objects.set(key, {
      bytes: upload.parts.reduce((sum, part) => sum + part.size, 0),
      contentType: upload.contentType,
    });
    this.uploads.delete(providerUploadId);
  }

  async head(key) {
    return structuredClone(this.objects.get(key) ?? null);
  }

  async signPlayback(key) {
    if (!this.objects.has(key)) throw new Error('missing fake object');
    return {
      url: `${this.uploadOrigin}/${encodeURIComponent(key)}?playback=1`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async deleteObject(key) {
    this.objects.delete(key);
  }

  putParts(providerUploadId, parts) {
    const upload = this.uploads.get(providerUploadId);
    if (!upload) throw new Error('missing fake multipart upload');
    upload.parts = structuredClone(parts);
  }
}

async function tls(workDir) {
  const key = path.join(workDir, 'server.key');
  const cert = path.join(workDir, 'server.crt');
  const config = path.join(workDir, 'openssl.cnf');
  await fs.writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-config', config], { stdio: 'ignore' });
  return { key: await fs.readFile(key), cert: await fs.readFile(cert) };
}

async function start(options = {}) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-media-receiver-'));
  const storage = options.storage ?? new FakeStorage();
  const receiver = await startReferenceMediaReceiver({
    tls: await tls(workDir),
    storage,
    statePath: path.join(workDir, 'state.json'),
    webhookSecret: SECRET,
    mediaBearer: BEARER,
    partSize: 5 * MiB,
    attemptTtlMs: options.attemptTtlMs ?? 60_000,
    completionLeaseMs: options.completionLeaseMs ?? 1,
  });
  return { receiver, storage, workDir };
}

async function request(origin, pathname, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(pathname, origin);
  return await new Promise((resolve, reject) => {
    const req = https.request(target, { method, headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          body: text ? JSON.parse(text) : undefined,
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
}

function mediaHeaders() {
  return { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' };
}

function createBody(bytes = 5 * MiB + 3) {
  return {
    clientTransferId: 'transfer-1',
    recordingId: 'recording-1',
    artifact: {
      role: 'tab-recording',
      filename: 'Interview.webm',
      mimeType: 'video/webm; codecs=vp9',
      bytes,
    },
  };
}

test('discovers the generic media capability only from a valid signed test event', async (t) => {
  const { receiver } = await start();
  t.after(() => receiver.stop());
  const payload = JSON.stringify({
    specversion: '1.0',
    id: 'evt_test',
    source: 'urn:meeting-recorder:destination:test',
    type: 'io.github.kstroevsky.meeting-recorder.integration.test.v1',
    data: { test: true },
  });
  const timestamp = new Date();
  const signer = new Webhook(SECRET);
  const headers = {
    'content-type': 'application/cloudevents+json',
    'webhook-id': 'evt_test',
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'webhook-signature': signer.sign('evt_test', timestamp, payload),
  };

  const valid = await request(receiver.origin, '/webhook', { method: 'POST', headers, body: JSON.parse(payload) });
  assert.equal(valid.status, 200);
  assert.equal(valid.body.protocol, MEDIA_PROTOCOL);
  assert.equal(valid.body.capabilities.media.apiBase, `${receiver.origin}/media`);
  assert.deepEqual(valid.body.capabilities.media.upload.origins, ['https://objects.example.test']);

  const invalid = await request(receiver.origin, '/webhook', {
    method: 'POST',
    headers: { ...headers, 'webhook-signature': 'v1,invalid' },
    body: JSON.parse(payload),
  });
  assert.equal(invalid.status, 401);
  assert.deepEqual(invalid.body, { code: 'INVALID_WEBHOOK_SIGNATURE' });
});

test('create is idempotent and conflicting transfer reuse does not allocate another artifact', async (t) => {
  const { receiver } = await start();
  t.after(() => receiver.stop());
  const first = await request(receiver.origin, '/media/v1/uploads', {
    method: 'POST', headers: mediaHeaders(), body: createBody(),
  });
  const repeated = await request(receiver.origin, '/media/v1/uploads', {
    method: 'POST', headers: mediaHeaders(), body: createBody(),
  });
  assert.equal(first.status, 200);
  assert.deepEqual(repeated.body, first.body);

  const conflicting = createBody();
  conflicting.artifact.bytes += 1;
  const conflict = await request(receiver.origin, '/media/v1/uploads', {
    method: 'POST', headers: mediaHeaders(), body: conflicting,
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'TRANSFER_CONFLICT');
  assert.equal(receiver.stats().uploadAttempts, 1);
});

test('completion accepts only exact provider parts and verifies the finished object before playback', async (t) => {
  const { receiver, storage } = await start();
  t.after(() => receiver.stop());
  const created = await request(receiver.origin, '/media/v1/uploads', {
    method: 'POST', headers: mediaHeaders(), body: createBody(),
  });
  const artifact = (await receiver.artifacts())[0];
  const persisted = [...storage.uploads.entries()].find(([, upload]) => upload.key.includes(artifact.artifactId));
  assert.ok(persisted);
  const [providerUploadId] = persisted;
  storage.putParts(providerUploadId, [
    { partNumber: 1, etag: '"etag-1"', size: 5 * MiB },
    { partNumber: 2, etag: '"etag-2"', size: 3 },
  ]);

  const wrong = await request(receiver.origin, `/media/v1/uploads/${created.body.uploadId}/complete`, {
    method: 'POST', headers: mediaHeaders(),
    body: { parts: [{ partNumber: 1, etag: '"wrong"' }, { partNumber: 2, etag: '"etag-2"' }] },
  });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, 'PARTS_MISMATCH');

  const completed = await request(receiver.origin, `/media/v1/uploads/${created.body.uploadId}/complete`, {
    method: 'POST', headers: mediaHeaders(),
    body: { parts: [{ partNumber: 1, etag: '"etag-1"' }, { partNumber: 2, etag: '"etag-2"' }] },
  });
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.body, { artifactId: created.body.artifactId, state: 'ready' });

  const playback = await request(receiver.origin, `/media/v1/artifacts/${created.body.artifactId}/playback`, {
    method: 'POST', headers: mediaHeaders(),
  });
  assert.equal(playback.status, 200);
  assert.equal(new URL(playback.body.url).origin, storage.uploadOrigin);
});

test('an expired attempt gets a new upload id while preserving artifact identity', async (t) => {
  const { receiver } = await start({ attemptTtlMs: 5 });
  t.after(() => receiver.stop());
  const first = await request(receiver.origin, '/media/v1/uploads', {
    method: 'POST', headers: mediaHeaders(), body: createBody(),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const stale = await request(receiver.origin, `/media/v1/uploads/${first.body.uploadId}`, {
    headers: mediaHeaders(),
  });
  assert.equal(stale.status, 410);

  const replacement = await request(receiver.origin, '/media/v1/uploads', {
    method: 'POST', headers: mediaHeaders(), body: createBody(),
  });
  assert.equal(replacement.status, 200);
  assert.equal(replacement.body.artifactId, first.body.artifactId);
  assert.notEqual(replacement.body.uploadId, first.body.uploadId);
  assert.equal(receiver.stats().uploadAttempts, 2);
});

test('durable state survives receiver restart without changing active transfer identity', async (t) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-media-restart-'));
  const storage = new FakeStorage();
  const options = {
    tls: await tls(workDir),
    storage,
    statePath: path.join(workDir, 'state.json'),
    webhookSecret: SECRET,
    mediaBearer: BEARER,
    partSize: 5 * MiB,
  };
  const firstReceiver = await startReferenceMediaReceiver(options);
  const first = await request(firstReceiver.origin, '/media/v1/uploads', {
    method: 'POST', headers: mediaHeaders(), body: createBody(),
  });
  await firstReceiver.stop();

  const secondReceiver = await startReferenceMediaReceiver(options);
  t.after(() => secondReceiver.stop());
  const resumed = await request(secondReceiver.origin, '/media/v1/uploads', {
    method: 'POST', headers: mediaHeaders(), body: createBody(),
  });
  assert.equal(resumed.body.artifactId, first.body.artifactId);
  assert.equal(resumed.body.uploadId, first.body.uploadId);
});
