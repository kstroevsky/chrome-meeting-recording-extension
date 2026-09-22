import { RecordingsController } from './recordings/RecordingsController';
import { RecordingsView } from './recordings/RecordingsView';
import { initializeExtensionTheme } from './shared/theme';
import { sendToBackground } from './shared/messages';
import type { RecordingNotation } from './shared/notations';
import type { PopupListRecordingNotations, PopupRemoveRecordingNotation, PopupUpdateRecordingNotation } from './shared/protocol';
import { fetchDriveTokenWithFallback } from './background/driveAuth';
import { fetchShareIdentityTokenWithFallback } from './background/shareIdentityAuth';
import { sharingServiceOrigin } from './sharing/config';
import { createShareRuntime } from './sharing/ShareRuntime';

/** One recording's notes, read or rewritten through the background's keyed commands. */
async function readNotations(
  message: PopupListRecordingNotations | PopupUpdateRecordingNotation | PopupRemoveRecordingNotation,
): Promise<RecordingNotation[]> {
  const response = await sendToBackground(message);
  if (!response.ok) throw new Error(response.error || 'Could not read the notes for this recording');
  return response.notations;
}

initializeExtensionTheme();

const get = (id: string) => document.getElementById(id);
const list = get('recordings-list');
const empty = get('recordings-empty');
const error = get('recordings-error');
const loadMore = get('recordings-load-more');
if (list && empty && error && loadMore instanceof HTMLButtonElement) {
  let controller: RecordingsController;
  const serviceOrigin = sharingServiceOrigin();
  const sharing = serviceOrigin ? createShareRuntime(serviceOrigin, {
    getDriveToken: async (options) => {
      const result = await fetchDriveTokenWithFallback(options);
      if (!result.ok) throw new Error(result.error);
      return result.token;
    },
    getIdentityToken: async (options) => {
      const result = await fetchShareIdentityTokenWithFallback(options);
      if (!result.ok) throw new Error(result.error);
      return result.token;
    },
  }) : undefined;
  const view = new RecordingsView(list, empty, error, loadMore, {
    rename: (id, name) => void controller.rename(id, name),
    note: (id, note) => void controller.setNote(id, note),
    remove: (id) => void controller.remove(id),
    removeMany: (ids) => void controller.removeMany(ids),
    openLocal: (recordingId, fileId) => void controller.openLocal(recordingId, fileId),
    play: (recordingId) => void controller.play(recordingId),
    fileTo: (recordingId, presetId) => void controller.fileTo(recordingId, presetId),
    loadMore: () => void controller.loadMore(),
    ...(sharing ? {
      share: (recordingIds, options, report) => controller.share(recordingIds, options, report),
      revokeShare: (shareId) => controller.revokeShare(shareId),
    } : {}),
    notes: {
      load: (recordingId) => readNotations({ type: 'LIST_RECORDING_NOTATIONS', recordingId }),
      rename: (recordingId, id, text) => readNotations({ type: 'UPDATE_RECORDING_NOTATION', recordingId, id, text }),
      remove: (recordingId, id) => readNotations({ type: 'REMOVE_RECORDING_NOTATION', recordingId, id }),
      // The add command answers with the one note it made; the editor wants the list.
      add: async (recordingId, note) => {
        const response = await sendToBackground({ type: 'ADD_RECORDING_NOTATION', recordingId, ...note });
        if (!response.ok) throw new Error(response.error || 'Could not add the note');
        return readNotations({ type: 'LIST_RECORDING_NOTATIONS', recordingId });
      },
      update: (recordingId, id, patch) => readNotations({ type: 'UPDATE_RECORDING_NOTATION', recordingId, id, ...patch }),
    },
    // Read lazily: the controller is made after the view.
    editor: {
      transcript: (recordingId) => controller.transcript(recordingId),
      playback: {
        getManifest: (recordingId) => controller.playback.getManifest(recordingId),
        prepareDriveSource: (recordingId, fileId, refresh) => controller.playback.prepareDriveSource(recordingId, fileId, refresh),
        warn: (...args) => controller.playback.warn(...args),
      },
      notesChanged: () => controller.notesChanged(),
    },
  });
  controller = new RecordingsController(view, sharing ? {
    publisher: sharing.publisher,
    publications: sharing.publications,
  } : undefined);
  void controller.init().catch((cause) => view.showError(cause instanceof Error ? cause.message : String(cause)));
}
