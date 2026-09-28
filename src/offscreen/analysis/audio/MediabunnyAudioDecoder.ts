import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Input,
} from 'mediabunny';
import {
  drainDecodedAudioSamples,
  type BoundedPcmSinkOptions,
  type PcmChunk,
  type PcmSinkSummary,
} from './BoundedPcmSink';

export type MediabunnyDecodeOptions = Omit<BoundedPcmSinkOptions, 'trackId'> & {
  sourceCacheBytes?: number;
  trackNumber?: number;
};

export type MediabunnyDecodeSummary = PcmSinkSummary & {
  mimeType: string;
  trackId: number;
  trackNumber: number;
  codec: string | null;
  codecParameter: string | null;
  sourceSampleRate: number;
  sourceChannels: number;
};

const DEFAULT_SOURCE_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * TECH-08 feasibility adapter: sealed File -> Mediabunny -> WebCodecs -> bounded PCM.
 * It deliberately does not resample, downmix, run VAD, or invoke ASR.
 */
export async function decodeSealedAudioFile(
  file: File,
  consume: (chunk: PcmChunk) => Promise<ArrayBuffer | void>,
  options: MediabunnyDecodeOptions,
): Promise<MediabunnyDecodeSummary> {
  if (!(file instanceof Blob) || file.size < 1) throw new Error('Audio decoding requires a non-empty sealed File');
  const sourceCacheBytes = options.sourceCacheBytes ?? DEFAULT_SOURCE_CACHE_BYTES;
  if (!Number.isSafeInteger(sourceCacheBytes) || sourceCacheBytes < 0) {
    throw new Error('Mediabunny source cache bound must be a non-negative integer');
  }

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: sourceCacheBytes }),
  });
  const abort = () => input.dispose();
  options.signal?.addEventListener('abort', abort, { once: true });

  let iterator: AsyncGenerator<import('mediabunny').AudioSample, void, unknown> | undefined;
  try {
    if (options.signal?.aborted) throw new Error('Audio decoding was cancelled');
    if (!await input.canRead()) throw new Error('Mediabunny cannot read this recording container');
    const tracks = await input.getAudioTracks();
    const selected = options.trackNumber == null
      ? await input.getPrimaryAudioTrack()
      : tracks.find((track) => track.number === options.trackNumber) ?? null;
    if (!selected) throw new Error('Recording contains no selected audio track');
    if (!await selected.canDecode()) {
      const codec = await selected.getCodecParameterString();
      throw new Error(`Browser cannot decode recording audio codec${codec ? ` ${codec}` : ''}`);
    }

    const sink = new AudioSampleSink(selected);
    iterator = sink.samples();
    const pcm = await drainDecodedAudioSamples(iterator, consume, {
      trackId: selected.id,
      poolSize: options.poolSize,
      bufferBytes: options.bufferBytes,
      signal: options.signal,
      discontinuityToleranceFrames: options.discontinuityToleranceFrames,
    });

    return {
      ...pcm,
      mimeType: await input.getMimeType(),
      trackId: selected.id,
      trackNumber: selected.number,
      codec: await selected.getCodec(),
      codecParameter: await selected.getCodecParameterString(),
      sourceSampleRate: await selected.getSampleRate(),
      sourceChannels: await selected.getNumberOfChannels(),
    };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await iterator?.return?.();
    input.dispose();
  }
}
