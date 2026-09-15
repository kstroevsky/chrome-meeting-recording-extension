/**
 * @file shared/analysis/clusters.ts
 *
 * Online micro-clustering: what turns a run of temporal segments into the
 * handful of subjects a conversation was actually about.
 *
 * **BERTopic is deliberately not run here** (CLU-01). `embeddings → UMAP →
 * HDBSCAN` is the right answer offline and the wrong one in a browser: both
 * stages are global re-computations over the full embedding set, so every
 * update redoes all prior work. Neither is necessary for this problem. A
 * cluster here is a centroid and a count; joining one is a cosine test and an
 * incremental mean, which is effectively free (CLU-02, CLU-03, CLU-05).
 *
 * **Recurrence is handled by merging, not by assignment.** A segment is
 * compared against the *current* cluster, exactly as CLU-04 specifies, so a
 * conversation that returns to Redis after twenty minutes of hiring opens a
 * second Redis cluster rather than reaching back. A periodic sweep over
 * centroid pairs then folds those together — which is precisely CLU-06's worked
 * example, *Redis incident #1* + *Redis incident #2* + *Redis config* → **Redis**.
 * That is what makes a topic global while segmentation stays temporal (MODEL-05).
 */

import { cosine, mergeCentroids } from './vector';
import { createTopicId, type ConversationSegment, type Embedding, type TemporalSegment } from './types';

/**
 * The assignment threshold as the source payload wrote it (CLU-04).
 *
 * Retained for provenance, **not used**: ADR-0007's 4B calibration measured
 * this encoder and found every genuinely different topic pair scoring above it
 * — 27 of 27, the lowest at 0.861 — so `cosine > 0.82` evaluates to "always
 * join" and every conversation collapses to one cluster. E5-family models
 * compress cosine into a narrow high band, and an absolute threshold chosen
 * without reference to a particular encoder cannot land in it.
 *
 * The payload presented it illustratively ("Imagine the current topic has …
 * number of segments = 14", "If: `s > 0.82` for example"), so it moves to
 * {@link ClusterConfig.assignmentThreshold} as a §9 open contract rather than
 * standing as a frozen value. See the plan's D-16.
 */
export const PAYLOAD_ASSIGNMENT_THRESHOLD = 0.82;

export type ClusterConfig = {
  /**
   * Cosine similarity a segment must **exceed** to join the current cluster
   * rather than open a new one (CLU-04, as amended by D-16).
   *
   * Model- and calibration-specific: embedding models differ in how they spread
   * similarity, so this is calibrated *jointly* with {@link mergeThreshold}
   * rather than chosen once. It compares a segment to a centroid; the merge
   * threshold compares two centroids.
   *
   * **Set it too high and the cost is recoverable; too low and it is not.** An
   * over-tight bar makes extra micro-clusters, which the periodic merge sweep
   * can still reunite. An over-loose one folds two subjects into one cluster,
   * and this pipeline has no split operation to undo that. Prefer over-splitting
   * when two candidate values score alike.
   */
  assignmentThreshold: number;
  /**
   * Cosine similarity between two cluster *centroids* at or above which they
   * are the same subject. Open contract (§9).
   */
  mergeThreshold: number;
  /**
   * How many assignments between merge sweeps. "Periodically" in CLU-06; the
   * period itself is an open contract (§9). A sweep also always runs at the end.
   */
  mergeEverySegments: number;
};

/** A cluster in flight: a centroid, how many segments it summarizes, and which. */
export type MicroCluster = {
  id: string;
  centroid: Embedding;
  /** The `n` in `C_new = (n·C + x) / (n + 1)`. */
  n: number;
  segmentIds: string[];
};

export type ClusteringResult = {
  clusters: MicroCluster[];
  /** The input segments, each now carrying the cluster it belongs to. */
  segments: ConversationSegment[];
};

