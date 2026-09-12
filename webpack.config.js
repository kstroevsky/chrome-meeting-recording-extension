const fs = require('fs')
const path = require('path')
const webpack = require('webpack')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { CleanWebpackPlugin } = require('clean-webpack-plugin')
const pkg = require('./package.json')
const { toChromeManifestVersion } = require('./scripts/lib/manifestVersion.cjs')
const {
  TARGET_PROFILES,
  DEFAULT_TARGET,
  getTargetProfile,
  usesWebAuthFlow,
  applyTargetToManifest,
} = require('./scripts/lib/manifestTargets.cjs')
const { telemetryHostPermission } = require('./scripts/lib/telemetryEndpoint.cjs')
const { ANALYSIS_MODEL, modelCacheDir } = require('./scripts/lib/analysisModel.cjs')

const GOOGLE_OAUTH_CLIENT_ID_ENV_KEY = 'GOOGLE_OAUTH_CLIENT_ID'
const GOOGLE_WEB_OAUTH_CLIENT_ID_ENV_KEY = 'GOOGLE_WEB_OAUTH_CLIENT_ID'
const GOOGLE_WEB_OAUTH_CLIENT_SECRET_ENV_KEY = 'GOOGLE_WEB_OAUTH_CLIENT_SECRET'
const TELEMETRY_ENDPOINT_ENV_KEY = 'TELEMETRY_ENDPOINT'
const OAUTH_CLIENT_ID_PLACEHOLDER = '__GOOGLE_OAUTH_CLIENT_ID__'
const STATIC_DIR = 'static'
const PUBLIC_DIR = 'public'
// Cross-browser build targets (ADR-0002), modeled as data in manifestTargets.cjs.
// Chrome uses chrome.identity.getAuthToken; every other Chromium target
// authenticates via launchWebAuthFlow but keeps a stable `key` for its redirect.
const KNOWN_BROWSER_TARGETS = Object.keys(TARGET_PROFILES)
const DEFAULT_BROWSER_TARGET = DEFAULT_TARGET

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

