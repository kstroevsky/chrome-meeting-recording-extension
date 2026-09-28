import type { Embedding } from '../../shared/analysis/types';

/** Exact model/preprocessing identity plus the padded row presented to ONNX. */
export type ExactEncoderInputIdentity = {
  artifactFingerprint: string;
  preprocessingFingerprint: string;
  inputIds: readonly (number | bigint)[];
  attentionMask: readonly (number | bigint)[];
};

export type ExactEmbeddingCacheStats = {
  hits: number;
  misses: number;
  coalesced: number;
  evictions: number;
  bytes: number;
  entries: number;
};

export type ExactEmbeddingCacheDeps = {
  /** Injectable so unit tests do not depend on WebCrypto availability. */
  digest?: (canonicalIdentity: string) => Promise<string>;
};

type CacheEntry = {
  recordingId: string;
  vector: Embedding;
  bytes: number;
};

/**
 * Bounded, recording-scoped research cache for ADR-0009 TECH-03.
 *
 * Cache loss is always safe: it only causes inference to run again. A recording
 * deletion advances a scope epoch so an inference that finishes after deletion
 * cannot repopulate that recording's cache. Returned vectors are copies; callers
 * may transfer or mutate them without detaching/corrupting the cached value.
 */
export class ExactEmbeddingCache {
  private readonly digest: (canonicalIdentity: string) => Promise<string>;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Embedding>>();
  private readonly scopeEpoch = new Map<string, number>();
  private globalEpoch = 0;
  private usedBytes = 0;
  private hitCount = 0;
  private missCount = 0;
  private coalescedCount = 0;
  private evictionCount = 0;

  constructor(
    private readonly maxBytes: number,
    deps: ExactEmbeddingCacheDeps = {},
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error(`Embedding cache size must be a non-negative integer, not ${maxBytes}`);
    }
    this.digest = deps.digest ?? sha256Hex;
  }

  async getOrCompute(
    recordingId: string,
    identity: ExactEncoderInputIdentity,
    compute: () => Promise<Embedding>,
  ): Promise<Embedding> {
    if (!recordingId) throw new Error('Embedding cache entries require a recording scope');
    const digest = await this.digest(canonicalEncoderInput(identity));
    const key = scopedKey(recordingId, digest);
    const hit = this.entries.get(key);
    if (hit) {
      this.hitCount += 1;
      this.touch(key, hit);
      return hit.vector.slice();
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.coalescedCount += 1;
      return (await pending).slice();
    }

    this.missCount += 1;
    const epoch = this.scopeEpoch.get(recordingId) ?? 0;
    const globalEpoch = this.globalEpoch;
    const work = (async () => {
      const vector = await compute();
      if (!(vector instanceof Float32Array) || !vector.length || vector.some((value) => !Number.isFinite(value))) {
        throw new Error('Embedding cache compute returned an invalid vector');
      }
      // A concurrent recording deletion wins. The caller still receives the
      // vector it requested, but it is not retained after the deletion fence.
      if (this.globalEpoch === globalEpoch && (this.scopeEpoch.get(recordingId) ?? 0) === epoch) {
        this.insert(key, recordingId, vector);
      }
      return vector;
    })();
    this.inFlight.set(key, work);
    try {
      return (await work).slice();
    } finally {
      if (this.inFlight.get(key) === work) this.inFlight.delete(key);
    }
  }

  /** Removes retained vectors and fences any currently running computation. */
  clearRecording(recordingId: string): void {
    this.scopeEpoch.set(recordingId, (this.scopeEpoch.get(recordingId) ?? 0) + 1);
    for (const [key, entry] of this.entries) {
      if (entry.recordingId !== recordingId) continue;
      this.entries.delete(key);
      this.usedBytes -= entry.bytes;
    }
  }

  clear(): void {
    this.globalEpoch += 1;
    this.entries.clear();
    this.usedBytes = 0;
  }

  stats(): ExactEmbeddingCacheStats {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      coalesced: this.coalescedCount,
      evictions: this.evictionCount,
      bytes: this.usedBytes,
      entries: this.entries.size,
    };
  }

  private insert(key: string, recordingId: string, vector: Embedding): void {
    if (!this.maxBytes || vector.byteLength > this.maxBytes) return;
    const owned = vector.slice();
    const existing = this.entries.get(key);
    if (existing) {
      this.usedBytes -= existing.bytes;
      this.entries.delete(key);
    }
    const entry = { recordingId, vector: owned, bytes: owned.byteLength };
    this.entries.set(key, entry);
    this.usedBytes += entry.bytes;

    while (this.usedBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey == null) break;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      this.usedBytes -= oldest.bytes;
      this.evictionCount += 1;
    }
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}

/**
 * Canonical length-delimited serialization. Delimiters inside fingerprints
 * cannot create ambiguity because every field declares its encoded length.
 */
export function canonicalEncoderInput(identity: ExactEncoderInputIdentity): string {
  if (!identity.artifactFingerprint || !identity.preprocessingFingerprint) {
    throw new Error('Encoder cache identity requires artifact and preprocessing fingerprints');
  }
  if (identity.inputIds.length !== identity.attentionMask.length || !identity.inputIds.length) {
    throw new Error('Encoder cache identity requires equal non-empty ids and attention mask');
  }
  return [
    field(identity.artifactFingerprint),
    field(identity.preprocessingFingerprint),
    numericSequence(identity.inputIds),
    numericSequence(identity.attentionMask),
  ].join('');
}

function numericSequence(values: readonly (number | bigint)[]): string {
  const encoded = values.map((value) => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Encoder cache identity contains invalid integer ${value}`);
    }
    if (typeof value === 'bigint' && value < 0n) {
      throw new Error(`Encoder cache identity contains invalid integer ${String(value)}`);
    }
    return field(String(value));
  }).join('');
  return `${values.length}:${encoded}`;
}

function field(value: string): string {
  const bytes = new TextEncoder().encode(value).byteLength;
  return `${bytes}:${value}`;
}

function scopedKey(recordingId: string, digest: string): string {
  return `${field(recordingId)}${field(digest)}`;
}

async function sha256Hex(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('WebCrypto is unavailable for embedding cache identity');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
