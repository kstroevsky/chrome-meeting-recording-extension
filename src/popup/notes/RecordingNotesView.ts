/**
 * @file popup/notes/RecordingNotesView.ts
 *
 * The live notes UI: the "Make a note" capture row, the span ribbon under the
 * timer, and the message editor (ADR-0005).
 *
 * The interaction rule this file exists to enforce is the design's: **ending a
 * note is silent**. Starting or ending a span opens nothing — the popup does not
 * interrupt the meeting. A message is written only when the user clicks a span,
 * whenever there happens to be a gap.
 *
 * Positions are media-relative ms from the background's pause-aware clock, so a
 * span's place on the ribbon is its place in the produced file. The ribbon is
 * scaled to live elapsed time, so "now" is always the right-hand edge of the
 * track and the spans slide left as the meeting gets longer. Elapsed time only
 * grows while recording, so a paused ribbon holds still rather than rescaling.
 */

import { formatDuration, formatPosition } from '../popupStatus';
import { NotationRibbon } from './notationRibbon';
import type { RecordingNotation } from '../../shared/notations';
import type { RecordingPhase, RecordingStatusView } from '../../shared/recording';

/** The open span's length re-renders once per second, like the timer. */
const TICK_MS = 1000;

/** How long typing settles before the name is written. Keystrokes are cheap; writes are not. */
const NAME_COMMIT_MS = 400;

/** Keeps a just-started span visible before elapsed time has caught up to it. */
const MIN_SCALE_MS = 1000;

export type RecordingNotesElements = {
  ribbon: HTMLElement | null;
  track: HTMLElement | null;
  openTimer: HTMLElement | null;
  held: HTMLElement | null;
  heldStart: HTMLElement | null;
  heldText: HTMLElement | null;
  toggle: HTMLButtonElement | null;
  row: HTMLElement | null;
  startButton: HTMLButtonElement | null;
  startLabel: HTMLElement | null;
  count: HTMLElement | null;
  /** Replaces the start button while a note runs: the name, typed as it happens. */
  nameRow: HTMLElement | null;
  nameInput: HTMLInputElement | null;
  /** Replaces the count while a note runs: where that note started. */
  from: HTMLElement | null;
  hint: HTMLElement | null;
  editor: HTMLElement | null;
  editorIndex: HTMLElement | null;
  editorRange: HTMLElement | null;
  editorLength: HTMLElement | null;
  editorText: HTMLInputElement | null;
  editorSave: HTMLButtonElement | null;
  editorDelete: HTMLButtonElement | null;
  editorClose: HTMLButtonElement | null;
};

