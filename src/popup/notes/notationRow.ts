/**
 * @file popup/notes/notationRow.ts
 *
 * One line of a notes list: when the note starts, what it says, and how long it
 * ran. Two surfaces show it — a finished recording's detail view, where the row
 * is selectable and can be renamed or deleted, and the interrupted-run notice,
 * where it is a read-only report.
 *
 * A note nobody named reads as an invitation rather than a label — the design's
 * "Name this one" — because on this row the length column already says how long
 * it ran. The compact one-line lists elsewhere have no such column, so they fold
 * the length into the label instead (`describeNotationForList`).
 */

import { formatDuration, formatPosition } from '../popupStatus';
import type { RecordingNotation } from '../../shared/notations';

/** What the design puts in a note nobody named: an invitation, not a label. */
const UNNAMED_NOTE = 'Name this one';

const PENCIL = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';
const CROSS = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M1.6 1.6l6.8 6.8M8.4 1.6l-6.8 6.8"/></svg>';

export type NotationRowActions = {
  select: (id: string) => void;
  /** Given the row so the rename can happen in place, without a reflow. */
  rename: (row: HTMLElement, notation: RecordingNotation) => void;
  remove: (id: string) => void;
};

export type NotationRowOptions = {
  selected?: boolean;
  /**
   * Where capture stopped. A span the run sealed then reports where it ended
   * rather than how long it ran — on that screen the end is the news.
   */
  sealedAtMs?: number;
  /** Present = the row is selectable and carries its rename/delete controls. */
  actions?: NotationRowActions;
};

export function notationRow(notation: RecordingNotation, options: NotationRowOptions = {}): HTMLElement {
  const row = document.createElement('div');
  row.className = 'detail-notes-row';
  row.classList.toggle('selected', options.selected === true);
  // The whole row is tinted, not just its text — the design bands an unnamed
  // note so it reads as an open item in a list of finished ones.
  row.classList.toggle('untitled', !notation.text);

  const main = document.createElement(options.actions ? 'button' : 'span');
  main.className = 'detail-notes-row-main';
  if (main instanceof HTMLButtonElement) {
    main.type = 'button';
    main.addEventListener('click', () => options.actions?.select(notation.id));
  }

  const start = document.createElement('span');
  start.className = 'detail-notes-start';
  start.textContent = formatPosition(notation.tStartMs);

  const text = document.createElement('span');
  text.className = 'detail-notes-text';
  // A note can be marked without a message; say so rather than showing a gap.
  if (notation.text) {
    text.textContent = notation.text;
  } else {
    text.classList.add('untitled');
    text.textContent = UNNAMED_NOTE;
  }
  main.append(start, text);

  const length = document.createElement('span');
  length.className = 'detail-notes-length';
  length.textContent = lengthLabel(notation, options.sealedAtMs);

  // The actions wrapper only exists where there are actions to hold: it carries
  // its own padding, so an empty one would shift the read-only row.
  if (!options.actions) {
    row.append(main, length);
    return row;
  }

  const actions = document.createElement('span');
  actions.className = 'detail-notes-actions';
  actions.append(
    length,
    iconButton('detail-notes-edit', PENCIL, 'Rename this note', `Rename note at ${formatPosition(notation.tStartMs)}`,
      () => options.actions?.rename(row, notation)),
    iconButton('detail-notes-delete', CROSS, 'Delete this note', `Delete note at ${formatPosition(notation.tStartMs)}`,
      () => options.actions?.remove(notation.id)),
  );
  row.append(main, actions);
  return row;
}

function lengthLabel(notation: RecordingNotation, sealedAtMs?: number): string {
  if (sealedAtMs != null && notation.endedBy === 'auto') return `ENDED AT ${formatPosition(sealedAtMs)}`;
  return notation.tEndMs == null ? '—' : formatDuration(notation.tEndMs - notation.tStartMs);
}

function iconButton(
  className: string,
  icon: string,
  title: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.title = title;
  button.setAttribute('aria-label', label);
  button.innerHTML = icon;
  button.addEventListener('click', onClick);
  return button;
}
