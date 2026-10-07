import type { RecordingDestinationProfile, RecordingDestinationRoute } from '../../shared/recordingDestinations';
import type { StorageMode } from '../../shared/recordingTypes';

/** What the start command needs from the "Save to" destinations owner. */
export type RecordingDestinationPort = {
  resolveForStart(
    profileId: string | undefined,
    requestedStorageMode: StorageMode,
  ): Promise<{ profile: RecordingDestinationProfile; requested?: RecordingDestinationProfile; available: boolean }>;
  remember(profileId: string): Promise<void>;
};

/** What recording lifecycle code needs from the integration routing owner. */
export type RecordingRoutingPort = {
  begin(recordingId: string, routes: readonly RecordingDestinationRoute[]): Promise<unknown>;
  forget(recordingId: string): Promise<void>;
};
