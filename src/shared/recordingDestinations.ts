/**
 * @file shared/recordingDestinations.ts
 *
 * Recording destinations: the entries of the popup's "Save to" list.
 *
 * A destination profile says where a recording's media goes (`mediaTarget`)
 * and which external services receive its data (`dataRoutes`). The type is the
 * final one, so later phases add capabilities without migrating stored data;
 * what a profile may *contain today* is decided by the V1 normalizer below.
 *
 * Folder presets stay storage-level concepts: a profile references them by
 * their stable ID. Integration destinations live in the integration database
 * and are referenced by `IntegrationDestination.id`; nothing here can verify
 * that reference, so callers resolve availability at use time.
 */

import type { StorageMode } from './recordingTypes';

export type RecordingDestinationMediaTarget =
  | { kind: 'drive'; folderPresetId?: string }
  | { kind: 'local'; folderPresetId?: string }
  | { kind: 'external'; destinationId: string };

export type RecordingDestinationRoute = {
  destinationId: string;
  mode: 'auto' | 'review';
};

export type RecordingDestinationProfile = {
  id: string;
  name: string;
  mediaTarget: RecordingDestinationMediaTarget;
  dataRoutes: RecordingDestinationRoute[];
};

export const BUILTIN_DRIVE_PROFILE_ID = 'builtin:drive';
export const BUILTIN_LOCAL_PROFILE_ID = 'builtin:local';
export const MAX_RECORDING_DESTINATION_PROFILES = 20;
export const MAX_RECORDING_DESTINATION_NAME_LENGTH = 60;
const MAX_ID_LENGTH = 128;
/** Popup select values for user profiles; the built-ins keep `drive` / `local`. */
const PROFILE_VALUE_PREFIX = 'profile:';

/** Today's two storage modes, as the profiles every user already has. */
export function builtinRecordingDestinations(): RecordingDestinationProfile[] {
  return [
    { id: BUILTIN_DRIVE_PROFILE_ID, name: 'Google Drive', mediaTarget: { kind: 'drive' }, dataRoutes: [] },
    { id: BUILTIN_LOCAL_PROFILE_ID, name: 'Local downloads', mediaTarget: { kind: 'local' }, dataRoutes: [] },
  ];
}

export function isBuiltinRecordingDestinationId(id: string): boolean {
  return id === BUILTIN_DRIVE_PROFILE_ID || id === BUILTIN_LOCAL_PROFILE_ID;
}

/**
 * User profiles as stored in settings, restricted to the V1 shape: files in
 * Local downloads (optionally a local folder preset) and exactly one AUTO data
 * route. Anything else is dropped rather than repaired, so a profile never
 * routes data somewhere the user did not see when they created it.
 */
export function normalizeRecordingDestinationProfiles(value: unknown): RecordingDestinationProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const profiles: RecordingDestinationProfile[] = [];
  for (const candidate of value) {
    if (profiles.length >= MAX_RECORDING_DESTINATION_PROFILES) break;
    const profile = normalizeV1Profile(candidate);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

function normalizeV1Profile(value: unknown): RecordingDestinationProfile | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedText(value.id, MAX_ID_LENGTH);
  const name = boundedText(value.name, MAX_RECORDING_DESTINATION_NAME_LENGTH);
  if (!id || !name || isBuiltinRecordingDestinationId(id)) return undefined;
  const media = isRecord(value.mediaTarget) ? value.mediaTarget : undefined;
  if (!media || media.kind !== 'local') return undefined;
  const folderPresetId = media.folderPresetId == null ? undefined : boundedText(media.folderPresetId, MAX_ID_LENGTH);
  if (media.folderPresetId != null && !folderPresetId) return undefined;
  if (!Array.isArray(value.dataRoutes) || value.dataRoutes.length !== 1) return undefined;
  const route = value.dataRoutes[0];
  if (!isRecord(route) || route.mode !== 'auto') return undefined;
  const destinationId = boundedText(route.destinationId, MAX_ID_LENGTH);
  if (!destinationId) return undefined;
  return {
    id,
    name,
    mediaTarget: { kind: 'local', ...(folderPresetId ? { folderPresetId } : {}) },
    dataRoutes: [{ destinationId, mode: 'auto' }],
  };
}

export function storageModeOfProfile(profile: RecordingDestinationProfile): StorageMode {
  return profile.mediaTarget.kind === 'drive' ? 'drive' : 'local';
}

export function resolveRecordingDestination(
  id: string | undefined,
  userProfiles: readonly RecordingDestinationProfile[],
): RecordingDestinationProfile | undefined {
  if (!id) return undefined;
  return [...builtinRecordingDestinations(), ...userProfiles].find((profile) => profile.id === id);
}

/** The popup's native select value for a profile. */
export function saveToValueOf(profileId: string): string {
  if (profileId === BUILTIN_DRIVE_PROFILE_ID) return 'drive';
  if (profileId === BUILTIN_LOCAL_PROFILE_ID) return 'local';
  return `${PROFILE_VALUE_PREFIX}${profileId}`;
}

/**
 * Reads a popup select value back. User profiles are local media in V1, so the
 * popup can derive the storage mode without loading them; the background start
 * command re-derives it from the stored profile and never trusts this.
 */
export function parseSaveToValue(value: unknown): { storageMode: StorageMode; profileId: string } {
  if (value === 'local') return { storageMode: 'local', profileId: BUILTIN_LOCAL_PROFILE_ID };
  if (typeof value === 'string' && value.startsWith(PROFILE_VALUE_PREFIX)) {
    const profileId = boundedText(value.slice(PROFILE_VALUE_PREFIX.length), MAX_ID_LENGTH);
    if (profileId) return { storageMode: 'local', profileId };
  }
  return { storageMode: 'drive', profileId: BUILTIN_DRIVE_PROFILE_ID };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}
