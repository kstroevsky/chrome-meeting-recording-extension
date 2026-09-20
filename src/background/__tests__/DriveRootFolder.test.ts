/**
 * Renaming the root folder is the one place the setting and Drive can disagree,
 * and a disagreement splits the library — so the failures matter more than the
 * happy path.
 */
import { DriveRootFolder, type DriveRootFolderDeps } from '../DriveRootFolder';

function make(folders: Record<string, string> = {}) {
  const renames: Array<{ folderId: string; name: string }> = [];
  const deps: DriveRootFolderDeps = {
    findFolder: jest.fn(async (name: string) => (folders[name] ? { id: folders[name] } : null)),
    renameFolder: jest.fn(async (folderId: string, name: string) => { renames.push({ folderId, name }); }),
  };
  return { folder: new DriveRootFolder(deps), deps, renames };
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
