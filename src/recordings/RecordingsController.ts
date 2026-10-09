import { createExternalTab } from '../platform/chrome/tabs';
import { loadExtensionSettingsFromStorage } from '../shared/settings';
import { sendToBackground } from '../shared/messages';
import { openDriveSyncDialog } from './DriveSyncDialog';
import { openRemovalProgress } from './RemovalProgressDialog';
import { PlayerController } from './player/PlayerController';
import { createPlaybackTrackResolver } from './player/playbackSource';
import type { PlayerStatus } from './player/PlayerView';
import type { PlaybackTrack } from '../shared/playback';
import type { ExternalMediaTransferStatus } from '../shared/protocol';
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
  /** The whole library's size; `entries` is only what has been paged in. */
  private total: number | undefined;
  private loadingMore = false;
  private externalMediaTransfers: ExternalMediaTransferStatus[] = [];
  private externalMediaPoll: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly view: RecordingsView,
    private readonly sharing?: RecordingsSharing,
  ) {}

  async init() {
    await Promise.all([this.refresh(), this.loadDestinations(), this.refreshExternalMediaTransfers()]);
  }

  async retryExternalMedia(destinationId: string, clientTransferId: string): Promise<void> {
    try {
      const response = await sendToBackground({
        type: 'RETRY_EXTERNAL_MEDIA_TRANSFER',
        destinationId,
        clientTransferId,
      });
      if (!response.ok) throw new Error(response.error);
      this.upsertExternalMediaTransfer(response.transfer);
      this.view.setExternalMediaTransfers(this.externalMediaTransfers);
    } catch (error) {
      this.view.showError(error instanceof Error ? error.message : String(error));
    } finally {
      await this.refreshExternalMediaTransfers();
    }
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

  /** Called once the page's dialog (and, for files, the native check) said yes. */
  async remove(id: string, deleteFiles = false) {
    try {
      const response = await sendToBackground({ type: 'REMOVE_RECORDING_HISTORY', id, ...(deleteFiles ? { deleteFiles } : {}) });
      if (!response.ok) throw new Error(response.error);
      if (response.removed) this.forget(id);
      this.render();
      this.reportFileErrors(response.fileErrors);
    } catch (error) { this.view.showError(error instanceof Error ? error.message : String(error)); }
  }

  /**
   * Removes the recordings one at a time, from this page, showing progress in
   * a dialog. A failure is reported and the run goes on; "Stop" ends it after
   * the recording in progress. Each row leaves the list as its removal lands.
   */
  async removeMany(ids: string[], deleteFiles = false) {
    const targets = [...new Set(ids)]
      .map((id) => this.entries.find((entry) => entry.id === id))
      .filter((entry): entry is RecordingHistoryEntry => entry != null);
    if (!targets.length) return;
    this.view.showError();
    const progress = openRemovalProgress(targets.length, deleteFiles);
    try {
      for (const [index, target] of targets.entries()) {
        if (progress.stopRequested) break;
        progress.start(target.name, index);
        try {
          const response = await sendToBackground({ type: 'REMOVE_RECORDING_HISTORY', id: target.id, ...(deleteFiles ? { deleteFiles } : {}) });
          if (!response.ok) throw new Error(response.error);
          // `removed: false` means it was already gone; either way it is out of the library.
          this.forget(target.id);
          progress.removed(target.name, response.fileErrors, response.filesDeleted);
        } catch (error) {
          progress.failed(target.name, error instanceof Error ? error.message : String(error));
        }
        this.render();
      }
    } finally {
      const summary = progress.finish();
      this.render();
      const problems = [
        summary.failed ? `${summary.failed} recording${summary.failed === 1 ? '' : 's'} could not be removed` : '',
        summary.fileErrors ? `${summary.fileErrors} file${summary.fileErrors === 1 ? '' : 's'} could not be deleted` : '',
      ].filter(Boolean);
      if (problems.length) this.view.showError(`${problems.join('; ')}.`);
    }
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
    prepareExternalSource: async (recordingId: string, fileId: string, destinationId: string, artifactId: string, _refresh?: boolean) => {
      const response = await sendToBackground({
        type: 'PREPARE_EXTERNAL_PLAYBACK_SOURCE', recordingId, fileId, destinationId, artifactId,
      });
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
        externalPlaybackStarted: async (recordingId, fileId, destinationId, artifactId) => {
          const response = await sendToBackground({
            type: 'REPORT_EXTERNAL_PLAYBACK_STARTED',
            recordingId,
            fileId,
            destinationId,
            artifactId,
          });
          if (!response.ok) throw new Error(response.error);
          await this.refresh();
        },
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

  private async refreshExternalMediaTransfers(): Promise<void> {
    if (this.externalMediaPoll) {
      clearTimeout(this.externalMediaPoll);
      this.externalMediaPoll = null;
    }
    try {
      const response = await sendToBackground({ type: 'LIST_EXTERNAL_MEDIA_TRANSFERS' });
      if (!response.ok) return;
      this.externalMediaTransfers = response.transfers;
      this.view.setExternalMediaTransfers(response.transfers);
    } catch {
      // Recording history stays usable when the offscreen media journal is unavailable.
    }
    if (this.externalMediaTransfers.some(pollsExternalMedia)) {
      this.externalMediaPoll = setTimeout(() => {
        this.externalMediaPoll = null;
        void this.refreshExternalMediaTransfers();
      }, 2_000);
    }
  }

  private upsertExternalMediaTransfer(next: ExternalMediaTransferStatus): void {
    const index = this.externalMediaTransfers.findIndex((transfer) =>
      transfer.destinationId === next.destinationId && transfer.clientTransferId === next.clientTransferId);
    if (index < 0) this.externalMediaTransfers.push(next);
    else this.externalMediaTransfers[index] = next;
  }

  private async refresh() {
    const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
    if (!response.ok) throw new Error(response.error);
    this.entries = response.entries;
    this.nextCursor = response.nextCursor;
    this.total = response.total;
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

  /** "Sync with Drive": the dialog previews and applies; the list is re-read after. */
  async syncDrive() {
    const result = await openDriveSyncDialog({
      plan: async () => {
        const response = await sendToBackground({ type: 'SYNC_DRIVE_PLAN' });
        if (!response.ok) throw new Error(response.error);
        return response.plan;
      },
      apply: async (choice) => {
        const response = await sendToBackground({ type: 'SYNC_DRIVE_APPLY', choice });
        if (!response.ok) throw new Error(response.error);
        return response.result;
      },
    });
    if (result) {
      try { await this.refresh(); } catch (error) { this.view.showError(error instanceof Error ? error.message : String(error)); }
    }
  }

  /** Removal succeeded; a file that could not be deleted is still said, not hidden. */
  private reportFileErrors(errors: string[] | undefined) {
    if (errors?.length) this.view.showError(`Removed, but ${errors.length} file${errors.length === 1 ? '' : 's'} could not be deleted — ${errors.join('; ')}`);
  }

  private forget(id: string) {
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.total != null) this.total = Math.max(0, this.total - 1);
  }

  private render() {
    this.view.render(this.entries, this.nextCursor != null, this.total);
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

function pollsExternalMedia(transfer: ExternalMediaTransferStatus): boolean {
  return transfer.state === 'pending' || transfer.state === 'queued' || transfer.state === 'uploading' ||
    transfer.state === 'verifying-capability' || transfer.state === 'retry-wait' ||
    transfer.state === 'ready-unacknowledged';
}
