/**
 * The grammar, tested by round trip rather than by literals.
 *
 * Literals are what hid the drift: every test wrote out a name in a shape
 * nothing produced, so the builder could change twice without a failure. These
 * build with the real builder and read back with the real parser, using the
 * slugs `resolveMeetingSlug` actually returns.
 */
import {
  buildRecordingFilename,
  isRecordingFilename,
  parseRecordingFilename,
  recordingGroupName,
  recordingStartedAtMs,
  recordingStreamOf,
  retitleRecordingFilename,
  stripStreamSuffix,
} from '../recordingFilename';
import type { RecordingStream } from '../recordingTypes';

const SLUGS = ['meet-abc-defg-hij', 'my-page-title-github', ''] as const;
const STREAMS: RecordingStream[] = ['tab', 'mic', 'self-video'];
const AT = new Date('2026-07-11T14:30:45.000Z');

describe('a recording filename', () => {
  it.each(SLUGS)('survives the round trip (slug: %s)', (slug) => {
    for (const stream of STREAMS) {
      const name = buildRecordingFilename(slug, stream, 'webm', AT);
      expect(isRecordingFilename(name)).toBe(true);
      expect(parseRecordingFilename(name)).toEqual({
        slug, stamp: '20260711T143045', stream, extension: 'webm',
      });
      expect(recordingStreamOf(name)).toBe(stream);
    }
  });

  it('groups every stream of one recording under one name', () => {
    const names = STREAMS.map((stream) => buildRecordingFilename('meet-abc', stream, 'webm', AT));
    const groups = new Set(names.map(recordingGroupName));
    expect(groups).toEqual(new Set(['meet-abc-20260711T143045']));
  });

  it('uses the stamp alone when the page had no usable title', () => {
    expect(recordingGroupName(buildRecordingFilename('', 'tab', 'webm', AT))).toBe('20260711T143045');
  });

  it('writes the stamp in UTC, and reads it back as the same moment', () => {
    const name = buildRecordingFilename('meet-abc', 'tab', 'webm', AT);
    expect(name).toContain('20260711T143045');
    expect(recordingStartedAtMs(name)).toBe(AT.getTime());
  });

  it('retitles without moving the recording to another folder', () => {
    const name = buildRecordingFilename('meet-abc', 'mic', 'webm', AT);
    const retitled = retitleRecordingFilename(name, 'team-sync')!;
    expect(retitled).toBe('team-sync-20260711T143045-mic.webm');
    expect(parseRecordingFilename(retitled)?.stamp).toBe(parseRecordingFilename(name)?.stamp);
  });

  it('still reads what earlier versions wrote', () => {
    // The `google-meet-` slug, and a stamp from before seconds were added.
    const legacy = 'google-meet-abc-20260101T0900-recording.webm';
    expect(parseRecordingFilename(legacy)).toEqual({
      slug: 'google-meet-abc', stamp: '20260101T0900', stream: 'tab', extension: 'webm',
    });
    expect(recordingStartedAtMs(legacy)).toBe(Date.parse('2026-01-01T09:00:00Z'));
  });

  it('refuses names it did not write', () => {
    for (const name of ['holiday-video.webm', 'meet-abc-recording.webm', 'meet-abc-20260101T0900-notes.vtt']) {
      expect(isRecordingFilename(name)).toBe(false);
      expect(parseRecordingFilename(name)).toBeNull();
      expect(recordingGroupName(name)).toBeNull();
    }
  });

  it('strips the stream suffix from a name that has lost its stamp', () => {
    // What renaming a saved recording leaves behind; a sidecar is named off it.
    expect(stripStreamSuffix('weekly-sync-recording.webm')).toBe('weekly-sync');
    expect(stripStreamSuffix('weekly-sync-self-video.mp4')).toBe('weekly-sync');
    expect(stripStreamSuffix('holiday-video.webm')).toBe('holiday-video.webm');
  });
});
