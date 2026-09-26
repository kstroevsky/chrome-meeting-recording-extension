import type { PopupToBg } from '../../shared/protocol';
import { normalizeDriveSyncChoice } from '../../shared/driveSync';
import { toStatusView } from '../../shared/recording';
import { createRecordingFileDeletionPorts } from '../drive/recordingFileDeletionPorts';
import { deleteRecordingFiles } from '../library/history/RecordingFileDeletion';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

export async function handleLibraryMessage(
  msg: PopupToBg,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): Promise<boolean> {
  const { analyses, history, notations, session, transcripts } = deps;

  if (msg.type === 'LIST_RECORDING_HISTORY') {
    if (!history) throw new Error('Recording history is unavailable');
    sendResponse({ ok: true, ...(await history.listPage(msg.cursor)) });
    return true;
  }
  if (msg.type === 'RENAME_RECORDING_HISTORY') {
    if (!history) throw new Error('Recording history is unavailable');
    const entry = await history.rename(msg.id, msg.name);
    let snapshot = session.getSnapshot();
    const job = snapshot.uploadJobs?.find((candidate) => candidate.historyId === msg.id);
    if (entry && job) {
      snapshot = session.upsertUploadJob({
        ...job,
        label: entry.name,
        namingStatus: 'named',
        driveFolderId: entry.driveFolderId ?? job.driveFolderId,
        driveFolderName: entry.driveFolderName ?? job.driveFolderName,
        folderWebViewLink: entry.folderWebViewLink ?? job.folderWebViewLink,
        files: job.files.map((file) => {
          const renamed = entry.files.find((candidate) => candidate.stream === file.stream);
          return renamed ? { ...file, filename: renamed.filename } : file;
        }),
      });
      await session.flush();
    }
    sendResponse({ ok: true, entry, session: toStatusView(snapshot) });
    return true;
  }
  if (msg.type === 'SET_RECORDING_HISTORY_NOTE') {
    if (!history) throw new Error('Recording history is unavailable');
    sendResponse({ ok: true, entry: await history.setNote(msg.id, msg.note) });
    return true;
  }
  if (msg.type === 'REMOVE_RECORDING_HISTORY') {
    if (!history) throw new Error('Recording history is unavailable');
    if (!msg.deleteFiles) {
      sendResponse({ ok: true, removed: await history.remove(msg.id) });
      return true;
    }
    const entry = await history.get(msg.id);
    // The share goes first: it is served from these files. If it cannot be
    // ended, nothing is removed or deleted.
    const sharesEnded = entry && deps.sharing ? await deps.sharing.revokeSharesOf(msg.id) : 0;
    const removed = await history.remove(msg.id);
    const files = removed && entry
      ? await deleteRecordingFiles(entry, createRecordingFileDeletionPorts())
      : { deleted: 0, errors: [] };
    sendResponse({ ok: true, removed, filesDeleted: files.deleted, fileErrors: files.errors, sharesEnded });
    return true;
  }
  if (msg.type === 'SYNC_DRIVE_PLAN' || msg.type === 'SYNC_DRIVE_APPLY') {
    if (!deps.driveLibrary) throw new Error('Google Drive sync is unavailable');
    if (msg.type === 'SYNC_DRIVE_PLAN') sendResponse({ ok: true, plan: await deps.driveLibrary.sync.plan() });
    else sendResponse({ ok: true, result: await deps.driveLibrary.sync.apply(normalizeDriveSyncChoice(msg.choice)) });
    return true;
  }
  if (msg.type === 'OPEN_RECORDING_HISTORY_FILE') {
    if (!history) throw new Error('Recording history is unavailable');
    await history.openLocalFile(msg.recordingId, msg.fileId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'LIST_ACTIVE_NOTATIONS') {
    if (!notations) throw new Error('Recording notations are unavailable');
    const { historyId } = session.getSnapshot();
    sendResponse({
      ok: true,
      notations: historyId ? await notations.list(historyId) : [],
    });
    return true;
  }
  if (msg.type === 'LIST_RECORDING_NOTATION_SUMMARIES') {
    if (!notations) throw new Error('Recording notations are unavailable');
    sendResponse({ ok: true, summaries: await notations.summaries(msg.recordingIds) });
    return true;
  }
  if (msg.type === 'LIST_RECORDING_TOPIC_SUMMARIES') {
    sendResponse({
      ok: true,
      summaries: analyses ? await analyses.topicSummaries(msg.recordingIds) : {},
    });
    return true;
  }
  if (msg.type === 'UPDATE_ACTIVE_NOTATION' || msg.type === 'REMOVE_ACTIVE_NOTATION') {
    if (!notations) throw new Error('Recording notations are unavailable');
    const { historyId } = session.getSnapshot();
    if (!historyId) throw new Error('No recording is active');
    sendResponse({
      ok: true,
      notations: msg.type === 'UPDATE_ACTIVE_NOTATION'
        ? await notations.update(historyId, msg.id, { text: msg.text })
        : await notations.remove(historyId, msg.id),
    });
    return true;
  }
  if (msg.type === 'GET_RECORDING_TRANSCRIPT') {
    if (!transcripts) throw new Error('Recording transcripts are unavailable');
    const transcript = await transcripts.get(msg.recordingId);
    sendResponse({ ok: true, ...(transcript ? { transcript } : {}) });
    return true;
  }
  if (msg.type === 'LIST_RECORDING_NOTATIONS') {
    if (!notations) throw new Error('Recording notations are unavailable');
    sendResponse({ ok: true, notations: await notations.list(msg.recordingId) });
    return true;
  }
  if (msg.type === 'ADD_RECORDING_NOTATION') {
    if (!notations) throw new Error('Recording notations are unavailable');
    const notation = await notations.add(msg.recordingId, {
      tStartMs: msg.tStartMs,
      ...(msg.tEndMs != null ? { tEndMs: msg.tEndMs } : {}),
      text: msg.text,
    });
    sendResponse({ ok: true, notation });
    return true;
  }
  if (msg.type === 'UPDATE_RECORDING_NOTATION') {
    if (!notations) throw new Error('Recording notations are unavailable');
    sendResponse({
      ok: true,
      notations: await notations.update(msg.recordingId, msg.id, msg),
    });
    return true;
  }
  if (msg.type === 'REMOVE_RECORDING_NOTATION') {
    if (!notations) throw new Error('Recording notations are unavailable');
    sendResponse({
      ok: true,
      notations: await notations.remove(msg.recordingId, msg.id),
    });
    return true;
  }

  return false;
}
