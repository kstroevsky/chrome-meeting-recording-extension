/** ADR-0006: promotion transfers ownership from staging to the retained library. */
import { ReadableStream, WritableStream } from 'node:stream/web';

// jsdom ships neither; browsers do, and the streamed-copy fallback needs them.
Object.assign(globalThis, { ReadableStream, WritableStream });

import { createFakeOpfs, type MoveMode } from '../../../../tests/helpers/fakeOpfs';
import { libraryKey, stagingKey } from '../opfsLayout';
import { MissingArtifactError, RetainedMediaStore } from '../RetainedMediaStore';

const HISTORY = 'recording:abc';
const FILE_ID = 'recording:abc:tab';
const NAME = 'meet-standup-recording.webm';
const STAGING = stagingKey(NAME);
const TARGET = libraryKey(HISTORY, FILE_ID, NAME);

function make(moveMode: MoveMode = 'works') {
  const opfs = createFakeOpfs(moveMode);
  const warn = jest.fn();
  const store = new RetainedMediaStore({ getRoot: async () => opfs.root, now: () => 1_000, warn });
  return { opfs, warn, store };
}

const promote = (store: RetainedMediaStore) => store.promote(STAGING, HISTORY, FILE_ID, NAME);

describe('RetainedMediaStore.promote', () => {
  it('moves a staged artifact into the library and reports where it landed', async () => {
    const { opfs, store } = make();
    opfs.seed(STAGING, 5_000);

    await expect(promote(store)).resolves.toEqual({ kind: 'opfs', key: TARGET, retainedAt: 1_000 });
    expect(opfs.snapshot()).toEqual({ [TARGET]: 5_000 });
  });

  it('uses a deterministic key so a re-run lands on the same file', () => {
    expect(TARGET).toBe('library/recording%3Aabc/recording%3Aabc%3Atab.webm');
    expect(libraryKey(HISTORY, FILE_ID, NAME)).toBe(TARGET);
  });

  it('is idempotent once the move happened but the metadata write did not', async () => {
    const { opfs, store } = make();
    opfs.seed(TARGET, 5_000); // crash after the move, before persisting the location

    await expect(promote(store)).resolves.toMatchObject({ key: TARGET });
    expect(opfs.snapshot()).toEqual({ [TARGET]: 5_000 });
  });

  it('reconciles an interrupted copy by keeping the complete retained file', async () => {
    const { opfs, store } = make();
    opfs.seed(STAGING, 5_000);
    opfs.seed(TARGET, 5_000); // copy finished, staging delete did not

    await promote(store);
    expect(opfs.snapshot()).toEqual({ [TARGET]: 5_000 });
  });

  it('re-promotes when the retained copy is short, rather than trusting it', async () => {
    const { opfs, store, warn } = make();
    opfs.seed(STAGING, 5_000);
    opfs.seed(TARGET, 1_200); // copy died partway through

    await promote(store);
    expect(opfs.snapshot()).toEqual({ [TARGET]: 5_000 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is short'));
  });

  it('throws when neither copy exists rather than inventing a location', async () => {
    const { store } = make();
    await expect(promote(store)).rejects.toBeInstanceOf(MissingArtifactError);
  });

  it('never touches anything outside the promoted pair', async () => {
    const { opfs, store } = make();
    opfs.seed(STAGING, 5_000);
    opfs.seed('staging/other-recording.webm', 42);
    opfs.seed('library/recording%3Aother/x.webm', 7);

    await promote(store);
    expect(opfs.snapshot()).toEqual({
      [TARGET]: 5_000,
      'staging/other-recording.webm': 42,
      'library/recording%3Aother/x.webm': 7,
    });
  });
});

describe('RetainedMediaStore promotion fallback', () => {
  it('prefers move() when it works, so a large file is not copied', async () => {
    const { opfs, store } = make('works');
    opfs.seed(STAGING, 5_000);

    await promote(store);
    expect(opfs.moveCalls).toBe(1);
  });

  it('falls back to a streamed copy when move() is absent', async () => {
    const { opfs, store } = make('absent');
    opfs.seed(STAGING, 5_000);

    await promote(store);
    expect(opfs.snapshot()).toEqual({ [TARGET]: 5_000 });
  });

  /**
   * The load-bearing case: Edge 118 *exposes* move() and throws NotAllowedError
   * when called, so a `typeof` capability check passes and production fails.
   */
  it('falls back when move() exists but throws at call time', async () => {
    const { opfs, store, warn } = make('throws');
    opfs.seed(STAGING, 5_000);

    await promote(store);
    expect(opfs.moveCalls).toBe(1);
    expect(opfs.snapshot()).toEqual({ [TARGET]: 5_000 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NotAllowedError'));
  });
});
