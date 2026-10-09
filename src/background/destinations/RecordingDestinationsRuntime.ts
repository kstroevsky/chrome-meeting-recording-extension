import type { IntegrationDestination } from '../../integrations/persistence';
import { normalizeWebhookEndpoint } from '../../integrations/webhook/WebhookEndpoint';
import {
  BUILTIN_DRIVE_PROFILE_ID,
  BUILTIN_LOCAL_PROFILE_ID,
  builtinRecordingDestinations,
  isBuiltinRecordingDestinationId,
  normalizeRecordingDestinationProfiles,
  resolveRecordingDestination,
  storageModeOfProfile,
  type RecordingDestinationMediaTarget,
  type RecordingDestinationProfile,
  type RecordingDestinationRoute,
} from '../../shared/recordingDestinations';
import type { StorageMode } from '../../shared/recordingTypes';
import type { ExtensionSettings } from '../../shared/settings';
import type { RecordingContext } from '../../shared/recordingContext';

export type RecordingDestinationUnavailableReason =
  | 'destination-missing'
  | 'destination-disabled'
  | 'permission-missing';

/** One "Save to" entry as the popup and settings page show it. */
export type RecordingDestinationOption = {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  storageMode: StorageMode;
  /** Where the files go, e.g. `Local downloads / Interviews`. */
  filesLabel: string;
  dataRoutes: Array<{ destinationId: string; destinationName: string | null }>;
  available: boolean;
  unavailableReason?: RecordingDestinationUnavailableReason;
};

type SaveRecordingDestinationBaseInput = {
  id?: string;
  name?: string;
};

/** Kept so existing callers and stored V1 setup flows continue to work. */
export type LegacySaveRecordingDestinationInput = SaveRecordingDestinationBaseInput & {
  destinationId: string;
  localFolderPresetId?: string;
};

/** M3 profile editor payload. External primary media is introduced in M5. */
export type GeneralSaveRecordingDestinationInput = SaveRecordingDestinationBaseInput & {
  mediaTarget: Extract<RecordingDestinationMediaTarget, { kind: 'local' | 'drive' }>;
  dataRoutes: RecordingDestinationRoute[];
};

export type SaveRecordingDestinationInput =
  | LegacySaveRecordingDestinationInput
  | GeneralSaveRecordingDestinationInput;

type Deps = {
  loadSettings(): Promise<ExtensionSettings>;
  saveSettings(settings: ExtensionSettings): Promise<ExtensionSettings>;
  listIntegrationDestinations(): Promise<IntegrationDestination[]>;
  containsHostPermission(pattern: string): Promise<boolean>;
  loadPick(): Promise<string | undefined>;
  rememberPick(profileId: string): Promise<void>;
  /** The durable context of a recording, which carries the profile picked at Start. */
  getRecordingContext?(recordingId: string): Promise<RecordingContext | undefined>;
  createId?: () => string;
};

/**
 * Owns the "Save to" destination profiles: the built-ins plus the user's
 * integration profiles stored in settings. It is the only writer of
 * `settings.storage.recordingDestinations`, and it resolves references to
 * integration destinations at use time (they live in another store, so no
 * single transaction can keep them consistent).
 */
export class RecordingDestinationsRuntime {
  private readonly createId: () => string;

  constructor(private readonly deps: Deps) {
    this.createId = deps.createId ?? (() => `destination-profile-${crypto.randomUUID()}`);
  }

  async list(): Promise<{ destinations: RecordingDestinationOption[]; rememberedId?: string }> {
    const [settings, integrations, pick] = await Promise.all([
      this.deps.loadSettings(),
      this.deps.listIntegrationDestinations(),
      this.deps.loadPick().catch(() => undefined),
    ]);
    const destinations = await Promise.all(
      [...builtinRecordingDestinations(), ...settings.storage.recordingDestinations]
        .map((profile) => this.describe(profile, settings, integrations)),
    );
    const remembered = destinations.find((option) => option.id === pick && option.available);
    return { destinations, ...(remembered ? { rememberedId: remembered.id } : {}) };
  }

