/**
 * @file shared/notations.ts
 *
 * Notations: timecoded, user-authored annotations on a recording — the plural,
 * time-bearing sibling of {@link RecordingHistoryEntry.note}.
 *
 * **Time base.** `tStartMs`/`tEndMs` are *media-relative* offsets into the
 * produced file, not wall clock. They are stamped from the background's
 * pause-aware recording clock (`RecordingSession.currentRecordedMs`), whose
 * domain is identical to playback position because a paused span is never
 * written into the media (`RecorderEngine.setPaused` pauses every
 * `MediaRecorder`). A notation therefore seeks correctly with no pause-gap
 * correction. See ADR-0005.
 *
 * **Decode is tolerant, writes are strict.** Normalizing degrades a bad field
 * (an out-of-order `tEndMs` becomes a point mark) rather than discarding the
 * user's mark; the service rejects the same input on the write path.
 */

/**
 * How a span was closed. Absent while the span is still open.
 *
 * `'auto'` means the run ended before the user closed it, so the span was
 * sealed at the last recorded position rather than discarded — the case the
 * design marks with a dashed edge and an “ENDED AT” label. Whether that reads
 * as *interrupted* depends on how the recording itself ended, which the history
 * entry already records; a notation should not carry a second opinion about it.
 */
export type NotationEndedBy = 'user' | 'auto';

/** One timecoded annotation. `tEndMs` absent = a point mark, or a span still open. */
export type RecordingNotation = {
  id: string;
  /** Media-relative start offset in ms; always finite and >= 0. */
  tStartMs: number;
  /** Media-relative end offset in ms; when present, always >= `tStartMs`. */
  tEndMs?: number;
  /** Only meaningful alongside `tEndMs`; absent on an open span. */
  endedBy?: NotationEndedBy;
  /** User-authored label. May be empty — marking a moment to name later is the point. */
  text: string;
};

/**
 * Per-recording cap. Durable lists in this codebase are always bounded
 * (`MAX_ORPHANS_PER_RUN`, `MAX_OUTBOX_BATCHES`); notations are user-driven, so
 * the cap only has to stop a stuck key-repeat from growing the row forever.
 */
export const MAX_NOTATIONS_PER_RECORDING = 500;
export const MAX_NOTATION_TEXT_LENGTH = 500;

export type RecordingNotationMessage =
  /** Stamps a notation at the live recording position. Targets the active run. */
  | { type: 'MARK_NOTATION'; text?: string }
  /** Closes an open notation at the live recording position. Targets the active run. */
  | { type: 'END_NOTATION'; id: string }
  /**
   * Reads the active run's notations. Exists so the popup never needs the run's
   * `historyId`, which is background-only bookkeeping (ADR-0003) — the background
   * resolves it. Answers an empty list when nothing is recording.
   */
  | { type: 'LIST_ACTIVE_NOTATIONS' }
  /** Writes a message onto one of the active run's notations. */
  | { type: 'UPDATE_ACTIVE_NOTATION'; id: string; text: string }
  | { type: 'REMOVE_ACTIVE_NOTATION'; id: string }
  | { type: 'LIST_RECORDING_NOTATIONS'; recordingId: string }
  | { type: 'ADD_RECORDING_NOTATION'; recordingId: string; tStartMs: number; tEndMs?: number; text: string }
  | { type: 'UPDATE_RECORDING_NOTATION'; recordingId: string; id: string; tStartMs?: number; tEndMs?: number; text?: string }
  | { type: 'REMOVE_RECORDING_NOTATION'; recordingId: string; id: string };

export function createNotationId(): string {
  return `notation:${crypto.randomUUID()}`;
}

/** Trims and bounds notation text. Empty is valid; `undefined` becomes `''`. */
export function normalizeNotationText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_NOTATION_TEXT_LENGTH) : '';
}

function finiteOffset(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Decodes one durable notation. Invalid records are skipped; invalid fields are dropped. */
export function normalizeRecordingNotation(value: unknown): RecordingNotation | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const tStartMs = finiteOffset(candidate.tStartMs);
  if (!id || tStartMs == null) return undefined;

  // A `tEndMs` before its start is meaningless, but the mark itself still is
  // not — degrade to a point mark rather than losing what the user recorded.
  const tEndMs = finiteOffset(candidate.tEndMs);
  const closed = tEndMs != null && tEndMs >= tStartMs;
  const endedBy = candidate.endedBy === 'auto' ? 'auto' : candidate.endedBy === 'user' ? 'user' : undefined;
  return {
    id,
    tStartMs,
    ...(closed ? { tEndMs } : {}),
    // An end reason without an end is meaningless, so it degrades with it.
    ...(closed && endedBy ? { endedBy } : {}),
    text: normalizeNotationText(candidate.text),
  };
}

/** Decodes a durable notation list into chronological order. Invalid records are skipped. */
export function normalizeRecordingNotations(value: unknown): RecordingNotation[] {
  if (!Array.isArray(value)) return [];
  return sortRecordingNotations(
    value
      .map(normalizeRecordingNotation)
      .filter((notation): notation is RecordingNotation => notation != null)
      .slice(0, MAX_NOTATIONS_PER_RECORDING),
  );
}

/** Chronological order, tie-broken by id so the sort is stable across reads. */
export function sortRecordingNotations(notations: RecordingNotation[]): RecordingNotation[] {
  return [...notations].sort((a, b) => a.tStartMs - b.tStartMs || a.id.localeCompare(b.id));
}

export function isRecordingNotationMessage(value: unknown): value is RecordingNotationMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  const hasRecordingId = typeof message.recordingId === 'string' && message.recordingId.length > 0;
  const hasId = typeof message.id === 'string' && message.id.length > 0;

  if (message.type === 'MARK_NOTATION') {
    return message.text == null || typeof message.text === 'string';
  }
  if (message.type === 'END_NOTATION') {
    return hasId;
  }
  if (message.type === 'LIST_ACTIVE_NOTATIONS') {
    return true;
  }
  if (message.type === 'UPDATE_ACTIVE_NOTATION') {
    return hasId && typeof message.text === 'string';
  }
  if (message.type === 'REMOVE_ACTIVE_NOTATION') {
    return hasId;
  }
  if (message.type === 'LIST_RECORDING_NOTATIONS') {
    return hasRecordingId;
  }
  if (message.type === 'ADD_RECORDING_NOTATION') {
    return hasRecordingId
      && typeof message.text === 'string'
      && finiteOffset(message.tStartMs) != null
      && (message.tEndMs == null || finiteOffset(message.tEndMs) != null);
  }
  if (message.type === 'UPDATE_RECORDING_NOTATION') {
    return hasRecordingId && hasId
      && (message.text == null || typeof message.text === 'string')
      && (message.tStartMs == null || finiteOffset(message.tStartMs) != null)
      && (message.tEndMs == null || finiteOffset(message.tEndMs) != null);
  }
  return message.type === 'REMOVE_RECORDING_NOTATION' && hasRecordingId && hasId;
}
