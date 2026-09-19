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
import { renderUploadDetail } from './uploadDetailPanel';
import {
  DETAIL_DRIVE_ICON,
  DETAIL_OPEN_ICON,
  recordingDetailDuration,
  recordingDetailWhen,
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

const CHECK_ICON = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.2l3 3L12.5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const CHEVRON_ICON = '<svg viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** A transcript is a file the recording carries, not one of its media tracks. */
const isTranscriptFile = (file: RecordingHistoryEntry['files'][number]): boolean => /\.(vtt|txt|srt)$/i.test(file.filename);

export class RecordingDetailView {
  private current: PopupDetailTarget | null = null;
  /** The saved recording whose files row is open, so a repaint keeps it open. */
  private filesOpenFor: string | null = null;
  /** The recording being renamed in the header (7H), and the draft name. */
  private renaming: { id: string; draft: string } | null = null;

  constructor(
    private readonly actions: RecordingDetailActions,
    private readonly confirmDialog: ConfirmDialog,
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
    this.renaming = null;
    this.filesOpenFor = null;
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
    if (this.renaming && (target.kind !== 'recording' || target.entry.id !== this.renaming.id)) this.renaming = null;
    this.renderHeading(target);
    if (target.kind === 'recording' && this.renaming) this.renderRenaming(content, target.entry);
    else if (target.kind === 'recording') this.renderSaved(content, target.entry);
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

  /**
   * The header names the recording (d1). While it is being renamed the name
   * becomes the field and a save button sits beside it (7H).
   */
  private renderHeading(target: PopupDetailTarget): void {
    const heading = document.getElementById('recording-detail-heading');
    const header = heading?.parentElement;
    if (!heading) return;
    heading.querySelectorAll('.recording-detail-title, .recording-detail-name-field, .recording-detail-save-name').forEach((node) => node.remove());
    header?.classList.toggle('renaming', Boolean(this.renaming));
    if (this.renaming && target.kind === 'recording') {
      const field = document.createElement('input');
      field.className = 'recording-detail-name-field';
      field.type = 'text';
      field.maxLength = 200;
      field.value = this.renaming.draft;
      field.setAttribute('aria-label', 'Recording name');
      field.addEventListener('input', () => { if (this.renaming) this.renaming.draft = field.value; });
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void this.commitRename(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancelRename(); }
      });
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'recording-detail-save-name';
      save.title = 'Save name';
      save.setAttribute('aria-label', 'Save name');
      save.innerHTML = CHECK_ICON;
      save.addEventListener('click', () => void this.commitRename());
      heading.append(field, save);
      requestAnimationFrame(() => { if (document.activeElement !== field) { field.focus(); field.select(); } });
      return;
    }
    const title = document.createElement('h2');
    title.id = 'recording-detail-title';
    title.className = 'recording-detail-title';
    title.textContent = target.kind === 'recording' ? target.entry.name : target.job.label;
    title.title = title.textContent;
    if (target.kind === 'recording') {
      title.tabIndex = 0;
      title.setAttribute('role', 'button');
      title.setAttribute('aria-label', `Rename ${target.entry.name}`);
      title.addEventListener('click', () => void this.startRename());
      title.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void this.startRename(); }
      });
    }
    heading.appendChild(title);
  }

  private renderSaved(content: HTMLElement, entry: RecordingHistoryEntry): void {
    content.append(this.summary(entry));

    // The notes are the content (d1): the timeline and the list, or — for a
    // recording nobody noted — the empty track and the shortcut that would have (f4).
    const notes = new RecordingNotesDetail(entry.id, entry.durationMs, this.actions.notes());
    content.appendChild(notes.element);
    void notes.load();

    content.append(...this.filesDisclosure(entry));
    content.appendChild(this.renderFooter());
  }

  /** `22:40 · 284 MB · TODAY 10:30` — length first, because the timeline is drawn against it. */
  private summary(entry: RecordingHistoryEntry): HTMLElement {
    const meta = document.createElement('p');
    meta.className = 'recording-detail-meta';
    const totalBytes = entry.files.reduce((total, file) => total + (file.bytes ?? 0), 0);
    meta.textContent = [
      recordingDetailDuration(entry),
      totalBytes ? formatBytes(totalBytes).toUpperCase() : '—',
      recordingDetailWhen(entry.createdAt),
    ].join(' · ');
    return meta;
  }

  /**
   * The files and the transcript fold into one row (d1), so the screen answers
   * what was noted before it answers what was stored. Opened, it lists them
   * with their sizes and a way to open each.
   */
  private filesDisclosure(entry: RecordingHistoryEntry): HTMLElement[] {
    const media = entry.files.filter((file) => !isTranscriptFile(file));
    const transcript = entry.files.find(isTranscriptFile);
    const open = this.filesOpenFor === entry.id;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'recording-detail-files-toggle';
    toggle.setAttribute('aria-expanded', String(open));
    const label = document.createElement('span');
    label.className = 'recording-detail-files-label';
    label.textContent = transcript ? 'Files and transcript' : 'Files';
    const right = document.createElement('span');
    right.className = 'recording-detail-files-meta';
    const count = document.createElement('span');
    count.textContent = transcript
      ? `${media.length} + ${transcript.filename.split('.').pop()?.toUpperCase() ?? 'TEXT'}`
      : String(media.length);
    right.append(count);
    right.insertAdjacentHTML('beforeend', CHEVRON_ICON);
    toggle.append(label, right);
    toggle.addEventListener('click', () => {
      this.filesOpenFor = this.filesOpenFor === entry.id ? null : entry.id;
      this.render();
    });
    if (!open) return [toggle];
    const list = document.createElement('div');
    list.className = 'recording-detail-files';
    for (const file of [...media, ...(transcript ? [transcript] : [])]) list.appendChild(this.renderFile(entry, file));
    return [toggle, list];
  }

  /** 7H: the name is edited in the header; the body says what else the name changes. */
  private renderRenaming(content: HTMLElement, entry: RecordingHistoryEntry): void {
    const meta = this.summary(entry);
    meta.classList.add('recording-detail-meta--renaming');
    const hint = document.createElement('p');
    hint.className = 'recording-detail-hint';
    hint.textContent = 'Enter saves · Esc keeps the old name';
    const rule = document.createElement('div');
    rule.className = 'recording-detail-rule';
    const head = document.createElement('div');
    head.className = 'recording-detail-files-head';
    const label = document.createElement('span');
    label.textContent = 'FILES';
    const count = document.createElement('span');
    count.className = 'recording-detail-files-count';
    count.textContent = String(entry.files.length);
    head.append(label, count);
    const list = document.createElement('div');
    list.className = 'recording-detail-files recording-detail-files--renaming';
    for (const file of entry.files) {
      const row = document.createElement('div');
      row.className = 'recording-detail-file';
      const name = document.createElement('span');
      name.className = 'recording-detail-file-name';
      name.textContent = file.filename;
      const size = document.createElement('span');
      size.className = 'recording-detail-file-size';
      size.textContent = typeof file.bytes === 'number' ? formatBytes(file.bytes) : '—';
      row.append(name, size);
      list.appendChild(row);
    }
    const note = document.createElement('p');
    note.className = 'recording-detail-hint';
    note.textContent = entry.storageMode === 'drive'
      ? 'File names follow the recording name.'
      : 'This changes the name shown in recording history.';
    content.append(meta, hint, rule, head, list, note);
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

  /** One action (d1): the Drive link is in the menu, where copying it belongs. */
  private renderFooter(): HTMLElement {
    const footer = document.createElement('footer');
    footer.className = 'recording-detail-footer';
    const link = this.driveLink();
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-ink recording-detail-open-drive';
    open.disabled = !link;
    open.innerHTML = DETAIL_DRIVE_ICON;
    open.append('Open in Google Drive');
    open.addEventListener('click', () => { if (link) void createExternalTab(link); });
    footer.append(open);
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

  /** The header rename (7H), for the menu, the title, and a preview. */
  beginRename(): void {
    void this.startRename();
  }

  private async startRename(): Promise<void> {
    if (this.current?.kind !== 'recording') return;
    this.closeMenu();
    this.renaming = { id: this.current.entry.id, draft: this.current.entry.name };
    this.render();
  }

  private cancelRename(): void {
    this.renaming = null;
    this.render();
  }

  private async commitRename(): Promise<void> {
    const target = this.current;
    const renaming = this.renaming;
    if (target?.kind !== 'recording' || !renaming) return;
    const name = renaming.draft.trim();
    this.renaming = null;
    if (!name || name === target.entry.name) {
      this.render();
      return;
    }
    const entry = await this.actions.rename(target.entry.id, name);
    if (entry && this.current?.kind === 'recording' && this.current.entry.id === entry.id) this.current = { kind: 'recording', entry };
    this.render();
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
