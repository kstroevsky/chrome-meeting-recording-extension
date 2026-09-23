/**
 * Deterministic embedding engine for the mock E2E build.
 *
 * Durability tests exercise the real analysis pipeline and MV3/offscreen
 * lifecycle, but they should not make those contracts depend on loading the
 * packaged 118 MB ML model on a shared CI runner. The production integration
 * tier covers that runtime separately.
 */

import type { Embedding } from '../../shared/analysis/types';
import type { AnalysisEmbeddingEngine } from './AnalysisManager';

const DIMENSIONS = 384;

const SUBJECT_AXES: Array<{ matches: RegExp; axis: number }> = [
  { matches: /redis|connection pool|timeout/i, axis: 0 },
  { matches: /berlin|flight|hotel/i, axis: 1 },
  { matches: /frontend|candidate|interview|hiring/i, axis: 2 },
];

function deterministicEmbedding(text: string): Embedding {
  const vector = new Float32Array(DIMENSIONS);
  const subject = SUBJECT_AXES.find(({ matches }) => matches.test(text));
  vector[subject?.axis ?? 3] = 1;
  return vector;
}

export class AnalysisE2EMockEngine implements AnalysisEmbeddingEngine {
  readonly info = {
    device: 'wasm' as const,
    dimensions: DIMENSIONS,
    dtype: 'q8' as const,
    loadMs: 0,
  };

  encoder() {
    return async (texts: string[]): Promise<Embedding[]> => texts.map(deterministicEmbedding);
  }

  dispose(): void {}
}
