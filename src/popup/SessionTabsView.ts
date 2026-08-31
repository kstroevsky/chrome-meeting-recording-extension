/**
 * @file popup/SessionTabsView.ts
 *
 * The popup's upload-view selection and per-job upload view (ADR-0004). A live
 * selection (config when idle / recording while capturing) and background Drive
 * uploads share one controller; the header progress control swaps the popup body
 * without mutating an upload. It owns that selection and its terminal fade timers,
 * keeping PopupController thin (mirrors PopupStateController's `(el, callbacks)`
 * shape).
 */

import { sendToBackground } from '../shared/messages';
import { formatBytes } from '../shared/format';
import { createExternalTab } from '../platform/chrome/tabs';
import type { PopupElements } from './popupView';
import type {
  RecordingPhase,
  RecordingStatusView,
  RecordingStream,
  UploadJob,
  UploadJobFile,
} from '../shared/recording';

/** How long a completed upload tab lingers before it auto-fades out of the bar. */
const COMPLETED_TAB_LINGER_MS = 10_000;

/** Escapes a value for use in an attribute selector (CSS.escape with a safe fallback). */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

/** Label for the always-present live/end-anchor tab. When idle it's the "new recording"
 *  action; while a capture is active it reflects the phase. */
function liveTabLabel(phase: RecordingPhase): string {
  if (phase === 'recording' || phase === 'starting') return '● Recording';
  if (phase === 'stopping') return 'Finishing';
  return '＋ New';
}

/** Compact tab badge for an upload job: percent while uploading, a glyph once done. */
function uploadTabBadge(job: UploadJob): string {
  if (job.status === 'completed') return '✓';
  if (job.status === 'failed' || job.status === 'partial') return '!';
  if (job.status === 'canceled') return '×';
  return `${Math.round(Math.min(1, Math.max(0, job.progress)) * 100)}%`;
}

/** Headline status line for an upload job's view. */
function uploadJobStatusText(job: UploadJob): string {
  if (job.recoveryPending) {
    return job.status === 'partial'
      ? 'Partially uploaded — remaining files retry when the recorder starts'
      : 'Upload paused — retrying when the recorder starts';
  }
  if (job.files.some((file) => file.status === 'unavailable')) {
    return job.status === 'partial'
      ? 'Partially uploaded — some recovery sources are unavailable'
      : 'Upload failed — recovery source is unavailable';
  }
  switch (job.status) {
    case 'completed': return 'Recording saved';
    case 'partial': return 'Uploaded — some files saved locally';
    case 'failed': return 'Upload failed — saved locally';
    case 'canceled': return 'Upload canceled — saved locally';
    default: return 'Uploading to Google Drive…';
  }
}

/** Per-file outcome label inside an upload job's view. */
function uploadFileStatusText(file: UploadJobFile): string {
  if (file.status === 'uploaded') return 'Uploaded';
  if (file.status === 'fallback') return 'Saved locally';
  if (file.status === 'retry-pending') return 'Retry pending';
  if (file.status === 'unavailable') return file.error || 'Recovery source unavailable';
  return 'Uploading…';
}

function fileCountText(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'}`;
}

function driveFileUrl(file: UploadJobFile): string | undefined {
  if (file.webViewLink) return file.webViewLink;
  return file.driveFileId ? `https://drive.google.com/file/d/${encodeURIComponent(file.driveFileId)}/view` : undefined;
}

function svgPathForStream(stream: RecordingStream): string {
  if (stream === 'mic') {
    return 'M8 10a2 2 0 002-2V4a2 2 0 00-4 0v4a2 2 0 002 2zM4.5 8a.5.5 0 00-1 0 4.5 4.5 0 009 0 .5.5 0 00-1 0 3.5 3.5 0 01-7 0zM7.5 13.5v1.5h1v-1.5a.5.5 0 00-1 0z';
  }
  if (stream === 'self-video') {
    return 'M2 4.5A1.5 1.5 0 013.5 3h6A1.5 1.5 0 0111 4.5v1.2l3.2-1.8a.5.5 0 01.8.4v7.4a.5.5 0 01-.8.4L11 10.3v1.2A1.5 1.5 0 019.5 13h-6A1.5 1.5 0 012 11.5v-7z';
  }
  return 'M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v7A1.5 1.5 0 0112.5 12H9v1h2v1H5v-1h2v-1H3.5A1.5 1.5 0 012 10.5v-7z';
}

