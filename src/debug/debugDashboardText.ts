/**
 * @file debug/debugDashboardText.ts
 *
 * Pure formatting helpers for the diagnostics dashboard. Keeping these string
 * builders separate leaves `DebugDashboard` focused on DOM lifecycle and data
 * refresh behavior.
 */

import type { PerfDebugSnapshot, PerfEventEntry } from '../shared/perf';

export function buildSummaryText(snapshot: PerfDebugSnapshot): string {
  const { summary } = snapshot;
  return [
    `Phase: ${summary.currentPhase}`,
    `Events captured: ${summary.totalEvents}`,
    `Retained events: ${snapshot.entries.length}`,
    `Dropped events: ${snapshot.droppedEvents}`,
    `Flags: audioBridge=${snapshot.settings.audioPlaybackBridgeMode}, adaptiveSelfVideo=${snapshot.settings.adaptiveSelfVideoProfile ? 'on' : 'off'}, extendedTimeslice=${snapshot.settings.extendedTimeslice ? 'on' : 'off'}, dynamicChunks=${snapshot.settings.dynamicDriveChunkSizing ? 'on' : 'off'}, parallelUploads=${snapshot.settings.parallelUploadConcurrency}`,
  ].join('\n');
}

export function buildRecorderText(snapshot: PerfDebugSnapshot): string {
  const { summary } = snapshot;
  return [
    `Active recorders: ${summary.runtime.activeRecorders}`,
    `Timeslice: ${summary.recorder.lastTimesliceMs ?? 'n/a'} ms`,
    `Tab start latency: ${formatMetric(summary.recorder.lastStartLatencyMsByStream.tab, 'ms')}`,
    `Mic start latency: ${formatMetric(summary.recorder.lastStartLatencyMsByStream.mic, 'ms')}`,
    `Self-video start latency: ${formatMetric(summary.recorder.lastStartLatencyMsByStream.selfVideo, 'ms')}`,
    `Persisted chunks: ${summary.recorder.persistedChunkCount}`,
    `Persisted bytes: ${formatBytes(summary.recorder.persistedChunkBytes)}`,
    `Average chunk write: ${formatMetric(summary.recorder.avgPersistedChunkDurationMs, 'ms')}`,
    `Self-video bitrate: ${formatBitrate(summary.recorder.lastSelfVideoBitrate)}`,
    `Audio bridge: mode=${summary.recorder.lastAudioBridgeMode ?? 'n/a'}, suppressed=${formatBool(summary.recorder.lastAudioBridgeSuppressed)}, enabled=${formatBool(summary.recorder.lastAudioBridgeEnabled)}`,
  ].join('\n');
}

export function buildUploadText(snapshot: PerfDebugSnapshot): string {
  const { summary } = snapshot;
  return [
    `Chunk uploads: ${summary.upload.chunkCount}`,
    `Retries: ${summary.upload.retryCount}`,
    `Retried chunks: ${summary.upload.retriedChunkCount}`,
    `Transferred bytes: ${formatBytes(summary.upload.totalChunkBytes)}`,
    `Average chunk duration: ${formatMetric(summary.upload.avgChunkDurationMs, 'ms')}`,
    `Latest chunk throughput: ${formatMetric(summary.upload.lastChunkThroughputMbps, 'MB/s')}`,
    `Completed files: ${summary.upload.fileCount}`,
    `Uploaded to Drive: ${summary.upload.uploadedCount}`,
    `Local fallbacks: ${summary.upload.fallbackCount}`,
    `Average file duration: ${formatMetric(summary.upload.avgFileDurationMs, 'ms')}`,
    `Latest fallback rate: ${summary.upload.lastFallbackRate ?? 'n/a'}`,
    `Upload concurrency: ${summary.upload.lastConcurrency ?? 'n/a'}`,
  ].join('\n');
}

export function buildCaptionsText(snapshot: PerfDebugSnapshot): string {
  const { summary } = snapshot;
  return [
    `Current block observers: ${summary.captions.currentObserverCount}`,
    `Peak block observers: ${summary.captions.maxObserverCount}`,
  ].join('\n');
}

export function buildRuntimeText(snapshot: PerfDebugSnapshot): string {
  const { summary } = snapshot;
  return [
    `State: ${summary.runtime.state}`,
    `Samples: ${summary.runtime.sampleCount}`,
    `Hardware threads: ${summary.runtime.hardwareConcurrency ?? 'n/a'}`,
    `Device memory: ${formatMetric(summary.runtime.deviceMemoryGb, 'GB')}`,
    `Used JS heap: ${formatMetric(summary.runtime.lastHeapUsedMb, 'MB')}`,
    `Total JS heap: ${formatMetric(summary.runtime.lastTotalHeapMb, 'MB')}`,
    `Max JS heap seen: ${formatMetric(summary.runtime.maxHeapUsedMb, 'MB')}`,
    `JS heap limit: ${formatMetric(summary.runtime.lastHeapLimitMb, 'MB')}`,
    `CPU pressure proxy (event loop lag): current=${formatMetric(summary.runtime.lastEventLoopLagMs, 'ms')}, avg=${formatMetric(summary.runtime.avgEventLoopLagMs, 'ms')}, max=${formatMetric(summary.runtime.maxEventLoopLagMs, 'ms')}`,
    `Long tasks: count=${summary.runtime.longTaskCount}, last=${formatMetric(summary.runtime.lastLongTaskMs, 'ms')}, max=${formatMetric(summary.runtime.maxLongTaskMs, 'ms')}`,
  ].join('\n');
}

export function formatEventFields(entry: PerfEventEntry): string {
  if (!Object.keys(entry.fields).length) return '-';
  return Object.entries(entry.fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
}

export function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${date.toLocaleString()} .${ms}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMetric(value: number | null | undefined, unit: string): string {
  return value == null ? 'n/a' : `${value} ${unit}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 * 1024 * 1024) return `${Math.round((value / 1024 / 1024 / 1024) * 100) / 100} GB`;
  if (value >= 1024 * 1024) return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`;
  if (value >= 1024) return `${Math.round((value / 1024) * 10) / 10} KB`;
  return `${value} B`;
}

function formatBitrate(value: number | null): string {
  return value == null ? 'n/a' : `${Math.round((value / 1_000_000) * 100) / 100} Mbps`;
}

function formatBool(value: boolean | null): string {
  return value == null ? 'n/a' : value ? 'yes' : 'no';
}
