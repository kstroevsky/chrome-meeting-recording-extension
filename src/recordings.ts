import { RecordingsController } from './recordings/RecordingsController';
import { RecordingsView } from './recordings/RecordingsView';
import { SharedView } from './recordings/SharedView';
import { initializeExtensionTheme } from './shared/theme';
import { sendToBackground } from './shared/messages';
import type { RecordingNotation } from './shared/notations';
import type { PopupListRecordingNotations, PopupRemoveRecordingNotation, PopupUpdateRecordingNotation } from './shared/protocol';
import { sharingServiceOrigin } from './sharing/config';

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
  let sharedView: SharedView | undefined;
  const serviceOrigin = sharingServiceOrigin();
  const sharingEnabled = Boolean(serviceOrigin);
  const view = new RecordingsView(list, empty, error, loadMore, {
    rename: (id, name) => void controller.rename(id, name),
    note: (id, note) => void controller.setNote(id, note),
    remove: (id) => void controller.remove(id),
    removeMany: (ids) => void controller.removeMany(ids),
    openLocal: (recordingId, fileId) => void controller.openLocal(recordingId, fileId),
    play: (recordingId) => void controller.play(recordingId),
    fileTo: (recordingId, presetId) => void controller.fileTo(recordingId, presetId),
    loadMore: () => void controller.loadMore(),
    ...(sharingEnabled ? {
      share: (recordingIds, options, report) => controller.share(recordingIds, options, report),
      shareSnapshot: () => controller.shareSnapshot(),
      revokeShare: (shareId) => controller.revokeShare(shareId),
      sharesChanged: () => { void sharedView?.refresh(); },
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
  controller = new RecordingsController(view, sharingEnabled ? { enabled: true } : undefined);

  const recordingsSurface = get('recordings-surface');
  const sharedSurface = get('shared-surface');
  const recordingsTab = get('recordings-tab');
  const sharedTab = get('shared-tab');
  const sharedList = get('shared-list');
  const sharedEmpty = get('shared-empty');
  const sharedError = get('shared-error');
  if (sharingEnabled && recordingsSurface && sharedSurface
    && recordingsTab instanceof HTMLButtonElement && sharedTab instanceof HTMLButtonElement
    && sharedList && sharedEmpty && sharedError) {
    sharedView = new SharedView(sharedList, sharedEmpty, sharedError, {
      load: () => controller.shareSnapshot(),
      revoke: (shareId) => controller.revokeShare(shareId),
      delete: (shareId) => controller.deleteShare(shareId),
    });
    sharedTab.hidden = false;
    const selectSurface = (shared: boolean) => {
      recordingsSurface.hidden = shared;
      sharedSurface.hidden = !shared;
      recordingsTab.classList.toggle('recordings-header__tab--active', !shared);
      sharedTab.classList.toggle('recordings-header__tab--active', shared);
      if (shared) void sharedView?.refresh();
    };
    recordingsTab.addEventListener('click', () => selectSurface(false));
    sharedTab.addEventListener('click', () => selectSurface(true));
    void sharedView.refresh();
  }
  void controller.init().catch((cause) => view.showError(cause instanceof Error ? cause.message : String(cause)));
}
