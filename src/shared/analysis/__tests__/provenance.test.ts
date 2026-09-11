import { PIPELINE_VERSION, hashAnalysisConfig, isStale, type AnalysisProvenance } from '../provenance';
import type { AnalysisConfig } from '../types';

const CONFIG: AnalysisConfig = {
  windowUtterances: 4,
  windowStride: 2,
  longPauseMs: 3_000,
  peakNeighbourhood: 2,
  peakMinProminence: 0.2,
  minSegmentMs: 30_000,
  mergeThreshold: 0.95,
  mergeEverySegments: 25,
  keywordsPerTopic: 4,
  mmrLambda: 0.6,
};

const provenance = (over: Partial<AnalysisProvenance> = {}): AnalysisProvenance => ({
  pipelineVersion: PIPELINE_VERSION,
  embeddingModel: 'Xenova/multilingual-e5-small',
  embeddingModelRevision: 'abc1234',
  embeddingDimensions: 384,
  configHash: hashAnalysisConfig(CONFIG),
  ...over,
});

describe('hashAnalysisConfig', () => {
  it('is stable across calls', () => {
    expect(hashAnalysisConfig(CONFIG)).toBe(hashAnalysisConfig(CONFIG));
  });

  it('ignores property order, so a reshuffled object does not force a recompute', () => {
    const reordered = Object.fromEntries(
      Object.entries(CONFIG).reverse(),
    ) as unknown as AnalysisConfig;
    expect(hashAnalysisConfig(reordered)).toBe(hashAnalysisConfig(CONFIG));
  });

  it('changes when any §9 value changes', () => {
    const baseline = hashAnalysisConfig(CONFIG);
    for (const key of Object.keys(CONFIG) as (keyof AnalysisConfig)[]) {
      const changed = { ...CONFIG, [key]: (CONFIG[key] as number) + 1 };
      expect(hashAnalysisConfig(changed)).not.toBe(baseline);
    }
  });

  it('distinguishes values that stringify alike', () => {
    expect(hashAnalysisConfig({ ...CONFIG, mmrLambda: 0.6 }))
      .not.toBe(hashAnalysisConfig({ ...CONFIG, mmrLambda: 0.61 }));
  });
});

describe('isStale', () => {
  it('accepts a result computed under identical conditions', () => {
    expect(isStale(provenance(), provenance())).toBe(false);
  });

  it('rejects a result from an earlier pipeline', () => {
    expect(isStale(provenance({ pipelineVersion: PIPELINE_VERSION - 1 }), provenance())).toBe(true);
  });

  it('rejects a result from a different model, revision or width', () => {
    expect(isStale(provenance({ embeddingModel: 'Xenova/all-MiniLM-L6-v2' }), provenance())).toBe(true);
    expect(isStale(provenance({ embeddingModelRevision: 'def5678' }), provenance())).toBe(true);
    // Re-quantizing or swapping the model can change the width.
    expect(isStale(provenance({ embeddingDimensions: 768 }), provenance())).toBe(true);
  });

  it('rejects a result computed under different §9 values', () => {
    const other = hashAnalysisConfig({ ...CONFIG, mergeThreshold: 0.9 });
    expect(isStale(provenance({ configHash: other }), provenance())).toBe(true);
  });

  it('catches a redefined provisional term through the pipeline version', () => {
    // Redefining `novelty` or `speakerPatternChange` changes no config value, so
    // the version is the only thing that can mark those results stale.
    const redefined = provenance({ pipelineVersion: PIPELINE_VERSION + 1 });
    expect(isStale(provenance(), redefined)).toBe(true);
  });
});
