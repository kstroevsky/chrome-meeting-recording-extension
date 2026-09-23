import { createExternalTab } from '../platform/chrome/tabs';
import { loadExtensionSettingsFromStorage } from '../shared/settings';
import { sendToBackground } from '../shared/messages';
import { PlayerController } from './player/PlayerController';
import { createPlaybackTrackResolver } from './player/playbackSource';
import type { PlayerStatus } from './player/PlayerView';
import type { PlaybackTrack } from '../shared/playback';
import type { RecordingHistoryCursor, RecordingHistoryEntry } from '../shared/recordingHistory';
import type { PublishRecordingOptions, PublishedRecordingInput } from '../sharing/PublishedManifestBuilder';
import type { ShareRuntimeSnapshot } from '../sharing/ShareRuntime';
import { RecordingsView } from './RecordingsView';
import type { QueuedShare, ShareProgressReporter } from './ShareDialog';

export type RecordingsSharing = {
  enabled: true;
};

export class RecordingsController {
  private player: PlayerController | null = null;
  private entries: RecordingHistoryEntry[] = [];
  private nextCursor: RecordingHistoryCursor | undefined;
  private loadingMore = false;
  constructor(
    private readonly view: RecordingsView,
    private readonly sharing?: RecordingsSharing,
  ) {}

  async init() {
    await Promise.all([this.refresh(), this.loadDestinations()]);
  }

  async share(
    recordingIds: readonly string[],
    options: PublishRecordingOptions,
    report: ShareProgressReporter = () => {},
  ): Promise<QueuedShare> {
    if (!this.sharing) throw new Error('Sharing is not configured for this build');
    const ids = [...new Set(recordingIds)].filter((id) => this.entries.some((entry) => entry.id === id));
    if (!ids.length) throw new Error('Select at least one recording to share');

    report(`Preparing ${ids.length} recording${ids.length === 1 ? '' : 's'}…`);
    const recordings: PublishedRecordingInput[] = await Promise.all(ids.map(async (recordingId) => {
      const manifest = await this.playback.getManifest(recordingId);
      if (!manifest) throw new Error(`Could not prepare “${this.entries.find((entry) => entry.id === recordingId)?.name ?? recordingId}” for sharing`);
      const transcript = options.includeTranscript ? await this.transcript(recordingId) : undefined;
      if (options.includeTranscript && manifest.transcriptStatus === 'ready' && !transcript) {
        throw new Error(`Could not load the transcript for “${manifest.title}”`);
      }
      return transcript ? { manifest, transcript } : { manifest };
    }));

    report('Starting publication…');
    const response = await sendToBackground({ type: 'PUBLISH_SHARE', recordings, options });
    if (!response.ok) throw new Error(response.error || 'Could not start sharing');
    report('Publication continues in the background.');
    return { shareId: response.shareId };
  }

  async revokeShare(shareId: string): Promise<void> {
    if (!this.sharing) throw new Error('Sharing is not configured for this build');
    const response = await sendToBackground({ type: 'REVOKE_SHARE', shareId });
    if (!response.ok) throw new Error(response.error || 'Could not revoke share');
  }

  async deleteShare(shareId: string): Promise<void> {
    if (!this.sharing) throw new Error('Sharing is not configured for this build');
    const response = await sendToBackground({ type: 'DELETE_SHARE', shareId });
    if (!response.ok) throw new Error(response.error || 'Could not delete published data');
  }

  async shareSnapshot(): Promise<ShareRuntimeSnapshot> {
    if (!this.sharing) throw new Error('Sharing is not configured for this build');
    const response = await sendToBackground({ type: 'LIST_SHARES' });
    if (!response.ok) throw new Error(response.error || 'Could not load shared recordings');
    return response.snapshot;
  }

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

  private unavailablePlaybackStatus(track: PlaybackTrack): PlayerStatus | undefined {
    if (!track.sources.some((source) => source.kind === 'drive')) return undefined;
    return {
      title: 'Could not open this recording from Google Drive.',
      body: 'It was deleted or moved, or Drive could not be reached. Notes and transcript are kept by the extension and are still available.',
      actions: ['folder', 'remove'],
    };
  }

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
        getManifest: this.playback.getManifest,
        resolveTrack: createPlaybackTrackResolver(this.playback),
        unavailableStatus: (track) => this.unavailablePlaybackStatus(track),
        warn: this.playback.warn,
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
