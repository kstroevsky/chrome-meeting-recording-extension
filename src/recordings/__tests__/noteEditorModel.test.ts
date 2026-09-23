import { editorLines, formatLength, formatSpan, linesInSpan, noteCount, spanOfLines } from '../noteEditorModel';
import type { RecordingNotation } from '../../shared/notations';
import type { TranscriptSegment } from '../../shared/transcript';

const seg = (startS: number, endS: number, text: string): TranscriptSegment => ({ tStartMs: startS * 1000, tEndMs: endS * 1000, text });
const note = (id: string, startS: number, endS: number, text: string): RecordingNotation =>
  ({ id, tStartMs: startS * 1000, tEndMs: endS * 1000, endedBy: 'user', text });

const SEGMENTS = [seg(10, 12, 'a'), seg(20, 22, 'b'), seg(24, 26, 'c'), seg(40, 42, 'd')];

describe('editorLines (f5)', () => {
  it('names a note on the first line of its run only, and leaves other lines unnamed', () => {
    const lines = editorLines(SEGMENTS, [note('n1', 19, 30, 'Migration owner'), note('n2', 39, 45, '')]);
    expect(lines.map((line) => [line.segment.text, line.noteId, line.noteName, line.edge])).toEqual([
      ['a', null, null, null],
      ['b', 'n1', 'Migration owner', 'first'],
      ['c', 'n1', null, 'last'],
      ['d', 'n2', '', 'single'],
    ]);
  });
});

describe('spanOfLines', () => {
  const lines = editorLines(SEGMENTS, []);

  it('runs from the first line\'s start to the last line\'s end, whichever way the drag went', () => {
    expect(spanOfLines(lines, 1, 2)).toEqual({ tStartMs: 20_000, tEndMs: 26_000 });
    expect(spanOfLines(lines, 2, 1)).toEqual({ tStartMs: 20_000, tEndMs: 26_000 });
    expect(spanOfLines(lines, 3, 3)).toEqual({ tStartMs: 40_000, tEndMs: 42_000 });
  });
});

describe('linesInSpan', () => {
  const lines = editorLines(SEGMENTS, []);

  it('covers every line that starts inside a closed span', () => {
    expect([...linesInSpan(lines, { tStartMs: 20_000, tEndMs: 26_000 }, 0)]).toEqual([1, 2]);
  });

  it('lets an open span reach the playhead, so it grows as the recording plays', () => {
    expect([...linesInSpan(lines, { tStartMs: 20_000, tEndMs: null }, 21_000)]).toEqual([1]);
    expect([...linesInSpan(lines, { tStartMs: 20_000, tEndMs: null }, 41_000)]).toEqual([1, 2, 3]);
  });
});

describe('formatting', () => {
  it('writes a span as its range, or as running while it has no end', () => {
    expect(formatSpan({ tStartMs: 338_000, tEndMs: 379_000 })).toBe('05:38 → 06:19');
    expect(formatSpan({ tStartMs: 338_000, tEndMs: null })).toBe('05:38 → running');
  });

  it('writes a length unpadded, the way it reads on its own', () => {
    expect(formatLength(41_000)).toBe('0:41');
    expect(formatLength(64_000)).toBe('1:04');
    expect(formatLength(3_727_000)).toBe('1:02:07');
  });

  it('counts the notes, and says so while one is open', () => {
    expect(noteCount(7, false)).toBe('7 NOTES');
    expect(noteCount(7, true)).toBe('7 NOTES · 1 OPEN');
    expect(noteCount(1, false)).toBe('1 NOTE');
  });
});
