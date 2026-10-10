import {
  BUILTIN_DRIVE_PROFILE_ID,
  BUILTIN_LOCAL_PROFILE_ID,
  MAX_RECORDING_DESTINATION_PROFILES,
  MAX_RECORDING_DESTINATION_ROUTES,
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

  it('keeps a well-formed V1 integration profile unchanged', () => {
    expect(normalizeRecordingDestinationProfiles([crm()])).toEqual([crm()]);
  });

  it('keeps a local folder preset reference on an integration profile', () => {
    const profile = crm({ mediaTarget: { kind: 'local', folderPresetId: 'folder-1' } });
    expect(normalizeRecordingDestinationProfiles([profile])).toEqual([profile]);
  });

  it('accepts M3 local/Drive media with zero or several automatic data routes', () => {
    const drive = crm({
      id: 'drive-profile',
      mediaTarget: { kind: 'drive', folderPresetId: 'drive-folder' },
      dataRoutes: [],
    });
    const several = crm({
      id: 'several',
      dataRoutes: [
        { destinationId: 'destination_crm', mode: 'auto' },
        { destinationId: 'destination_journal', mode: 'auto' },
      ],
    });
    expect(normalizeRecordingDestinationProfiles([drive, several])).toEqual([drive, several]);
  });

  it('accepts M5 external primary media independently from data routes', () => {
    const mediaOnly = crm({
      id: 'external-media-only',
      mediaTarget: { kind: 'external', destinationId: 'destination_crm' },
      dataRoutes: [],
    });
    const mediaAndData = crm({
      id: 'external-combined',
      mediaTarget: { kind: 'external', destinationId: 'destination_crm' },
    });
    expect(normalizeRecordingDestinationProfiles([mediaOnly, mediaAndData])).toEqual([mediaOnly, mediaAndData]);
  });

  it('rejects malformed external media, review routes, duplicate routes and overlong route lists', () => {
    expect(normalizeRecordingDestinationProfiles([
      { ...crm({ id: 'external' }), mediaTarget: { kind: 'external' } },
      crm({ id: 'review', dataRoutes: [{ destinationId: 'destination_crm', mode: 'review' }] }),
      crm({ id: 'duplicate', dataRoutes: [
        { destinationId: 'destination_crm', mode: 'auto' },
        { destinationId: 'destination_crm', mode: 'auto' },
      ] }),
      crm({
        id: 'too-many',
        dataRoutes: Array.from({ length: MAX_RECORDING_DESTINATION_ROUTES + 1 }, (_, index) => ({
          destinationId: `destination-${index}`,
          mode: 'auto' as const,
        })),
      }),
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
    expect(storageModeOfProfile(crm({ mediaTarget: { kind: 'drive' } }))).toBe('drive');
    expect(storageModeOfProfile(crm({ mediaTarget: { kind: 'external', destinationId: 'destination_crm' } }))).toBe('local');
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
    expect(parseSaveToValue('profile:profile-crm', 'drive')).toEqual({ storageMode: 'drive', profileId: 'profile-crm' });
    expect(parseSaveToValue('profile:')).toEqual({ storageMode: 'drive', profileId: BUILTIN_DRIVE_PROFILE_ID });
    expect(parseSaveToValue(undefined)).toEqual({ storageMode: 'drive', profileId: BUILTIN_DRIVE_PROFILE_ID });
  });
});
