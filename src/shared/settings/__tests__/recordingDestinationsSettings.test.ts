import { cloneSettings, normalizeExtensionSettings } from '../normalize';

const profile = {
  id: 'profile-crm',
  name: 'CheekyCheeseIT',
  mediaTarget: { kind: 'local' },
  dataRoutes: [{ destinationId: 'destination_crm', mode: 'auto' }],
};

describe('recording destinations in settings', () => {
  it('defaults to none: the built-in Drive and local entries are derived, not stored', () => {
    expect(normalizeExtensionSettings({}).storage.recordingDestinations).toEqual([]);
    expect(normalizeExtensionSettings({ storage: {} } as never).storage.recordingDestinations).toEqual([]);
  });

  it('keeps valid V1 profiles and drops the rest', () => {
    const settings = normalizeExtensionSettings({
      storage: { recordingDestinations: [profile, { ...profile, id: 'drive', mediaTarget: { kind: 'drive' } }] },
    } as never);
    expect(settings.storage.recordingDestinations).toEqual([profile]);
  });

  it('clones deeply, so editing a copy never edits the stored profile', () => {
    const settings = normalizeExtensionSettings({ storage: { recordingDestinations: [profile] } } as never);
    const copy = cloneSettings(settings);
    copy.storage.recordingDestinations[0]!.dataRoutes[0]!.destinationId = 'changed';
    (copy.storage.recordingDestinations[0]!.mediaTarget as { folderPresetId?: string }).folderPresetId = 'x';
    expect(settings.storage.recordingDestinations[0]).toEqual(profile);
  });
});
