/**
 * @file popup/historyChrome.ts
 *
 * The small vocabulary the popup's two history surfaces share — the compact
 * recordings list and the detail screen it pushes to. Both draw the same open
 * affordance, date and percentage, so those live here rather than in whichever
 * surface happened to need them first.
 */

import { formatDuration } from './popupStatus';
import type { RecordingHistoryEntry } from '../shared/recordingHistory';

export const DETAIL_OPEN_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4h6v6M11.5 4.5L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const DETAIL_RENAME_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10.5 2.8l2.7 2.7M3 11.4l7.6-7.6 2.7 2.7L5.6 14l-3 .4z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const DETAIL_DRIVE_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 13a3 3 0 01-.3-5.99A4 4 0 0112 6.5a2.75 2.75 0 01-.25 5.5H4.5z"/></svg>';
export const DETAIL_LINK_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.5 9.5a2.5 2.5 0 003.5 0l2-2a2.5 2.5 0 00-3.5-3.5l-1 1M9.5 6.5a2.5 2.5 0 00-3.5 0l-2 2a2.5 2.5 0 003.5 3.5l1-1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function recordingDetailDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(timestamp))
    .toUpperCase();
}

export function recordingDetailDuration(entry: RecordingHistoryEntry): string {
  return entry.durationMs == null ? '—' : formatDuration(entry.durationMs);
}

export function detailPercent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}
