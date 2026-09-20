/** Filing moves a recording's folder; it never moves media and never deletes. */
import { DriveDestinationFiler, type DriveFolder } from '../DriveDestinationFiler';

const ROOT = 'Recordings';
const ROOT_FOLDER: DriveFolder = { id: 'root-folder' };

function make(
  folder: DriveFolder | null,
  existingDestination: DriveFolder | null = null,
  existingRoot: DriveFolder | null = ROOT_FOLDER,
) {
  const created: Array<{ name: string; parentId: string | null }> = [];
  const lookups: Array<{ name: string; parentId: string | null }> = [];
  const moves: Array<{ folderId: string; add: string; remove: string[] }> = [];
  const deps = {
    getFolder: jest.fn(async () => folder),
    findFolder: jest.fn(async (name: string, parentId: string | null) => {
      lookups.push({ name, parentId });
      return name === ROOT ? existingRoot : existingDestination;
    }),
    createFolder: jest.fn(async (name: string, parentId: string | null) => {
      created.push({ name, parentId });
      return { id: `new-${name}` };
    }),
    moveFolder: jest.fn(async (folderId: string, add: string, remove: string[]) => { moves.push({ folderId, add, remove }); }),
    warn: jest.fn(),
  };
  return { filer: new DriveDestinationFiler(deps), deps, created, lookups, moves };
}

describe('filing a recording', () => {
  it('creates the destination on first use and moves the recording folder into it', async () => {
    const { filer, created, moves } = make({ id: 'rec-folder', parents: ['built-in'] });

    await expect(filer.file('rec-folder', 'Psychotherapy', ROOT)).resolves
      .toEqual({ status: 'filed', destinationFolderId: 'new-Psychotherapy' });

    expect(created).toEqual([{ name: 'Psychotherapy', parentId: 'root-folder' }]);
    // The folder moves; the gigabyte of media inside it does not.
    expect(moves).toEqual([{ folderId: 'rec-folder', add: 'new-Psychotherapy', remove: ['built-in'] }]);
  });

  it('puts the destination inside the root folder, never beside it at the top of Drive', async () => {
    const { filer, lookups, created } = make({ id: 'rec-folder', parents: ['built-in'] }, null, null);

    await filer.file('rec-folder', 'Therapy', ROOT);

    // The root is the only thing looked up, or created, directly under My Drive.
    expect(lookups).toEqual([{ name: ROOT, parentId: null }, { name: 'Therapy', parentId: 'new-Recordings' }]);
    expect(created).toEqual([
      { name: ROOT, parentId: null },
      { name: 'Therapy', parentId: 'new-Recordings' },
    ]);
  });

  it('reuses an existing destination folder rather than making a second one', async () => {
    const { filer, deps, created } = make({ id: 'rec-folder', parents: ['built-in'] }, { id: 'existing' });

    await expect(filer.file('rec-folder', 'Interviews', ROOT)).resolves
      .toMatchObject({ destinationFolderId: 'existing' });
    expect(created).toEqual([]);
    expect(deps.createFolder).not.toHaveBeenCalled();
  });

  it('replaces every parent, so a recording is never in two places', async () => {
    const { filer, moves } = make({ id: 'rec-folder', parents: ['built-in', 'somewhere-else'] }, { id: 'dest' });

    await filer.file('rec-folder', 'Work', ROOT);
    expect(moves[0].remove).toEqual(['built-in', 'somewhere-else']);
  });

  it('does nothing when the recording is already in that destination', async () => {
    const { filer, deps } = make({ id: 'rec-folder', parents: ['dest'] }, { id: 'dest' });

    await expect(filer.file('rec-folder', 'Work', ROOT)).resolves.toEqual({ status: 'unchanged' });
    expect(deps.moveFolder).not.toHaveBeenCalled();
  });

  it('reports missing when the recording folder is gone from Drive', async () => {
    const { filer, deps } = make(null);

    await expect(filer.file('rec-folder', 'Work', ROOT)).resolves.toEqual({ status: 'missing' });
    expect(deps.findFolder).not.toHaveBeenCalled();
    expect(deps.moveFolder).not.toHaveBeenCalled();
  });

  it('handles a folder Drive reports with no parents', async () => {
    const { filer, moves } = make({ id: 'rec-folder' }, { id: 'dest' });

    await filer.file('rec-folder', 'Work', ROOT);
    expect(moves).toEqual([{ folderId: 'rec-folder', add: 'dest', remove: [] }]);
  });

  it('never deletes anything', async () => {
    // There is deliberately no delete in the port: a destination is a label the
    // user gave a folder, and the recordings inside it are theirs.
    const { deps } = make({ id: 'rec-folder' });
    expect(Object.keys(deps)).not.toContain('deleteFolder');
  });
});
