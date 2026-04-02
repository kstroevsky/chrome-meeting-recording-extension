/**
 * @file shared/recordingFactories.ts
 *
 * Factory helpers that construct or derive recording domain objects.
 */

import { DEFAULT_RECORDING_RUN_CONFIG } from './recordingConstants';
import type { RecordingRunConfig } from './recordingTypes';
import { parseRunConfig } from './recordingNormalizers';

/** Returns a detached clone of the default run configuration. */
export function createDefaultRunConfig(): RecordingRunConfig {
  return { ...DEFAULT_RECORDING_RUN_CONFIG };
}

/** Returns a normalized run config or a cloned default when the input is invalid. */
export function getRunConfigOrDefault(value: unknown): RecordingRunConfig {
  return parseRunConfig(value) ?? createDefaultRunConfig();
}
