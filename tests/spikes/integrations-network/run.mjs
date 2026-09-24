import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const EXTENSION_SOURCE = path.join(HERE, 'extension');
const PUBLIC_HTTPS = argument('--public-https') ?? 'https://example.com/';
const TRUSTED_HTTPS = argument('--trusted-https');
const PRIVATE_DNS = argument('--private-dns');
const KEEP = process.argv.includes('--keep');
const results = [];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function privateIpv4() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (
        address.address.startsWith('10.')
        || address.address.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[01])\./.test(address.address)
      ) return address.address;
    }
  }
  return undefined;
}

function hostPattern(url) {
  const parsed = new URL(url);
  // Chrome match patterns do not encode a port. "Exact" host access therefore
  // means exact scheme + host, across that host's ports.
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function receiverHandler(req, res) {
  let bytes = 0;
  req.on('data', (chunk) => { bytes += chunk.length; });
  req.on('end', () => {
    res.writeHead(204, {
      'cache-control': 'no-store',
      'x-spike-request-bytes': String(bytes),
    });
    res.end();
  });
}

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return server.address().port;
}

async function createSelfSigned(work) {
  const key = path.join(work, 'localhost.key');
  const cert = path.join(work, 'localhost.crt');
  const config = path.join(work, 'openssl.cnf');
  await fs.writeFile(config, `[req]
distinguished_name=dn
prompt=no
x509_extensions=v3
[dn]
CN=localhost
[v3]
subjectAltName=DNS:localhost,IP:127.0.0.1
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-config', config,
  ], { stdio: 'ignore' });
  return {
    key: await fs.readFile(key),
    cert: await fs.readFile(cert),
  };
}

async function writeExtension(root, grantedPattern) {
  await fs.mkdir(root, { recursive: true });
  await Promise.all(['spike.html', 'spike.js', 'sw.js'].map((name) =>
    fs.copyFile(path.join(EXTENSION_SOURCE, name), path.join(root, name))));
  const manifest = {
    manifest_version: 3,
    name: 'Integration network compatibility spike',
    version: '0.0.1',
    permissions: [],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...(grantedPattern ? { host_permissions: [grantedPattern] } : {}),
    background: { service_worker: 'sw.js', type: 'module' },
  };
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function launchProbe(extensionPath, profile, url) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/spike.html`);
    const [pageResult, workerResult, hasPermission] = await Promise.all([
      page.evaluate((target) => window.__integrationNetworkSpike.pageFetch(target), url),
      page.evaluate((target) => window.__integrationNetworkSpike.workerFetch(target), url),
      page.evaluate((target) => window.__integrationNetworkSpike.hasPermission(target), url),
    ]);
    return { page: pageResult, worker: workerResult, hasPermission };
  } finally {
    await context.close();
  }
}

