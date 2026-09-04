import {
  recoverOrphanRecordings,
  type OrphanRecoveryDeps,
} from '../recoverOrphanRecordings';

const NAME = 'google-meet-abc-20260101T0900-recording.webm';
const KEY = `staging/${NAME}`;
const CUTOFF = 1_000_000;
const blob = (size: number) => ({ size } as Blob);

function makeDeps(over: Partial<OrphanRecoveryDeps> = {}): OrphanRecoveryDeps {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    cutoffMs: CUTOFF,
    // Default candidate is older than the cutoff -> a genuine orphan.
    listOrphanCandidates: jest.fn(async () => [{ key: KEY, filename: NAME, lastModifiedMs: CUTOFF - 1 }]),
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
    expect(deps.saveRecovered).toHaveBeenCalledWith(NAME, expect.anything(), KEY);
  });

  it('skips files newer than the cutoff (the active recording is never touched)', async () => {
    const deps = makeDeps({
      listOrphanCandidates: jest.fn(async () => [{ key: KEY, filename: NAME, lastModifiedMs: CUTOFF + 1 }]),
    });
    await recoverOrphanRecordings(deps);
    expect(deps.openOpfsFile).not.toHaveBeenCalled();
    expect(deps.saveRecovered).not.toHaveBeenCalled();
  });

  it('skips files that have a pending-upload marker (#1 owns them)', async () => {
    // Markers hold the OPFS key, so exclusion is matched on the key.
    const deps = makeDeps({ excludedNames: jest.fn(async () => new Set([KEY])) });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
  });

  it('deletes an empty orphan without saving', async () => {
    const deps = makeDeps({ openOpfsFile: jest.fn(async () => blob(0)) });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
    expect(deps.removeOpfsFile).toHaveBeenCalledWith(KEY);
  });

  it('deletes a missing orphan (open returns null)', async () => {
    const deps = makeDeps({ openOpfsFile: jest.fn(async () => null) });
    await recoverOrphanRecordings(deps);
    expect(deps.removeOpfsFile).toHaveBeenCalledWith(KEY);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
  });

  it('preserves the orphan when sealing throws, and retries next launch', async () => {
    const deps = makeDeps({ sealFile: jest.fn(async () => { throw new Error('seal failed'); }) });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).not.toHaveBeenCalled();
    expect(deps.removeOpfsFile).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalled();
  });

  /**
   * OF-1: capture moved into `staging/`, but recordings orphaned before that
   * still sit at the OPFS root under a bare filename. They must keep recovering,
   * or a crash from before the upgrade strands its bytes forever.
   */
  it('recovers a pre-split orphan sitting at the OPFS root', async () => {
    const legacy = 'google-meet-old-20251201T0900-recording.webm';
    const deps = makeDeps({
      listOrphanCandidates: jest.fn(async () => [
        { key: legacy, filename: legacy, lastModifiedMs: CUTOFF - 1 },
      ]),
    });
    await recoverOrphanRecordings(deps);
    expect(deps.openOpfsFile).toHaveBeenCalledWith(legacy);
    expect(deps.saveRecovered).toHaveBeenCalledWith(legacy, expect.anything(), legacy);
  });

  it('processes each old-enough orphan independently', async () => {
    const deps = makeDeps({
      listOrphanCandidates: jest.fn(async () => [
        { key: KEY, filename: NAME, lastModifiedMs: CUTOFF - 1 },
        { key: 'staging/google-meet-abc-20260101T0900-mic.webm', filename: 'google-meet-abc-20260101T0900-mic.webm', lastModifiedMs: CUTOFF - 1 },
      ]),
    });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).toHaveBeenCalledTimes(2);
  });

  it('caps the number recovered per run, deferring the rest to a later launch', async () => {
    const deps = makeDeps({
      maxPerRun: 2,
      listOrphanCandidates: jest.fn(async () => [
        { key: 'staging/a-recording.webm', filename: 'a-recording.webm', lastModifiedMs: CUTOFF - 3 },
        { key: 'staging/b-recording.webm', filename: 'b-recording.webm', lastModifiedMs: CUTOFF - 2 },
        { key: 'staging/c-recording.webm', filename: 'c-recording.webm', lastModifiedMs: CUTOFF - 1 },
      ]),
    });
    await recoverOrphanRecordings(deps);
    expect(deps.saveRecovered).toHaveBeenCalledTimes(2);
    // Oldest-first: the two oldest are taken, the newest is deferred.
    expect(deps.saveRecovered).toHaveBeenCalledWith('a-recording.webm', expect.anything(), 'staging/a-recording.webm');
    expect(deps.saveRecovered).toHaveBeenCalledWith('b-recording.webm', expect.anything(), 'staging/b-recording.webm');
  });

  it('delivers raw bytes (skips the in-memory seal) for files above maxSealBytes', async () => {
    const raw = blob(500);
    const deps = makeDeps({ maxSealBytes: 100, openOpfsFile: jest.fn(async () => raw) });
    await recoverOrphanRecordings(deps);
    expect(deps.sealFile).not.toHaveBeenCalled();
    expect(deps.saveRecovered).toHaveBeenCalledWith(NAME, raw, KEY);
  });

  it('still seals files at or below maxSealBytes', async () => {
    const deps = makeDeps({ maxSealBytes: 1000, openOpfsFile: jest.fn(async () => blob(500)) });
    await recoverOrphanRecordings(deps);
    expect(deps.sealFile).toHaveBeenCalledTimes(1);
  });
});
