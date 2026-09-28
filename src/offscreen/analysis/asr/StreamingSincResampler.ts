import type { PcmChunk } from '../audio/BoundedPcmSink';

export type ResampledPcmBlock = {
  samples: Float32Array;
  sampleRate: number;
  timestampUs: number;
  discontinuity: boolean;
};

/**
 * Stateful bounded mono resampler for the TECH-09 Whisper control.
 *
 * The symmetric windowed-sinc kernel keeps future source context until it is
 * available instead of resetting a browser resampler at every decoded packet.
 * Missing context exists only at real stream/discontinuity edges, where the
 * edge sample is extended. The cut-off follows the lower Nyquist rate so
 * 48 kHz -> 16 kHz does not use a plain interpolator that aliases speech-band
 * energy into Whisper's input.
 */
export class StreamingSincResampler {
  private sourceRate = 0;
  private channels = 0;
  private originUs = 0;
  private sourceStart = 0;
  private totalSourceFrames = 0;
  private nextOutputFrame = 0;
  private source: number[] = [];
  private firstSample = 0;
  private lastSample = 0;
  private emittedInSegment = false;
  private segmentDiscontinuity = false;

  constructor(
    readonly targetRate = 16_000,
    private readonly kernelLobes = 8,
  ) {
    if (!Number.isSafeInteger(targetRate) || targetRate < 1) {
      throw new Error(`Resampler target rate must be a positive integer, got ${targetRate}`);
    }
    if (!Number.isSafeInteger(kernelLobes) || kernelLobes < 2 || kernelLobes > 64) {
      throw new Error(`Resampler kernel lobes must be an integer in 2..64, got ${kernelLobes}`);
    }
  }

  push(chunk: PcmChunk): ResampledPcmBlock[] {
    const result: ResampledPcmBlock[] = [];
    this.validateChunk(chunk);

    if (this.sourceRate) {
      const expectedUs = this.originUs + Math.round(this.totalSourceFrames * 1_000_000 / this.sourceRate);
      const toleranceUs = Math.ceil(2 * 1_000_000 / this.sourceRate);
      const timingBreak = Math.abs(chunk.timestampUs - expectedUs) > toleranceUs;
      if (chunk.discontinuity || timingBreak || chunk.sampleRate !== this.sourceRate || chunk.channels !== this.channels) {
        const tail = this.emit(true);
        if (tail) result.push(tail);
        this.resetSegment();
      }
    }

    if (!this.sourceRate) {
      this.sourceRate = chunk.sampleRate;
      this.channels = chunk.channels;
      this.originUs = chunk.timestampUs;
      this.segmentDiscontinuity = chunk.discontinuity || result.length > 0;
    }

    const input = new Float32Array(chunk.buffer, 0, chunk.byteLength / Float32Array.BYTES_PER_ELEMENT);
    const frameCount = chunk.frames;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let mono = 0;
      const offset = frame * chunk.channels;
      for (let channel = 0; channel < chunk.channels; channel += 1) mono += input[offset + channel];
      mono /= chunk.channels;
      if (!Number.isFinite(mono)) throw new Error('Resampler received non-finite PCM');
      if (!this.totalSourceFrames && frame === 0) this.firstSample = mono;
      this.lastSample = mono;
      this.source.push(mono);
    }
    this.totalSourceFrames += frameCount;

