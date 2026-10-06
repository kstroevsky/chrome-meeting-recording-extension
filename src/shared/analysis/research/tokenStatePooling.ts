import type { Embedding } from '../types';

export type TokenStatePrefix = {
  tokenCount: number;
  dimensions: number;
  prefixSums: Float64Array;
  prefixCounts: Uint16Array;
};

export type TokenSpanPoolOptions = {
  normalize?: boolean;
};

/**
 * Bounded prefix statistics for ADR-0009 TECH-07.
 *
 * `attentionMask` says which padded positions exist. `specialTokenMask` is
 * separate on purpose: the shipping E5 path currently mean-pools attended
 * special tokens, while the token-span experiment needs an explicit way to
 * exclude them. A value of 1 in `specialTokenMask` excludes that token.
 */
export function buildTokenStatePrefix(
  hiddenStates: Float32Array,
  tokenCount: number,
  dimensions: number,
  attentionMask: readonly number[],
  specialTokenMask: readonly number[] | undefined,
  maxTokens: number,
): TokenStatePrefix {
  if (!Number.isSafeInteger(tokenCount) || tokenCount < 1 || tokenCount > maxTokens) {
    throw new Error(`Token-state block must contain 1..${maxTokens} tokens, got ${tokenCount}`);
  }
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Error(`Token-state dimensions must be positive, got ${dimensions}`);
  }
  if (hiddenStates.length !== tokenCount * dimensions) {
    throw new Error('Token-state data does not match tokenCount × dimensions');
  }
  if (attentionMask.length !== tokenCount) {
    throw new Error('Token-state attention mask does not match token count');
  }
  if (specialTokenMask && specialTokenMask.length !== tokenCount) {
    throw new Error('Token-state special-token mask does not match token count');
  }

  const prefixSums = new Float64Array((tokenCount + 1) * dimensions);
  const prefixCounts = new Uint16Array(tokenCount + 1);

  for (let token = 0; token < tokenCount; token += 1) {
    const attended = binary(attentionMask[token], 'attention');
    const special = specialTokenMask ? binary(specialTokenMask[token], 'special-token') : 0;
    const include = attended && !special ? 1 : 0;
    prefixCounts[token + 1] = prefixCounts[token] + include;

    const previous = token * dimensions;
    const next = (token + 1) * dimensions;
    const source = token * dimensions;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const value = hiddenStates[source + dimension];
      if (!Number.isFinite(value)) throw new Error('Token-state pooling received a non-finite hidden state');
      prefixSums[next + dimension] = prefixSums[previous + dimension] + (include ? value : 0);
    }
  }

  return { tokenCount, dimensions, prefixSums, prefixCounts };
}

/** Pools an attended token interval [startToken, endToken) in O(dimensions). */
export function poolTokenStateSpan(
  prefix: TokenStatePrefix,
  startToken: number,
  endToken: number,
  options: TokenSpanPoolOptions = {},
): { vector: Embedding; includedTokens: number } {
  if (!Number.isSafeInteger(startToken) || !Number.isSafeInteger(endToken)
    || startToken < 0 || endToken > prefix.tokenCount || endToken <= startToken) {
    throw new Error(`Invalid token-state span [${startToken}, ${endToken}) for ${prefix.tokenCount} tokens`);
  }
  const includedTokens = prefix.prefixCounts[endToken] - prefix.prefixCounts[startToken];
  if (!includedTokens) throw new Error('Token-state span contains no eligible tokens');

  const vector = new Float32Array(prefix.dimensions);
  const startOffset = startToken * prefix.dimensions;
  const endOffset = endToken * prefix.dimensions;
  let square = 0;
  for (let dimension = 0; dimension < prefix.dimensions; dimension += 1) {
    const mean = (
      prefix.prefixSums[endOffset + dimension]
      - prefix.prefixSums[startOffset + dimension]
    ) / includedTokens;
    vector[dimension] = mean;
    square += mean * mean;
  }

  if (options.normalize) {
    const norm = Math.sqrt(square);
    if (!norm || !Number.isFinite(norm)) throw new Error('Token-state span produced a zero or non-finite vector');
    for (let dimension = 0; dimension < vector.length; dimension += 1) {
      vector[dimension] = vector[dimension] / norm;
    }
  }

  return { vector, includedTokens };
}

function binary(value: number, name: string): 0 | 1 {
  if (value === 0 || value === 1) return value;
  throw new Error(`Token-state ${name} mask must be binary, got ${value}`);
}
