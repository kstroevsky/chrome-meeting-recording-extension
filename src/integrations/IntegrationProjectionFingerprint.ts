import type { RecordingSnapshotEventData } from './contracts';
import { sha256Hex, stableJsonSerialize } from './serialization';

/** Hashes only destination-visible logical state, excluding event envelope identity/version fields. */
export async function integrationProjectionHash(serializedCloudEvent: string): Promise<string> {
  const parsed = JSON.parse(serializedCloudEvent) as { data?: Partial<RecordingSnapshotEventData> };
  if (!parsed.data?.readiness || !parsed.data.recording) {
    throw new Error('Integration snapshot is missing projection data');
  }
  return sha256Hex(stableJsonSerialize({
    readiness: parsed.data.readiness,
    recording: parsed.data.recording,
  }));
}
