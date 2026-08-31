/**
 * @file popup/history/RecordingDetailView.ts
 *
 * The screen a recording is pushed to from the history list: a saved
 * recording's files, notes and Drive links, or an upload still in flight.
 *
 * It owns which recording is on screen (`target`) and every transition of it —
 * including the one that matters most, an upload finishing while its own detail
 * is open, where the progress view is replaced by the durable history row
 * without the user losing their place (ADR-0004).
 *
 * Protocol calls it makes itself; everything shared with the rest of the popup
 * (toasts, dialogs, the session store, where "back" goes) arrives as an action,
 * so this module can be driven without a controller.
 */

import { RecordingNotesDetail, type RecordingNotesDetailActions } from '../notes/RecordingNotesDetail';
import type { ConfirmDialog } from '../ConfirmDialog';
import type { RecordingNameDialog } from '../RecordingNameDialog';
import { renderUploadDetail } from './uploadDetailPanel';
import {
  DETAIL_DRIVE_ICON,
  DETAIL_LINK_ICON,
  DETAIL_OPEN_ICON,
  DETAIL_RENAME_ICON,
  recordingDetailDate,
  recordingDetailDuration,
} from './historyChrome';
import { createExternalTab, createRuntimeTab } from '../../platform/chrome/tabs';
import { sendToBackground } from '../../shared/messages';
import { isDevBuild } from '../../shared/build';
import { formatBytes } from '../../shared/format';
import type { UploadJob } from '../../shared/recording';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';

export type PopupDetailTarget =
  | { kind: 'recording'; entry: RecordingHistoryEntry }
  | { kind: 'upload'; job: UploadJob };

export type RecordingDetailActions = {
  /** Leaves the detail — the caller decides which screen it returns to. */
  back: () => void | Promise<void>;
  notify: (message: string) => void;
  /** Renames through the caller, which owns the session the response carries. */
  rename: (id: string, name: string) => Promise<RecordingHistoryEntry | undefined>;
  /** Notation reads for the saved recording; preview-aware in the gallery. */
  notes: () => RecordingNotesDetailActions;
  /** Ran after a delete lands, so the history count outside this screen agrees. */
  onRemoved: () => void;
};

export class RecordingDetailView {
  private current: PopupDetailTarget | null = null;

  constructor(
    private readonly actions: RecordingDetailActions,
    private readonly confirmDialog: ConfirmDialog,
    private readonly nameDialog: RecordingNameDialog,
  ) {}

  /** The recording on screen, or null when the detail is not showing. */
  get target(): PopupDetailTarget | null {
    return this.current;
  }

  wire(): void {
    this.wireMenu();
    document.getElementById('recording-detail-back')?.addEventListener('click', () => void this.actions.back());
    document.getElementById('recording-detail-copy')?.addEventListener('click', () => void this.copyDriveLink());
    document.getElementById('recording-detail-rename')?.addEventListener('click', () => void this.startRename());
    document.getElementById('recording-detail-delete')?.addEventListener('click', () => void this.remove());
    document.getElementById('recording-detail-diagnostics')?.addEventListener('click', () => void createRuntimeTab('debug.html'));
    document.getElementById('recording-detail-settings')?.addEventListener('click', () => void createRuntimeTab('settings.html'));
  }