function resolveWebOauthClientSecret(projectRoot) {
  const fileEnv = loadProjectDotEnv(projectRoot)
  const value = process.env[GOOGLE_WEB_OAUTH_CLIENT_SECRET_ENV_KEY] || fileEnv[GOOGLE_WEB_OAUTH_CLIENT_SECRET_ENV_KEY] || ''
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

function transformManifest(content, oauthClientId, isDevBuild, browserTarget, telemetryEndpoint) {
  const manifest = JSON.parse(content.toString('utf8'))
  // Per-target manifest decisions (oauth2 / key) live in the tested profile model
  // (scripts/lib/manifestTargets.cjs), keyed off browser family + auth capability.
  applyTargetToManifest(manifest, browserTarget, { oauthClientId })
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
  const telemetryPermission = telemetryHostPermission(telemetryEndpoint)
  if (telemetryPermission && !manifest.host_permissions.includes(telemetryPermission)) {
    manifest.host_permissions.push(telemetryPermission)
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
  const targetProfile = getTargetProfile(browserTarget)
  const isWebAuthFlowTarget = usesWebAuthFlow(browserTarget)
  const configuredGoogleOauthClientId = resolveGoogleOauthClientId(__dirname)
  const googleOauthClientId = configuredGoogleOauthClientId || OAUTH_CLIENT_ID_PLACEHOLDER
  // The web OAuth client id/secret are only used by the launchWebAuthFlow path;
  // they are left empty for chrome-identity targets so the secret never embeds
  // in a Chrome bundle that uses getAuthToken.
  const webOauthClientId = isWebAuthFlowTarget ? resolveWebOauthClientId(__dirname) : ''
  const webOauthClientSecret = isWebAuthFlowTarget ? resolveWebOauthClientSecret(__dirname) : ''
  const fileEnv = loadProjectDotEnv(__dirname)
  const telemetryEndpoint = String(process.env[TELEMETRY_ENDPOINT_ENV_KEY] || fileEnv[TELEMETRY_ENDPOINT_ENV_KEY] || '').trim()
  if (!isDevBuild && !telemetryEndpoint) {
    throw new Error(`${TELEMETRY_ENDPOINT_ENV_KEY} is required for production builds`)
  }
  telemetryHostPermission(telemetryEndpoint)

  if (targetProfile.auth === 'chrome-identity' && !configuredGoogleOauthClientId) {
    console.warn(
      `[build] ${GOOGLE_OAUTH_CLIENT_ID_ENV_KEY} is not set; keeping placeholder in dist/manifest.json. Drive OAuth will fail until you configure it.`
    )
  }
  if (isWebAuthFlowTarget && !webOauthClientId) {
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
      ...(isDevBuild ? { popupGallery: './src/popup/gallery/popupGallery.ts' } : {}),
      debug: './src/debug.ts',
      background: './src/background.ts',
      offscreen: './src/offscreen.ts',
      opfsWorker: './src/offscreen/storage/opfsWorker.ts',
      // A worker has no `document`, so it cannot use webpack's default
      // JSONP chunk loading. @huggingface/transformers splits its ONNX backends
      // into async chunks, so this entry needs the worker-native loader.
      analysisWorker: {
        import: './src/offscreen/analysis/analysisWorker.ts',
        chunkLoading: 'import-scripts',
      },
      micsetup: './src/micsetup.ts',
      camsetup: './src/camsetup.ts',
      settings: './src/settings.ts',
      recordings: './src/recordings.ts',
    },
    output: {
      path: path.resolve(__dirname, outputDir),
      filename: '[name].js',
      // Explicit, because the default ('auto') derives the path from
      // `document.currentScript` — which does not exist in a worker and throws
      // at module scope. In an extension, '/' is the package root, where every
      // bundle and chunk already lives.
      publicPath: '/',
    },
    // `.mjs` for @huggingface/transformers, which ships ESM under that extension.
    resolve: { extensions: ['.ts', '.js', '.mjs'] },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: 'ts-loader',
          exclude: /node_modules/
        },
        {
          // ONNX Runtime reaches for its own `.wasm` through `import.meta.url`.
          // The worker points ORT at the packaged copies in `ort/` instead
          // (`wasmPaths`), so letting webpack emit a second, hashed copy would
          // ship 22.5 MB nobody loads.
          test: /\.wasm$/,
          type: 'asset/resource',
          generator: { emit: false },
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
        '__POPUP_GALLERY_BUILD__': JSON.stringify(isDevBuild),
        '__BROWSER_TARGET__': JSON.stringify(browserTarget),
        '__WEB_OAUTH_CLIENT_ID__': JSON.stringify(webOauthClientId),
        '__WEB_OAUTH_CLIENT_SECRET__': JSON.stringify(webOauthClientSecret),
        '__TELEMETRY_ENDPOINT__': JSON.stringify(telemetryEndpoint),
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
            transform: (content) => transformManifest(content, googleOauthClientId, isDevBuild, browserTarget, telemetryEndpoint),
          },
          { from: path.join(STATIC_DIR, 'popup.html'),     to: 'popup.html' },
          ...(isDevBuild ? [{ from: path.join(STATIC_DIR, 'popup-gallery.html'), to: 'popup-gallery.html' }] : []),
          { from: path.join(STATIC_DIR, 'styles'),         to: 'styles' },
          { from: path.join(STATIC_DIR, 'fonts'),          to: 'fonts' },
          { from: path.join(STATIC_DIR, 'debug.html'),     to: 'debug.html' },
          { from: path.join(STATIC_DIR, 'offscreen.html'), to: 'offscreen.html', noErrorOnMissing: true },
          { from: path.join(STATIC_DIR, 'micsetup.html'), to: 'micsetup.html' },
          { from: path.join(STATIC_DIR, 'camsetup.html'), to: 'camsetup.html' },
          { from: path.join(STATIC_DIR, 'settings.html'), to: 'settings.html' },
          { from: path.join(STATIC_DIR, 'recordings.html'), to: 'recordings.html' },
          // Finder metadata is ignored by git but can still exist locally; never
          // ship it inside the extension package.
          { from: PUBLIC_DIR, to: '.', noErrorOnMissing: true, globOptions: { ignore: ['**/.DS_Store', '**/._*'] } },
          // ADR-0007: the embedding model is extension-owned. Materialized and
          // SHA-256 verified by `scripts/fetch-analysis-model.mjs` before the
          // build; analysis never reaches the network.
          // Exactly one ONNX export ships. The cache may hold several — 4A
          // measures Q8 and FP16 as separate builds — so everything under
          // `onnx/` except the selected one is filtered out here.
          {
            from: modelCacheDir(),
            to: `models/${ANALYSIS_MODEL.id}`,
            filter: (resourcePath) => {
              const relative = path.relative(modelCacheDir(), resourcePath).split(path.sep).join('/')
              return !relative.startsWith('onnx/') || relative === ANALYSIS_MODEL.onnxPath
            },
          },
          // ONNX Runtime's WASM binaries, copied from the version
          // @huggingface/transformers resolved. Not an independent dependency:
          // two ORT versions would be worse than a path that breaks loudly.
          //
          // Which variants ORT selects is its own decision, made from the
          // features it detects — an earlier attempt inferred the set from the
          // file names, packaged only `jsep` and the plain build, and failed at
          // runtime asking for `asyncify`. `ORT_VARIANTS` exists so the set can
          // be narrowed by measurement against a working build instead.
          {
            from: path.join(__dirname, 'node_modules', 'onnxruntime-web', 'dist'),
            to: 'ort',
            globOptions: { ignore: ['**/*.map'] },
            filter: (resourcePath) => {
              if (!/\.(wasm|mjs)$/.test(resourcePath)) return false
              const allow = process.env.ORT_VARIANTS
              if (!allow) return true
              const name = path.basename(resourcePath)
              return allow.split(',').some((v) => name === `ort-wasm-simd-threaded.${v}`.replace(/\.$/, '')
                || name.startsWith(`ort-wasm-simd-threaded.${v}.`)
                || (v === 'base' && /^ort-wasm-simd-threaded\.(wasm|mjs)$/.test(name)))
            },
          },
        ]
      })
    ]
  }
}