export type RecordingNotesActions = {
  mark: () => Promise<void>;
  end: (id: string) => Promise<void>;
  save: (id: string, text: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

export class RecordingNotesView {
  private notations: RecordingNotation[] = [];
  private phase: RecordingPhase = 'idle';
  private paused = false;
  private recordedMs = 0;
  private runningSince: number | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private editingId: string | null = null;
  /** Pending debounce for the open note's name. */
  private nameTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly ribbon: NotationRibbon | null;

  private readonly el: Partial<RecordingNotesElements>;

  constructor(
    el: Partial<RecordingNotesElements> | null | undefined,
    private readonly actions: RecordingNotesActions,
  ) {
    // Every element in this popup is nullable; an absent group behaves the same
    // way, so a missing id degrades to an inert ribbon rather than a crash.
    this.el = el ?? {};
    this.ribbon = this.el.track
      // The live ribbon lets CSS `min-width` keep a new span visible, so a span
      // that has just been marked grows from nothing instead of snapping open.
      ? new NotationRibbon(this.el.track, {
        spanClass: 'note-span',
        minWidthPct: 0,
        activeClass: 'editing',
        onSelect: (id) => this.openEditor(id),
      })
      : null;
    this.el.startButton?.addEventListener('click', () => void this.onToggle());
    this.el.toggle?.addEventListener('click', () => void this.onToggle());
    this.el.editorClose?.addEventListener('click', () => this.closeEditor());
    this.el.editor?.querySelector('[data-note-editor-dismiss]')
      ?.addEventListener('click', () => this.closeEditor());
    this.el.editorSave?.addEventListener('click', () => void this.onSave());
    this.el.editorDelete?.addEventListener('click', () => void this.onDelete());
    // Named while it runs, so nothing is asked of the user after the fact.
    this.el.nameInput?.addEventListener('input', () => this.queueName());
    this.el.nameInput?.addEventListener('blur', () => this.commitName());
    this.el.nameInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); this.commitName(); }
    });
    this.el.editorText?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void this.onSave(); }
      if (event.key === 'Escape') { event.preventDefault(); this.closeEditor(); }
    });
  }

  /** Syncs the clock fields the ribbon scales against, mirroring RecordingTimer. */
  sync(phase: RecordingPhase, session?: RecordingStatusView): void {
    this.phase = phase;
    this.paused = session?.paused === true;
    this.recordedMs = session?.recordedMs ?? 0;
    this.runningSince =
      phase === 'recording' && session?.paused !== true ? (session?.runningSince ?? null) : null;
    this.render();
    if (this.runningSince != null && this.hasOpenSpan()) this.start();
    else this.stop();
  }

  /** Replaces the notation list (after a mark, an edit, or a fresh read). */
  setNotations(notations: RecordingNotation[]): void {
    this.notations = notations;
    // An edited span can disappear underneath the editor (deleted elsewhere).
    if (this.editingId && !notations.some((n) => n.id === this.editingId)) this.closeEditor();
    this.render();
    if (this.runningSince != null && this.hasOpenSpan()) this.start();
    else this.stop();
  }

  /** Stops the per-second tick (idempotent). */
  stop(): void {
    if (this.interval != null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Schedules the open note's name, so a burst of typing is one write. */
  private queueName(): void {
    if (this.nameTimer != null) clearTimeout(this.nameTimer);
    this.nameTimer = setTimeout(() => this.commitName(), NAME_COMMIT_MS);
  }

  private commitName(): void {
    if (this.nameTimer != null) { clearTimeout(this.nameTimer); this.nameTimer = null; }
    const open = this.openSpan();
    const value = this.el.nameInput?.value ?? '';
    if (!open || value === open.text) return;
    void this.actions.save(open.id, value);
  }

  /** True when the shortcut/toggle would end rather than start a note. */
  private openSpan(): RecordingNotation | undefined {
    return this.notations.find((notation) => notation.tEndMs == null);
  }

  private hasOpenSpan(): boolean {
    return this.openSpan() != null;
  }

  private elapsedMs(): number {
    return this.recordedMs + (this.runningSince != null ? Date.now() - this.runningSince : 0);
  }

  private async onToggle(): Promise<void> {
    const open = this.openSpan();
    if (open) await this.actions.end(open.id);
    else await this.actions.mark();
  }

  private async onSave(): Promise<void> {
    const id = this.editingId;
    if (!id) return;
    await this.actions.save(id, this.el.editorText?.value ?? '');
    this.closeEditor();
  }

  private async onDelete(): Promise<void> {
    const id = this.editingId;
    if (!id) return;
    this.closeEditor();
    await this.actions.remove(id);
  }

  private start(): void {
    if (this.interval != null) return;
    this.interval = setInterval(() => this.render(), TICK_MS);
  }

  private render(): void {
    const live = this.phase === 'recording' || this.phase === 'starting';
    const count = this.notations.length;
    const open = this.openSpan();

    // The row is the "nothing yet" affordance; once notes exist the ribbon owns
    // the interaction, so the row keeps only its count.
    if (this.el.count) {
      this.el.count.textContent = count === 0 ? 'NONE YET' : count === 1 ? '1 NOTE' : `${count} NOTES`;
    }
    // The row is one of two things: the affordance that starts a note, or the
    // note that is running. Never both.
    const naming = live && open != null;
    if (this.el.nameRow) this.el.nameRow.hidden = !naming;
    if (this.el.from) {
      this.el.from.hidden = !naming;
      if (open) this.el.from.textContent = `FROM ${formatPosition(open.tStartMs)}`;
    }
    if (this.el.startButton) this.el.startButton.hidden = naming;
    if (this.el.count) this.el.count.hidden = naming;
    // Never overwrite what is being typed; adopt the stored text otherwise.
    if (this.el.nameInput && open && document.activeElement !== this.el.nameInput) {
      this.el.nameInput.value = open.text;
    }
    if (this.el.startLabel) this.el.startLabel.textContent = open ? 'End note' : 'Make a note';
    if (this.el.startButton) {
      this.el.startButton.disabled = !live;
      this.el.startButton.title = open ? 'End this note (⌥M)' : 'Start a note (⌥M)';
    }
    // The tip has done its job once the user has made a note.
    if (this.el.hint) this.el.hint.hidden = count > 0 || !live;
    if (this.el.row) this.el.row.hidden = !live;

    if (this.el.ribbon) this.el.ribbon.hidden = count === 0 || !live;
    if (count === 0 || !live) { this.ribbon?.clear(); return; }

    // The whole track is the recording so far; the playhead is its right edge.
    const scale = Math.max(this.elapsedMs(), MIN_SCALE_MS);
    this.ribbon?.draw(this.notations, {
      scaleMs: scale,
      openEndsAtMs: this.elapsedMs(),
      activeId: this.editingId,
    });

    if (this.el.openTimer) {
      this.el.openTimer.hidden = !open;
      if (open) this.el.openTimer.textContent = formatDuration(this.elapsedMs() - open.tStartMs);
    }

    // Pausing holds an open note rather than ending it: the span stops growing
    // and says so, instead of silently continuing across a gap the media
    // never recorded.
    if (this.el.held) this.el.held.hidden = !(this.paused && open);
    if (this.paused && open) {
      if (this.el.heldStart) this.el.heldStart.textContent = formatPosition(open.tStartMs);
      if (this.el.heldText) this.el.heldText.textContent = open.text;
    }
    if (this.el.toggle) {
      this.el.toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
      this.el.toggle.title = open ? 'End this note (⌥M)' : 'Start a note (⌥M)';
      const label = this.el.toggle.querySelector('[data-note-toggle-label]');
      if (label) label.textContent = open ? 'End note' : 'Start a note';
    }
  }

  private openEditor(id: string): void {
    const notation = this.notations.find((candidate) => candidate.id === id);
    // An open span has no span to describe yet — end it first.
    if (!notation || notation.tEndMs == null) return;
    this.editingId = id;

    const index = this.notations.indexOf(notation) + 1;
    if (this.el.editorIndex) this.el.editorIndex.textContent = `NOTE ${index}`;
    if (this.el.editorRange) {
      this.el.editorRange.textContent =
        `${formatPosition(notation.tStartMs)} → ${formatPosition(notation.tEndMs)}`;
    }
    if (this.el.editorLength) {
      this.el.editorLength.textContent = formatDuration(notation.tEndMs - notation.tStartMs);
    }
    if (this.el.editorText) this.el.editorText.value = notation.text;
    if (this.el.editor) this.el.editor.hidden = false;
    this.el.editorText?.focus();
    this.el.editorText?.select();
    this.render();
  }

  private closeEditor(): void {
    this.editingId = null;
    if (this.el.editor) this.el.editor.hidden = true;
    this.render();
  }
}
