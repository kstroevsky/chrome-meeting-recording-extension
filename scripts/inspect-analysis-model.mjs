/**
 * Prints the real packaged E5 graph boundary used by ADR-0009 TECH-02/07.
 *
 * This is deliberately a local-artifact inspection: remote resolution is
 * disabled and the same pinned cache verified by fetch-analysis-model.mjs is
 * used. Node's Transformers.js backend calls its host CPU device `cpu`; output
 * names/shapes are properties of the packaged graph, independent of that host
 * execution-provider spelling.
 *
 *   npm run analysis:model:inspect
 */

import { env, pipeline } from '@huggingface/transformers';
import { ANALYSIS_MODEL, modelCacheDir, selectedDtype } from './fetch-analysis-model.mjs';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = `${modelCacheDir()}/../`;

const extractor = await pipeline('feature-extraction', ANALYSIS_MODEL.revision, {
  device: 'cpu',
  dtype: selectedDtype(),
});

try {
  const modelInputs = extractor.tokenizer(['query: alpha beta', 'query: gamma'], {
    padding: true,
    truncation: true,
  });
  const outputs = await extractor.model(modelInputs);
  const describe = (tensor) => ({
    type: tensor.type,
    dims: tensor.dims,
    bytes: tensor.data?.byteLength ?? null,
  });

  console.log(JSON.stringify({
    model: `${ANALYSIS_MODEL.id}@${ANALYSIS_MODEL.revision}`,
    dtype: selectedDtype(),
    inputs: Object.fromEntries(Object.entries(modelInputs).map(([name, tensor]) => [name, describe(tensor)])),
    outputs: Object.fromEntries(Object.entries(outputs).map(([name, tensor]) => [name, describe(tensor)])),
  }, null, 2));
} finally {
  await extractor.dispose?.();
}
