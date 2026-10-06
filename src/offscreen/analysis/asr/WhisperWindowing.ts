import type { ResampledPcmBlock } from './StreamingSincResampler';

export type WhisperAudioWindow = {
  samples: Float32Array;
  sampleRate: 16_000;
  startUs: number;
  endUs: number;
  discontinuity: boolean;
};

export type WhisperWindowConfig = {
  /** Explicit experiment input. ADR-0009 does not freeze a shipping chunk size. */
  windowSeconds: number;
  /** Explicit overlap; must be smaller than the window. */
  overlapSeconds: number;
};

/**
 * Bounded overlap window assembler. It never joins across a media-time gap.
 * The retained overlap is emitted again only when fresh samples follow it.
 */
export class WhisperWindowAssembler {
  private readonly windowSamples: number;
  private readonly overlapSamples: number;
  private readonly stepSamples: number;
  private buffered: number[] = [];
  private startUs: number | undefined;
  private coveredPrefix = 0;
  private nextWindowDiscontinuity = false;

  constructor(config: WhisperWindowConfig) {
    if (!Number.isFinite(config.windowSeconds) || config.windowSeconds <= 0 || config.windowSeconds > 30) {
      throw new Error(`Whisper window must be in (0, 30] seconds, got ${config.windowSeconds}`);
    }
    if (!Number.isFinite(config.overlapSeconds) || config.overlapSeconds < 0
      || config.overlapSeconds >= config.windowSeconds) {
      throw new Error(`Whisper overlap must be in [0, window), got ${config.overlapSeconds}`);
    }
    this.windowSamples = Math.round(config.windowSeconds * 16_000);
    this.overlapSamples = Math.round(config.overlapSeconds * 16_000);
    this.stepSamples = this.windowSamples - this.overlapSamples;
    if (this.stepSamples < 1) throw new Error('Whisper overlap leaves no forward progress');
  }

  push(block: ResampledPcmBlock): WhisperAudioWindow[] {
    if (block.sampleRate !== 16_000) throw new Error(`Whisper requires 16 kHz PCM, got ${block.sampleRate}`);
    const result: WhisperAudioWindow[] = [];

    if (block.discontinuity && this.buffered.length) {
      const tail = this.flushTail();
      if (tail) result.push(tail);
      this.reset();
    }

    if (this.startUs == null) {
      this.startUs = block.timestampUs;
      this.nextWindowDiscontinuity = block.discontinuity;
    } else {
      const expectedUs = this.startUs + Math.round(this.buffered.length * 1_000_000 / 16_000);
      const toleranceUs = Math.ceil(2 * 1_000_000 / 16_000);
      if (Math.abs(block.timestampUs - expectedUs) > toleranceUs) {
        const tail = this.flushTail();
        if (tail) result.push(tail);
        this.reset();
        this.startUs = block.timestampUs;
        this.nextWindowDiscontinuity = true;
      }
    }

    for (const value of block.samples) {
      if (!Number.isFinite(value)) throw new Error('Whisper window received non-finite PCM');
      this.buffered.push(value);
    }
    result.push(...this.emitFullWindows());
    return result;
  }

  finish(): WhisperAudioWindow[] {
    const tail = this.flushTail();
    this.reset();
    return tail ? [tail] : [];
  }

  private emitFullWindows(): WhisperAudioWindow[] {
    const result: WhisperAudioWindow[] = [];
    while (this.buffered.length >= this.windowSamples) {
      result.push(this.windowFrom(this.buffered.slice(0, this.windowSamples)));
      this.buffered.splice(0, this.stepSamples);
      this.startUs = this.startUs! + Math.round(this.stepSamples * 1_000_000 / 16_000);
      this.coveredPrefix = this.overlapSamples;
      this.nextWindowDiscontinuity = false;
    }
    return result;
  }

  private flushTail(): WhisperAudioWindow | undefined {
    if (!this.buffered.length || this.buffered.length <= this.coveredPrefix) return undefined;
    return this.windowFrom(this.buffered);
  }

  private windowFrom(values: readonly number[]): WhisperAudioWindow {
    const startUs = this.startUs!;
    return {
      samples: Float32Array.from(values),
      sampleRate: 16_000,
      startUs,
      endUs: startUs + Math.round(values.length * 1_000_000 / 16_000),
      discontinuity: this.nextWindowDiscontinuity,
    };
  }

