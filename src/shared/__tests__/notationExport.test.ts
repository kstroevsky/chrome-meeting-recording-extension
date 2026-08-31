import { hasExportableNotations, toWebVtt } from '../notationExport';
import type { RecordingNotation } from '../notations';

const note = (id: string, tStartMs: number, tEndMs: number | undefined, text: string): RecordingNotation =>
  ({ id, tStartMs, ...(tEndMs != null ? { tEndMs } : {}), text });

describe('toWebVtt', () => {
  it('renders the header and one cue per note, in order', () => {
    expect(toWebVtt([
      note('n2', 154_000, 209_000, 'Pricing objection'),
      note('n1', 12_500, 41_000, 'Intro / agenda'),
    ])).toBe([
      'WEBVTT',
      '',
      '1',
      '00:00:12.500 --> 00:00:41.000',
      'Intro / agenda',
      '',
      '2',
      '00:02:34.000 --> 00:03:29.000',
      'Pricing objection',
      '',
    ].join('\n'));
  });

  it('uses the long timestamp form past an hour', () => {
    expect(toWebVtt([note('n1', 3_723_456, 3_785_000, 'late')]))
      .toContain('01:02:03.456 --> 01:03:05.000');
  });

  it('widens a cue that would be shorter than a player can land on', () => {
    // 544ms is a real span, but too short to click; it is stretched, not dropped.
    expect(toWebVtt([note('n1', 3_723_456, 3_724_000, 'brief')]))
      .toContain('01:02:03.456 --> 01:02:04.456');
  });

  it('gives a point mark a width, because a cue must end after it starts', () => {
    expect(toWebVtt([note('n1', 5_000, 5_000, 'instant')]))
      .toContain('00:00:05.000 --> 00:00:06.000');
  });

  it('ends a span the run never sealed at the recording duration', () => {
    expect(toWebVtt([note('n1', 10_000, undefined, 'still open')], { durationMs: 90_000 }))
      .toContain('00:00:10.000 --> 00:01:30.000');
  });

  it('still exports an unsealed span when the duration is unknown', () => {
    // Losing the note here would undo the point of sealing it at all.
    const vtt = toWebVtt([note('n1', 10_000, undefined, 'orphan')]);
    expect(vtt).toContain('00:00:10.000 --> 00:00:11.000');
    expect(vtt).toContain('orphan');
  });

  it('names a note that was marked but never written', () => {
    expect(toWebVtt([note('n1', 0, 1_000, '')])).toContain('Unnamed note');
  });

  it('keeps a cue payload from breaking the file', () => {
    // A newline would end the cue; the arrow would read as a timing line.
    const vtt = toWebVtt([note('n1', 0, 1_000, 'first line\nsecond --> third')]);
    expect(vtt).toContain('first line second → third');
    expect(vtt.split('\n').filter((line) => line === '')).toHaveLength(2);
  });

  it('skips records that are not usable notations', () => {
    expect(toWebVtt([
      note('n1', 0, 1_000, 'kept'),
      { id: '', tStartMs: 5_000, text: 'dropped' } as RecordingNotation,
    ])).toContain('kept');
    expect(toWebVtt([{ id: '', tStartMs: 0, text: 'x' } as RecordingNotation])).toBe('WEBVTT\n');
  });

  it('is parseable by the browser as a chapters track', () => {
    const vtt = toWebVtt([note('n1', 12_500, 41_000, 'Intro / agenda')]);
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    for (const line of vtt.split('\n')) expect(line).not.toMatch(/^\s+$/);
  });
});

describe('hasExportableNotations', () => {
  it('is false when nothing survives decoding', () => {
    expect(hasExportableNotations([])).toBe(false);
    expect(hasExportableNotations([{ id: '', tStartMs: 0, text: 'x' } as RecordingNotation])).toBe(false);
  });

  it('is true once one real notation exists', () => {
    expect(hasExportableNotations([note('n1', 0, 1_000, '')])).toBe(true);
  });
});
