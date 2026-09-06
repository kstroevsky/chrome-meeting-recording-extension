/**
 * SPIKE part 1 (throwaway) — the one question only real Google can answer.
 *
 * `files.get?alt=media` with a Range header: what is the status, does the
 * response redirect off www.googleapis.com, and if so does the final hop still
 * demand Authorization? That answer decides how wide the DNR rule must be, and
 * ADR-0006 refuses to guess it.
 *
 * Needs no extension and no browser — just a Drive access token.
 *
 *   node tests/spikes/drive-playback/probe.mjs --token "$TOKEN" [--file-id <id>]
 *
 * Minting a token from your main Chrome: open the extension's service worker
 * console (chrome://extensions -> the extension -> "service worker") and run
 *   const r = await new Promise(res => chrome.identity.getAuthToken({interactive:true}, res));
 *   const token = typeof r === 'string' ? r : r?.token;   // Chrome 128+ returns an object
 *   console.log(token);
 *
 * then right-click the logged string -> "Copy string contents". Do NOT use
 * `t => copy(t)`: `copy` is a DevTools helper that does not exist inside the
 * async callback.
 * That is the extension's own OAuth client and consent — nothing new is granted.
 */
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const token = arg('--token') ?? process.env.DRIVE_TOKEN;
if (!token) { console.error('Pass --token <access token> (or set DRIVE_TOKEN). See the header of this file.'); process.exit(2); }

const fmt = (n) => `${(n / 1048576).toFixed(1)} MB`;
const findings = [];
let exitCode = 0;
const pass = (m) => findings.push(`PASS  ${m}`);
const fail = (m) => { findings.push(`FAIL  ${m}`); exitCode = 1; };
const note = (m) => findings.push(`NOTE  ${m}`);

// ---- pick a real recording -------------------------------------------------
let fileId = arg('--file-id');
let meta;
if (!fileId) {
  // drive.file scope sees exactly what the extension created — real
  // MediaRecorder output, which is what plan section 20 wants exercised.
  const res = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=200&fields=files(id,name,size,mimeType)&q=trashed=false', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) { console.error(`files.list failed: ${res.status} ${await res.text()}`); process.exit(1); }
  const files = (await res.json()).files ?? [];
  const candidates = files.filter((f) => Number(f.size) > 0 && /\.(webm|mp4)$/i.test(f.name ?? ''))
    .sort((a, b) => Number(b.size) - Number(a.size));
  if (!candidates.length) { console.error('No app-created .webm/.mp4 in Drive. Upload a recording, or pass --file-id.'); process.exit(1); }
  meta = candidates[0];
  console.log(`Largest of ${candidates.length} app-created media: ${meta.name} (${fmt(Number(meta.size))})`);
  if (Number(meta.size) < 100 * 1048576) note(`Largest file is only ${fmt(Number(meta.size))}; plan section 20 wants a large real WebM for the seekability verdict.`);
  fileId = meta.id;
} else {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,size,mimeType`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error(`files.get metadata failed: ${res.status}`); process.exit(1); }
  meta = await res.json();
  console.log(`Using ${meta.name} (${fmt(Number(meta.size))})`);
}

// ---- walk the redirect chain by hand --------------------------------------
console.log('\n=== Range probe / redirect chain ===');
let url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
let sendAuth = true;
let hops = 0;
let last = null;
while (hops < 6) {
  hops += 1;
  const headers = { Range: 'bytes=0-1023' };
  if (sendAuth) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, redirect: 'manual' });
  const h = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
  last = { url, host: new URL(url).host, sentAuth: sendAuth, status: res.status, contentRange: h['content-range'] ?? null, acceptRanges: h['accept-ranges'] ?? null, location: h.location ?? null };
  console.log(`  hop ${hops}: ${res.status} ${last.host}  auth=${sendAuth ? 'yes' : 'no '}  content-range=${last.contentRange ?? '-'}  accept-ranges=${last.acceptRanges ?? '-'}`);
  if (last.location) console.log(`          -> ${last.location.slice(0, 140)}`);
  if (res.status >= 300 && res.status < 400 && last.location) {
    url = new URL(last.location, url).toString();
    // Deliberately drop the header on the next hop: whether the redirect target
    // needs it is exactly what decides the DNR rule's scope.
    sendAuth = false;
    continue;
  }
  break;
}

if (last.status === 206) pass(`Range honoured: 206, content-range ${last.contentRange}`);
else if (last.status === 200) fail('Final hop returned 200, not 206 — Range was ignored (whole-object download)');
else fail(`Final hop returned ${last.status} on ${last.host}`);

if (hops === 1) {
  pass('No redirect: the media response terminates on www.googleapis.com — the DNR rule stays scoped to that host');
} else if (!last.sentAuth && last.status < 400) {
  pass(`Redirects to ${last.host}, which serves the range WITHOUT Authorization — keep the rule on www.googleapis.com only`);
} else {
  fail(`Redirect target ${last.host} returned ${last.status} without Authorization — the rule must also cover that exact host/path (and only it)`);
}

console.log('\n=== VERDICT ===');
for (const f of findings) console.log(`  ${f}`);
console.log(`\n  exit=${exitCode}`);
process.exit(exitCode);
