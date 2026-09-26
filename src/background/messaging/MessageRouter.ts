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
import { handleShareIdentityTokenMessage } from './sharingMessages';
import {
  handleDriveTokenMessage,
  handleSystemIngress,
  handleSystemPopupMessage,
} from './systemMessages';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

const includes = (types: readonly string[], type: string): boolean => types.includes(type);

type PopupRouteOwner = 'drive-token' | 'share-identity-token' | 'library' | 'playback' | 'recording' | 'system';

/** Compile-time ownership table: every recognized popup message must have one background route. */
export const POPUP_ROUTE_OWNERS = {
  START_RECORDING: 'recording',
  STOP_RECORDING: 'recording',
  DISCARD_RECORDING: 'recording',
  GET_RECORDING_STATUS: 'recording',
  GET_DRIVE_TOKEN: 'drive-token',
  GET_SHARE_IDENTITY_TOKEN: 'share-identity-token',
  PUBLISH_SHARE: 'system',
  LIST_SHARES: 'system',
  REVOKE_SHARE: 'system',
  DELETE_SHARE: 'system',
  SET_MIC_MUTED: 'recording',
  SET_CAMERA_MUTED: 'recording',
  SET_INPUT_DEVICE: 'recording',
  SET_PAUSED: 'recording',
  DISMISS_UPLOAD_JOB: 'recording',
  RETRY_UPLOAD_JOB: 'recording',
  CANCEL_UPLOAD_JOB: 'recording',
  SKIP_RECORDING_NAMING: 'recording',
  DISMISS_INTERRUPTION: 'recording',
  LIST_RECORDING_HISTORY: 'library',
  RENAME_RECORDING_HISTORY: 'library',
  SET_RECORDING_HISTORY_NOTE: 'library',
  REMOVE_RECORDING_HISTORY: 'library',
  SYNC_DRIVE_PLAN: 'library',
  SYNC_DRIVE_APPLY: 'library',
  OPEN_RECORDING_HISTORY_FILE: 'library',
  MARK_NOTATION: 'recording',
  END_NOTATION: 'recording',
  LIST_ACTIVE_NOTATIONS: 'library',
  UPDATE_ACTIVE_NOTATION: 'library',
  REMOVE_ACTIVE_NOTATION: 'library',
  LIST_RECORDING_NOTATIONS: 'library',
  GET_RECORDING_PLAYBACK_MANIFEST: 'playback',
  FILE_RECORDING_TO_DESTINATION: 'system',
  GET_STORAGE_USAGE: 'system',
  RENAME_DRIVE_ROOT_FOLDER: 'system',
  LIST_UNSAVED_RECORDINGS: 'system',
  RESOLVE_UNSAVED_RECORDING: 'system',
  LIST_PENDING_LOCAL_DELIVERIES: 'system',
  DELIVER_LOCAL_RECORDING: 'system',
  PREPARE_RECORDING_PLAYBACK_SOURCE: 'playback',
  REFRESH_RECORDING_PLAYBACK_SOURCE: 'playback',
  LIST_RECORDING_NOTATION_SUMMARIES: 'library',
  ADD_RECORDING_NOTATION: 'library',
  UPDATE_RECORDING_NOTATION: 'library',
  REMOVE_RECORDING_NOTATION: 'library',
  GET_RECORDING_TRANSCRIPT: 'library',
  LIST_RECORDING_TOPIC_SUMMARIES: 'library',
} satisfies Record<PopupToBg['type'], PopupRouteOwner>;

const SESSION_FAILURE_MESSAGE_TYPES = [
  'START_RECORDING',
  'STOP_RECORDING',
  'DISCARD_RECORDING',
  'SET_MIC_MUTED',
  'SET_CAMERA_MUTED',
  'SET_INPUT_DEVICE',
  'SET_PAUSED',
  'RETRY_UPLOAD_JOB',
  'CANCEL_UPLOAD_JOB',
] as const;

function isNonSessionResponse(type: string): boolean {
  return includes(NON_SESSION_RESPONSE_MESSAGE_TYPES, type);
}

function failsSessionOnError(type: string): boolean {
  return includes(SESSION_FAILURE_MESSAGE_TYPES, type);
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
  const owner = POPUP_ROUTE_OWNERS[msg.type];
  const handled = owner === 'library'
    ? await handleLibraryMessage(msg, sendResponse, deps)
    : owner === 'playback'
      ? await handlePlaybackMessage(msg, sender, sendResponse, deps)
      : owner === 'system'
        ? await handleSystemPopupMessage(msg, sendResponse, deps)
        : owner === 'recording'
          ? await handleRecordingMessage(msg, sendResponse, deps)
          : false;
  if (!handled) throw new Error(`Unhandled background message type: ${msg.type}`);
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
    const shareIdentityResult = handleShareIdentityTokenMessage(msg, sendResponse, deps);
    if (shareIdentityResult !== undefined) return shareIdentityResult;

    let readinessPassed = deps.waitUntilReady == null;
    void (async () => {
      await deps.waitUntilReady?.();
      readinessPassed = true;
      await routePopupMessage(msg, sender, sendResponse, deps);
    })().catch((error) => {
      console.error('[background] top-level error', error);
      const message = String(error);
      if (isNonSessionResponse(msg.type)) {
        sendResponse({ ok: false, error: message });
        return;
      }
      if (readinessPassed && failsSessionOnError(msg.type)) deps.session.fail(message);
      sendResponse({
        ok: false,
        error: message,
        session: toStatusView(deps.session.getSnapshot()),
      } satisfies CommandResult);
    });

    return true;
  };
}
