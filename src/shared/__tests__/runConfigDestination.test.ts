import { parseRunConfig } from '../recordingNormalizers';

describe('run config destination profile', () => {
  it('keeps a bounded destination profile ID', () => {
    expect(parseRunConfig({ storageMode: 'local', destinationProfileId: ' profile-crm ' })?.destinationProfileId)
      .toBe('profile-crm');
  });

  it('omits the field for missing, blank, non-string or oversized values', () => {
    for (const destinationProfileId of [undefined, '', '   ', 42, 'x'.repeat(129)]) {
      expect(parseRunConfig({ storageMode: 'local', destinationProfileId })).not.toHaveProperty('destinationProfileId');
    }
  });
});
