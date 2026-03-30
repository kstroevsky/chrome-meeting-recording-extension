/**
 * @file debug/DebugDashboard.ts
 *
 * Renders the diagnostics dashboard and keeps it synchronized with the
 * session-scoped perf snapshot written by background.
 */

import { isDevBuild } from '../shared/build';
import {
  buildCaptionsText,
  buildRecorderText,
  buildRuntimeText,
  buildSummaryText,
  buildUploadText,
  formatTimestamp,
} from './debugDashboardText';
import {
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  type PerfDebugSnapshot,
} from '../shared/perf';
import { EventTableRenderer } from './renderers/EventTableRenderer';
import { buildSystemInfoText } from './renderers/SystemInfoReader';

type Elements = {
  buildBadgeEl: HTMLElement | null;
  updatedAtEl: HTMLElement | null;
  summaryEl: HTMLElement | null;
  recorderEl: HTMLElement | null;
  uploadEl: HTMLElement | null;
  captionsEl: HTMLElement | null;
  runtimeEl: HTMLElement | null;
  systemEl: HTMLElement | null;
  eventsScrollEl: HTMLElement | null;
  eventsBodyEl: HTMLTableSectionElement | null;
  downloadBtn: HTMLButtonElement | null;
};

export class DebugDashboard {
  private snapshot: PerfDebugSnapshot | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debugPort: chrome.runtime.Port | null = null;
  private systemInfoText = 'Loading system info...';
  private readonly eventTable: EventTableRenderer;

  private readonly storageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== 'session') return;
    if (!changes?.[PERF_DEBUG_SNAPSHOT_STORAGE_KEY]) return;
    const next = changes[PERF_DEBUG_SNAPSHOT_STORAGE_KEY].newValue as PerfDebugSnapshot | undefined;
    this.renderSnapshot(next);
  };

  constructor(private readonly el: Elements) {
    this.eventTable = new EventTableRenderer(el.eventsBodyEl, el.eventsScrollEl);
  }

  init() {
    if (!isDevBuild()) {
      this.renderMessage('Diagnostics are available only in builds created with `npm run dev`.');
      if (this.el.buildBadgeEl) this.el.buildBadgeEl.textContent = 'Production build';
      if (this.el.downloadBtn) this.el.downloadBtn.disabled = true;
      return;
    }

    this.debugPort = chrome.runtime.connect({ name: 'debug-dashboard' });
    this.el.downloadBtn?.addEventListener('click', () => this.downloadSnapshot());
    chrome.storage?.onChanged?.addListener?.(this.storageListener);

    void buildSystemInfoText().then((text) => {
      this.systemInfoText = text;
      if (this.el.systemEl) this.el.systemEl.textContent = text;
    });

    void this.refreshSnapshot();
    this.pollTimer = setInterval(() => void this.refreshSnapshot(), 3_000);
  }

  destroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    chrome.storage?.onChanged?.removeListener?.(this.storageListener);
    try { this.debugPort?.disconnect(); } catch {}
    this.debugPort = null;
  }

  private async refreshSnapshot() {
    try {
      const res = await chrome.storage.session.get(PERF_DEBUG_SNAPSHOT_STORAGE_KEY);
      this.renderSnapshot(res?.[PERF_DEBUG_SNAPSHOT_STORAGE_KEY] as PerfDebugSnapshot | undefined);
    } catch {
      this.renderMessage('Diagnostics are temporarily unavailable.');
    }
  }

  private renderMessage(message: string) {
    if (this.el.summaryEl) this.el.summaryEl.textContent = message;
    if (this.el.recorderEl) this.el.recorderEl.textContent = '';
    if (this.el.uploadEl) this.el.uploadEl.textContent = '';
    if (this.el.captionsEl) this.el.captionsEl.textContent = '';
    if (this.el.runtimeEl) this.el.runtimeEl.textContent = '';
    if (this.el.systemEl) this.el.systemEl.textContent = this.systemInfoText;
    this.eventTable.reset();
  }

  private renderSnapshot(snapshot?: PerfDebugSnapshot) {
    const previousSnapshot = this.snapshot;
    this.snapshot = snapshot ?? null;

    if (this.el.buildBadgeEl) {
      this.el.buildBadgeEl.textContent = isDevBuild() ? 'Dev build' : 'Production build';
    }

    if (!snapshot?.enabled) {
      this.renderMessage('Waiting for diagnostics data...');
      if (this.el.updatedAtEl) this.el.updatedAtEl.textContent = 'No data yet';
      if (this.el.downloadBtn) this.el.downloadBtn.disabled = true;
      return;
    }

    if (this.el.updatedAtEl) {
      this.el.updatedAtEl.textContent = snapshot.updatedAt == null
        ? 'No updates yet'
        : `Last update: ${formatTimestamp(snapshot.updatedAt)}`;
    }
    if (this.el.downloadBtn) this.el.downloadBtn.disabled = false;

    if (this.el.summaryEl) this.el.summaryEl.textContent = buildSummaryText(snapshot);
    if (this.el.recorderEl) this.el.recorderEl.textContent = buildRecorderText(snapshot);
    if (this.el.uploadEl) this.el.uploadEl.textContent = buildUploadText(snapshot);
    if (this.el.captionsEl) this.el.captionsEl.textContent = buildCaptionsText(snapshot);
    if (this.el.runtimeEl) this.el.runtimeEl.textContent = buildRuntimeText(snapshot);
    if (this.el.systemEl) this.el.systemEl.textContent = this.systemInfoText;

    this.eventTable.update(snapshot.entries, previousSnapshot);
  }

  private downloadSnapshot() {
    if (!this.snapshot) return;
    const blob = new Blob([JSON.stringify(this.snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `extension-diagnostics-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