  /** The menu disclosure, which a static preview can also run. */
  wireMenu(): void {
    const menuButton = document.getElementById('recording-detail-menu-button');
    const menu = document.getElementById('recording-detail-menu');
    const closeMenu = () => {
      if (menu) menu.hidden = true;
      menuButton?.setAttribute('aria-expanded', 'false');
    };

    menuButton?.addEventListener('click', () => {
      if (!menu) return;
      const opening = menu.hidden;
      menu.hidden = !opening;
      menuButton.setAttribute('aria-expanded', String(opening));
    });
    document.addEventListener('click', (event) => {
      if (menu && !menu.hidden && !menu.contains(event.target as Node) && !menuButton?.contains(event.target as Node)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });
  }

  closeMenu(): void {
    const menu = document.getElementById('recording-detail-menu');
    const button = document.getElementById('recording-detail-menu-button');
    if (menu) menu.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
  }

  /** Forgets the recording on screen without painting; the caller hides the view. */
  clear(): void {
    this.current = null;
    this.closeMenu();
  }

  show(target: PopupDetailTarget): boolean {
    const detail = document.getElementById('view-recording-detail');
    if (!detail) return false;
    this.current = target;
    this.closeMenu();
    detail.hidden = false;
    this.render();
    return true;
  }

  /**
   * Follows an upload that is still open on this screen. A job that has just
   * finished is swapped for its history row, so the screen becomes the saved
   * recording rather than a progress bar stuck at 100%.
   */
  syncUploadJob(job: UploadJob): void {
    if (this.current?.kind !== 'upload' || this.current.job.id !== job.id) return;
    if (job.status === 'completed' && job.historyId) {
      void this.promoteCompletedUpload(job);
      return;
    }
    this.current = { kind: 'upload', job };
    this.render();
  }

  render(): void {
    const target = this.current;
    const content = document.getElementById('recording-detail-content');
    if (!target || !content) return;
    content.replaceChildren();
    if (target.kind === 'recording') this.renderSaved(content, target.entry);
    else renderUploadDetail(content, target.job, (job, button) => void this.cancelUpload(job, button));

    const link = this.driveLink();
    const copy = document.getElementById('recording-detail-copy') as HTMLButtonElement | null;
    const rename = document.getElementById('recording-detail-rename') as HTMLButtonElement | null;
    const remove = document.getElementById('recording-detail-delete') as HTMLButtonElement | null;
    const diagnostics = document.getElementById('recording-detail-diagnostics') as HTMLButtonElement | null;
    if (copy) copy.disabled = !link;
    if (rename) rename.hidden = target.kind !== 'recording';
    if (remove) remove.hidden = target.kind !== 'recording';
    if (diagnostics) diagnostics.hidden = !isDevBuild();
  }

  private renderSaved(content: HTMLElement, entry: RecordingHistoryEntry): void {
    const titleRow = document.createElement('div');
    titleRow.className = 'recording-detail-title-row';
    const title = document.createElement('h2');
    title.id = 'recording-detail-title';
    title.className = 'recording-detail-title';
    title.textContent = entry.name;
    title.title = entry.name;
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'recording-detail-rename';
    rename.setAttribute('aria-label', 'Rename recording');
    rename.title = 'Rename';
    rename.innerHTML = DETAIL_RENAME_ICON;
    rename.addEventListener('click', () => void this.startRename());
    titleRow.append(title, rename);

    const meta = document.createElement('p');
    meta.className = 'recording-detail-meta';
    const totalBytes = entry.files.reduce((total, file) => total + (file.bytes ?? 0), 0);
    meta.textContent = `${recordingDetailDate(entry.createdAt)} · ${recordingDetailDuration(entry)} · ${entry.files.length} ${entry.files.length === 1 ? 'FILE' : 'FILES'} · ${totalBytes ? formatBytes(totalBytes) : '—'}`;

    const destination = document.createElement('p');
    destination.className = 'recording-detail-eyebrow';
    destination.textContent = entry.files.some((file) => file.destination === 'drive') ? 'IN GOOGLE DRIVE' : 'ON LOCAL DISK';
    const files = document.createElement('div');
    files.className = 'recording-detail-files';
    for (const file of entry.files) files.appendChild(this.renderFile(entry, file));
    content.append(titleRow, meta, destination, files);

    // Notes for this recording (d1). Loads on its own and stays hidden if the
    // recording has none, so an unnoted recording looks exactly as before.
    const notes = new RecordingNotesDetail(entry.id, entry.durationMs, this.actions.notes());
    content.appendChild(notes.element);
    void notes.load();

    const transcript = entry.files.find((file) => /\.(vtt|txt)$/i.test(file.filename));
    const transcriptButton = document.createElement('button');
    transcriptButton.type = 'button';
    transcriptButton.className = 'recording-detail-transcript';
    transcriptButton.innerHTML = '<span><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v6.4M5.3 6.2L8 8.9l2.7-2.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3.2 12.5h9.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>Transcript</span><span></span>';
    const transcriptMeta = transcriptButton.querySelector('span:last-child');
    if (transcriptMeta) {
      transcriptMeta.textContent = transcript
        ? `${transcript.filename.split('.').pop()?.toUpperCase() ?? 'TEXT'} · ${typeof transcript.bytes === 'number' ? formatBytes(transcript.bytes) : '—'}`
        : 'VTT · —';
    }
    transcriptButton.addEventListener('click', () => {
      if (transcript) void this.openFile(entry, transcript);
      else this.actions.notify('Transcript is not available for this recording.');
    });
    content.appendChild(transcriptButton);
    content.appendChild(this.renderFooter());
  }

  private renderFile(entry: RecordingHistoryEntry, file: RecordingHistoryEntry['files'][number]): HTMLElement {
    const row = document.createElement('div');
    row.className = 'recording-detail-file';
    const name = document.createElement('span');
    name.className = 'recording-detail-file-name';
    name.textContent = file.filename;
    name.title = file.filename;
    const actions = document.createElement('span');
    actions.className = 'recording-detail-file-actions';
    const size = document.createElement('span');
    size.className = 'recording-detail-file-size';
    size.textContent = typeof file.bytes === 'number' ? formatBytes(file.bytes) : '—';
    actions.appendChild(size);
    if ((file.destination === 'drive' && file.webViewLink) || (file.destination === 'local' && file.downloadId && file.status === 'available')) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'recording-detail-file-open';
      open.setAttribute('aria-label', `Open ${file.filename}`);
      open.innerHTML = DETAIL_OPEN_ICON;
      open.addEventListener('click', () => void this.openFile(entry, file));
      actions.appendChild(open);
    }
    row.append(name, actions);
    return row;
  }

