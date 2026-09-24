import type { PlaybackTrack } from '../../shared/playback';
import {
  DriveOriginPreparer,
  type DriveOriginApi,
} from '../DriveOriginPreparer';
import type { PublishedRecordingPlan } from '../PublishedManifestBuilder';
import { ShareDriveOriginRegistry } from '../ShareDriveOriginRegistry';
import {
  ShareUploadStore,
  type ShareUploadStorageArea,
} from '../ShareUploadStore';

function memoryArea(): ShareUploadStorageArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    getAll: async () => structuredClone(data),
    set: async (items) => { Object.assign(data, structuredClone(items)); },
    remove: async (key) => { delete data[key]; },
  };
}

function sourceTrack(source: PlaybackTrack['sources'][number], bytes = 6): PlaybackTrack {
  return {
    fileId: 'private-track-id',
    stream: 'tab',
    filename: 'private.webm',
    mimeType: 'video/webm',
    bytes,
    captureStartOffsetMs: 0,
    sources: [source],
  };
}

function plan(source: PlaybackTrack['sources'][number], bytes = 6): PublishedRecordingPlan {
  const published = {
    id: 'public-track',
    stream: 'tab' as const,
    mimeType: 'video/webm',
    bytes,
    captureStartOffsetMs: 0,
    mediaEndpoint: '/media/recordings/public-recording/tracks/public-track',
  };
  return {
    sourceRecordingId: 'private-recording',
    recording: {
      id: 'public-recording',
      title: 'Demo',
      createdAt: 1,
      tracks: [published],
      downloadsEnabled: false,
    },
    tracks: [{ source: sourceTrack(source, bytes), published }],
  };
}

function api(overrides: Partial<DriveOriginApi> = {}): DriveOriginApi {
  return {
    getDriveReaderIdentity: jest.fn(async () => ({
      email: 'reader@example.iam.gserviceaccount.com',
    })),
    registerDriveOrigin: jest.fn(async () => {}),
    ...overrides,
  };
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers({ 'content-type': 'application/json' });
  new Headers(headers).forEach((value, key) => responseHeaders.set(key, value));
  const make = (): Response => ({
    status,
    headers: responseHeaders,
    json: async () => structuredClone(body),
    text: async () => body == null ? '' : JSON.stringify(body),
    clone: () => make(),
  } as Response);
  return make();
}

function driveMetadata(fileId: string) {
  return {
    id: fileId,
    headRevisionId: 'revision-1',
    size: '6',
    mimeType: 'video/webm',
    md5Checksum: 'checksum-1',
    capabilities: { canDownload: true },
  };
}

