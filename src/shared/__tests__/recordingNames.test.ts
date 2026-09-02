import { buildRenamedRecordingFilename, slugifyRecordingTitle } from '../recordingNames';

describe('recording names', () => {
  it('creates lowercase dash-separated Unicode-safe slugs', () => {
    expect(slugifyRecordingTitle('  Quarterly Review  ')).toBe('quarterly-review');
    expect(slugifyRecordingTitle('Crème brûlée / 東京')).toBe('creme-brulee-東京');
    expect(slugifyRecordingTitle('Продукт — Demo')).toBe('продукт-demo');
  });

  it('rejects titles without letters or numbers', () => {
    expect(slugifyRecordingTitle(' -- / ')).toBe('');
    expect(() => buildRenamedRecordingFilename(' -- ', 'tab', 'meeting.webm'))
      .toThrow('at least one letter or number');
  });

  it.each([
    ['tab', 'capture.webm', 'quarterly-review-recording.webm'],
    ['mic', 'capture.m4a', 'quarterly-review-mic.m4a'],
    ['self-video', 'capture.mp4', 'quarterly-review-self-video.mp4'],
  ] as const)('preserves the extension for %s artifacts', (stream, current, expected) => {
    expect(buildRenamedRecordingFilename('Quarterly Review', stream, current)).toBe(expected);
  });

  it('names the notes sidecar for itself, not the stream it rode along with', () => {
    // The sidecar carries a media stream only so the upload can order it; naming
    // it after that stream collided with the real file of the same stream.
    expect(buildRenamedRecordingFilename('Weekly sync', 'mic', 'meet-notes.vtt', 'notes'))
      .toBe('weekly-sync-notes.vtt');
    expect(buildRenamedRecordingFilename('Weekly sync', 'tab', 'meet-notes.vtt', 'notes'))
      .toBe('weekly-sync-notes.vtt');
  });

  it('does not let the sidecar take a media file\'s name', () => {
    const mic = buildRenamedRecordingFilename('Weekly sync', 'mic', 'meet-mic.webm');
    const notes = buildRenamedRecordingFilename('Weekly sync', 'mic', 'meet-notes.vtt', 'notes');
    expect(mic).toBe('weekly-sync-mic.webm');
    expect(notes).not.toBe(mic);
  });
});
