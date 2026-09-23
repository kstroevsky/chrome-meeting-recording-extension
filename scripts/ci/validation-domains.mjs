import { createHash } from 'node:crypto';

export const VALIDATION_SCHEMA = 1;
export const DOMAIN_NAMES = ['verify', 'mock-e2e', 'sharing', 'production-e2e'];

const ALL = DOMAIN_NAMES;
const VERIFY = ['verify'];
const VERIFY_MOCK = ['verify', 'mock-e2e'];
const VERIFY_SHARING = ['verify', 'sharing'];
const VERIFY_SHARING_MOCK = ['verify', 'sharing', 'mock-e2e'];
const VERIFY_MOCK_PRODUCTION = ['verify', 'mock-e2e', 'production-e2e'];
const VERIFY_SHARING_MOCK_PRODUCTION = [
  'verify',
  'sharing',
  'mock-e2e',
  'production-e2e',
];

const exact = (...paths) => ({ exact: paths });
const prefix = (...paths) => ({ prefix: paths });
const regex = (...patterns) => ({ regex: patterns });

export const IGNORED_RULES = [
  prefix('docs/'),
  prefix('graphify-out/'),
  regex(/(^|\/)README\.md$/i, /\.md$/i),
  exact(
    '.env.example',
    '.gitignore',
    '.github/dependabot.yml',
    'LICENSE',
    'LICENSE.md',
  ),
];

export const RELEVANCE_RULES = [
  {
    name: 'global-ci-and-build-config',
    domains: ALL,
    match: [
      exact(
        '.github/workflows/ci.yml',
        '.nvmrc',
        'package.json',
        'package-lock.json',
        'webpack.config.js',
        'playwright.config.ts',
        'tsconfig.json',
        'tsconfig.e2e.json',
      ),
      prefix('scripts/ci/'),
    ],
  },
  {
    name: 'other-workflows',
    domains: ALL,
    match: [prefix('.github/workflows/')],
  },
  {
    name: 'sharing-worker',
    domains: ['sharing'],
    match: [prefix('sharing-worker/')],
  },
  {
    name: 'telemetry-worker',
    domains: VERIFY,
    match: [prefix('telemetry-worker/')],
  },
  {
    name: 'sharing-owned-extension-code',
    domains: VERIFY_SHARING,
    match: [
      prefix('src/sharing/', 'src/background/sharing/'),
      exact(
        'src/shared/sharing.ts',
        'src/shared/sharingContract.ts',
        'src/background/messaging/sharingMessages.ts',
        'src/recordings/ShareDialog.ts',
        'src/recordings/SharedView.ts',
      ),
    ],
  },
  {
    name: 'shared-offscreen-entrypoint',
    domains: VERIFY_SHARING_MOCK_PRODUCTION,
    match: [exact('src/offscreen.ts')],
  },
  {
    name: 'shared-extension-boundaries',
    domains: VERIFY_SHARING_MOCK,
    match: [
      exact(
        'src/offscreen/rpcHandlers.ts',
        'src/background/messaging/messageHandlers.ts',
        'src/background/runtime/createBackgroundRuntime.ts',
        'src/recordings.ts',
        'src/recordings/RecordingsController.ts',
        'src/recordings/RecordingsView.ts',
        'src/shared/protocol.ts',
        'src/shared/protocolMessageTypes.ts',
        'src/shared/playback.ts',
        'src/offscreen/drive/request.ts',
        'static/recordings.html',
        'static/styles/recordings.css',
      ),
      prefix('src/shared/player/'),
    ],
  },
  {
    name: 'shared-e2e-harness',
    domains: VERIFY_SHARING_MOCK_PRODUCTION,
    match: [exact('tests/e2e/helpers/extensionHarness.ts')],
  },
  {
    name: 'sharing-e2e',
    domains: VERIFY_SHARING,
    match: [
      exact(
        'tests/e2e/sharing-lifecycle.spec.ts',
        'tests/e2e/helpers/sharingWorker.ts',
      ),
    ],
  },
  {
    name: 'sharing-core-e2e-helper',
    domains: VERIFY_SHARING_MOCK,
    match: [exact('tests/e2e/helpers/driveSimulator.ts')],
  },
  {
    name: 'shared-extension-packaging',
    domains: VERIFY_SHARING_MOCK_PRODUCTION,
    match: [exact('static/manifest.json', 'static/offscreen.html')],
  },
  {
    name: 'sharing-runtime-build-dependency',
    domains: VERIFY_SHARING_MOCK_PRODUCTION,
    match: [exact('src/shared/build.ts')],
  },
  {
    name: 'sharing-runtime-dependencies',
    domains: VERIFY_SHARING_MOCK,
    match: [
      prefix(
        'src/background/offscreen/',
        'src/platform/capabilities/auth/',
      ),
      exact(
        'src/offscreen/storage/opfsLayout.ts',
        'src/offscreen/storage/indexedDbKeyValueArea.ts',
        'src/platform/capabilities/AuthProvider.ts',
        'src/platform/chrome/identity.ts',
        'src/platform/chrome/offscreen.ts',
        'src/platform/chrome/runtime.ts',
        'src/shared/rpc.ts',
        'src/shared/async.ts',
        'src/shared/timeouts.ts',
      ),
    ],
  },
  {
    name: 'production-analysis-packaging',
    domains: VERIFY_MOCK_PRODUCTION,
    match: [
      prefix('src/offscreen/analysis/', 'src/shared/analysis/'),
      exact(
        'src/buildFlags.d.ts',
        'scripts/fetch-analysis-model.mjs',
        'scripts/lib/analysisModel.cjs',
        'tests/e2e/analysis-embedding.spec.ts',
      ),
    ],
  },
  {
    name: 'core-extension-directories',
    domains: VERIFY_MOCK,
    match: [
      prefix(
        'src/background/',
        'src/content/',
        'src/debug/',
        'src/offscreen/',
        'src/platform/',
        'src/popup/',
        'src/recordings/',
        'src/shared/',
        'src/ui/',
        'src/settings/',
      ),
    ],
  },
  {
    name: 'core-extension-entrypoints',
    domains: VERIFY_MOCK,
    match: [
      exact(
        'src/background.ts',
        'src/camsetup.ts',
        'src/debug.ts',
        'src/micsetup.ts',
        'src/popup.ts',
        'src/scrapingScript.ts',
        'src/scrapingScript.test.ts',
        'src/settings.ts',
        'src/settings.test.ts',
      ),
    ],
  },
  {
    name: 'core-e2e',
    domains: VERIFY_MOCK,
    match: [prefix('tests/e2e/')],
  },
  {
    name: 'unit-and-script-tests',
    domains: VERIFY,
    match: [
      prefix('tests/helpers/', 'tests/scripts/', 'tests/fixtures/', 'tests/spikes/'),
      regex(/^tests\/[^/]+\.test\.(ts|tsx|js|mjs|cjs)$/),
    ],
  },
  {
    name: 'root-scripts',
    domains: VERIFY,
    match: [prefix('scripts/')],
  },
  {
    name: 'static-extension-assets',
    domains: VERIFY_MOCK,
    match: [prefix('static/')],
  },
  {
    name: 'public-extension-assets',
    domains: ALL,
    match: [prefix('public/')],
  },
  {
    name: 'verify-config',
    domains: VERIFY,
    match: [
      exact(
        'jest.config.js',
        'playwright.real-meet.config.ts',
        'tests/setup.ts',
        'tsconfig.check.json',
        '.eslintrc',
        '.eslintrc.js',
        '.prettierrc',
        '.prettierrc.json',
      ),
    ],
  },
];

