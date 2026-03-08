/**
 * @file debug/DebugDashboard.ts
 *
 * Renders the diagnostics dashboard and keeps it synchronized with the
 * session-scoped perf snapshot written by background.
 */

import { isDevBuild, isTestRuntime } from '../shared/build';
import {
  buildCaptionsText,
  buildRecorderText,
  buildRuntimeText,
  buildSummaryText,
  buildUploadText,
  escapeHtml,
  formatEventFields,
  formatTimestamp,
} from './debugDashboardText';
import {
  PERF_DEBUG_SNAPSHOT_STORAGE_KEY,
  type PerfDebugSnapshot,
  type PerfEventEntry,
} from '../shared/perf';

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
  private renderedEventCount = 0;
  private readonly storageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== 'session') return;
    if (!changes?.[PERF_DEBUG_SNAPSHOT_STORAGE_KEY]) return;
    const next = changes[PERF_DEBUG_SNAPSHOT_STORAGE_KEY].newValue as PerfDebugSnapshot | undefined;
    this.renderSnapshot(next);
  };

  constructor(private readonly el: Elements) {}

  init() {
    if (!isDevBuild()) {
      this.renderUnavailable();
      return;
    }

    this.debugPort = chrome.runtime.connect({ name: 'debug-dashboard' });
    this.el.downloadBtn?.addEventListener('click', () => this.downloadSnapshot());
    chrome.storage?.onChanged?.addListener?.(this.storageListener);
    void this.loadSystemInfo();
    void this.refreshSnapshot();
    this.pollTimer = setInterval(() => {
      void this.refreshSnapshot();
    }, 3_000);
  }

  destroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    chrome.storage?.onChanged?.removeListener?.(this.storageListener);
    try {
      this.debugPort?.disconnect();
    } catch {}
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

  private renderUnavailable() {
    this.renderMessage('Diagnostics are available only in builds created with `npm run dev`.');
    if (this.el.buildBadgeEl) this.el.buildBadgeEl.textContent = 'Production build';
    if (this.el.downloadBtn) this.el.downloadBtn.disabled = true;
  }

  private renderMessage(message: string) {
    if (this.el.summaryEl) this.el.summaryEl.textContent = message;
    if (this.el.recorderEl) this.el.recorderEl.textContent = '';
    if (this.el.uploadEl) this.el.uploadEl.textContent = '';
    if (this.el.captionsEl) this.el.captionsEl.textContent = '';
    if (this.el.runtimeEl) this.el.runtimeEl.textContent = '';
    if (this.el.systemEl) this.el.systemEl.textContent = this.systemInfoText;
    this.resetEvents();
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

    if (this.el.summaryEl) {
      this.el.summaryEl.textContent = buildSummaryText(snapshot);
    }

    if (this.el.recorderEl) {
      this.el.recorderEl.textContent = buildRecorderText(snapshot);
    }

    if (this.el.uploadEl) {
      this.el.uploadEl.textContent = buildUploadText(snapshot);
    }

    if (this.el.captionsEl) {
      this.el.captionsEl.textContent = buildCaptionsText(snapshot);
    }

    if (this.el.runtimeEl) {
      this.el.runtimeEl.textContent = buildRuntimeText(snapshot);
    }

    if (this.el.systemEl) {
      this.el.systemEl.textContent = this.systemInfoText;
    }

    this.renderEvents(snapshot.entries, previousSnapshot);
  }

  private renderEvents(entries: PerfEventEntry[], previousSnapshot: PerfDebugSnapshot | null) {
    if (!this.el.eventsBodyEl) return;

    const shouldReset = previousSnapshot == null
      || entries.length < this.renderedEventCount
      || !this.sameEntryPrefix(entries, previousSnapshot.entries, this.renderedEventCount);

    if (shouldReset) {
      this.resetEvents();
    }

    if (entries.length === this.renderedEventCount) return;

    const wasNearBottom = this.isNearBottom();
    const fragment = document.createDocumentFragment();
    for (const entry of entries.slice(this.renderedEventCount)) {
      fragment.appendChild(this.createEventRow(entry));
    }

    this.el.eventsBodyEl.appendChild(fragment);
    this.renderedEventCount = entries.length;

    if (wasNearBottom || shouldReset) {
      this.scrollEventsToBottom();
    }
  }

  private sameEntryPrefix(
    nextEntries: PerfEventEntry[],
    previousEntries: PerfEventEntry[],
    count: number
  ): boolean {
    for (let i = 0; i < count; i += 1) {
      const next = nextEntries[i];
      const previous = previousEntries[i];
      if (
        !next
        || !previous
        || next.ts !== previous.ts
        || next.source !== previous.source
        || next.scope !== previous.scope
        || next.event !== previous.event
      ) {
        return false;
      }
    }
    return true;
  }

  private createEventRow(entry: PerfEventEntry): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.innerHTML = [
      `<td>${escapeHtml(formatTimestamp(entry.ts))}</td>`,
      `<td>${escapeHtml(entry.source)}</td>`,
      `<td>${escapeHtml(entry.scope)}</td>`,
      `<td>${escapeHtml(entry.event)}</td>`,
      `<td>${escapeHtml(formatEventFields(entry))}</td>`,
    ].join('');
    return row;
  }

  private resetEvents() {
    this.renderedEventCount = 0;
    if (this.el.eventsBodyEl) {
      this.el.eventsBodyEl.innerHTML = '';
    }
    if (this.el.eventsScrollEl) {
      this.el.eventsScrollEl.scrollTop = 0;
    }
  }

  private isNearBottom(): boolean {
    const container = this.el.eventsScrollEl;
    if (!container) return true;
    return (container.scrollHeight - container.scrollTop - container.clientHeight) <= 24;
  }

  private scrollEventsToBottom() {
    const container = this.el.eventsScrollEl;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
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

  private async loadSystemInfo() {
    const lines = [
      'True system CPU/GPU utilization is not exposed by Chrome extension APIs.',
      'CPU pressure in this dashboard is approximated with event-loop lag and long-task counts.',
      `Hardware threads: ${typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : 'n/a'}`,
      `Device memory: ${typeof (navigator as Navigator & { deviceMemory?: number }).deviceMemory === 'number' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory + ' GB' : 'n/a'}`,
    ];

    const webGlInfo = this.readWebGlInfo();
    lines.push(`WebGL vendor: ${webGlInfo.vendor ?? 'n/a'}`);
    lines.push(`WebGL renderer: ${webGlInfo.renderer ?? 'n/a'}`);

    const webGpuInfo = await this.readWebGpuInfo();
    if (webGpuInfo) {
      lines.push(`WebGPU adapter: ${webGpuInfo}`);
    } else {
      lines.push('WebGPU adapter: unavailable');
    }

    this.systemInfoText = lines.join('\n');
    if (this.el.systemEl) this.el.systemEl.textContent = this.systemInfoText;
  }

  private readWebGlInfo(): { vendor: string | null; renderer: string | null } {
    if (isTestRuntime()) return { vendor: null, renderer: null };
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return { vendor: null, renderer: null };

      const webgl = gl as WebGLRenderingContext;
      const debugExt = webgl.getExtension('WEBGL_debug_renderer_info') as {
        UNMASKED_VENDOR_WEBGL: number;
        UNMASKED_RENDERER_WEBGL: number;
      } | null;

      if (debugExt) {
        return {
          vendor: String(webgl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) ?? ''),
          renderer: String(webgl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) ?? ''),
        };
      }

      return {
        vendor: null,
        renderer: String(webgl.getParameter(webgl.RENDERER) ?? ''),
      };
    } catch {
      return { vendor: null, renderer: null };
    }
  }

  private async readWebGpuInfo(): Promise<string | null> {
    try {
      const gpu = (navigator as Navigator & { gpu?: any }).gpu;
      if (!gpu?.requestAdapter) return null;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;

      const info = await adapter.requestAdapterInfo?.().catch?.(() => null);
      if (info) {
        const parts = [
          info.vendor,
          info.architecture,
          info.device,
          info.description,
        ].filter(Boolean);
        if (parts.length) return parts.join(' / ');
      }

      return adapter.name ?? null;
    } catch {
      return null;
    }
  }
}
