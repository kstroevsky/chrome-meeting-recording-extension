/** ADR-0006: the OPFS namespace, and the key shape that carries the migration. */
import { createFakeOpfs } from '../../../../tests/helpers/fakeOpfs';
import {
  existsByKey,
  listLibraryFiles,
  filenameFromKey,
  isLegacyRootKey,
  libraryKey,
  listFiles,
  readFileByKey,
  removeByKey,
  stagingKey,
} from '../opfsLayout';

describe('OPFS keys', () => {
  it('treats a bare filename as a pre-split root file and a path as a new one', () => {
    // This one property is the whole legacy migration: orphans and pending-upload
    // markers written before the split hold bare names, so they keep resolving
    // at the root with no version flag and no migration pass.
    expect(isLegacyRootKey('meet-standup-recording.webm')).toBe(true);
    expect(isLegacyRootKey(stagingKey('meet-standup-recording.webm'))).toBe(false);
    expect(isLegacyRootKey(libraryKey('r1', 'r1:tab', 'a.webm'))).toBe(false);
  });

  it('percent-encodes segments so an id containing a separator cannot escape', () => {
    expect(libraryKey('recording:a/b', 'f/1', 'clip.mp4')).toBe('library/recording%3Aa%2Fb/f%2F1.mp4');
  });

  it('keeps the artifact extension and defaults to webm', () => {
    expect(libraryKey('r', 'f', 'x.mp4')).toMatch(/\.mp4$/);
    expect(libraryKey('r', 'f', 'x.m4a')).toMatch(/\.m4a$/);
    expect(libraryKey('r', 'f', 'notes.vtt')).toMatch(/\.vtt$/);
    expect(libraryKey('r', 'f', 'no-extension')).toMatch(/\.webm$/);
  });

  it('reports the display filename from any key', () => {
    expect(filenameFromKey('staging/meet-recording.webm')).toBe('meet-recording.webm');
    expect(filenameFromKey('legacy.webm')).toBe('legacy.webm');
  });
});

describe('OPFS access by key', () => {
  it('reads and deletes at both the root and a nested path', async () => {
    const opfs = createFakeOpfs();
    opfs.seed('legacy.webm', 10);
    opfs.seed('staging/current.webm', 20);

    expect((await readFileByKey(opfs.root, 'legacy.webm'))?.size).toBe(10);
    expect((await readFileByKey(opfs.root, 'staging/current.webm'))?.size).toBe(20);

    await removeByKey(opfs.root, 'legacy.webm');
    expect(await existsByKey(opfs.root, 'legacy.webm')).toBe(false);
    expect(await existsByKey(opfs.root, 'staging/current.webm')).toBe(true);
  });

  it('treats a missing key as absent rather than throwing', async () => {
    const opfs = createFakeOpfs();
    expect(await readFileByKey(opfs.root, 'staging/nope.webm')).toBeNull();
    await expect(removeByKey(opfs.root, 'staging/nope.webm')).resolves.toBeUndefined();
  });
});

describe('listFiles', () => {
  it('lists a directory without descending into it', async () => {
    const opfs = createFakeOpfs();
    opfs.seed('staging/a.webm', 1, 111);
    opfs.seed('staging/b.webm', 2, 222);
    opfs.seed('library/r/c.webm', 3);

    const listed = await listFiles(opfs.root, 'staging');
    expect(listed).toEqual([
      { key: 'staging/a.webm', name: 'a.webm', lastModifiedMs: 111, sizeBytes: 1 },
      { key: 'staging/b.webm', name: 'b.webm', lastModifiedMs: 222, sizeBytes: 2 },
    ]);
  });

  /**
   * The invariant ADR-0006 exists to protect: a root listing must not surface
   * the library, or orphan recovery starts recovering the media library.
   */
  it('skips the staging and library directories when listing the root', async () => {
    const opfs = createFakeOpfs();
    opfs.seed('legacy-orphan.webm', 9, 333);
    opfs.seed('staging/in-flight.webm', 1);
    opfs.seed('library/r/retained.webm', 2);

    expect(await listFiles(opfs.root, '')).toEqual([
      { key: 'legacy-orphan.webm', name: 'legacy-orphan.webm', lastModifiedMs: 333, sizeBytes: 9 },
    ]);
  });

  it('returns nothing for a directory that does not exist yet', async () => {
    expect(await listFiles(createFakeOpfs().root, 'staging')).toEqual([]);
  });
});

describe('listLibraryFiles', () => {
  it('lists every retained file across recordings', async () => {
    const opfs = createFakeOpfs();
    opfs.seed('library/recording%3A1/recording%3A1%3Atab.webm', 10, 111);
    opfs.seed('library/recording%3A1/recording%3A1%3Amic.webm', 20, 222);
    opfs.seed('library/recording%3A2/recording%3A2%3Atab.webm', 30, 333);
    opfs.seed('staging/in-flight.webm', 1);
    opfs.seed('legacy.webm', 2);

    const listed = (await listLibraryFiles(opfs.root)).map((entry) => entry.key).sort();
    expect(listed).toEqual([
      'library/recording%3A1/recording%3A1%3Amic.webm',
      'library/recording%3A1/recording%3A1%3Atab.webm',
      'library/recording%3A2/recording%3A2%3Atab.webm',
    ]);
  });

  it('returns nothing before anything has been retained', async () => {
    expect(await listLibraryFiles(createFakeOpfs().root)).toEqual([]);
  });
});
