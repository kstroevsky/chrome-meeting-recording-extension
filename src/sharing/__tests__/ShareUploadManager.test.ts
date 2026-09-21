import type { PlaybackTrack } from '../../shared/playback';
import type { PublishedRecordingPlan } from '../PublishedManifestBuilder';
import { ShareUploadBatchError, ShareUploadManager, type ShareUploadTransport } from '../ShareUploadManager';
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

function httpError(status: number, message: string, code?: string): Error & { status: number; code?: string } {
  return Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
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

  it('retries the same chunk with bounded exponential backoff on transient failures', async () => {
    const store = new ShareUploadStore(memoryArea());
    let attempts = 0;
    const sleeps: number[] = [];
    const api = transport({
      beginTrackUpload: jest.fn(async () => ({ uploadId: 'upload-1', chunkSize: 10 })),
      uploadTrackChunk: jest.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw httpError(503, 'temporarily unavailable');
      }),
    });
    const bytes = new Blob(['0123456789']);
    const manager = new ShareUploadManager({
      store,
      source: async () => ({ size: bytes.size, read: async (start, end) => bytes.slice(start, end) }),
      transport: api,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    await manager.upload('share-1', [plan()]);

    expect((api.uploadTrackChunk as jest.Mock).mock.calls.map(([call]) => call.offset)).toEqual([0, 0, 0]);
    expect(sleeps).toEqual([10, 20]);
    expect(await store.list('share-1')).toEqual([expect.objectContaining({ status: 'completed', offset: 10 })]);
  });

  it('discards a gone backend session and restarts the same track from byte zero', async () => {
    const store = new ShareUploadStore(memoryArea());
    let session = 0;
    const uploaded: Array<[string, number]> = [];
    const api = transport({
      beginTrackUpload: jest.fn(async () => ({ uploadId: `upload-${++session}`, chunkSize: 4 })),
      uploadTrackChunk: jest.fn(async ({ uploadId, offset }) => {
        uploaded.push([uploadId, offset]);
        if (uploadId === 'upload-1' && offset === 4) {
          throw httpError(410, 'session expired', 'UPLOAD_SESSION_GONE');
        }
      }),
    });
    const bytes = new Blob(['0123456789']);
    const manager = new ShareUploadManager({
      store,
      source: async () => ({ size: bytes.size, read: async (start, end) => bytes.slice(start, end) }),
      transport: api,
      sleep: async () => {},
    });

    await manager.upload('share-1', [plan()]);

    expect(api.beginTrackUpload).toHaveBeenCalledTimes(2);
    expect(uploaded).toEqual([
      ['upload-1', 0],
      ['upload-1', 4],
      ['upload-2', 0],
      ['upload-2', 4],
      ['upload-2', 8],
    ]);
    expect(await store.list('share-1')).toEqual([expect.objectContaining({
      status: 'completed', uploadId: 'upload-2', offset: 10,
    })]);
  });

  it('lets every queued track settle before returning an aggregate failure', async () => {
    const store = new ShareUploadStore(memoryArea());
    const base = plan();
    const makeTrack = (id: string, stream: PlaybackTrack['stream']) => ({
      source: { ...sourceTrack(), stream, fileId: `private-${id}` },
      published: {
        ...base.tracks[0].published,
        id,
        stream,
        mediaEndpoint: `/media/recordings/pub-recording/tracks/${id}`,
      },
    });
    const tracks = [makeTrack('tab-track', 'tab'), makeTrack('mic-track', 'mic'), makeTrack('cam-track', 'self-video')];
    const multiPlan: PublishedRecordingPlan = {
      ...base,
      recording: { ...base.recording, tracks: tracks.map((entry) => entry.published) },
      tracks,
    };
    const completed: string[] = [];
    const api = transport({
      beginTrackUpload: jest.fn(async ({ trackId }) => ({ uploadId: trackId, chunkSize: 10 })),
      uploadTrackChunk: jest.fn(async ({ uploadId }) => {
        if (uploadId === 'mic-track') throw new Error('mic failed');
      }),
      completeTrackUpload: jest.fn(async ({ uploadId }) => { completed.push(uploadId); }),
    });
    const bytes = new Blob(['0123456789']);
    const manager = new ShareUploadManager({
      store,
      source: async () => ({ size: bytes.size, read: async (start, end) => bytes.slice(start, end) }),
      transport: api,
      concurrency: 2,
      maxAttempts: 1,
    });

    await expect(manager.upload('share-1', [multiPlan])).rejects.toBeInstanceOf(ShareUploadBatchError);

    expect(completed.sort()).toEqual(['cam-track', 'tab-track']);
    expect(await store.list('share-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ trackId: 'tab-track', status: 'completed' }),
      expect.objectContaining({ trackId: 'mic-track', status: 'failed', error: 'mic failed' }),
      expect.objectContaining({ trackId: 'cam-track', status: 'completed' }),
    ]));
  });
});
