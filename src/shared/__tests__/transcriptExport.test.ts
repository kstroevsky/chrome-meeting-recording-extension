import { hasExportableTranscript, transcriptToWebVtt } from '../transcriptExport';
import type { Transcript, TranscriptSegment } from '../transcript';

const seg = (startS: number, endS: number, text: string, speaker?: string): TranscriptSegment =>
  ({ tStartMs: startS * 1000, tEndMs: endS * 1000, text, ...(speaker ? { speaker } : {}) });
const transcript = (segments: TranscriptSegment[]): Transcript => ({ source: 'meet-captions', segments });

describe('transcriptToWebVtt', () => {
  it('numbers the cues, writes WebVTT times, and names the speaker as a voice', () => {
    expect(transcriptToWebVtt(transcript([seg(48, 52.5, 'Q3 target moved up.', 'Maria'), seg(61, 80, 'That changes hiring.')])))
      .toBe([
        'WEBVTT',
        '',
        '1',
        '00:00:48.000 --> 00:00:52.500',
        '<v Maria>Q3 target moved up.',
        '',
        '2',
        '00:01:01.000 --> 00:01:20.000',
        'That changes hiring.',
        '',
      ].join('\n'));
  });

  it('orders by time whatever order the segments arrive in', () => {
    const vtt = transcriptToWebVtt(transcript([seg(60, 61, 'second'), seg(5, 6, 'first')]));
    expect(vtt.indexOf('first')).toBeLessThan(vtt.indexOf('second'));
  });

  it('drops blank lines a caption stream leaves behind', () => {
    expect(transcriptToWebVtt(transcript([seg(1, 2, '   '), seg(3, 4, 'kept')]))).not.toContain('1\n00:00:01');
    expect(hasExportableTranscript(transcript([seg(1, 2, '  ')]))).toBe(false);
    expect(hasExportableTranscript(transcript([seg(1, 2, 'kept')]))).toBe(true);
    expect(hasExportableTranscript(undefined)).toBe(false);
  });

  it('gives a zero-length segment a cue a player can land on', () => {
    expect(transcriptToWebVtt(transcript([seg(10, 10, 'A word')]))).toContain('00:00:10.000 --> 00:00:10.200');
  });

  it('escapes what WebVTT would otherwise read as markup — these are other people\'s words', () => {
    const vtt = transcriptToWebVtt(transcript([seg(1, 2, 'a < b & c --> d', 'Alex')]));
    expect(vtt).toContain('<v Alex>a &lt; b &amp; c --&gt; d');
    expect(vtt).not.toContain('a < b');
  });
});
