/**
 * @file recordings/RecordingNotesSection.ts
 *
 * The notes a recording carries, inside the recordings page's detail modal
 * (design `f2`): a timeline of every span against the recording's length, and
 * NOTES — a spoiler whose header folds the list to a one-line range.
 *
 * Deleting a note is the cheap loss, so it is confirmed in the row rather than
 * by a modal (`f17`): the row arms, the name strikes through, and Keep / Delete
 * take the length's place. The delete then waits eight seconds behind an UNDO
 * toast before it is written, so undoing it costs nothing.
 */

import { NotationRibbon } from '../popup/notes/notationRibbon';
import type { RecordingNotation } from '../shared/notations';

export type RecordingNotesSectionActions = {
  load: (recordingId: string) => Promise<RecordingNotation[]>;
  rename: (recordingId: string, id: string, text: string) => Promise<RecordingNotation[]>;
  remove: (recordingId: string, id: string) => Promise<RecordingNotation[]>;
  /** Shows the page's UNDO toast; resolves true when the user took it back. */
  offerUndo: (message: string, windowMs: number) => Promise<boolean>;
  /** Opens the note editor (f5, f6): ADD beside the count. Absent, there is no ADD. */
  openEditor?: () => void;
};

export type RecordingNotesSectionOptions = {
  /**
   * The list alone, always open (f6): the note editor supplies its own
   * timeline and header, so this section's would be a second copy.
   */
  bare?: boolean;
};

/** A span being made in the editor, listed among the saved notes while it runs (f6). */
export type OpenSpanRow = {
  tStartMs: number;
  text: string;
  /** Its pencil: the name is typed in the editor's composer, so this goes there. */
  onRename?: () => void;
  /** Its ×: throws the span away. */
  onDiscard?: () => void;
};

/** How long a deleted note can be taken back (f17). */
export const NOTE_UNDO_MS = 8_000;

const PENCIL = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';
const CROSS = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M1.6 1.6l6.8 6.8M8.4 1.6l-6.8 6.8"/></svg>';
const PLUS = '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M5 1.5v7M1.5 5h7"/></svg>';
const CHEVRON = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>';

/** A note nobody named is an invitation in this list, as it is everywhere (d1). */
const UNNAMED = 'Name this one';

