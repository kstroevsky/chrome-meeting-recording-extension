import {
  storageModeOfProfile,
  type RecordingDestinationRoute,
} from '../../shared/recordingDestinations';
import type { RecordingRunConfig } from '../../shared/recording';
import type { RecordingDestinationPort, RecordingRoutingPort } from './recordingRoutingPorts';

type Deps = {
  L: { warn: (...a: any[]) => void };
  destinations?: RecordingDestinationPort;
  routing?: RecordingRoutingPort;
};

/**
 * Resolves the "Save to" pick against the stored profiles and makes it
 * authoritative: the storage mode comes from the profile, never from the popup
 * alone. Returns the data routes to hold for this recording, which is none
 * when the profile is unknown or currently unavailable. Never throws: a broken
 * destination owner records without routing rather than failing Start.
 */
export async function applyStartDestination(
  runConfig: RecordingRunConfig,
  deps: Deps,
): Promise<RecordingDestinationRoute[]> {
  if (!deps.destinations) return [];
  try {
    const resolved = await deps.destinations.resolveForStart(runConfig.destinationProfileId, runConfig.storageMode);
    const profile = resolved.requested ?? resolved.profile;
    runConfig.storageMode = storageModeOfProfile(profile);
    runConfig.destinationProfileId = profile.id;
    return resolved.available ? [...profile.dataRoutes] : [];
  } catch (error) {
    deps.L.warn('Could not resolve the Save to destination; recording without routing:', error);
    return [];
  }
}

/**
 * Holds the routes until the end dialog confirms the save. A failure never
 * stops capture: the popup shows "automation could not be scheduled" from the
 * context's profile, with Retry (plan E5, E7).
 */
export async function beginStartRouting(
  recordingId: string,
  routes: readonly RecordingDestinationRoute[],
  deps: Deps,
): Promise<void> {
  if (!routes.length) return;
  await deps.routing?.begin(recordingId, routes)
    .catch((error) => deps.L.warn('Could not schedule recording routing:', error));
}

/** Remember + confirm: the pick preselects the next recording's Save to. */
export function rememberStartPick(runConfig: RecordingRunConfig, deps: Deps): void {
  if (!runConfig.destinationProfileId) return;
  void deps.destinations?.remember(runConfig.destinationProfileId)
    .catch((error) => deps.L.warn('Could not remember the Save to pick:', error));
}
