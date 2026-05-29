/**
 * @file background/stopRecordingFlow.ts
 *
 * Shared stop orchestration for user-requested and automatic recording stops.
 */

import type { CommandResult } from '../shared/protocol';
import { type RecordingPhase, toStatusView } from '../shared/recording';
import type { OffscreenManager } from './OffscreenManager';
import type { RecordingSession } from './RecordingSession';

export type StopRecordingDeps = {
  L: { log: (...a: any[]) => void; warn: (...a: any[]) => void };
  offscreen: OffscreenManager;
  session: RecordingSession;
};

export function isStoppablePhase(phase: RecordingPhase): boolean {
  return phase === 'starting' || phase === 'recording' || phase === 'stopping';
}

const ok = (session: RecordingSession): CommandResult =>
  ({ ok: true, session: toStatusView(session.getSnapshot()) });

const fail = (error: string, session: RecordingSession): CommandResult =>
  ({ ok: false, error, session: toStatusView(session.getSnapshot()) });

/** Marks the session as stopping and delegates the stop request to offscreen. */
export async function stopRecordingFlow(
  { L, offscreen, session }: StopRecordingDeps,
  reason = 'user requested stop'
): Promise<CommandResult> {
  if (!isStoppablePhase(session.getSnapshot().phase)) {
    return fail('Stop requested but no recording session is active', session);
  }
  session.markStopping();
  L.log('Stopping recording:', reason);

  try {
    await offscreen.ensureReady();
    const r = await offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_STOP' });
    if (!r?.ok) {
      session.fail(r?.error || 'Stop failed in offscreen');
      return fail(r?.error || 'Stop failed in offscreen', session);
    }
    return ok(session);
  } catch (e: any) {
    session.fail(`STOP failed: ${e?.message || e}`);
    return fail(`STOP failed: ${e?.message || e}`, session);
  }
}
