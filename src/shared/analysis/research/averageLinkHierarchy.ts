import type { Embedding } from '../types';

export const DEFAULT_MAX_HIERARCHY_LEAVES = 512;

export type AverageLinkMerge = {
  /** Node ids: leaves are 0..leafCount-1, merged nodes continue upward. */
  node: number;
  left: number;
  right: number;
  similarity: number;
  mass: number;
};

export type AverageLinkHierarchy = {
  leafCount: number;
  leafMasses: number[];
  merges: AverageLinkMerge[];
};

type Cluster = {
  id: number;
  mass: number;
  minLeaf: number;
};

/**
 * O(m²)-memory nearest-neighbor-chain average-link hierarchy.
 *
 * Leaves are normalized exactly once. Cluster means are never normalized:
 * weighted average cosine follows the Lance-Williams mass update, which is
 * algebraically the average of every cross-cluster leaf cosine. Re-normalizing
 * a cluster mean would silently change average-link into centroid cosine.
 */
export function buildAverageLinkHierarchy(
  embeddings: Embedding[],
  masses: number[] = embeddings.map(() => 1),
  maxLeaves = DEFAULT_MAX_HIERARCHY_LEAVES,
): AverageLinkHierarchy {
  const initial = initialize(embeddings, masses, maxLeaves);
  return nearestNeighborChain(initial.clusters, initial.similarities, masses);
}

/** Cubic reference implementation retained as TECH-06's exact oracle. */
export function buildAverageLinkHierarchyReference(
  embeddings: Embedding[],
  masses: number[] = embeddings.map(() => 1),
  maxLeaves = DEFAULT_MAX_HIERARCHY_LEAVES,
): AverageLinkHierarchy {
  const initial = initialize(embeddings, masses, maxLeaves);
  return globallyBestPairs(initial.clusters, initial.similarities, masses);
}

/**
 * Reuses one hierarchy for many thresholds without rebuilding pairwise state.
 * Returns leaf indices in deterministic cluster order.
 */
