import type { IntegrationDestination } from '../../integrations/persistence';
import { normalizeWebhookEndpoint } from '../../integrations/webhook/WebhookEndpoint';
import {
  isBuiltinRecordingDestinationId,
  storageModeOfProfile,
  type RecordingDestinationProfile,
} from '../../shared/recordingDestinations';
import type { StorageMode } from '../../shared/recordingTypes';
import type { ExtensionSettings } from '../../shared/settings';

export type RecordingDestinationUnavailableReason =
  | 'destination-missing'
  | 'destination-disabled'
  | 'media-unavailable'
  | 'permission-missing';

/** One "Save to" entry as the popup and settings page show it. */
export type RecordingDestinationOption = {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  storageMode: StorageMode;
  filesLabel: string;
  dataRoutes: Array<{ destinationId: string; destinationName: string | null }>;
  available: boolean;
  unavailableReason?: RecordingDestinationUnavailableReason;
};

type PermissionReader = (pattern: string) => Promise<boolean>;

export async function describeRecordingDestination(
  profile: RecordingDestinationProfile,
  settings: ExtensionSettings,
  integrations: IntegrationDestination[],
  containsHostPermission: PermissionReader,
): Promise<RecordingDestinationOption> {
  const option: RecordingDestinationOption = {
    id: profile.id,
    name: profile.name,
    kind: isBuiltinRecordingDestinationId(profile.id) ? 'builtin' : 'custom',
    storageMode: storageModeOfProfile(profile),
    filesLabel: filesLabelOf(profile, settings, integrations),
    dataRoutes: profile.dataRoutes.map((route) => ({
      destinationId: route.destinationId,
      destinationName: integrations.find((destination) => destination.id === route.destinationId)?.name ?? null,
    })),
    available: true,
  };
  if (profile.mediaTarget.kind === 'external') {
    const destinationId = profile.mediaTarget.destinationId;
    const destination = integrations.find((candidate) => candidate.id === destinationId);
    const reason: RecordingDestinationUnavailableReason | undefined = !destination
      ? 'destination-missing'
      : !destination.enabled
        ? 'destination-disabled'
        : !destination.media
          ? 'media-unavailable'
          : await hasMediaPermission(destination, containsHostPermission) ? undefined : 'permission-missing';
    if (reason) return { ...option, available: false, unavailableReason: reason };
  }
  for (const route of profile.dataRoutes) {
    const destination = integrations.find((candidate) => candidate.id === route.destinationId);
    const reason: RecordingDestinationUnavailableReason | undefined = !destination
      ? 'destination-missing'
      : !destination.enabled
        ? 'destination-disabled'
        : await hasPermission(destination, containsHostPermission) ? undefined : 'permission-missing';
    if (reason) return { ...option, available: false, unavailableReason: reason };
  }
  return option;
}

export function filesLabelOf(
  profile: RecordingDestinationProfile,
  settings: ExtensionSettings,
  integrations: readonly IntegrationDestination[] = [],
): string {
  const target = profile.mediaTarget;
  if (target.kind === 'external') {
    return integrations.find((destination) => destination.id === target.destinationId)?.name ?? 'External service';
  }
  const base = target.kind === 'drive' ? 'Google Drive' : 'Local downloads';
  const presets = target.kind === 'drive' ? settings.storage.driveFolderPresets : settings.storage.localFolderPresets;
  const folder = target.folderPresetId
    ? presets.find((preset) => preset.id === target.folderPresetId)?.name
    : undefined;
  return folder ? `${base} / ${folder}` : base;
}

async function hasPermission(
  destination: IntegrationDestination,
  containsHostPermission: PermissionReader,
): Promise<boolean> {
  try {
    return await containsHostPermission(normalizeWebhookEndpoint(destination.endpoint).hostPermission);
  } catch {
    return false;
  }
}

async function hasMediaPermission(
  destination: IntegrationDestination,
  containsHostPermission: PermissionReader,
): Promise<boolean> {
  try {
    if (!destination.media || !await hasPermission(destination, containsHostPermission)) return false;
    for (const origin of destination.media.capability.upload.origins) {
      if (!await containsHostPermission(`${origin}/*`)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
