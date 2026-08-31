/**
 * @file popup/RecordingNotesDetail.ts
 *
 * The notes section of a finished recording's detail view (design `d1`): a
 * timeline of every span drawn against the recording's own duration, and the
 * "YOUR NOTES" list beneath it.
 *
 * Unlike the live ribbon (`RecordingNotesView`), this surface knows the
 * recording it belongs to, so it uses the keyed notation messages. It is also
 * the first place a note can be renamed after the fact — during a recording the
 * message editor does that job, but a note marked and never named has to be
 * reachable later.
 */

import { formatDuration } from './popupStatus';
import type { RecordingNotation } from '../shared/notations';

const PENCIL = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';
const CROSS = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M1.6 1.6l6.8 6.8M8.4 1.6l-6.8 6.8"/></svg>';

export type RecordingNotesDetailOptions = {
  /** Draw the span timeline above the list. Off where the surface has no room for it. */
  timeline?: boolean;
  /** Fold the list behind its heading, which then acts as a disclosure button. */
  collapsible?: boolean;
};

export type RecordingNotesDetailActions = {
  load: (recordingId: string) => Promise<RecordingNotation[]>;
  rename: (recordingId: string, id: string, text: string) => Promise<RecordingNotation[]>;
  remove: (recordingId: string, id: string) => Promise<RecordingNotation[]>;
};

export class RecordingNotesDetail {
  /** Only the detail build explains itself when empty; see `render`. */
  private readonly showsEmptyState: boolean;

  private readonly root = document.createElement('section');
  private readonly timeline = document.createElement('div');
  private readonly header = document.createElement('div');
  private readonly count = document.createElement('span');
  private readonly list = document.createElement('div');
  private readonly empty = document.createElement('div');
  private notations: RecordingNotation[] = [];
  private selectedId: string | null = null;

  constructor(
    private readonly recordingId: string,
    /** The recording's own length; spans are drawn against it. */
    private readonly durationMs: number | undefined,
    private readonly actions: RecordingNotesDetailActions,
    options: RecordingNotesDetailOptions = { timeline: true },
  ) {
    this.root.className = 'detail-notes';
    this.root.hidden = true;
    this.timeline.className = 'detail-notes-timeline';
    this.timeline.hidden = options.timeline !== true;
    this.showsEmptyState = options.timeline === true;

    const label = document.createElement('span');
    label.textContent = 'YOUR NOTES';
    this.count.className = 'detail-notes-count';

    if (options.collapsible) {
      // The heading itself is the disclosure, so the section costs one line
      // until someone wants the notes (n2a → n2c).
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'detail-notes-head detail-notes-toggle';
      button.setAttribute('aria-expanded', 'false');
      const right = document.createElement('span');
      right.className = 'detail-notes-head-right';
      right.append(this.count, chevron());
      button.append(label, right);
      button.addEventListener('click', () => this.toggle());
      this.header.appendChild(button);
      this.list.hidden = true;
    } else {
      this.header.className = 'detail-notes-head';
      this.header.append(label, this.count);
    }

    this.list.className = 'detail-notes-list';

    // A recording nobody noted still says so, and teaches the shortcut that
    // would have noted it (f4) — an absent section teaches nothing.
    this.empty.className = 'detail-notes-empty';
    this.empty.hidden = true;
    this.empty.innerHTML =
      '<div class="detail-notes-empty-title">No notes in this recording</div>'
      + '<div class="detail-notes-empty-body">Press <kbd>⌥M</kbd> during a call to mark a moment. '
      + 'The popup does not need to be open.</div>';

    this.root.append(this.timeline, this.header, this.list, this.empty);
  }

  private toggle(): void {
    const button = this.header.querySelector('.detail-notes-toggle');
    const open = button?.getAttribute('aria-expanded') === 'true';
    button?.setAttribute('aria-expanded', open ? 'false' : 'true');
    this.list.hidden = open;
  }

  /** The element to place in the detail view; it fills itself in once loaded. */
  get element(): HTMLElement {
    return this.root;
  }

  async load(): Promise<void> {
    try {
      this.notations = await this.actions.load(this.recordingId);
    } catch {
      // A detail view that cannot read its notes still shows the recording.
      this.notations = [];
    }
    this.render();
  }

  private render(): void {
    const empty = this.notations.length === 0;
    // The detail screen says so and teaches ⌥M (f4). The saved screen folds its
    // notes behind a heading, where an empty state would be noise right after a
    // recording the user chose not to note.
    const explains = empty && this.showsEmptyState;
    this.root.hidden = empty && !explains;
    this.empty.hidden = !explains;
    this.header.hidden = empty;
    this.list.hidden = empty || this.list.hidden;
    if (empty) {
      // The track stays, so the screen keeps its shape.
      this.timeline.replaceChildren(track());
      return;
    }

    this.count.textContent = String(this.notations.length);
    this.renderTimeline();
    this.renderList();
  }

  /**
   * Scaled to the recording's duration, so a span sits where it sits in the
   * file. Falls back to the last note's end when the duration is unknown —
   * legacy rows have no `durationMs`.
   */
  private scaleMs(): number {
    const fromNotes = this.notations.reduce(
      (max, notation) => Math.max(max, notation.tEndMs ?? notation.tStartMs),
      0,
    );
    return Math.max(this.durationMs ?? 0, fromNotes, 1);
  }