  private renderFooter(): HTMLElement {
    const footer = document.createElement('footer');
    footer.className = 'recording-detail-footer';
    const link = this.driveLink();
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn recording-detail-open-drive';
    open.disabled = !link;
    open.innerHTML = DETAIL_DRIVE_ICON;
    open.append('Open in Google Drive');
    open.addEventListener('click', () => { if (link) void createExternalTab(link); });
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-secondary recording-detail-copy-link';
    copy.disabled = !link;
    copy.innerHTML = DETAIL_LINK_ICON;
    copy.append('Copy Drive link');
    copy.addEventListener('click', () => void this.copyDriveLink());
    footer.append(open, copy);
    return footer;
  }

  private driveLink(): string | undefined {
    if (this.current?.kind === 'upload') {
      return this.current.job.folderWebViewLink ?? this.current.job.files.find((file) => file.webViewLink)?.webViewLink;
    }
    return this.current?.entry.files.find((file) => file.destination === 'drive' && file.webViewLink)?.webViewLink;
  }

  /** Once the background finalizes a job, replace its progress view with durable history. */
  private async promoteCompletedUpload(job: UploadJob): Promise<void> {
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
      const entry = response.ok ? response.entries.find((candidate) => candidate.id === job.historyId) : undefined;
      if (entry && this.current?.kind === 'upload' && this.current.job.id === job.id) {
        this.current = { kind: 'recording', entry };
        this.render();
        return;
      }
    } catch {
      // The progress detail remains usable until history is available on the next refresh.
    }
    if (this.current?.kind === 'upload' && this.current.job.id === job.id) {
      this.current = { kind: 'upload', job };
      this.render();
    }
  }

  private async openFile(entry: RecordingHistoryEntry, file: RecordingHistoryEntry['files'][number]): Promise<void> {
    if (file.destination === 'drive' && file.webViewLink) {
      await createExternalTab(file.webViewLink);
      return;
    }
    if (file.destination === 'local' && file.downloadId && file.status === 'available') {
      const response = await sendToBackground({ type: 'OPEN_RECORDING_HISTORY_FILE', recordingId: entry.id, fileId: file.id });
      if (response.ok === false) this.actions.notify(response.error || 'Could not open the local file');
    }
  }

  private async copyDriveLink(): Promise<void> {
    const link = this.driveLink();
    if (!link) {
      this.actions.notify('No Google Drive link is available yet.');
      return;
    }
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
      else {
        const input = document.createElement('textarea');
        input.value = link;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      this.actions.notify('Google Drive link copied.');
    } catch {
      this.actions.notify('Could not copy the Google Drive link.');
    }
  }

  private async startRename(): Promise<void> {
    if (this.current?.kind !== 'recording') return;
    this.closeMenu();
    const target = this.current;
    await this.nameDialog.ask({
      title: 'Name this recording',
      message: target.entry.storageMode === 'drive'
        ? 'The recording folder and every uploaded media file will use this name.'
        : 'This changes the name shown in recording history.',
      initialValue: target.entry.name,
      saveLabel: 'Save name',
      cancelLabel: 'Cancel',
      onSave: async (name) => {
        if (name === target.entry.name) return;
        const entry = await this.actions.rename(target.entry.id, name);
        if (entry) this.current = { kind: 'recording', entry };
        this.render();
      },
    });
  }

  private async remove(): Promise<void> {
    const target = this.current;
    if (target?.kind !== 'recording' || this.confirmDialog.isOpen()) return;
    this.closeMenu();
    const confirmed = await this.confirmDialog.ask({
      title: 'Delete this recording?',
      message: 'This removes it from Recordings. Files already saved to Google Drive or your computer are not deleted.',
      confirmLabel: 'Delete recording',
      cancelLabel: 'Keep recording',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const response = await sendToBackground({ type: 'REMOVE_RECORDING_HISTORY', id: target.entry.id });
      if (response.ok === false || !response.removed) {
        this.actions.notify(response.ok === false ? response.error || 'Could not delete this recording' : 'Could not delete this recording');
        return;
      }
      await this.actions.back();
      this.actions.onRemoved();
    } catch {
      this.actions.notify('Could not delete this recording');
    }
  }

  private async cancelUpload(job: UploadJob, button: HTMLButtonElement): Promise<void> {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const response = await sendToBackground({ type: 'CANCEL_UPLOAD_JOB', jobId: job.id });
      if (response.ok === false) {
        button.disabled = false;
        this.actions.notify(response.error || 'This upload is no longer active');
        return;
      }
      this.actions.notify('Canceling upload — downloading locally…');
    } catch {
      button.disabled = false;
      this.actions.notify('Could not cancel this upload');
    }
  }
}
