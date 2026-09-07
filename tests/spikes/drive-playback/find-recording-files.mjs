/**
 * Recovery helper: list what a recording actually has in Drive.
 *
 * History can point a row at the wrong Drive file (a notes sidecar riding a
 * media stream was once matched by stream alone). This asks Drive directly, so
 * a file that history lost track of still shows up.
 *
 *   node tests/spikes/drive-playback/find-recording-files.mjs --token "$DRIVE_TOKEN" [--match 20260901]
 */
const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const token = arg('--token') ?? process.env.DRIVE_TOKEN;
const match = arg('--match');
if (!token) { console.error('Pass --token "$DRIVE_TOKEN".'); process.exit(2); }

const mb = (n) => `${(Number(n) / 1048576).toFixed(1)} MB`;
const res = await fetch(
  'https://www.googleapis.com/drive/v3/files?pageSize=500&orderBy=createdTime desc'
  + '&fields=files(id,name,size,mimeType,createdTime,parents)&q=trashed=false',
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!res.ok) { console.error(`files.list failed: ${res.status} ${await res.text()}`); process.exit(1); }

const files = (await res.json()).files ?? [];
const shown = match ? files.filter((f) => (f.name ?? '').includes(match)) : files;
if (!shown.length) { console.log(match ? `No app-created file matches "${match}".` : 'No app-created files.'); process.exit(0); }

// Group by parent folder: one recording is one folder.
const byParent = new Map();
for (const f of shown) {
  const key = (f.parents ?? ['(no folder)'])[0];
  if (!byParent.has(key)) byParent.set(key, []);
  byParent.get(key).push(f);
}

for (const [parent, group] of byParent) {
  console.log(`\nfolder ${parent}`);
  for (const f of group.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
    const size = Number(f.size ?? 0);
    const flag = size > 0 && size < 4096 ? '  <-- suspiciously small' : '';
    console.log(`  ${String(f.name).padEnd(52)} ${mb(size).padStart(10)}  ${f.id}${flag}`);
  }
}
console.log('\nA microphone track for a one-hour call should be tens of MB.');
console.log('If you see one, your audio is intact — download it with:');
console.log('  curl -L -H "Authorization: Bearer $DRIVE_TOKEN" \\');
console.log('    "https://www.googleapis.com/drive/v3/files/<ID>?alt=media" -o mic.webm');
