import type { PlaybackManifest } from '../../shared/playback';
import type { PublishedPlaybackManifest } from '../../shared/sharing';
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
  it('sends only sanitized metadata, uploads private sources locally, then finalizes', async () => {
    const calls: string[] = [];
    let publicPayload: PublishedPlaybackManifest | undefined;
    const createShare = jest.fn(async (manifest: PublishedPlaybackManifest) => {
      publicPayload = manifest;
      calls.push('create');
    });
    const finalizeShare = jest.fn(async () => { calls.push('finalize'); return { shareUrl: 'https://share.example/s/share-id' }; });
    const upload = jest.fn(async () => { calls.push('upload'); });
    const clearShare = jest.fn(async () => { calls.push('clear'); });
    const ids = ['pub-recording', 'pub-track', 'share-id'];
    const publisher = new SharePublisher({
      api: { createShare, finalizeShare },
      uploads: { upload, clearShare },
      recordingBuilder: {
        newId: () => ids.shift()!,
        mediaEndpoint: (recordingId, trackId) => `/media/${recordingId}/${trackId}`,
      },
      manifestBuilder: { newId: () => ids.shift()!, now: () => 200 },
    });

    const result = await publisher.publish([{ manifest }]);

    expect(calls).toEqual(['create', 'upload', 'finalize', 'clear']);
    expect(publicPayload).toBeDefined();
    expect(JSON.stringify(publicPayload)).not.toContain('private-history-id');
    expect(JSON.stringify(publicPayload)).not.toContain('private-drive-file-id');
    expect(JSON.stringify(publicPayload)).not.toContain('library/');
    expect(upload).toHaveBeenCalledWith('share-id', [expect.objectContaining({
      sourceRecordingId: 'private-history-id',
      tracks: [expect.objectContaining({ source: expect.objectContaining({ fileId: 'private-drive-file-id' }) })],
    })]);
    expect(finalizeShare).toHaveBeenCalledWith('share-id');
    expect(clearShare).toHaveBeenCalledWith('share-id');
    expect(result.shareUrl).toBe('https://share.example/s/share-id');
  });

  it('does not clear resumable upload state when finalization fails', async () => {
    const clearShare = jest.fn(async () => {});
    const publisher = new SharePublisher({
      api: {
        createShare: async () => {},
        finalizeShare: async () => { throw new Error('publish failed'); },
      },
      uploads: { upload: async () => {}, clearShare },
      recordingBuilder: { newId: (() => { const ids = ['r', 't']; return () => ids.shift()!; })() },
      manifestBuilder: { newId: () => 's' },
    });

    await expect(publisher.publish([{ manifest }])).rejects.toThrow('publish failed');
    expect(clearShare).not.toHaveBeenCalled();
  });
});
