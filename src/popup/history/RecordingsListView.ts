/**
 * @file popup/history/RecordingsListView.ts
 *
 * The compact Recordings screen inside the popup: the three most recent
 * recordings, any upload still in flight above them, and the note spoiler on
 * each row (design n1).
 *
 * It owns the list's DOM and its reads. Opening a row is an action, because
 * where a row leads — the detail screen — is the caller's navigation, not this
 * list's business.
 */

import { DETAIL_OPEN_ICON, detailPercent } from './historyChrome';
import { formatDuration, formatPosition } from '../popupStatus';
import { sendToBackground } from '../../shared/messages';
import { describeNotationForList, type RecordingNotation } from '../../shared/notations';
import type { UploadJob } from '../../shared/recording';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';

const NOTE_CHIP_ICON = '<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';

/** The list shows at most this many rows; uploads take places from the top. */
const VISIBLE_ROWS = 3;

export type RecordingsListActions = {
  openRecording: (entry: RecordingHistoryEntry) => void;
  openUpload: (job: UploadJob) => void;
  /** One recording's notations — preview-aware, so the gallery needs no background. */
  loadNotations: (recordingId: string) => Promise<RecordingNotation[]>;
  /** How many notes each of these recordings has, in one read. */
  noteCounts: (entries: RecordingHistoryEntry[]) => Promise<Record<string, number>>;
  /** Uploads still running, which head the list. */
  activeUploads: () => UploadJob[];
};

export class RecordingsListView {
  constructor(private readonly actions: RecordingsListActions) {}

