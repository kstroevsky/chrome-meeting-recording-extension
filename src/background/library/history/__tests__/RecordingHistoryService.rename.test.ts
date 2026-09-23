import { RecordingHistoryService } from '../RecordingHistoryService';
import { historyFile } from '../../../../../tests/helpers/recordingHistoryFixtures';
import { MemoryRepository } from './RecordingHistoryService.testSupport';

describe('renaming never mislabels a Drive file', () => {
  const seed = async (repo: MemoryRepository, files: unknown[]) => {
    repo.entries.set('r1', {
      id: 'r1', name: 'Old name', createdAt: 1, storageMode: 'drive', status: 'complete',
      driveFolderId: 'folder-1', files: files as never,
    });
  };
  const driveRow = (over: Record<string, unknown>) => historyFile({
    id: 'r1:tab', stream: 'tab', filename: 'a-recording.webm',
    destination: 'drive', status: 'available', ...over,
  } as never);

  it('renames each file once, by its own identity', async () => {
    const repo = new MemoryRepository();
    const renameDrive = jest.fn(async (_resources: Array<{ id: string; name: string }>) => ({ ok: true }));
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10, renameDrive);
    await seed(repo, [
      driveRow({ driveFileId: 'tab-1' }),
      driveRow({ id: 'r1:mic', stream: 'mic', filename: 'a-mic.webm', driveFileId: 'mic-1' }),
      driveRow({ id: 'r1:notes', kind: 'notes', filename: 'a-notes.vtt', driveFileId: 'notes-1' }),
    ]);

    await service.rename('r1', 'Quarterly review');

    const targets = renameDrive.mock.calls[0][0];
    const byId = Object.fromEntries(targets.map((t) => [t.id, t.name]));
    expect(byId['tab-1']).toMatch(/recording\.webm$/);
    expect(byId['mic-1']).toMatch(/-mic\.webm$/);
    // The sidecar stays a sidecar. This is the assertion that was missing.
    expect(byId['notes-1']).toMatch(/-notes\.vtt$/);
  });

  it('refuses to rename a Drive file two rows both claim', async () => {
    const repo = new MemoryRepository();
    const renameDrive = jest.fn(async (_resources: Array<{ id: string; name: string }>) => ({ ok: true }));
    const service = new RecordingHistoryService(repo, jest.fn(), () => 10, renameDrive);
    // Exactly the corrupted shape: a sidecar and the mic pointing at one file.
    await seed(repo, [
      driveRow({ driveFileId: 'tab-1' }),
      driveRow({ id: 'r1:mic', stream: 'mic', filename: 'a-mic.webm', driveFileId: 'shared' }),
      driveRow({ id: 'r1:notes', kind: 'notes', filename: 'a-notes.vtt', driveFileId: 'shared' }),
    ]);

    await service.rename('r1', 'Quarterly review');

    const targets = renameDrive.mock.calls[0][0];
    // Renaming it either way would mislabel one of the two rows, so it is left
    // alone; the unambiguous file and the folder still get renamed.
    expect(targets.map((t) => t.id)).toEqual(['tab-1', 'folder-1']);
  });
});
