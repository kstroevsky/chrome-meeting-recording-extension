/** The page's choice crosses a message boundary; only a clean one is acted on. */
import { handleLibraryMessage } from '../libraryMessages';

jest.mock('../../drive/recordingFileDeletionPorts', () => ({ createRecordingFileDeletionPorts: () => ({}) }));

describe('SYNC_DRIVE_PLAN / SYNC_DRIVE_APPLY', () => {
  const sync = {
    plan: jest.fn(async () => ({ moves: [], notInLibrary: [], missing: [], durations: 0, leftAlone: [] })),
    apply: jest.fn(async () => ({ moved: 0, broughtBack: 0, durations: 0, durationsUnreadable: 0 })),
  };
  const deps = { history: {}, driveLibrary: { sync } } as never;

  it('previews, and applies only a well-formed choice', async () => {
    const respond = jest.fn();
    await handleLibraryMessage({ type: 'SYNC_DRIVE_PLAN' }, respond, deps);
    expect(respond).toHaveBeenLastCalledWith({ ok: true, plan: expect.objectContaining({ durations: 0 }) });

    await handleLibraryMessage({
      type: 'SYNC_DRIVE_APPLY',
      choice: { moves: 'yes', durations: true, bringBack: ['folder-1', 42, '', null] } as never,
    }, respond, deps);
    expect(sync.apply).toHaveBeenCalledWith({ moves: false, durations: true, bringBack: ['folder-1'] });
  });

  it('refuses when Drive is not available', async () => {
    await expect(handleLibraryMessage({ type: 'SYNC_DRIVE_PLAN' }, jest.fn(), { history: {} } as never))
      .rejects.toThrow('Google Drive sync is unavailable');
  });
});
