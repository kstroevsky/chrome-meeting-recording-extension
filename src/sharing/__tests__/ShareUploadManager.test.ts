import type { PlaybackTrack } from '../../shared/playback';
import type { PublishedRecordingPlan } from '../PublishedManifestBuilder';
import { ShareUploadManager, type ShareUploadTransport } from '../ShareUploadManager';
import { ShareUploadStore, type ShareUploadStorageArea } from '../ShareUploadStore';

function memoryArea(): ShareUploadStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    getAll: async () => structuredClone(data),
    set: async (items) => { Object.assign(data, structuredClone(items)); },
    remove: async (key) => { delete data[key]; },
  };
}

function sourceTrack(): PlaybackTrack {
  return {
    fileId: 'private-file-id',
    stream: 'tab',
    filename: 'private-recording.webm',
    mimeType: 'video/webm',
    bytes: 10,
    captureStartOffsetMs: 0,
    sources: [{ kind: 'opfs', key: 'library/private-history/tab.webm' }],
  };
}

function plan(): PublishedRecordingPlan {
  const source = sourceTrack();
  return {
    sourceRecordingId: 'private-history-id',
    recording: {
      id: 'pub-recording',
      title: 'Demo',
      createdAt: 1,
      downloadsEnabled: false,
      tracks: [{
        id: 'pub-track',
        stream: 'tab',
        mimeType: 'video/webm',
        bytes: 10,
        captureStartOffsetMs: 0,
        mediaEndpoint: '/media/recordings/pub-recording/tracks/pub-track',
      }],
    },
    tracks: [{ source, published: {
      id: 'pub-track',
      stream: 'tab',
      mimeType: 'video/webm',
      bytes: 10,
      captureStartOffsetMs: 0,
      mediaEndpoint: '/media/recordings/pub-recording/tracks/pub-track',
    } }],
  };
}

function transport(overrides: Partial<ShareUploadTransport> = {}): ShareUploadTransport {
  return {
    beginTrackUpload: jest.fn(async () => ({ uploadId: 'upload-1', chunkSize: 4 })),
    uploadTrackChunk: jest.fn(async () => {}),
    completeTrackUpload: jest.fn(async () => {}),
    ...overrides,
  };
}

describe('ShareUploadManager', () => {
  it('uploads bounded chunks and keeps completion durable until the share finalizes', async () => {
    const area = memoryArea();
    const store = new ShareUploadStore(area);
    const api = transport();
    const bytes = new Blob(['0123456789']);
    const manager = new ShareUploadManager({
      store,
      source: async () => ({ size: bytes.size, read: async (start, end) => bytes.slice(start, end) }),
      transport: api,
      now: () => 100,
    });

    await manager.upload('share-1', [plan()]);

    expect(api.beginTrackUpload).toHaveBeenCalledWith({
      shareId: 'share-1',
      recordingId: 'pub-recording',
      trackId: 'pub-track',
      mimeType: 'video/webm',
      bytes: 10,
    }, expect.any(AbortSignal));
    expect((api.uploadTrackChunk as jest.Mock).mock.calls.map(([call]) => [call.offset, call.chunk.size])).toEqual([
      [0, 4], [4, 4], [8, 2],
    ]);
    expect(api.completeTrackUpload).toHaveBeenCalledWith({ uploadId: 'upload-1', totalBytes: 10 }, expect.any(AbortSignal));
    expect(await store.list('share-1')).toEqual([expect.objectContaining({
      status: 'completed', offset: 10, uploadId: 'upload-1',
    })]);

    await manager.clearShare('share-1');
    expect(await store.list('share-1')).toEqual([]);
  });

  it('resumes from the last acknowledged chunk without creating a new upload session', async () => {
    const area = memoryArea();
    const store = new ShareUploadStore(area);
    await store.put({
      id: 'share-1:pub-recording:pub-track',
      shareId: 'share-1',
      sourceRecordingId: 'private-history-id',
      recordingId: 'pub-recording',
      trackId: 'pub-track',
      source: sourceTrack(),
      mimeType: 'video/webm',
      bytes: 10,
      offset: 4,
      status: 'uploading',
      uploadId: 'existing-upload',
      chunkSize: 4,
      updatedAt: 10,
    });
    const api = transport();
    const bytes = new Blob(['0123456789']);
    const reads: Array<[number, number]> = [];
    const manager = new ShareUploadManager({
      store,
      source: async () => ({
        size: bytes.size,
        read: async (start, end) => { reads.push([start, end]); return bytes.slice(start, end); },
      }),
      transport: api,
    });

    await manager.upload('share-1', [plan()]);

    expect(api.beginTrackUpload).not.toHaveBeenCalled();
    expect(reads).toEqual([[4, 8], [8, 10]]);
    expect((api.uploadTrackChunk as jest.Mock).mock.calls.map(([call]) => call.offset)).toEqual([4, 8]);
    expect(api.completeTrackUpload).toHaveBeenCalledWith({ uploadId: 'existing-upload', totalBytes: 10 }, expect.any(AbortSignal));
  });

  it('persists a failed offset so an explicit rerun continues the same session', async () => {
    const area = memoryArea();
    const store = new ShareUploadStore(area);
    let fail = true;
    const api = transport({
      uploadTrackChunk: jest.fn(async ({ offset }) => {
        if (offset === 4 && fail) throw new Error('network down');
      }),
    });
    const bytes = new Blob(['0123456789']);
    const manager = new ShareUploadManager({
      store,
      source: async () => ({ size: bytes.size, read: async (start, end) => bytes.slice(start, end) }),
      transport: api,
    });

    await expect(manager.upload('share-1', [plan()])).rejects.toThrow('network down');
    expect(await store.list('share-1')).toEqual([expect.objectContaining({
      status: 'failed', offset: 4, uploadId: 'upload-1', error: 'network down',
    })]);

    fail = false;
    await manager.upload('share-1', [plan()]);
    expect(api.beginTrackUpload).toHaveBeenCalledTimes(1);
    expect(await store.list('share-1')).toEqual([expect.objectContaining({ status: 'completed', offset: 10 })]);
  });
});
