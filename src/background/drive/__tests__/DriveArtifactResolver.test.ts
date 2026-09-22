/** Telling trash from gone, and re-finding a file history lost track of. */
import { DriveArtifactResolver, type DriveMetadata } from '../DriveArtifactResolver';

const identity = (over: Record<string, unknown> = {}) => ({
  fileId: 'file-1', folderId: 'folder-1', filename: 'a-mic.webm', bytes: 44_911_708, ...over,
} as never);

function make(metadata: DriveMetadata | null, folder: DriveMetadata[] = []) {
  const getMetadata = jest.fn(async () => metadata);
  const listFolder = jest.fn(async () => folder);
  const warn = jest.fn();
  return { resolver: new DriveArtifactResolver({ getMetadata, listFolder, warn }), getMetadata, listFolder, warn };
}

describe('a file that is still there', () => {
  it('reports ok without searching', async () => {
    const { resolver, listFolder } = make({ id: 'file-1', name: 'a-mic.webm' });
    await expect(resolver.resolve(identity())).resolves.toEqual({ status: 'ok', fileId: 'file-1' });
    expect(listFolder).not.toHaveBeenCalled();
  });

  it('is unaffected by the file having been moved or renamed in Drive', async () => {
    // A Drive id survives both, so metadata resolving is the whole test.
    const { resolver } = make({ id: 'file-1', name: 'renamed-by-hand.webm' });
    await expect(resolver.resolve(identity())).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('a file in the trash', () => {
  it('is reported as trashed, not missing', async () => {
    // Recoverable for about 30 days — worth saying so rather than swallowing.
    const { resolver, listFolder } = make({ id: 'file-1', trashed: true });
    await expect(resolver.resolve(identity())).resolves.toEqual({ status: 'trashed', fileId: 'file-1' });
    expect(listFolder).not.toHaveBeenCalled();
  });
});

describe('a file history lost track of', () => {
  it('re-finds it in the recording folder by name and size, and relinks', async () => {
    const { resolver, warn } = make(null, [
      { id: 'other', name: 'a-recording.webm', size: '600' },
      { id: 'real', name: 'a-mic.webm', size: '44911708' },
    ]);
    await expect(resolver.resolve(identity())).resolves.toEqual({ status: 'relinked', fileId: 'real' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Relinked'));
  });

  it('matches on name when the size is unknown', async () => {
    const { resolver } = make(null, [{ id: 'real', name: 'a-mic.webm' }]);
    await expect(resolver.resolve(identity({ bytes: undefined }))).resolves
      .toEqual({ status: 'relinked', fileId: 'real' });
  });

  it('prefers the same-sized candidate when two share a name', async () => {
    const { resolver } = make(null, [
      { id: 'stub', name: 'a-mic.webm', size: '86' },
      { id: 'real', name: 'a-mic.webm', size: '44911708' },
    ]);
    await expect(resolver.resolve(identity())).resolves.toMatchObject({ fileId: 'real' });
  });

  it('never adopts a trashed candidate', async () => {
    const { resolver } = make(null, [{ id: 'real', name: 'a-mic.webm', size: '44911708', trashed: true }]);
    await expect(resolver.resolve(identity())).resolves.toEqual({ status: 'missing' });
  });

  it('never adopts a differently named file', async () => {
    const { resolver } = make(null, [{ id: 'other', name: 'a-recording.webm', size: '44911708' }]);
    await expect(resolver.resolve(identity())).resolves.toEqual({ status: 'missing' });
  });

  it('reports missing when the recording has no folder to search', async () => {
    const { resolver, listFolder } = make(null, []);
    await expect(resolver.resolve(identity({ folderId: undefined }))).resolves.toEqual({ status: 'missing' });
    expect(listFolder).not.toHaveBeenCalled();
  });
});

describe('when Drive itself misbehaves', () => {
  it('falls through to a search when the metadata call throws', async () => {
    const getMetadata = jest.fn(async () => { throw new Error('network'); });
    const listFolder = jest.fn(async () => [{ id: 'real', name: 'a-mic.webm', size: '44911708' }]);
    const warn = jest.fn();
    const resolver = new DriveArtifactResolver({ getMetadata, listFolder, warn });
    await expect(resolver.resolve(identity())).resolves.toMatchObject({ status: 'relinked' });
    expect(warn).toHaveBeenCalled();
  });

  it('reports missing when the search also fails', async () => {
    const resolver = new DriveArtifactResolver({
      getMetadata: async () => null,
      listFolder: async () => { throw new Error('network'); },
      warn: jest.fn(),
    });
    await expect(resolver.resolve(identity())).resolves.toEqual({ status: 'missing' });
  });
});
