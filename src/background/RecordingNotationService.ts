/**
 * @file background/RecordingNotationService.ts
 *
 * Owns every notation transition. Decode is tolerant (see `shared/notations.ts`),
 * but this layer is strict: it rejects an out-of-order span or an unknown id
 * rather than silently degrading, so a caller learns its write did not land.
 */

import {
  MAX_NOTATIONS_PER_RECORDING,
  createNotationId,
  normalizeNotationText,
  sortRecordingNotations,
  type NotationEndedBy,
  type RecordingNotation,
} from '../shared/notations';
import type { RecordingNotationRepositoryPort } from './RecordingNotationRepository';

export type NewRecordingNotation = { tStartMs: number; tEndMs?: number; text?: string };
export type RecordingNotationPatch = { tStartMs?: number; tEndMs?: number; text?: string };

/** Owns every notation transition for a recording, keyed by its history id. */
export class RecordingNotationService {
  constructor(private readonly repository: RecordingNotationRepositoryPort) {}

  async list(recordingId: string): Promise<RecordingNotation[]> {
    return await this.repository.list(recordingId);
  }

  /**
   * How many notations each of these recordings has. Lets a list render its
   * count chips from one message rather than one per row.
   */
  async counts(recordingIds: string[]): Promise<Record<string, number>> {
    const entries = await Promise.all(
      recordingIds.map(async (id) => [id, (await this.repository.list(id)).length] as const),
    );
    return Object.fromEntries(entries.filter(([, count]) => count > 0));
  }

  /** Appends a notation. Returns the stored record, including its assigned id. */
  async add(recordingId: string, notation: NewRecordingNotation): Promise<RecordingNotation> {
    const created: RecordingNotation = {
      id: createNotationId(),
      tStartMs: requireOffset(notation.tStartMs, 'start'),
      ...(notation.tEndMs != null ? { tEndMs: requireOffset(notation.tEndMs, 'end') } : {}),
      text: normalizeNotationText(notation.text),
    };
    requireOrderedSpan(created);

    await this.repository.update(recordingId, (current) => {
      if (current.length >= MAX_NOTATIONS_PER_RECORDING) {
        throw new Error(`A recording cannot hold more than ${MAX_NOTATIONS_PER_RECORDING} notations`);
      }
      return sortRecordingNotations([...current, created]);
    });
    return created;
  }

  /** Patches an existing notation. Only the supplied fields change. */
  async update(recordingId: string, id: string, patch: RecordingNotationPatch): Promise<RecordingNotation[]> {
    return await this.repository.update(recordingId, (current) => {
      const existing = current.find((notation) => notation.id === id);
      if (!existing) throw new Error(`Unknown notation: ${id}`);

      const next: RecordingNotation = {
        ...existing,
        ...(patch.tStartMs != null ? { tStartMs: requireOffset(patch.tStartMs, 'start') } : {}),
        ...(patch.text != null ? { text: normalizeNotationText(patch.text) } : {}),
      };
      if (patch.tEndMs != null) next.tEndMs = requireOffset(patch.tEndMs, 'end');
      requireOrderedSpan(next);

      return sortRecordingNotations(current.map((notation) => (notation.id === id ? next : notation)));
    });
  }

  /**
   * Closes an open span. A notation that already has an end is left alone, so a
   * repeated END_NOTATION cannot rewrite a span the user already finished.
   */
  async endOpen(recordingId: string, id: string, tEndMs: number): Promise<RecordingNotation> {
    const end = requireOffset(tEndMs, 'end');
    let result: RecordingNotation | undefined;
    await this.repository.update(recordingId, (current) => {
      const existing = current.find((notation) => notation.id === id);
      if (!existing) throw new Error(`Unknown notation: ${id}`);
      if (existing.tEndMs != null) {
        result = existing;
        return current;
      }
      if (end < existing.tStartMs) throw new Error('A notation cannot end before it starts');
      result = { ...existing, tEndMs: end, endedBy: 'user' };
      return current.map((notation) => (notation.id === id ? result! : notation));
    });
    return result!;
  }

  /**
   * Seals every span still open when a run ends, at the last recorded position.
   *
   * A note left open must not vanish — the design's rule is that it is "closed
   * at the last saved frame and marked, rather than disappearing" — so the
   * spans are closed with `endedBy: 'auto'`, which is what lets a screen draw
   * the dashed edge. Idempotent: a second call finds nothing open.
   */
  async closeOpenSpans(recordingId: string, tEndMs: number, endedBy: NotationEndedBy = 'auto'): Promise<RecordingNotation[]> {
    const end = requireOffset(tEndMs, 'end');
    return await this.repository.update(recordingId, (current) => {
      if (!current.some((notation) => notation.tEndMs == null)) return current;
      return current.map((notation) => (
        notation.tEndMs == null
          // A run can end before the clock advances past a mark taken in the
          // same instant, so clamp rather than reject a zero-length span.
          ? { ...notation, tEndMs: Math.max(end, notation.tStartMs), endedBy }
          : notation
      ));
    });
  }

  async remove(recordingId: string, id: string): Promise<RecordingNotation[]> {
    return await this.repository.update(recordingId, (current) => {
      const next = current.filter((notation) => notation.id !== id);
      if (next.length === current.length) throw new Error(`Unknown notation: ${id}`);
      return next;
    });
  }

  /** Drops every notation for a recording — a discarded run, or a deleted entry. */
  async removeAll(recordingId: string): Promise<void> {
    await this.repository.remove(recordingId);
  }
}

function requireOffset(value: number, label: 'start' | 'end'): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`A notation ${label} offset must be a non-negative number of milliseconds`);
  }
  return value;
}

function requireOrderedSpan(notation: RecordingNotation): void {
  if (notation.tEndMs != null && notation.tEndMs < notation.tStartMs) {
    throw new Error('A notation cannot end before it starts');
  }
}
