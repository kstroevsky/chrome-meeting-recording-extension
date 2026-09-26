import type { PlaybackManifest } from '../../shared/playback';
import type { SharePublication } from '../SharePublicationStore';
import { SharePublisher } from '../SharePublisher';

const manifest: PlaybackManifest = {
  recordingId: 'private-history-id',
  title: 'Private demo',
  createdAt: 100,
  durationMs: 5_000,
  transcriptStatus: 'none',
  notations: [],
  topics: [],
  tracks: [{
    fileId: 'private-drive-file-id',
    stream: 'tab',
    filename: 'private-name.webm',
    mimeType: 'video/webm',
    bytes: 10,
    captureStartOffsetMs: 0,
    sources: [{ kind: 'opfs', key: 'library/private-history-id/tab.webm' }],
  }],
};

describe('SharePublisher', () => {
  it('builds one immutable publication plan and delegates its durable lifecycle', async () => {
    let captured: { manifest: any; plans: any } | undefined;
    const publishNew = jest.fn(async (input) => {
      captured = input;
      return {
        id: input.manifest.id,
        status: 'active',
        manifest: structuredClone(input.manifest),
        plans: structuredClone(input.plans),
        sourceRecordingIds: ['private-history-id'],
        shareUrl: 'https://share.example/s/q4fB9viewerCapability',
        createdAt: 200,
        updatedAt: 201,
      } satisfies SharePublication;
    });
    const ids = ['pub-recording', 'pub-track', 'share-id'];
    const publisher = new SharePublisher({
      publications: { publishNew },
      recordingBuilder: {
        newId: () => ids.shift()!,
        mediaEndpoint: (recordingId, trackId) => `/media/${recordingId}/${trackId}`,
      },
      manifestBuilder: { newId: () => ids.shift()!, now: () => 200 },
    });

    const result = await publisher.publish([{ manifest }]);

    expect(publishNew).toHaveBeenCalledTimes(1);
    expect(captured?.manifest.id).toBe('share-id');
    expect(JSON.stringify(captured?.manifest)).not.toContain('private-history-id');
    expect(JSON.stringify(captured?.manifest)).not.toContain('private-drive-file-id');
    expect(JSON.stringify(captured?.manifest)).not.toContain('library/');
    expect(captured?.plans).toEqual([expect.objectContaining({
      sourceRecordingId: 'private-history-id',
      tracks: [expect.objectContaining({ source: expect.objectContaining({ fileId: 'private-drive-file-id' }) })],
    })]);
    expect(result.shareUrl).toBe('https://share.example/s/q4fB9viewerCapability');
  });

  it('fails if the durable coordinator does not return an active publication', async () => {
    const publisher = new SharePublisher({
      publications: {
        publishNew: async (input) => ({
          id: input.manifest.id,
          status: 'failed',
          manifest: structuredClone(input.manifest),
          plans: structuredClone([...input.plans]),
          sourceRecordingIds: ['private-history-id'],
          resumeFrom: 'uploading',
          error: 'network down',
          createdAt: 1,
          updatedAt: 2,
        }),
      },
      recordingBuilder: { newId: (() => { const ids = ['r', 't']; return () => ids.shift()!; })() },
      manifestBuilder: { newId: () => 's' },
    });

    await expect(publisher.publish([{ manifest }])).rejects.toThrow('did not become active');
  });
});
