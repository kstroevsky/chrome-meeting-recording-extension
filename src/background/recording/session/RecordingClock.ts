import type { RecordingSessionSnapshot } from '../../../shared/recording';
import { MAX_RECORDED_SPANS, type RecordedSpan } from '../../../shared/recordingTypes';

export type RecordingTimerState = Pick<
  RecordingSessionSnapshot,
  'recordedMs' | 'runningSince' | 'recordedSpans'
>;

export function elapsedRecordedMs(snapshot: RecordingSessionSnapshot, now: number): number {
  const base = snapshot.recordedMs ?? 0;
  return snapshot.runningSince ? base + Math.max(0, now - snapshot.runningSince) : base;
}

export function timerForPhase(
  snapshot: RecordingSessionSnapshot,
  newPhase: RecordingSessionSnapshot['phase'],
  now: number,
): RecordingTimerState {
  if (newPhase === 'recording') {
    return snapshot.phase === 'recording'
      ? {
        recordedMs: snapshot.recordedMs,
        runningSince: snapshot.runningSince,
        recordedSpans: snapshot.recordedSpans,
      }
      : { recordedMs: 0, runningSince: now, recordedSpans: openSpan(undefined, now, 0) };
  }
  return {
    recordedMs: elapsedRecordedMs(snapshot, now),
    runningSince: undefined,
    recordedSpans: closeOpenSpan(snapshot.recordedSpans, now),
  };
}

export function timerForPause(
  snapshot: RecordingSessionSnapshot,
  paused: boolean,
  now: number,
): RecordingTimerState {
  const recordedMs = paused ? elapsedRecordedMs(snapshot, now) : (snapshot.recordedMs ?? 0);
  return {
    recordedMs,
    runningSince: paused ? undefined : (snapshot.runningSince ?? now),
    recordedSpans: paused
      ? closeOpenSpan(snapshot.recordedSpans, now)
      : openSpan(snapshot.recordedSpans, now, recordedMs),
  };
}

export function recordedMsAt(
  snapshot: RecordingSessionSnapshot,
  wallClockMs: number,
  now: number,
): number | undefined {
  if (!Number.isFinite(wallClockMs)) return undefined;
  const spans = snapshot.recordedSpans;
  if (!spans?.length) return legacyRecordedMsAt(snapshot, wallClockMs);

  const span = spans.find((candidate) => withinSpan(candidate, wallClockMs, now));
  return span ? span.mediaStartMs + (wallClockMs - span.wallStartMs) : undefined;
}

export function recordedRangeAt(
  snapshot: RecordingSessionSnapshot,
  startWallMs: number,
  endWallMs: number,
  now: number,
): { tStartMs: number; tEndMs: number } | undefined {
  const tStartMs = recordedMsAt(snapshot, startWallMs, now);
  if (tStartMs == null) return undefined;

  const spans = snapshot.recordedSpans;
  const span = spans?.find((candidate) => withinSpan(candidate, startWallMs, now));
  if (!span) {
    const tEndMs = recordedMsAt(snapshot, endWallMs, now);
    return { tStartMs, tEndMs: Math.max(tStartMs, tEndMs ?? tStartMs) };
  }

  const spanEndWallMs = span.wallEndMs ?? now;
  if (endWallMs > spanEndWallMs) return undefined;

  const boundedEndWallMs = Math.max(endWallMs, startWallMs);
  return { tStartMs, tEndMs: span.mediaStartMs + (boundedEndWallMs - span.wallStartMs) };
}

export function closeOpenSpan(
  spans: RecordedSpan[] | undefined,
  now: number,
): RecordedSpan[] | undefined {
  if (!spans?.length) return spans;
  const last = spans[spans.length - 1];
  if (last.wallEndMs != null) return spans;
  return [...spans.slice(0, -1), { ...last, wallEndMs: Math.max(last.wallStartMs, now) }];
}

function legacyRecordedMsAt(
  snapshot: RecordingSessionSnapshot,
  wallClockMs: number,
): number | undefined {
  const { runningSince } = snapshot;
  if (runningSince == null || wallClockMs < runningSince) return undefined;
  return (snapshot.recordedMs ?? 0) + (wallClockMs - runningSince);
}

function withinSpan(span: RecordedSpan, wallClockMs: number, now: number): boolean {
  if (wallClockMs < span.wallStartMs) return false;
  return wallClockMs <= (span.wallEndMs ?? now);
}

function openSpan(
  spans: RecordedSpan[] | undefined,
  now: number,
  mediaStartMs: number,
): RecordedSpan[] {
  const current = spans ?? [];
  const last = current[current.length - 1];
  if (last && last.wallEndMs == null) return current;
  if (current.length >= MAX_RECORDED_SPANS) return current;
  return [...current, { wallStartMs: now, mediaStartMs }];
}
