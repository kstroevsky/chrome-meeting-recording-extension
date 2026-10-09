import type { IntegrationDestination } from '../../../integrations/persistence';
import { CONSERVATIVE_INTEGRATION_POLICY } from '../../../integrations/policy';
import { BUILTIN_DRIVE_PROFILE_ID, BUILTIN_LOCAL_PROFILE_ID } from '../../../shared/recordingDestinations';
import type { RecordingContext } from '../../../shared/recordingContext';
import { normalizeExtensionSettings, type ExtensionSettings } from '../../../shared/settings';
import { RecordingDestinationsRuntime } from '../RecordingDestinationsRuntime';

function integration(overrides: Partial<IntegrationDestination> = {}): IntegrationDestination {
  return {
    id: 'destination_crm',
    producerId: 'producer_crm',
    name: 'CheekyCheeseIT CRM',
    type: 'webhook',
    enabled: true,
    endpoint: 'https://crm.example.test/api/integrations/meeting-recorder/c1/webhook',
    routingDefault: 'manual',
    dataPolicy: { ...CONSERVATIVE_INTEGRATION_POLICY, metadata: true },
    requestAuth: { type: 'none' },
    signingSecretId: 'secret_crm',
    connectionVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const MEDIA: NonNullable<IntegrationDestination['media']> = {
  secretId: 'secret_media',
  capability: {
    version: 1,
    apiBase: 'https://crm.example.test/api/integrations/meeting-recorder/media',
    upload: { strategy: 'multipart-put-v1', origins: ['https://objects.example.test'] },
    playback: { strategy: 'refreshable-url-v1' },
  },
};

function harness(options: {
  integrations?: IntegrationDestination[];
  permitted?: boolean;
  pick?: string;
  contexts?: Record<string, RecordingContext>;
} = {}) {
  let settings: ExtensionSettings = normalizeExtensionSettings({
    storage: {
      localFolderPresets: [{ id: 'folder-1', name: 'Interviews' }],
      driveFolderPresets: [{ id: 'drive-folder-1', name: 'Recruiting' }],
    },
  } as never);
  let pick = options.pick;
  let ids = 0;
  const runtime = new RecordingDestinationsRuntime({
    loadSettings: async () => normalizeExtensionSettings(settings),
    saveSettings: async (next) => { settings = normalizeExtensionSettings(next); return settings; },
    listIntegrationDestinations: async () => options.integrations ?? [integration()],
    containsHostPermission: async () => options.permitted ?? true,
    loadPick: async () => pick,
    rememberPick: async (id) => { pick = id; },
    createId: () => `profile-${++ids}`,
    getRecordingContext: async (recordingId) => options.contexts?.[recordingId],
  });
  return { runtime, settings: () => settings, pick: () => pick };
}

describe('RecordingDestinationsRuntime', () => {
  it('lists the built-ins first, then saved integration profiles with their files and data lines', async () => {
    const ctx = harness();
    await ctx.runtime.save({ destinationId: 'destination_crm', name: 'CheekyCheeseIT', localFolderPresetId: 'folder-1' });

    const { destinations } = await ctx.runtime.list();
    expect(destinations.map((option) => option.id)).toEqual([BUILTIN_DRIVE_PROFILE_ID, BUILTIN_LOCAL_PROFILE_ID, 'profile-1']);
    expect(destinations[2]).toEqual({
      id: 'profile-1',
      name: 'CheekyCheeseIT',
      kind: 'custom',
      storageMode: 'local',
      filesLabel: 'Local downloads / Interviews',
      dataRoutes: [{ destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM' }],
      available: true,
    });
  });

  it('names a new profile after its destination when no name is given', async () => {
    const ctx = harness();
    await expect(ctx.runtime.save({ destinationId: 'destination_crm' })).resolves.toEqual(
      expect.objectContaining({ name: 'CheekyCheeseIT CRM', mediaTarget: { kind: 'local' } }),
    );
  });

  it('saves Drive media with several automatic routes and reports all destinations', async () => {
    const journal = integration({
      id: 'destination_journal',
      producerId: 'producer_journal',
      name: 'Journal',
      endpoint: 'https://journal.example.test/hooks/recordings',
      signingSecretId: 'secret_journal',
    });
    const ctx = harness({ integrations: [integration(), journal] });
    await expect(ctx.runtime.save({
      name: 'Recruiting archive',
      mediaTarget: { kind: 'drive', folderPresetId: 'drive-folder-1' },
      dataRoutes: [
        { destinationId: 'destination_crm', mode: 'auto' },
        { destinationId: 'destination_journal', mode: 'auto' },
      ],
    })).resolves.toEqual(expect.objectContaining({
      name: 'Recruiting archive',
      mediaTarget: { kind: 'drive', folderPresetId: 'drive-folder-1' },
    }));

    expect((await ctx.runtime.list()).destinations[2]).toEqual(expect.objectContaining({
      kind: 'custom',
      storageMode: 'drive',
      filesLabel: 'Google Drive / Recruiting',
      dataRoutes: [
        { destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM' },
        { destinationId: 'destination_journal', destinationName: 'Journal' },
      ],
      available: true,
    }));
  });

  it('allows a folder-only profile and rejects unknown folder presets', async () => {
    const ctx = harness();
    await expect(ctx.runtime.save({
      mediaTarget: { kind: 'local', folderPresetId: 'folder-1' },
      dataRoutes: [],
    })).resolves.toEqual(expect.objectContaining({
      name: 'Local downloads / Interviews',
      dataRoutes: [],
    }));
    await expect(ctx.runtime.save({
      mediaTarget: { kind: 'drive', folderPresetId: 'missing' },
      dataRoutes: [],
    })).rejects.toThrow('Folder preset does not exist');
  });

  it('saves an external primary-media profile without turning the receiver into a data route', async () => {
    const ctx = harness({ integrations: [integration({ media: MEDIA })] });
    await expect(ctx.runtime.save({
      mediaTarget: { kind: 'external', destinationId: 'destination_crm' },
      dataRoutes: [],
    })).resolves.toEqual(expect.objectContaining({
      name: 'CheekyCheeseIT CRM',
      mediaTarget: { kind: 'external', destinationId: 'destination_crm' },
      dataRoutes: [],
    }));

    expect((await ctx.runtime.list()).destinations[2]).toEqual(expect.objectContaining({
      storageMode: 'local',
      filesLabel: 'CheekyCheeseIT CRM',
      dataRoutes: [],
      available: true,
    }));
  });

  it('requires an external primary receiver to advertise media capability', async () => {
    const ctx = harness();
    await expect(ctx.runtime.save({
      mediaTarget: { kind: 'external', destinationId: 'destination_crm' },
      dataRoutes: [],
    })).rejects.toThrow('does not support media');
  });

  it('marks a profile unavailable when its destination is gone, disabled, or lacks host permission', async () => {
    const saved = harness();
    await saved.runtime.save({ destinationId: 'destination_crm' });
    const stored = saved.settings().storage.recordingDestinations;

    const reasonWith = async (options: Parameters<typeof harness>[0]) => {
      const ctx = harness(options);
      await ctx.runtime.save({ destinationId: 'destination_crm' }).catch(() => {});
      (ctx.settings().storage as { recordingDestinations: unknown }).recordingDestinations = stored;
      const option = (await ctx.runtime.list()).destinations[2];
      return option && { available: option.available, reason: option.unavailableReason };
    };
    await expect(reasonWith({ integrations: [] })).resolves.toEqual({ available: false, reason: 'destination-missing' });
    await expect(reasonWith({ integrations: [integration({ enabled: false })] })).resolves.toEqual({ available: false, reason: 'destination-disabled' });
    await expect(reasonWith({ permitted: false })).resolves.toEqual({ available: false, reason: 'permission-missing' });
  });

  it('refuses a profile for a destination that does not exist', async () => {
    const ctx = harness({ integrations: [] });
    await expect(ctx.runtime.save({ destinationId: 'destination_crm' })).rejects.toThrow('does not exist');
  });

  it('updates in place by ID and removes only user profiles', async () => {
    const ctx = harness();
    await ctx.runtime.save({ destinationId: 'destination_crm', name: 'First' });
    await ctx.runtime.save({ id: 'profile-1', destinationId: 'destination_crm', name: 'Renamed' });
    expect(ctx.settings().storage.recordingDestinations).toEqual([expect.objectContaining({ id: 'profile-1', name: 'Renamed' })]);

    await expect(ctx.runtime.remove(BUILTIN_DRIVE_PROFILE_ID)).rejects.toThrow('Built-in');
    await expect(ctx.runtime.remove('profile-1')).resolves.toBe(true);
    await expect(ctx.runtime.remove('profile-1')).resolves.toBe(false);
    expect(ctx.settings().storage.recordingDestinations).toEqual([]);
  });

  it('offers the remembered pick only while it still exists and is available', async () => {
    const ctx = harness({ pick: 'profile-1' });
    await expect(ctx.runtime.list()).resolves.not.toHaveProperty('rememberedId');
    await ctx.runtime.save({ destinationId: 'destination_crm' });
    await expect(ctx.runtime.list()).resolves.toEqual(expect.objectContaining({ rememberedId: 'profile-1' }));
    await ctx.runtime.remember(BUILTIN_LOCAL_PROFILE_ID);
    expect(ctx.pick()).toBe(BUILTIN_LOCAL_PROFILE_ID);
  });

  it('resolves the profile a recording starts with, falling back to the matching built-in', async () => {
    const ctx = harness();
    await ctx.runtime.save({ destinationId: 'destination_crm' });

    await expect(ctx.runtime.resolveForStart('profile-1', 'drive')).resolves.toEqual(expect.objectContaining({
      profile: expect.objectContaining({ id: 'profile-1' }), available: true,
    }));
    await expect(ctx.runtime.resolveForStart('missing', 'drive')).resolves.toEqual(expect.objectContaining({
      profile: expect.objectContaining({ id: BUILTIN_DRIVE_PROFILE_ID }), available: false,
    }));
    await expect(ctx.runtime.resolveForStart(undefined, 'local')).resolves.toEqual(expect.objectContaining({
      profile: expect.objectContaining({ id: BUILTIN_LOCAL_PROFILE_ID }), available: true,
    }));
  });

  it('names the local folder a recording\'s destination files into', async () => {
    const recordingContext = (recordingId: string, destinationProfileId: string): RecordingContext => ({
      recordingId,
      startedAt: 1,
      source: { kind: 'tab' },
      destinationProfileId,
    });
    const ctx = harness({ contexts: {
      r1: recordingContext('r1', 'profile-1'),
      r2: recordingContext('r2', BUILTIN_LOCAL_PROFILE_ID),
      r3: recordingContext('r3', 'profile-removed'),
    } });
    await ctx.runtime.save({ destinationId: 'destination_crm', localFolderPresetId: 'folder-1' });

    await expect(ctx.runtime.localFolderFor('r1')).resolves.toBe('folder-1');
    await expect(ctx.runtime.localFolderFor('r2')).resolves.toBeUndefined();
    await expect(ctx.runtime.localFolderFor('r3')).resolves.toBeUndefined();
    await expect(ctx.runtime.localFolderFor('unknown')).resolves.toBeUndefined();
  });

  it('uses frozen routes instead of expanding historical authorization after a profile edit', async () => {
    const journal = integration({
      id: 'destination_journal',
      producerId: 'producer_journal',
      name: 'Journal',
      endpoint: 'https://journal.example.test/hooks/recordings',
      signingSecretId: 'secret_journal',
    });
    const frozenRoutes = [{ destinationId: 'destination_crm', mode: 'auto' as const }];
    const ctx = harness({
      integrations: [integration(), journal],
      contexts: {
        r1: {
          recordingId: 'r1', startedAt: 1, source: { kind: 'tab' }, destinationProfileId: 'profile-1',
          destinationMediaTarget: { kind: 'local' }, destinationRoutes: frozenRoutes,
        },
      },
    });
    await ctx.runtime.save({ destinationId: 'destination_crm' });
    await ctx.runtime.save({
      id: 'profile-1',
      name: 'Expanded later',
      mediaTarget: { kind: 'local' },
      dataRoutes: [
        { destinationId: 'destination_crm', mode: 'auto' },
        { destinationId: 'destination_journal', mode: 'auto' },
      ],
    });

    await expect(ctx.runtime.routesForRecording('r1')).resolves.toEqual(frozenRoutes);
  });

  it('uses the frozen media target even when the live profile later points somewhere else', async () => {
    const ctx = harness({
      contexts: {
        r1: {
          recordingId: 'r1', startedAt: 1, source: { kind: 'tab' }, destinationProfileId: 'profile-1',
          destinationMediaTarget: { kind: 'local', folderPresetId: 'folder-1' }, destinationRoutes: [],
        },
      },
    });
    await ctx.runtime.save({ destinationId: 'destination_crm', localFolderPresetId: 'folder-1' });
    await ctx.runtime.save({
      id: 'profile-1',
      name: 'Moved later',
      mediaTarget: { kind: 'drive', folderPresetId: 'drive-folder-1' },
      dataRoutes: [{ destinationId: 'destination_crm', mode: 'auto' }],
    });

    await expect(ctx.runtime.localFolderFor('r1')).resolves.toBe('folder-1');
    await expect(ctx.runtime.driveFolderPresetFor('r1')).resolves.toBeUndefined();
  });

  it('resolves the frozen Drive preset identity and folder name', async () => {
    const ctx = harness({
      contexts: {
        r1: {
          recordingId: 'r1', startedAt: 1, source: { kind: 'tab' }, destinationProfileId: 'profile-1',
          destinationMediaTarget: { kind: 'drive', folderPresetId: 'drive-folder-1' }, destinationRoutes: [],
        },
      },
    });

    await expect(ctx.runtime.driveFolderPresetFor('r1')).resolves.toBe('drive-folder-1');
    await expect(ctx.runtime.driveFolderNameFor('r1')).resolves.toBe('Recruiting');
  });
});
