/**
 * @file background/legacySession.ts
 *
 * Reconstructs in-session state persisted by pre-refactor versions of the
 * extension that stored `phase` and `activeRunConfig` as separate keys.
 */

import { parseRunConfig, type RecordingSessionSnapshot } from '../shared/recording';

export const LEGACY_SESSION_PHASE_KEY = 'phase';
export const LEGACY_SESSION_RUN_CONFIG_KEY = 'activeRunConfig';

const VALID_PHASES = ['starting', 'recording', 'stopping', 'uploading', 'failed', 'idle'] as const;
type ValidPhase = typeof VALID_PHASES[number];

function normalizeLegacyPhase(value: unknown): ValidPhase | null {
  if (typeof value !== 'string') return null;
  return (VALID_PHASES as readonly string[]).includes(value)
    ? (value as ValidPhase)
    : null;
}

/** Reads the old flat key format and converts it to the current session snapshot shape. */
export function hydrateLegacySession(
  value: Record<string, unknown> | undefined
): RecordingSessionSnapshot | undefined {
  const phase = normalizeLegacyPhase(value?.[LEGACY_SESSION_PHASE_KEY]);
  if (!phase) return undefined;

  return {
    phase,
    runConfig: phase === 'idle' ? null : parseRunConfig(value?.[LEGACY_SESSION_RUN_CONFIG_KEY]),
    updatedAt: Date.now(),
  };
}
