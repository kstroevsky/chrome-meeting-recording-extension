import { IDBFactory } from 'fake-indexeddb';
import { MediaHttpError, type ExternalMediaGrant } from '../../../integrations/media/ExternalMediaClient';
import type { AuthorizedMediaRoute } from '../../../integrations/RecordingRoutingService';
import type { RecordingHistoryEntry, RecordingHistoryFile } from '../../../shared/recordingHistory';
import { libraryKey, type DirectoryHandleLike } from '../../storage/opfsLayout';
import { ExternalMediaTransferRuntime } from '../ExternalMediaTransferRuntime';
import { MediaUploadCompletingError } from '../ExternalMediaTransferRunner';
import { createExternalMediaTransferStore } from '../ExternalMediaTransferStore';

const capability = {
  version: 1 as const,
  apiBase: 'https://receiver.example.test/media',
  upload: { strategy: 'multipart-put-v1' as const, origins: ['https://upload.example.test'] },
  playback: { strategy: 'refreshable-url-v1' as const },
};
const route: AuthorizedMediaRoute = {
  destinationId: 'crm',
  externalRecordingId: 'recording_external',
  connectionVersion: 3,
  receiver: {
    producerId: 'receiver',
    endpoint: 'https://receiver.example.test/hooks',
    apiBase: capability.apiBase,
    uploadOrigins: [...capability.upload.origins],
  },
};
const grant: ExternalMediaGrant = {
  destinationId: route.destinationId,
  connectionVersion: route.connectionVersion,
  producerId: route.receiver.producerId,
  endpoint: route.receiver.endpoint,
  capability,
  bearer: 'never-persist-this-bearer',
};

function media(id: string, stream: 'tab' | 'mic'): RecordingHistoryFile {
  const filename = stream === 'tab' ? 'tab.webm' : 'mic.webm';
  return {
    id,
    stream,
    filename,
    mimeType: stream === 'tab' ? 'video/webm' : 'audio/webm',
    locations: [{ kind: 'opfs', key: libraryKey('local-recording', id, filename), retainedAt: 1 }],
    delivery: { requested: 'local', status: 'downloaded' },
    destination: 'local',
    status: 'available',
  };
}

function recording(): Pick<RecordingHistoryEntry, 'id' | 'status' | 'files' | 'deletedAt'> {
  return { id: 'local-recording', status: 'complete', files: [media('tab-file', 'tab'), media('mic-file', 'mic')] };
}

function opfs(): () => Promise<DirectoryHandleLike> {
  const file = { size: 6 * 1024 * 1024, slice: (start: number, end: number) => ({ size: end - start } as Blob) } as File;
  const root: DirectoryHandleLike = {
    getDirectoryHandle: jest.fn(async () => root),
    getFileHandle: jest.fn(async () => ({ getFile: async () => file } as unknown as FileSystemFileHandle)),
    removeEntry: jest.fn(async () => {}),
  };
  return async () => root;
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Condition did not settle');
}

