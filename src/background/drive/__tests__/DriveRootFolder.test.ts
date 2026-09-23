/**
 * Renaming the root folder is the one place the setting and Drive can disagree,
 * and a disagreement splits the library — so the failures matter more than the
 * happy path.
 */
import { DriveRootFolder, type DriveRootFolderDeps } from '../DriveRootFolder';

type FakeFolder = { id: string; name?: string; parents?: string[] };

function make(folders: Record<string, string> = {}, tree: Record<string, FakeFolder> = {}) {
  const renames: Array<{ folderId: string; name: string }> = [];
  const moves: Array<{ folderId: string; add: string; remove: string[] }> = [];
  const deps: DriveRootFolderDeps = {
    findFolder: jest.fn(async (name: string) => (folders[name] ? { id: folders[name] } : null)),
    createFolder: jest.fn(async (name: string) => ({ id: `new-${name}` })),
    renameFolder: jest.fn(async (folderId: string, name: string) => { renames.push({ folderId, name }); }),
    getFolder: jest.fn(async (folderId: string) => tree[folderId] ?? null),
    moveFolder: jest.fn(async (folderId: string, add: string, remove: string[]) => { moves.push({ folderId, add, remove }); }),
    warn: jest.fn(),
  };
  return { folder: new DriveRootFolder(deps), deps, renames, moves };
}

describe('renaming the folder every recording lives under', () => {
  it('renames the existing folder, so the recordings already in it come along', async () => {
    const { folder, renames } = make({ 'Google Meet Records': 'root-id' });

    await expect(folder.rename('Google Meet Records', 'Recordings'))
      .resolves.toEqual({ status: 'renamed', folderId: 'root-id' });
    // The same folder, renamed: every stored file id and link still resolves.
    expect(renames).toEqual([{ folderId: 'root-id', name: 'Recordings' }]);
  });

  it('reports absent when nothing has been uploaded yet, so the name can just be saved', async () => {
    const { folder, deps } = make();

    await expect(folder.rename('Google Meet Records', 'Recordings')).resolves.toEqual({ status: 'absent' });
    expect(deps.renameFolder).not.toHaveBeenCalled();
  });

  it('refuses when a folder of that name already exists, rather than leaving two', async () => {
    // Drive allows two folders with one name, and a lookup cannot tell them
    // apart — so which one holds the recordings stops being answerable.
    const { folder, deps } = make({ 'Google Meet Records': 'root-id', Recordings: 'other-id' });

    await expect(folder.rename('Google Meet Records', 'Recordings'))
      .resolves.toEqual({ status: 'taken', folderId: 'other-id' });
    expect(deps.renameFolder).not.toHaveBeenCalled();
  });

  it('does nothing when the name has not actually changed', async () => {
    const { folder, deps } = make({ Recordings: 'root-id' });

    await expect(folder.rename('Recordings', '  Recordings  ')).resolves.toEqual({ status: 'absent' });
    expect(deps.findFolder).not.toHaveBeenCalled();
    expect(deps.renameFolder).not.toHaveBeenCalled();
  });

  it('refuses a blank name rather than renaming the folder to nothing', async () => {
    const { folder, deps } = make({ Recordings: 'root-id' });

    await expect(folder.rename('Recordings', '   ')).resolves.toEqual({ status: 'absent' });
    expect(deps.renameFolder).not.toHaveBeenCalled();
  });

  it('lets a Drive failure through, so the caller can decline to save the name', async () => {
    const { folder, deps } = make({ 'Google Meet Records': 'root-id' });
    (deps.renameFolder as jest.Mock).mockRejectedValueOnce(new Error('Could not rename the folder in Google Drive (403)'));

    await expect(folder.rename('Google Meet Records', 'Recordings')).rejects.toThrow('403');
  });

  it('looks only at the top of My Drive, where the root folder is', async () => {
    const { folder, deps } = make({ 'Google Meet Records': 'root-id' });

    await folder.rename('Google Meet Records', 'Recordings');
    for (const call of (deps.findFolder as jest.Mock).mock.calls) expect(call[1]).toBeNull();
  });
});

/**
 * Earlier versions created destinations at the top of My Drive. Gathering them
 * back has to be exact: these are folders in someone's Drive, and the ones that
 * look like ours may not be.
 */
