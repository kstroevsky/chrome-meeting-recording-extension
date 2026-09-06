/**
 * SELF-TEST for the Drive playback spike — no Google account required.
 *
 * Everything in `run.mjs` except Google's own behaviour is exercised here
 * against a local Range-serving origin that 401s without a bearer token:
 *   - the DNR session rule really attaches Authorization to a <video> request
 *     (the media 401s otherwise, so playback is the assertion);
 *   - background refuses a page-supplied tabId and uses sender.tab.id;
 *   - Chromium issues Range requests and a far seek does not drag the prefix;
 *   - the token never reaches the page.
 *
 * What it CANNOT tell you: whether Drive redirects off www.googleapis.com and
 * whether that hop needs the header. Only run.mjs answers that.
 *
 *   node tests/spikes/drive-playback/selftest.mjs [--seconds 180]
 */
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SPIKE_EXT = path.join(HERE, 'extension');
const TOKEN = 'spike-secret-token-do-not-log';
const argv = process.argv.slice(2);
const SECONDS = Number(argv[argv.indexOf('--seconds') + 1]) || 180;

const fmt = (n) => `${(n / 1048576).toFixed(1)} MB`;
const findings = [];
let exitCode = 0;
const pass = (m) => findings.push(`PASS  ${m}`);
const fail = (m) => { findings.push(`FAIL  ${m}`); exitCode = 1; };

// ---- 1. A real, seekable WebM ---------------------------------------------
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'drive-spike-'));
const media = path.join(work, 'recording.webm');
console.log(`Encoding a ${SECONDS}s seekable WebM with ffmpeg…`);
const ff = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc=size=1280x720:rate=30:duration=${SECONDS}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
  '-c:v', 'libvpx-vp9', '-b:v', '3M', '-deadline', 'realtime', '-cpu-used', '8',
  '-c:a', 'libopus', '-b:a', '96k',
  media,
], { stdio: 'inherit' });
if (ff.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
const total = (await fsp.stat(media)).size;
console.log(`encoded ${fmt(total)}`);

// ---- 2. A Range-serving origin that demands a bearer token ----------------
let sawUnauthorized = 0;
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    sawUnauthorized += 1;
    res.writeHead(401).end('unauthorized');
    return;
  }
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': total, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(media).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Number(m[2]) : total - 1;
  res.writeHead(206, {
    'Content-Type': 'video/webm',
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(media, { start, end }).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const mediaUrl = `http://127.0.0.1:${server.address().port}/recording.webm`;

// ---- 3. Drive the spike extension -----------------------------------------
const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'drive-spike-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: false,
  args: [`--disable-extensions-except=${SPIKE_EXT}`, `--load-extension=${SPIKE_EXT}`],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const extId = worker.url().match(/^chrome-extension:\/\/([a-z]{32})\//)[1];
  await worker.evaluate((t) => self.__setSpikeToken(t), TOKEN);

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const net = { bytes: 0, ranges: [], authed: 0, statuses: [] };
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
    const h = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (h.range) net.ranges.push(h.range);
    if (h.authorization) net.authed += 1;
  });
  cdp.on('Network.responseReceived', (e) => net.statuses.push(e.response.status));
  cdp.on('Network.dataReceived', (e) => { net.bytes += e.dataLength; });

  await page.goto(`chrome-extension://${extId}/spike.html`);

  // (a) background must refuse to authorize a tab the page names itself.
  const spoof = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'SPIKE_INSTALL_RULE', mediaUrl: 'http://127.0.0.1/x', tabId: 99999 }));
  const rules = await worker.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.condition.tabIds));
  if (spoof.ok && rules.every((ids) => !ids.includes(99999))) pass('Page-supplied tabId ignored; rule bound to sender.tab.id');
  else if (!spoof.ok) pass(`Page-supplied tabId rejected outright (${spoof.error})`);
  else fail('A page-supplied tabId reached the rule');

  // (b) playback only succeeds if DNR actually attached the header.
  const loaded = await page.evaluate((u) => window.__spikeLoad(u), mediaUrl);
  console.log(`  duration ${loaded.duration.toFixed(1)}s`);
  const afterMeta = net.bytes;

  const seeked = await page.evaluate(() => window.__spikeSeek(0.8));
  await page.evaluate(() => window.__spikePlay(3000)).catch(() => {});
  const afterSeek = net.bytes;

  console.log(`  bytes after metadata : ${fmt(afterMeta)}`);
  console.log(`  bytes after seek+play: ${fmt(afterSeek)} of ${fmt(total)}`);
  console.log(`  seek landed at ${seeked.currentTime.toFixed(1)}s, buffered ${JSON.stringify(seeked.buffered)}`);
  console.log(`  ranges: ${net.ranges.slice(0, 6).join(', ')}${net.ranges.length > 6 ? ` … (${net.ranges.length})` : ''}`);

  if (net.authed > 0) pass(`DNR attached Authorization to ${net.authed} request(s)`);
  else fail('No request carried Authorization — the DNR rule did not match');
  if (!net.statuses.includes(401)) pass('No 401: every media request was authorized');
  else fail(`Got 401 responses (${net.statuses.filter((s) => s === 401).length}); the header was missing on some requests`);
  if (net.ranges.length) pass(`Chromium issued ${net.ranges.length} Range request(s)`);
  else fail('No Range request issued');
  if (afterSeek < total * 0.8 * 0.5) pass(`Far seek did not drag the prefix (${fmt(afterSeek)} vs ${fmt(total * 0.8)})`);
  else fail(`Far seek transferred ${fmt(afterSeek)}; prefix is ${fmt(total * 0.8)}`);

  const surfaces = await page.evaluate(() => window.__spikeSurfaces());
  const leaks = Object.entries(surfaces).filter(([, v]) => typeof v === 'string' && v.includes(TOKEN));
  if (leaks.length) fail(`Token leaked into: ${leaks.map(([k]) => k).join(', ')}`);
  else pass('Token absent from page URL, video src, DOM, localStorage and page log');
} catch (error) {
  fail(`Self-test aborted: ${error?.message ?? error}`);
} finally {
  console.log('\n=== SELF-TEST VERDICT ===');
  for (const f of findings) console.log(`  ${f}`);
  console.log(`  (server saw ${sawUnauthorized} unauthorized attempt(s))`);
  console.log(`  exit=${exitCode}`);
  await context.close().catch(() => {});
  server.close();
  await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
