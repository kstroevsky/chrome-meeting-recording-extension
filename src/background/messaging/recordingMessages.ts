import {
  toStatusView,
} from '../../shared/recording';
import type { CommandResult, PopupToBg } from '../../shared/protocol';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

export async function handleRecordingMessage(
  msg: PopupToBg,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): Promise<boolean> {
  const { controller, session } = deps;
  const send = sendResponse as (result: CommandResult) => void;

  if (msg.type === 'MARK_NOTATION') {
    sendResponse(await controller.markNotation(msg.text));
    return true;
  }
  if (msg.type === 'END_NOTATION') {
    sendResponse(await controller.endNotation(msg.id));
    return true;
  }
  if (msg.type === 'START_RECORDING') {
    send(await controller.start(msg));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    send(await controller.stop('popup stop button'));
    return true;
  }
  if (msg.type === 'DISCARD_RECORDING') {
    send(await controller.discard('popup discard button'));
    return true;
  }
  if (msg.type === 'SET_MIC_MUTED') {
    send(await controller.setMicMuted(msg.muted));
    return true;
  }
  if (msg.type === 'SET_CAMERA_MUTED') {
    send(await controller.setCameraMuted(msg.muted));
    return true;
  }
  if (msg.type === 'SET_INPUT_DEVICE') {
    send(await controller.setInputDevice(msg.device, msg.deviceId));
    return true;
  }
  if (msg.type === 'SET_PAUSED') {
    send(await controller.setPaused(msg.paused));
    return true;
  }
  if (msg.type === 'DISMISS_INTERRUPTION') {
    sendResponse({ session: toStatusView(session.dismissInterruption()) });
    return true;
  }
  if (msg.type === 'GET_RECORDING_STATUS') {
    sendResponse({ session: toStatusView(session.getSnapshot()) });
    return true;
  }
  if (msg.type === 'DISMISS_UPLOAD_JOB') {
    sendResponse({ session: toStatusView(session.removeUploadJob(msg.jobId)) });
    return true;
  }
  if (msg.type === 'RETRY_UPLOAD_JOB') {
    send(await controller.retryUpload(msg.jobId));
    return true;
  }
  if (msg.type === 'CANCEL_UPLOAD_JOB') {
    send(await controller.cancelUpload(msg.jobId));
    return true;
  }
  if (msg.type === 'SKIP_RECORDING_NAMING') {
    const job = session.getSnapshot().uploadJobs?.find(
      (candidate) => candidate.id === msg.jobId,
    );
    if (!job || job.status !== 'completed') {
      send({
        ok: false,
        error: 'Completed upload was not found',
        session: toStatusView(session.getSnapshot()),
      });
      return true;
    }
    const snapshot = session.upsertUploadJob({ ...job, namingStatus: 'skipped' });
    await session.flush();
    send({ ok: true, session: toStatusView(snapshot) });
    return true;
  }

  return false;
}
