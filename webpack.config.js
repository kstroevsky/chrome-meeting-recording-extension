const path = require('path')
const CopyWebpackPlugin = require('copy-webpack-plugin')
const { CleanWebpackPlugin } = require('clean-webpack-plugin')

module.exports = {
  mode: 'production',
  devtool: false,
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
