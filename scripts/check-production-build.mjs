import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toChromeManifestVersion } = require('./lib/manifestVersion.cjs');
const pkg = require('../package.json');

const distDir = path.resolve(process.cwd(), 'dist');
const forbiddenMarkers = [
  'e2e-mock-drive-token',
  '__E2E_MOCK_TAB_CAPTURE__',
  'E2E_DRIVE_FETCH',
  'E2E real capture tab runtime selected',
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
for (const file of files.filter((candidate) => candidate.endsWith('.js'))) {
  const source = await fs.readFile(file, 'utf8');
  for (const marker of forbiddenMarkers) {
    if (source.includes(marker)) {
      violations.push(`${path.relative(process.cwd(), file)} contains ${marker}`);
    }
  }
}

// The Chrome manifest version is derived from package.json at build time; assert
// the built artifact actually reflects that so a stale or un-derived version can
// never reach the store.
const expectedVersion = toChromeManifestVersion(pkg.version);
try {
  const manifest = JSON.parse(await fs.readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  if (manifest.version === '0.0.0') {
    violations.push('dist/manifest.json version is the 0.0.0 placeholder — the build did not derive it from package.json');
  } else if (manifest.version !== expectedVersion) {
    violations.push(`dist/manifest.json version "${manifest.version}" != package.json-derived "${expectedVersion}"`);
  }
} catch (error) {
  violations.push(`cannot validate dist/manifest.json version: ${error.message}`);
}

if (violations.length) {
  console.error(`Production build failed guards:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(
    `Production build clean: version ${expectedVersion} derived from package.json; no synthetic capture, fake OAuth, Drive fetch bridge, or live-E2E recorder-tab markers.`
  );
}
