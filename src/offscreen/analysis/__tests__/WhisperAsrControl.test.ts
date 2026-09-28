import type { PcmChunk } from '../audio/BoundedPcmSink';
import { StreamingSincResampler } from '../asr/StreamingSincResampler';
import {
  WhisperAsrControl,
  type WhisperWindowTranscriber,
} from '../asr/WhisperAsrControl';
import {
  WhisperWindowAssembler,
  mergeWhisperOverlap,
  type WhisperTimedWord,
} from '../asr/WhisperWindowing';

function pcm(values: number[], overrides: Partial<PcmChunk> = {}): PcmChunk {
  const floats = Float32Array.from(values);
  return {
    trackId: 1,
    format: 'f32-interleaved',
    buffer: floats.buffer,
    byteLength: floats.byteLength,
    sampleRate: 16_000,
    channels: 1,
    frames: floats.length,
    timestampUs: 0,
    durationUs: Math.round(floats.length * 1_000_000 / 16_000),
    discontinuity: false,
    ...overrides,
  };
}

describe('TECH-09 bounded Whisper control', () => {
  it('statefully resamples 48 kHz stereo to 16 kHz mono without resetting packet edges', () => {
    const resampler = new StreamingSincResampler(16_000, 4);
    const firstFrames = 480;
    const secondFrames = 480;
    const stereo = (frames: number) => Array.from({ length: frames * 2 }, (_, index) => index % 2 ? 0.25 : 0.75);
    const first = pcm(stereo(firstFrames), {
      sampleRate: 48_000,
      channels: 2,
      frames: firstFrames,
      timestampUs: 2_000_000,
      durationUs: 10_000,
    });
    const second = pcm(stereo(secondFrames), {
      sampleRate: 48_000,
      channels: 2,
      frames: secondFrames,
      timestampUs: 2_010_000,
      durationUs: 10_000,
    });

    const output = [...resampler.push(first), ...resampler.push(second), ...resampler.finish()];
    const samples = output.flatMap((block) => [...block.samples]);
    expect(samples).toHaveLength(320);
    expect(Math.max(...samples.map((value) => Math.abs(value - 0.5)))).toBeLessThan(1e-5);
    expect(output[0].timestampUs).toBe(2_000_000);
  });

  it('never joins windows across a discontinuity', () => {
    const assembler = new WhisperWindowAssembler({ windowSeconds: 0.01, overlapSeconds: 0.0025 });
    const first = assembler.push({
      samples: new Float32Array(120).fill(0.1),
      sampleRate: 16_000,
      timestampUs: 0,
      discontinuity: false,
    });
    expect(first).toEqual([]);
    const second = assembler.push({
      samples: new Float32Array(120).fill(0.2),
      sampleRate: 16_000,
      timestampUs: 1_000_000,
      discontinuity: true,
    });
    expect(second).toHaveLength(1);
    expect(second[0].startUs).toBe(0);
    expect(second[0].endUs).toBe(7_500);
    const tail = assembler.finish();
    expect(tail).toHaveLength(1);
    expect(tail[0].startUs).toBe(1_000_000);
  });

  it('deduplicates only the same word at the same overlap time', () => {
    const accepted: WhisperTimedWord[] = [
      { text: ' yes', startUs: 1_000_000, endUs: 1_200_000 },
      { text: ' yes', startUs: 2_000_000, endUs: 2_200_000 },
    ];
    const merged = mergeWhisperOverlap(accepted, [
      { text: ' YES', startUs: 1_050_000, endUs: 1_210_000 },
      { text: ' yes', startUs: 3_000_000, endUs: 3_200_000 },
    ], 100);
    expect(merged).toEqual([
      accepted[0],
      accepted[1],
      { text: ' yes', startUs: 3_000_000, endUs: 3_200_000 },
    ]);
  });

  it('serializes bounded windows and maps Whisper word timestamps to media time', async () => {
    let active = 0;
    let maxActive = 0;
    const starts: number[] = [];
    const transcriber: WhisperWindowTranscriber = {
      async transcribe(window) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        starts.push(window.startUs);
        const text = ` word-${starts.length}`;
        await Promise.resolve();
        active -= 1;
        return {
          text,
          words: [{ text, timestamp: [0, Math.min(0.1, (window.endUs - window.startUs) / 1_000_000)] }],
        };
      },
    };
    const control = new WhisperAsrControl(transcriber, {
      windowSeconds: 0.02,
      overlapSeconds: 0.005,
      sameTimeToleranceMs: 20,
      resamplerKernelLobes: 2,
      language: 'ukrainian',
    });

    await control.consume(pcm(new Array(640).fill(0.1), { timestampUs: 5_000_000 }));
    const result = await control.finish();

    expect(maxActive).toBe(1);
    expect(starts).toEqual([5_000_000, 5_015_000, 5_030_000]);
    expect(result.windows).toBe(3);
    expect(result.words[0].startUs).toBe(5_000_000);
    expect(result.words[1].startUs).toBe(5_015_000);
    expect(result.words[2].startUs).toBe(5_030_000);
  });
});
