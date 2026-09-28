export type DecodedAudioSampleLike = {
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  allocationSize(options: { planeIndex: number; format: 'f32' }): number;
  copyTo(destination: ArrayBufferView, options: { planeIndex: number; format: 'f32' }): void;
  close(): void;
};

export type PcmChunk = {
  trackId: number;
  format: 'f32-interleaved';
  buffer: ArrayBuffer;
  byteLength: number;
  sampleRate: number;
  channels: number;
  frames: number;
  timestampUs: number;
  durationUs: number;
  discontinuity: boolean;
};

export type BoundedPcmSinkOptions = {
  trackId: number;
  poolSize: number;
  bufferBytes: number;
  signal?: AbortSignal;
  discontinuityToleranceFrames?: number;
};

export type PcmSinkSummary = {
  samples: number;
  frames: number;
  bytesCopied: number;
  discontinuities: number;
  firstTimestampUs?: number;
  lastEndTimestampUs?: number;
};

/**
 * Drains decoded samples through a fixed-capacity PCM pool.
 *
 * A buffer returns to the pool only after the consumer promise settles. When
 * the consumer is another worker, that promise should resolve on its explicit
 * release/ack rather than on `postMessage`, preserving real backpressure.
 */
export async function drainDecodedAudioSamples(
  samples: AsyncIterable<DecodedAudioSampleLike>,
  consume: (chunk: PcmChunk) => Promise<void>,
  options: BoundedPcmSinkOptions,
): Promise<PcmSinkSummary> {
  const { poolSize, bufferBytes } = options;
  if (!Number.isSafeInteger(poolSize) || poolSize < 1) throw new Error('PCM pool size must be a positive integer');
  if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 4 || bufferBytes % 4 !== 0) {
    throw new Error('PCM buffer capacity must be a positive multiple of four bytes');
  }

  const free = Array.from({ length: poolSize }, () => new ArrayBuffer(bufferBytes));
  const inFlight = new Set<Promise<void>>();
  const summary: PcmSinkSummary = { samples: 0, frames: 0, bytesCopied: 0, discontinuities: 0 };
  let expectedTimestampSeconds: number | undefined;

  const waitForCapacity = async (): Promise<ArrayBuffer> => {
    while (!free.length) {
      if (!inFlight.size) throw new Error('PCM pool lost capacity');
      await Promise.race(inFlight);
    }
    return free.pop()!;
  };

  try {
    for await (const sample of samples) {
      assertNotAborted(options.signal);
      let copiedBytes = 0;
      let chunk: PcmChunk;
      const buffer = await waitForCapacity();
      try {
        validateSample(sample);
        copiedBytes = sample.allocationSize({ planeIndex: 0, format: 'f32' });
        if (!Number.isSafeInteger(copiedBytes) || copiedBytes < 1 || copiedBytes > bufferBytes || copiedBytes % 4 !== 0) {
          throw new Error(`Decoded PCM sample needs ${copiedBytes} bytes, pool capacity is ${bufferBytes}`);
        }

        sample.copyTo(new Uint8Array(buffer, 0, copiedBytes), { planeIndex: 0, format: 'f32' });
        const durationSeconds = sample.numberOfFrames / sample.sampleRate;
        const toleranceSeconds = (options.discontinuityToleranceFrames ?? 1) / sample.sampleRate;
        const discontinuity = expectedTimestampSeconds != null
          && Math.abs(sample.timestamp - expectedTimestampSeconds) > toleranceSeconds;

        chunk = {
          trackId: options.trackId,
          format: 'f32-interleaved',
          buffer,
          byteLength: copiedBytes,
          sampleRate: sample.sampleRate,
          channels: sample.numberOfChannels,
          frames: sample.numberOfFrames,
          timestampUs: Math.round(sample.timestamp * 1_000_000),
          durationUs: Math.round(durationSeconds * 1_000_000),
          discontinuity,
        };
        expectedTimestampSeconds = sample.timestamp + durationSeconds;
      } finally {
        sample.close();
      }

      summary.samples += 1;
      summary.frames += chunk.frames;
      summary.bytesCopied += copiedBytes;
      if (chunk.discontinuity) summary.discontinuities += 1;
      summary.firstTimestampUs ??= chunk.timestampUs;
      summary.lastEndTimestampUs = chunk.timestampUs + chunk.durationUs;

      let work!: Promise<void>;
      work = (async () => {
        try {
          await consume(chunk);
        } finally {
          free.push(buffer);
          inFlight.delete(work);
        }
      })();
      inFlight.add(work);

      if (inFlight.size >= poolSize) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    assertNotAborted(options.signal);
    return summary;
  } catch (error) {
    await Promise.allSettled(inFlight);
    throw error;
  }
}

function validateSample(sample: DecodedAudioSampleLike): void {
  if (!Number.isFinite(sample.timestamp)) throw new Error('Decoded PCM sample has a non-finite timestamp');
  if (!Number.isSafeInteger(sample.sampleRate) || sample.sampleRate < 1) throw new Error('Decoded PCM sample has an invalid rate');
  if (!Number.isSafeInteger(sample.numberOfFrames) || sample.numberOfFrames < 1) throw new Error('Decoded PCM sample has no frames');
  if (!Number.isSafeInteger(sample.numberOfChannels) || sample.numberOfChannels < 1) throw new Error('Decoded PCM sample has no channels');
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Audio decoding was cancelled');
}
