import { activeSegmentIndex, noteAt, railItems, sortSegments, toSrt, type RailItem } from '../playerTranscript';
import type { RecordingNotation } from '../../../shared/notations';
import type { TranscriptSegment } from '../../../shared/transcript';

const seg = (startS: number, endS: number, text: string, speaker?: string): TranscriptSegment =>
  ({ tStartMs: startS * 1000, tEndMs: endS * 1000, text, ...(speaker ? { speaker } : {}) });
const note = (id: string, startS: number, endS: number | undefined, text = id): RecordingNotation =>
  ({ id, tStartMs: startS * 1000, ...(endS != null ? { tEndMs: endS * 1000 } : {}), endedBy: 'user', text });

/** `H:note` for a heading, `line@noteId/edge` for a line — enough to read the shape at a glance. */
const shape = (items: RailItem[]) => items.map((item) => (item.kind === 'heading'
  ? `H:${item.notation.id}`
  : `${item.segment.text}@${item.noteId ?? '-'}/${item.edge ?? '-'}`));

describe('railItems (f10)', () => {
  it('heads each run of lines said during a note, and leaves the rest unheaded', () => {
    const items = railItems(
      [seg(1, 2, 'before'), seg(10, 12, 'a'), seg(13, 15, 'b'), seg(16, 18, 'c'), seg(30, 31, 'after')],
      [note('n1', 10, 20)],
    );
    expect(shape(items)).toEqual(['before@-/-', 'H:n1', 'a@n1/first', 'b@n1/middle', 'c@n1/last', 'after@-/-']);
  });

  it('marks a one-line run as single', () => {
    expect(shape(railItems([seg(10, 11, 'only')], [note('n1', 10, 20)]))).toEqual(['H:n1', 'only@n1/single']);
  });

  it('ends an unclosed note at the next note, and gives each its own heading', () => {
    const items = railItems([seg(10, 11, 'a'), seg(25, 26, 'b')], [note('open', 5, undefined), note('next', 20, 30)]);
    expect(shape(items)).toEqual(['H:open', 'a@open/single', 'H:next', 'b@next/single']);
  });

  it('gives a line inside overlapping notes to the one that started first', () => {
    // n0 runs 5–30 and n1 10–40: 12s is in both and goes to n0; 35s only n1 reaches.
    const items = railItems([seg(12, 13, 'a'), seg(35, 36, 'b')], [note('n1', 10, 40), note('n0', 5, 30)]);
    expect(shape(items)).toEqual(['H:n0', 'a@n0/single', 'H:n1', 'b@n1/single']);
  });

  it('orders lines by time whatever order they arrive in', () => {
    const items = railItems([seg(5, 6, 'second'), seg(1, 2, 'first')], []);
    expect(shape(items)).toEqual(['first@-/-', 'second@-/-']);
    expect(items.map((item) => (item.kind === 'line' ? item.index : -1))).toEqual([0, 1]);
  });
});

describe('activeSegmentIndex', () => {
  const lines = sortSegments([seg(0, 2, 'a'), seg(3, 5, 'b'), seg(5, 9, 'c')]);

  it('finds the line being spoken', () => {
    expect(activeSegmentIndex(lines, 0)).toBe(0);
    expect(activeSegmentIndex(lines, 4_000)).toBe(1);
    // An end is exclusive: at 5s the next line has begun.
    expect(activeSegmentIndex(lines, 5_000)).toBe(2);
  });

  it('is -1 between lines and past the last one', () => {
    expect(activeSegmentIndex(lines, 2_500)).toBe(-1);
    expect(activeSegmentIndex(lines, 9_000)).toBe(-1);
    expect(activeSegmentIndex([], 0)).toBe(-1);
  });

  it('holds up across thousands of lines', () => {
    const many = Array.from({ length: 5000 }, (_, i) => seg(i * 2, i * 2 + 1.5, `l${i}`));
    expect(activeSegmentIndex(many, 7_777_000)).toBe(3888);
    expect(activeSegmentIndex(many, 7_777_600)).toBe(-1);
  });
});

describe('toSrt', () => {
  it('numbers the cues, writes SubRip times and puts the speaker first', () => {
    expect(toSrt([seg(3_725.5, 3_727.25, 'Past the hour.'), seg(48, 52.5, 'Q3 target moved.', 'Maria')])).toBe(
      '1\n00:00:48,000 --> 00:00:52,500\nMaria: Q3 target moved.\n\n'
      + '2\n01:02:05,500 --> 01:02:07,250\nPast the hour.\n',
    );
  });

  it('is empty for an empty transcript', () => {
    expect(toSrt([])).toBe('');
  });
});

describe('noteAt', () => {
  it('finds the note under the playhead by the rail\'s own rule', () => {
    const notes = [note('open', 5, undefined), note('closed', 20, 30)];
    expect(noteAt(notes, 10_000)?.id).toBe('open');
    expect(noteAt(notes, 25_000)?.id).toBe('closed');
    expect(noteAt(notes, 40_000)).toBeNull();
    expect(noteAt(notes, 1_000)).toBeNull();
  });
});