  private reset(): void {
    this.buffered = [];
    this.startUs = undefined;
    this.coveredPrefix = 0;
    this.nextWindowDiscontinuity = false;
  }
}

export type WhisperRelativeWord = {
  text: string;
  timestamp: [number, number];
};

export type WhisperTimedWord = {
  text: string;
  startUs: number;
  endUs: number;
};

export function mapWhisperWordsToMediaTime(
  window: WhisperAudioWindow,
  chunks: readonly WhisperRelativeWord[],
): WhisperTimedWord[] {
  return chunks.map((chunk) => {
    const startUs = window.startUs + Math.round(chunk.timestamp[0] * 1_000_000);
    const endUs = window.startUs + Math.round(chunk.timestamp[1] * 1_000_000);
    if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || endUs < startUs) {
      throw new Error('Whisper returned an invalid word timestamp');
    }
    return {
      text: chunk.text,
      startUs: Math.max(window.startUs, startUs),
      endUs: Math.min(window.endUs, endUs),
    };
  }).filter((word) => word.endUs >= word.startUs);
}

/**
 * Removes only the same recognized word at the same media time. Repeated text
 * elsewhere remains untouched, so "yes yes" cannot disappear just because an
 * overlap also contained "yes".
 */
export function mergeWhisperOverlap(
  accepted: WhisperTimedWord[],
  incoming: readonly WhisperTimedWord[],
  sameTimeToleranceMs: number,
  previousWindow?: Pick<WhisperAudioWindow, 'startUs' | 'endUs'>,
  incomingWindow?: Pick<WhisperAudioWindow, 'startUs' | 'endUs'>,
): WhisperTimedWord[] {
  if (!Number.isFinite(sameTimeToleranceMs) || sameTimeToleranceMs < 0 || sameTimeToleranceMs > 1_000) {
    throw new Error(`Whisper overlap tolerance must be in 0..1000 ms, got ${sameTimeToleranceMs}`);
  }
  const toleranceUs = sameTimeToleranceMs * 1_000;
  if (!previousWindow || !incomingWindow) {
    return [...accepted, ...incoming].sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  }

  const overlapStartUs = Math.max(previousWindow.startUs, incomingWindow.startUs);
  const overlapEndUs = Math.min(previousWindow.endUs, incomingWindow.endUs);
  if (overlapEndUs <= overlapStartUs) {
    return [...accepted, ...incoming].sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
  }

  const previousOverlap = accepted.filter((word) => intersects(word, overlapStartUs, overlapEndUs));
  const incomingOverlap = incoming.filter((word) => intersects(word, overlapStartUs, overlapEndUs));
  // The duplicated ASR material is a suffix of the previous window and a
  // prefix of the next one. Match that short sequence monotonically instead of
  // globally deleting equal nearby words, which would collapse legitimate
  // speech such as "yes yes".
  let duplicatePrefix = 0;
  const max = Math.min(previousOverlap.length, incomingOverlap.length);
  for (let length = max; length >= 1; length -= 1) {
    const previousStart = previousOverlap.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      const left = previousOverlap[previousStart + index];
      const right = incomingOverlap[index];
      if (normalizeWord(left.text) !== normalizeWord(right.text)
        || intervalDistanceUs(left, right) > toleranceUs) {
        matches = false;
        break;
      }
    }
    if (matches) {
      duplicatePrefix = length;
      break;
    }
  }
  const duplicates = new Set(incomingOverlap.slice(0, duplicatePrefix));
  return [...accepted, ...incoming.filter((word) => !duplicates.has(word))]
    .sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
}

function intersects(word: WhisperTimedWord, startUs: number, endUs: number): boolean {
  return word.endUs >= startUs && word.startUs <= endUs;
}

function intervalDistanceUs(a: WhisperTimedWord, b: WhisperTimedWord): number {
  if (a.endUs >= b.startUs && b.endUs >= a.startUs) return 0;
  return a.endUs < b.startUs ? b.startUs - a.endUs : a.startUs - b.endUs;
}

function normalizeWord(text: string): string {
  return text.trim().normalize('NFKC').toLowerCase();
}
