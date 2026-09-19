import { createExternalTab } from '../platform/chrome/tabs';
import { loadExtensionSettingsFromStorage } from '../shared/settings';
import { sendToBackground } from '../shared/messages';
import { PlayerController } from './player/PlayerController';
import type { RecordingHistoryCursor, RecordingHistoryEntry } from '../shared/recordingHistory';
import { RecordingsView } from './RecordingsView';

export class RecordingsController {
  private player: PlayerController | null = null;
  private entries: RecordingHistoryEntry[] = [];
  private nextCursor: RecordingHistoryCursor | undefined;
  private loadingMore = false;
  constructor(private readonly view: RecordingsView) {}

  async init() { await Promise.all([this.refresh(), this.loadDestinations()]); }

  async rename(id: string, name: string) {
    try {
      const response = await sendToBackground({ type: 'RENAME_RECORDING_HISTORY', id, name });
      if (!response.ok) throw new Error(response.error);
      this.entries = response.entry
        ? this.entries.map((entry) => entry.id === id ? response.entry! : entry)
        : this.entries.filter((entry) => entry.id !== id);
      this.render();
    } catch (error) { this.view.showError(error instanceof Error ? error.message : String(error)); }
  }

  async setNote(id: string, note: string) {
    try {
      const response = await sendToBackground({ type: 'SET_RECORDING_HISTORY_NOTE', id, note });
      if (!response.ok) throw new Error(response.error);
      this.entries = response.entry
        ? this.entries.map((entry) => entry.id === id ? response.entry! : entry)
        : this.entries.filter((entry) => entry.id !== id);
      this.render();
    } catch (error) { this.view.showError(error instanceof Error ? error.message : String(error)); }
  }

  async remove(id: string) {
    if (!confirm('Remove this item from recording history? Its in-extension playback copy is deleted; your downloaded and Google Drive files are not.')) return;
    try {
      const response = await sendToBackground({ type: 'REMOVE_RECORDING_HISTORY', id });
      if (!response.ok) throw new Error(response.error);
      if (response.removed) this.entries = this.entries.filter((entry) => entry.id !== id);
      this.render();
    } catch (error) { this.view.showError(error instanceof Error ? error.message : String(error)); }
  }

  async removeMany(ids: string[]) {
    const uniqueIds = [...new Set(ids)].filter((id) => this.entries.some((entry) => entry.id === id));
    if (!uniqueIds.length) return;
    if (!confirm(`Remove ${uniqueIds.length} item${uniqueIds.length === 1 ? '' : 's'} from recording history? Their in-extension playback copies are deleted; your downloaded and Google Drive files are not.`)) return;
    try {
      for (const id of uniqueIds) {
        const response = await sendToBackground({ type: 'REMOVE_RECORDING_HISTORY', id });
        if (!response.ok) throw new Error(response.error);
        if (response.removed) this.entries = this.entries.filter((entry) => entry.id !== id);
      }
      this.render();
    } catch (error) { this.view.showError(error instanceof Error ? error.message : String(error)); }
  }

  async openLocal(recordingId: string, fileId: string) {
    try {
      const response = await sendToBackground({ type: 'OPEN_RECORDING_HISTORY_FILE', recordingId, fileId });
      if (!response.ok) throw new Error(response.error);
    } catch (error) { this.view.showError(error instanceof Error ? error.message : String(error)); }
  }

  /** How this page reaches a recording's media, shared by the player and the note editor. */
  readonly playback = {
    getManifest: async (id: string) => {
      const response = await sendToBackground({ type: 'GET_RECORDING_PLAYBACK_MANIFEST', recordingId: id });
      return response.ok ? response.manifest : undefined;
    },
    prepareDriveSource: async (id: string, fileId: string, refresh?: boolean) => {
      const response = await sendToBackground(refresh
        ? { type: 'REFRESH_RECORDING_PLAYBACK_SOURCE', recordingId: id, fileId }
        : { type: 'PREPARE_RECORDING_PLAYBACK_SOURCE', recordingId: id, fileId, source: 'drive' });
      return response.ok ? response.url : undefined;
    },
    warn: (...args: unknown[]) => console.warn('[recordings]', ...args),
  };

  /** A recording's persisted transcript (ADR-0007), for the player's rail and the note editor. */
  async transcript(id: string) {
    const response = await sendToBackground({ type: 'GET_RECORDING_TRANSCRIPT', recordingId: id });
    return response.ok ? response.transcript : undefined;
  }

