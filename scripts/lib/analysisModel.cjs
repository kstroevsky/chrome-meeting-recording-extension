/**
 * CommonJS view of the packaged-model manifest, for `webpack.config.js`.
 *
 * The manifest itself lives in `scripts/fetch-analysis-model.mjs`, which is ESM
 * because it is a standalone build step. Rather than duplicate the pins — two
 * copies of a SHA-256 is a bug waiting to happen — this reads them out of that
 * file's source, and fails loudly if its shape ever changes.
 */

const fs = require('fs')
const path = require('path')

const SOURCE = path.join(__dirname, '..', 'fetch-analysis-model.mjs')

function readManifest() {
  const source = fs.readFileSync(SOURCE, 'utf8')
  const field = (name) => {
    const match = source.match(new RegExp(`${name}:\\s*'([^']+)'`))
    if (!match) throw new Error(`analysisModel: could not read \`${name}\` from ${SOURCE}`)
    return match[1]
  }

  const dtype = process.env.ANALYSIS_DTYPE || 'q8'
  // The ONNX filename for this dtype, read from the same manifest so the build
  // and the fetcher can never disagree about which export was verified.
  const entry = source.match(new RegExp(`\\b${dtype}:\\s*\\{\\s*path:\\s*'([^']+)'`))
  if (!entry) throw new Error(`analysisModel: no ONNX export pinned for ANALYSIS_DTYPE '${dtype}'`)

  return { id: field('id'), revision: field('revision'), dtype, onnxPath: entry[1] }
}

const ANALYSIS_MODEL = readManifest()

function modelCacheDir() {
  const dir = path.join(__dirname, '..', '..', '.cache', 'analysis-model', ANALYSIS_MODEL.revision)
  if (!fs.existsSync(dir)) {
    throw new Error(
      `The packaged embedding model is missing from ${dir}.\n`
      + 'Run `node scripts/fetch-analysis-model.mjs` before building (ADR-0007).'
    )
  }
  return dir
}

module.exports = { ANALYSIS_MODEL, modelCacheDir }