  private renderTimeline(): void {
    const scale = this.scaleMs();
    this.timeline.replaceChildren();

    this.timeline.appendChild(track());

    for (const notation of this.notations) {
      const span = document.createElement('button');
      span.type = 'button';
      span.className = 'detail-notes-span';
      // A note the run sealed on the way out reads as muted: it ended because
      // the recording did, not because the user closed it.
      span.classList.toggle('auto-ended', notation.endedBy === 'auto');
      span.classList.toggle('selected', notation.id === this.selectedId);
      const left = (notation.tStartMs / scale) * 100;
      const width = (((notation.tEndMs ?? notation.tStartMs) - notation.tStartMs) / scale) * 100;
      span.style.left = `${Math.min(100, Math.max(0, left))}%`;
      span.style.width = `${Math.max(1, Math.min(100 - left, width))}%`;
      span.title = describe(notation);
      span.setAttribute('aria-label', describe(notation));
      span.addEventListener('click', () => this.select(notation.id));
      this.timeline.appendChild(span);
    }

    if (this.selectedId) {
      const selected = this.notations.find((notation) => notation.id === this.selectedId);
      if (selected) {
        const marker = document.createElement('span');
        marker.className = 'detail-notes-marker';
        marker.style.left = `${Math.min(100, (selected.tStartMs / scale) * 100)}%`;
        this.timeline.appendChild(marker);
      }
    }
  }

  private renderList(): void {
    this.list.replaceChildren();
    for (const notation of this.notations) this.list.appendChild(this.renderRow(notation));
  }

  private renderRow(notation: RecordingNotation): HTMLElement {
    const row = document.createElement('div');
    row.className = 'detail-notes-row';
    row.classList.toggle('selected', notation.id === this.selectedId);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'detail-notes-row-main';
    main.addEventListener('click', () => this.select(notation.id));

    const start = document.createElement('span');
    start.className = 'detail-notes-start';
    start.textContent = formatDuration(notation.tStartMs);

    const text = document.createElement('span');
    text.className = 'detail-notes-text';
    // A note can be marked without a message; say so rather than showing a gap.
    if (notation.text) text.textContent = notation.text;
    else { text.textContent = 'Untitled note'; text.classList.add('untitled'); }
    main.append(start, text);

    const actions = document.createElement('span');
    actions.className = 'detail-notes-actions';
    const length = document.createElement('span');
    length.className = 'detail-notes-length';
    length.textContent = notation.tEndMs == null ? '—' : formatDuration(notation.tEndMs - notation.tStartMs);

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'detail-notes-edit';
    rename.title = 'Rename this note';
    rename.setAttribute('aria-label', `Rename note at ${formatDuration(notation.tStartMs)}`);
    rename.innerHTML = PENCIL;
    rename.addEventListener('click', () => this.startRename(row, notation));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'detail-notes-delete';
    remove.title = 'Delete this note';
    remove.setAttribute('aria-label', `Delete note at ${formatDuration(notation.tStartMs)}`);
    remove.innerHTML = CROSS;
    remove.addEventListener('click', () => void this.remove(notation.id));

    actions.append(length, rename, remove);
    row.append(main, actions);
    return row;
  }

  /** Swaps the row's label for an input, in place, so the list does not reflow. */
  private startRename(row: HTMLElement, notation: RecordingNotation): void {
    if (row.querySelector('.detail-notes-input')) return;
    const main = row.querySelector('.detail-notes-row-main');
    const text = row.querySelector('.detail-notes-text');
    if (!main || !text) return;

    const input = document.createElement('input');
    input.className = 'detail-notes-input';
    input.type = 'text';
    input.maxLength = 500;
    input.value = notation.text;
    input.setAttribute('aria-label', `Note at ${formatDuration(notation.tStartMs)}`);

    const commit = async (save: boolean) => {
      if (input.parentElement !== main) return;
      main.replaceChild(text, input);
      if (save && input.value.trim() !== notation.text) await this.rename(notation.id, input.value);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); void commit(true); }
      if (event.key === 'Escape') { event.preventDefault(); void commit(false); }
    });
    input.addEventListener('blur', () => void commit(true));

    main.replaceChild(input, text);
    input.focus();
    input.select();
  }

  private select(id: string): void {
    this.selectedId = this.selectedId === id ? null : id;
    this.render();
  }

  private async rename(id: string, text: string): Promise<void> {
    try {
      this.notations = await this.actions.rename(this.recordingId, id, text);
    } catch { /* the list stays as it was; the write simply did not land */ }
    this.render();
  }

  private async remove(id: string): Promise<void> {
    try {
      this.notations = await this.actions.remove(this.recordingId, id);
      if (this.selectedId === id) this.selectedId = null;
    } catch { /* as above */ }
    this.render();
  }
}

function track(): HTMLElement {
  const base = document.createElement('span');
  base.className = 'detail-notes-track';
  return base;
}

function chevron(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 10 10');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('detail-notes-chevron');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M3.5 2l3 3-3 3');
  svg.appendChild(path);
  return svg;
}

function describe(notation: RecordingNotation): string {
  const range = notation.tEndMs == null
    ? formatDuration(notation.tStartMs)
    : `${formatDuration(notation.tStartMs)} → ${formatDuration(notation.tEndMs)}`;
  return notation.text ? `${range} · ${notation.text}` : range;
}