  /**
   * The profile a recording starts with. An unknown or unavailable profile
   * resolves to the built-in matching the requested storage mode: the
   * recording still starts, it just routes nowhere.
   */
  async resolveForStart(
    profileId: string | undefined,
    requestedStorageMode: StorageMode,
  ): Promise<{ profile: RecordingDestinationProfile; requested?: RecordingDestinationProfile; available: boolean }> {
    const fallback = resolveRecordingDestination(
      requestedStorageMode === 'drive' ? BUILTIN_DRIVE_PROFILE_ID : BUILTIN_LOCAL_PROFILE_ID,
      [],
    )!;
    if (!profileId) return { profile: fallback, available: true };
    const settings = await this.deps.loadSettings();
    const requested = resolveRecordingDestination(profileId, settings.storage.recordingDestinations);
    if (!requested) return { profile: fallback, available: false };
    if (!requested.dataRoutes.length) return { profile: requested, requested, available: true };
    const option = await this.describe(requested, settings, await this.deps.listIntegrationDestinations());
    return { profile: requested, requested, available: option.available };
  }

  /** The profile stored under an ID, built-ins included, without availability checks. */
  async find(profileId: string | undefined): Promise<RecordingDestinationProfile | undefined> {
    if (!profileId) return undefined;
    const settings = await this.deps.loadSettings();
    return resolveRecordingDestination(profileId, settings.storage.recordingDestinations);
  }

  /**
   * The data routes of the profile a recording was started with. Empty when the
   * recording predates destinations, used a built-in, or its profile was
   * removed since.
   */
  async routesForRecording(recordingId: string): Promise<RecordingDestinationRoute[]> {
    const context = await this.deps.getRecordingContext?.(recordingId).catch(() => undefined);
    const profile = await this.find(context?.destinationProfileId).catch(() => undefined);
    return profile ? [...profile.dataRoutes] : [];
  }

  /**
   * The local folder preset the recording's destination files into. Undefined
   * for the download directory, a Drive destination, or a profile removed since.
   */
  async localFolderFor(recordingId: string): Promise<string | undefined> {
    const context = await this.deps.getRecordingContext?.(recordingId).catch(() => undefined);
    const profile = await this.find(context?.destinationProfileId).catch(() => undefined);
    return profile?.mediaTarget.kind === 'local' ? profile.mediaTarget.folderPresetId : undefined;
  }

  async save(input: SaveRecordingDestinationInput): Promise<RecordingDestinationProfile> {
    const integrations = await this.deps.listIntegrationDestinations();
    if (input.id && isBuiltinRecordingDestinationId(input.id)) {
      throw new Error('Built-in destinations cannot be changed');
    }

    const settings = await this.deps.loadSettings();
    const normalizedInput = normalizeSaveInput(input);
    const routedDestinations = normalizedInput.dataRoutes.map((route) =>
      integrations.find((candidate) => candidate.id === route.destinationId));
    if (routedDestinations.some((destination) => !destination)) {
      throw new Error('Integration destination does not exist');
    }
    if (normalizedInput.mediaTarget.folderPresetId) {
      const presets = normalizedInput.mediaTarget.kind === 'drive'
        ? settings.storage.driveFolderPresets
        : settings.storage.localFolderPresets;
      if (!presets.some((preset) => preset.id === normalizedInput.mediaTarget.folderPresetId)) {
        throw new Error('Folder preset does not exist');
      }
    }

    const id = input.id ?? this.createId();
    const defaultName = routedDestinations.length === 1
      ? routedDestinations[0]!.name
      : filesLabelOf({
        id,
        name: '',
        mediaTarget: normalizedInput.mediaTarget,
        dataRoutes: [],
      }, settings);
    const profile: RecordingDestinationProfile = {
      id,
      name: (input.name ?? '').trim() || defaultName,
      mediaTarget: normalizedInput.mediaTarget,
      dataRoutes: normalizedInput.dataRoutes,
    };
    const others = settings.storage.recordingDestinations.filter((existing) => existing.id !== id);
    const candidate = normalizeRecordingDestinationProfiles([...others, profile]);
    const stored = candidate.find((existing) => existing.id === id);
    if (!stored) throw new Error('This destination cannot be saved (name too long, or too many destinations)');
    await this.deps.saveSettings({
      ...settings,
      storage: { ...settings.storage, recordingDestinations: candidate },
    });
    return stored;
  }

