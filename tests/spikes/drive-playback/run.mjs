/**
 * SPIKE part 2 (throwaway) — ADR-0006 exit criterion, half 1, in a real browser.
 *
 * Points a native <video> at real Google Drive with NO token in the page, lets
 * a tab-scoped declarativeNetRequest session rule attach the bearer header, and
 * measures — via CDP, so the byte counts are what Chromium actually transferred
 * — whether seeking far into a real recording drags the byte prefix.
 *
 * Runs on Playwright's bundled Chromium: branded Chrome 152+ refuses
 * `--load-extension` outright (verified), and Playwright's connectOverCDP cannot
 * reach an extension service worker in an already-running browser (also
 * verified), so attaching to your main Chrome is not an option today.
 *
 *   node tests/spikes/drive-playback/run.mjs --token "$TOKEN" [--file-id <id>] [--seek 0.8]
 *
 * Minting a token from your main Chrome: chrome://extensions -> the extension ->
 * "service worker", then
 *   const r = await new Promise(res => chrome.identity.getAuthToken({interactive:true}, res));
 *   const token = typeof r === 'string' ? r : r?.token;   // Chrome 128+ returns an object
 *   console.log(token);
 *
 * then right-click the logged string -> "Copy string contents". Do NOT use
 * `t => copy(t)`: `copy` is a DevTools helper that does not exist inside the
 * async callback.
 * That is the extension's own OAuth client and existing consent.
 */
import { chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SPIKE_EXT = path.join(HERE, 'extension');

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const token = arg('--token') ?? process.env.DRIVE_TOKEN;
const seek = Number(arg('--seek')) || 0.8;
if (!token) { console.error('Pass --token <access token> (or set DRIVE_TOKEN). See the header of this file.'); process.exit(2); }

const fmt = (n) => `${(n / 1048576).toFixed(1)} MB`;
const section = (t) => console.log(`\n\x1b[1m=== ${t} ===\x1b[0m`);
const findings = [];
let exitCode = 0;
const pass = (m) => findings.push(`PASS  ${m}`);
const fail = (m) => { findings.push(`FAIL  ${m}`); exitCode = 1; };
const note = (m) => findings.push(`NOTE  ${m}`);

// ---- pick a real recording -------------------------------------------------
section('Target file');
let fileId = arg('--file-id');
let meta;
if (!fileId) {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=200&fields=files(id,name,size,mimeType)&q=trashed=false', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) { console.error(`files.list failed: ${res.status} ${await res.text()}`); process.exit(1); }
  const candidates = ((await res.json()).files ?? [])
    .filter((f) => Number(f.size) > 0 && /\.(webm|mp4)$/i.test(f.name ?? ''))
    .sort((a, b) => Number(b.size) - Number(a.size));
  if (!candidates.length) { console.error('No app-created .webm/.mp4 in Drive. Upload a recording, or pass --file-id.'); process.exit(1); }
  meta = candidates[0];
} else {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error(`files.get metadata failed: ${res.status}`); process.exit(1); }
  meta = await res.json();
}
fileId = meta.id;
const total = Number(meta.size);
console.log(`  ${meta.name}  ${fmt(total)}  ${meta.mimeType}`);
if (total < 100 * 1048576) note(`File is only ${fmt(total)}; plan section 20 wants a large real WebM before trusting the seek verdict.`);

