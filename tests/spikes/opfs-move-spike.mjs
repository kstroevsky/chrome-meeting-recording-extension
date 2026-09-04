/**
 * SPIKE (throwaway) — ADR-0006 exit criterion, half 2.
 *
 * Proves OPFS promotion (`staging/` -> `library/`) can transfer ownership of a
 * large recording WITHOUT an application-level byte-for-byte copy, on Chrome and
 * on at least one non-Chrome Chromium target we actively build for.
 *
 * Method: write an N-MB file into staging/, then (a) FileSystemHandle.move() it
 * into library/ and (b) separately stream-copy an identical file. If move() is
 * genuinely a metadata operation its elapsed time is orders of magnitude below
 * the copy's, and is ~flat in N. We assert correctness (bytes + directory
 * membership) and report both timings.
 *
 *   node tests/spikes/opfs-move-spike.mjs [--mb=128]
 */
import { chromium } from '@playwright/test';
import http from 'node:http';

const MB = Number((process.argv.find(a => a.startsWith('--mb=')) || '--mb=128').split('=')[1]);

// OPFS needs a secure context; 127.0.0.1 qualifies.
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><title>opfs spike</title>');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/** Runs inside the page. Returns a plain result object. */
const probe = async (sizeMb) => {
  const bytes = sizeMb * 1024 * 1024;
  const root = await navigator.storage.getDirectory();

  // Clean slate.
  for (const dir of ['staging', 'library']) {
    try { await root.removeEntry(dir, { recursive: true }); } catch {}
  }
  const staging = await root.getDirectoryHandle('staging', { create: true });
  const library = await root.getDirectoryHandle('library', { create: true });

  const CHUNK = 8 * 1024 * 1024;
  const chunk = new Uint8Array(CHUNK).fill(0xab);
  const write = async (dir, name) => {
    const h = await dir.getFileHandle(name, { create: true });
    const w = await h.createWritable();
    let written = 0;
    while (written < bytes) {
      const n = Math.min(CHUNK, bytes - written);
      await w.write(n === CHUNK ? chunk : chunk.subarray(0, n));
      written += n;
    }
    await w.close();
    return h;
  };

  const listing = async (dir) => {
    const names = [];
    for await (const n of dir.keys()) names.push(n);
    return names.sort();
  };

  // Presence of the method is NOT proof it works: Edge 118 exposes
  // FileSystemFileHandle.prototype.move and throws NotAllowedError on call.
  // The real capability test is calling it.
  const movePresent = typeof FileSystemFileHandle.prototype.move === 'function';
  const result = { sizeMb, movePresent, moveUsable: false };

  // --- (a) promotion by move() ---
  if (movePresent) {
    const src = await write(staging, 'take-1.webm');
    const t0 = performance.now();
    try {
      await src.move(library, 'promoted.webm');
      result.moveUsable = true;
      result.moveMs = Math.round(performance.now() - t0);

      const promoted = await library.getFileHandle('promoted.webm');
      const pf = await promoted.getFile();
      result.promotedBytes = pf.size;
      result.stagingAfterMove = await listing(staging);
      result.libraryAfterMove = await listing(library);

      // Spot-check the bytes really are the same content, not a truncated stub.
      const head = new Uint8Array(await pf.slice(0, 4).arrayBuffer());
      const tail = new Uint8Array(await pf.slice(pf.size - 4).arrayBuffer());
      result.bytesIntact = head.every(b => b === 0xab) && tail.every(b => b === 0xab);
    } catch (e) {
      result.moveError = `${e.name}: ${e.message}`;
      try { await staging.removeEntry('take-1.webm'); } catch {}
    }
  }

  // --- (b) the fallback path, for comparison ---
  const src2 = await write(staging, 'take-2.webm');
  const t1 = performance.now();
  const destHandle = await library.getFileHandle('copied.webm', { create: true });
  const file2 = await src2.getFile();
  await file2.stream().pipeTo(await destHandle.createWritable());
  await staging.removeEntry('take-2.webm');
  result.copyMs = Math.round(performance.now() - t1);

  const { quota, usage } = await navigator.storage.estimate();
  result.estimate = { usageMb: Math.round(usage / 1048576), quotaMb: Math.round(quota / 1048576) };

  for (const dir of ['staging', 'library']) {
    try { await root.removeEntry(dir, { recursive: true }); } catch {}
  }
  return result;
};

const targets = [
  { name: 'Chromium (Playwright)', opts: {} },
  { name: 'Microsoft Edge',        opts: { channel: 'msedge' } },
  { name: 'Brave',                 opts: { executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' } },
];

let exit = 0;
for (const t of targets) {
  let browser;
  try {
    browser = await chromium.launch(t.opts);
    const page = await browser.newPage();
    await page.goto(url);
    const r = await page.evaluate(probe, MB);
    const version = browser.version();

    const ok = r.moveUsable && r.bytesIntact
      && r.promotedBytes === MB * 1024 * 1024
      && r.stagingAfterMove.length === 0
      && r.libraryAfterMove.includes('promoted.webm');
    // A target where move() is unusable is not a spike failure — it is the
    // fallback path, and the point is that we detect it by CALLING, not by typeof.
    if (!ok && r.moveUsable) exit = 1;

    console.log(`\n=== ${t.name}  (Chromium ${version}) ===`);
    console.log(`  move() present   : ${r.movePresent}`);
    console.log(`  move() usable    : ${r.moveUsable}${r.moveError ? `  <- ${r.moveError}` : ''}`);
    if (r.moveUsable) {
      console.log(`  promote ${r.sizeMb} MB  : ${r.moveMs} ms   <- move()`);
      console.log(`  speedup          : ${(r.copyMs / Math.max(r.moveMs, 1)).toFixed(0)}x vs copy`);
      console.log(`  bytes intact     : ${r.bytesIntact} (${r.promotedBytes} bytes)`);
      console.log(`  staging after    : [${r.stagingAfterMove}]  library after: [${r.libraryAfterMove}]`);
    }
    if (r.copyMs !== undefined) console.log(`  copy    ${r.sizeMb} MB  : ${r.copyMs} ms   <- stream fallback`);
    if (r.estimate) console.log(`  storage estimate : ${r.estimate.usageMb} MB used / ${r.estimate.quotaMb} MB quota`);
    console.log(`  VERDICT          : ${ok ? 'PASS (copy-free promotion)'
      : r.movePresent && !r.moveUsable ? 'FALLBACK REQUIRED (move present but throws)'
      : 'FALLBACK REQUIRED (no move)'}`);
  } catch (err) {
    console.log(`\n=== ${t.name} ===\n  SKIPPED/ERROR: ${err.message.split('\n')[0]}`);
  } finally {
    await browser?.close();
  }
}
server.close();
process.exit(exit);
