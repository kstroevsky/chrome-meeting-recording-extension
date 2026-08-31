/**
 * @file popup/recording/InterruptedView.ts
 *
 * The notice for a run that ended without the user asking — the meeting tab
 * closed, the tab left the meeting, or the meeting ended (design n4).
 *
 * The capture is already sealed and saved by the time this paints, so the
 * screen is a report rather than a decision point: it says what happened, what
 * was kept, and offers the ordinary delete of a recording that already exists.
 * That is why "NOTHING LOST" is the first thing it can honestly claim.
 */

import { NotationRibbon } from '../notes/notationRibbon';
import { notationRow } from '../notes/notationRow';
import { formatDuration } from '../popupStatus';
import type { PopupElements } from '../popupView';
import type { RecordingNotation } from '../../shared/notations';
import type { RecordingStatusView } from '../../shared/recording';

export type RecordingInterruption = NonNullable<RecordingStatusView['interruption']>;

/** What actually happened, in the user's terms. */
const INTERRUPTION_TITLE: Record<RecordingInterruption['reason'], string> = {
  'tab-closed': 'The meeting tab closed',
  'navigated-away': 'The tab left the meeting',
  'meeting-ended': 'The meeting ended',
};

export type InterruptedElements = Pick<
  PopupElements,
  | 'interruptedTitle'
  | 'interruptedSub'
  | 'interruptedNotes'
  | 'interruptedRibbon'
  | 'interruptedTrack'
  | 'interruptedList'
  | 'interruptedCount'
  | 'interruptedDone'
  | 'interruptedDiscard'
>;

export type InterruptedActions = {
  /** Clears the notice. The run is already saved; nothing else changes. */
  dismiss: () => Promise<void>;
  /** Deletes the recording the interruption produced, then dismisses. */
  discard: (historyId: string) => Promise<void>;
  /** The run's notations — preview-aware, so the gallery needs no background. */
  loadNotations: (recordingId: string) => Promise<RecordingNotation[]>;
};

export class InterruptedView {
  private readonly el: Partial<InterruptedElements>;
  private ribbon: NotationRibbon | null = null;
  private current: RecordingInterruption | null = null;

  constructor(
    el: Partial<InterruptedElements> | null | undefined,
    private readonly actions: InterruptedActions,
  ) {
    this.el = el ?? {};
  }

  wire(): void {
    this.el.interruptedDone?.addEventListener('click', () => void this.actions.dismiss());
    this.el.interruptedDiscard?.addEventListener('click', () => {
      const historyId = this.current?.historyId;
      if (historyId) void this.actions.discard(historyId);
    });
  }

  async render(interruption?: RecordingInterruption): Promise<void> {
    if (!interruption) return;
    this.current = interruption;
    const { el } = this;
    if (el.interruptedTitle) el.interruptedTitle.textContent = INTERRUPTION_TITLE[interruption.reason];
    if (el.interruptedSub) {
      el.interruptedSub.textContent = `STOPPED AT ${formatDuration(interruption.atMs)} · NOTHING LOST`;
    }

    let notations: RecordingNotation[] = [];
    try {
      notations = await this.actions.loadNotations(interruption.historyId);
    } catch { /* the report stands without them */ }

    if (el.interruptedNotes) el.interruptedNotes.hidden = notations.length === 0;
    if (el.interruptedRibbon) el.interruptedRibbon.hidden = notations.length === 0;
    if (el.interruptedCount) {
      el.interruptedCount.textContent = `${notations.length} ${notations.length === 1 ? 'NOTE' : 'NOTES'}`;
    }
    this.renderSpans(notations, interruption.atMs);
    this.renderList(notations, interruption.atMs);
  }

  /** Spans on a finished timeline; the one the run sealed keeps its dashed edge. */
  private renderSpans(notations: RecordingNotation[], atMs: number): void {
    const track = this.el.interruptedTrack;
    if (!track) return;
    // Inert spans: this screen reports what was kept, it does not edit it.
    this.ribbon ??= new NotationRibbon(track, { spanClass: 'note-span', minWidthPct: 1 });
    this.ribbon.draw(notations, { scaleMs: atMs, openEndsAtMs: atMs });
  }

  private renderList(notations: RecordingNotation[], atMs: number): void {
    const list = this.el.interruptedList;
    if (!list) return;
    list.replaceChildren(...notations.map((notation) => notationRow(notation, { sealedAtMs: atMs })));
  }
}
