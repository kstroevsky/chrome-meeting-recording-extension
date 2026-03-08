import { isDevBuild } from '../shared/build';
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
  eventsBodyEl: HTMLTableSectionElement | null;
  downloadBtn: HTMLButtonElement | null;
};

export class DebugDashboard {
  private snapshot: PerfDebugSnapshot | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly storageListener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string
  ) => {
    if (areaName !== 'session') return;
    const next = changes?.[PERF_DEBUG_SNAPSHOT_STORAGE_KEY]?.newValue as PerfDebugSnapshot | undefined;
    if (next) this.renderSnapshot(next);
  };

  constructor(private readonly el: Elements) {}

  init() {
    if (!isDevBuild()) {
      this.renderUnavailable();
      return;
    }

    this.el.downloadBtn?.addEventListener('click', () => this.downloadSnapshot());
    chrome.storage?.onChanged?.addListener?.(this.storageListener);
    void this.refreshSnapshot();
    this.pollTimer = setInterval(() => {
      void this.refreshSnapshot();
    }, 1_000);
  }

  destroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    chrome.storage?.onChanged?.removeListener?.(this.storageListener);
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
    if (this.el.eventsBodyEl) this.el.eventsBodyEl.innerHTML = '';
  }

  private renderSnapshot(snapshot?: PerfDebugSnapshot) {
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
        `Dropped from ring buffer: ${snapshot.droppedEvents}`,
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
        `Used JS heap: ${this.formatMetric(summary.runtime.lastHeapUsedMb, 'MB')}`,
        `Max JS heap seen: ${this.formatMetric(summary.runtime.maxHeapUsedMb, 'MB')}`,
        `JS heap limit: ${this.formatMetric(summary.runtime.lastHeapLimitMb, 'MB')}`,
      ].join('\n');
    }

    if (this.el.eventsBodyEl) {
      this.el.eventsBodyEl.innerHTML = '';
      const recentEntries = snapshot.entries.slice(-25).reverse();
      for (const entry of recentEntries) {
        const row = document.createElement('tr');
        row.innerHTML = [
          `<td>${this.escapeHtml(this.formatTimestamp(entry.ts))}</td>`,
          `<td>${this.escapeHtml(entry.source)}</td>`,
          `<td>${this.escapeHtml(entry.scope)}</td>`,
          `<td>${this.escapeHtml(entry.event)}</td>`,
          `<td>${this.escapeHtml(this.formatFields(entry))}</td>`,
        ].join('');
        this.el.eventsBodyEl.appendChild(row);
      }
    }
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

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
