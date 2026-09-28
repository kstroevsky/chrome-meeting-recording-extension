import { Tensor } from '@huggingface/transformers';

/**
 * Owned mean-pooling kernel for ADR-0009 TECH-01 experiments.
 *
 * Transformers.js currently walks embedding dimensions outside tokens, which
 * rereads and converts the same attention-mask value once per dimension. This
 * keeps each dimension's token accumulation order identical while moving the
 * token loop outside dimensions, so each mask value is converted once and the
 * hidden-state reads are contiguous.
 *
 * The equivalence domain is the production one: finite float32 hidden states,
 * a binary attention mask, and at least one valid token in every row. Invalid
 * rows are rejected rather than converted into NaN vectors.
 */
export function meanPoolingLocality(
  lastHiddenState: Tensor,
  attentionMask: Tensor,
): Tensor {
  const [batchSize, seqLength, embedDim] = lastHiddenState.dims;
  if (lastHiddenState.type !== 'float32'
    || lastHiddenState.dims.length !== 3
    || !positiveInteger(batchSize)
    || !positiveInteger(seqLength)
    || !positiveInteger(embedDim)) {
    throw new Error('Mean pooling requires a finite float32 [batch, sequence, dimensions] tensor');
  }
  if (attentionMask.dims.length !== 2
    || attentionMask.dims[0] !== batchSize
    || attentionMask.dims[1] !== seqLength) {
    throw new Error('Mean pooling attention mask does not match the hidden-state batch and sequence');
  }

  const hidden = lastHiddenState.data as Float32Array;
  const mask = attentionMask.data;
  const pooled = new Float32Array(batchSize * embedDim);
  const sums = new Float64Array(embedDim);

  for (let batch = 0; batch < batchSize; batch += 1) {
    sums.fill(0);
    let count = 0;
    const hiddenOffset = batch * seqLength * embedDim;
    const maskOffset = batch * seqLength;

    for (let token = 0; token < seqLength; token += 1) {
      const weight = Number(mask[maskOffset + token]);
      if (weight !== 0 && weight !== 1) {
        throw new Error(`Mean pooling requires a binary attention mask, got ${weight}`);
      }
      count += weight;
      if (!weight) continue;

      const tokenOffset = hiddenOffset + token * embedDim;
      for (let dimension = 0; dimension < embedDim; dimension += 1) {
        const value = hidden[tokenOffset + dimension];
        if (!Number.isFinite(value)) throw new Error('Mean pooling received a non-finite hidden state');
        // Each dimension observes tokens in the same ascending order as the
        // installed Transformers.js mean_pooling implementation.
        sums[dimension] += value;
      }
    }
    if (!count) throw new Error(`Mean pooling row ${batch} contains no valid tokens`);

    const outputOffset = batch * embedDim;
    for (let dimension = 0; dimension < embedDim; dimension += 1) {
      pooled[outputOffset + dimension] = sums[dimension] / count;
    }
  }

  return new Tensor('float32', pooled, [batchSize, embedDim]);
}

function positiveInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}
