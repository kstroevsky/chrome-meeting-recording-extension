import { buildContextWindows } from '../windows';
import { startsWithDiscourseCue } from '../types';
import type { TranscriptSegment } from '../../transcript';

const utterance = (i: number, text: string, speaker = 'Ada'): TranscriptSegment =>
  ({ tStartMs: i * 1_000, tEndMs: i * 1_000 + 800, speaker, text });

const transcript = (count: number) =>
  Array.from({ length: count }, (_, i) => utterance(i, `line ${i}`));

const CONFIG = { windowUtterances: 3, windowStride: 2 };

describe('startsWithDiscourseCue', () => {
  it('matches a cue that opens the turn, in any case or punctuation', () => {
    expect(startsWithDiscourseCue('Anyway, about Redis')).toBe(true);
    expect(startsWithDiscourseCue('  by the way — did you see')).toBe(true);
    expect(startsWithDiscourseCue('Moving on')).toBe(true);
    expect(startsWithDiscourseCue('speaking of, the pool')).toBe(true);
  });

  it('does not match a cue buried mid-sentence', () => {
    // "we could do it anyway" is not a topic change.
    expect(startsWithDiscourseCue('we could do it anyway')).toBe(false);
  });

  it('requires a word boundary after the cue', () => {
    expect(startsWithDiscourseCue('movingonward we deploy')).toBe(false);
    expect(startsWithDiscourseCue('anywayside')).toBe(false);
  });

  it('matches Russian and Ukrainian cues (D-18)', () => {
    expect(startsWithDiscourseCue('кстати, про redis')).toBe(true);
    expect(startsWithDiscourseCue('Идём дальше')).toBe(true);
    expect(startsWithDiscourseCue('до речі, щодо релізу')).toBe(true);
    expect(startsWithDiscourseCue('Наступне питання')).toBe(true);
  });

  it('applies the word boundary to Cyrillic too', () => {
    // An ASCII-only boundary class would treat "ь" as a break and match here.
    expect(startsWithDiscourseCue('кстатиь про redis')).toBe(false);
    expect(startsWithDiscourseCue('загаломний підхід')).toBe(false);
  });

  it('still ignores a non-English cue buried mid-sentence', () => {
    expect(startsWithDiscourseCue('мы обсудим это кстати позже')).toBe(false);
  });
});

