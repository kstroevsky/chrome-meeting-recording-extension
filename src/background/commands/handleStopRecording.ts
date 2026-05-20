/**
 * @file background/commands/handleStopRecording.ts
 *
 * Handles the STOP_RECORDING popup command: guards against stopping when idle,
 * transitions session state, and delegates to the offscreen document via RPC.
 */

import { type CommandResult } from '../../shared/protocol';
import type { MessageHandlersDeps } from '../messageHandlers';
import { stopRecordingFlow } from '../stopRecordingFlow';

/**
 * Guards against stopping when no recording is active, marks the session as
 * stopping, then fires the OFFSCREEN_STOP RPC.
 */
export async function handleStopRecording(
  deps: MessageHandlersDeps,
  sendResponse: (response: CommandResult) => void
): Promise<void> {
  sendResponse(await stopRecordingFlow(deps, 'popup stop button'));
}
