import { handleLibraryMessage } from '../libraryMessages';

const TARGET = { fileId: 'r1:tab', key: 'library/r1/tab.webm', bytes: 123 };
const ENTRY = { id: 'r1', name: 'Interview', files: [] };

function setup(busy = false) {
  const history = {
    planVerifiedRetainedMediaRelease: jest.fn(async () => [TARGET]),
    markVerifiedRetainedMediaReleased: jest.fn(async () => ({ entry: ENTRY, released: [TARGET] })),
    deleteReleasedRetainedMedia: jest.fn(async () => 'deferred' as const),
    get: jest.fn(async () => ENTRY),
  };
  const externalMedia = {
    withRetainedSourceRelease: jest.fn(async (_id: string, _keys: string[], release: () => Promise<unknown>) =>
      busy ? { busy: true as const } : { busy: false as const, value: await release() }),
  };
  return { history, externalMedia, deps: { history, externalMedia } as never };
}

describe('FREE_RECORDING_SPACE', () => {
  beforeEach(() => jest.clearAllMocks());

  it('does not mutate history when an external transfer still needs the retained source', async () => {
    const { history, deps } = setup(true);
    const respond = jest.fn();

    await handleLibraryMessage({ type: 'FREE_RECORDING_SPACE', id: 'r1' }, respond, deps);

    expect(respond).toHaveBeenCalledWith({
      ok: false,
      error: 'This recording is still being transferred. Try again when the transfer finishes.',
    });
    expect(history.markVerifiedRetainedMediaReleased).not.toHaveBeenCalled();
    expect(history.deleteReleasedRetainedMedia).not.toHaveBeenCalled();
    expect(chrome.storage.session.set).not.toHaveBeenCalledWith({ retainedMediaReconciled: false });
  });

  it('invalidates startup recovery before committing release intent, then performs lease-aware cleanup', async () => {
    const { history, deps } = setup();
    const respond = jest.fn();

    await handleLibraryMessage({ type: 'FREE_RECORDING_SPACE', id: 'r1' }, respond, deps);

    expect(chrome.storage.session.set).toHaveBeenCalledWith({ retainedMediaReconciled: false });
    expect((chrome.storage.session.set as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan(history.markVerifiedRetainedMediaReleased.mock.invocationCallOrder[0]);
    expect(history.markVerifiedRetainedMediaReleased).toHaveBeenCalledWith('r1', [TARGET]);
    expect(history.deleteReleasedRetainedMedia).toHaveBeenCalledWith('r1', [TARGET]);
    expect(respond).toHaveBeenCalledWith({
      ok: true,
      entry: ENTRY,
      releasedFiles: 1,
      cleanup: 'deferred',
    });
  });
});