function matchesMatcher(path, matcher) {
  if (matcher.exact?.includes(path)) {
    return true;
  }
  if (matcher.prefix?.some((candidate) => path.startsWith(candidate))) {
    return true;
  }
  if (matcher.regex?.some((candidate) => candidate.test(path))) {
    return true;
  }
  return false;
}

function matchesAny(path, matchers) {
  return matchers.some((matcher) => matchesMatcher(path, matcher));
}

export function isIgnoredPath(path) {
  return matchesAny(path, IGNORED_RULES);
}

export function classifyPath(path) {
  if (isIgnoredPath(path)) {
    return { path, domains: [], rule: 'ignored', unknown: false };
  }

  for (const rule of RELEVANCE_RULES) {
    if (matchesAny(path, rule.match)) {
      return {
        path,
        domains: [...rule.domains],
        rule: rule.name,
        unknown: false,
      };
    }
  }

  return {
    path,
    domains: [...ALL],
    rule: 'unknown-path',
    unknown: true,
  };
}

export function classifyChangedFiles(paths) {
  const classifications = paths.map(classifyPath);
  const relevant = Object.fromEntries(DOMAIN_NAMES.map((domain) => [domain, false]));
  const unknownPaths = [];

  for (const classification of classifications) {
    if (classification.unknown) {
      unknownPaths.push(classification.path);
    }
    for (const domain of classification.domains) {
      relevant[domain] = true;
    }
  }

  return { relevant, unknownPaths, classifications };
}

export function fingerprintIncludesPath(domain, path) {
  if (!DOMAIN_NAMES.includes(domain)) {
    throw new Error(`Unknown validation domain: ${domain}`);
  }

  const classification = classifyPath(path);
  if (classification.unknown) {
    return true;
  }

  if (
    path === '.github/workflows/ci.yml' ||
    path.startsWith('scripts/ci/') ||
    path === 'package.json' ||
    path === 'package-lock.json' ||
    path === 'webpack.config.js' ||
    path === 'playwright.config.ts'
  ) {
    return true;
  }

  if (domain === 'verify') {
    return classification.domains.includes('verify');
  }

  if (domain === 'mock-e2e') {
    return classification.domains.includes('mock-e2e');
  }

  if (domain === 'sharing') {
    return (
      classification.domains.includes('sharing') ||
      path === 'sharing-worker/package.json' ||
      path === 'sharing-worker/package-lock.json'
    );
  }

  return classification.domains.includes('production-e2e');
}

export function computeDomainFingerprint(domain, entries) {
  const hash = createHash('sha256');
  hash.update(`validation-schema:${VALIDATION_SCHEMA}\n`);
  hash.update(`domain:${domain}\n`);

  const included = entries
    .filter(({ path }) => fingerprintIncludesPath(domain, path))
    .sort((a, b) => a.path.localeCompare(b.path));

  for (const { path, blob } of included) {
    hash.update(path);
    hash.update('\0');
    hash.update(blob);
    hash.update('\n');
  }

  return hash.digest('hex');
}

export function findUnknownOwnedPaths(paths) {
  return paths.filter((path) => classifyPath(path).unknown);
}
