/**
 * @file background/RecordingAnalysisService.ts
 *
 * Owns every analysis transition, and decides when a stored one still counts.
 *
 * The interesting behaviour here is not storage, it is **staleness**. Four of
 * the scoring terms are provisional, every §9 value is still a candidate rather
 * than a frozen contract, and the embedding model and its quantization may
 * change. A stored analysis is therefore only meaningful alongside the
 * conditions that produced it, and this is the layer that compares them.
 */

import { isStale, type AnalysisProvenance } from '../shared/analysis/provenance';
import {
  summarize,
  toTopicSummary,
  type AnalysisSummary,
  type RecordingTopicSummary,
  type StoredAnalysis,
} from '../shared/analysis/storedAnalysis';
import type { RecordingAnalysisRepositoryPort } from './RecordingAnalysisRepository';

/** Why a recording has no usable analysis, or that it has one. */
export type AnalysisState =
  | { status: 'ready'; summary: AnalysisSummary }
  /** Never analysed. */
  | { status: 'none' }
  /** Analysed under conditions that no longer apply; recompute to replace it. */
  | { status: 'stale' };

export class RecordingAnalysisService {
  constructor(
    private readonly repository: RecordingAnalysisRepositoryPort,
    /** The conditions a fresh run would use; compared against what is stored. */
    private readonly currentProvenance: () => AnalysisProvenance,
  ) {}

  /**
   * The stored analysis, or `undefined` when there is none **or it is stale**.
   *
   * Stale is folded into "nothing to show" deliberately: a caller that only
   * wants topics should not have to know why there are none, and one that
   * cares can ask {@link state}.
   */
  async get(recordingId: string): Promise<StoredAnalysis | undefined> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return undefined;
    return isStale(stored.provenance, this.currentProvenance()) ? undefined : stored;
  }

  /** What a surface should render, including *why* there is nothing to render. */
  async state(recordingId: string): Promise<AnalysisState> {
    const stored = await this.repository.get(recordingId);
    if (!stored) return { status: 'none' };
    if (isStale(stored.provenance, this.currentProvenance())) return { status: 'stale' };
    return { status: 'ready', summary: summarize(stored) };
  }

  /**
   * Stores a completed analysis, stamping it with the conditions it ran under.
   *
   * Provenance is applied here rather than trusted from the caller, so a job
   * cannot record conditions it did not actually use.
   */
  async save(
    recordingId: string,
    result: Omit<StoredAnalysis, 'provenance' | 'completedAt'>,
    now: number = Date.now(),
  ): Promise<StoredAnalysis> {
    const analysis: StoredAnalysis = {
      ...result,
      provenance: this.currentProvenance(),
      completedAt: now,
    };
    await this.repository.put(recordingId, analysis);
    return analysis;
  }

  /**
   * Topic digests for a page of the library, keyed by recording id.
   *
   * Recordings with no current analysis are simply absent from the result
   * rather than present with empty keywords — the column renders nothing either
   * way, and a caller can tell "not analysed" from "analysed, no topics".
   *
   * One read per recording, which is what the underlying store supports; the
   * page size is a screenful, and this is a fire-and-forget digest the table
   * does not wait for.
   */
  async topicSummaries(recordingIds: string[]): Promise<Record<string, RecordingTopicSummary>> {
    const current = this.currentProvenance();
    const summaries: Record<string, RecordingTopicSummary> = {};
    for (const recordingId of recordingIds) {
      const stored = await this.repository.get(recordingId);
      if (!stored || isStale(stored.provenance, current)) continue;
      summaries[recordingId] = toTopicSummary(stored);
    }
    return summaries;
  }

  /** Drops a recording's analysis — a discarded run, a deleted entry, or a recompute. */
  async removeAll(recordingId: string): Promise<void> {
    await this.repository.remove(recordingId);
  }
}
