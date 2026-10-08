import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOMAIN_NAMES,
  classifyChangedFiles,
  classifyPath,
  computeDomainFingerprint,
} from '../../scripts/ci/validation-domains.mjs';
import { buildPlan } from '../../scripts/ci/plan-validation.mjs';

function domains(path) {
  return classifyPath(path).domains;
}

test('classifies representative repository paths conservatively', () => {
  const cases = new Map([
    ['docs/sharing-operations.md', []],
    ['src/sharing/README.md', []],
    ['sharing-worker/src/router.ts', ['sharing']],
    ['sharing-worker/migrations/0005_x.sql', ['sharing']],
    ['src/sharing/ShareMediaSourceResolver.ts', ['verify', 'sharing']],
    [
      'src/background/sharing/BackgroundSharingRuntime.ts',
      ['verify', 'sharing'],
    ],
    ['src/recordings/ShareDialog.ts', ['verify', 'sharing']],
    [
      'src/recordings/RecordingsController.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/recordings/RecordingsView.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/background/messaging/sharingMessages.ts',
      ['verify', 'sharing'],
    ],
    [
      'src/background/messaging/messageHandlers.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/background/offscreen/OffscreenManager.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/offscreen/storage/opfsLayout.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/offscreen/storage/indexedDbKeyValueArea.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/platform/capabilities/AuthProvider.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/platform/capabilities/auth/ChromeIdentityAuthProvider.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/platform/chrome/identity.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/platform/chrome/offscreen.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/platform/chrome/runtime.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    ['src/shared/rpc.ts', ['verify', 'sharing', 'mock-e2e']],
    ['src/shared/async.ts', ['verify', 'sharing', 'mock-e2e']],
    ['src/shared/timeouts.ts', ['verify', 'sharing', 'mock-e2e']],
    [
      'src/shared/build.ts',
      ['verify', 'sharing', 'mock-e2e', 'production-e2e'],
    ],
    [
      'src/offscreen.ts',
      ['verify', 'sharing', 'mock-e2e', 'production-e2e'],
    ],
    [
      'src/shared/protocol.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    [
      'src/shared/player/PlaybackClock.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    ['tests/e2e/sharing-lifecycle.spec.ts', ['verify', 'sharing']],
    [
      'tests/e2e/helpers/driveSimulator.ts',
      ['verify', 'sharing', 'mock-e2e'],
    ],
    ['tests/e2e/recording-playback.spec.ts', ['verify', 'mock-e2e']],
    [
      'tests/e2e/analysis-embedding.spec.ts',
      ['verify', 'mock-e2e', 'production-e2e'],
    ],
    ['webpack.config.js', DOMAIN_NAMES],
    ['package-lock.json', DOMAIN_NAMES],
    ['.github/workflows/ci.yml', DOMAIN_NAMES],
    ['static/manifest.json', DOMAIN_NAMES],
    ['public/gear.png', DOMAIN_NAMES],
  ]);

  for (const [path, expected] of cases) {
    assert.deepEqual([...domains(path)].sort(), [...expected].sort(), path);
  }
});

test('unknown paths force every domain and report missing ownership', () => {
  const result = classifyChangedFiles(['src/exporting/foo.py']);
  assert.deepEqual(result.relevant, {
    verify: true,
    'mock-e2e': true,
    sharing: true,
    'production-e2e': true,
  });
  assert.deepEqual(result.unknownPaths, ['src/exporting/foo.py']);
});

test('unknown assets also fail closed unless explicitly ignored', () => {
  const result = classifyChangedFiles(['assets/new-image.png']);
  assert.deepEqual(result.relevant, {
    verify: true,
    'mock-e2e': true,
    sharing: true,
    'production-e2e': true,
  });
  assert.deepEqual(result.unknownPaths, ['assets/new-image.png']);
});

test('explicit inert docs stay ignored', () => {
  const result = classifyChangedFiles(['docs/new-note.md']);
  assert.deepEqual(result.relevant, {
    verify: false,
    'mock-e2e': false,
    sharing: false,
    'production-e2e': false,
  });
  assert.deepEqual(result.unknownPaths, []);
});

test('fingerprints only move for domain-owned inputs', () => {
  const base = [
    { path: '.github/workflows/ci.yml', blob: 'ci-1' },
    { path: 'package-lock.json', blob: 'lock-1' },
    { path: 'src/background/recording/RecordingController.ts', blob: 'core-1' },
    { path: 'sharing-worker/src/router.ts', blob: 'share-1' },
    { path: 'docs/README.md', blob: 'docs-1' },
  ];

  const before = Object.fromEntries(
    DOMAIN_NAMES.map((domain) => [domain, computeDomainFingerprint(domain, base)]),
  );

  const docsEdited = base.map((entry) =>
    entry.path === 'docs/README.md' ? { ...entry, blob: 'docs-2' } : entry,
  );
  assert.equal(
    computeDomainFingerprint('mock-e2e', docsEdited),
    before['mock-e2e'],
  );

  const coreEdited = base.map((entry) =>
    entry.path.includes('RecordingController') ? { ...entry, blob: 'core-2' } : entry,
  );
  assert.notEqual(
    computeDomainFingerprint('mock-e2e', coreEdited),
    before['mock-e2e'],
  );

  const sharingEdited = base.map((entry) =>
    entry.path === 'sharing-worker/src/router.ts'
      ? { ...entry, blob: 'share-2' }
      : entry,
  );
  assert.equal(
    computeDomainFingerprint('mock-e2e', sharingEdited),
    before['mock-e2e'],
  );
  assert.notEqual(
    computeDomainFingerprint('sharing', sharingEdited),
    before.sharing,
  );
});

test('shared extension harness invalidates mock, sharing and production', () => {
  const before = [
    { path: '.github/workflows/ci.yml', blob: 'ci-1' },
    { path: 'tests/e2e/helpers/extensionHarness.ts', blob: 'harness-1' },
  ];
  const after = before.map((entry) =>
    entry.path.endsWith('extensionHarness.ts')
      ? { ...entry, blob: 'harness-2' }
      : entry,
  );

  for (const domain of ['mock-e2e', 'sharing', 'production-e2e']) {
    assert.notEqual(
      computeDomainFingerprint(domain, before),
      computeDomainFingerprint(domain, after),
      domain,
    );
  }
});

test('sharing runtime dependencies invalidate the sharing fingerprint', () => {
  const before = [
    { path: '.github/workflows/ci.yml', blob: 'ci-1' },
    { path: 'src/background/offscreen/OffscreenManager.ts', blob: 'offscreen-manager-1' },
    { path: 'src/shared/build.ts', blob: 'build-1' },
  ];
  const offscreenChanged = before.map((entry) =>
    entry.path.endsWith('OffscreenManager.ts')
      ? { ...entry, blob: 'offscreen-manager-2' }
      : entry,
  );
  const buildChanged = before.map((entry) =>
    entry.path === 'src/shared/build.ts'
      ? { ...entry, blob: 'build-2' }
      : entry,
  );

  assert.notEqual(
    computeDomainFingerprint('sharing', before),
    computeDomainFingerprint('sharing', offscreenChanged),
  );
  assert.notEqual(
    computeDomainFingerprint('sharing', before),
    computeDomainFingerprint('sharing', buildChanged),
  );
  assert.notEqual(
    computeDomainFingerprint('production-e2e', before),
    computeDomainFingerprint('production-e2e', buildChanged),
  );
});

test('PR relevance stays PR-wide while unchanged fingerprints are reusable', () => {
  const entries = [
    { path: '.github/workflows/ci.yml', blob: 'ci-1' },
    { path: 'package-lock.json', blob: 'lock-1' },
    { path: 'src/offscreen.ts', blob: 'offscreen-1' },
    { path: 'docs/sharing-operations.md', blob: 'docs-2' },
  ];

  const plan = buildPlan({
    eventName: 'pull_request',
    changedFiles: ['src/offscreen.ts', 'docs/sharing-operations.md'],
    entries,
    forceAll: false,
  });

  assert.deepEqual(plan.relevant, {
    verify: true,
    'mock-e2e': true,
    sharing: true,
    'production-e2e': true,
  });

  const docsAgain = entries.map((entry) =>
    entry.path.endsWith('.md') ? { ...entry, blob: 'docs-3' } : entry,
  );
  const followUp = buildPlan({
    eventName: 'pull_request',
    changedFiles: ['src/offscreen.ts', 'docs/sharing-operations.md'],
    entries: docsAgain,
    forceAll: false,
  });
  assert.deepEqual(followUp.fingerprints, plan.fingerprints);
});

test('push validation forces all domains independent of changed-file classification', () => {
  const plan = buildPlan({
    eventName: 'push',
    changedFiles: ['README.md'],
    entries: [{ path: '.github/workflows/ci.yml', blob: 'ci-1' }],
    forceAll: true,
  });
  assert.deepEqual(plan.relevant, {
    verify: true,
    'mock-e2e': true,
    sharing: true,
    'production-e2e': true,
  });
});
