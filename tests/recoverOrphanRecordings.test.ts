import {
  recoverOrphanRecordings,
  type OrphanRecoveryDeps,
} from '../src/offscreen/storage/recoverOrphanRecordings';

const NAME = 'google-meet-abc-20260101T0900-recording.webm';
const CUTOFF = 1_000_000;
const blob = (size: number) => ({ size } as Blob);

function makeDeps(over: Partial<OrphanRecoveryDeps> = {}): OrphanRecoveryDeps {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    cutoffMs: CUTOFF,
    // Default candidate is older than the cutoff -> a genuine orphan.
    listOrphanCandidates: jest.fn(async () => [{ name: NAME, lastModifiedMs: CUTOFF - 1 }]),
    excludedNames: jest.fn(async () => new Set<string>()),
    openOpfsFile: jest.fn(async () => blob(100)),
    sealFile: jest.fn(async (raw) => raw),
    saveRecovered: jest.fn(),
    removeOpfsFile: jest.fn(async () => {}),
    ...over,
  };
}

describe('recoverOrphanRecordings', () => {
  it('does nothing when there are no candidates', async () => {
    const deps = makeDeps({ listOrphanCandidates: jest.fn(async () => []) });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('seals an orphan and hands it to the save flow', async () => {
    const deps = makeDeps();
    await recoverOrphanRecordings(deps);
    expect(deps.sealFile).toHaveBeenCalledTimes(1);
    expect(deps.saveRecovered).toHaveBeenCalledWith(NAME, expect.anything(), NAME);
  });

  it('skips files newer than the cutoff (the active recording is never touched)', async () => {
    const deps = makeDeps({
      listOrphanCandidates: jest.fn(async () => [{ name: NAME, lastModifiedMs: CUTOFF + 1 }]),
    });
    await recoverOrphanRecordings(deps);
    expect(deps.openOpfsFile).not.toHaveBeenCalled();
    expect(deps.saveRecovered).not.toHaveBeenCalled();
  });

  it('skips files that have a pending-upload marker (#1 owns them)', async () => {
    const deps = makeDeps({ excludedNames: jest.fn(async () => new Set([NAME])) });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
  });

  it('deletes an empty orphan without saving', async () => {
    const deps = makeDeps({ openOpfsFile: jest.fn(async () => blob(0)) });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
    expect(deps.removeOpfsFile).toHaveBeenCalledWith(NAME);
  });

  it('deletes a missing orphan (open returns null)', async () => {
    const deps = makeDeps({ openOpfsFile: jest.fn(async () => null) });
    await recoverOrphanRecordings(deps);
    expect(deps.removeOpfsFile).toHaveBeenCalledWith(NAME);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
  });

  it('preserves the orphan when sealing throws, and retries next launch', async () => {
    const deps = makeDeps({ sealFile: jest.fn(async () => { throw new Error('seal failed'); }) });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
    expect(deps.removeOpfsFile).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalled();
  });

  it('processes each old-enough orphan independently', async () => {
    const deps = makeDeps({
      listOrphanCandidates: jest.fn(async () => [
        { name: NAME, lastModifiedMs: CUTOFF - 1 },
        { name: 'google-meet-abc-20260101T0900-mic.webm', lastModifiedMs: CUTOFF - 1 },
      ]),
    });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).toHaveBeenCalledTimes(2);
  });

  it('caps the number recovered per run, deferring the rest to a later launch', async () => {
    const deps = makeDeps({
      maxPerRun: 2,
      listOrphanCandidates: jest.fn(async () => [
        { name: 'a-recording.webm', lastModifiedMs: CUTOFF - 3 },
        { name: 'b-recording.webm', lastModifiedMs: CUTOFF - 2 },
        { name: 'c-recording.webm', lastModifiedMs: CUTOFF - 1 },
      ]),
    });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).toHaveBeenCalledTimes(2);
    // Oldest-first: the two oldest are taken, the newest is deferred.
    expect(deps.saveRecovered).toHaveBeenCalledWith('a-recording.webm', expect.anything(), 'a-recording.webm');
    expect(deps.saveRecovered).toHaveBeenCalledWith('b-recording.webm', expect.anything(), 'b-recording.webm');
  });

  it('delivers raw bytes (skips the in-memory seal) for files above maxSealBytes', async () => {
    const raw = blob(500);
    const deps = makeDeps({ maxSealBytes: 100, openOpfsFile: jest.fn(async () => raw) });
    await recoverOrphanRecordings(deps);
    expect(deps.sealFile).not.toHaveBeenCalled();
    expect(deps.saveRecovered).toHaveBeenCalledWith(NAME, raw, NAME);
  });

  it('still seals files at or below maxSealBytes', async () => {
    const deps = makeDeps({ maxSealBytes: 1000, openOpfsFile: jest.fn(async () => blob(500)) });
    await recoverOrphanRecordings(deps);
    expect(deps.sealFile).toHaveBeenCalledTimes(1);
  });
});
