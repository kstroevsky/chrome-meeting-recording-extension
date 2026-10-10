import { RecordingHistoryService } from '../RecordingHistoryService';
import { MemoryRepository } from './RecordingHistoryService.testSupport';

describe('RecordingHistoryService artifact replicas', () => {
  const uploadJob = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-1',
    historyId: 'r1',
    label: 'Demo',
    status: 'completed' as const,
    progress: 1,
    files: [{ stream: 'tab' as const, filename: 'demo-recording.webm', status: 'uploaded' as const, driveFileId: 'd1' }],
    startedAt: 10,
    finishedAt: 11,
    ...overrides,
  });
  const tabFile = async (repo: MemoryRepository) => (await repo.get('r1'))!.files[0];
  const seedRetainedExternal = (repo: MemoryRepository, playbackVerifiedAt?: number) => {
    repo.entries.set('r1', {
      id: 'r1',
      name: 'Demo',
      createdAt: 1,
      storageMode: 'local',
      status: 'complete',
      files: [{
        id: 'r1:tab',
        stream: 'tab',
        filename: 'demo-recording.webm',
        mimeType: 'video/webm',
        bytes: 123,
        locations: [
          { kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 5 },
          {
            kind: 'external', destinationId: 'crm', artifactId: 'media-1',
            ...(playbackVerifiedAt != null ? { playbackVerifiedAt } : {}),
          },
        ],
        delivery: { requested: 'local', status: 'downloaded' },
        destination: 'local',
        status: 'available',
      }],
    });
  };

  it('starts a pending row with no replicas and the requested delivery recorded', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');

    expect(await tabFile(repo)).toMatchObject({
      mimeType: 'video/webm',
      locations: [],
      delivery: { requested: 'drive', status: 'pending' },
    });
  });

  it('models external primary ownership independently from retained OPFS recovery', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    const requested = { kind: 'external' as const, destinationId: 'crm' };
    await service.createPending(
      'r1',
      [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }],
      requested,
    );

    expect(await repo.get('r1')).toMatchObject({
      storageMode: 'local',
      status: 'saving',
      files: [{
        destination: 'local',
        status: 'pending',
        delivery: { requested, status: 'pending' },
      }],
    });

    await service.recordArtifactLocation('r1', 'r1:tab', {
      kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 11,
    });
    expect(await repo.get('r1')).toMatchObject({
      status: 'complete',
      files: [{
        status: 'available',
        locations: [{ kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 11 }],
        delivery: { requested, status: 'pending' },
      }],
    });
  });

  it('satisfies external primary delivery only with a replica from the requested destination', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending(
      'r1',
      [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }],
      { kind: 'external', destinationId: 'crm' },
    );
    await service.recordArtifactLocation('r1', 'r1:tab', {
      kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 11,
    });

    await service.recordArtifactLocation('r1', 'r1:tab', {
      kind: 'external', destinationId: 'archive', artifactId: 'archive-1',
    });
    expect((await tabFile(repo)).delivery).toEqual({
      requested: { kind: 'external', destinationId: 'crm' }, status: 'pending',
    });

    await service.recordArtifactLocation('r1', 'r1:tab', {
      kind: 'external', destinationId: 'crm', artifactId: 'crm-1',
    });
    expect((await tabFile(repo)).delivery).toEqual({
      requested: { kind: 'external', destinationId: 'crm' }, status: 'uploaded',
    });
  });

  it('keeps external recovery bytes locally playable through pending and failed remote delivery', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending(
      'r1',
      [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }],
      { kind: 'external', destinationId: 'crm' },
    );
    await service.recordArtifactLocation('r1', 'r1:tab', {
      kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 11,
    });

    await service.setExternalDeliveryState('r1', 'r1:tab', 'crm', 'failed', 'Canceled');
    expect(await tabFile(repo)).toMatchObject({
      status: 'available',
      locations: [{ kind: 'opfs', key: 'library/r1/tab.webm' }],
      delivery: {
        requested: { kind: 'external', destinationId: 'crm' }, status: 'failed', error: 'Canceled',
      },
    });
    await service.setExternalDeliveryState('r1', 'r1:tab', 'crm', 'pending');
    expect((await tabFile(repo)).delivery).toEqual({
      requested: { kind: 'external', destinationId: 'crm' }, status: 'pending',
    });
  });

  it('retargets external primary ownership only through an exact requested-destination replacement', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending(
      'r1',
      [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }],
      { kind: 'external', destinationId: 'crm' },
    );
    await service.recordArtifactLocation('r1', 'r1:tab', {
      kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 11,
    });

    await expect(service.replaceExternalPrimaryDestination('r1', 'other', 'journal')).resolves.toBe(false);
    expect((await tabFile(repo)).delivery.requested).toEqual({ kind: 'external', destinationId: 'crm' });

    await expect(service.replaceExternalPrimaryDestination('r1', 'crm', 'journal')).resolves.toBe(true);
    expect((await tabFile(repo)).delivery).toEqual({
      requested: { kind: 'external', destinationId: 'journal' }, status: 'pending',
    });
  });

  it('adds a drive replica on upload without disturbing an existing download replica', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');
    await service.localSaveSettled('r1', 'tab', 7, 'complete');

    await service.applyUploadJob(uploadJob({
      files: [{ stream: 'tab', filename: 'demo-recording.webm', status: 'uploaded', driveFileId: 'd1', webViewLink: 'https://drive.example/d1' }],
    }));

    expect(await tabFile(repo)).toMatchObject({
      locations: [
        { kind: 'download', downloadId: 7 },
        { kind: 'drive', fileId: 'd1', webViewLink: 'https://drive.example/d1' },
      ],
      delivery: { requested: 'drive', status: 'uploaded' },
    });
  });

  it('records a Drive-requested local save as local-fallback, and a local one as downloaded', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');
    await service.localSaveSettled('r1', 'tab', 7, 'complete');
    expect((await tabFile(repo)).delivery).toEqual({ requested: 'drive', status: 'local-fallback' });

    const localRepo = new MemoryRepository();
    const localService = new RecordingHistoryService(localRepo, jest.fn(), () => 10);
    await localService.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');
    await localService.localSaveSettled('r1', 'tab', 7, 'complete');
    expect((await tabFile(localRepo)).delivery).toEqual({ requested: 'local', status: 'downloaded' });
  });

  it('records no replica for an interrupted download and fails the delivery', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');

    await service.localSaveSettled('r1', 'tab', 7, 'interrupted');

    expect(await tabFile(repo)).toMatchObject({
      locations: [],
      delivery: { requested: 'local', status: 'failed', error: 'Download interrupted' },
    });
  });

  it('keeps an interrupted retained download pending and retryable', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');
    await service.recordArtifactLocation('r1', 'r1:tab', { kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 1 });
    await service.localSaveSettled('r1', 'tab', 7, 'interrupted', 'Download interrupted', undefined, true);

    expect(await tabFile(repo)).toMatchObject({
      status: 'pending',
      error: 'Download interrupted',
      delivery: { requested: 'local', status: 'pending', error: 'Download interrupted' },
    });
  });

  it('keeps an unsettled timed-out download pending and retryable', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');

    await service.localSaveSettled('r1', 'tab', 7, 'timeout');

    expect(await tabFile(repo)).toMatchObject({
      status: 'pending',
      downloadId: 7,
      delivery: { requested: 'local', status: 'pending' },
    });
  });

  it('holds delivery pending through a Drive failure until the local save settles', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');

    await service.applyTerminalUploadJob(uploadJob({
      status: 'failed',
      files: [{ stream: 'tab', filename: 'demo-recording.webm', status: 'fallback' }],
    }));
    // Drive is done and lost; whether this is a fallback or a total failure is
    // not yet known, so the outcome must not be guessed here.
    expect((await tabFile(repo)).delivery).toEqual({ requested: 'drive', status: 'pending' });

    await service.localSaveSettled('r1', 'tab', 7, 'complete');
    expect(await tabFile(repo)).toMatchObject({
      locations: [{ kind: 'download', downloadId: 7 }],
      delivery: { requested: 'drive', status: 'local-fallback' },
    });
  });

  it('fails the delivery when a recovery source is gone', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');

    await service.applyTerminalUploadJob(uploadJob({
      status: 'failed',
      files: [{ stream: 'tab', filename: 'demo-recording.webm', status: 'unavailable', error: 'Source gone' }],
    }));

    expect((await tabFile(repo)).delivery).toEqual({ requested: 'drive', status: 'failed', error: 'Source gone' });
  });

  it('reports a partial delivery per file rather than one verdict for the recording', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [
      { id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' },
      { id: 'r1:mic', stream: 'mic', filename: 'demo-mic.webm' },
    ], 'drive');

    await service.applyTerminalUploadJob(uploadJob({
      status: 'partial',
      files: [
        { stream: 'tab', filename: 'demo-recording.webm', status: 'uploaded', driveFileId: 'd1' },
        { stream: 'mic', filename: 'demo-mic.webm', status: 'unavailable', error: 'Source gone' },
      ],
    }));

    const entry = (await repo.get('r1'))!;
    expect(entry.files.map((file) => file.delivery)).toEqual([
      { requested: 'drive', status: 'uploaded' },
      { requested: 'drive', status: 'failed', error: 'Source gone' },
    ]);
    expect(entry.files[0].locations).toEqual([{ kind: 'drive', fileId: 'd1' }]);
    expect(entry.files[1].locations).toEqual([]);
  });

  it('does not duplicate a replica when the same completion is applied twice', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');

    await service.applyUploadJob(uploadJob());
    await service.applyUploadJob(uploadJob());
    await service.localSaveSettled('r1', 'tab', 7, 'complete');
    await service.localSaveSettled('r1', 'tab', 7, 'complete');

    expect((await tabFile(repo)).locations).toEqual([
      { kind: 'drive', fileId: 'd1' },
      { kind: 'download', downloadId: 7 },
    ]);
  });

  it('replaces rather than accumulates when a replica of the same kind moves', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');

    await service.localSaveSettled('r1', 'tab', 7, 'complete');
    await service.localSaveSettled('r1', 'tab', 8, 'complete');

    expect((await tabFile(repo)).locations).toEqual([{ kind: 'download', downloadId: 8 }]);
  });

  it('adds no replica to a tombstoned recording', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');
    await service.remove('r1');

    await service.applyUploadJob(uploadJob());
    await service.localSaveSettled('r1', 'tab', 7, 'complete');

    const entry = (await repo.get('r1'))!;
    expect(entry.deletedAt).toBe(10);
    expect(entry.files[0].locations).toEqual([]);
    expect(entry.files[0].delivery).toEqual({ requested: 'drive', status: 'pending' });
  });

  it('settles only the artifact of the matching kind, leaving the sidecar alone', async () => {
    // The sidecar rides the tab stream (ADR-0005). Matching on stream alone gave
    // it the media file's download id, and after ADR-0006 its replica and
    // delivery too.
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');
    await service.applyTerminalUploadJob(uploadJob({
      status: 'failed',
      files: [
        { stream: 'tab', filename: 'demo-recording.webm', status: 'fallback' },
        { stream: 'tab', kind: 'notes', filename: 'demo.vtt', status: 'fallback' },
      ],
    }));

    await service.localSaveSettled('r1', 'tab', 7, 'complete');

    const byId = new Map((await repo.get('r1'))!.files.map((file) => [file.id, file]));
    expect(byId.get('r1:tab')).toMatchObject({
      locations: [{ kind: 'download', downloadId: 7 }],
      delivery: { requested: 'drive', status: 'local-fallback' },
    });
    expect(byId.get('r1:notes')).toMatchObject({
      locations: [],
      delivery: { status: 'pending' },
    });
    expect(byId.get('r1:notes')?.downloadId).toBeUndefined();
  });

  it('settles the sidecar on its own download without touching the media row', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [
      { id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' },
      { id: 'r1:notes', stream: 'tab', kind: 'notes', filename: 'demo.vtt' },
    ], 'local');

    await service.localSaveSettled('r1', 'tab', 8, 'complete', undefined, 'notes');

    const byId = new Map((await repo.get('r1'))!.files.map((file) => [file.id, file]));
    expect(byId.get('r1:notes')).toMatchObject({
      mimeType: 'text/vtt',
      locations: [{ kind: 'download', downloadId: 8 }],
      delivery: { requested: 'local', status: 'downloaded' },
    });
    expect(byId.get('r1:tab')).toMatchObject({ locations: [], delivery: { status: 'pending' } });
  });

  it('drops only the named retained replica, keeping the row and its other copies', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');
    await service.recordArtifactLocation('r1', 'r1:tab', { kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 5 });
    await service.applyUploadJob(uploadJob());

    await service.dropArtifactLocation('r1', 'r1:tab', 'library/r1/tab.webm');

    // The Drive replica still makes this recording reachable, so the row stays.
    expect((await repo.get('r1'))!.files[0].locations).toEqual([{ kind: 'drive', fileId: 'd1' }]);
  });

  it('does not resurrect a tombstoned row when a replica is recorded or dropped', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');
    await service.remove('r1');

    await service.recordArtifactLocation('r1', 'r1:tab', { kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 5 });
    await service.dropArtifactLocation('r1', 'r1:tab', 'library/r1/tab.webm');

    const entry = (await repo.get('r1'))!;
    expect(entry.deletedAt).toBe(10);
    expect(entry.files[0].locations).toEqual([]);
  });

  it('does not offer retained-media release until the exact external artifact has played', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    seedRetainedExternal(repo);

    await expect(service.planVerifiedRetainedMediaRelease('r1')).resolves.toEqual([]);
    await expect(service.markExternalPlaybackVerified('r1', 'r1:tab', 'crm', 'media-1')).resolves.toBe(true);
    await expect(service.planVerifiedRetainedMediaRelease('r1')).resolves.toEqual([
      { fileId: 'r1:tab', key: 'library/r1/tab.webm', bytes: 123 },
    ]);
  });

  it('records release intent and removes the OPFS claim in one idempotent history mutation', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    seedRetainedExternal(repo, 9);
    const update = jest.spyOn(repo, 'update');
    const planned = await service.planVerifiedRetainedMediaRelease('r1');

    await expect(service.markVerifiedRetainedMediaReleased('r1', planned)).resolves.toMatchObject({ released: planned });
    expect(update).toHaveBeenCalledTimes(1);
    expect(await tabFile(repo)).toMatchObject({
      locations: [{ kind: 'external', destinationId: 'crm', artifactId: 'media-1', playbackVerifiedAt: 9 }],
      releasedRetainedMedia: [{ key: 'library/r1/tab.webm', releasedAt: 10 }],
    });

    await expect(service.markVerifiedRetainedMediaReleased('r1', planned)).resolves.toMatchObject({ released: [] });
    expect((await tabFile(repo)).releasedRetainedMedia).toEqual([
      { key: 'library/r1/tab.webm', releasedAt: 10 },
    ]);
  });

  it('reports lease-deferred physical cleanup without undoing the durable release marker', async () => {
    const repo = new MemoryRepository();
    const deleteRetained = jest.fn().mockResolvedValue('deferred');
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10, undefined, undefined, deleteRetained);
    seedRetainedExternal(repo, 9);
    const planned = await service.planVerifiedRetainedMediaRelease('r1');
    const marked = await service.markVerifiedRetainedMediaReleased('r1', planned);

    await expect(service.deleteReleasedRetainedMedia('r1', marked.released)).resolves.toBe('deferred');
    expect(deleteRetained).toHaveBeenCalledWith(['library/r1/tab.webm'], 'r1');
    expect((await tabFile(repo)).releasedRetainedMedia).toEqual([
      { key: 'library/r1/tab.webm', releasedAt: 10 },
    ]);
  });

  /** ADR-0006 §24: removing a recording deletes only what the extension owns. */
  describe('removal deletes internal copies only', () => {
    const seeded = async () => {
      const repo = new MemoryRepository();
      const deleteRetained = jest.fn().mockResolvedValue(undefined);
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10, undefined, undefined, deleteRetained);
      await service.createPending('r1', [
        { id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' },
        { id: 'r1:mic', stream: 'mic', filename: 'demo-mic.webm' },
      ], 'drive');
      await service.recordArtifactLocation('r1', 'r1:tab', { kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 5 });
      await service.recordArtifactLocation('r1', 'r1:mic', { kind: 'opfs', key: 'library/r1/mic.webm', retainedAt: 5 });
      await service.localSaveSettled('r1', 'tab', 7, 'complete');
      await service.applyUploadJob(uploadJob());
      return { repo, service, deleteRetained };
    };

    it('deletes every retained OPFS copy and nothing else', async () => {
      const { service, deleteRetained } = await seeded();

      await expect(service.remove('r1')).resolves.toBe(true);

      // Only OPFS keys: the Downloads file and the Drive file are the user's.
      // The recording id rides along so the deleter can check for a playback lease.
      expect(deleteRetained).toHaveBeenCalledWith(['library/r1/tab.webm', 'library/r1/mic.webm'], 'r1');
    });

    it('tombstones even when deleting the internal copies fails', async () => {
      const repo = new MemoryRepository();
      const deleteRetained = jest.fn().mockRejectedValue(new Error('disk error'));
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10, undefined, undefined, deleteRetained);
      await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'a.webm' }], 'local');
      await service.recordArtifactLocation('r1', 'r1:tab', { kind: 'opfs', key: 'library/r1/tab.webm', retainedAt: 5 });

      await expect(service.remove('r1')).resolves.toBe(true);
      expect((await repo.get('r1'))!.deletedAt).toBe(10);
    });

    it('does not call the deleter when nothing was retained', async () => {
      const repo = new MemoryRepository();
      const deleteRetained = jest.fn();
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10, undefined, undefined, deleteRetained);
      await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'a.webm' }], 'local');
      await service.localSaveSettled('r1', 'tab', 7, 'complete');

      await service.remove('r1');
      expect(deleteRetained).not.toHaveBeenCalled();
    });

    it('is a no-op on a second removal', async () => {
      const { service, deleteRetained } = await seeded();
      await service.remove('r1');
      deleteRetained.mockClear();

      await expect(service.remove('r1')).resolves.toBe(false);
      expect(deleteRetained).not.toHaveBeenCalled();
    });
  });
});

/**
 * The rename is what turned a user's notes sidecar into `-mic.webm` and cost
 * them an hour of audio: it named each Drive file from *its row's* stream and
 * kind, so a sidecar id sitting on a media row was renamed as that media.
 */