describe('buildContextWindows', () => {
  it('slides a window across the transcript at the configured stride', () => {
    const windows = buildContextWindows(transcript(7), CONFIG);
    expect(windows.map((w) => [w.startIndex, w.endIndex])).toEqual([[0, 3], [2, 5], [4, 7]]);
  });

  it('honours a stride shorter than the window, which overlaps them', () => {
    // Expressible, and not what the calibrated configuration uses: 4B found
    // overlapping boundary contexts smear the signal. See the disjointness
    // suite below.
    const windows = buildContextWindows(transcript(5), { windowUtterances: 3, windowStride: 1 });
    expect(windows.map((w) => w.startIndex)).toEqual([0, 1, 2]);
  });

  it('covers a trailing remainder the stride would otherwise skip', () => {
    // 8 utterances, window 3, stride 3 → [0,3) [3,6) leaves 6 and 7 uncovered.
    // The tail covers exactly [6,8) — short rather than a full window anchored
    // at 5, which would have duplicated utterance 5.
    const windows = buildContextWindows(transcript(8), { windowUtterances: 3, windowStride: 3 });
    expect(windows[windows.length - 1].startIndex).toBe(6);
    expect(windows[windows.length - 1].endIndex).toBe(8);
    // Every utterance appears in at least one window.
    const covered = new Set<number>();
    for (const w of windows) for (let i = w.startIndex; i < w.endIndex; i += 1) covered.add(i);
    expect(covered.size).toBe(8);
  });

  it('still yields one window for a transcript shorter than a window', () => {
    const windows = buildContextWindows(transcript(2), CONFIG);
    expect(windows).toHaveLength(1);
    expect([windows[0].startIndex, windows[0].endIndex]).toEqual([0, 2]);
  });

  it('returns nothing for an empty transcript', () => {
    expect(buildContextWindows([], CONFIG)).toEqual([]);
  });

  it('carries media bounds from the utterances it covers', () => {
    const [window] = buildContextWindows(transcript(3), CONFIG);
    expect(window.tStartMs).toBe(0);
    expect(window.tEndMs).toBe(2_800);
    expect(window.text).toBe('line 0 line 1 line 2');
  });

  it('lists distinct speakers in order of first appearance', () => {
    const windows = buildContextWindows([
      utterance(0, 'a', 'Ada'),
      utterance(1, 'b', 'Grace'),
      utterance(2, 'c', 'Ada'),
    ], CONFIG);
    expect(windows[0].speakers).toEqual(['Ada', 'Grace']);
  });

  it('flags a window whose turn opens with a discourse cue', () => {
    const withCue = buildContextWindows([
      utterance(0, 'the pool is saturated'),
      utterance(1, 'anyway, about hiring'),
      utterance(2, 'we need a frontend candidate'),
    ], CONFIG);
    expect(withCue[0].opensWithDiscourseCue).toBe(true);

    const withoutCue = buildContextWindows(transcript(3), CONFIG);
    expect(withoutCue[0].opensWithDiscourseCue).toBe(false);
  });

  it('enforces SEG-02’s 3–5 utterance bound and a sane stride', () => {
    expect(() => buildContextWindows(transcript(9), { windowUtterances: 2, windowStride: 1 }))
      .toThrow(/must be 3–5 utterances/);
    expect(() => buildContextWindows(transcript(9), { windowUtterances: 6, windowStride: 1 }))
      .toThrow(/must be 3–5 utterances/);
    expect(() => buildContextWindows(transcript(9), { windowUtterances: 3, windowStride: 0 }))
      .toThrow(/stride/);
    expect(() => buildContextWindows(transcript(9), { windowUtterances: 3, windowStride: 4 }))
      .toThrow(/stride/);
  });

  describe('the disjointness invariant (ADR-0007 4B)', () => {
    const utterances = (count: number) => Array.from({ length: count }, (_, i) => ({
      tStartMs: i * 1_000,
      tEndMs: i * 1_000 + 900,
      speaker: i % 2 ? 'Ada' : 'Grace',
      text: `turn number ${i} about the pool`,
    }));

    /** Any pair of adjacent windows sharing an utterance. */
    const overlaps = (windows: Array<{ startIndex: number; endIndex: number }>) =>
      windows.filter((window, i) => i > 0 && window.startIndex < windows[i - 1].endIndex);

    it('never overlaps the tail window with its predecessor at 4/4', () => {
      // The regression: 10 turns used to produce [0,4) [4,8) [6,10) — the last
      // pair sharing two utterances, which is the smearing 4B eliminated.
      const windows = buildContextWindows(utterances(10), { windowUtterances: 4, windowStride: 4 });
      expect(windows.map((w) => [w.startIndex, w.endIndex])).toEqual([[0, 4], [4, 8], [8, 10]]);
      expect(overlaps(windows)).toEqual([]);
    });

    it('stays disjoint and gapless at every remainder', () => {
      for (let count = 1; count <= 40; count += 1) {
        const windows = buildContextWindows(utterances(count), { windowUtterances: 4, windowStride: 4 });
        expect(overlaps(windows)).toEqual([]);
        // And still covers the conversation: no turn is dropped to arithmetic.
        expect(windows[0].startIndex).toBe(0);
        expect(windows[windows.length - 1].endIndex).toBe(count);
        for (let i = 1; i < windows.length; i += 1) {
          expect(windows[i].startIndex).toBe(windows[i - 1].endIndex);
        }
      }
    });

    it('lets the tail be shorter than SEG-02 rather than duplicating context', () => {
      const windows = buildContextWindows(utterances(9), { windowUtterances: 4, windowStride: 4 });
      const tail = windows[windows.length - 1];
      expect(tail.endIndex - tail.startIndex).toBe(1);
      expect(overlaps(windows)).toEqual([]);
    });

    it('still overlaps when a stride shorter than the window is asked for', () => {
      // Expressible on purpose — a future higher-resolution detector may slide a
      // disjoint *pair* — but not what the calibrated configuration uses.
      const windows = buildContextWindows(utterances(12), { windowUtterances: 4, windowStride: 2 });
      expect(overlaps(windows).length).toBeGreaterThan(0);
    });
  });
});