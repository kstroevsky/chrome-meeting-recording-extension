import { ExactEmbeddingCache, canonicalEncoderInput, type ExactEncoderInputIdentity } from '../ExactEmbeddingCache';

const identity = (overrides: Partial<ExactEncoderInputIdentity> = {}): ExactEncoderInputIdentity => ({
  artifactFingerprint: 'e5@revision:q8:wasm',
  preprocessingFingerprint: 'query-prefix:v1|special-tokens|mean|l2',
  inputIds: [0n, 7n, 8n, 2n, 1n],
  attentionMask: [1n, 1n, 1n, 1n, 0n],
  ...overrides,
});

const cache = (maxBytes = 1_024) => new ExactEmbeddingCache(maxBytes, {
  digest: async (canonical) => canonical,
});

describe('ExactEmbeddingCache', () => {
  it('reuses an identical encoder input when only revision-specific timeline metadata changed outside the key', async () => {
    const subject = cache();
    let computes = 0;
    const compute = async () => { computes += 1; return Float32Array.of(1, 2, 3); };

    expect(Array.from(await subject.getOrCompute('recording:1', identity(), compute))).toEqual([1, 2, 3]);
    expect(Array.from(await subject.getOrCompute('recording:1', identity(), compute))).toEqual([1, 2, 3]);
    expect(computes).toBe(1);
    expect(subject.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  it('misses for token, mask, artifact, preprocessing, or recording-scope changes', async () => {
    const subject = cache();
    let computes = 0;
    const run = (recordingId: string, value: ExactEncoderInputIdentity) => subject.getOrCompute(
      recordingId,
      value,
      async () => Float32Array.of(++computes),
    );

    await run('recording:1', identity());
    await run('recording:1', identity({ inputIds: [0n, 7n, 9n, 2n, 1n] }));
    await run('recording:1', identity({ attentionMask: [1n, 1n, 1n, 0n, 0n] }));
    await run('recording:1', identity({ artifactFingerprint: 'e5@next:q8:wasm' }));
    await run('recording:1', identity({ preprocessingFingerprint: 'passage-prefix:v1|special-tokens|mean|l2' }));
    await run('recording:2', identity());

    expect(computes).toBe(6);
    expect(subject.stats()).toMatchObject({ hits: 0, misses: 6, entries: 6 });
  });

  it('coalesces simultaneous exact requests and never caches a failed compute', async () => {
    const subject = cache();
    let release!: (value: Float32Array) => void;
    let computes = 0;
    const pending = () => {
      computes += 1;
      return new Promise<Float32Array>((resolve) => { release = resolve; });
    };
    const first = subject.getOrCompute('recording:1', identity(), pending);
    const second = subject.getOrCompute('recording:1', identity(), pending);
    await Promise.resolve();
    await Promise.resolve();
    release(Float32Array.of(4, 5));
    await expect(first).resolves.toEqual(Float32Array.of(4, 5));
    await expect(second).resolves.toEqual(Float32Array.of(4, 5));
    expect(computes).toBe(1);
    expect(subject.stats().coalesced).toBe(1);

    await expect(subject.getOrCompute('recording:1', identity({ inputIds: [99n] , attentionMask: [1n] }), async () => {
      throw new Error('backend failed');
    })).rejects.toThrow('backend failed');
    await expect(subject.getOrCompute('recording:1', identity({ inputIds: [99n], attentionMask: [1n] }), async () => (
      Float32Array.of(9)
    ))).resolves.toEqual(Float32Array.of(9));
  });

  it('returns owned copies so transfers or mutations cannot poison the retained vector', async () => {
    const subject = cache();
    const first = await subject.getOrCompute('recording:1', identity(), async () => Float32Array.of(1, 2));
    first[0] = 99;
    const second = await subject.getOrCompute('recording:1', identity(), async () => Float32Array.of(8, 8));
    expect(Array.from(second)).toEqual([1, 2]);
  });

  it('uses bounded LRU eviction and recovers by recomputing evicted input', async () => {
    const subject = cache(8); // two float32 scalars
    let computes = 0;
    const run = (token: bigint) => subject.getOrCompute(
      'recording:1',
      identity({ inputIds: [token], attentionMask: [1n] }),
      async () => Float32Array.of(++computes),
    );
    await run(1n);
    await run(2n);
    await run(1n); // touch key 1, making key 2 oldest
    await run(3n); // evicts key 2
    await run(2n); // recompute
    expect(computes).toBe(4);
    expect(subject.stats().evictions).toBe(2);
    expect(subject.stats().bytes).toBeLessThanOrEqual(8);
  });

  it('fences an in-flight result when its recording is cleared', async () => {
    const subject = cache();
    let release!: (value: Float32Array) => void;
    const pending = subject.getOrCompute('recording:1', identity(), () => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    subject.clearRecording('recording:1');
    release(Float32Array.of(3));
    await expect(pending).resolves.toEqual(Float32Array.of(3));
    expect(subject.stats().entries).toBe(0);
  });

  it('also fences in-flight work when the entire cache is cleared', async () => {
    const subject = cache();
    let release!: (value: Float32Array) => void;
    const pending = subject.getOrCompute('recording:1', identity(), () => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    subject.clear();
    release(Float32Array.of(7));
    await expect(pending).resolves.toEqual(Float32Array.of(7));
    expect(subject.stats().entries).toBe(0);
  });

  it('serializes length-delimited identities without delimiter ambiguity', () => {
    const a = canonicalEncoderInput(identity({ artifactFingerprint: 'a:bc', preprocessingFingerprint: 'd' }));
    const b = canonicalEncoderInput(identity({ artifactFingerprint: 'a', preprocessingFingerprint: 'bc:d' }));
    expect(a).not.toBe(b);
  });
});
