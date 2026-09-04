/** ADR-0006 §9: the five states a crash can leave between library/ and history. */
import { libraryKey } from '../../offscreen/storage/opfsLayout';
import {
  DEFAULT_ORPHAN_GRACE_MS,
  reconcileRetainedMedia,
  type RetainedMediaReconcilerDeps,
} from '../RetainedMediaReconciler';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';

const NOW = 10_000_000;
const HISTORY = 'recording:1';
const FILE_ID = 'recording:1:tab';
const KEY = libraryKey(HISTORY, FILE_ID, 'demo-recording.webm');

const entry = (over: Partial<RecordingHistoryEntry> = {}): RecordingHistoryEntry => ({
  id: HISTORY,
  name: 'Demo',
  createdAt: 1,
  storageMode: 'local',
  status: 'complete',
  files: [historyFile({
    id: FILE_ID, stream: 'tab', filename: 'demo-recording.webm',
    destination: 'local', status: 'available',
  })],
  ...over,
});

const withRetained = (locations: unknown[] = []) => {
  const base = entry();
  return { ...base, files: [{ ...base.files[0], locations: locations as never }] };
};

function makeDeps(over: Partial<RetainedMediaReconcilerDeps> = {}): RetainedMediaReconcilerDeps {
  return {
    listRetained: jest.fn(async () => [{ key: KEY, name: 'x.webm', lastModifiedMs: NOW - 1000 }]),
    getEntry: jest.fn(async () => entry()),
    listLiveEntries: jest.fn(async () => []),
    exists: jest.fn(async () => true),
    removeRetained: jest.fn(async () => {}),
    recordLocation: jest.fn(async () => {}),
    dropLocation: jest.fn(async () => {}),
    now: () => NOW,
    log: jest.fn(),
    warn: jest.fn(),
    ...over,
  };
}

describe('reconcileRetainedMedia', () => {
  it('leaves a file alone when history already claims it', async () => {
    const deps = makeDeps({
      getEntry: jest.fn(async () => withRetained([{ kind: 'opfs', key: KEY, retainedAt: 1 }])),
    });
    await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ healthy: 1, repaired: 0, collected: 0 });
    expect(deps.removeRetained).not.toHaveBeenCalled();
  });

  it('repairs metadata when the move landed but the write did not', async () => {
    const deps = makeDeps();
    await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ repaired: 1 });
    expect(deps.recordLocation).toHaveBeenCalledWith(HISTORY, FILE_ID, KEY, NOW - 1000);
    expect(deps.removeRetained).not.toHaveBeenCalled();
  });

  it('collects media belonging to a deleted recording immediately', async () => {
    const deps = makeDeps({ getEntry: jest.fn(async () => entry({ deletedAt: 5 })) });
    await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ collected: 1 });
    expect(deps.removeRetained).toHaveBeenCalledWith(KEY);
  });

  describe('unowned files', () => {
    it('waits out the grace period rather than deleting a promotion in flight', async () => {
      const deps = makeDeps({
        getEntry: jest.fn(async () => undefined),
        listRetained: jest.fn(async () => [{ key: KEY, name: 'x.webm', lastModifiedMs: NOW - 1000 }]),
      });
      await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ deferred: 1, collected: 0 });
      expect(deps.removeRetained).not.toHaveBeenCalled();
    });

    it('collects once the file is older than the grace period', async () => {
      const deps = makeDeps({
        getEntry: jest.fn(async () => undefined),
        listRetained: jest.fn(async () => [
          { key: KEY, name: 'x.webm', lastModifiedMs: NOW - DEFAULT_ORPHAN_GRACE_MS - 1 },
        ]),
      });
      await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ collected: 1 });
    });

    it('treats a file whose history row is gone as unowned', async () => {
      const deps = makeDeps({
        getEntry: jest.fn(async () => entry({ files: [] })),
        listRetained: jest.fn(async () => [
          { key: KEY, name: 'x.webm', lastModifiedMs: NOW - DEFAULT_ORPHAN_GRACE_MS - 1 },
        ]),
      });
      await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ collected: 1 });
    });

    it('does not mistake a stray non-library path for owned media', async () => {
      const deps = makeDeps({
        listRetained: jest.fn(async () => [
          { key: 'library/junk.webm', name: 'junk.webm', lastModifiedMs: NOW - DEFAULT_ORPHAN_GRACE_MS - 1 },
        ]),
      });
      await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ collected: 1 });
      expect(deps.getEntry).not.toHaveBeenCalled();
    });
  });

  it('drops a location whose file is gone, keeping the row for its other replicas', async () => {
    const deps = makeDeps({
      listRetained: jest.fn(async () => []),
      listLiveEntries: jest.fn(async () => [withRetained([
        { kind: 'opfs', key: KEY, retainedAt: 1 },
        { kind: 'drive', fileId: 'd1' },
      ])]),
      exists: jest.fn(async () => false),
    });
    await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ staleLocations: 1 });
    expect(deps.dropLocation).toHaveBeenCalledWith(HISTORY, FILE_ID, KEY);
  });

  it('keeps a location whose file is present', async () => {
    const deps = makeDeps({
      listRetained: jest.fn(async () => []),
      listLiveEntries: jest.fn(async () => [withRetained([{ kind: 'opfs', key: KEY, retainedAt: 1 }])]),
      exists: jest.fn(async () => true),
    });
    await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ staleLocations: 0 });
    expect(deps.dropLocation).not.toHaveBeenCalled();
  });

  it('keeps going when one file cannot be reconciled', async () => {
    const other = libraryKey('recording:2', 'recording:2:tab', 'b.webm');
    const deps = makeDeps({
      listRetained: jest.fn(async () => [
        { key: KEY, name: 'a.webm', lastModifiedMs: NOW - 1 },
        { key: other, name: 'b.webm', lastModifiedMs: NOW - 1 },
      ]),
      getEntry: jest.fn(async (id: string) => {
        if (id === HISTORY) throw new Error('IndexedDB unavailable');
        return { ...entry(), id: 'recording:2', files: [] };
      }),
    });
    await expect(reconcileRetainedMedia(deps)).resolves.toMatchObject({ deferred: 1 });
    expect(deps.warn).toHaveBeenCalledWith(
      'Could not reconcile retained media; leaving it in place', KEY, expect.anything(),
    );
  });
});
