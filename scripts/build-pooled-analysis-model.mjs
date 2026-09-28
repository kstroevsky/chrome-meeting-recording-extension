/**
 * ADR-0009 TECH-03 research helper.
 *
 * Rewrites the selected packaged embedding graph so mean pooling and L2
 * normalization happen inside ONNX. The experimental graph keeps BertModel's
 * canonical `last_hidden_state` output name, but changes its shape from
 * [batch, tokens, width] to [batch, width]. That lets the existing
 * Transformers.js model loader open the graph while the worker can fence the
 * experiment by output rank.
 *
 * This does not replace the pinned source artifact. It writes a sibling
 * `*_pooled.onnx` file in the verified model cache. Build with
 * `ANALYSIS_POOLING=pooled-onnx` to package that sibling under the ordinary
 * runtime filename.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ANALYSIS_MODEL, modelCacheDir } = require('./lib/analysisModel.cjs');

// Reuse the ONNX schema already shipped by the pinned Transformers.js runtime.
// Keeping graph rewriting on that dependency avoids a second protobuf runtime
// and, more importantly, avoids onnx-proto's obsolete protobufjs 6.x tree.
const ortEntry = require.resolve('onnxruntime-web');
const ortSchemaPath = path.resolve(
  path.dirname(ortEntry),
  '../lib/onnxjs/ort-schema/protobuf/onnx.js',
);
if (!fs.existsSync(ortSchemaPath)) {
  throw new Error(`ONNX Runtime protobuf schema is missing at ${ortSchemaPath}`);
}
const { onnx } = require(ortSchemaPath);
if (!onnx?.ModelProto || !onnx?.NodeProto || !onnx?.ValueInfoProto) {
  throw new Error('ONNX Runtime protobuf schema does not expose the expected graph types');
}

const sourcePath = path.join(modelCacheDir(), ANALYSIS_MODEL.onnxPath);
const pooledRelativePath = ANALYSIS_MODEL.onnxPath.replace(/\.onnx$/, '_pooled.onnx');
const destinationPath = path.join(modelCacheDir(), pooledRelativePath);

const model = onnx.ModelProto.decode(fs.readFileSync(sourcePath));
const graph = model.graph;
if (!graph) throw new Error('Embedding ONNX graph is missing');

const defaultOpset = model.opsetImport.find((entry) => !entry.domain);
const defaultOpsetVersion = Number(defaultOpset?.version ?? 0);
if (defaultOpsetVersion !== 11) {
  throw new Error(`Expected the pinned embedding graph to use ONNX opset 11, got ${defaultOpsetVersion || 'none'}`);
}
if (!graph.input.some((input) => input.name === 'attention_mask')) {
  throw new Error('Embedding ONNX graph does not expose the attention_mask input required for pooling');
}

const sourceOutput = graph.output.find((output) => output.name === 'last_hidden_state');
const sourceDims = sourceOutput?.type?.tensorType?.shape?.dim ?? [];
const width = Number(sourceDims.at(-1)?.dimValue ?? 0);
if (sourceDims.length !== 3 || !Number.isSafeInteger(width) || width < 1) {
  throw new Error('Expected last_hidden_state to have [batch, tokens, width] shape');
}

let renamedProducer = false;
for (const node of graph.node) {
  node.output = node.output.map((name) => {
    if (name !== 'last_hidden_state') return name;
    renamedProducer = true;
    return 'token_hidden_state';
  });
  node.input = node.input.map((name) => name === 'last_hidden_state' ? 'token_hidden_state' : name);
}
if (!renamedProducer) throw new Error('Could not find the last_hidden_state producer');
for (const value of graph.valueInfo) {
  if (value.name === 'last_hidden_state') value.name = 'token_hidden_state';
}

const { AttributeType } = onnx.AttributeProto;
const attrInt = (name, value) => onnx.AttributeProto.fromObject({
  name,
  type: AttributeType.INT,
  i: value,
});
const attrInts = (name, values) => onnx.AttributeProto.fromObject({
  name,
  type: AttributeType.INTS,
  ints: values,
});
const node = (opType, input, output, name, attribute = []) => onnx.NodeProto.fromObject({
  opType,
  input,
  output,
  name,
  attribute,
});

graph.node.push(
  node('Cast', ['attention_mask'], ['pool_mask_f32'], 'PoolMaskCast', [
    attrInt('to', onnx.TensorProto.DataType.FLOAT),
  ]),
  node('Unsqueeze', ['pool_mask_f32'], ['pool_mask_3d'], 'PoolMaskUnsqueeze', [
    attrInts('axes', [2]),
  ]),
  node('Mul', ['token_hidden_state', 'pool_mask_3d'], ['pool_masked'], 'PoolMaskHidden'),
  node('ReduceSum', ['pool_masked'], ['pool_sum'], 'PoolHiddenSum', [
    attrInts('axes', [1]),
    attrInt('keepdims', 0),
  ]),
  node('ReduceSum', ['pool_mask_f32'], ['pool_count'], 'PoolTokenCount', [
    attrInts('axes', [1]),
    attrInt('keepdims', 1),
  ]),
  node('Div', ['pool_sum', 'pool_count'], ['pool_mean'], 'PoolMean'),
  node('Mul', ['pool_mean', 'pool_mean'], ['pool_squared'], 'PoolSquare'),
  node('ReduceSum', ['pool_squared'], ['pool_norm_sq'], 'PoolNormSquared', [
    attrInts('axes', [1]),
    attrInt('keepdims', 1),
  ]),
  node('Sqrt', ['pool_norm_sq'], ['pool_norm'], 'PoolNorm'),
  node('Div', ['pool_mean', 'pool_norm'], ['last_hidden_state'], 'PoolNormalize'),
);

graph.output = [onnx.ValueInfoProto.fromObject({
  name: 'last_hidden_state',
  type: {
    tensorType: {
      elemType: onnx.TensorProto.DataType.FLOAT,
      shape: { dim: [{ dimParam: 'batch_size' }, { dimValue: width }] },
    },
  },
})];

const encoded = onnx.ModelProto.encode(model).finish();
fs.writeFileSync(destinationPath, encoded);
console.log(`[analysis:model:pool] ${pooledRelativePath} (${encoded.byteLength} bytes, ${width}d)`);
