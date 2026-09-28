import type { TranscriptSegment } from '../../transcript';
import { buildTokenBoundedContextWindows } from '../tokenBoundedWindows';

const CONFIG = { windowUtterances: 4, windowStride: 4 };

/** Mimics a prefix plus two special tokens while making each code point one token. */
const tokenLength = (text: string) => 3 + [...text.trim()].length;

describe('buildTokenBoundedContextWindows', () => {
  it('preserves an ordinary window while recording its exact token length', () => {
    const segments: TranscriptSegment[] = [
      { tStartMs: 0, tEndMs: 1_000, speaker: 'Ada', text: 'alpha' },
      { tStartMs: 1_000, tEndMs: 2_000, speaker: 'Grace', text: 'beta' },
    ];

    const [window] = buildTokenBoundedContextWindows(segments, CONFIG, 64, tokenLength);

    expect(window.text).toBe('alpha beta');
    expect(window.tokenLength).toBe(tokenLength('alpha beta'));
    expect(window.sourceSpans.map((span) => [span.segmentIndex, span.textStart, span.textEnd]))
      .toEqual([[0, 0, 5], [1, 0, 4]]);
  });

  it('losslessly splits one overlong source segment without inventing fine timing', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta';
    const segments: TranscriptSegment[] = [{
      tStartMs: 1_000,
      tEndMs: 9_000,
      speaker: 'Ada',
      text,
    }];

    const windows = buildTokenBoundedContextWindows(segments, CONFIG, 15, tokenLength);

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.tokenLength! <= 15)).toBe(true);
    const spans = windows.flatMap((window) => window.sourceSpans);
    expect(spans[0].textStart).toBe(0);
    expect(spans[spans.length - 1].textEnd).toBe(text.length);
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index].textStart).toBe(spans[index - 1].textEnd);
    }
    expect(spans.map((span) => text.slice(span.textStart, span.textEnd)).join('')).toBe(text);
    expect(spans.every((span) => (
      span.tStartMs === 1_000
      && span.tEndMs === 9_000
      && span.speaker === 'Ada'
      && span.timingFidelity === 'enclosing-segment'
    ))).toBe(true);
  });

  it('never splits a surrogate pair while re-windowing a no-space source', () => {
    const text = '😀😀😀😀😀😀😀😀😀😀';
    const windows = buildTokenBoundedContextWindows(
      [{ tStartMs: 0, tEndMs: 1_000, text }],
      CONFIG,
      7,
      tokenLength,
    );

    const reconstructed = windows
      .flatMap((window) => window.sourceSpans)
      .map((span) => text.slice(span.textStart, span.textEnd))
      .join('');
    expect(reconstructed).toBe(text);
    expect(windows.every((window) => window.tokenLength! <= 7)).toBe(true);
  });

  it('does not assume token counts grow monotonically with source length', () => {
    const text = 'abcdefghijk';
    const jaggedLength = (value: string) => {
      const length = [...value].length;
      if (length === 4) return 99;
      return length + 2;
    };

    const windows = buildTokenBoundedContextWindows(
      [{ tStartMs: 0, tEndMs: 1_000, text }],
      CONFIG,
      10,
      jaggedLength,
    );

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.tokenLength! <= 10)).toBe(true);
    expect(windows
      .flatMap((window) => window.sourceSpans)
      .map((span) => text.slice(span.textStart, span.textEnd))
      .join('')).toBe(text);
  });

  it('re-packs source turns while retaining ordered speaker and media coverage', () => {
    const segments: TranscriptSegment[] = [
      { tStartMs: 0, tEndMs: 7_000, speaker: 'Ada', text: 'alpha alpha' },
      { tStartMs: 2_000, tEndMs: 3_000, speaker: 'Grace', text: 'beta beta' },
      { tStartMs: 4_000, tEndMs: 5_000, speaker: 'Ada', text: 'gamma gamma' },
      { tStartMs: 6_000, tEndMs: 8_000, speaker: 'Linus', text: 'delta delta' },
    ];

    const windows = buildTokenBoundedContextWindows(segments, CONFIG, 17, tokenLength);

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => window.tokenLength! <= 17)).toBe(true);
    const seen = windows.flatMap((window) => window.sourceSpans.map((span) => span.segmentIndex));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen)).toEqual(new Set([0, 1, 2, 3]));
    expect(Math.min(...windows.map((window) => window.tStartMs))).toBe(0);
    expect(Math.max(...windows.map((window) => window.tEndMs))).toBe(8_000);
  });
});
