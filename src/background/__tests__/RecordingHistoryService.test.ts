import { RecordingHistoryService } from '../RecordingHistoryService';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';

class MemoryRepository {
  entries = new Map<string, RecordingHistoryEntry>();
  async listPage() {
    return { entries: [...this.entries.values()].filter((entry) => !entry.deletedAt).sort((a, b) => b.createdAt - a.createdAt) };
  }
  async get(id: string) { return this.entries.get(id); }
  async update(id: string, mutate: (entry: RecordingHistoryEntry | undefined) => RecordingHistoryEntry | undefined) {
    const current = this.entries.get(id);
    const next = mutate(current ? structuredClone(current) : undefined);
    if (next) this.entries.set(id, structuredClone(next));
    return next;
  }
}

describe('RecordingHistoryService', () => {
  describe('setDuration', () => {
    const seed = async (service: RecordingHistoryService) => {
      await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');
    };

    it('stamps the recorded duration onto an existing row', async () => {
      const repo = new MemoryRepository();
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
      await seed(service);

      await expect(service.setDuration('r1', 63_000)).resolves.toMatchObject({ durationMs: 63_000 });
      expect(repo.entries.get('r1')?.durationMs).toBe(63_000);
    });

    it('accepts a zero-length recording', async () => {
      const repo = new MemoryRepository();
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
      await seed(service);

      await service.setDuration('r1', 0);
      expect(repo.entries.get('r1')?.durationMs).toBe(0);
    });

    it('ignores an unknown, negative, or absent duration rather than writing junk', async () => {
      const repo = new MemoryRepository();
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
      await seed(service);

      await expect(service.setDuration('r1', undefined)).resolves.toBeUndefined();
      await expect(service.setDuration('r1', -1)).resolves.toBeUndefined();
      await expect(service.setDuration('r1', Number.NaN)).resolves.toBeUndefined();
      expect(repo.entries.get('r1')?.durationMs).toBeUndefined();
    });

    it('does not create or resurrect a row', async () => {
      const repo = new MemoryRepository();
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10);

      await expect(service.setDuration('r-missing', 1_000)).resolves.toBeUndefined();
      expect(repo.entries.has('r-missing')).toBe(false);

      await seed(service);
      await service.remove('r1');
      await expect(service.setDuration('r1', 1_000)).resolves.toBeUndefined();
      expect(repo.entries.get('r1')?.durationMs).toBeUndefined();
    });
  });

  describe('remove side effects (ADR-0005)', () => {
    const seed = async (repo: MemoryRepository, service: RecordingHistoryService) => {
      await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');
      return repo;
    };

    it('drops dependent data once the entry is tombstoned', async () => {
      const repo = new MemoryRepository();
      const onRemoved = jest.fn().mockResolvedValue(undefined);
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10, undefined, onRemoved);
      await seed(repo, service);

      await expect(service.remove('r1')).resolves.toBe(true);
      expect(onRemoved).toHaveBeenCalledWith('r1');
    });

    it('does not run dependent cleanup for an entry that was already deleted', async () => {
      const repo = new MemoryRepository();
      const onRemoved = jest.fn().mockResolvedValue(undefined);
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10, undefined, onRemoved);
      await seed(repo, service);
      await service.remove('r1');
      onRemoved.mockClear();

      await expect(service.remove('r1')).resolves.toBe(false);
      expect(onRemoved).not.toHaveBeenCalled();
    });

    it('still reports the removal when dependent cleanup fails', async () => {
      const repo = new MemoryRepository();
      const onRemoved = jest.fn().mockRejectedValue(new Error('store closed'));
      const service = new RecordingHistoryService(repo, jest.fn(), () => 10, undefined, onRemoved);
      await seed(repo, service);

      await expect(service.remove('r1')).resolves.toBe(true);
      expect(repo.entries.get('r1')?.deletedAt).toBe(10);
    });
  });

  it('groups local artifacts and writes terminal statuses without touching files', async () => {
    const repo = new MemoryRepository();
    const open = jest.fn();
    const service = new RecordingHistoryService(repo, open, () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');
    await service.createPending('r1', [{ id: 'r1:mic', stream: 'mic', filename: 'demo-mic.webm' }], 'local');
    await service.localSaveSettled('r1', 'tab', 1, 'complete');
    await service.localSaveSettled('r1', 'mic', 2, 'complete');
    expect(await service.list()).toEqual([expect.objectContaining({ id: 'r1', status: 'complete', files: [
      expect.objectContaining({ id: 'r1:tab', downloadId: 1, status: 'available' }),
      expect.objectContaining({ id: 'r1:mic', downloadId: 2, status: 'available' }),
    ] })]);
    await service.remove('r1');
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps metadata when opening a missing local file fails', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn().mockRejectedValue(new Error('Missing')));
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');
    await service.localSaveSettled('r1', 'tab', 1, 'complete');
    await expect(service.openLocalFile('r1', 'r1:tab')).rejects.toThrow('Missing');
    expect(await repo.get('r1')).toBeDefined();
  });

  it('persists a user note and clears it without changing the recording files', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');

    await service.setNote('r1', '  Review decisions at 42:10.  ');
    expect(await repo.get('r1')).toEqual(expect.objectContaining({ note: 'Review decisions at 42:10.' }));

    await service.setNote('r1', '');
    expect((await repo.get('r1'))?.note).toBeUndefined();
  });

  it('keeps an already available local fallback available when a retry fails', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'local');
    await service.localSaveSettled('r1', 'tab', 7, 'complete');

    await service.applyTerminalUploadJob({
      id: 'job-1',
      historyId: 'r1',
      label: 'Demo',
      status: 'failed',
      progress: 1,
      files: [{ stream: 'tab', filename: 'demo-recording.webm', status: 'fallback' }],
      startedAt: 10,
      finishedAt: 11,
    });

    expect((await service.list())[0]).toEqual(expect.objectContaining({
      status: 'complete',
      files: [expect.objectContaining({ stream: 'tab', destination: 'local', status: 'available', downloadId: 7 })],
    }));
  });

  it('does not resurrect a deleted entry when delayed upload recovery reports its job', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'demo-recording.webm' }], 'drive');
    await service.remove('r1');

    await service.applyUploadJob({
      id: 'job-1',
      historyId: 'r1',
      label: 'Demo',
      status: 'completed',
      progress: 1,
      files: [{ stream: 'tab', filename: 'demo-recording.webm', status: 'uploaded', driveFileId: 'drive-1' }],
      startedAt: 10,
      finishedAt: 11,
    });

    expect(await service.list()).toEqual([]);
    expect(await repo.get('r1')).toEqual(expect.objectContaining({ deletedAt: 10 }));
  });

  it('keeps a recovered retry pending on Drive instead of claiming a nonexistent local fallback', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10);

    await service.applyUploadJob({
      id: 'job-1',
      historyId: 'r1',
      label: 'Demo',
      status: 'failed',
      recoveryPending: true,
      progress: 1,
      files: [{ stream: 'tab', filename: 'demo-recording.webm', status: 'retry-pending', error: 'network down' }],
      startedAt: 10,
      finishedAt: 11,
    });

    expect((await service.list())[0]).toEqual(expect.objectContaining({
      files: [expect.objectContaining({ destination: 'drive', status: 'pending', error: 'network down' })],
    }));
  });

  it('renames a completed Drive folder and every media file before committing history', async () => {
    const repo = new MemoryRepository();
    const renameDrive = jest.fn(async () => ({ ok: true }));
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10, renameDrive);
    await service.applyUploadJob({
      id: 'job-1',
      historyId: 'r1',
      label: 'Default recording',
      status: 'completed',
      progress: 1,
      driveFolderId: 'folder-1',
      driveFolderName: 'default-recording',
      folderWebViewLink: 'https://drive.example/folder-1',
      namingStatus: 'pending',
      files: [
        { stream: 'tab', filename: 'default-recording.webm', status: 'uploaded', driveFileId: 'tab-1' },
        { stream: 'mic', filename: 'default-mic.m4a', status: 'uploaded', driveFileId: 'mic-1' },
        { stream: 'self-video', filename: 'default-self-video.mp4', status: 'uploaded', driveFileId: 'camera-1' },
      ],
      startedAt: 10,
      finishedAt: 11,
    });

    const renamed = await service.rename('r1', '  Quarterly Review  ');

    expect(renameDrive).toHaveBeenCalledWith([
      { id: 'tab-1', name: 'quarterly-review-recording.webm' },
      { id: 'mic-1', name: 'quarterly-review-mic.m4a' },
      { id: 'camera-1', name: 'quarterly-review-self-video.mp4' },
      { id: 'folder-1', name: 'quarterly-review' },
    ]);
    expect(renamed).toEqual(expect.objectContaining({
      name: 'Quarterly Review',
      userNamed: true,
      driveFolderName: 'quarterly-review',
      files: [
        expect.objectContaining({ filename: 'quarterly-review-recording.webm' }),
        expect.objectContaining({ filename: 'quarterly-review-mic.m4a' }),
        expect.objectContaining({ filename: 'quarterly-review-self-video.mp4' }),
      ],
    }));
  });

  it('keeps local filenames unchanged when only the history title can be renamed', async () => {
    const repo = new MemoryRepository();
    const renameDrive = jest.fn();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10, renameDrive);
    await service.createPending('r1', [{ id: 'r1:tab', stream: 'tab', filename: 'default-recording.webm' }], 'local');

    const renamed = await service.rename('r1', 'Quarterly Review');

    expect(renameDrive).not.toHaveBeenCalled();
    expect(renamed).toEqual(expect.objectContaining({
      name: 'Quarterly Review',
      files: [expect.objectContaining({ filename: 'default-recording.webm' })],
    }));
  });

  it('renames only uploaded artifacts for a partial Drive recording', async () => {
    const repo = new MemoryRepository();
    const renameDrive = jest.fn(async () => ({ ok: true }));
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10, renameDrive);
    repo.entries.set('r1', {
      id: 'r1', name: 'Default recording', createdAt: 1, storageMode: 'drive', status: 'partial',
      driveFolderId: 'folder-1', driveFolderName: 'default-recording',
      files: [
        historyFile({ id: 'r1:tab', stream: 'tab', filename: 'default-recording.webm', destination: 'drive', status: 'available', driveFileId: 'tab-1' }),
        historyFile({ id: 'r1:mic', stream: 'mic', filename: 'default-mic.m4a', destination: 'local', status: 'available', downloadId: 7 }),
      ],
    });

    const renamed = await service.rename('r1', 'Quarterly Review');

    expect(renameDrive).toHaveBeenCalledWith([
      { id: 'tab-1', name: 'quarterly-review-recording.webm' },
      { id: 'folder-1', name: 'quarterly-review' },
    ]);
    expect(renamed?.files).toEqual([
      expect.objectContaining({ filename: 'quarterly-review-recording.webm' }),
      expect.objectContaining({ filename: 'default-mic.m4a' }),
    ]);
  });

  it('keeps legacy Drive history rename-compatible when folder metadata is absent', async () => {
    const repo = new MemoryRepository();
    const renameDrive = jest.fn();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10, renameDrive);
    repo.entries.set('r1', {
      id: 'r1', name: 'Legacy recording', createdAt: 1, storageMode: 'drive', status: 'complete',
      files: [historyFile({ id: 'r1:tab', stream: 'tab', filename: 'legacy-recording.webm', destination: 'drive', status: 'available', driveFileId: 'tab-1' })],
    });

    const renamed = await service.rename('r1', 'New display title');

    expect(renameDrive).not.toHaveBeenCalled();
    expect(renamed).toEqual(expect.objectContaining({
      name: 'New display title',
      files: [expect.objectContaining({ filename: 'legacy-recording.webm' })],
    }));
  });

  it('synchronizes observed Drive names after an incomplete rollback and leaves the title unchanged', async () => {
    const repo = new MemoryRepository();
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10, async () => ({
      ok: false,
      error: 'partial rename',
      rollbackIncomplete: true,
      resources: [
        { id: 'tab-1', name: 'quarterly-review-recording.webm' },
        { id: 'folder-1', name: 'default-recording' },
      ],
    }));
    await service.applyUploadJob({
      id: 'job-1', historyId: 'r1', label: 'Default recording', status: 'completed', progress: 1,
      driveFolderId: 'folder-1', driveFolderName: 'default-recording',
      files: [{ stream: 'tab', filename: 'default-recording.webm', status: 'uploaded', driveFileId: 'tab-1' }],
      startedAt: 10, finishedAt: 11,
    });

    await expect(service.rename('r1', 'Quarterly Review')).rejects.toThrow('partial rename');
    expect(await repo.get('r1')).toEqual(expect.objectContaining({
      name: 'Default recording',
      driveFolderName: 'default-recording',
      files: [expect.objectContaining({ filename: 'quarterly-review-recording.webm' })],
    }));
  });
});

/**
 * ADR-0006: delivery completions add replicas to a logical artifact instead of
 * reassigning its one destination.
 */
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
});

