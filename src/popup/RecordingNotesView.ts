/**
 * @file popup/RecordingNotesView.ts
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
 * scaled to live elapsed time, which only grows while recording.
 */

import { formatDuration } from './popupStatus';
import type { RecordingNotation } from '../shared/notations';
import type { RecordingPhase, RecordingStatusView } from '../shared/recording';

/** The open span's length re-renders once per second, like the timer. */
const TICK_MS = 1000;

/** Keeps a just-started span visible before elapsed time has caught up to it. */
const MIN_SCALE_MS = 1000;

/**
 * Where "now" sits on the track. A live recording has no known end, so the
 * ribbon is scaled to leave headroom rather than pinning the playhead to the
 * right edge — which is what makes the unfilled part of the track mean
 * something. Taken from the design, where every span position resolves against
 * a playhead at exactly this fraction.
 */
const PLAYHEAD_FRACTION = 0.82;

export type RecordingNotesElements = {
  ribbon: HTMLElement | null;
  track: HTMLElement | null;
  elapsed: HTMLElement | null;
  playhead: HTMLElement | null;
  openTimer: HTMLElement | null;
  toggle: HTMLButtonElement | null;
  row: HTMLElement | null;
  startButton: HTMLButtonElement | null;
  startLabel: HTMLElement | null;
  count: HTMLElement | null;
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
  private recordedMs = 0;
  private runningSince: number | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private editingId: string | null = null;
  private spans = new Map<string, HTMLButtonElement>();

  private readonly el: Partial<RecordingNotesElements>;

  constructor(
    el: Partial<RecordingNotesElements> | null | undefined,
    private readonly actions: RecordingNotesActions,
  ) {
    // Every element in this popup is nullable; an absent group behaves the same
    // way, so a missing id degrades to an inert ribbon rather than a crash.
    this.el = el ?? {};
    this.el.startButton?.addEventListener('click', () => void this.onToggle());
    this.el.toggle?.addEventListener('click', () => void this.onToggle());
    this.el.editorClose?.addEventListener('click', () => this.closeEditor());
    this.el.editor?.querySelector('[data-note-editor-dismiss]')
      ?.addEventListener('click', () => this.closeEditor());
    this.el.editorSave?.addEventListener('click', () => void this.onSave());
    this.el.editorDelete?.addEventListener('click', () => void this.onDelete());
    this.el.editorText?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void this.onSave(); }
      if (event.key === 'Escape') { event.preventDefault(); this.closeEditor(); }
    });
  }

  /** Syncs the clock fields the ribbon scales against, mirroring RecordingTimer. */
  sync(phase: RecordingPhase, session?: RecordingStatusView): void {
    this.phase = phase;
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
    if (this.el.startLabel) this.el.startLabel.textContent = open ? 'End note' : 'Make a note';
    if (this.el.startButton) {
      this.el.startButton.disabled = !live;
      this.el.startButton.title = open ? 'End this note (⌥M)' : 'Start a note (⌥M)';
    }
    // The tip has done its job once the user has made a note.
    if (this.el.hint) this.el.hint.hidden = count > 0 || !live;
    if (this.el.row) this.el.row.hidden = !live;

    if (this.el.ribbon) this.el.ribbon.hidden = count === 0 || !live;
    if (count === 0 || !live) { this.spans.clear(); return; }

    const scale = Math.max(this.elapsedMs(), MIN_SCALE_MS) / PLAYHEAD_FRACTION;
    const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / scale) * 100))}%`;

    if (this.el.elapsed) this.el.elapsed.style.width = pct(this.elapsedMs());
    if (this.el.playhead) this.el.playhead.style.left = pct(this.elapsedMs());

    this.renderSpans(scale);

    if (this.el.openTimer) {
      this.el.openTimer.hidden = !open;
      if (open) this.el.openTimer.textContent = formatDuration(this.elapsedMs() - open.tStartMs);
    }
    if (this.el.toggle) {
      this.el.toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
      this.el.toggle.title = open ? 'End this note (⌥M)' : 'Start a note (⌥M)';
      const label = this.el.toggle.querySelector('[data-note-toggle-label]');
      if (label) label.textContent = open ? 'End note' : 'Start a note';
    }
  }

  /** Reconciles span elements in place so a click target survives the 1s tick. */
  private renderSpans(scale: number): void {
    const track = this.el.track;
    if (!track) return;
    const seen = new Set<string>();

    for (const notation of this.notations) {
      seen.add(notation.id);
      let span = this.spans.get(notation.id);
      if (!span) {
        span = document.createElement('button');
        span.type = 'button';
        span.className = 'note-span';
        span.addEventListener('click', () => this.openEditor(notation.id));
        track.appendChild(span);
        this.spans.set(notation.id, span);
      }
      const end = notation.tEndMs ?? this.elapsedMs();
      const left = (notation.tStartMs / scale) * 100;
      const width = Math.max(0, ((end - notation.tStartMs) / scale) * 100);
      span.style.left = `${Math.min(100, Math.max(0, left))}%`;
      span.style.width = `${Math.min(100 - left, width)}%`;
      span.classList.toggle('open', notation.tEndMs == null);
      span.classList.toggle('auto-ended', notation.endedBy === 'auto');
      span.classList.toggle('editing', this.editingId === notation.id);
      span.title = describeSpan(notation);
      span.setAttribute('aria-label', describeSpan(notation));
    }

    for (const [id, span] of this.spans) {
      if (seen.has(id)) continue;
      span.remove();
      this.spans.delete(id);
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
        `${formatDuration(notation.tStartMs)} → ${formatDuration(notation.tEndMs)}`;
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

/** "00:41 → 01:18 · Q3 target changed" — the ribbon's only label. */
function describeSpan(notation: RecordingNotation): string {
  const range = notation.tEndMs == null
    ? `${formatDuration(notation.tStartMs)} → …`
    : `${formatDuration(notation.tStartMs)} → ${formatDuration(notation.tEndMs)}`;
  return notation.text ? `${range} · ${notation.text}` : range;
}