/**
 * Assigns every segment to a subject, merging recurrences as it goes.
 *
 * Cost is linear in segments for assignment plus a quadratic sweep over
 * clusters, which at CLU-07's reference scale of 50 topics is 2,500 cosine
 * comparisons — nothing for JavaScript.
 */
export function clusterSegments(segments: TemporalSegment[], config: ClusterConfig): ClusteringResult {
  assertConfig(config);

  let clusters: MicroCluster[] = [];
  let current: MicroCluster | undefined;
  const assignment = new Map<string, string>();
  let sinceSweep = 0;

  for (const segment of segments) {
    if (current && cosine(segment.embedding, current.centroid) > config.assignmentThreshold) {
      current.centroid = foldIn(current, segment.embedding);
      current.n += 1;
      current.segmentIds.push(segment.id);
    } else {
      current = {
        id: createTopicId(),
        centroid: Float32Array.from(segment.embedding),
        n: 1,
        segmentIds: [segment.id],
      };
      clusters.push(current);
    }
    assignment.set(segment.id, current.id);

    sinceSweep += 1;
    if (sinceSweep >= config.mergeEverySegments) {
      sinceSweep = 0;
      const before = current;
      clusters = mergeClusters(clusters, config, assignment);
      // The current cluster may have been folded into another; follow it, so
      // the next segment is compared against the centroid it actually joined.
      current = clusters.find((cluster) => cluster.id === assignment.get(before.segmentIds[0]!));
    }
  }

  clusters = mergeClusters(clusters, config, assignment);

  // Inside a merged subject, segments read in the order they came up in the
  // conversation rather than the order their fragments happened to be folded.
  // Ids are UUIDs, so this has to sort by position, not by id.
  const order = new Map(segments.map((segment, index) => [segment.id, index]));
  for (const cluster of clusters) {
    cluster.segmentIds.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  return {
    clusters,
    segments: segments.map((segment) => ({
      ...segment,
      localTopicId: assignment.get(segment.id)!,
    })),
  };
}

/**
 * One merge sweep over every pair of cluster centroids (CLU-06).
 *
 * Repeats until a pass changes nothing, because merging two clusters moves
 * their centroid and can bring a third within reach. `assignment` is rewritten
 * in place so segments follow the cluster they end up in.
 */
export function mergeClusters(
  clusters: MicroCluster[],
  config: ClusterConfig,
  assignment: Map<string, string>,
): MicroCluster[] {
  assertConfig(config);

  let working = [...clusters];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        if (cosine(working[i].centroid, working[j].centroid) < config.mergeThreshold) continue;

        const kept = working[i];
        const absorbed = working[j];
        kept.centroid = mergeCentroids(kept.centroid, kept.n, absorbed.centroid, absorbed.n);
        kept.n += absorbed.n;
        kept.segmentIds.push(...absorbed.segmentIds);
        for (const segmentId of absorbed.segmentIds) assignment.set(segmentId, kept.id);

        working = working.filter((cluster) => cluster !== absorbed);
        merged = true;
        break outer;
      }
    }
  }

  return working;
}

function foldIn(cluster: MicroCluster, x: Embedding): Embedding {
  return mergeCentroids(cluster.centroid, cluster.n, x, 1);
}

function assertConfig(config: ClusterConfig): void {
  if (!(config.assignmentThreshold > -1 && config.assignmentThreshold <= 1)) {
    throw new Error(`An assignment threshold must be a cosine similarity in (-1, 1], not ${config.assignmentThreshold}`);
  }
  if (!(config.mergeThreshold > -1 && config.mergeThreshold <= 1)) {
    throw new Error(`A merge threshold must be a cosine similarity in (-1, 1], not ${config.mergeThreshold}`);
  }
  if (!Number.isInteger(config.mergeEverySegments) || config.mergeEverySegments < 1) {
    throw new Error(`A merge period must be at least one segment, not ${config.mergeEverySegments}`);
  }
}