  /** Notes were added or changed elsewhere on the page: the NOTES column catches up. */
  notesChanged(): void {
    void this.refreshNoteSummaries();
  }

  /**
   * Opens the playback modal. The player is a modal on this page rather than a
   * page of its own, so it shares this document's tab — which is what lets
   * background scope a Drive authorization to `sender.tab.id`.
   */
  async play(recordingId: string) {
    try {
      this.player?.close();
      const player = new PlayerController({
        ...this.playback,
        getTranscript: (id) => this.transcript(id),
        // f16: the way to the folder the video should have been in, and the way out of history.
        openFolder: (id) => {
          const folderId = this.entries.find((entry) => entry.id === id)?.driveFolderId;
          if (folderId) void createExternalTab(`https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`);
        },
        remove: (id) => {
          void this.view.askToRemove(id).then((removed) => { if (removed) player.close(); });
        },
        renameNotation: async (recordingId, id, text) => {
          const response = await sendToBackground({ type: 'UPDATE_RECORDING_NOTATION', recordingId, id, text });
          if (!response.ok) throw new Error(response.error || 'Could not rename the note');
          return response.notations;
        },
      });
      this.player = player;
      document.body.append(player.element);
      await player.open(recordingId);
    } catch (error) {
      this.view.showError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Moves the recording's Drive folder into a destination, then re-reads
   * history so the picker reflects what Drive actually did rather than what
   * was asked for.
   */
  async fileTo(recordingId: string, presetId: string | null) {
    try {
      const response = await sendToBackground({
        type: 'FILE_RECORDING_TO_DESTINATION', recordingId, presetId,
      });
      if (!response.ok) throw new Error(response.error);
    } catch (error) {
      this.view.showError(error instanceof Error ? error.message : String(error));
    } finally {
      await this.refresh();
    }
  }

  private async loadDestinations() {
    try {
      const settings = await loadExtensionSettingsFromStorage();
      this.view.setDestinations(settings.storage.driveFolderPresets);
    } catch {
      // A settings read failure just means no destinations to offer.
    }
  }

  private async refresh() {
    const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
    if (!response.ok) throw new Error(response.error);
    this.entries = response.entries;
    this.nextCursor = response.nextCursor;
    this.view.showError();
    this.render();
    void this.refreshNoteSummaries();
    void this.refreshTopicSummaries();
  }

  async loadMore() {
    if (!this.nextCursor || this.loadingMore) return;
    this.loadingMore = true;
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY', cursor: this.nextCursor });
      if (!response.ok) throw new Error(response.error);
      const known = new Set(this.entries.map((entry) => entry.id));
      this.entries.push(...response.entries.filter((entry) => !known.has(entry.id)));
      this.nextCursor = response.nextCursor;
      this.view.showError();
      this.render();
      void this.refreshNoteSummaries();
      void this.refreshTopicSummaries();
    } catch (error) {
      this.view.showError(error instanceof Error ? error.message : String(error));
    } finally {
      this.loadingMore = false;
    }
  }

  private render() {
    this.view.render(this.entries, this.nextCursor != null);
  }

  /**
   * Reads the notes digest for the loaded page in one message and repaints.
   * Fire-and-forget: the table is useful without it, so a failure leaves the
   * NOTES column empty rather than blocking the list.
   */
  private async refreshNoteSummaries(): Promise<void> {
    const recordingIds = this.entries.map((entry) => entry.id);
    if (!recordingIds.length) return;
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_NOTATION_SUMMARIES', recordingIds });
      if (!response.ok) return;
      this.view.setNoteSummaries(response.summaries);
      this.render();
    } catch {
      // Leave the column empty; the recordings themselves still list.
    }
  }

  /**
   * Reads the topics digest for the loaded page, exactly as the notes one is
   * read and for the same reason: it makes the table searchable by subject, and
   * a recording is still findable by name without it.
   */
  private async refreshTopicSummaries(): Promise<void> {
    const recordingIds = this.entries.map((entry) => entry.id);
    if (!recordingIds.length) return;
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_TOPIC_SUMMARIES', recordingIds });
      if (!response.ok) return;
      this.view.setTopicSummaries(response.summaries);
      this.render();
    } catch {
      // Same as notes: a missing digest costs search reach, not the list.
    }
  }
}