export function cutAverageLinkHierarchy(
  hierarchy: AverageLinkHierarchy,
  minSimilarity: number,
): number[][] {
  if (!Number.isFinite(minSimilarity) || minSimilarity < -1 || minSimilarity > 1) {
    throw new Error(`Average-link cut must be a cosine similarity in [-1, 1], not ${minSimilarity}`);
  }
  const groups = new Map<number, number[]>();
  for (let leaf = 0; leaf < hierarchy.leafCount; leaf += 1) groups.set(leaf, [leaf]);
  for (const merge of hierarchy.merges) {
    if (merge.similarity < minSimilarity) break;
    const left = groups.get(merge.left);
    const right = groups.get(merge.right);
    if (!left || !right) throw new Error('Average-link hierarchy contains an invalid merge order');
    groups.delete(merge.left);
    groups.delete(merge.right);
    groups.set(merge.node, [...left, ...right].sort((a, b) => a - b));
  }
  return [...groups.values()]
    .map((group) => [...group].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

/** Direct formula used by tests to catch accidental cluster-mean normalization. */
export function averageCosineBetweenGroups(
  embeddings: Embedding[],
  masses: number[],
  left: number[],
  right: number[],
): number {
  const normalized = normalizeLeaves(embeddings, masses);
  let leftMass = 0;
  let rightMass = 0;
  const leftSum = new Float64Array(normalized.dimensions);
  const rightSum = new Float64Array(normalized.dimensions);
  for (const index of left) {
    assertLeafIndex(index, embeddings.length);
    leftMass += masses[index];
    addScaled(leftSum, normalized.vectors[index], masses[index]);
  }
  for (const index of right) {
    assertLeafIndex(index, embeddings.length);
    rightMass += masses[index];
    addScaled(rightSum, normalized.vectors[index], masses[index]);
  }
  return dot(leftSum, rightSum) / (leftMass * rightMass);
}

type Initialized = {
  clusters: Map<number, Cluster>;
  similarities: CondensedSimilarityTable;
};

function initialize(embeddings: Embedding[], masses: number[], maxLeaves: number): Initialized {
  if (!Number.isSafeInteger(maxLeaves) || maxLeaves < 1) throw new Error('Average-link leaf bound must be positive');
  if (embeddings.length > maxLeaves) {
    throw new Error(`Average-link hierarchy is bounded to ${maxLeaves} leaves, got ${embeddings.length}`);
  }
  if (embeddings.length !== masses.length) {
    throw new Error(`Average-link needs one mass per embedding: ${embeddings.length} vs ${masses.length}`);
  }
  if (!embeddings.length) return { clusters: new Map(), similarities: new CondensedSimilarityTable(1) };
  const normalized = normalizeLeaves(embeddings, masses);
  const maxNodes = Math.max(1, embeddings.length * 2 - 1);
  const similarities = new CondensedSimilarityTable(maxNodes);
  const clusters = new Map<number, Cluster>();
  for (let i = 0; i < embeddings.length; i += 1) {
    clusters.set(i, { id: i, mass: masses[i], minLeaf: i });
    for (let j = 0; j < i; j += 1) similarities.set(j, i, dot(normalized.vectors[j], normalized.vectors[i]));
  }
  return { clusters, similarities };
}

function nearestNeighborChain(
  initial: Map<number, Cluster>,
  similarities: CondensedSimilarityTable,
  leafMasses: number[],
): AverageLinkHierarchy {
  const active = new Map(initial);
  const merges: AverageLinkMerge[] = [];
  const chain: number[] = [];
  let nextId = leafMasses.length;

  while (active.size > 1) {
    if (!chain.length) chain.push(smallestCluster(active));
    const current = chain[chain.length - 1];
    const neighbor = nearestNeighbor(current, active, similarities);
    const previous = chain.length >= 2 ? chain[chain.length - 2] : undefined;
    if (previous !== neighbor) {
      chain.push(neighbor);
      continue;
    }

    const leftCluster = active.get(current)!;
    const rightCluster = active.get(neighbor)!;
    const [left, right] = canonicalPair(leftCluster, rightCluster);
    const similarity = similarities.get(left.id, right.id);
    const merged: Cluster = {
      id: nextId,
      mass: left.mass + right.mass,
      minLeaf: Math.min(left.minLeaf, right.minLeaf),
    };

    for (const other of active.values()) {
      if (other.id === left.id || other.id === right.id) continue;
      const updated = (
        left.mass * similarities.get(left.id, other.id)
        + right.mass * similarities.get(right.id, other.id)
      ) / merged.mass;
      similarities.set(merged.id, other.id, updated);
    }
    active.delete(left.id);
    active.delete(right.id);
    active.set(merged.id, merged);
    merges.push({
      node: merged.id,
      left: left.id,
      right: right.id,
      similarity,
      mass: merged.mass,
    });
    nextId += 1;
    chain.pop();
    chain.pop();
  }
  return {
    leafCount: leafMasses.length,
    leafMasses: [...leafMasses],
    merges: sortAndRelabelMerges(merges, leafMasses.length),
  };
}

function globallyBestPairs(
  initial: Map<number, Cluster>,
  similarities: CondensedSimilarityTable,
  leafMasses: number[],
): AverageLinkHierarchy {
  const active = new Map(initial);
  const merges: AverageLinkMerge[] = [];
  let nextId = leafMasses.length;
  while (active.size > 1) {
    let bestPair: [Cluster, Cluster] | undefined;
    let bestSimilarity = Number.NEGATIVE_INFINITY;
    const ordered = [...active.values()].sort(clusterOrder);
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const candidate = similarities.get(ordered[i].id, ordered[j].id);
        if (candidate > bestSimilarity) {
          bestSimilarity = candidate;
          bestPair = [ordered[i], ordered[j]];
        }
      }
    }
    if (!bestPair) throw new Error('Average-link reference could not select a pair');
    const [left, right] = canonicalPair(...bestPair);
    const merged: Cluster = {
      id: nextId,
      mass: left.mass + right.mass,
      minLeaf: Math.min(left.minLeaf, right.minLeaf),
    };
    for (const other of active.values()) {
      if (other.id === left.id || other.id === right.id) continue;
      const updated = (
        left.mass * similarities.get(left.id, other.id)
        + right.mass * similarities.get(right.id, other.id)
      ) / merged.mass;
      similarities.set(merged.id, other.id, updated);
    }
    active.delete(left.id);
    active.delete(right.id);
    active.set(merged.id, merged);
    merges.push({ node: merged.id, left: left.id, right: right.id, similarity: bestSimilarity, mass: merged.mass });
    nextId += 1;
  }
  assertMonotone(merges);
  return { leafCount: leafMasses.length, leafMasses: [...leafMasses], merges };
}

function nearestNeighbor(
  clusterId: number,
  active: Map<number, Cluster>,
  similarities: CondensedSimilarityTable,
): number {
  let best: Cluster | undefined;
  let bestSimilarity = Number.NEGATIVE_INFINITY;
  for (const candidate of active.values()) {
    if (candidate.id === clusterId) continue;
    const similarity = similarities.get(clusterId, candidate.id);
    if (similarity > bestSimilarity || (similarity === bestSimilarity && best && clusterOrder(candidate, best) < 0)) {
      best = candidate;
      bestSimilarity = similarity;
    }
  }
  if (!best) throw new Error('Average-link nearest-neighbor search has no candidate');
  return best.id;
}

