import {
  BUILTIN_DRIVE_PROFILE_ID,
  BUILTIN_LOCAL_PROFILE_ID,
  MAX_RECORDING_DESTINATION_PROFILES,
  builtinRecordingDestinations,
  normalizeRecordingDestinationProfiles,
  parseSaveToValue,
  resolveRecordingDestination,
  saveToValueOf,
  storageModeOfProfile,
  type RecordingDestinationProfile,
} from '../recordingDestinations';

const crm = (overrides: Partial<RecordingDestinationProfile> = {}): RecordingDestinationProfile => ({
  id: 'profile-crm',
  name: 'CheekyCheeseIT',
  mediaTarget: { kind: 'local' },
  dataRoutes: [{ destinationId: 'destination_crm', mode: 'auto' }],
  ...overrides,
});

describe('recording destination profiles', () => {
  it('reproduces today\'s two storage modes as built-in profiles', () => {
    expect(builtinRecordingDestinations()).toEqual([
      { id: BUILTIN_DRIVE_PROFILE_ID, name: 'Google Drive', mediaTarget: { kind: 'drive' }, dataRoutes: [] },
      { id: BUILTIN_LOCAL_PROFILE_ID, name: 'Local downloads', mediaTarget: { kind: 'local' }, dataRoutes: [] },
    ]);
  });

  it('keeps a well-formed V1 integration profile', () => {
    expect(normalizeRecordingDestinationProfiles([crm()])).toEqual([crm()]);
  });

  it('keeps a local folder preset reference on an integration profile', () => {
    const profile = crm({ mediaTarget: { kind: 'local', folderPresetId: 'folder-1' } });
    expect(normalizeRecordingDestinationProfiles([profile])).toEqual([profile]);
  });

  it('rejects shapes V1 does not allow yet: Drive media, external media, review routes, zero or several routes', () => {
    expect(normalizeRecordingDestinationProfiles([
      crm({ id: 'a', mediaTarget: { kind: 'drive' } }),
      crm({ id: 'b', mediaTarget: { kind: 'external', destinationId: 'destination_crm' } }),
      crm({ id: 'c', dataRoutes: [{ destinationId: 'destination_crm', mode: 'review' }] }),
      crm({ id: 'd', dataRoutes: [] }),
      crm({ id: 'e', dataRoutes: [
        { destinationId: 'destination_crm', mode: 'auto' },
        { destinationId: 'destination_journal', mode: 'auto' },
      ] }),
    ])).toEqual([]);
  });

  it('drops malformed entries, built-in IDs, duplicate IDs and blank names, and trims names', () => {
    expect(normalizeRecordingDestinationProfiles([
      null,
      'nope',
      crm({ id: BUILTIN_DRIVE_PROFILE_ID }),
      crm({ id: 'x', name: '   ' }),
      crm({ id: 'dup', name: '  Recruiting  ' }),
      crm({ id: 'dup', name: 'Second' }),
    ])).toEqual([crm({ id: 'dup', name: 'Recruiting' })]);
  });

  it('is bounded like the folder lists', () => {
    const many = Array.from({ length: MAX_RECORDING_DESTINATION_PROFILES + 5 }, (_, i) => crm({ id: `p${i}`, name: `P${i}` }));
    expect(normalizeRecordingDestinationProfiles(many)).toHaveLength(MAX_RECORDING_DESTINATION_PROFILES);
  });

  it('treats anything that is not a list as no profiles', () => {
    expect(normalizeRecordingDestinationProfiles(undefined)).toEqual([]);
    expect(normalizeRecordingDestinationProfiles({})).toEqual([]);
  });

  it('derives the storage mode from the media target', () => {
    expect(storageModeOfProfile(builtinRecordingDestinations()[0])).toBe('drive');
    expect(storageModeOfProfile(builtinRecordingDestinations()[1])).toBe('local');
    expect(storageModeOfProfile(crm())).toBe('local');
  });

  it('resolves built-in and user profiles by ID, and nothing else', () => {
    expect(resolveRecordingDestination(BUILTIN_DRIVE_PROFILE_ID, [crm()])?.mediaTarget.kind).toBe('drive');
    expect(resolveRecordingDestination('profile-crm', [crm()])).toEqual(crm());
    expect(resolveRecordingDestination('missing', [crm()])).toBeUndefined();
    expect(resolveRecordingDestination(undefined, [crm()])).toBeUndefined();
  });

  it('round-trips the Save to select value, keeping the legacy values for built-ins', () => {
    expect(saveToValueOf(BUILTIN_DRIVE_PROFILE_ID)).toBe('drive');
    expect(saveToValueOf(BUILTIN_LOCAL_PROFILE_ID)).toBe('local');
    expect(saveToValueOf('profile-crm')).toBe('profile:profile-crm');
    expect(parseSaveToValue('drive')).toEqual({ storageMode: 'drive', profileId: BUILTIN_DRIVE_PROFILE_ID });
    expect(parseSaveToValue('local')).toEqual({ storageMode: 'local', profileId: BUILTIN_LOCAL_PROFILE_ID });
    expect(parseSaveToValue('profile:profile-crm')).toEqual({ storageMode: 'local', profileId: 'profile-crm' });
    expect(parseSaveToValue('profile:')).toEqual({ storageMode: 'drive', profileId: BUILTIN_DRIVE_PROFILE_ID });
    expect(parseSaveToValue(undefined)).toEqual({ storageMode: 'drive', profileId: BUILTIN_DRIVE_PROFILE_ID });
  });
});
