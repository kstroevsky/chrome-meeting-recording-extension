import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import https from 'node:https';
import path from 'node:path';

export type IntegrationReceiverPlan = {
  status?: number;
  headers?: Record<string, string>;
  dropResponse?: boolean;
  delayMs?: number;
};

export type IntegrationReceiverRequest = {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  receivedAt: number;
};

export type IntegrationReceiver = {
  origin: string;
  url(pathname: string): string;
  plan(pathname: string, plans: IntegrationReceiverPlan[]): void;
  requests(pathname?: string): IntegrationReceiverRequest[];
  verify(request: IntegrationReceiverRequest, signingSecret: string): boolean;
  stop(): Promise<void>;
};

export async function startIntegrationReceiver(workDir: string): Promise<IntegrationReceiver> {
  await fs.mkdir(workDir, { recursive: true });
  const tls = await createSelfSignedCertificate(workDir);
  const plans = new Map<string, IntegrationReceiverPlan[]>();
  const received: IntegrationReceiverRequest[] = [];
  const sockets = new Set<import('node:stream').Duplex>();

  const server = https.createServer(tls, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const pathname = new URL(request.url ?? '/', 'https://127.0.0.1').pathname;
      const record: IntegrationReceiverRequest = {
        path: pathname,
        method: request.method ?? 'GET',
        headers: { ...request.headers },
        body: Buffer.concat(chunks).toString('utf8'),
        receivedAt: Date.now(),
      };
      received.push(record);
      const queue = plans.get(pathname) ?? [];
      const plan = queue.shift() ?? { status: 204 };

      const finish = () => {
        if (plan.dropResponse) {
          request.socket.destroy();
          return;
        }
        response.writeHead(plan.status ?? 204, {
          'cache-control': 'no-store',
          ...(plan.headers ?? {}),
        });
        response.end();
      };
      if ((plan.delayMs ?? 0) > 0) setTimeout(finish, plan.delayMs);
      else finish();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Integration receiver did not bind a TCP port');
  const origin = `https://127.0.0.1:${address.port}`;

  return {
    origin,
    url(pathname) {
      return `${origin}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
    },
    plan(pathname, nextPlans) {
      plans.set(normalizePath(pathname), [...nextPlans]);
    },
    requests(pathname) {
      if (!pathname) return [...received];
      const normalized = normalizePath(pathname);
      return received.filter((request) => request.path === normalized);
    },
    verify(request, signingSecret) {
      const eventId = header(request, 'webhook-id');
      const timestamp = header(request, 'webhook-timestamp');
      const signature = header(request, 'webhook-signature');
      if (!eventId || !timestamp || !signature || !signingSecret.startsWith('whsec_')) return false;
      const expected = createHmac('sha256', Buffer.from(signingSecret.slice('whsec_'.length), 'base64'))
        .update(`${eventId}.${timestamp}.${request.body}`)
        .digest('base64');
      return signature.split(/\s+/).includes(`v1,${expected}`);
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function normalizePath(pathname: string): string {
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function header(request: IntegrationReceiverRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function createSelfSignedCertificate(workDir: string): Promise<{ key: Buffer; cert: Buffer }> {
  const keyPath = path.join(workDir, 'integration-receiver.key');
  const certPath = path.join(workDir, 'integration-receiver.crt');
  const configPath = path.join(workDir, 'integration-receiver-openssl.cnf');
  await fs.writeFile(configPath, `[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-config', configPath,
  ], { stdio: 'ignore' });
  return {
    key: await fs.readFile(keyPath),
    cert: await fs.readFile(certPath),
  };
}
