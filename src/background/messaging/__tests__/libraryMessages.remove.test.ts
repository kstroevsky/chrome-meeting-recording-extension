/**
 * Removing with "also delete files": the share goes first (it is served from
 * those files), and if it cannot be ended, nothing is removed or deleted.
 */
import { handleLibraryMessage } from '../libraryMessages';
import { deleteRecordingFiles } from '../../library/history/RecordingFileDeletion';

jest.mock('../../library/history/RecordingFileDeletion', () => ({ deleteRecordingFiles: jest.fn() }));
jest.mock('../../drive/recordingFileDeletionPorts', () => ({ createRecordingFileDeletionPorts: () => ({}) }));

const ENTRY = { id: 'r1', name: 'Therapy', files: [] };

function deps(overrides: { revoke?: jest.Mock } = {}) {
  const order: string[] = [];
  const history = {
    get: jest.fn(async () => ENTRY),
    remove: jest.fn(async () => { order.push('remove'); return true; }),
  };
  const sharing = {
    revokeSharesOf: overrides.revoke ?? jest.fn(async () => { order.push('revoke'); return 1; }),
  };
  (deleteRecordingFiles as jest.Mock).mockImplementation(async () => {
    order.push('delete files');
    return { deleted: 3, errors: [] };
  });
  return { order, history, sharing, all: { history, sharing } as never };
}

describe('REMOVE_RECORDING_HISTORY', () => {
  beforeEach(() => jest.clearAllMocks());

  it('only removes from the library unless files are asked for', async () => {
    const { history, sharing, all } = deps();
    const respond = jest.fn();
    await handleLibraryMessage({ type: 'REMOVE_RECORDING_HISTORY', id: 'r1' }, respond, all);
    expect(respond).toHaveBeenCalledWith({ ok: true, removed: true });
    expect(sharing.revokeSharesOf).not.toHaveBeenCalled();
    expect(deleteRecordingFiles).not.toHaveBeenCalled();
    expect(history.remove).toHaveBeenCalledWith('r1');
  });

  it('ends the share, then removes, then deletes the files', async () => {
    const { order, all } = deps();
    const respond = jest.fn();
    await handleLibraryMessage({ type: 'REMOVE_RECORDING_HISTORY', id: 'r1', deleteFiles: true }, respond, all);
    expect(order).toEqual(['revoke', 'remove', 'delete files']);
    expect(deleteRecordingFiles).toHaveBeenCalledWith(ENTRY, expect.anything());
    expect(respond).toHaveBeenCalledWith({ ok: true, removed: true, filesDeleted: 3, fileErrors: [], sharesEnded: 1 });
  });

  it('removes and deletes nothing when the share cannot be ended', async () => {
    const { history, all } = deps({ revoke: jest.fn(async () => { throw new Error('Could not revoke share'); }) });
    await expect(handleLibraryMessage({ type: 'REMOVE_RECORDING_HISTORY', id: 'r1', deleteFiles: true }, jest.fn(), all))
      .rejects.toThrow('Could not revoke share');
    expect(history.remove).not.toHaveBeenCalled();
    expect(deleteRecordingFiles).not.toHaveBeenCalled();
  });
});
