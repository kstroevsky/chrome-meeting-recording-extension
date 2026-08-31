/**
 * @file recordings/recordingsFormat.ts
 *
 * How the recordings table words a recording: its size, length, day, time and
 * stream, plus the search highlighter.
 *
 * Kept apart from the view because these are the page's *vocabulary* — the
 * table, the expanded detail and the note cell all word a duration the same
 * way, and this page words it differently from the popup on purpose (the design
 * zero-pads a position here: `02:34`, not `2:34`).
 */

import type { RecordingHistoryEntry, RecordingHistoryFile } from '../shared/recordingHistory';

type HistoryEntryWithDuration = RecordingHistoryEntry & { durationMs?: number };

/**
 * Writes `text` into `host`, wrapping each occurrence of the active query in a
 * gold `<b>` so a search says *where* it matched (f2). Falls back to plain text
 * when there is no query, and never interprets the query as markup.
 */
export function withHit(host: HTMLElement, text: string, query: string): HTMLElement {
  if (!query) { host.textContent = text; return host; }
  const lower = text.toLocaleLowerCase();
  let from = 0;
  let at = lower.indexOf(query);
  if (at < 0) { host.textContent = text; return host; }
  while (at >= 0) {
    if (at > from) host.append(text.slice(from, at));
    const hit = document.createElement('b');
    hit.className = 'recording-row__hit';
    hit.textContent = text.slice(at, at + query.length);
    host.append(hit);
    from = at + query.length;
    at = lower.indexOf(query, from);
  }
  if (from < text.length) host.append(text.slice(from));
  return host;
}

export function streamLabel(stream: RecordingHistoryFile['stream']): string {
  return stream === 'self-video' ? 'CAM' : stream.toUpperCase();
}

export function statusLabel(status: RecordingHistoryEntry['status']): string {
  return status === 'partial' ? 'RECOVERED' : status.toUpperCase();
}

export function sizeOf(entry: RecordingHistoryEntry): number {
  return entry.files.reduce((total, file) => total + (file.bytes ?? 0), 0);
}

export function formatSize(bytes: number): string {
  if (!bytes) return '—';
  const megabytes = bytes / (1024 * 1024);
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(1)}G`;
  return `${Math.max(1, Math.round(megabytes))}M`;
}

export function durationOf(entry: RecordingHistoryEntry): number | undefined {
  return (entry as HistoryEntryWithDuration).durationMs;
}

/** The design's note timecodes are zero-padded to minutes: `02:34`, not `2:34`. */
export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${String(minutes).padStart(2, '0')}:${seconds}`;
}

export function formatDuration(entry: RecordingHistoryEntry): string {
  const durationMs = durationOf(entry);
  if (durationMs == null || durationMs < 0) return '—';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  const weekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${sameDay ? 'TODAY · ' : ''}${weekdays[date.getDay()]} ${months[date.getMonth()]} ${date.getDate()}`;
}

export function fullDate(timestamp: number): string {
  const date = new Date(timestamp);
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${weekdays[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()} ${date.getFullYear()} · ${formatTime(timestamp)}`;
}
