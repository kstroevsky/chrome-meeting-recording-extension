const fs = require('fs')
const path = require('path')
const webpack = require('webpack')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { CleanWebpackPlugin } = require('clean-webpack-plugin')

const GOOGLE_OAUTH_CLIENT_ID_ENV_KEY = 'GOOGLE_OAUTH_CLIENT_ID'
const OAUTH_CLIENT_ID_PLACEHOLDER = '__GOOGLE_OAUTH_CLIENT_ID__'
const STATIC_DIR = 'static'

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

function transformManifest(content, oauthClientId) {
  const manifest = JSON.parse(content.toString('utf8'))
  if (!manifest.oauth2 || typeof manifest.oauth2 !== 'object') {
    throw new Error('manifest.json is missing oauth2 configuration')
  }
  manifest.oauth2.client_id = oauthClientId
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
}

module.exports = (_env, argv) => {
  const mode = argv.mode || 'production'
  const isDevBuild = mode === 'development'
  const configuredGoogleOauthClientId = resolveGoogleOauthClientId(__dirname)
  const googleOauthClientId = configuredGoogleOauthClientId || OAUTH_CLIENT_ID_PLACEHOLDER

  if (!configuredGoogleOauthClientId) {
    console.warn(
      `[build] ${GOOGLE_OAUTH_CLIENT_ID_ENV_KEY} is not set; keeping placeholder in dist/manifest.json. Drive OAuth will fail until you configure it.`
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
      micsetup: './src/micsetup.ts',
      camsetup: './src/camsetup.ts',
      settings: './src/settings.ts',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
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
        'globalThis.__DEV_BUILD__': JSON.stringify(isDevBuild),
        'process.env.NODE_ENV': JSON.stringify(mode),
      }),
      new CopyWebpackPlugin({
        patterns: [
          {
            from: path.join(STATIC_DIR, 'manifest.json'),
            to: 'manifest.json',
            transform: (content) => transformManifest(content, googleOauthClientId),
          },
          { from: path.join(STATIC_DIR, 'popup.html'),     to: 'popup.html' },
          { from: path.join(STATIC_DIR, 'debug.html'),     to: 'debug.html' },
          { from: path.join(STATIC_DIR, 'offscreen.html'), to: 'offscreen.html', noErrorOnMissing: true },
          { from: path.join(STATIC_DIR, 'micsetup.html'), to: 'micsetup.html' },
          { from: path.join(STATIC_DIR, 'camsetup.html'), to: 'camsetup.html' },
          { from: path.join(STATIC_DIR, 'settings.html'), to: 'settings.html' },
        ]
      })
    ]
  }
}