function buildStreamIcon(stream: RecordingStream): HTMLElement {
  const icon = document.createElement('span');
  icon.className = 'file-ico';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', svgPathForStream(stream));
  svg.appendChild(path);
  icon.appendChild(svg);
  return icon;
}

/** Hooks back into PopupController for cross-cutting concerns the tab bar can't own. */
export interface SessionTabsCallbacks {
  /** Re-render the popup body for the current phase/session (after a tab switch). */
  rerender: () => void;
  /** Apply an authoritative session pushed back by a command response. */
  applySession: (session: RecordingStatusView) => void;
  /** Show a transient status message on the popup status line. */
  toast: (message: string) => void;
  /** Fired after a job's panel is painted, so its notes can be mounted (n2). */
  onJobRendered?: (job: UploadJob) => void;
}

export class SessionTabsView {
  /** Selected view: 'live' (config/recording) or an upload job id. */
  private selectedTab = 'live';
  /** Pending auto-dismiss timers for completed upload tabs, keyed by job id. */
  private readonly fadeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly el: PopupElements,
    private readonly callbacks: SessionTabsCallbacks,
  ) {}

  /** Wires upload actions + roving-tabindex keyboard nav. Call once from init. */
  wireEvents(): void {
    this.el.uploadJobRetry?.addEventListener('click', () => void this.retryUploadJob());
    this.el.uploadJobCancel?.addEventListener('click', () => void this.cancelUploadJob());
    this.el.uploadJobOpenDrive?.addEventListener('click', () => void this.openUploadJobFolder());
    document.getElementById('upload-job-new-recording')?.addEventListener('click', () => this.openLive());
    this.wireKeyboard();
  }

  /** Reconciles a selected job, then updates any legacy test-only navigation fixture. */
  sync(phase: RecordingPhase, session?: RecordingStatusView): void {
    this.reconcileSelectedUpload(session);
    this.renderSessionTabs(phase, session);
  }

  /** The upload job for the selected tab, or null when the live tab is active. */
  activeJob(session?: RecordingStatusView): UploadJob | null {
    if (this.selectedTab === 'live') return null;
    return session?.uploadJobs?.find((j) => j.id === this.selectedTab) ?? null;
  }

  /** Selects a known tab programmatically (used by deterministic popup previews). */
  select(tab: 'live' | string): void {
    this.selectTab(tab);
  }
  
  /** Opens an upload from the header progress control without changing upload state. */
  openUpload(jobId: string): void {
    this.selectTab(jobId);
  }

  /** Returns from Saving to the live recording/setup view. */
  openLive(): void {
    this.selectTab('live');
  }

  /** Clears pending auto-dismiss timers (call from the controller's destroy). */
  dispose(): void {
    for (const timer of this.fadeTimers.values()) clearTimeout(timer);
    this.fadeTimers.clear();
  }

  /** Keeps a vanished/pruned upload from leaving the popup on an empty detail view. */
  private reconcileSelectedUpload(session?: RecordingStatusView): void {
    const jobs = session?.uploadJobs ?? [];
    if (this.selectedTab !== 'live' && !jobs.some((job) => job.id === this.selectedTab)) {
      this.selectedTab = 'live';
    }
  }

  /**
   * Rebuilds the tab bar from the live phase plus the background upload jobs. The
   * bar is hidden when there are no uploads (a single view needs no tabs), and a
   * selected job that has been dismissed/pruned falls back to the live tab.
   */
  private renderSessionTabs(phase: RecordingPhase, session?: RecordingStatusView): void {
    const tabsEl = this.el.sessionTabs;
    if (!tabsEl) return;
    const jobs = session?.uploadJobs ?? [];
    if (jobs.length === 0) {
      tabsEl.hidden = true;
      tabsEl.replaceChildren();
      return;
    }
    tabsEl.hidden = false;
    const frag = document.createDocumentFragment();
    // Upload tabs first, in creation order, then the live/end-anchor tab.
    for (const job of jobs) frag.appendChild(this.buildTab(job.id, job.label, job));
    const liveTab = this.buildTab('live', liveTabLabel(phase), null);
    // When idle the live tab is the "＋ New" action; give it the action styling.
    if (phase !== 'starting' && phase !== 'recording' && phase !== 'stopping') {
      liveTab.classList.add('session-tab--new');
    }
    frag.appendChild(liveTab);
    tabsEl.replaceChildren(frag);
    this.scheduleTerminalFade(jobs);
  }

  private buildTab(tab: string, label: string, job: UploadJob | null): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'session-tab';
    btn.setAttribute('role', 'tab');
    btn.dataset.tab = tab;
    const selected = this.selectedTab === tab;
    btn.setAttribute('aria-selected', String(selected));
    // Roving tabindex: only the selected tab is in the Tab order; arrow keys move
    // focus within the group (see wireKeyboard).
    btn.tabIndex = selected ? 0 : -1;
    if (job) btn.dataset.status = job.status;
    const labelEl = document.createElement('span');
    labelEl.className = 'session-tab-label';
    labelEl.textContent = label;
    btn.appendChild(labelEl);
    if (job) {
      const badge = document.createElement('span');
      badge.className = 'session-tab-pct';
      badge.textContent = uploadTabBadge(job);
      btn.appendChild(badge);
    }
    // A finished upload tab gets a browser-style "×" to clear it (keyboard: Delete on
    // the focused tab — see wireKeyboard). In-flight and live tabs have none.
    if (job && job.status !== 'uploading') {
      const close = document.createElement('span');
      close.className = 'session-tab-close';
      close.textContent = '×';
      close.title = 'Dismiss';
      close.addEventListener('click', (e) => {
        e.stopPropagation(); // don't also select the tab
        void this.dismissJob(job.id, this.selectedTab === job.id);
      });
      btn.appendChild(close);
    }
    btn.addEventListener('click', () => this.selectTab(tab));
    return btn;
  }

  /** Switches tabs and re-renders the body from the last known phase/session. */
  private selectTab(tab: string): void {
    if (this.selectedTab === tab) return;
    this.selectedTab = tab;
    this.callbacks.rerender();
  }

  /**
   * Roving-tabindex keyboard navigation for the tablist: Arrow keys (and Home/End)
   * move focus between tabs and activate them; Enter/Space activate via the native
   * button click; Delete/Backspace dismisses a focused finished upload tab. Wired once
   * — the container persists across `replaceChildren`.
   */
  private wireKeyboard(): void {
    const tabsEl = this.el.sessionTabs;
    if (!tabsEl) return;
    tabsEl.setAttribute('role', 'tablist');
    tabsEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const focused = (e.target as HTMLElement)?.closest<HTMLElement>('.session-tab');
        const id = focused?.dataset.tab;
        if (id && id !== 'live' && focused?.dataset.status && focused.dataset.status !== 'uploading') {
          e.preventDefault();
          void this.dismissJob(id, this.selectedTab === id);
        }
        return;
      }
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      const tabs = Array.from(tabsEl.querySelectorAll<HTMLButtonElement>('.session-tab'));
      if (tabs.length < 2) return;
      const current = Math.max(0, tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true'));
      const next =
        e.key === 'Home' ? 0
        : e.key === 'End' ? tabs.length - 1
        : e.key === 'ArrowRight' ? (current + 1) % tabs.length
        : (current - 1 + tabs.length) % tabs.length;
      e.preventDefault();
      const id = tabs[next].dataset.tab;
      if (id) {
        this.selectTab(id);
        // selectTab re-rendered the bar; move focus to the now-selected tab.
        tabsEl.querySelector<HTMLButtonElement>('.session-tab[aria-selected="true"]')?.focus();
      }
    });
  }

  /**
   * Auto-dismisses a *completed* upload tab a few seconds after it finishes, to keep
   * the bar uncluttered. Partial/failed jobs are left in place — they need the user's
   * attention — and the tab the user is currently viewing is never auto-cleared.
   */
  private scheduleTerminalFade(jobs: UploadJob[]): void {
    const ids = new Set(jobs.map((j) => j.id));
    for (const [id, timer] of this.fadeTimers) {
      if (!ids.has(id)) { clearTimeout(timer); this.fadeTimers.delete(id); }
    }
    for (const job of jobs) {
      const eligible = job.status === 'completed' && job.namingStatus !== 'pending' && this.selectedTab !== job.id;
      if (eligible && !this.fadeTimers.has(job.id)) {
        this.fadeTimers.set(job.id, setTimeout(() => this.fadeAndDismiss(job.id), COMPLETED_TAB_LINGER_MS));
      } else if (!eligible && this.fadeTimers.has(job.id)) {
        clearTimeout(this.fadeTimers.get(job.id)!);
        this.fadeTimers.delete(job.id);
      }
    }
  }

  private fadeAndDismiss(id: string): void {
    this.fadeTimers.delete(id);
    const tab = this.el.sessionTabs?.querySelector<HTMLElement>(`.session-tab[data-tab="${cssEscape(id)}"]`);
    if (tab) {
      tab.classList.add('session-tab--fading');
      setTimeout(() => void this.dismissJob(id, false), 280);
    } else {
      void this.dismissJob(id, false);
    }
  }

  /** Populates the upload view: a linear progress bar while uploading, a saved
   *  confirmation once complete, plus the per-file list. */
  renderJobView(job: UploadJob): void {
    const percent = Math.round(Math.min(1, Math.max(0, job.progress)) * 100);
    const completed = job.status === 'completed';
    const totalBytes = job.files.reduce((sum, f) => sum + (typeof f.bytes === 'number' ? f.bytes : 0), 0);
    const sizeSuffix = totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : '';

    // Toggle the in-progress bar vs. the saved-confirmation block.
    if (this.el.uploadProgress) this.el.uploadProgress.hidden = completed;
    if (this.el.uploadDone) this.el.uploadDone.hidden = !completed;

    // In-progress bar (the head text also carries failed/partial outcomes).
    if (this.el.uploadJobLabel) {
      this.el.uploadJobLabel.textContent = job.status === 'uploading'
        ? 'to Google Drive'
        : uploadJobStatusText(job);
    }
    if (this.el.uploadJobPct) this.el.uploadJobPct.textContent = `${percent}%`;
    if (this.el.uploadBarFill) this.el.uploadBarFill.style.width = `${percent}%`;
    if (this.el.uploadJobMeta) {
      this.el.uploadJobMeta.textContent = fileCountText(job.files.length);
    }

    // Saved-confirmation subline (shown in the done block).
    if (this.el.uploadJobSub) {
      this.el.uploadJobSub.textContent = `${fileCountText(job.files.length)}${sizeSuffix} · Google Drive`;
    }
    this.callbacks.onJobRendered?.(job);
    if (this.el.uploadJobFiles) {
      const frag = document.createDocumentFragment();
      for (const file of job.files) {
        const li = document.createElement('li');
        li.classList.add(`file-status-${file.status}`);
        li.appendChild(buildStreamIcon(file.stream));
        const main = document.createElement('div');
        main.className = 'file-main';
        const name = document.createElement('div');
        name.className = 'file-title';
        name.textContent = file.filename;
        const status = document.createElement('div');
        status.className = 'file-sub';
        if (file.status === 'uploaded' && completed) {
          status.textContent = typeof file.bytes === 'number' ? formatBytes(file.bytes) : 'DONE';
        } else if (file.status === 'uploaded') {
          status.textContent = `✓ DONE${typeof file.bytes === 'number' ? ` · ${formatBytes(file.bytes)}` : ''}`;
        } else if (typeof file.bytes === 'number') {
          status.textContent = `${formatBytes(Math.round(file.bytes * job.progress))} / ${formatBytes(file.bytes)}`;
        } else {
          status.textContent = uploadFileStatusText(file);
        }
        const head = document.createElement('div');
        head.className = 'file-head';
        head.append(name, status);
        main.append(head);
        if (job.status === 'uploading' || file.status === 'uploaded') {
          const progress = document.createElement('div');
          progress.className = 'file-progress';
          const fill = document.createElement('span');
          const fraction = file.status === 'uploaded' ? 1 : job.progress;
          fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
          progress.append(fill);
          main.append(progress);
        }
        const openUrl = driveFileUrl(file);
        if (openUrl && file.status === 'uploaded') {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'file-open';
          open.textContent = '↗';
          open.addEventListener('click', () => void createExternalTab(openUrl));
          head.appendChild(open);
        }
        li.appendChild(main);
        frag.appendChild(li);
      }
      this.el.uploadJobFiles.replaceChildren(frag);
    }
    // Retry is offered only for a job that ended with fallbacks.
    if (this.el.uploadJobRetry) {
      this.el.uploadJobRetry.hidden = job.recoveryPending
        || job.files.some((file) => file.status === 'unavailable')
        || !(job.status === 'failed' || job.status === 'partial');
      this.el.uploadJobRetry.dataset.jobId = job.id;
    }
    if (this.el.uploadJobCancel) {
      this.el.uploadJobCancel.hidden = job.status !== 'uploading';
      this.el.uploadJobCancel.disabled = false;
      this.el.uploadJobCancel.dataset.jobId = job.id;
    }
    if (this.el.uploadJobOpenDrive) {
      this.el.uploadJobOpenDrive.hidden = !(completed && job.folderWebViewLink);
      this.el.uploadJobOpenDrive.dataset.folderUrl = completed ? job.folderWebViewLink ?? '' : '';
    }
    const newRecording = document.getElementById('upload-job-new-recording') as HTMLButtonElement | null;
    // An upload is intentionally backgroundable: the user can immediately return
    // to Setup and start another recording without cancelling the current job.
    if (newRecording) newRecording.hidden = false;
    const transcript = document.getElementById('upload-job-transcript') as HTMLButtonElement | null;
    if (transcript) transcript.hidden = !completed;
  }

  private async openUploadJobFolder(): Promise<void> {
    const url = this.el.uploadJobOpenDrive?.dataset.folderUrl;
    if (!url) return;
    await createExternalTab(url);
  }

  /** Re-uploads the shown failed/partial job; the offscreen flips its tab to uploading. */
  private async retryUploadJob(): Promise<void> {
    const id = this.el.uploadJobRetry?.dataset.jobId;
    if (!id) return;
    try {
      const resp = await sendToBackground({ type: 'RETRY_UPLOAD_JOB', jobId: id });
      if (resp.ok === false) this.callbacks.toast(resp.error || 'This upload can no longer be retried');
      if (resp.session) this.callbacks.applySession(resp.session);
    } catch (e: unknown) {
      console.error('[popup] RETRY_UPLOAD_JOB error', e);
    }
  }

  private async cancelUploadJob(): Promise<void> {
    const btn = this.el.uploadJobCancel;
    const id = btn?.dataset.jobId;
    if (!btn || !id || btn.disabled) return;
    btn.disabled = true;
    try {
      const resp = await sendToBackground({ type: 'CANCEL_UPLOAD_JOB', jobId: id });
      if (resp.ok === false) {
        btn.disabled = false;
        this.callbacks.toast(resp.error || 'This upload is no longer active');
      } else {
        this.callbacks.toast('Canceling upload — downloading locally…');
      }
      // The command response can still contain the pre-cancel upload snapshot;
      // keep the button disabled until OFFSCREEN_UPLOAD_STATE reports `canceled`.
      if (resp.ok === false && resp.session) this.callbacks.applySession(resp.session);
    } catch (e: unknown) {
      btn.disabled = false;
      console.error('[popup] CANCEL_UPLOAD_JOB error', e);
    }
  }

  /**
   * Drops an upload job's tab: the background removes it and pushes a fresh view.
   * `leaveToLive` returns to Setup first (manual dismiss of the viewed job); an
   * auto-fade of an unviewed completed tab passes false so the current tab stays put.
   */
  private async dismissJob(id: string, leaveToLive: boolean): Promise<void> {
    if (leaveToLive) this.selectedTab = 'live'; // leave the tab before it disappears
    try {
      const resp = await sendToBackground({ type: 'DISMISS_UPLOAD_JOB', jobId: id });
      this.callbacks.applySession(resp.session);
    } catch (e: unknown) {
      console.error('[popup] DISMISS_UPLOAD_JOB error', e);
    }
  }
}