async function probeRuntimePermission(work, url) {
  const extension = path.join(work, 'extension-runtime-permission');
  const profile = path.join(work, 'profile-runtime-permission');
  await writeExtension(extension);

  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });

  let requestResult = 'not-run';
  let before;
  let after;
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    const extensionId = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/spike.html`);
    before = {
      page: await page.evaluate((target) => window.__integrationNetworkSpike.pageFetch(target), url),
      worker: await page.evaluate((target) => window.__integrationNetworkSpike.workerFetch(target), url),
    };
    await page.evaluate((target) => window.__integrationNetworkSpike.preparePermissionRequest(target), url);
    await page.click('#request-host');
    try {
      await page.waitForFunction(
        () => !['ready', 'pending'].includes(window.__integrationNetworkSpike.permissionRequestResult()),
        undefined,
        { timeout: 4_000 },
      );
      requestResult = await page.evaluate(() => window.__integrationNetworkSpike.permissionRequestResult());
    } catch {
      requestResult = 'native-prompt-unresolved';
    }
    if (requestResult === 'granted') {
      after = {
        page: await page.evaluate((target) => window.__integrationNetworkSpike.pageFetch(target), url),
        worker: await page.evaluate((target) => window.__integrationNetworkSpike.workerFetch(target), url),
      };
    }
  } finally {
    await context.close().catch(() => {});
  }

  let afterRestart;
  if (requestResult === 'granted') {
    afterRestart = await launchProbe(extension, profile, url);
  }
  return {
    target: url,
    permissionPattern: hostPattern(url),
    before,
    requestResult,
    after,
    afterRestart,
  };
}

async function probeTarget(work, name, url) {
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  const extension = path.join(work, `extension-${hash}`);
  const profile = path.join(work, `profile-${hash}`);

  await writeExtension(extension);
  const before = await launchProbe(extension, profile, url);

  await writeExtension(extension, hostPattern(url));
  const after = await launchProbe(extension, profile, url);
  const afterRestart = await launchProbe(extension, profile, url);

  results.push({
    name,
    url,
    permissionPattern: hostPattern(url),
    before,
    after,
    afterRestart,
  });
}

function summarize(result) {
  const status = (entry) => entry.ok ? `HTTP ${entry.status}` : 'blocked';
  return {
    target: result.name,
    permissionPattern: result.permissionPattern,
    beforePage: status(result.before.page),
    beforeWorker: status(result.before.worker),
    afterPage: status(result.after.page),
    afterWorker: status(result.after.worker),
    restartPage: status(result.afterRestart.page),
    restartWorker: status(result.afterRestart.worker),
  };
}

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-network-spike-'));
const httpServer = http.createServer(receiverHandler);
const httpPort = await listen(httpServer, '0.0.0.0');
const tls = await createSelfSigned(work);
const httpsServer = https.createServer(tls, receiverHandler);
const httpsPort = await listen(httpsServer, '127.0.0.1');

try {
  await probeTarget(work, 'public HTTPS', PUBLIC_HTTPS);
  await probeTarget(work, 'localhost HTTP', `http://localhost:${httpPort}/events`);
  await probeTarget(work, '127.0.0.1 HTTP', `http://127.0.0.1:${httpPort}/events`);

  const privateIp = privateIpv4();
  if (privateIp) {
    await probeTarget(work, 'private IPv4 HTTP', `http://${privateIp}:${httpPort}/events`);
  } else {
    results.push({ name: 'private IPv4 HTTP', skipped: 'No RFC1918 interface found' });
  }

  const localName = `${os.hostname().replace(/\.local$/i, '')}.local`;
  try {
    await dns.lookup(localName);
    await probeTarget(work, '.local HTTP', `http://${localName}:${httpPort}/events`);
  } catch {
    results.push({ name: '.local HTTP', skipped: `${localName} did not resolve` });
  }

  if (PRIVATE_DNS) {
    await probeTarget(work, 'private DNS HTTP', PRIVATE_DNS);
  } else {
    results.push({ name: 'private DNS HTTP', skipped: 'Pass --private-dns <url> to measure' });
  }

  if (TRUSTED_HTTPS) {
    await probeTarget(work, 'trusted local HTTPS', TRUSTED_HTTPS);
  } else {
    results.push({ name: 'trusted local HTTPS', skipped: 'Pass --trusted-https <url> to measure' });
  }

  await probeTarget(work, 'self-signed local HTTPS', `https://localhost:${httpsPort}/events`);
  const runtimePermission = await probeRuntimePermission(
    work,
    `http://127.0.0.1:${httpPort}/events`,
  );

  console.table(results.filter((entry) => !entry.skipped).map(summarize));
  for (const result of results.filter((entry) => entry.skipped)) {
    console.log(`SKIP ${result.name}: ${result.skipped}`);
  }
  console.log('\nJSON');
  console.log(JSON.stringify(results, null, 2));
  console.log('\nRUNTIME_PERMISSION_JSON');
  console.log(JSON.stringify(runtimePermission, null, 2));
} finally {
  await new Promise((resolve) => httpServer.close(resolve));
  await new Promise((resolve) => httpsServer.close(resolve));
  if (KEEP) console.log(`Kept spike workspace: ${work}`);
  else await fs.rm(work, { recursive: true, force: true });
}
