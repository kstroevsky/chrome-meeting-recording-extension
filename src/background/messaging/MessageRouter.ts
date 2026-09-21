import { isRecordingNotationMessage } from '../../shared/notations';
import {
  isPopupToBgMessage,
  type CommandResult,
  type PopupToBg,
} from '../../shared/protocol';
import {
  NON_SESSION_RESPONSE_MESSAGE_TYPES,
  RECORDING_HISTORY_MESSAGE_TYPES,
  RECORDING_NOTATION_MESSAGE_TYPES,
} from '../../shared/protocolMessageTypes';
import { toStatusView } from '../../shared/recording';
import { isRecordingHistoryMessage } from '../../shared/recordingHistory';
import { handleLibraryMessage } from './libraryMessages';
import { handlePlaybackMessage } from './playbackMessages';
import { handleRecordingMessage } from './recordingMessages';
import {
  handleDriveTokenMessage,
  handleSystemIngress,
  handleSystemPopupMessage,
} from './systemMessages';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

const includes = (types: readonly string[], type: string): boolean => types.includes(type);

function isNonSessionResponse(type: string): boolean {
  return includes(NON_SESSION_RESPONSE_MESSAGE_TYPES, type);
}

function validatePopupMessage(msg: PopupToBg): void {
  if (
    includes(RECORDING_HISTORY_MESSAGE_TYPES, msg.type)
    && !isRecordingHistoryMessage(msg)
  ) {
    throw new Error('Malformed recording history request');
  }
  if (
    includes(RECORDING_NOTATION_MESSAGE_TYPES, msg.type)
    && !isRecordingNotationMessage(msg)
  ) {
    throw new Error('Malformed recording notation request');
  }
}

async function routePopupMessage(
  msg: PopupToBg,
  sender: chrome.runtime.MessageSender,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): Promise<void> {
  validatePopupMessage(msg);
  if (await handleLibraryMessage(msg, sendResponse, deps)) return;
  if (await handlePlaybackMessage(msg, sender, sendResponse, deps)) return;
  if (await handleSystemPopupMessage(msg, sendResponse, deps)) return;
  await handleRecordingMessage(msg, sendResponse, deps);
}

export function createMessageListener(deps: MessageHandlersDeps) {
  return (
    msg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: RuntimeSendResponse,
  ): boolean => {
    const ingressResult = handleSystemIngress(msg, sender, sendResponse, deps);
    if (ingressResult !== undefined) return ingressResult;

    if (!isPopupToBgMessage(msg)) return false;

    const driveTokenResult = handleDriveTokenMessage(msg, sendResponse, deps);
    if (driveTokenResult !== undefined) return driveTokenResult;

    void routePopupMessage(msg, sender, sendResponse, deps).catch((error) => {
      console.error('[background] top-level error', error);
      const message = String(error);
      if (isNonSessionResponse(msg.type)) {
        sendResponse({ ok: false, error: message });
        return;
      }
      deps.session.fail(message);
      sendResponse({
        ok: false,
        error: message,
        session: toStatusView(deps.session.getSnapshot()),
      } satisfies CommandResult);
    });

    return true;
  };
}
