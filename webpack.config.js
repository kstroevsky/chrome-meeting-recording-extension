const path = require('path')
const webpack = require('webpack')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { CleanWebpackPlugin } = require('clean-webpack-plugin')

module.exports = (_env, argv) => {
  const mode = argv.mode || 'production'
  const isDevBuild = mode === 'development'

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
          { from: 'manifest.json',  to: 'manifest.json' },
          { from: 'popup.html',     to: 'popup.html' },
          { from: 'debug.html',     to: 'debug.html' },
          { from: 'offscreen.html', to: 'offscreen.html', noErrorOnMissing: true },
          { from: 'micsetup.html', to: 'micsetup.html' },
          { from: 'camsetup.html', to: 'camsetup.html' },
        ]
      })
    ]
  }
}
