/**
 * @file shared/recordingProjection.ts
 *
 * Pure projection from the two owned recording-state inputs onto the single
 * displayed {@link RecordingPhase}. This is the heart of ADR-0003 Decision 4:
 * `phase` is not stored or written directly — it is *derived* from the
 * command-plane `desired` intent and the status-plane `observed` report. Because
 * each plane writes its own field and the phase is computed, the offscreen-status
 * path can no longer clobber the command path's view of "what's happening" (a
 * stale `observed` can at worst flip a derived `recording` back to `starting`
 * until the next report, never overwrite it permanently).
 *
 * Failure is a terminal, cross-cutting flag rather than an observed value: a
 * start can fail in the command path before any status exists, and the offscreen
 * can report a runtime failure — so it is passed separately and wins over both.
 */

import type { DesiredState, ObservedState, RecordingPhase } from './recordingTypes';

/**
 * Derives the displayed phase from desired intent, last observed status, and a
 * terminal failure flag. Total over all inputs:
 *
 *   failed                          → 'failed'    (terminal; wins over everything)
 *   want recording, observed recording → 'recording'
 *   want recording, not yet observed   → 'starting'  (intent ahead of observation)
 *   want idle, still capturing         → 'stopping'  (observation lagging the stop)
 *   want idle, observed uploading      → 'uploading'
 *   want idle, observed idle / none    → 'idle'
 */
export function projectPhase(desired: DesiredState, observed: ObservedState, failed: boolean): RecordingPhase {
  if (failed) return 'failed';

  if (desired === 'recording') {
    // Intent is to record; we are only truly `recording` once the offscreen
    // confirms it. Anything else means observation hasn't caught up yet.
    return observed === 'recording' ? 'recording' : 'starting';
  }

  // desired === 'idle': the recorder may still be draining a previous run.
  if (observed === 'starting' || observed === 'recording' || observed === 'stopping') {
    return 'stopping';
  }
  if (observed === 'uploading') return 'uploading';
  return 'idle';
}
