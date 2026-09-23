import { loadExtensionSettingsFromStorage } from '../../../shared/settings';
import { DriveDestinationFiler } from '../DriveDestinationFiler';
import { DriveLibraryCoordinator } from '../DriveLibraryCoordinator';

jest.mock('../../../shared/settings', () => ({
  ...jest.requireActual('../../../shared/settings'),
  loadExtensionSettingsFromStorage: jest.fn(),
}));

describe('DriveLibraryCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (loadExtensionSettingsFromStorage as jest.Mock).mockResolvedValue({
      storage: {
        driveFolderPresets: [{ id: 'preset-1', name: 'Clients' }],
        driveRootFolderName: 'Recordings',
      },
    });
    (chrome.storage.local.get as jest.Mock).mockResolvedValue({ driveDestinationsGathered: true });
  });

  it('files the Drive folder before recording the destination in history', async () => {
    const file = jest.spyOn(DriveDestinationFiler.prototype, 'file')
      .mockResolvedValue({ status: 'filed', destinationFolderId: 'destination-1' });
    const historyRepository = {
      get: jest.fn().mockResolvedValue({
        id: 'recording-1',
        name: 'Call',
        createdAt: 1,
        files: [],
        driveFolderId: 'folder-1',
      }),
    };
    const history = { setDriveDestination: jest.fn().mockResolvedValue(undefined) };
    const coordinator = new DriveLibraryCoordinator(
      historyRepository as never,
      history as never,
      { log: jest.fn(), warn: jest.fn() },
    );

    await coordinator.fileRecordingToDestination('recording-1', 'preset-1');

    expect(file).toHaveBeenCalledWith('folder-1', 'Clients', 'Recordings');
    expect(history.setDriveDestination).toHaveBeenCalledWith('recording-1', 'preset-1');
    expect(file.mock.invocationCallOrder[0]).toBeLessThan(
      history.setDriveDestination.mock.invocationCallOrder[0],
    );
  });

  it('does not mutate history when the recording is no longer available', async () => {
    const history = { setDriveDestination: jest.fn() };
    const coordinator = new DriveLibraryCoordinator(
      { get: jest.fn().mockResolvedValue(null) } as never,
      history as never,
      { log: jest.fn(), warn: jest.fn() },
    );

    await expect(coordinator.fileRecordingToDestination('missing', 'preset-1'))
      .rejects.toThrow('no longer available');
    expect(history.setDriveDestination).not.toHaveBeenCalled();
  });
});
