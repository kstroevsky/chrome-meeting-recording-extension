/**
 * @file shared/recordingFactories.ts
 *
 * Factory helpers that construct or derive recording domain objects.
 */

import { DEFAULT_RECORDING_RUN_CONFIG } from './recordingConstants';
import type {
  RecordingRunConfig,
  RecordingSessionSnapshot,
  RecordingStatusView,
} from './recordingTypes';
import { parseRunConfig } from './recordingNormalizers';

/** Returns a detached clone of the default run configuration. */
export function createDefaultRunConfig(): RecordingRunConfig {
  return { ...DEFAULT_RECORDING_RUN_CONFIG };
}

/** Returns a normalized run config or a cloned default when the input is invalid. */
export function getRunConfigOrDefault(value: unknown): RecordingRunConfig {
  return parseRunConfig(value) ?? createDefaultRunConfig();
}

/**
 * Projects the background-owned session snapshot into the popup-facing view,
 * dropping the control-plane bookkeeping (`targetTabId`, `meetingSlug`) the
 * popup never renders. This is the single translator at the background→popup seam.
 */
export function toStatusView(snapshot: RecordingSessionSnapshot): RecordingStatusView {
  return {
    phase: snapshot.phase,
    runConfig: snapshot.runConfig,
    uploadSummary: snapshot.uploadSummary,
    error: snapshot.error,
    warnings: snapshot.warnings,
    micMuted: snapshot.micMuted,
    cameraMuted: snapshot.cameraMuted,
    updatedAt: snapshot.updatedAt,
  };
}
