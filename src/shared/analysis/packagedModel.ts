/**
 * @file shared/analysis/packagedModel.ts
 *
 * Which embedding model this build actually packaged.
 *
 * Shared rather than owned by the offscreen tree because two contexts need it
 * for different reasons and they must not disagree: the data plane loads these
 * artifacts, and the control plane stamps their identity into every analysis's
 * provenance. It comes from the build define `__ANALYSIS_MODEL__`, which
 * webpack fills from the same manifest `scripts/fetch-analysis-model.mjs`
 * verified the bytes against — so a build that packaged Q8 cannot produce an
 * analysis claiming FP16.
 */

import type { EmbeddingDtype } from './provenance';

export type PackagedModel = { id: string; revision: string; dtype: EmbeddingDtype };

/**
 * The model identity this build carries.
 *
 * Falls back only for contexts that have no define — unit tests, mostly. A
 * production build always has one, and `scripts/check-production-build.mjs` is
 * where that becomes enforceable rather than hoped for.
 */
export function packagedModel(): PackagedModel {
  const defined = typeof __ANALYSIS_MODEL__ === 'object' ? __ANALYSIS_MODEL__ : undefined;
  return {
    id: defined?.id ?? 'Xenova/multilingual-e5-small',
    revision: defined?.revision ?? 'unknown',
    dtype: (defined?.dtype ?? 'q8') as EmbeddingDtype,
  };
}
