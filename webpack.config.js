const fs = require('fs')
const path = require('path')
const webpack = require('webpack')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { CleanWebpackPlugin } = require('clean-webpack-plugin')
const pkg = require('./package.json')
const { toChromeManifestVersion } = require('./scripts/lib/manifestVersion.cjs')

const GOOGLE_OAUTH_CLIENT_ID_ENV_KEY = 'GOOGLE_OAUTH_CLIENT_ID'
const GOOGLE_WEB_OAUTH_CLIENT_ID_ENV_KEY = 'GOOGLE_WEB_OAUTH_CLIENT_ID'
const OAUTH_CLIENT_ID_PLACEHOLDER = '__GOOGLE_OAUTH_CLIENT_ID__'
const STATIC_DIR = 'static'
const PUBLIC_DIR = 'public'
// Cross-browser build targets (ADR-0002). Chrome uses chrome.identity.getAuthToken;
// every other Chromium target authenticates via launchWebAuthFlow.
const KNOWN_BROWSER_TARGETS = ['chrome', 'edge', 'brave', 'opera', 'vivaldi', 'arc']
const DEFAULT_BROWSER_TARGET = 'chrome'

function parseDotEnv(rawContent) {
  const parsed = {}
  for (const rawLine of rawContent.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const delimiterIndex = line.indexOf('=')
    if (delimiterIndex <= 0) continue

    const key = line.slice(0, delimiterIndex).trim()
    let value = line.slice(delimiterIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    parsed[key] = value
  }
  return parsed
}

function loadProjectDotEnv(projectRoot) {
  const envPath = path.resolve(projectRoot, '.env')
  if (!fs.existsSync(envPath)) return {}
  return parseDotEnv(fs.readFileSync(envPath, 'utf8'))
}

function resolveGoogleOauthClientId(projectRoot) {
  const fileEnv = loadProjectDotEnv(projectRoot)
  const value = process.env[GOOGLE_OAUTH_CLIENT_ID_ENV_KEY] || fileEnv[GOOGLE_OAUTH_CLIENT_ID_ENV_KEY] || ''
  return value.trim()
}

function resolveWebOauthClientId(projectRoot) {
  const fileEnv = loadProjectDotEnv(projectRoot)
  const value = process.env[GOOGLE_WEB_OAUTH_CLIENT_ID_ENV_KEY] || fileEnv[GOOGLE_WEB_OAUTH_CLIENT_ID_ENV_KEY] || ''
  return value.trim()
}

function resolveBrowserTarget(rawTarget) {
  if (rawTarget == null || rawTarget === '') return DEFAULT_BROWSER_TARGET
  const target = String(rawTarget).trim().toLowerCase()
  if (!KNOWN_BROWSER_TARGETS.includes(target)) {
    throw new Error(`Unknown build target "${target}". Known targets: ${KNOWN_BROWSER_TARGETS.join(', ')}`)
  }
  return target
}

function transformManifest(content, oauthClientId, isDevBuild, browserTarget) {
  const manifest = JSON.parse(content.toString('utf8'))
  if (browserTarget === 'chrome') {
    if (!manifest.oauth2 || typeof manifest.oauth2 !== 'object') {
      throw new Error('manifest.json is missing oauth2 configuration')
    }
    manifest.oauth2.client_id = oauthClientId
  } else {
    // Non-Chrome targets authenticate via launchWebAuthFlow (ADR-0002). The
    // Chrome-only getAuthToken `oauth2` block and the dev stable-id `key` are
    // unused there; drop them so each store package stays minimal.
    delete manifest.oauth2
    delete manifest.key
  }
  // package.json is the single source of truth for the release version; the
  // numeric Chrome `version` is derived here so the two can never drift, and the
  // full semver (incl. any pre-release tag) is preserved for display in
  // `version_name`. The value in static/manifest.json is an ignored placeholder.
  manifest.version = toChromeManifestVersion(pkg.version)
  manifest.version_name = isDevBuild ? `${pkg.version} (dev)` : pkg.version
  // Dev-only diagnostics: system-wide CPU sampling via chrome.system.cpu. Never
  // shipped to production so the store listing keeps a minimal permission set
  // and avoids a permission re-review prompt for users.
  if (isDevBuild && Array.isArray(manifest.permissions) && !manifest.permissions.includes('system.cpu')) {
    manifest.permissions.push('system.cpu')
  }
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

function isTruthyEnvFlag(value) {
  return value === true || value === 'true' || value === '1'
}

module.exports = (_env, argv) => {
  const env = _env || {}
  const mode = argv.mode || 'production'
  const isDevBuild = mode === 'development'
  const e2eMockCapture = isTruthyEnvFlag(env.e2eMockCapture) || process.env.E2E_MOCK_CAPTURE === '1'
  const e2eMockDrive = isTruthyEnvFlag(env.e2eMockDrive) || process.env.E2E_MOCK_DRIVE === '1'
  const e2eRealCaptureTab = isTruthyEnvFlag(env.e2eRealCaptureTab)
    || process.env.E2E_REAL_CAPTURE_TAB === '1'
  const browserTarget = resolveBrowserTarget(env.target)
  const outputDir = typeof env.outputPath === 'string' && env.outputPath.trim()
    ? env.outputPath.trim()
    : (browserTarget === DEFAULT_BROWSER_TARGET ? 'dist' : `dist-${browserTarget}`)
  const configuredGoogleOauthClientId = resolveGoogleOauthClientId(__dirname)
  const googleOauthClientId = configuredGoogleOauthClientId || OAUTH_CLIENT_ID_PLACEHOLDER
  const webOauthClientId = resolveWebOauthClientId(__dirname)

  if (browserTarget === 'chrome' && !configuredGoogleOauthClientId) {
    console.warn(
      `[build] ${GOOGLE_OAUTH_CLIENT_ID_ENV_KEY} is not set; keeping placeholder in dist/manifest.json. Drive OAuth will fail until you configure it.`
    )
  }
  if (browserTarget !== 'chrome' && !webOauthClientId) {
    console.warn(
      `[build] ${GOOGLE_WEB_OAUTH_CLIENT_ID_ENV_KEY} is not set for target "${browserTarget}"; Drive OAuth via launchWebAuthFlow will fail until you configure it.`
    )
  }

  return {
    mode,
    devtool: isDevBuild ? 'source-map' : false,
    entry: {
      scrapingScript: './src/scrapingScript.ts',
      popup: './src/popup.ts',
      debug: './src/debug.ts',
      background: './src/background.ts',
      offscreen: './src/offscreen.ts',
      opfsWorker: './src/offscreen/storage/opfsWorker.ts',
      micsetup: './src/micsetup.ts',
      camsetup: './src/camsetup.ts',
      settings: './src/settings.ts',
    },
    output: {
      path: path.resolve(__dirname, outputDir),
      filename: '[name].js'
    },
    resolve: { extensions: ['.ts', '.js'] },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/
        }
      ]
    },
    plugins: [
      new CleanWebpackPlugin(),
      new webpack.DefinePlugin({
        '__E2E_MOCK_CAPTURE_BUILD__': JSON.stringify(e2eMockCapture),
        '__E2E_MOCK_DRIVE_BUILD__': JSON.stringify(e2eMockDrive),
        '__E2E_REAL_CAPTURE_TAB_BUILD__': JSON.stringify(e2eRealCaptureTab),
        'globalThis.__DEV_BUILD__': JSON.stringify(isDevBuild),
        'globalThis.__E2E_MOCK_CAPTURE__': JSON.stringify(e2eMockCapture),
        'globalThis.__E2E_MOCK_DRIVE__': JSON.stringify(e2eMockDrive),
        'globalThis.__E2E_REAL_CAPTURE_TAB__': JSON.stringify(e2eRealCaptureTab),
        '__BROWSER_TARGET__': JSON.stringify(browserTarget),
        '__WEB_OAUTH_CLIENT_ID__': JSON.stringify(webOauthClientId),
        'process.env.NODE_ENV': JSON.stringify(mode),
      }),
      // Stamp the per-compilation content hash into every entry bundle as
      // globalThis.__BUILD_ID__. It changes iff the built code changes (so it is
      // reproducible and updates on every --watch rebuild), and is identical
      // across bundles within one build so the SW↔offscreen handshake matches.
      new webpack.BannerPlugin({
        raw: true,
        entryOnly: true,
        banner: 'globalThis.__BUILD_ID__="[fullhash]";',
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: path.join(STATIC_DIR, 'manifest.json'),
            to: 'manifest.json',
            transform: (content) => transformManifest(content, googleOauthClientId, isDevBuild, browserTarget),
          },
          { from: path.join(STATIC_DIR, 'popup.html'),     to: 'popup.html' },
          { from: path.join(STATIC_DIR, 'debug.html'),     to: 'debug.html' },
          { from: path.join(STATIC_DIR, 'offscreen.html'), to: 'offscreen.html', noErrorOnMissing: true },
          { from: path.join(STATIC_DIR, 'micsetup.html'), to: 'micsetup.html' },
          { from: path.join(STATIC_DIR, 'camsetup.html'), to: 'camsetup.html' },
          { from: path.join(STATIC_DIR, 'settings.html'), to: 'settings.html' },
          { from: PUBLIC_DIR, to: '.', noErrorOnMissing: true },
        ]
      })
    ]
  }
}