    const block = this.emit(false);
    if (block) result.push(block);
    return result;
  }

  finish(): ResampledPcmBlock[] {
    if (!this.sourceRate) return [];
    const tail = this.emit(true);
    this.resetSegment();
    return tail ? [tail] : [];
  }

  private emit(final: boolean): ResampledPcmBlock | undefined {
    if (!this.sourceRate || !this.totalSourceFrames) return undefined;

    const cutoff = Math.min(1, this.targetRate / this.sourceRate);
    const halfWidth = Math.ceil(this.kernelLobes / cutoff);
    const startOutputFrame = this.nextOutputFrame;
    const values: number[] = [];
    const finalOutputFrames = Math.max(1, Math.round(this.totalSourceFrames * this.targetRate / this.sourceRate));

    while (this.nextOutputFrame < finalOutputFrames) {
      const sourcePosition = this.nextOutputFrame * this.sourceRate / this.targetRate;
      if (!final && Math.ceil(sourcePosition + halfWidth) >= this.totalSourceFrames) break;

      const first = Math.floor(sourcePosition - halfWidth);
      const last = Math.ceil(sourcePosition + halfWidth);
      let weighted = 0;
      let weightTotal = 0;
      for (let sourceFrame = first; sourceFrame <= last; sourceFrame += 1) {
        const delta = sourcePosition - sourceFrame;
        if (Math.abs(delta) > halfWidth) continue;
        const window = 0.5 * (1 + Math.cos(Math.PI * delta / halfWidth));
        const scaled = delta * cutoff;
        const sinc = Math.abs(scaled) < 1e-12
          ? 1
          : Math.sin(Math.PI * scaled) / (Math.PI * scaled);
        const weight = cutoff * sinc * window;
        weighted += this.sampleAt(sourceFrame) * weight;
        weightTotal += weight;
      }
      if (!Number.isFinite(weighted) || Math.abs(weightTotal) < 1e-12) {
        throw new Error('Resampler kernel produced an invalid output');
      }
      values.push(Math.fround(weighted / weightTotal));
      this.nextOutputFrame += 1;
    }

    this.discardConsumedPrefix(halfWidth);
    if (!values.length) return undefined;

    const block: ResampledPcmBlock = {
      samples: Float32Array.from(values),
      sampleRate: this.targetRate,
      timestampUs: this.originUs + Math.round(startOutputFrame * 1_000_000 / this.targetRate),
      discontinuity: !this.emittedInSegment && this.segmentDiscontinuity,
    };
    this.emittedInSegment = true;
    return block;
  }

  private sampleAt(index: number): number {
    if (index < 0) return this.firstSample;
    if (index >= this.totalSourceFrames) return this.lastSample;
    const local = index - this.sourceStart;
    if (local < 0 || local >= this.source.length) {
      throw new Error(`Resampler discarded source frame ${index} too early`);
    }
    return this.source[local];
  }

  private discardConsumedPrefix(halfWidth: number): void {
    const nextSourcePosition = this.nextOutputFrame * this.sourceRate / this.targetRate;
    const keepFrom = Math.max(0, Math.floor(nextSourcePosition - halfWidth) - 1);
    const remove = Math.min(this.source.length, Math.max(0, keepFrom - this.sourceStart));
    if (!remove) return;
    this.source.splice(0, remove);
    this.sourceStart += remove;
  }

  private resetSegment(): void {
    this.sourceRate = 0;
    this.channels = 0;
    this.originUs = 0;
    this.sourceStart = 0;
    this.totalSourceFrames = 0;
    this.nextOutputFrame = 0;
    this.source = [];
    this.firstSample = 0;
    this.lastSample = 0;
    this.emittedInSegment = false;
    this.segmentDiscontinuity = false;
  }

  private validateChunk(chunk: PcmChunk): void {
    if (chunk.format !== 'f32-interleaved') throw new Error(`Unsupported PCM format ${chunk.format}`);
    if (!Number.isSafeInteger(chunk.sampleRate) || chunk.sampleRate < 1) throw new Error('PCM sample rate is invalid');
    if (!Number.isSafeInteger(chunk.channels) || chunk.channels < 1) throw new Error('PCM channel count is invalid');
    if (!Number.isSafeInteger(chunk.frames) || chunk.frames < 1) throw new Error('PCM frame count is invalid');
    const expectedBytes = chunk.frames * chunk.channels * Float32Array.BYTES_PER_ELEMENT;
    if (chunk.byteLength !== expectedBytes || chunk.byteLength > chunk.buffer.byteLength) {
      throw new Error(`PCM byte length ${chunk.byteLength} does not match ${expectedBytes}`);
    }
  }
}
