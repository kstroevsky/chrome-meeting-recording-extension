import { sendToBackground } from '../shared/messages';
import type { RecordingHistoryCursor, RecordingHistoryEntry } from '../shared/recordingHistory';
import { RecordingsView } from './RecordingsView';

export class RecordingsController {
  private entries: RecordingHistoryEntry[] = [];
  private nextCursor: RecordingHistoryCursor | undefined;
  private loadingMore = false;
  constructor(private readonly view: RecordingsView) {}

  async init() { await this.refresh(); }

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

  private async refresh() {
    const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
    if (!response.ok) throw new Error(response.error);
    this.entries = response.entries;
    this.nextCursor = response.nextCursor;
    this.view.showError();
    this.render();
    void this.refreshNoteSummaries();
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
}
