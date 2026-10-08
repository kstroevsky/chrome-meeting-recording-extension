import type { ArtifactByteSource } from '../../../media/ArtifactByteSource';
import type { UploadCreate } from '../../../integrations/media/ExternalMediaClient';
import { MediaHttpError } from '../../../integrations/media/ExternalMediaClient';
import { ExternalMediaTransferRunner } from '../ExternalMediaTransferRunner';
import { ExternalMediaTransferStore, type ExternalMediaTransfer } from '../ExternalMediaTransferStore';

const MiB = 1024 * 1024;
const artifactId = `media_${'a'.repeat(8)}-${'a'.repeat(4)}-${'4aaa'}-${'8aaa'}-${'a'.repeat(12)}`;
const uploadId = `upload_${'b'.repeat(8)}-${'b'.repeat(4)}-${'4bbb'}-${'8bbb'}-${'b'.repeat(12)}`;
const anotherUploadId = `upload_${'c'.repeat(8)}-${'c'.repeat(4)}-${'4ccc'}-${'8ccc'}-${'c'.repeat(12)}`;

const request: UploadCreate = {
  clientTransferId: 'transfer-1', recordingId: `recording_${'d'.repeat(8)}-${'d'.repeat(4)}-4ddd-8ddd-${'d'.repeat(12)}`,
  artifact: { role: 'tab-recording', filename: 'recording.webm', mimeType: 'video/webm', bytes: 12 * MiB },
};
const input = { destinationId: 'destination_one', source: { kind: 'opfs' as const, key: 'recording.webm' }, request };

function mockSource(size: number, reads: Array<[number, number]>): ArtifactByteSource {
  return { size, async read(start, end) {
    reads.push([start, end]);
    // Range verification without allocating hundreds of megabytes.
    return { size: end - start } as Blob;
  } };
}

function memoryStore() {
  const map: Record<string, unknown> = {};
  return new ExternalMediaTransferStore({
    getAll: async () => structuredClone(map),
    set: async (items) => { Object.assign(map, structuredClone(items)); },
    remove: async (key) => { delete map[key]; },
  });
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    create: jest.fn(async () => ({ state: 'uploading' as const, artifactId, uploadId,
      partSize: 5 * MiB, maxConcurrency: 2, strategy: 'multipart-put-v1' as const })),
    status: jest.fn(async () => ({ state: 'uploading' as const, artifactId, uploadedParts: [] })),
    uploadPart: jest.fn(async (_upload: string, part: number) => `"etag-${part}"`),
    complete: jest.fn(async (_uploadId: string, _parts: unknown, _signal?: AbortSignal) => ({ state: 'ready' as const, artifactId })),
    playback: jest.fn(async () => ({ url: 'https://media.example.test/object?signature=opaque', expiresAt: new Date().toISOString() })),
    ...overrides,
  };
}

