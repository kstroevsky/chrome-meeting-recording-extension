/**
 * @file background/commands/handleStopRecording.ts
 *
 * Handles the STOP_RECORDING popup command: guards against stopping when idle,
 * transitions session state, and delegates to the offscreen document via RPC.
 */

import { type CommandResult } from '../../shared/protocol';
import { isBusyPhase } from '../../shared/recording';
import type { MessageHandlersDeps } from '../messageHandlers';

const ok = (session: MessageHandlersDeps['session']): CommandResult =>
  ({ ok: true, session: session.getSnapshot() });
const fail = (error: string, session: MessageHandlersDeps['session']): CommandResult =>
  ({ ok: false, error, session: session.getSnapshot() });

/**
 * Guards against stopping when no recording is active, marks the session as
 * stopping, then fires the OFFSCREEN_STOP RPC.
 */
export async function handleStopRecording(
  { L, offscreen, session }: MessageHandlersDeps,
  sendResponse: (response: CommandResult) => void
): Promise<void> {
  if (!isBusyPhase(session.getSnapshot().phase)) {
    sendResponse(fail('Stop requested but no recording session is active', session));
    return;
  }
  session.markStopping();

  try {
    await offscreen.ensureReady();
    const r = await offscreen.rpc<{ ok: boolean; error?: string }>({ type: 'OFFSCREEN_STOP' });
    if (!r?.ok) {
      session.fail(r?.error || 'Stop failed in offscreen');
      sendResponse(fail(r?.error || 'Stop failed in offscreen', session));
      return;
    }
    sendResponse(ok(session));
  } catch (e: any) {
    session.fail(`STOP failed: ${e?.message || e}`);
    sendResponse(fail(`STOP failed: ${e?.message || e}`, session));
  }
}
