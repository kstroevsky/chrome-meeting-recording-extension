import {
  RECORDING_DESTINATION_PICK_KEY,
  loadRememberedDestinationPick,
  rememberDestinationPick,
} from '../recordingDestinationPick';

describe('remembered Save to pick', () => {
  const get = () => chrome.storage.local.get as jest.Mock;

  it('reads a stored pick and ignores anything malformed', async () => {
    get().mockResolvedValueOnce({ [RECORDING_DESTINATION_PICK_KEY]: ' profile-crm ' });
    await expect(loadRememberedDestinationPick()).resolves.toBe('profile-crm');
    for (const value of [undefined, 42, '', 'x'.repeat(129)]) {
      get().mockResolvedValueOnce({ [RECORDING_DESTINATION_PICK_KEY]: value });
      await expect(loadRememberedDestinationPick()).resolves.toBeUndefined();
    }
  });

  it('stores the pick under its own key, never inside the settings object', async () => {
    await rememberDestinationPick('profile-crm');
    expect(chrome.storage.local.set).toHaveBeenCalledWith({ [RECORDING_DESTINATION_PICK_KEY]: 'profile-crm' });
  });
});
