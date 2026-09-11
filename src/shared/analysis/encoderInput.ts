/**
 * @file shared/analysis/encoderInput.ts
 *
 * How text is handed to the encoder — in exactly one place.
 *
 * E5 models are trained with an instruction prefix, and the multilingual-E5
 * card asks for `"query: "` even when the embeddings are used as features for
 * clustering rather than for retrieval. Omitting it does not fail; it quietly
 * produces vectors from a distribution the model was not trained to place,
 * which moves every cosine downstream — boundaries, clusters, importance.
 *
 * That failure is invisible, which is precisely why this cannot be left to each
 * call site. The spike and the eventual engine go through this function, so
 * they cannot disagree: a transcript window embedded during calibration and the
 * same window embedded in production are prefixed identically or the code does
 * not compile.
 */

/** The prefix multilingual-E5 expects, including its trailing space. */
export const E5_QUERY_PREFIX = 'query: ';

/**
 * Prepares one piece of text for the encoder.
 *
 * Idempotent: text that already carries the prefix is not prefixed twice, so a
 * caller that pre-formats cannot silently double it.
 */
export function toEncoderInput(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith(E5_QUERY_PREFIX) ? trimmed : `${E5_QUERY_PREFIX}${trimmed}`;
}