describe('durable external media transfer runner', () => {
  it('uploads exactly bounded byte ranges, persists results and keeps ready markers until acknowledged', async () => {
    const reads: Array<[number, number]> = [];
    const store = memoryStore();
    let inFlight = 0;
    let peak = 0;
    const api = client({ uploadPart: jest.fn(async (_upload: string, part: number) => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return `"etag-${part}"`;
    }) });
    const runner = new ExternalMediaTransferRunner(api, store);
    await expect(runner.transfer(input, mockSource(request.artifact.bytes, reads))).resolves.toEqual({ state: 'ready', artifactId });
    expect(reads.sort((a, b) => a[0] - b[0])).toEqual([
      [0, 5 * MiB], [5 * MiB, 10 * MiB], [10 * MiB, 12 * MiB],
    ]);
    expect(peak).toBeLessThanOrEqual(2);
    expect(api.complete).toHaveBeenCalledWith(uploadId, [
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 3, etag: '"etag-3"' },
    ], undefined);
    expect((await store.list())[0]).toMatchObject({ state: 'ready-unacknowledged', artifactId });
    await expect(runner.transfer(input, mockSource(request.artifact.bytes, []))).resolves.toEqual({ state: 'ready', artifactId });
    expect(api.create).toHaveBeenCalledTimes(1);
    await store.acknowledge(input.destinationId, request.clientTransferId);
    expect(await store.list()).toEqual([]);
  });

  it('resumes from provider ListParts, never trusts a stale local ETag', async () => {
    const store = memoryStore();
    const saved: ExternalMediaTransfer = {
      ...input, uploadId, artifactId, partSize: 5 * MiB, maxConcurrency: 3,
      state: 'uploading', uploadedParts: [{ partNumber: 2, etag: 'stale' }],
    };
    await store.put(saved);
    const api = client({ status: jest.fn(async () => ({ state: 'uploading' as const, artifactId,
      uploadedParts: [{ partNumber: 1, etag: '"provider-1"' }] })) });
    const reads: Array<[number, number]> = [];
    await new ExternalMediaTransferRunner(api, store).transfer(input, mockSource(request.artifact.bytes, reads));
    expect(api.create).not.toHaveBeenCalled();
    expect(reads).toHaveLength(2);
    expect(api.complete.mock.calls[0]?.[1]).toEqual([
      { partNumber: 1, etag: '"provider-1"' },
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 3, etag: '"etag-3"' },
    ]);
  });

  it('recreates expired upload attempts under the same logical transfer', async () => {
    const store = memoryStore();
    await store.put({ ...input, uploadId, artifactId, partSize: 5 * MiB, maxConcurrency: 2,
      state: 'uploading', uploadedParts: [{ partNumber: 1, etag: 'old' }] });
    const api = client({
      status: jest.fn(async (id: string) => {
        if (id === uploadId) throw new MediaHttpError(410);
        return { state: 'uploading' as const, artifactId, uploadedParts: [] };
      }),
      create: jest.fn(async () => ({ state: 'uploading' as const, artifactId,
        uploadId: anotherUploadId, partSize: 5 * MiB, maxConcurrency: 2, strategy: 'multipart-put-v1' as const })),
    });
    await new ExternalMediaTransferRunner(api, store).transfer(input, mockSource(request.artifact.bytes, []));
    expect(api.create).toHaveBeenCalledWith(request, undefined);
    expect(api.complete.mock.calls[0]?.[0]).toBe(anotherUploadId);
    expect((await store.list())[0]?.uploadId).toBe(anotherUploadId);
  });

  it('recovers a lost completion reply from the server ready status on the next invocation', async () => {
    const store = memoryStore();
    let completedRemotely = false;
    const api = client({
      status: jest.fn(async () => completedRemotely
        ? { state: 'ready' as const, artifactId, uploadedParts: [] }
        : { state: 'uploading' as const, artifactId, uploadedParts: [] }),
      complete: jest.fn().mockRejectedValueOnce(new Error('connection reset')),
    });
    const runner = new ExternalMediaTransferRunner(api, store);
    await expect(runner.transfer(input, mockSource(request.artifact.bytes, [])))
      .rejects.toThrow('connection reset');
    completedRemotely = true;
    await expect(runner.transfer(input, mockSource(request.artifact.bytes, [])))
      .resolves.toEqual({ state: 'ready', artifactId });
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.playback).toHaveBeenCalledWith(artifactId);
  });

  it('reduces concurrency for large parts to respect the 256 MiB in-flight limit', async () => {
    const hugeRequest = { ...request, artifact: { ...request.artifact, bytes: 400 * MiB } };
    const api = client({ create: jest.fn(async () => ({ state: 'uploading' as const,
      artifactId, uploadId, partSize: 200 * MiB, maxConcurrency: 3, strategy: 'multipart-put-v1' as const })) });
    let inFlight = 0;
    let peak = 0;
    api.uploadPart.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
      return '"etag"';
    });
    await new ExternalMediaTransferRunner(api, memoryStore()).transfer(
      { ...input, request: hugeRequest }, mockSource(hugeRequest.artifact.bytes, []));
    expect(peak).toBe(1);
  });

  it('rejects invalid part sizes before reading any bytes or completing an upload', async () => {
    const api = client({ create: jest.fn(async () => ({ state: 'uploading' as const,
      artifactId, uploadId, partSize: 4 * MiB, maxConcurrency: 3, strategy: 'multipart-put-v1' as const })) });
    const reads: Array<[number, number]> = [];
    await expect(new ExternalMediaTransferRunner(api, memoryStore())
      .transfer(input, mockSource(request.artifact.bytes, reads))).rejects.toThrow('Unsupported upload parameters');
    expect(reads).toEqual([]);
  });
});
