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
});

describe('buildContextWindows', () => {
  it('slides a window across the transcript at the configured stride', () => {
    const windows = buildContextWindows(transcript(7), CONFIG);
    expect(windows.map((w) => [w.startIndex, w.endIndex])).toEqual([[0, 3], [2, 5], [4, 7]]);
  });

  it('overlaps windows so a boundary score reflects subject, not window placement', () => {
    const windows = buildContextWindows(transcript(5), { windowUtterances: 3, windowStride: 1 });
    expect(windows.map((w) => w.startIndex)).toEqual([0, 1, 2]);
  });

  it('covers a trailing remainder the stride would otherwise skip', () => {
    // 8 utterances, window 3, stride 3 → [0,3) [3,6) leaves 6 and 7 uncovered.
    const windows = buildContextWindows(transcript(8), { windowUtterances: 3, windowStride: 3 });
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
});
