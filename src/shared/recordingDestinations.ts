/**
 * @file shared/recordingDestinations.ts
 *
 * Recording destinations: the entries of the popup's "Save to" list.
 *
 * A destination profile says where a recording's media goes (`mediaTarget`)
 * and which external services receive its data (`dataRoutes`). The type is the
 * final one, so later phases add capabilities without migrating stored data.
 * M3 accepts local or Drive media plus several automatic data routes. M5 adds
 * an external primary-media target while keeping media ownership independent
 * from the profile's data routes. Review routing remains reserved for later.
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

/**
 * Immutable per-recording routing snapshot. `mediaOnly` is never stored in a
 * destination profile: it is synthesized when an external primary-media target
 * is distinct from every data route, so granting media ownership cannot also
 * grant data export.
 */
export type RecordingRoutingRoute = RecordingDestinationRoute & {
  mediaOnly?: true;
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
export const MAX_RECORDING_DESTINATION_ROUTES = 20;
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
 * User profiles as stored in settings. Existing V1 profiles remain valid, and
 * M3 additionally permits Drive media, folder-only profiles and several AUTO
 * data routes; M5 permits an external primary-media receiver. Anything else is
 * dropped rather than repaired, so malformed or duplicate routing never
 * broadens what a profile author explicitly selected.
 */
export function normalizeRecordingDestinationProfiles(value: unknown): RecordingDestinationProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const profiles: RecordingDestinationProfile[] = [];
  for (const candidate of value) {
    if (profiles.length >= MAX_RECORDING_DESTINATION_PROFILES) break;
    const profile = normalizeProfile(candidate);
    if (!profile || seen.has(profile.id)) continue;
    seen.add(profile.id);
    profiles.push(profile);
  }
  return profiles;
}

function normalizeProfile(value: unknown): RecordingDestinationProfile | undefined {
  if (!isRecord(value)) return undefined;
  const id = boundedText(value.id, MAX_ID_LENGTH);
  const name = boundedText(value.name, MAX_RECORDING_DESTINATION_NAME_LENGTH);
  if (!id || !name || isBuiltinRecordingDestinationId(id)) return undefined;
  const media = isRecord(value.mediaTarget) ? value.mediaTarget : undefined;
  if (!media || (media.kind !== 'local' && media.kind !== 'drive' && media.kind !== 'external')) return undefined;
  let mediaTarget: RecordingDestinationMediaTarget;
  if (media.kind === 'external') {
    const destinationId = boundedText(media.destinationId, MAX_ID_LENGTH);
    if (!destinationId || media.folderPresetId != null) return undefined;
    mediaTarget = { kind: 'external', destinationId };
  } else {
    const folderPresetId = media.folderPresetId == null ? undefined : boundedText(media.folderPresetId, MAX_ID_LENGTH);
    if (media.folderPresetId != null && !folderPresetId) return undefined;
    mediaTarget = { kind: media.kind, ...(folderPresetId ? { folderPresetId } : {}) };
  }
  const dataRoutes = normalizeAutomaticRoutes(value.dataRoutes);
  if (!dataRoutes) return undefined;
  return {
    id,
    name,
    mediaTarget,
    dataRoutes,
  };
}

/** Strict route snapshot normalizer shared by settings and recording context. */
export function normalizeAutomaticRecordingDestinationRoutes(value: unknown): RecordingDestinationRoute[] | undefined {
  return normalizeAutomaticRoutes(value);
}

/** Strict normalizer for the immutable Start routing snapshot. */
export function normalizeRecordingRoutingRoutes(value: unknown): RecordingRoutingRoute[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RECORDING_DESTINATION_ROUTES) return undefined;
  const seen = new Set<string>();
  const routes: RecordingRoutingRoute[] = [];
  for (const route of value) {
    if (!isRecord(route) || route.mode !== 'auto') return undefined;
    const destinationId = boundedText(route.destinationId, MAX_ID_LENGTH);
    if (!destinationId || seen.has(destinationId)) return undefined;
    if (route.mediaOnly != null && route.mediaOnly !== true) return undefined;
    seen.add(destinationId);
    routes.push({ destinationId, mode: 'auto', ...(route.mediaOnly === true ? { mediaOnly: true } : {}) });
  }
  return routes;
}

function normalizeAutomaticRoutes(value: unknown): RecordingDestinationRoute[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RECORDING_DESTINATION_ROUTES) return undefined;
  const seen = new Set<string>();
  const routes: RecordingDestinationRoute[] = [];
  for (const route of value) {
    if (!isRecord(route) || route.mode !== 'auto') return undefined;
    const destinationId = boundedText(route.destinationId, MAX_ID_LENGTH);
    if (!destinationId || seen.has(destinationId)) return undefined;
    seen.add(destinationId);
    routes.push({ destinationId, mode: 'auto' });
  }
  return routes;
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
 * Reads a popup select value back. For a user profile the rendered option
 * supplies its storage mode; the background start command still re-derives the
 * authoritative mode from the stored profile and never trusts this UI hint.
 */
export function parseSaveToValue(
  value: unknown,
  profileStorageMode?: StorageMode,
): { storageMode: StorageMode; profileId: string } {
  if (value === 'local') return { storageMode: 'local', profileId: BUILTIN_LOCAL_PROFILE_ID };
  if (typeof value === 'string' && value.startsWith(PROFILE_VALUE_PREFIX)) {
    const profileId = boundedText(value.slice(PROFILE_VALUE_PREFIX.length), MAX_ID_LENGTH);
    if (profileId) return { storageMode: profileStorageMode ?? 'local', profileId };
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
