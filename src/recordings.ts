import { RecordingsController } from './recordings/RecordingsController';
import { RecordingsView } from './recordings/RecordingsView';
import { initializeExtensionTheme } from './shared/theme';
import { sendToBackground } from './shared/messages';
import type { RecordingNotation } from './shared/notations';
import type { PopupListRecordingNotations, PopupRemoveRecordingNotation, PopupUpdateRecordingNotation } from './shared/protocol';

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
  const view = new RecordingsView(list, empty, error, loadMore, {
    rename: (id, name) => void controller.rename(id, name),
    note: (id, note) => void controller.setNote(id, note),
    remove: (id) => void controller.remove(id),
    removeMany: (ids) => void controller.removeMany(ids),
    openLocal: (recordingId, fileId) => void controller.openLocal(recordingId, fileId),
    play: (recordingId) => void controller.play(recordingId),
    fileTo: (recordingId, presetId) => void controller.fileTo(recordingId, presetId),
    loadMore: () => void controller.loadMore(),
    notes: {
      load: (recordingId) => readNotations({ type: 'LIST_RECORDING_NOTATIONS', recordingId }),
      rename: (recordingId, id, text) => readNotations({ type: 'UPDATE_RECORDING_NOTATION', recordingId, id, text }),
      remove: (recordingId, id) => readNotations({ type: 'REMOVE_RECORDING_NOTATION', recordingId, id }),
    },
  });
  controller = new RecordingsController(view);
  void controller.init().catch((cause) => view.showError(cause instanceof Error ? cause.message : String(cause)));
}
