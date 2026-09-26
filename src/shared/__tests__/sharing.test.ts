import type { SharedRecording } from '../sharing';
import { sharedRecordingToPlaybackManifest } from '../sharing';

describe('shared playback contract', () => {
  it('adapts protected remote endpoints to the existing player contract', () => {
    const shared: SharedRecording = {
      id: 'published-recording',
      title: 'Customer call',
      createdAt: 10,
      durationMs: 5_000,
      downloadsEnabled: false,
      transcript: { source: 'meet-captions', segments: [{ tStartMs: 10, tEndMs: 20, text: 'hello' }] },
      tracks: [{
        id: 'published-track', stream: 'tab', mimeType: 'video/webm', bytes: 99,
        captureStartOffsetMs: 0, mediaEndpoint: '/media/share/abc/tab',
      }],
    };

    expect(sharedRecordingToPlaybackManifest(shared)).toEqual({
      recordingId: 'published-recording',
      title: 'Customer call',
      createdAt: 10,
      durationMs: 5_000,
      transcriptStatus: 'ready',
      notations: [],
      topics: [],
      tracks: [{
        fileId: 'published-track', stream: 'tab', filename: 'tab.webm', mimeType: 'video/webm', bytes: 99,
        captureStartOffsetMs: 0, sources: [{ kind: 'remote', url: '/media/share/abc/tab' }],
      }],
    });
  });
});
