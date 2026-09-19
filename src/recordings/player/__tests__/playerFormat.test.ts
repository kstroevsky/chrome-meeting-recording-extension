import { formatClock, mergeNoteMarks, seekFraction, toNoteMarks } from '../playerFormat';
import type { RecordingNotation } from '../../../shared/notations';

const note = (over: Partial<RecordingNotation>): RecordingNotation =>
  ({ id: 'n', tStartMs: 0, text: '', ...over } as RecordingNotation);

describe('formatClock', () => {
  it('drops the hour until there is one, and pads inside it', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(5_000)).toBe('00:05');
    expect(formatClock(65_000)).toBe('01:05');
    expect(formatClock(600_000)).toBe('10:00');
    expect(formatClock(3_600_000)).toBe('1:00:00');
    expect(formatClock(3_965_000)).toBe('1:06:05');
  });

  it('treats nonsense as zero rather than rendering NaN', () => {
    expect(formatClock(Number.NaN)).toBe('00:00');
    expect(formatClock(-5)).toBe('00:00');
  });
});

describe('toNoteMarks', () => {
  it('places a span by percentage of duration', () => {
    const [mark] = toNoteMarks([note({ id: 'a', tStartMs: 25_000, tEndMs: 50_000, text: 'Decision' })], 100_000);
    expect(mark).toMatchObject({ id: 'a', leftPct: 25, widthPct: 25, named: true, label: 'Decision' });
  });

  it('gives a point note a hittable minimum width', () => {
    const [mark] = toNoteMarks([note({ id: 'a', tStartMs: 50_000 })], 100_000);
    expect(mark.widthPct).toBeGreaterThan(0);
    expect(mark.leftPct).toBe(50);
  });

  it('marks an unnamed note as unnamed and labels it for the user', () => {
    const [mark] = toNoteMarks([note({ id: 'a', tStartMs: 0, text: '   ' })], 100_000);
    expect(mark).toMatchObject({ named: false, label: 'Name this one' });
  });

  it('never lets a mark run past the end of the track', () => {
    const [mark] = toNoteMarks([note({ id: 'a', tStartMs: 90_000, tEndMs: 500_000 })], 100_000);
    expect(mark.leftPct + mark.widthPct).toBeLessThanOrEqual(100);
  });

  it('clamps a start beyond the duration instead of placing it off-track', () => {
    const [mark] = toNoteMarks([note({ id: 'a', tStartMs: 500_000 })], 100_000);
    expect(mark.leftPct).toBe(100);
  });

  it('returns nothing when the duration is unknown', () => {
    expect(toNoteMarks([note({ id: 'a', tStartMs: 1 })], 0)).toEqual([]);
    expect(toNoteMarks([note({ id: 'a', tStartMs: 1 })], Number.NaN)).toEqual([]);
  });

  it('orders marks left to right regardless of input order', () => {
    const marks = toNoteMarks([
      note({ id: 'b', tStartMs: 80_000 }),
      note({ id: 'a', tStartMs: 10_000 }),
    ], 100_000);
    expect(marks.map((m) => m.id)).toEqual(['a', 'b']);
  });
});

describe('seekFraction', () => {
  it('maps a pointer position onto the track and clamps at both ends', () => {
    const rect = { left: 100, width: 200 };
    expect(seekFraction(200, rect)).toBe(0.5);
    expect(seekFraction(50, rect)).toBe(0);
    expect(seekFraction(400, rect)).toBe(1);
  });

  it('is zero for a track with no width rather than dividing by zero', () => {
    expect(seekFraction(10, { left: 0, width: 0 })).toBe(0);
  });
});

describe('mergeNoteMarks (f20)', () => {
  const marks = (starts: number[]) => toNoteMarks(starts.map((s, i) => note({ id: `n${i}`, tStartMs: s * 1000, text: `N${i}` })), 1_000_000);

  it('keeps apart marks with room between them', () => {
    expect(mergeNoteMarks(marks([0, 100, 500])).map((group) => group.notes.length)).toEqual([1, 1, 1]);
  });

  it('folds marks that would overlap into one, spanning all of them', () => {
    // 0.6% ticks 0.3% apart overlap; the third is far away.
    const groups = mergeNoteMarks(marks([100, 103, 106, 500]));
    expect(groups.map((group) => group.notes.map((n) => n.id))).toEqual([['n0', 'n1', 'n2'], ['n3']]);
    expect(groups[0].leftPct).toBe(10);
    expect(groups[0].widthPct).toBeCloseTo(1.2);
  });

  it('is pale only when every note in it is unnamed', () => {
    const notes = [note({ id: 'a', tStartMs: 100_000, text: '' }), note({ id: 'b', tStartMs: 101_000, text: 'Named' })];
    expect(mergeNoteMarks(toNoteMarks(notes, 1_000_000))[0].named).toBe(true);
    expect(mergeNoteMarks(toNoteMarks([notes[0]], 1_000_000))[0].named).toBe(false);
  });
});
