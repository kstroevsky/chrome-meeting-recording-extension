/** ADR-0006 §10: quota is intentional once OPFS holds a media library. */
import { createFakeOpfs } from '../../../tests/helpers/fakeOpfs';
import { measureRetainedStorage } from '../retainedStorage';

describe('measureRetainedStorage', () => {
  it('counts only the retained library, not staging or pre-split files', async () => {
    const opfs = createFakeOpfs();
    opfs.seed('library/r1/tab.webm', 300);
    opfs.seed('library/r2/tab.webm', 700);
    opfs.seed('staging/in-flight.webm', 5_000);
    opfs.seed('legacy-orphan.webm', 9_000);

    await expect(measureRetainedStorage(opfs.root)).resolves.toMatchObject({
      retainedFiles: 2,
      retainedBytes: 1_000,
    });
  });

  it('reports whole-origin usage when the browser supplies it', async () => {
    const opfs = createFakeOpfs();
    opfs.seed('library/r1/tab.webm', 42);

    await expect(
      measureRetainedStorage(opfs.root, async () => ({ usage: 5_000, quota: 100_000 })),
    ).resolves.toEqual({ retainedFiles: 1, retainedBytes: 42, usageBytes: 5_000, quotaBytes: 100_000 });
  });

  it('still measures the library when quota reporting is unavailable', async () => {
    const opfs = createFakeOpfs();
    opfs.seed('library/r1/tab.webm', 42);

    await expect(
      measureRetainedStorage(opfs.root, async () => { throw new Error('not supported'); }),
    ).resolves.toEqual({ retainedFiles: 1, retainedBytes: 42 });
  });

  it('reports an empty library as zero rather than failing', async () => {
    await expect(measureRetainedStorage(createFakeOpfs().root)).resolves.toEqual({
      retainedFiles: 0,
      retainedBytes: 0,
    });
  });
});
