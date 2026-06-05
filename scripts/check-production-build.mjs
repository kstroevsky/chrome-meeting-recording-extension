import fs from 'node:fs/promises';
import path from 'node:path';

const distDir = path.resolve(process.cwd(), 'dist');
const forbiddenMarkers = [
  'e2e-mock-drive-token',
  '__E2E_MOCK_TAB_CAPTURE__',
  'E2E_DRIVE_FETCH',
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

if (violations.length) {
  console.error(`Production build contains E2E-only capabilities:\n${violations.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('Production build excludes synthetic capture, fake OAuth, and Drive fetch bridge markers.');
}