function normalizeLeaves(embeddings: Embedding[], masses: number[]): { vectors: Float64Array[]; dimensions: number } {
  if (embeddings.length !== masses.length) throw new Error('Average-link needs one mass per embedding');
  if (!embeddings.length) return { vectors: [], dimensions: 0 };
  const dimensions = embeddings[0].length;
  if (!dimensions) throw new Error('Average-link embeddings must have at least one dimension');
  const vectors = embeddings.map((embedding, index) => {
    if (embedding.length !== dimensions) throw new Error('Average-link embeddings must have equal dimensions');
    const mass = masses[index];
    if (!Number.isFinite(mass) || mass <= 0) throw new Error(`Average-link requires positive finite masses, got ${mass}`);
    let square = 0;
    for (const value of embedding) {
      if (!Number.isFinite(value)) throw new Error('Average-link received a non-finite embedding');
      square += value * value;
    }
    const norm = Math.sqrt(square);
    if (!norm) throw new Error('Average-link cannot normalize a zero embedding');
    return Float64Array.from(embedding, (value) => value / norm);
  });
  return { vectors, dimensions };
}

function canonicalPair(a: Cluster, b: Cluster): [Cluster, Cluster] {
  return clusterOrder(a, b) <= 0 ? [a, b] : [b, a];
}

function clusterOrder(a: Cluster, b: Cluster): number {
  return a.minLeaf - b.minLeaf || a.id - b.id;
}

function smallestCluster(active: Map<number, Cluster>): number {
  const first = [...active.values()].sort(clusterOrder)[0];
  if (!first) throw new Error('Average-link hierarchy has no active cluster');
  return first.id;
}

function assertMonotone(merges: AverageLinkMerge[]): void {
  for (let i = 1; i < merges.length; i += 1) {
    if (merges[i].similarity > merges[i - 1].similarity + 1e-12) {
      throw new Error('Average-link hierarchy similarity increased after a merge');
    }
  }
}

/**
 * NNC discovers independent reciprocal pairs in chain order, not necessarily in
 * descending similarity order. Threshold cuts need a canonical dendrogram order,
 * and sorting raw records directly is unsafe because internal node ids refer to
 * earlier raw merges. Relabel only merges whose children have already been
 * emitted, choosing the highest available similarity at each step.
 */
function sortAndRelabelMerges(raw: AverageLinkMerge[], leafCount: number): AverageLinkMerge[] {
  const pending = new Map(raw.map((merge) => [merge.node, merge]));
  const remapped = new Map<number, number>();
  for (let leaf = 0; leaf < leafCount; leaf += 1) remapped.set(leaf, leaf);

  const result: AverageLinkMerge[] = [];
  while (pending.size) {
    let best: AverageLinkMerge | undefined;
    for (const candidate of pending.values()) {
      if (!remapped.has(candidate.left) || !remapped.has(candidate.right)) continue;
      if (
        !best
        || candidate.similarity > best.similarity
        || (candidate.similarity === best.similarity && mergeOrder(candidate, best) < 0)
      ) {
        best = candidate;
      }
    }
    if (!best) throw new Error('Average-link hierarchy contains an unresolved merge dependency');

    const node = leafCount + result.length;
    result.push({
      node,
      left: remapped.get(best.left)!,
      right: remapped.get(best.right)!,
      similarity: best.similarity,
      mass: best.mass,
    });
    remapped.set(best.node, node);
    pending.delete(best.node);
  }
  assertMonotone(result);
  return result;
}

function mergeOrder(a: AverageLinkMerge, b: AverageLinkMerge): number {
  return Math.min(a.left, a.right) - Math.min(b.left, b.right)
    || Math.max(a.left, a.right) - Math.max(b.left, b.right)
    || a.node - b.node;
}

function addScaled(target: Float64Array, vector: Float64Array, mass: number): void {
  for (let i = 0; i < target.length; i += 1) target[i] += vector[i] * mass;
}

function dot(a: Float64Array, b: Float64Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
  return total;
}

function assertLeafIndex(index: number, count: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error(`Invalid average-link leaf ${index}`);
}

class CondensedSimilarityTable {
  private readonly data: Float64Array;

  constructor(private readonly capacity: number) {
    this.data = new Float64Array((capacity * (capacity - 1)) / 2);
    this.data.fill(Number.NaN);
  }

  get(a: number, b: number): number {
    if (a === b) return 1;
    const index = this.index(a, b);
    const value = this.data[index];
    if (!Number.isFinite(value)) throw new Error(`Average-link similarity ${a}/${b} is unavailable`);
    return value;
  }

  set(a: number, b: number, value: number): void {
    if (a === b) return;
    if (!Number.isFinite(value)) throw new Error('Average-link similarity must be finite');
    this.data[this.index(a, b)] = value;
  }

  private index(a: number, b: number): number {
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a >= this.capacity || b >= this.capacity) {
      throw new Error(`Average-link node is outside condensed table: ${a}/${b}`);
    }
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    return (high * (high - 1)) / 2 + low;
  }
}
