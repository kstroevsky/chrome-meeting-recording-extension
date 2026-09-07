import { RecordingsController } from './recordings/RecordingsController';
import { RecordingsView } from './recordings/RecordingsView';
import { initializeExtensionTheme } from './shared/theme';

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
  });
  controller = new RecordingsController(view);
  void controller.init().catch((cause) => view.showError(cause instanceof Error ? cause.message : String(cause)));
}
