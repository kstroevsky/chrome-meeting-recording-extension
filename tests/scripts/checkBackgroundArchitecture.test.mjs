import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../../scripts/check-background-architecture.mjs', import.meta.url));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'background-architecture-'));
  const write = async (relative, source) => {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  };
  await write('src/background.ts', 'chrome.runtime.onMessage.addListener(listener);\n');
  await write('src/background/runtime/Valid.ts', 'export const valid = true;\n');
  await write(
    'src/background/library/analysis/RecordingAnalysisCoordinator.ts',
    Array.from({ length: 251 }, (_, index) => `// accepted ${index}`).join('\n') + '\n',
  );
  return {
    root,
    write,
    run() {
      return spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

async function withFixture(run) {
  const f = await fixture();
  try {
    await run(f);
  } finally {
    await f.cleanup();
  }
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

test('accepts nested production files, the documented size exception, and entrypoint listeners', async () => {
  await withFixture(async (f) => {
    const result = f.run();
    assert.equal(result.status, 0, output(result));
  });
});

test('rejects production TypeScript directly under background/', async () => {
  await withFixture(async (f) => {
    await f.write('src/background/Bad.ts', 'export const bad = true;\n');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /feature package/);
  });
});

test('rejects unapproved files over the line target', async () => {
  await withFixture(async (f) => {
    await f.write(
      'src/background/runtime/TooLarge.ts',
      Array.from({ length: 251 }, (_, index) => `// line ${index}`).join('\n') + '\n',
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /exceeds the 250-line background target/);
  });
});

test('rejects library to runtime imports', async () => {
  await withFixture(async (f) => {
    await f.write(
      'src/background/library/BadDependency.ts',
      "import '../../runtime/Valid';\nexport const bad = true;\n",
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /library must not import runtime/);
  });
});

test('rejects raw Chrome operations in feature packages', async () => {
  await withFixture(async (f) => {
    await f.write(
      'src/background/runtime/RawChrome.ts',
      'export const reload = () => chrome.runtime.reload();\n',
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /raw Chrome operation/);
  });
});

test('rejects stale line-limit exceptions', async () => {
  await withFixture(async (f) => {
    await f.write(
      'src/background/library/analysis/RecordingAnalysisCoordinator.ts',
      'export const coordinator = true;\n',
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /stale line-limit exception/);
  });
});

test('entrypoint allows listener registration but rejects other Chrome operations', async () => {
  await withFixture(async (f) => {
    await f.write(
      'src/background.ts',
      'chrome.runtime.onMessage.addListener(listener);\nchrome.runtime.reload();\n',
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /entrypoint may only register listeners/);
  });
});

test('entrypoint rejects business declarations and size creep', async () => {
  await withFixture(async (f) => {
    await f.write(
      'src/background.ts',
      'function businessLogic() {}\n' + Array.from({ length: 100 }, () => '// filler').join('\n') + '\n',
    );
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(output(result), /domain\/business declarations/);
    assert.match(output(result), /100-line entrypoint target/);
  });
});
