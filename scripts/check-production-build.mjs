import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readReleaseVersion } = require('./lib/releaseVersion.cjs');
const { ANALYSIS_MODEL } = require('./lib/analysisModel.cjs');
const pkg = require('../package.json');
const telemetryEndpoint = process.env.TELEMETRY_ENDPOINT?.trim() ?? '';

const distDir = path.resolve(process.cwd(), 'dist');
const forbiddenMarkers = [
  'e2e-mock-drive-token',
  '__E2E_MOCK_TAB_CAPTURE__',
  'E2E_DRIVE_FETCH',
  'E2E real capture tab runtime selected',
  '__E2E_MOCK_ANALYSIS__',
];

async function collectFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await collectFiles(distDir);
const violations = [];
let telemetryOrigin = '';
try {
  const url = new URL(telemetryEndpoint);
  if (url.protocol !== 'https:' || url.pathname !== '/api/telemetry/batches' || url.search || url.hash || url.username || url.password) throw new Error('invalid shape');
  telemetryOrigin = url.origin;
} catch {
  violations.push('TELEMETRY_ENDPOINT must be the exact HTTPS /api/telemetry/batches endpoint used for this build');
}
for (const file of files.filter((candidate) => candidate.endsWith('.js'))) {
  const source = await fs.readFile(file, 'utf8');
  for (const marker of forbiddenMarkers) {
    if (source.includes(marker)) {
      violations.push(`${path.relative(process.cwd(), file)} contains ${marker}`);
    }
  }
}

// The Chrome manifest version is counted from git history at build time; assert
// the built artifact carries the count for the commit checked out now, so a
// stale build (made before the last commit) or an uncounted one never ships.
let expectedVersion = null;
try {
  expectedVersion = readReleaseVersion({ cwd: process.cwd(), packageVersion: pkg.version });
} catch (error) {
  violations.push(`cannot count the release version from git: ${error.message}`);
}
try {
  const manifest = JSON.parse(await fs.readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("'wasm-unsafe-eval'")) {
    violations.push("dist/manifest.json extension_pages CSP is missing 'wasm-unsafe-eval' — ONNX Runtime cannot instantiate");
  }
  if (manifest.version === '0.0.0') {
    violations.push('dist/manifest.json version is the 0.0.0 placeholder — the build did not count it from git');
  } else if (expectedVersion && manifest.version !== expectedVersion) {
    violations.push(`dist/manifest.json version "${manifest.version}" != "${expectedVersion}" counted for this commit — rebuild`);
  }
  if (telemetryOrigin && !manifest.host_permissions?.includes(`${telemetryOrigin}/*`)) {
    violations.push(`dist/manifest.json is missing the exact telemetry host permission ${telemetryOrigin}/*`);
  }
  if (!manifest.permissions?.includes('alarms')) {
    violations.push('dist/manifest.json is missing the alarms permission required for bounded one-shot telemetry retries');
  }
} catch (error) {
  violations.push(`cannot validate dist/manifest.json version: ${error.message}`);
}

/*
 * Topic analysis ships with its model in the package (ADR-0007). Three things
 * have to be true together, and none of them is visible at runtime until a user
 * tries to analyse a recording — by which point the model is a 118 MB download
 * that is not there.
 *
 *   1. the ONNX export and its tokenizer were copied into the build,
 *   2. ONNX Runtime's `.wasm` binaries came with them, and
 *   3. the build stamped the model's identity, so provenance names what shipped.
 *
 * The CSP key is checked here too: without `'wasm-unsafe-eval'` the runtime
 * cannot instantiate at all, and that is a store-review-visible line nobody
 * would notice had been dropped.
 */
const modelDir = path.join(distDir, 'models', ANALYSIS_MODEL.id);
for (const required of ['config.json', 'tokenizer.json', ANALYSIS_MODEL.onnxPath]) {
  try {
    const stat = await fs.stat(path.join(modelDir, required));
    if (!stat.size) violations.push(`packaged analysis model file is empty: models/${ANALYSIS_MODEL.id}/${required}`);
  } catch {
    violations.push(`packaged analysis model is missing models/${ANALYSIS_MODEL.id}/${required}`);
  }
}
try {
  const ortFiles = await fs.readdir(path.join(distDir, 'ort'));
  if (!ortFiles.some((name) => name.endsWith('.wasm'))) {
    violations.push('dist/ort carries no .wasm binary — ONNX Runtime cannot start');
  }
} catch {
  violations.push('dist/ort is missing — ONNX Runtime binaries were not packaged');
}
// Stamped from the same manifest the fetcher verified, so a build cannot record
// provenance for a model other than the one on disk beside it.
const workerBundle = path.join(distDir, 'analysisWorker.js');
try {
  await fs.stat(workerBundle);
} catch {
  violations.push('dist/analysisWorker.js is missing — the embedding engine was not built');
}
const backgroundBundle = path.join(distDir, 'background.js');
try {
  if (!(await fs.readFile(backgroundBundle, 'utf8')).includes(ANALYSIS_MODEL.revision)) {
    violations.push(`dist/background.js does not carry the packaged model revision ${ANALYSIS_MODEL.revision} — __ANALYSIS_MODEL__ was not defined`);
  }
} catch (error) {
  violations.push(`cannot validate the packaged model define: ${error.message}`);
}

if (violations.length) {
  console.error(`Production build failed guards:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Production build clean: version ${expectedVersion}, telemetry endpoint permission, and retry alarm are present; `
    + `${ANALYSIS_MODEL.id}@${ANALYSIS_MODEL.revision} [${ANALYSIS_MODEL.dtype}] is packaged with its ONNX Runtime and stamped into the build; `
    + `no synthetic capture, fake OAuth, Drive fetch bridge, or live-E2E recorder-tab markers.`
  );
}