// ---- drive a real <video> through the DNR rule ------------------------------
section('DNR-authorized <video> against real Drive');
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
  // Straight into worker scope: the token never passes through a page or a URL.
  await worker.evaluate((t) => self.__setSpikeToken(t), token);

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');

  const net = { bytes: 0, ranges: [], authed: [], hosts: new Set(), statuses: [], redirects: [] };
  const urlById = new Map();
  cdp.on('Network.requestWillBeSent', (e) => {
    urlById.set(e.requestId, e.request.url);
    try {
      const u = new URL(e.request.url);
      if (u.protocol === 'http:' || u.protocol === 'https:') net.hosts.add(u.host);
    } catch {}
    if (e.redirectResponse) net.redirects.push({ from: new URL(e.redirectResponse.url).host, status: e.redirectResponse.status, to: new URL(e.request.url).host });
  });
  // The headers Chromium actually put on the wire — the definitive DNR proof.
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
    const h = Object.fromEntries(Object.entries(e.headers).map(([k, v]) => [k.toLowerCase(), v]));
    if (h.range) net.ranges.push(h.range);
    if (h.authorization) net.authed.push(urlById.get(e.requestId) ?? '(unknown)');
  });
  cdp.on('Network.responseReceived', (e) => {
    const h = Object.fromEntries(Object.entries(e.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    net.statuses.push({ host: new URL(e.response.url).host, status: e.response.status, contentRange: h['content-range'] ?? null });
  });
  cdp.on('Network.dataReceived', (e) => { net.bytes += e.dataLength; });

  await page.goto(`chrome-extension://${extId}/spike.html`);
  const loaded = await page.evaluate((id) => window.__spikeLoad(id), fileId);
  const afterMeta = net.bytes;
  console.log(`  duration ${loaded.duration}s, ${fmt(afterMeta)} read for metadata`);

  const seeked = await page.evaluate((f) => window.__spikeSeek(f), seek);
  await page.evaluate(() => window.__spikePlay(3000)).catch(() => {});
  const afterSeek = net.bytes;

  console.log(`  seek to ${(seek * 100).toFixed(0)}%: landed ${seeked.currentTime.toFixed(1)}s, buffered ${JSON.stringify(seeked.buffered)}`);
  console.log(`  transferred ${fmt(afterSeek)} of ${fmt(total)}`);
  console.log(`  ranges: ${net.ranges.slice(0, 8).join(', ')}${net.ranges.length > 8 ? ` … (${net.ranges.length})` : ''}`);
  console.log(`  hosts : ${[...net.hosts].join(', ')}`);
  for (const r of net.redirects) console.log(`  redirect: ${r.from} ${r.status} -> ${r.to}`);

  if (net.authed.length) pass(`DNR attached Authorization to ${net.authed.length} request(s)`);
  else fail('No request carried Authorization — the DNR rule did not match');

  const unauthorized = net.statuses.filter((s) => s.status === 401 || s.status === 403);
  if (unauthorized.length) {
    fail(`${unauthorized.length} request(s) came back ${unauthorized.map((s) => `${s.status}@${s.host}`).join(', ')} — a hop the rule does not cover needs the header`);
  } else pass('No 401/403: every hop was satisfied');

  const offGoogleapis = [...net.hosts].filter((h) => h && h !== 'www.googleapis.com' && !h.endsWith('.googleapis.com'));
  if (offGoogleapis.length) note(`Media traffic also touched: ${offGoogleapis.join(', ')} — confirm whether those hops needed the header before narrowing the rule.`);

  if (net.ranges.length) pass(`Chromium issued ${net.ranges.length} Range request(s)`);
  else fail('No Range request issued — the media stack downloaded linearly');

  const prefix = total * seek;
  if (afterSeek < prefix * 0.5) pass(`Far seek did not drag the prefix: ${fmt(afterSeek)} vs ${fmt(prefix)}`);
  else fail(`Far seek transferred ${fmt(afterSeek)} against a ${fmt(prefix)} prefix — suspect container indexing, not the player architecture (plan section 20: post-seal container normalization)`);

  const surfaces = await page.evaluate(() => window.__spikeSurfaces());
  const leaks = Object.entries(surfaces).filter(([, v]) => typeof v === 'string' && v.includes(token));
  if (leaks.length) fail(`Token leaked into: ${leaks.map(([k]) => k).join(', ')}`);
  else pass('Token absent from page URL, video src, DOM, localStorage and page log');

  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'SPIKE_CLEAR_RULES' }));
} catch (error) {
  fail(`Spike aborted: ${error?.message ?? error}`);
} finally {
  section('VERDICT');
  for (const f of findings) console.log(`  ${f}`);
  console.log(`\n  exit=${exitCode}`);
  await context.close().catch(() => {});
  await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(exitCode);