  /** Reads history and paints it. The layout appears first, so the screen never flashes empty. */
  async load(): Promise<void> {
    this.paintFrame();
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
      this.render(response.ok ? response.entries : []);
    } catch {
      this.render([]);
    }
  }

  /**
   * Presents the layout, optionally with entries already in hand — the preview's
   * path, and the first paint of {@link load}.
   */
  paintFrame(entries?: RecordingHistoryEntry[]): boolean {
    const recordings = document.getElementById('view-recordings');
    if (!recordings) return false;
    recordings.hidden = false;
    const list = document.getElementById('popup-recordings-list');
    if (list) list.replaceChildren();
    if (entries) this.render(entries);
    return true;
  }

  render(entries: RecordingHistoryEntry[]): void {
    const list = document.getElementById('popup-recordings-list');
    const empty = document.getElementById('popup-recordings-empty');
    if (!list || !empty) return;
    list.replaceChildren();
    const uploads = this.actions.activeUploads();
    for (const job of uploads) list.appendChild(this.uploadRow(job));
    const visible = entries.slice(0, Math.max(0, VISIBLE_ROWS - uploads.length));
    empty.hidden = uploads.length > 0 || visible.length > 0;
    for (const entry of visible) list.appendChild(this.recordingRow(entry));
    if (visible.length) void this.paintNoteCounts(visible);
  }

  /** The badge beside the Recordings link, which is visible from every screen. */
  async refreshCount(): Promise<void> {
    const count = document.getElementById('recordings-count');
    if (!count) return;
    try {
      const response = await sendToBackground({ type: 'LIST_RECORDING_HISTORY' });
      if (!response.ok) return;
      count.textContent = String(response.entries.length);
      count.hidden = false;
    } catch {
      count.hidden = true;
    }
  }

  private recordingRow(entry: RecordingHistoryEntry): HTMLElement {
    const row = document.createElement('div');
    row.className = 'popup-recording-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open ${entry.name}`);
    const openDetail = () => this.actions.openRecording(entry);
    row.addEventListener('click', openDetail);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(); }
    });
    const copy = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'popup-recording-title';
    title.textContent = entry.name;
    const meta = document.createElement('div');
    meta.className = 'popup-recording-meta';
    meta.textContent = `${entry.files.length} ${entry.files.length === 1 ? 'FILE' : 'FILES'} · ${new Date(entry.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toUpperCase()}`;
    copy.append(title, meta);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'popup-recording-open';
    open.setAttribute('aria-label', `Open ${entry.name}`);
    // This is the supplied design's source icon, kept as a real SVG control rather
    // than the word “Open”, so popup history rows retain their compact 52px rhythm.
    open.innerHTML = DETAIL_OPEN_ICON;
    open.addEventListener('click', (event) => { event.stopPropagation(); openDetail(); });

    // Notes live under a spoiler on the row: the chip says how many, tapping it
    // reveals them, and each line opens the recording (n1). The chip stays
    // hidden until the count arrives, so an unnoted row looks untouched.
    const notes = document.createElement('div');
    notes.className = 'popup-recording-notes';
    notes.hidden = true;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'popup-recording-note-chip';
    chip.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
    chip.innerHTML = `${NOTE_CHIP_ICON}<span></span>`;
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.toggleRowNotes(entry, chip, notes);
    });

    const actions = document.createElement('span');
    actions.className = 'popup-recording-actions';
    actions.append(chip, open);

    const head = document.createElement('div');
    head.className = 'popup-recording-head';
    head.append(copy, actions);
    row.append(head, notes);
    row.dataset.recordingId = entry.id;
    return row;
  }

  /** Expands or collapses a row's notes, reading them the first time it opens. */
  private async toggleRowNotes(
    entry: RecordingHistoryEntry,
    chip: HTMLButtonElement,
    notes: HTMLElement,
  ): Promise<void> {
    const expanded = chip.getAttribute('aria-expanded') === 'true';
    chip.setAttribute('aria-expanded', expanded ? 'false' : 'true');
    notes.hidden = expanded;
    if (expanded || notes.childElementCount) return;

    let notations: RecordingNotation[];
    try {
      notations = await this.actions.loadNotations(entry.id);
    } catch {
      notes.hidden = true;
      chip.setAttribute('aria-expanded', 'false');
      return;
    }
    for (const notation of notations) {
      const line = document.createElement('button');
      line.type = 'button';
      line.className = 'popup-recording-note';
      const at = document.createElement('span');
      at.className = 'popup-recording-note-at';
      at.textContent = formatPosition(notation.tStartMs);
      const text = document.createElement('span');
      text.className = 'popup-recording-note-text';
      // No length column on this line, so the label carries the length itself.
      if (!notation.text) text.classList.add('unnamed');
      text.textContent = describeNotationForList(notation, formatDuration);
      line.append(at, text);
      line.addEventListener('click', (event) => {
        event.stopPropagation();
        this.actions.openRecording(entry);
      });
      notes.appendChild(line);
    }
  }

  /** Fills in the note-count chips for the rendered rows in one read. */
  private async paintNoteCounts(entries: RecordingHistoryEntry[]): Promise<void> {
    const counts = await this.actions.noteCounts(entries);

    // Matched in JS rather than through a selector: a recording id is not a
    // valid CSS identifier, and CSS.escape does not exist outside a browser.
    for (const row of Array.from(document.querySelectorAll<HTMLElement>('.popup-recording-row'))) {
      const count = counts[row.dataset.recordingId ?? ''] ?? 0;
      const chip = row.querySelector<HTMLButtonElement>('.popup-recording-note-chip');
      if (!chip || !count) continue;
      chip.hidden = false;
      chip.title = count === 1 ? '1 note' : `${count} notes`;
      const label = chip.querySelector('span');
      if (label) label.textContent = String(count);
    }
  }

  /** Active uploads are first-class entries in the compact Recordings list. */
  private uploadRow(job: UploadJob): HTMLElement {
    const row = document.createElement('div');
    row.className = 'popup-recording-upload';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open upload ${job.label}`);
    const openDetail = () => this.actions.openUpload(job);
    row.addEventListener('click', openDetail);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(); }
    });
    const head = document.createElement('div');
    head.className = 'popup-recording-upload-head';
    const title = document.createElement('span');
    title.textContent = job.label;
    const status = document.createElement('span');
    const percent = detailPercent(job.progress);
    status.textContent = `UPLOADING ${percent}%`;
    head.append(title, status);
    const track = document.createElement('div');
    track.className = 'popup-recording-upload-track';
    const fill = document.createElement('span');
    fill.style.width = `${percent}%`;
    track.append(fill);
    row.append(head, track);
    return row;
  }
}