describe('ExternalMediaTransferRuntime', () => {
  it('runs only one artifact globally and never persists its ephemeral bearer grant', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let createCount = 0;
    const create = jest.fn(async (): Promise<{ state: 'ready'; artifactId: string }> => {
      createCount += 1;
      if (createCount === 1) await firstGate;
      return { state: 'ready', artifactId: `artifact-${createCount}` };
    });
    const client = {
      create,
      status: jest.fn(),
      uploadPart: jest.fn(),
      complete: jest.fn(),
      playback: jest.fn(async () => ({ url: 'https://media.example.test/object', expiresAt: '2099-01-01T00:00:00Z' })),
    };
    const store = createExternalMediaTransferStore(new IDBFactory());
    const states: string[] = [];
    const runtime = new ExternalMediaTransferRuntime({
      store,
      getRoot: opfs(),
      onState: (state) => states.push(state.state),
      createClient: () => client as any,
    });

    await runtime.enqueue({ recording: recording(), route, fileId: 'tab-file', sealed: true, grant });
    await until(() => create.mock.calls.length === 1);
    await runtime.enqueue({ recording: recording(), route, fileId: 'mic-file', sealed: true, grant });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(create).toHaveBeenCalledTimes(1);

    const persistedWhileRunning = JSON.stringify(await runtime.snapshot());
    expect(persistedWhileRunning).not.toContain(grant.bearer);
    releaseFirst();
    await until(() => create.mock.calls.length === 2 && states.filter((state) => state === 'ready-unacknowledged').length === 2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rejects a grant from a different receiver generation before journaling bytes', async () => {
    const store = createExternalMediaTransferStore(new IDBFactory());
    const runtime = new ExternalMediaTransferRuntime({
      store,
      getRoot: opfs(),
      onState: jest.fn(),
      createClient: jest.fn() as any,
    });

    await expect(runtime.enqueue({
      recording: recording(),
      route,
      fileId: 'tab-file',
      sealed: true,
      grant: { ...grant, connectionVersion: route.connectionVersion + 1 },
    })).rejects.toThrow('does not match recording authorization');
    await expect(runtime.snapshot()).resolves.toEqual([]);
  });

  it('does not let an explicit retry reset queued or active work', async () => {
    const store = createExternalMediaTransferStore(new IDBFactory());
    const registered = await store.enqueue({
      recording: recording(),
      route,
      fileId: 'tab-file',
      sealed: true,
      getRoot: opfs(),
    });
    const runtime = new ExternalMediaTransferRuntime({
      store,
      getRoot: opfs(),
      onState: jest.fn(),
      createClient: jest.fn() as any,
    });

    await expect(runtime.retry(
      registered.destinationId,
      registered.request.clientTransferId,
      grant,
    )).rejects.toThrow('not retryable');
    await expect(store.get(registered.destinationId, registered.request.clientTransferId))
      .resolves.toMatchObject({ state: 'queued', attempts: 0 });
  });

  it('keeps a prolonged completion lease on durable retry instead of requiring manual action', async () => {
    const store = createExternalMediaTransferStore(new IDBFactory());
    const registered = await store.enqueue({
      recording: recording(),
      route,
      fileId: 'tab-file',
      sealed: true,
      getRoot: opfs(),
    });
    await store.put({
      ...registered,
      state: 'uploading',
      uploadId: 'upload_00000000-0000-4000-8000-000000000001',
      artifactId: 'media_00000000-0000-4000-8000-000000000002',
      partSize: 5 * 1024 * 1024,
      maxConcurrency: 2,
    });
    const status = jest.fn()
      .mockRejectedValueOnce(new MediaUploadCompletingError(
        new MediaHttpError(409, 'MEDIA_UPLOAD_COMPLETING'),
      ))
      .mockResolvedValue({
        state: 'ready' as const,
        artifactId: 'media_00000000-0000-4000-8000-000000000002',
      });
    const states: string[] = [];
    let now = 1_000;
    const runtime = new ExternalMediaTransferRuntime({
      store,
      getRoot: opfs(),
      onState: (transfer) => states.push(transfer.state),
      now: () => now,
      createClient: () => ({
        create: jest.fn(),
        status,
        uploadPart: jest.fn(),
        complete: jest.fn(),
        playback: jest.fn(async () => ({
          url: 'https://media.example.test/object',
          expiresAt: '2099-01-01T00:00:00Z',
        })),
      }) as any,
    });

    await runtime.enqueue({ recording: recording(), route, fileId: 'tab-file', sealed: true, grant });
    await until(() => states.includes('retry-wait'));
    const waiting = (await runtime.snapshot())[0]!;
    expect(waiting).toMatchObject({ state: 'retry-wait', errorCategory: 'provider' });

    now = waiting.nextAttemptAt!;
    await runtime.enqueue({ recording: recording(), route, fileId: 'tab-file', sealed: true, grant });
    await until(() => states.includes('ready-unacknowledged'));
    expect(status).toHaveBeenCalledTimes(2);
    await expect(runtime.snapshot()).resolves.toEqual([
      expect.objectContaining({
        state: 'ready-unacknowledged',
        artifactId: 'media_00000000-0000-4000-8000-000000000002',
      }),
    ]);
  });

  it('resumes capability verification and its durable retry without reopening retained source bytes', async () => {
    const store = createExternalMediaTransferStore(new IDBFactory());
    const registered = await store.enqueue({
      recording: recording(),
      route,
      fileId: 'tab-file',
      sealed: true,
      getRoot: opfs(),
    });
    await store.put({
      ...registered,
      state: 'verifying-capability',
      artifactId: 'artifact-already-ready',
    });
    const getRoot = jest.fn(async (): Promise<DirectoryHandleLike> => {
      throw new Error('retained source must not be reopened');
    });
    const playback = jest.fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValue({
        url: 'https://media.example.test/object',
        expiresAt: '2099-01-01T00:00:00Z',
      });
    const states: string[] = [];
    let now = 1_000;
    const runtime = new ExternalMediaTransferRuntime({
      store,
      getRoot,
      onState: (transfer) => states.push(transfer.state),
      now: () => now,
      createClient: () => ({
        create: jest.fn(),
        status: jest.fn(),
        uploadPart: jest.fn(),
        complete: jest.fn(),
        playback,
      }) as any,
    });

    await runtime.enqueue({ recording: recording(), route, fileId: 'tab-file', sealed: true, grant });
    await until(() => states.includes('retry-wait'));
    const waiting = (await runtime.snapshot())[0]!;
    expect(waiting).toMatchObject({ state: 'retry-wait', resumeFrom: 'verifying-capability' });
    now = waiting.nextAttemptAt!;
    await runtime.enqueue({ recording: recording(), route, fileId: 'tab-file', sealed: true, grant });
    await until(() => states.includes('ready-unacknowledged'));
    expect(getRoot).not.toHaveBeenCalled();
    expect(playback).toHaveBeenCalledTimes(2);
    expect(playback).toHaveBeenCalledWith('artifact-already-ready');
    await expect(runtime.snapshot()).resolves.toEqual([
      expect.objectContaining({ state: 'ready-unacknowledged', artifactId: 'artifact-already-ready' }),
    ]);
  });
});
