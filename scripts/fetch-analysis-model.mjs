/**
 * Materializes the packaged embedding model at build time.
 *
 * ADR-0007: embedding artifacts are extension-owned. The released extension
 * carries the complete model, tokenizer, config and runtime, and analysis makes
 * no network request. This script is the *supply chain* for that package, not a
 * runtime capability — it runs on a developer or CI machine, never in the
 * browser.
 *
 * Every artifact is pinned to an immutable revision, an exact byte length and a
 * SHA-256, and any mismatch fails the build rather than shipping something
 * nobody vouched for. Downloads are cached under `.cache/analysis-model/<rev>/`
 * so ordinary rebuilds do no network work at all.
 *
 *   node scripts/fetch-analysis-model.mjs            # fetch + verify
 *   node scripts/fetch-analysis-model.mjs --verify   # verify cache, never fetch
 *   node scripts/fetch-analysis-model.mjs --print-digests
 *       # re-derive digests for a revision bump; review the diff by hand
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Shared artifacts, and the one ONNX export a build packages.
 *
 * This model's exports do not order the way the names suggest — the INT8 export
 * is ~118 MB while plain `q4` is ~399 MB and `q4f16` ~205 MB. The extension
 * packages exactly **one** dtype; 4A chooses which by measuring both as
 * separate builds. `ANALYSIS_DTYPE` selects it; Q8 is the baseline.
 */
export const ANALYSIS_MODEL = {
  id: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  dimensions: 384,
  shared: [
    { path: 'config.json', bytes: 658, sha256: 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1' },
    { path: 'tokenizer.json', bytes: 17_082_730, sha256: '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39' },
    { path: 'tokenizer_config.json', bytes: 443, sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b' },
    { path: 'special_tokens_map.json', bytes: 167, sha256: 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7' },
  ],
  /** Transformers.js resolves a dtype to one of these filenames. */
  onnx: {
    q8: { path: 'onnx/model_quantized.onnx', bytes: 118_308_185, sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193' },
    fp16: { path: 'onnx/model_fp16.onnx', bytes: 235_336_732, sha256: '0e0fe349c99ea21c6f3aa273af21f7fb753c1e1174ef1647032029c2be3251c3' },
  },
};

/** The dtype this build packages. */
export function selectedDtype() {
  const dtype = process.env.ANALYSIS_DTYPE ?? 'q8';
  if (!(dtype in ANALYSIS_MODEL.onnx)) {
    throw new Error(`Unknown ANALYSIS_DTYPE '${dtype}'; known: ${Object.keys(ANALYSIS_MODEL.onnx).join(', ')}`);
  }
  return dtype;
}

/** Shared artifacts plus the selected export — what one build materializes. */
export function selectedFiles() {
  return [...ANALYSIS_MODEL.shared, ANALYSIS_MODEL.onnx[selectedDtype()]];
}

export function modelCacheDir() {
  return join(ROOT, '.cache', 'analysis-model', ANALYSIS_MODEL.revision);
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function readCached(file) {
  const path = join(modelCacheDir(), file.path);
  return existsSync(path) ? await readFile(path) : undefined;
}

function check(file, body) {
  if (body.byteLength !== file.bytes) {
    return `expected ${file.bytes} bytes, got ${body.byteLength}`;
  }
  const digest = sha256(body);
  if (file.sha256 && digest !== file.sha256) {
    return `expected sha256 ${file.sha256}, got ${digest}`;
  }
  return undefined;
}

async function download(file) {
  const url = `https://huggingface.co/${ANALYSIS_MODEL.id}/resolve/${ANALYSIS_MODEL.revision}/${file.path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${file.path}: ${response.status} ${response.statusText} from ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function materialize({ verifyOnly = false } = {}) {
  const dir = modelCacheDir();
  const results = [];

  for (const file of selectedFiles()) {
    const target = join(dir, file.path);
    let body = await readCached(file);
    let source = 'cache';

    if (body) {
      const problem = check(file, body);
      if (problem) {
        // A corrupt or half-written cache entry is discarded, not trusted.
        if (verifyOnly) throw new Error(`Cached ${file.path} is wrong: ${problem}`);
        console.warn(`  ! cached ${file.path} is wrong (${problem}); re-fetching`);
        await rm(target, { force: true });
        body = undefined;
      }
    }

    if (!body) {
      if (verifyOnly) throw new Error(`${file.path} is not in the model cache; run without --verify`);
      body = await download(file);
      const problem = check(file, body);
      if (problem) throw new Error(`${file.path} failed verification: ${problem}`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      source = 'downloaded';
    }

    results.push({ ...file, digest: sha256(body), source });
    console.log(`  ${source === 'cache' ? '·' : '↓'} ${file.path} (${body.byteLength.toLocaleString()} bytes)`);
  }
  return results;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  console.log(`${ANALYSIS_MODEL.id}@${ANALYSIS_MODEL.revision} [${selectedDtype()}] → ${modelCacheDir()}`);

  const results = await materialize({ verifyOnly: args.has('--verify') });

  if (args.has('--print-digests')) {
    console.log('\nDigests for this revision — review before pinning:');
    for (const r of results) {
      console.log(`    { path: '${r.path}', bytes: ${r.bytes}, sha256: '${r.digest}' },`);
    }
    return;
  }

  const unpinned = results.filter((r) => !r.sha256);
  if (unpinned.length) {
    console.warn(`\n  ! ${unpinned.length} artifact(s) verified by byte length only.`);
    console.warn('    Run with --print-digests and pin their sha256 in this file.');
  }
  console.log('\nModel artifacts verified.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\nAnalysis model materialization failed: ${error.message}`);
    process.exit(1);
  });
}
