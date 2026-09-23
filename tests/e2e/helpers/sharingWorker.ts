import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const workerRoot = path.join(repoRoot, 'sharing-worker');
const workerPort = Number(process.env.SHARING_E2E_PORT || 8791);
export const sharingE2EOrigin = `https://127.0.0.1:${workerPort}`;

export type SharingWorkerState = {
  counters: {
    authSessions: number;
    uploadBegins: number;
    chunkCommits: number;
    expiredUploads: number;
    droppedChunkResponses: number;
  };
  shares: Array<{ id: string; owner_id: string; status: string; manifest: any }>;
  uploads: Array<{ id: string; share_id: string; status: string; offset: number; bytes: number }>;
  objects: Array<{ key: string; size: number }>;
};

export type SharingWorkerHarness = {
  origin: string;
  state: () => Promise<SharingWorkerState>;
  faults: (value: Record<string, unknown>) => Promise<void>;
  stop: () => Promise<void>;
};

export async function startSharingWorker(extensionId: string, stateDir: string): Promise<SharingWorkerHarness> {
  if (process.env.SHARING_SERVICE_ORIGIN && process.env.SHARING_SERVICE_ORIGIN !== sharingE2EOrigin) {
    throw new Error(`Sharing E2E build origin must be ${sharingE2EOrigin}`);
  }
  await fs.mkdir(stateDir, { recursive: true });
  const tokenServer = await startTokenInfoServer();
  const wrangler = path.join(workerRoot, 'node_modules', '.bin', 'wrangler');

  await execFileAsync(wrangler, [
    'd1', 'migrations', 'apply', 'SHARING_DB',
    '--local', '--persist-to', stateDir, '--config', 'wrangler.jsonc',
  ], { cwd: workerRoot, env: process.env, maxBuffer: 10 * 1024 * 1024 });

  const args = [
    'dev', 'test/e2e-entry.ts', '--config', 'wrangler.jsonc', '--local',
    '--local-protocol', 'https', '--ip', '127.0.0.1', '--port', String(workerPort),
    '--persist-to', stateDir, '--log-level', 'error', '--show-interactive-dev-session=false',
    '--var', `ALLOWED_EXTENSION_ORIGINS:chrome-extension://${extensionId}`,
    '--var', 'VIEWER_SESSION_TTL_SECONDS:43200',
    '--var', 'OWNER_SESSION_TTL_SECONDS:3600',
    '--var', 'GOOGLE_OAUTH_CLIENT_ID:test-client.apps.googleusercontent.com',
    '--var', `GOOGLE_TOKENINFO_URL:http://127.0.0.1:${tokenServer.port}/tokeninfo`,
    '--var', 'CAPABILITY_KEY_ID:v1',
    '--var', 'OWNER_MUTATION_RATE_PER_MINUTE:500',
    '--var', 'MAX_SHARES_PER_OWNER:200',
    '--var', 'MAX_OWNER_STORED_BYTES:536870912000',
    '--var', 'STALE_DRAFT_TTL_SECONDS:604800',
    '--var', 'REVOKED_RETENTION_SECONDS:2592000',
    '--var', 'CAPABILITY_KEY:e2e-legacy-capability-key-with-enough-entropy',
    '--var', `CAPABILITY_KEYS_JSON:${JSON.stringify({ v1: 'e2e-capability-v1-with-enough-entropy' })}`,
    '--var', 'SESSION_KEY:e2e-session-key-with-enough-entropy-for-tests',
  ];
  const child = spawn(wrangler, args, {
    cwd: workerRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs = `${logs}${String(chunk)}`.slice(-20_000); });
  child.stderr.on('data', (chunk) => { logs = `${logs}${String(chunk)}`.slice(-20_000); });

  try {
    await waitForWorker(child, () => secureJson('/__e2e__/state'), logs);
  } catch (error) {
    child.kill('SIGTERM');
    await tokenServer.stop();
    throw error;
  }

  return {
    origin: sharingE2EOrigin,
    state: () => secureJson<SharingWorkerState>('/__e2e__/state'),
    faults: async (value) => { await secureJson('/__e2e__/faults', 'POST', value); },
    stop: async () => {
      await stopChild(child);
      await tokenServer.stop();
    },
  };
}

async function startTokenInfoServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const token = url.searchParams.get('access_token');
    const subject = token === 'e2e-mock-share-identity-token'
      ? 'e2e-owner-a'
      : token === 'e2e-owner-b-token' ? 'e2e-owner-b' : null;
    response.setHeader('content-type', 'application/json');
    if (!subject) {
      response.statusCode = 401;
      response.end('{}');
      return;
    }
    response.end(JSON.stringify({ sub: subject, aud: 'test-client.apps.googleusercontent.com' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start E2E tokeninfo server');
  return {
    port: address.port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitForWorker(
  child: ChildProcess,
  probe: () => Promise<unknown>,
  logs: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Sharing Worker exited (${child.exitCode})\n${logs}`);
    try {
      await probe();
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out starting Sharing Worker\n${logs}`);
}

async function secureJson<T = unknown>(pathname: string, method = 'GET', body?: unknown): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const request = https.request(`${sharingE2EOrigin}${pathname}`, {
      method,
      rejectUnauthorized: false,
      headers: body == null ? undefined : { 'content-type': 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((response.statusCode ?? 500) >= 400) {
          reject(new Error(`Sharing Worker ${method} ${pathname} failed (${response.statusCode}): ${text}`));
          return;
        }
        try { resolve(JSON.parse(text) as T); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    if (body != null) request.write(JSON.stringify(body));
    request.end();
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}
