import { IDBFactory } from 'fake-indexeddb';
import type { AuthorizedMediaRoute } from '../../../integrations/RecordingRoutingService';
import type { RecordingHistoryEntry, RecordingHistoryFile } from '../../../shared/recordingHistory';
import { libraryKey, type DirectoryHandleLike } from '../../storage/opfsLayout';
import { createExternalMediaTransferStore } from '../ExternalMediaTransferStore';

const recordingId = 'local-recording';
const fileId = 'local-file';
const sourceKey = libraryKey(recordingId, fileId, 'clip.webm');
const route: AuthorizedMediaRoute = {
  destinationId: 'crm', externalRecordingId: 'recording_external', connectionVersion: 1,
  receiver: { producerId: 'receiver', endpoint: 'https://receiver.example.test',
    apiBase: 'https://receiver.example.test/media', uploadOrigins: ['https://upload.example.test'] },
};

const media = (): RecordingHistoryFile => ({
  id: fileId, stream: 'tab', filename: 'clip.webm', mimeType: 'video/webm',
  locations: [{ kind: 'opfs', key: sourceKey, retainedAt: 1 }],
  delivery: { requested: 'local', status: 'downloaded' },
  destination: 'local', status: 'available', bytes: 0,
});

const recording = (): Pick<RecordingHistoryEntry, 'id' | 'status' | 'files' | 'deletedAt'> => ({
  id: recordingId, status: 'complete', files: [media()],
});

function source(bytes = 11 * 1024 * 1024) {
  const getFile = jest.fn(async () => ({ size: bytes } as File));
  const root: DirectoryHandleLike = {
    getDirectoryHandle: jest.fn(async () => root),
    getFileHandle: jest.fn(async () => ({ getFile } as unknown as FileSystemFileHandle)),
    removeEntry: jest.fn(async () => {}),
  };
  return { getRoot: jest.fn(async () => root), getFile };
}

describe('ExternalMediaTransferStore durable logical identity', () => {
  it('atomically registers a single identity across two offscreen instances', async () => {
    const factory = new IDBFactory();
    const stores = [createExternalMediaTransferStore(factory), createExternalMediaTransferStore(factory)];
    const { getRoot } = source();
    const input = { recording: recording(), route, fileId, sealed: true as const, getRoot };
    const rows = await Promise.all(Array.from({ length: 12 }, (_, index) => stores[index % 2].enqueue(input)));
    expect(new Set(rows.map((row) => row.request.clientTransferId)).size).toBe(1);
    expect((await stores[0].list())).toHaveLength(1);
    expect(rows[0].request.artifact).toEqual({
      role: 'tab-recording', filename: 'clip.webm', mimeType: 'video/webm', bytes: 11 * 1024 * 1024,
    });
  });

  it('preserves request metadata across a rename, and replays ready results without OPFS bytes', async () => {
    const store = createExternalMediaTransferStore(new IDBFactory());
    const first = await store.enqueue({ recording: recording(), route, fileId,
      sealed: true, getRoot: source().getRoot });
    await store.put({ ...first, state: 'ready-unacknowledged', artifactId: 'artifact-1' });

    const renamed = recording();
    renamed.files[0].filename = 'renamed.webm';
    const missing = jest.fn<Promise<DirectoryHandleLike>, []>(async () => { throw new Error('OPFS gone'); });
    const replay = await store.enqueue({ recording: renamed, route, fileId, sealed: true, getRoot: missing });
    expect(missing).not.toHaveBeenCalled();
    expect(replay).toMatchObject({ state: 'ready-unacknowledged', artifactId: 'artifact-1',
      request: first.request });
    await store.acknowledge(route.destinationId, first.request.clientTransferId);
    await store.acknowledge(route.destinationId, first.request.clientTransferId);
    expect((await store.enqueue({ recording: renamed, route, fileId, sealed: true,
      getRoot: missing })).state).toBe('acknowledged');
    expect(await store.list()).toHaveLength(1); // tombstone prevents duplicate receiver artifacts
  });

  it('atomically prevents an uploader from overwriting cancellation or acknowledgement', async () => {
    const factory = new IDBFactory();
    const firstStore = createExternalMediaTransferStore(factory);
    const secondStore = createExternalMediaTransferStore(factory);
    const row = await firstStore.enqueue({ recording: recording(), route, fileId,
      sealed: true, getRoot: source().getRoot });
    await secondStore.cancel('crm', row.request.clientTransferId);
    await expect(firstStore.put({ ...row, state: 'uploading' })).rejects.toThrow('terminal');
    await expect(firstStore.acknowledge('crm', row.request.clientTransferId))
      .rejects.toThrow('not ready');
    expect((await firstStore.list())[0].state).toBe('canceled');

    const alternate = await secondStore.enqueue({ recording: recording(),
      route: { ...route, connectionVersion: 2 }, fileId, sealed: true, getRoot: source().getRoot });
    await firstStore.put({ ...alternate, state: 'ready-unacknowledged', artifactId: 'artifact-2' });
    await Promise.all([
      firstStore.acknowledge('crm', alternate.request.clientTransferId),
      secondStore.acknowledge('crm', alternate.request.clientTransferId),
    ]);
    await expect(firstStore.put({ ...alternate, state: 'uploading' })).rejects.toThrow('terminal');
    expect((await secondStore.get('crm', alternate.request.clientTransferId))?.state).toBe('acknowledged');
  });

  it('rejects missing authorization, unsealed, deleted, sidecar and foreign files', async () => {
    const store = createExternalMediaTransferStore(new IDBFactory());
    const base = { recording: recording(), route, fileId, sealed: true as const,
      getRoot: source().getRoot };
    await expect(store.enqueue({ ...base, sealed: false as unknown as true }))
      .rejects.toThrow('sealed');
    await expect(store.enqueue({ ...base, recording: { ...recording(), deletedAt: 12 } }))
      .rejects.toThrow('sealed');
    await expect(store.enqueue({ ...base, recording: { ...recording(), status: 'saving' } }))
      .rejects.toThrow('sealed');
    await expect(store.enqueue({ ...base, recording: { ...recording(), files: [{ ...media(), kind: 'notes' }] } }))
      .rejects.toThrow('Unsupported');
    await expect(store.enqueue({ ...base, route: { ...route, connectionVersion: 0 } }))
      .rejects.toThrow('Invalid authorized');
    const foreign = { ...media(), locations: [{ kind: 'opfs' as const,
      key: libraryKey('other-recording', fileId, 'clip.webm'), retainedAt: 1 }] };
    await expect(store.enqueue({ ...base, recording: { ...recording(), files: [foreign] } }))
      .rejects.toThrow('Owned retained media');
    await expect(store.enqueue({ ...base, recording: { ...recording(), files: [{ ...media(), mimeType: 'text/plain' }] } }))
      .rejects.toThrow('MIME');
    expect(await store.list()).toHaveLength(0);
  });

  it('rejects immutable request changes and records separate receiver generations', async () => {
    const store = createExternalMediaTransferStore(new IDBFactory());
    const base = { recording: recording(), route, fileId, sealed: true as const,
      getRoot: source().getRoot };
    const row = await store.enqueue(base);
    await expect(store.put({ ...row, request: { ...row.request,
      artifact: { ...row.request.artifact, filename: 'tampered.webm' } } }))
      .rejects.toThrow('immutable');
    const other = await store.enqueue({ ...base, route: { ...route, connectionVersion: 2 } });
    expect(other.request.clientTransferId).not.toBe(row.request.clientTransferId);
    expect((await store.list())).toHaveLength(2);
  });
});
