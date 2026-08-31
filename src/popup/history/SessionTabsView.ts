/**
 * @file popup/history/SessionTabsView.ts
 *
 * The popup's upload-view selection and per-job upload view (ADR-0004). A live
 * selection (config when idle / recording while capturing) and background Drive
 * uploads share one controller; the header progress control swaps the popup body
 * without mutating an upload. It owns that selection and its terminal fade timers,
 * keeping PopupController thin (mirrors PopupStateController's `(el, callbacks)`
 * shape).
 */

import { renderUploadJobPanel } from './uploadJobPanel';
import { sendToBackground } from '../../shared/messages';
import { createExternalTab } from '../../platform/chrome/tabs';
import type { PopupElements } from '../popupView';
import type {
  RecordingPhase,
  RecordingStatusView,
  UploadJob,
} from '../../shared/recording';

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
  /** Paints the selected job's panel; the panel itself is a pure renderer. */
  renderJobView(job: UploadJob): void {
    renderUploadJobPanel(this.el, job, this.callbacks.onJobRendered);
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