  async remove(profileId: string): Promise<boolean> {
    if (isBuiltinRecordingDestinationId(profileId)) throw new Error('Built-in destinations cannot be removed');
    const settings = await this.deps.loadSettings();
    const remaining = settings.storage.recordingDestinations.filter((profile) => profile.id !== profileId);
    if (remaining.length === settings.storage.recordingDestinations.length) return false;
    await this.deps.saveSettings({
      ...settings,
      storage: { ...settings.storage, recordingDestinations: remaining },
    });
    return true;
  }

  remember(profileId: string): Promise<void> {
    return this.deps.rememberPick(profileId);
  }

  private async describe(
    profile: RecordingDestinationProfile,
    settings: ExtensionSettings,
    integrations: IntegrationDestination[],
  ): Promise<RecordingDestinationOption> {
    const storageMode = storageModeOfProfile(profile);
    const option: RecordingDestinationOption = {
      id: profile.id,
      name: profile.name,
      kind: isBuiltinRecordingDestinationId(profile.id) ? 'builtin' : 'custom',
      storageMode,
      filesLabel: filesLabelOf(profile, settings),
      dataRoutes: profile.dataRoutes.map((route) => ({
        destinationId: route.destinationId,
        destinationName: integrations.find((destination) => destination.id === route.destinationId)?.name ?? null,
      })),
      available: true,
    };
    for (const route of profile.dataRoutes) {
      const destination = integrations.find((candidate) => candidate.id === route.destinationId);
      const reason: RecordingDestinationUnavailableReason | undefined = !destination
        ? 'destination-missing'
        : !destination.enabled
          ? 'destination-disabled'
          : await this.hasPermission(destination) ? undefined : 'permission-missing';
      if (reason) return { ...option, available: false, unavailableReason: reason };
    }
    return option;
  }

  private async hasPermission(destination: IntegrationDestination): Promise<boolean> {
    try {
      return await this.deps.containsHostPermission(normalizeWebhookEndpoint(destination.endpoint).hostPermission);
    } catch {
      return false;
    }
  }
}

function normalizeSaveInput(input: SaveRecordingDestinationInput): {
  mediaTarget: Extract<RecordingDestinationMediaTarget, { kind: 'local' | 'drive' }>;
  dataRoutes: RecordingDestinationRoute[];
} {
  if ('mediaTarget' in input) {
    return {
      mediaTarget: { ...input.mediaTarget },
      dataRoutes: input.dataRoutes.map((route) => ({ ...route })),
    };
  }
  return {
    mediaTarget: {
      kind: 'local',
      ...(input.localFolderPresetId ? { folderPresetId: input.localFolderPresetId } : {}),
    },
    dataRoutes: [{ destinationId: input.destinationId, mode: 'auto' }],
  };
}

function filesLabelOf(profile: RecordingDestinationProfile, settings: ExtensionSettings): string {
  const target = profile.mediaTarget;
  if (target.kind === 'external') return 'External service';
  const base = target.kind === 'drive' ? 'Google Drive' : 'Local downloads';
  const presets = target.kind === 'drive' ? settings.storage.driveFolderPresets : settings.storage.localFolderPresets;
  const folder = target.folderPresetId
    ? presets.find((preset) => preset.id === target.folderPresetId)?.name
    : undefined;
  return folder ? `${base} / ${folder}` : base;
}