/** `mm:ss` positions, padded so a column of them lines up (00:48, 18:02). */
function position(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A length reads on its own, so it is not padded: `0:37`, `1:04`. */
function length(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

export class RecordingNotesSection {
  readonly element = document.createElement('section');
  private readonly timeline = document.createElement('div');
  private readonly ribbon: NotationRibbon;
  private readonly header = document.createElement('div');
  private readonly toggle = document.createElement('button');
  private readonly count = document.createElement('span');
  private readonly range = document.createElement('div');
  private readonly list = document.createElement('div');
  private notations: RecordingNotation[] = [];
  private open = true;
  private selectedId: string | null = null;
  private armedId: string | null = null;
  private renamingId: string | null = null;
  /** Notes deleted but still inside their undo window: hidden, not yet written. */
  private readonly pendingDelete = new Set<string>();
  private openSpan: OpenSpanRow | null = null;
  private readonly bare: boolean;

  constructor(
    private readonly recordingId: string,
    private readonly durationMs: number | undefined,
    private readonly actions: RecordingNotesSectionActions,
    options: RecordingNotesSectionOptions = {},
  ) {
    this.bare = options.bare === true;
    this.element.className = `detail-notes${this.bare ? ' detail-notes--bare' : ''}`;
    this.element.hidden = true;
    this.timeline.className = 'detail-notes__timeline';
    const track = document.createElement('span');
    track.className = 'detail-notes__track';
    this.timeline.append(track);
    this.ribbon = new NotationRibbon(this.timeline, {
      spanClass: 'detail-notes__span',
      minWidthPct: 1,
      activeClass: 'detail-notes__span--selected',
      // Clicking any span opens the list again and selects its note (f2).
      onSelect: (id) => { this.open = true; this.select(id); },
    });

    this.header.className = 'detail-notes__header';
    this.toggle.type = 'button';
    this.toggle.className = 'detail-notes__toggle';
    this.toggle.title = 'Show or hide the note list';
    this.toggle.innerHTML = CHEVRON;
    const label = document.createElement('span');
    label.className = 'detail-notes__label';
    label.textContent = 'NOTES';
    this.count.className = 'detail-notes__count';
    this.toggle.append(label, this.count);
    this.toggle.addEventListener('click', () => { this.open = !this.open; this.render(); });
    this.header.append(this.toggle);
    if (actions.openEditor) {
      // ADD beside the count opens the editor (f2 → f5).
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'detail-notes__add';
      add.title = 'Add a note to this recording';
      add.innerHTML = PLUS;
      add.append('ADD');
      add.addEventListener('click', () => actions.openEditor?.());
      this.header.append(add);
    }
    this.range.className = 'detail-notes__range';
    this.list.className = 'detail-notes__list';
    // Bare, the editor's own timeline and footer stand in for these (f6).
    if (this.bare) this.element.append(this.list);
    else this.element.append(this.timeline, this.header, this.range, this.list);
  }

  async load(): Promise<void> {
    try {
      this.notations = await this.actions.load(this.recordingId);
    } catch {
      // The modal still describes the recording without its notes.
      this.notations = [];
    }
    this.render();
  }

  private visible(): RecordingNotation[] {
    return this.notations.filter((notation) => !this.pendingDelete.has(notation.id));
  }

  /** Lists the editor's span in progress among the saved notes, or takes it away (f6). */
  setOpenSpan(span: OpenSpanRow | null): void {
    this.openSpan = span;
    this.render();
  }

  /** The saved notes as this section last read them. */
  get notes(): RecordingNotation[] {
    return this.visible();
  }

  private render(): void {
    const notes = this.visible();
    // With nothing noted the track stays, empty, beside ADD, so the absence is
    // legible rather than hidden (f4); without ADD there is nothing to show.
    const empty = notes.length === 0 && !(this.bare && this.openSpan);
    this.element.hidden = empty && (!this.actions.openEditor || this.bare);
    this.element.classList.toggle('detail-notes--empty', empty);
    if (empty) {
      this.ribbon.clear();
      this.count.textContent = '0';
      this.toggle.disabled = true;
      this.range.hidden = true;
      this.list.hidden = true;
      return;
    }
    this.toggle.disabled = false;
    if (this.bare) {
      this.list.hidden = false;
      this.list.replaceChildren(...this.rows(notes));
      return;
    }
    const scale = Math.max(this.durationMs ?? 0, ...notes.map((n) => n.tEndMs ?? n.tStartMs), 1);
    this.ribbon.draw(notes, { scaleMs: scale, activeId: this.selectedId });
    this.count.textContent = String(notes.length);
    this.toggle.setAttribute('aria-expanded', String(this.open));
    // Folded, the list becomes one line: where the notes run, and how many lack a name.
    const unnamed = notes.filter((n) => !n.text).length;
    const first = notes[0];
    const last = notes[notes.length - 1];
    this.range.textContent = `${position(first.tStartMs)} → ${position(last.tStartMs)} · ${notes.length - unnamed} named${unnamed ? `, ${unnamed} unnamed` : ''}`;
    this.range.hidden = this.open;
    this.list.hidden = !this.open;
    if (this.open) this.list.replaceChildren(...this.rows(notes));
  }

  /** The saved rows, with the editor's running span slotted in at its start. */
  private rows(notes: RecordingNotation[]): HTMLElement[] {
    const rows = notes.map((notation) => this.row(notation));
    if (!this.openSpan) return rows;
    const at = notes.findIndex((notation) => notation.tStartMs > this.openSpan!.tStartMs);
    rows.splice(at < 0 ? rows.length : at, 0, this.openRow(this.openSpan));
    return rows;
  }

  /** The span being made (f6): tinted, its start in bold, `running` where the length goes. */
  private openRow(span: OpenSpanRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'detail-notes__row detail-notes__row--open';
    row.title = 'Open, being named below';
    const main = document.createElement('span');
    main.className = 'detail-notes__main';
    const at = document.createElement('span');
    at.className = 'detail-notes__at';
    at.textContent = position(span.tStartMs);
    const text = document.createElement('span');
    text.className = `detail-notes__text${span.text ? '' : ' detail-notes__text--unnamed'}`;
    text.textContent = span.text || UNNAMED;
    main.append(at, text);
    const side = document.createElement('span');
    side.className = 'detail-notes__side';
    const running = document.createElement('span');
    running.className = 'detail-notes__length';
    running.textContent = 'running';
    side.append(
      running,
      this.iconButton('detail-notes__edit', PENCIL, 'Name this note', () => span.onRename?.()),
      this.iconButton('detail-notes__delete', CROSS, 'Discard this note', () => span.onDiscard?.()),
    );
    row.append(main, side);
    return row;
  }

  private row(notation: RecordingNotation): HTMLElement {
    const row = document.createElement('div');
    row.className = 'detail-notes__row';
    row.classList.toggle('detail-notes__row--selected', notation.id === this.selectedId);
    row.classList.toggle('detail-notes__row--unnamed', !notation.text);
    const armed = notation.id === this.armedId;
    row.classList.toggle('detail-notes__row--armed', armed);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'detail-notes__main';
    main.addEventListener('click', () => this.select(notation.id));
    const at = document.createElement('span');
    at.className = 'detail-notes__at';
    at.textContent = position(notation.tStartMs);
    main.append(at);
    if (notation.id === this.renamingId) {
      main.append(this.renameField(notation));
    } else {
      const text = document.createElement('span');
      text.className = 'detail-notes__text';
      text.textContent = notation.text || UNNAMED;
      main.append(text);
    }

    const side = document.createElement('span');
    side.className = 'detail-notes__side';
    if (armed) {
      const ask = document.createElement('span');
      ask.className = 'detail-notes__ask';
      ask.textContent = 'Delete this note?';
      const keep = this.textButton('detail-notes__keep', 'Keep', () => { this.armedId = null; this.render(); });
      const remove = this.textButton('detail-notes__confirm', 'Delete', () => void this.remove(notation));
      side.append(ask, keep, remove);
      requestAnimationFrame(() => keep.focus());
    } else {
      const span = document.createElement('span');
      span.className = 'detail-notes__length';
      span.textContent = notation.tEndMs == null ? '—' : length(notation.tEndMs - notation.tStartMs);
      side.append(
        span,
        this.iconButton('detail-notes__edit', PENCIL, 'Rename this note', () => { this.renamingId = notation.id; this.armedId = null; this.render(); }),
        this.iconButton('detail-notes__delete', CROSS, 'Delete this note', () => { this.armedId = notation.id; this.renamingId = null; this.render(); }),
      );
    }
    row.append(main, side);
    return row;
  }

  /** Enter commits, Escape reverts (f18's rule, applied to the list). */
  private renameField(notation: RecordingNotation): HTMLInputElement {
    const input = document.createElement('input');
    input.className = 'detail-notes__input';
    input.type = 'text';
    input.maxLength = 500;
    input.value = notation.text;
    input.placeholder = UNNAMED;
    input.setAttribute('aria-label', `Name the note at ${position(notation.tStartMs)}`);
    let settled = false;
    const finish = async (save: boolean) => {
      if (settled) return;
      settled = true;
      this.renamingId = null;
      if (save && input.value.trim() !== notation.text) {
        try { this.notations = await this.actions.rename(this.recordingId, notation.id, input.value.trim()); } catch { /* unchanged */ }
      }
      this.render();
    };
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => void finish(true));
    requestAnimationFrame(() => { input.focus(); input.select(); });
    return input;
  }

  private select(id: string): void {
    this.selectedId = this.selectedId === id ? null : id;
    this.render();
    if (this.selectedId) this.list.querySelector('.detail-notes__row--selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** Hidden at once, written only once the undo window has passed untouched. */
  private async remove(notation: RecordingNotation): Promise<void> {
    this.armedId = null;
    this.pendingDelete.add(notation.id);
    if (this.selectedId === notation.id) this.selectedId = null;
    this.render();
    const label = notation.text ? `“${notation.text}” deleted` : `Note at ${position(notation.tStartMs)} deleted`;
    const undone = await this.actions.offerUndo(label, NOTE_UNDO_MS);
    this.pendingDelete.delete(notation.id);
    if (!undone) {
      try { this.notations = await this.actions.remove(this.recordingId, notation.id); } catch { /* it stays */ }
    }
    this.render();
  }

  private textButton(className: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return button;
  }

  private iconButton(className: string, icon: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.innerHTML = icon;
    button.addEventListener('click', (event) => { event.stopPropagation(); onClick(); });
    return button;
  }
}