describe('DriveOriginPreparer', () => {
  it('reuses Drive-backed media without reading source bytes', async () => {
    const store = new ShareUploadStore(memoryArea());
    const source = jest.fn(async () => {
      throw new Error('Drive-backed publication must not resolve media bytes');
    });
    const service = api();
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/drive/v3/files/drive-file-1?fields=')) {
        return json(driveMetadata('drive-file-1'));
      }
      if (url.includes('/drive/v3/files/drive-file-1/revisions/revision-1?fields=')
        && method === 'PATCH') {
        return json({ id: 'revision-1', keepForever: true });
      }
      if (url.includes('/drive/v3/files/drive-file-1/permissions?fields=permissions')
        && method === 'GET') {
        return json({ permissions: [] });
      }
      if (url.includes('/drive/v3/files/drive-file-1/permissions?fields=id')
        && method === 'POST') {
        return json({ id: 'permission-1' }, 201);
      }
      throw new Error(`Unexpected Drive request: ${method} ${url}`);
    });
    const preparer = new DriveOriginPreparer({
      store,
      source,
      api: service,
      getDriveToken: async () => 'owner-token',
      fetch: fetcher as typeof fetch,
      now: () => 100,
    });

    await expect(preparer.prepare('share-1', [plan({ kind: 'drive', fileId: 'drive-file-1' })]))
      .resolves.toEqual([{
        sourceRecordingId: 'private-recording',
        recordingId: 'public-recording',
        trackId: 'public-track',
        fileId: 'drive-file-1',
        revisionId: 'revision-1',
        bytes: 6,
        mimeType: 'video/webm',
        md5Checksum: 'checksum-1',
        permissionId: 'permission-1',
        createdDriveCopy: false,
      }]);

    expect(source).not.toHaveBeenCalled();
    expect(service.registerDriveOrigin).toHaveBeenCalledWith({
      shareId: 'share-1',
      recordingId: 'public-recording',
      trackId: 'public-track',
      fileId: 'drive-file-1',
      revisionId: 'revision-1',
      bytes: 6,
      mimeType: 'video/webm',
      md5Checksum: 'checksum-1',
      permissionId: 'permission-1',
    });
    expect(await store.list('share-1')).toEqual([
      expect.objectContaining({
        status: 'completed',
        driveFileId: 'drive-file-1',
        revisionId: 'revision-1',
        permissionId: 'permission-1',
        createdDriveCopy: false,
        offset: 6,
      }),
    ]);
  });

  it('resumes an OPFS-to-Drive upload from the server-confirmed offset', async () => {
    const store = new ShareUploadStore(memoryArea());
    const sessionUri = 'https://upload.example/session-1';
    const publishedPlan = plan({ kind: 'opfs', key: 'library/private/tab.webm' });
    await store.put({
      id: 'share-1:public-recording:public-track',
      shareId: 'share-1',
      sourceRecordingId: 'private-recording',
      recordingId: 'public-recording',
      trackId: 'public-track',
      source: structuredClone(publishedPlan.tracks[0].source),
      mimeType: 'video/webm',
      bytes: 6,
      offset: 0,
      status: 'uploading',
      uploadId: sessionUri,
      createdDriveCopy: true,
      updatedAt: 1,
    });
    const reads: Array<[number, number]> = [];
    const bytes = new Blob(['abcdef'], { type: 'video/webm' });
    const source = jest.fn(async () => ({
      size: bytes.size,
      read: async (start: number, end: number) => {
        reads.push([start, end]);
        return bytes.slice(start, end, 'video/webm');
      },
    }));
    const service = api();
    let sessionPuts = 0;
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const headers = new Headers(init?.headers);
      if (url === sessionUri && method === 'PUT') {
        sessionPuts += 1;
        if (headers.get('content-range') === 'bytes */6') {
          return {
            status: 308,
            headers: {
              get: (name: string) => name.toLowerCase() === 'range' ? 'bytes=0-2' : null,
            },
          } as Response;
        }
        expect(headers.get('content-range')).toBe('bytes 3-5/6');
        return json({ id: 'drive-copy-1' }, 200);
      }
      if (url.includes('/upload/drive/v3/files?uploadType=resumable')) {
        throw new Error('A new resumable upload must not be created');
      }
      if (url.includes('/drive/v3/files/drive-copy-1?fields=')) {
        return json(driveMetadata('drive-copy-1'));
      }
      if (url.includes('/drive/v3/files/drive-copy-1/revisions/revision-1?fields=')
        && method === 'PATCH') {
        return json({ id: 'revision-1', keepForever: true });
      }
      if (url.includes('/drive/v3/files/drive-copy-1/permissions?fields=permissions')
        && method === 'GET') {
        return json({
          permissions: [{
            id: 'permission-existing',
            type: 'user',
            role: 'reader',
            emailAddress: 'reader@example.iam.gserviceaccount.com',
          }],
        });
      }
      throw new Error(`Unexpected Drive request: ${method} ${url}`);
    });
    const preparer = new DriveOriginPreparer({
      store,
      source,
      api: service,
      getDriveToken: async () => 'owner-token',
      fetch: fetcher as typeof fetch,
      sleep: async () => {},
    });

    const result = await preparer.prepare('share-1', [publishedPlan]);

    expect(reads).toEqual([[3, 6]]);
    expect(sessionPuts).toBe(2);
    expect(result[0]).toEqual(expect.objectContaining({
      fileId: 'drive-copy-1',
      revisionId: 'revision-1',
      permissionId: 'permission-existing',
      createdDriveCopy: true,
    }));
    const jobs = await store.list('share-1');
    expect(jobs).toEqual([
      expect.objectContaining({
        status: 'completed',
        driveFileId: 'drive-copy-1',
        offset: 6,
      }),
    ]);
    expect(jobs[0].uploadId).toBeUndefined();
  });

  it('reuses the Drive copy created for the same OPFS source across later shares', async () => {
    const store = new ShareUploadStore(memoryArea());
    const registry = new ShareDriveOriginRegistry(memoryArea());
    const bytes = new Blob(['abcdef'], { type: 'video/webm' });
    const source = jest.fn(async () => ({
      size: bytes.size,
      read: async (start: number, end: number) => bytes.slice(start, end, 'video/webm'),
    }));
    const service = api();
    let uploadStarts = 0;
    let permissionId: string | undefined;
    const sessionUri = 'https://upload.example/reusable-session';
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/upload/drive/v3/files?uploadType=resumable')) {
        uploadStarts += 1;
        return json({ id: 'provisional' }, 200, { location: sessionUri });
      }
      if (url === sessionUri && method === 'PUT') {
        return json({ id: 'drive-copy-reusable' }, 200);
      }
      if (url.includes('/drive/v3/files/drive-copy-reusable?fields=')) {
        return json(driveMetadata('drive-copy-reusable'));
      }
      if (url.includes('/drive/v3/files/drive-copy-reusable/revisions/revision-1?fields=')
        && method === 'PATCH') {
        return json({ id: 'revision-1', keepForever: true });
      }
      if (url.includes('/drive/v3/files/drive-copy-reusable/permissions?fields=permissions')
        && method === 'GET') {
        return json({
          permissions: permissionId
            ? [{
              id: permissionId,
              type: 'user',
              role: 'reader',
              emailAddress: 'reader@example.iam.gserviceaccount.com',
            }]
            : [],
        });
      }
      if (url.includes('/drive/v3/files/drive-copy-reusable/permissions?fields=id')
        && method === 'POST') {
        permissionId = 'permission-reusable';
        return json({ id: permissionId }, 201);
      }
      throw new Error(`Unexpected Drive request: ${method} ${url}`);
    });
    const preparer = new DriveOriginPreparer({
      store,
      source,
      api: service,
      registry,
      getDriveToken: async () => 'owner-token',
      fetch: fetcher as typeof fetch,
    });
    const publishedPlan = plan({ kind: 'opfs', key: 'library/private/tab.webm' });

    const first = await preparer.prepare('share-1', [publishedPlan]);
    await preparer.clearShare('share-1');
    const second = await preparer.prepare('share-2', [publishedPlan]);

    expect(first[0].fileId).toBe('drive-copy-reusable');
    expect(second[0].fileId).toBe('drive-copy-reusable');
    expect(uploadStarts).toBe(1);
    expect(source).toHaveBeenCalledTimes(1);
    expect(service.registerDriveOrigin).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        shareId: 'share-2',
        fileId: 'drive-copy-reusable',
        revisionId: 'revision-1',
        permissionId: 'permission-reusable',
      }),
    );
  });

  it('reuploads OPFS media when the reusable Drive copy no longer has the recorded revision', async () => {
    const store = new ShareUploadStore(memoryArea());
    const registry = new ShareDriveOriginRegistry(memoryArea());
    const bytes = new Blob(['abcdef'], { type: 'video/webm' });
    const source = jest.fn(async () => ({
      size: bytes.size,
      read: async (start: number, end: number) => bytes.slice(start, end, 'video/webm'),
    }));
    let uploadStarts = 0;
    let firstCopyRevision = 'revision-1';
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/upload/drive/v3/files?uploadType=resumable')) {
        uploadStarts += 1;
        return json({}, 200, { location: `https://upload.example/session-${uploadStarts}` });
      }
      if (url === 'https://upload.example/session-1' && method === 'PUT') {
        return json({ id: 'drive-copy-1' });
      }
      if (url === 'https://upload.example/session-2' && method === 'PUT') {
        return json({ id: 'drive-copy-2' });
      }
      if (url.includes('/drive/v3/files/drive-copy-1?fields=')) {
        return json({
          ...driveMetadata('drive-copy-1'),
          headRevisionId: firstCopyRevision,
          md5Checksum: firstCopyRevision === 'revision-1' ? 'checksum-1' : 'checksum-mutated',
        });
      }
      if (url.includes('/drive/v3/files/drive-copy-2?fields=')) {
        return json({
          ...driveMetadata('drive-copy-2'),
          headRevisionId: 'revision-2',
          md5Checksum: 'checksum-2',
        });
      }
      if (url.includes('/revisions/') && method === 'PATCH') {
        return json({ keepForever: true });
      }
      if (url.includes('/permissions?fields=permissions') && method === 'GET') {
        return json({
          permissions: [{
            id: url.includes('drive-copy-1') ? 'permission-1' : 'permission-2',
            type: 'user',
            role: 'reader',
            emailAddress: 'reader@example.iam.gserviceaccount.com',
          }],
        });
      }
      throw new Error(`Unexpected Drive request: ${method} ${url}`);
    });
    const preparer = new DriveOriginPreparer({
      store,
      source,
      api: api(),
      registry,
      getDriveToken: async () => 'owner-token',
      fetch: fetcher as typeof fetch,
    });
    const publishedPlan = plan({ kind: 'opfs', key: 'library/private/tab.webm' });

    expect((await preparer.prepare('share-1', [publishedPlan]))[0].fileId).toBe('drive-copy-1');
    await preparer.clearShare('share-1');
    firstCopyRevision = 'revision-mutated';

    const second = await preparer.prepare('share-2', [publishedPlan]);

    expect(second[0]).toEqual(expect.objectContaining({
      fileId: 'drive-copy-2',
      revisionId: 'revision-2',
      md5Checksum: 'checksum-2',
    }));
    expect(uploadStarts).toBe(2);
    expect(source).toHaveBeenCalledTimes(2);
    await expect(registry.get('private-recording', 'private-track-id')).resolves.toEqual(expect.objectContaining({
      driveFileId: 'drive-copy-2',
      revisionId: 'revision-2',
      md5Checksum: 'checksum-2',
    }));
  });

  it('backs off and retries Drive metadata quota responses', async () => {
    const store = new ShareUploadStore(memoryArea());
    const sleep = jest.fn(async () => {});
    let metadataAttempts = 0;
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/drive/v3/files/drive-file-1?fields=')) {
        metadataAttempts += 1;
        if (metadataAttempts <= 2) {
          return json({
            error: {
              errors: [{ reason: 'userRateLimitExceeded' }],
            },
          }, 403);
        }
        return json(driveMetadata('drive-file-1'));
      }
      if (url.includes('/drive/v3/files/drive-file-1/revisions/revision-1?fields=')
        && method === 'PATCH') {
        return json({ id: 'revision-1', keepForever: true });
      }
      if (url.includes('/drive/v3/files/drive-file-1/permissions?fields=permissions')
        && method === 'GET') {
        return json({
          permissions: [{
            id: 'permission-1',
            type: 'user',
            role: 'reader',
            emailAddress: 'reader@example.iam.gserviceaccount.com',
          }],
        });
      }
      throw new Error(`Unexpected Drive request: ${method} ${url}`);
    });
    const preparer = new DriveOriginPreparer({
      store,
      source: async () => { throw new Error('source should not be read'); },
      api: api(),
      getDriveToken: async () => 'owner-token',
      fetch: fetcher as typeof fetch,
      sleep,
    });

    await preparer.prepare('share-1', [plan({ kind: 'drive', fileId: 'drive-file-1' })]);

    expect(metadataAttempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });
});