describe('gathering destinations back inside the root', () => {
  const ROOT = 'Recordings';
  const tree = {
    'rec-1': { id: 'rec-1', name: 'google-meet-sync-20260920T1430', parents: ['therapy-id'] },
    'rec-2': { id: 'rec-2', name: 'google-meet-standup-20260919T0900', parents: ['therapy-id'] },
    'rec-3': { id: 'rec-3', name: 'google-meet-review-20260918T1100', parents: ['work-id'] },
    'therapy-id': { id: 'therapy-id', name: 'Therapy', parents: ['root-of-drive'] },
    'work-id': { id: 'work-id', name: 'Work', parents: ['root-of-drive'] },
  };

  it('moves each destination once, however many recordings it holds', async () => {
    const { folder, moves } = make({ [ROOT]: 'root-id' }, tree);

    const result = await folder.gather(['rec-1', 'rec-2', 'rec-3'], ['Therapy', 'Work'], ROOT);

    expect(result.moved).toEqual(['Therapy', 'Work']);
    expect(moves).toEqual([
      { folderId: 'therapy-id', add: 'root-id', remove: ['root-of-drive'] },
      { folderId: 'work-id', add: 'root-id', remove: ['root-of-drive'] },
    ]);
  });

  it('leaves a folder alone when its name is not one of the destinations', async () => {
    // The user filed a recording into a folder of their own by hand. It holds
    // one of our recordings, but it is not ours to reorganise.
    const { folder, moves } = make({ [ROOT]: 'root-id' }, {
      'rec-1': { id: 'rec-1', parents: ['their-own-folder'] },
      'their-own-folder': { id: 'their-own-folder', name: 'Client work', parents: ['root-of-drive'] },
    });

    const result = await folder.gather(['rec-1'], ['Therapy'], ROOT);

    expect(result.moved).toEqual([]);
    expect(moves).toEqual([]);
  });

  it('leaves a recording that is already in the root where it is', async () => {
    const { folder, deps } = make({ [ROOT]: 'root-id' }, {
      'rec-1': { id: 'rec-1', parents: ['root-id'] },
    });

    const result = await folder.gather(['rec-1'], ['Therapy'], ROOT);

    expect(result.moved).toEqual([]);
    expect(deps.moveFolder).not.toHaveBeenCalled();
  });

  it('counts a destination that is already inside rather than moving it again', async () => {
    const { folder, deps } = make({ [ROOT]: 'root-id' }, {
      'rec-1': { id: 'rec-1', parents: ['therapy-id'] },
      'therapy-id': { id: 'therapy-id', name: 'Therapy', parents: ['root-id'] },
    });

    await expect(folder.gather(['rec-1'], ['Therapy'], ROOT))
      .resolves.toEqual({ moved: [], alreadyInside: 1, failed: 0 });
    expect(deps.moveFolder).not.toHaveBeenCalled();
  });

  it('keeps going when one folder cannot be moved, and says how many failed', async () => {
    const { folder, deps, moves } = make({ [ROOT]: 'root-id' }, tree);
    (deps.moveFolder as jest.Mock).mockRejectedValueOnce(new Error('403'));

    const result = await folder.gather(['rec-1', 'rec-3'], ['Therapy', 'Work'], ROOT);

    expect(result).toEqual({ moved: ['Work'], alreadyInside: 0, failed: 1 });
    expect(moves).toEqual([{ folderId: 'work-id', add: 'root-id', remove: ['root-of-drive'] }]);
  });

  it('does nothing at all when there are no recordings or no destinations', async () => {
    const { folder, deps } = make({ [ROOT]: 'root-id' }, tree);

    await expect(folder.gather([], ['Therapy'], ROOT)).resolves.toEqual({ moved: [], alreadyInside: 0, failed: 0 });
    await expect(folder.gather(['rec-1'], [], ROOT)).resolves.toEqual({ moved: [], alreadyInside: 0, failed: 0 });
    expect(deps.findFolder).not.toHaveBeenCalled();
  });

  it('survives a recording folder Drive no longer has', async () => {
    const { folder } = make({ [ROOT]: 'root-id' }, {});

    await expect(folder.gather(['gone'], ['Therapy'], ROOT))
      .resolves.toEqual({ moved: [], alreadyInside: 0, failed: 0 });
  });
});
