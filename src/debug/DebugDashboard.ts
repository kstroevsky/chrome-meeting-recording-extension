import { isDevBuild, isTestRuntime } from '../shared/build';
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

    const { summary } = snapshot;
    if (this.el.updatedAtEl) {
      this.el.updatedAtEl.textContent = snapshot.updatedAt == null
        ? 'No updates yet'
        : `Last update: ${this.formatTimestamp(snapshot.updatedAt)}`;
    }
    if (this.el.downloadBtn) this.el.downloadBtn.disabled = false;

    if (this.el.summaryEl) {
      this.el.summaryEl.textContent = [
        `Phase: ${summary.currentPhase}`,
        `Events captured: ${summary.totalEvents}`,
        `Retained events: ${snapshot.entries.length}`,
        `Dropped events: ${snapshot.droppedEvents}`,
        `Flags: audioBridge=${snapshot.settings.audioPlaybackBridgeMode}, adaptiveSelfVideo=${snapshot.settings.adaptiveSelfVideoProfile ? 'on' : 'off'}, extendedTimeslice=${snapshot.settings.extendedTimeslice ? 'on' : 'off'}, dynamicChunks=${snapshot.settings.dynamicDriveChunkSizing ? 'on' : 'off'}, parallelUploads=${snapshot.settings.parallelUploadConcurrency}`,
      ].join('\n');
    }

    if (this.el.recorderEl) {
      this.el.recorderEl.textContent = [
        `Active recorders: ${summary.runtime.activeRecorders}`,
        `Timeslice: ${summary.recorder.lastTimesliceMs ?? 'n/a'} ms`,
        `Tab start latency: ${this.formatMetric(summary.recorder.lastStartLatencyMsByStream.tab, 'ms')}`,
        `Mic start latency: ${this.formatMetric(summary.recorder.lastStartLatencyMsByStream.mic, 'ms')}`,
        `Self-video start latency: ${this.formatMetric(summary.recorder.lastStartLatencyMsByStream.selfVideo, 'ms')}`,
        `Persisted chunks: ${summary.recorder.persistedChunkCount}`,
        `Persisted bytes: ${this.formatBytes(summary.recorder.persistedChunkBytes)}`,
        `Average chunk write: ${this.formatMetric(summary.recorder.avgPersistedChunkDurationMs, 'ms')}`,
        `Self-video bitrate: ${this.formatBitrate(summary.recorder.lastSelfVideoBitrate)}`,
        `Audio bridge: mode=${summary.recorder.lastAudioBridgeMode ?? 'n/a'}, suppressed=${this.formatBool(summary.recorder.lastAudioBridgeSuppressed)}, enabled=${this.formatBool(summary.recorder.lastAudioBridgeEnabled)}`,
      ].join('\n');
    }

    if (this.el.uploadEl) {
      this.el.uploadEl.textContent = [
        `Chunk uploads: ${summary.upload.chunkCount}`,
        `Retries: ${summary.upload.retryCount}`,
        `Retried chunks: ${summary.upload.retriedChunkCount}`,
        `Transferred bytes: ${this.formatBytes(summary.upload.totalChunkBytes)}`,
        `Average chunk duration: ${this.formatMetric(summary.upload.avgChunkDurationMs, 'ms')}`,
        `Latest chunk throughput: ${this.formatMetric(summary.upload.lastChunkThroughputMbps, 'MB/s')}`,
        `Completed files: ${summary.upload.fileCount}`,
        `Uploaded to Drive: ${summary.upload.uploadedCount}`,
        `Local fallbacks: ${summary.upload.fallbackCount}`,
        `Average file duration: ${this.formatMetric(summary.upload.avgFileDurationMs, 'ms')}`,
        `Latest fallback rate: ${summary.upload.lastFallbackRate ?? 'n/a'}`,
        `Upload concurrency: ${summary.upload.lastConcurrency ?? 'n/a'}`,
      ].join('\n');
    }

    if (this.el.captionsEl) {
      this.el.captionsEl.textContent = [
        `Current block observers: ${summary.captions.currentObserverCount}`,
        `Peak block observers: ${summary.captions.maxObserverCount}`,
      ].join('\n');
    }

    if (this.el.runtimeEl) {
      this.el.runtimeEl.textContent = [
        `State: ${summary.runtime.state}`,
        `Samples: ${summary.runtime.sampleCount}`,
        `Hardware threads: ${summary.runtime.hardwareConcurrency ?? 'n/a'}`,
        `Device memory: ${this.formatMetric(summary.runtime.deviceMemoryGb, 'GB')}`,
        `Used JS heap: ${this.formatMetric(summary.runtime.lastHeapUsedMb, 'MB')}`,
        `Total JS heap: ${this.formatMetric(summary.runtime.lastTotalHeapMb, 'MB')}`,
        `Max JS heap seen: ${this.formatMetric(summary.runtime.maxHeapUsedMb, 'MB')}`,
        `JS heap limit: ${this.formatMetric(summary.runtime.lastHeapLimitMb, 'MB')}`,
        `CPU pressure proxy (event loop lag): current=${this.formatMetric(summary.runtime.lastEventLoopLagMs, 'ms')}, avg=${this.formatMetric(summary.runtime.avgEventLoopLagMs, 'ms')}, max=${this.formatMetric(summary.runtime.maxEventLoopLagMs, 'ms')}`,
        `Long tasks: count=${summary.runtime.longTaskCount}, last=${this.formatMetric(summary.runtime.lastLongTaskMs, 'ms')}, max=${this.formatMetric(summary.runtime.maxLongTaskMs, 'ms')}`,
      ].join('\n');
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
      `<td>${this.escapeHtml(this.formatTimestamp(entry.ts))}</td>`,
      `<td>${this.escapeHtml(entry.source)}</td>`,
      `<td>${this.escapeHtml(entry.scope)}</td>`,
      `<td>${this.escapeHtml(entry.event)}</td>`,
      `<td>${this.escapeHtml(this.formatFields(entry))}</td>`,
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

  private formatFields(entry: PerfEventEntry): string {
    if (!Object.keys(entry.fields).length) return '-';
    return Object.entries(entry.fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');
  }

  private formatTimestamp(ts: number): string {
    const date = new Date(ts);
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${date.toLocaleString()} .${ms}`;
  }

  private formatMetric(value: number | null | undefined, unit: string): string {
    return value == null ? 'n/a' : `${value} ${unit}`;
  }

  private formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    if (value >= 1024 * 1024 * 1024) return `${Math.round((value / 1024 / 1024 / 1024) * 100) / 100} GB`;
    if (value >= 1024 * 1024) return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`;
    if (value >= 1024) return `${Math.round((value / 1024) * 10) / 10} KB`;
    return `${value} B`;
  }

  private formatBitrate(value: number | null): string {
    return value == null ? 'n/a' : `${Math.round((value / 1_000_000) * 100) / 100} Mbps`;
  }

  private formatBool(value: boolean | null): string {
    return value == null ? 'n/a' : value ? 'yes' : 'no';
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

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
