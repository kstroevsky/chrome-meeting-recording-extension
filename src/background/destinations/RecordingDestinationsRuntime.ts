import type { IntegrationDestination } from '../../integrations/persistence';
import {
  BUILTIN_DRIVE_PROFILE_ID,
  BUILTIN_LOCAL_PROFILE_ID,
  builtinRecordingDestinations,
  isBuiltinRecordingDestinationId,
  normalizeRecordingDestinationProfiles,
  resolveRecordingDestination,
  type RecordingDestinationProfile,
  type RecordingRoutingRoute,
} from '../../shared/recordingDestinations';
import type { StorageMode } from '../../shared/recordingTypes';
import type { ExtensionSettings } from '../../shared/settings';
import type { RecordingContext } from '../../shared/recordingContext';
import {
  describeRecordingDestination,
  filesLabelOf,
  type RecordingDestinationOption,
} from './RecordingDestinationPresentation';
import {
  normalizeSaveInput,
  type SaveRecordingDestinationInput,
} from './RecordingDestinationInput';

export type {
  RecordingDestinationOption,
  RecordingDestinationUnavailableReason,
} from './RecordingDestinationPresentation';

export type {
  GeneralSaveRecordingDestinationInput,
  LegacySaveRecordingDestinationInput,
  SaveRecordingDestinationInput,
} from './RecordingDestinationInput';

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
        .map((profile) => describeRecordingDestination(
          profile,
          settings,
          integrations,
          this.deps.containsHostPermission,
        )),
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
    const option = await describeRecordingDestination(
      requested,
      settings,
      await this.deps.listIntegrationDestinations(),
      this.deps.containsHostPermission,
    );
    return { profile: requested, requested, available: option.available };
  }

  /** The profile stored under an ID, built-ins included, without availability checks. */
  async find(profileId: string | undefined): Promise<RecordingDestinationProfile | undefined> {
    if (!profileId) return undefined;
    const settings = await this.deps.loadSettings();
    return resolveRecordingDestination(profileId, settings.storage.recordingDestinations);
  }

  /**
   * The data routes frozen when this recording started. Never falls back to the
   * live profile: doing so would let a later profile edit authorize a new
   * receiver for historical data.
   */
  async routesForRecording(recordingId: string): Promise<RecordingRoutingRoute[]> {
    const context = await this.deps.getRecordingContext?.(recordingId).catch(() => undefined);
    return context?.destinationRoutes?.map((route) => ({ ...route })) ?? [];
  }

  /**
   * The local folder preset the recording's destination files into. Undefined
   * for the download directory, a Drive destination, or a profile removed since.
   */
  async localFolderFor(recordingId: string): Promise<string | undefined> {
    const context = await this.deps.getRecordingContext?.(recordingId).catch(() => undefined);
    const target = context?.destinationMediaTarget
      ?? (await this.find(context?.destinationProfileId).catch(() => undefined))?.mediaTarget;
    return target?.kind === 'local' ? target.folderPresetId : undefined;
  }

  /** Resolves the frozen Drive preset to the folder name the offscreen uploader needs. */
  async driveFolderNameFor(recordingId: string): Promise<string | undefined> {
    const presetId = await this.driveFolderPresetFor(recordingId);
    if (!presetId) return undefined;
    const settings = await this.deps.loadSettings();
    return settings.storage.driveFolderPresets.find((preset) => preset.id === presetId)?.name;
  }

  /** Stable preset identity frozen in the recording context for history projection. */
  async driveFolderPresetFor(recordingId: string): Promise<string | undefined> {
    const context = await this.deps.getRecordingContext?.(recordingId).catch(() => undefined);
    const target = context?.destinationMediaTarget
      ?? (await this.find(context?.destinationProfileId).catch(() => undefined))?.mediaTarget;
    return target?.kind === 'drive' ? target.folderPresetId : undefined;
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
    if (normalizedInput.mediaTarget.kind === 'external') {
      const destinationId = normalizedInput.mediaTarget.destinationId;
      const destination = integrations.find((candidate) => candidate.id === destinationId);
      if (!destination) throw new Error('Primary media integration does not exist');
      if (!destination.media) throw new Error('Primary media integration does not support media');
    } else if (normalizedInput.mediaTarget.folderPresetId) {
      const folderPresetId = normalizedInput.mediaTarget.folderPresetId;
      const presets = normalizedInput.mediaTarget.kind === 'drive'
        ? settings.storage.driveFolderPresets
        : settings.storage.localFolderPresets;
      if (!presets.some((preset) => preset.id === folderPresetId)) {
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
      }, settings, integrations);
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
}
