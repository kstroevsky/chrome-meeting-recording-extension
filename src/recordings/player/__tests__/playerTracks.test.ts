import {
  clockOffsetMs, audioTracks, describeTracks, shownCount, toggleShown } from '../playerTracks';
import type { PlaybackManifest } from '../../../shared/playback';

const manifest = (streams: Array<'tab' | 'mic' | 'self-video'>): PlaybackManifest => ({
  recordingId: 'r1',
  title: 'Weekly sync',
  createdAt: 0,
  transcriptStatus: 'none',
  notations: [],
  tracks: streams.map((stream) => ({
    fileId: `r1:${stream}`,
    stream,
    filename: `${stream}.${stream === 'mic' ? 'm4a' : 'webm'}`,
    mimeType: stream === 'mic' ? 'audio/mp4' : 'video/webm',
    captureStartOffsetMs: 0,
    sources: [],
  })),
});

describe('describeTracks', () => {
  it('lists tracks in the design order, whatever order history stored them', () => {
    const described = describeTracks(manifest(['mic', 'self-video', 'tab']));
    expect(described.map((t) => t.label)).toEqual(['Tab video', 'Self camera', 'Microphone']);
  });

  it('does not render a file the recording never held', () => {
    // A tab-only recording shows one row, not three with two greyed out.
    expect(describeTracks(manifest(['tab'])).map((t) => t.stream)).toEqual(['tab']);
  });

  it('tags each row with its format', () => {
    const described = describeTracks(manifest(['tab', 'mic']));
    expect(described.map((t) => t.format)).toEqual(['WEBM', 'M4A']);
  });

  it('knows the camera carries no audio and the mic no picture', () => {
    const byStream = Object.fromEntries(describeTracks(manifest(['tab', 'mic', 'self-video']))
      .map((t) => [t.stream, t]));
    expect(byStream['self-video']).toMatchObject({ hasVideo: true, hasAudio: false });
    expect(byStream.mic).toMatchObject({ hasVideo: false, hasAudio: true });
    expect(byStream.tab).toMatchObject({ hasVideo: true, hasAudio: true });
  });

  it('marks rows against the shown set, keeping the off ones listed', () => {
    const described = describeTracks(manifest(['tab', 'mic']), new Set(['r1:tab']));
    expect(described.map((t) => [t.stream, t.shown])).toEqual([['tab', true], ['mic', false]]);
  });
});

describe('shownCount', () => {
  it('counts what is on, not what exists', () => {
    const tracks = describeTracks(manifest(['tab', 'mic', 'self-video']), new Set(['r1:tab']));
    expect(shownCount(tracks)).toBe(1);
    expect(tracks).toHaveLength(3);
  });
});

describe('audioTracks', () => {
  it('gives a fader to each audio track and none to the camera', () => {
    const tracks = describeTracks(manifest(['tab', 'mic', 'self-video']));
    expect(audioTracks(tracks).map((t) => t.stream)).toEqual(['tab', 'mic']);
  });

  it('is one fader for a single audio track', () => {
    expect(audioTracks(describeTracks(manifest(['tab'])))).toHaveLength(1);
  });
});

describe('toggleShown', () => {
  it('turns a file off and back on', () => {
    const off = toggleShown(new Set(['a', 'b']), 'a');
    expect([...off]).toEqual(['b']);
    expect([...toggleShown(off, 'a')].sort()).toEqual(['a', 'b']);
  });

  it('refuses to leave nothing playing', () => {
    // An empty player is worse than a file the user wanted hidden.
    expect([...toggleShown(new Set(['a']), 'a')]).toEqual(['a']);
  });
});

describe('availability', () => {
  it('marks a track that never attached, and gives it no fader', () => {
    // A Drive recording whose mic could not be authorized must say so rather
    // than offering a fader that controls silence.
    const tracks = describeTracks(manifest(['tab', 'mic']), null, new Set(['r1:tab']));
    expect(tracks.map((t) => [t.stream, t.available])).toEqual([['tab', true], ['mic', false]]);
    expect(audioTracks(tracks).map((t) => t.stream)).toEqual(['tab']);
  });

  it('treats everything as available when nothing has been attached yet', () => {
    expect(describeTracks(manifest(['tab', 'mic'])).every((t) => t.available)).toBe(true);
  });
});


describe('clockOffsetMs', () => {
  const at = (captureStartOffsetMs: number) => ({ captureStartOffsetMs });

  it('is zero for the master against itself', () => {
    const master = at(340);
    expect(clockOffsetMs(master, master)).toBe(0);
  });

  it('re-bases an auxiliary onto the master rather than onto the run', () => {
    // Both started after the run began; what playback needs is the 120 ms
    // between them, not either raw figure.
    expect(clockOffsetMs(at(460), at(340))).toBe(120);
  });

  it('keeps the sign when the auxiliary started first', () => {
    expect(clockOffsetMs(at(220), at(340))).toBe(-120);
  });

  it('gives the same answer whichever track ends up driving', () => {
    const tab = at(340);
    const mic = at(460);
    // A tab track with only a Downloads copy cannot be master, so the mic can
    // be — and the pair must stay 120 ms apart either way.
    expect(clockOffsetMs(mic, tab)).toBe(120);
    expect(clockOffsetMs(tab, mic)).toBe(-120);
  });

  it('treats unmeasured tracks as aligned, which is the old behaviour', () => {
    expect(clockOffsetMs(at(0), at(0))).toBe(0);
  });
});
