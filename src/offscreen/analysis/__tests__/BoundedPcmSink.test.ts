import {
  drainDecodedAudioSamples,
  type DecodedAudioSampleLike,
  type PcmChunk,
} from '../audio/BoundedPcmSink';
import { MessageChannel } from 'node:worker_threads';

class FakeSample implements DecodedAudioSampleLike {
  closed = false;

  constructor(
    readonly timestamp: number,
    readonly sampleRate: number,
    readonly numberOfFrames: number,
    readonly numberOfChannels: number,
    private readonly values: number[],
  ) {}

  allocationSize(): number {
    return this.values.length * 4;
  }

  copyTo(destination: ArrayBufferView): void {
    new Float32Array(destination.buffer, destination.byteOffset, this.values.length).set(this.values);
  }

  close(): void {
    this.closed = true;
  }
}

async function* sequence(samples: FakeSample[]): AsyncGenerator<FakeSample> {
  for (const sample of samples) yield sample;
}

async function transferBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const { port1, port2 } = new MessageChannel();
  try {
    const received = new Promise<ArrayBuffer>((resolve) => {
      port2.once('message', (value: ArrayBuffer) => resolve(value));
    });
    port1.postMessage(buffer, [buffer]);
    return await received;
  } finally {
    port1.close();
    port2.close();
  }
}

describe('TECH-08 bounded PCM sink', () => {
  it('bounds consumer concurrency and reuses only released buffers', async () => {
    const samples = [
      new FakeSample(0, 4, 2, 1, [1, 2]),
      new FakeSample(0.5, 4, 2, 1, [3, 4]),
      new FakeSample(1, 4, 2, 1, [5, 6]),
    ];
    const releases: Array<() => void> = [];
    const seen: PcmChunk[] = [];
    let active = 0;
    let maxActive = 0;

    const work = drainDecodedAudioSamples(sequence(samples), async (chunk) => {
      seen.push({ ...chunk });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    }, { trackId: 7, poolSize: 2, bufferBytes: 16 });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(2);
    expect(maxActive).toBe(2);
    releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(3);
    releases.splice(0).forEach((release) => release());

    await expect(work).resolves.toMatchObject({ samples: 3, frames: 6, bytesCopied: 24 });
    expect(samples.every((sample) => sample.closed)).toBe(true);
  });

  it('reuses a buffer returned after transferable ownership round-trips through a consumer', async () => {
    const samples = [
      new FakeSample(0, 4, 1, 1, [1]),
      new FakeSample(0.25, 4, 1, 1, [2]),
    ];
    const seen: number[] = [];

    await expect(drainDecodedAudioSamples(sequence(samples), async (chunk) => {
      seen.push(new Float32Array(chunk.buffer, 0, chunk.byteLength / 4)[0]);
      const consumerOwned = await transferBuffer(chunk.buffer);
      expect(chunk.buffer.byteLength).toBe(0);
      return await transferBuffer(consumerOwned);
    }, { trackId: 9, poolSize: 1, bufferBytes: 8 })).resolves.toMatchObject({ samples: 2 });

    expect(seen).toEqual([1, 2]);
  });

  it('rejects a detached pooled buffer that the consumer does not return', async () => {
    const sample = new FakeSample(0, 4, 1, 1, [1]);
    await expect(drainDecodedAudioSamples(sequence([sample]), async (chunk) => {
      await transferBuffer(chunk.buffer);
    }, { trackId: 9, poolSize: 1, bufferBytes: 8 })).rejects.toThrow(/without returning equal capacity/);
  });

  it('preserves timestamps and marks real discontinuities', async () => {
    const chunks: PcmChunk[] = [];
    const samples = [
      new FakeSample(1, 10, 5, 1, [1, 2, 3, 4, 5]),
      new FakeSample(1.5, 10, 5, 1, [6, 7, 8, 9, 10]),
      new FakeSample(2.2, 10, 5, 1, [11, 12, 13, 14, 15]),
    ];
    const summary = await drainDecodedAudioSamples(sequence(samples), async (chunk) => {
      chunks.push({ ...chunk });
    }, { trackId: 3, poolSize: 1, bufferBytes: 32 });

    expect(chunks.map((chunk) => [chunk.timestampUs, chunk.durationUs, chunk.discontinuity])).toEqual([
      [1_000_000, 500_000, false],
      [1_500_000, 500_000, false],
      [2_200_000, 500_000, true],
    ]);
    expect(summary).toMatchObject({ discontinuities: 1, firstTimestampUs: 1_000_000, lastEndTimestampUs: 2_700_000 });
  });

  it('closes samples and cancels before handing more PCM to the consumer', async () => {
    const controller = new AbortController();
    const samples = [
      new FakeSample(0, 10, 1, 1, [1]),
      new FakeSample(0.1, 10, 1, 1, [2]),
    ];
    let consumed = 0;
    const work = drainDecodedAudioSamples(sequence(samples), async () => {
      consumed += 1;
      controller.abort();
    }, { trackId: 1, poolSize: 1, bufferBytes: 4, signal: controller.signal });

    await expect(work).rejects.toThrow(/cancelled/);
    expect(consumed).toBe(1);
    expect(samples[0].closed).toBe(true);
  });

  it('does not let a never-resolving consumer defeat cancellation', async () => {
    const controller = new AbortController();
    const abandoned: string[] = [];
    let entered = false;
    const work = drainDecodedAudioSamples(
      sequence([new FakeSample(0, 10, 1, 1, [1])]),
      async () => {
        entered = true;
        return await new Promise<ArrayBuffer | void>(() => {});
      },
      {
        trackId: 1,
        poolSize: 1,
        bufferBytes: 4,
        signal: controller.signal,
        consumerAckTimeoutMs: 60_000,
        onConsumerAbandoned: (_chunk, reason) => { abandoned.push(reason); },
      },
    );
    while (!entered) await Promise.resolve();
    controller.abort();

    await expect(work).rejects.toThrow(/cancelled/);
    expect(abandoned).toEqual(['aborted']);
  });

  it('abandons a wedged consumer after the configured ACK deadline', async () => {
    const abandoned: string[] = [];
    await expect(drainDecodedAudioSamples(
      sequence([new FakeSample(0, 10, 1, 1, [1])]),
      async () => await new Promise<ArrayBuffer | void>(() => {}),
      {
        trackId: 1,
        poolSize: 1,
        bufferBytes: 4,
        consumerAckTimeoutMs: 5,
        onConsumerAbandoned: (_chunk, reason) => { abandoned.push(reason); },
      },
    )).rejects.toThrow(/did not acknowledge/);
    expect(abandoned).toEqual(['timeout']);
  });

  it('rejects decoded samples larger than the fixed pool capacity', async () => {
    const sample = new FakeSample(0, 48_000, 4, 2, new Array(8).fill(0));
    await expect(drainDecodedAudioSamples(sequence([sample]), async () => {}, {
      trackId: 1,
      poolSize: 1,
      bufferBytes: 16,
    })).rejects.toThrow(/needs 32 bytes/);
    expect(sample.closed).toBe(true);
  });
});
