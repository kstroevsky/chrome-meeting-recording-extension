import type { PlaybackManifest } from '../../shared/playback';
import { buildPublishedManifest, buildPublishedRecording } from '../PublishedManifestBuilder';

const manifest: PlaybackManifest = {
  recordingId: 'history-private-123',
  title: 'Customer discovery',
  createdAt: 100,
  durationMs: 60_000,
  transcriptStatus: 'ready',
  notations: [{ id: 'private-note', tStartMs: 1_000, tEndMs: 2_000, endedBy: 'user', text: 'Private thought' }],
  topics: [{ id: 'topic-1', keywords: ['pricing'], spans: [{ tStartMs: 10_000, tEndMs: 20_000 }], totalMs: 10_000, importance: 1 }],
  tracks: [
    {
      fileId: 'history-private-123:tab', stream: 'tab', filename: 'customer-name.webm', mimeType: 'video/webm',
      bytes: 1_000, captureStartOffsetMs: 0,
      sources: [{ kind: 'opfs', key: 'library/history-private-123/customer-name.webm' }, { kind: 'drive', fileId: 'drive-secret' }],
    },
    {
      fileId: 'history-private-123:self', stream: 'self-video', filename: 'camera.webm', mimeType: 'video/webm',
      bytes: 100, captureStartOffsetMs: 125, sources: [{ kind: 'opfs', key: 'library/history-private-123/camera.webm' }],
    },
  ],
};

const transcript = {
  source: 'meet-captions' as const,
  segments: [{ tStartMs: 10_000, tEndMs: 12_000, speaker: 'A', text: 'Pricing' }],
};

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

describe('buildPublishedRecording', () => {
  it('creates a sanitized snapshot and keeps owner storage identifiers private', () => {
    const plan = buildPublishedRecording({ manifest, transcript }, {}, {
      newId: ids('published-recording', 'published-tab'),
      mediaEndpoint: (recordingId, trackId) => `/media/${recordingId}/${trackId}`,
    });

    expect(plan.sourceRecordingId).toBe('history-private-123');
    expect(plan.recording).toEqual({
      id: 'published-recording',
      title: 'Customer discovery',
      createdAt: 100,
      durationMs: 60_000,
      tracks: [{
        id: 'published-tab', stream: 'tab', mimeType: 'video/webm', bytes: 1_000,
        captureStartOffsetMs: 0, mediaEndpoint: '/media/published-recording/published-tab',
      }],
      transcript,
      topics: manifest.topics,
      downloadsEnabled: false,
    });
    expect(JSON.stringify(plan.recording)).not.toMatch(/history-private|drive-secret|library\//);
    expect(plan.tracks[0].source).toBe(manifest.tracks[0]);
  });

  it('keeps notes and self-video opt-in and never publishes topics without the transcript', () => {
    const plan = buildPublishedRecording({ manifest, transcript }, {
      includeTranscript: false,
      includeTopics: true,
      includeNotations: true,
      includeSelfVideo: true,
      downloadsEnabled: true,
    }, { newId: ids('r', 'tab', 'self') });

    expect(plan.recording.tracks.map((track) => track.stream)).toEqual(['tab', 'self-video']);
    expect(plan.recording.transcript).toBeUndefined();
    expect(plan.recording.topics).toBeUndefined();
    expect(plan.recording.notations).toEqual(manifest.notations);
    expect(plan.recording.downloadsEnabled).toBe(true);
  });

  it('snapshots derivative data instead of retaining mutable references', () => {
    const plan = buildPublishedRecording({ manifest, transcript }, { includeNotations: true }, {
      newId: ids('r', 'tab'),
    });

    transcript.segments[0].text = 'changed later';
    manifest.notations[0].text = 'changed later';
    manifest.topics[0].keywords[0] = 'changed-later';

    expect(plan.recording.transcript?.segments[0].text).toBe('Pricing');
    expect(plan.recording.notations?.[0].text).toBe('Private thought');
    expect(plan.recording.topics?.[0].keywords[0]).toBe('pricing');
  });

  it('groups several published snapshots behind one share manifest', () => {
    const first = buildPublishedRecording({ manifest, transcript }, {}, { newId: ids('r1', 't1') });
    const second = buildPublishedRecording({ manifest: { ...manifest, recordingId: 'private-second', title: 'Follow-up' } }, {}, {
      newId: ids('r2', 't2'),
    });

    expect(buildPublishedManifest([first, second], { newId: () => 'share-public', now: () => 123 })).toEqual({
      id: 'share-public',
      createdAt: 123,
      recordings: [first.recording, second.recording],
    });
  });
});
