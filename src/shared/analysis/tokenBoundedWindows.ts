/**
 * Token-safe contextual windows derived from canonical transcript segments.
 *
 * The caller supplies the packaged tokenizer's exact length function. This
 * module owns only lossless source mapping and re-windowing, so it can be tested
 * without a model and used by the real worker without a second tokenizer.
 */

import type { TranscriptSegment } from '../transcript';
import type { AnalysisEmbeddingChunk, AnalysisSourceSpan, ContextWindow } from './types';
import {
  buildContextWindows,
  contextWindowFromSourceSpans,
  type WindowConfig,
} from './windows';

export type TokenLength = (text: string) => number;

export function buildTokenBoundedContextWindows(
  segments: TranscriptSegment[],
  config: WindowConfig,
  maxTokens: number,
  tokenLength: TokenLength,
): ContextWindow[] {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new Error(`The encoder token limit must be a positive integer, not ${maxTokens}`);
  }

  const result: ContextWindow[] = [];
  for (const base of buildContextWindows(segments, config)) {
    const length = checkedTokenLength(base.text, tokenLength);
    if (length <= maxTokens) {
      result.push({ ...base, tokenLength: length });
      continue;
    }

    const fragments = base.sourceSpans.flatMap((span) => (
      splitSourceSpan(segments, span, maxTokens, tokenLength)
    ));
    const chunks: AnalysisEmbeddingChunk[] = [];
    let current: AnalysisSourceSpan[] = [];
    let currentLength = 0;
    for (const fragment of fragments) {
      const candidate = [...current, fragment];
      const candidateWindow = contextWindowFromSourceSpans(segments, candidate);
      const candidateLength = checkedTokenLength(candidateWindow.text, tokenLength);
      if (candidateLength <= maxTokens) {
        current = candidate;
        currentLength = candidateLength;
        continue;
      }

      if (!current.length) {
        throw new Error('A token-safe source fragment exceeded the encoder limit');
      }
      chunks.push(toEmbeddingChunk(segments, current, currentLength));
      const fragmentWindow = contextWindowFromSourceSpans(segments, [fragment]);
      const fragmentLength = checkedTokenLength(fragmentWindow.text, tokenLength);
      if (fragmentLength > maxTokens) {
        throw new Error('A token-safe source fragment exceeded the encoder limit');
      }
      current = [fragment];
      currentLength = fragmentLength;
    }
    if (current.length) chunks.push(toEmbeddingChunk(segments, current, currentLength));
    if (chunks.length < 2) throw new Error('An over-limit logical window did not produce multiple encoder chunks');
    // Preserve one temporal/boundary unit. Split pieces have only enclosing
    // segment timing, so promoting them to ContextWindows would manufacture a
    // seekable topic boundary inside an interval we cannot locate more finely.
    result.push({ ...base, embeddingChunks: chunks });
  }

  return result;
}

function toEmbeddingChunk(
  segments: TranscriptSegment[],
  sourceSpans: AnalysisSourceSpan[],
  tokenLength: number,
): AnalysisEmbeddingChunk {
  const window = contextWindowFromSourceSpans(segments, sourceSpans, tokenLength);
  return {
    text: window.text,
    sourceSpans: window.sourceSpans,
    tokenLength,
  };
}

function splitSourceSpan(
  segments: TranscriptSegment[],
  source: AnalysisSourceSpan,
  maxTokens: number,
  tokenLength: TokenLength,
): AnalysisSourceSpan[] {
  const segment = segments[source.segmentIndex];
  const whole = segment.text.slice(source.textStart, source.textEnd);
  if (checkedTokenLength(whole, tokenLength) <= maxTokens) return [source];

  const boundaries = codePointBoundaries(whole).map((offset) => source.textStart + offset);
  const result: AnalysisSourceSpan[] = [];
  let startBoundary = 0;
  while (startBoundary < boundaries.length - 1) {
    const start = boundaries[startBoundary];
    let bestBoundary = -1;
    // Token counts are not mathematically monotone under BPE: appending text
    // can change how the suffix is merged. Stop at the first exact over-limit
    // prefix instead of binary-searching an assumption the tokenizer does not
    // promise. This path runs only for an already-overlong source span and is
    // bounded by the model context, so correctness is worth the extra tokenizes.
    for (let candidate = startBoundary + 1; candidate < boundaries.length; candidate += 1) {
      const end = boundaries[candidate];
      const length = checkedTokenLength(segment.text.slice(start, end), tokenLength);
      if (length <= maxTokens) {
        bestBoundary = candidate;
        continue;
      }
      break;
    }
    if (bestBoundary < 0) {
      throw new Error(`A single code point in transcript segment ${source.segmentIndex} exceeds the encoder token limit`);
    }

    const preferredBoundary = whitespaceBoundary(segment.text, boundaries, startBoundary, bestBoundary);
    if (preferredBoundary > startBoundary && preferredBoundary < bestBoundary) {
      const preferredLength = checkedTokenLength(
        segment.text.slice(start, boundaries[preferredBoundary]),
        tokenLength,
      );
      if (preferredLength <= maxTokens) {
        bestBoundary = preferredBoundary;
      }
    }

    const end = boundaries[bestBoundary];
    result.push({
      segmentIndex: source.segmentIndex,
      textStart: start,
      textEnd: end,
      tStartMs: source.tStartMs,
      tEndMs: source.tEndMs,
      ...(source.speaker ? { speaker: source.speaker } : {}),
      timingFidelity: 'enclosing-segment',
    });
    startBoundary = bestBoundary;
  }
  return result;
}

function codePointBoundaries(text: string): number[] {
  const result = [0];
  let offset = 0;
  for (const codePoint of text) {
    offset += codePoint.length;
    result.push(offset);
  }
  return result;
}

function whitespaceBoundary(
  text: string,
  boundaries: number[],
  startBoundary: number,
  bestBoundary: number,
): number {
  for (let index = bestBoundary; index > startBoundary + 1; index -= 1) {
    const from = boundaries[index - 1];
    const to = boundaries[index];
    if (/\s/u.test(text.slice(from, to))) return index;
  }
  return bestBoundary;
}

function checkedTokenLength(text: string, tokenLength: TokenLength): number {
  const length = tokenLength(text);
  if (!Number.isSafeInteger(length) || length < 1) {
    throw new Error(`Tokenizer returned invalid input length ${length}`);
  }
  return length;
}
