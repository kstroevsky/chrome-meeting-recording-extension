import type { DriveFolderPreset } from '../shared/settings';
import { createListboxSelect, type ListboxSelect } from '../ui/listboxSelect';
import {
  dayLabel,
  durationOf,
  formatDuration,
  formatDurationMs,
  formatSize,
  formatTime,
  fullDate,
  sizeOf,
  statusLabel,
  streamLabel,
  withHit,
} from './recordingsFormat';
import { checkIcon, cloudIcon, diskIcon, editIcon } from './recordingsIcons';
import type { RecordingNotationSummary } from '../shared/notations';
import type { RecordingHistoryEntry, RecordingHistoryFile } from '../shared/recordingHistory';

export type RecordingsViewCallbacks = {
  rename: (id: string, name: string) => void;
  note: (id: string, note: string) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  openLocal: (recordingId: string, fileId: string) => void;
  fileTo: (recordingId: string, presetId: string | null) => void;
  play: (recordingId: string) => void;
  loadMore: () => void;
};

type Sort = 'time-desc' | 'time-asc' | 'name' | 'duration' | 'size' | 'notes';

const NOTE_CHIP_ICON = '<svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';


const $ = (tag: string, className?: string): HTMLElement => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
};
















/** DOM-only renderer for the standalone, paged recordings history. */
export class RecordingsView {
  private entries: RecordingHistoryEntry[] = [];
  private hasMore = false;
  private query = '';
  private sort: Sort = 'time-desc';
  private selected = new Set<string>();
  /** Note counts + searchable note text per recording (ADR-0005). */
  private noteSummaries: Record<string, RecordingNotationSummary> = {};

  /**
   * Supplies the notes digest for the loaded page. Repainting is the caller's
   * job — it owns the entry list `render` needs.
   */
  setNoteSummaries(summaries: Record<string, RecordingNotationSummary>): void {
    this.noteSummaries = summaries;
  }
  private openId: string | null = null;
  private destinations: DriveFolderPreset[] = [];
  /** The open modal's picker, torn down with the modal so its listeners go too. */
  private destinationListbox: ListboxSelect | null = null;
  private editingId: string | null = null;

  constructor(
    private readonly list: HTMLElement,
    private readonly empty: HTMLElement,
    private readonly error: HTMLElement,
    private readonly loadMoreButton: HTMLButtonElement,
    private readonly callbacks: RecordingsViewCallbacks,
  ) {
    this.loadMoreButton.addEventListener('click', () => this.callbacks.loadMore());
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (this.editingId) {
        this.editingId = null;
        this.redraw();
      } else if (this.openId) {
        this.openId = null;
        this.redraw();
      } else if (this.selected.size) {
        this.selected.clear();
        this.redraw();
      }
    });
  }

  render(entries: RecordingHistoryEntry[], hasMore = false) {
    this.entries = entries;
    this.hasMore = hasMore;
    const validIds = new Set(entries.map((entry) => entry.id));
    this.selected = new Set([...this.selected].filter((id) => validIds.has(id)));
    if (this.openId && !validIds.has(this.openId)) this.openId = null;
    if (this.editingId && !validIds.has(this.editingId)) this.editingId = null;
    this.redraw();
  }

  showError(message = '') { this.error.textContent = message; this.error.hidden = !message; }

  private redraw({ focusSearch = false } = {}) {
    // The picker owns document-level listeners; a redraw discards its element,
    // so it has to be torn down here rather than only when a new one is built.
    this.destinationListbox?.destroy();
    this.destinationListbox = null;
    this.list.replaceChildren();
    this.empty.hidden = this.entries.length > 0;
    this.loadMoreButton.hidden = !this.hasMore;
    if (!this.entries.length) return;

    const visible = this.visibleEntries();
    this.list.append(this.selected.size ? this.bulkToolbar() : this.searchToolbar(visible.length, focusSearch));
    this.list.append(this.table(visible));
    const openEntry = this.entries.find((entry) => entry.id === this.openId);
    if (openEntry) this.list.append(this.detail(openEntry));
  }

  private visibleEntries(): RecordingHistoryEntry[] {
    const query = this.query.trim().toLocaleLowerCase();
    const filtered = this.entries.filter((entry) => !query
      || `${entry.name} ${entry.note ?? ''} ${this.noteSummaries[entry.id]?.search ?? ''}`
        .toLocaleLowerCase().includes(query));
    return [...filtered].sort((left, right) => {
      if (this.sort === 'time-desc') return right.createdAt - left.createdAt;
      if (this.sort === 'time-asc') return left.createdAt - right.createdAt;
      if (this.sort === 'name') return left.name.localeCompare(right.name);
      if (this.sort === 'notes') {
        return (this.noteSummaries[right.id]?.count ?? 0) - (this.noteSummaries[left.id]?.count ?? 0);
      }
      if (this.sort === 'duration') return (durationOf(right) ?? -1) - (durationOf(left) ?? -1);
      return sizeOf(right) - sizeOf(left);
    });
  }

  private searchToolbar(count: number, focusSearch: boolean): HTMLElement {
    const toolbar = $('div', 'recordings-toolbar');
    const search = document.createElement('input');
    search.className = 'recording-search';
    search.type = 'search';
    search.value = this.query;
    search.placeholder = 'Search name or note…';
    search.setAttribute('aria-label', 'Search recordings');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.redraw({ focusSearch: true });
    });
    const total = $('span', 'recordings-count');
    // While searching, the count is only useful next to what it was drawn from,
    // and saying where the match came from is the point of the split below (f2).
    total.textContent = this.query.trim()
      ? `${count} OF ${this.entries.length} · IN NAMES AND NOTES`
      : `${count} RECORDING${count === 1 ? '' : 'S'}`;
    toolbar.append(search, total);
    if (focusSearch) requestAnimationFrame(() => {
      const currentSearch = this.list.querySelector<HTMLInputElement>('.recording-search');
      currentSearch?.focus();
      currentSearch?.setSelectionRange(currentSearch.value.length, currentSearch.value.length);
    });
    return toolbar;
  }

  private bulkToolbar(): HTMLElement {
    const toolbar = $('div', 'bulk-toolbar');
    const count = $('span', 'bulk-toolbar__count');
    count.textContent = `${this.selected.size} SELECTED`;
    const actions = $('div', 'bulk-toolbar__actions');
    const selection = this.entries.filter((entry) => this.selected.has(entry.id));
    const canOpen = selection.some((entry) => entry.files.some((file) =>
      (file.destination === 'drive' && file.webViewLink) || (file.destination === 'local' && file.downloadId && file.status === 'available')));

    const move = document.createElement('button');
    move.className = 'bulk-button bulk-button--primary';
    move.type = 'button';
    move.textContent = 'Move to Drive';
    move.disabled = true;
    move.title = 'Moving completed local files to Google Drive is not available after capture.';

    const open = document.createElement('button');
    open.className = 'bulk-button bulk-button--ghost';
    open.type = 'button';
    open.textContent = 'Download';
    open.disabled = !canOpen;
    open.addEventListener('click', () => this.openSelected(selection));

    const remove = document.createElement('button');
    remove.className = 'bulk-button bulk-button--ghost';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      const ids = [...this.selected];
      this.selected.clear();
      this.redraw();
      this.callbacks.removeMany(ids);
    });

    const clear = document.createElement('button');
    clear.className = 'bulk-clear';
    clear.type = 'button';
    clear.title = 'Clear selection';
    clear.setAttribute('aria-label', 'Clear selection');
    clear.textContent = '×';
    clear.addEventListener('click', () => { this.selected.clear(); this.redraw(); });
    actions.append(move, open, remove, clear);
    toolbar.append(count, actions);
    return toolbar;
  }

  private table(entries: RecordingHistoryEntry[]): HTMLElement {
    const table = $('section', 'recording-table');
    const header = $('div', 'recording-table__header');
    const allSelected = entries.length > 0 && entries.every((entry) => this.selected.has(entry.id));
    const master = this.selectionBox(allSelected, 'Select all shown');
    master.addEventListener('click', () => {
      if (allSelected) entries.forEach((entry) => this.selected.delete(entry.id));
      else entries.forEach((entry) => this.selected.add(entry.id));
      this.redraw();
    });
    header.append(master, $('span'), this.headerButton('NAME', 'name'), this.headerButton('NOTES', 'notes'), this.headerButton('DUR', 'duration', true), this.headerButton('SIZE', 'size', true));
    const destination = $('span', 'table-header-text'); destination.textContent = 'DEST';
    header.append(destination, this.headerButton('TIME', 'time', true), $('span'));
    table.append(header);

    const scroll = $('div', 'recording-table__scroll');
    if (!entries.length) {
      const empty = $('div', 'recording-no-results');
      empty.textContent = `NO RECORDINGS MATCH “${this.query.toUpperCase()}”`;
      scroll.append(empty);
    } else {
      for (const group of this.groups(entries)) {
        const day = $('div', `recording-day${group.plain ? ' recording-day--match' : ''}`);
        const label = $('span', 'recording-day__label'); label.textContent = group.label;
        const count = $('span', 'recording-day__count');
        count.textContent = group.plain ? '' : String(group.entries.length);
        day.append(label, count);
        scroll.append(day);
        group.entries.forEach((entry) => scroll.append(this.row(entry)));
      }
    }
    table.append(scroll);
    return table;
  }

  private headerButton(label: string, key: 'name' | 'duration' | 'notes' | 'size' | 'time', right = false): HTMLButtonElement {
    const active = (key === 'time' && this.sort.startsWith('time')) || this.sort === key;
    const button = document.createElement('button');
    button.className = `table-header-button${right ? ' table-header-button--right' : ''}${active ? ' table-header-button--active' : ''}${key === 'notes' ? ' table-header-button--notes' : ''}`;
    button.type = 'button';
    button.textContent = label;
    if (active) {
      const arrow = $('span', 'table-header-button__arrow');
      arrow.textContent = this.sort === 'time-asc' ? '▴' : '▾';
      button.append(arrow);
    }
    button.addEventListener('click', () => {
      this.sort = key === 'time'
        ? (this.sort === 'time-desc' ? 'time-asc' : 'time-desc')
        : key;
      this.redraw();
    });
    return button;
  }

  /** True when the query matched this recording's notes rather than its name. */
  private matchedInNotes(entry: RecordingHistoryEntry, query: string): boolean {
    return (this.noteSummaries[entry.id]?.search ?? '').toLocaleLowerCase().includes(query);
  }

  private groups(entries: RecordingHistoryEntry[]): Array<{ label: string; entries: RecordingHistoryEntry[]; plain?: true }> {
    // A note match is the more interesting of the two and needs saying, so a
    // search groups by where the hit landed rather than by day (f2).
    const query = this.query.trim().toLocaleLowerCase();
    if (query) {
      const inNotes = entries.filter((entry) => this.matchedInNotes(entry, query));
      const inName = entries.filter((entry) => !this.matchedInNotes(entry, query));
      return [
        ...(inNotes.length ? [{ label: 'MATCHED IN NOTES', entries: inNotes, plain: true as const }] : []),
        ...(inName.length ? [{ label: 'MATCHED IN NAME', entries: inName, plain: true as const }] : []),
      ];
    }
    if (!this.sort.startsWith('time')) {
      const labels: Record<Exclude<Sort, 'time-desc' | 'time-asc'>, string> = {
        name: 'SORTED BY NAME', duration: 'SORTED BY DURATION', notes: 'SORTED BY NOTES', size: 'SORTED BY SIZE',
      };
      const sort = this.sort as Exclude<Sort, 'time-desc' | 'time-asc'>;
      return [{ label: `${labels[sort]} · ${entries.length}`, entries }];
    }
    const groups: Array<{ label: string; entries: RecordingHistoryEntry[] }> = [];
    for (const entry of entries) {
      const label = dayLabel(entry.createdAt);
      const group = groups[groups.length - 1];
      if (!group || group.label !== label) groups.push({ label, entries: [entry] });
      else group.entries.push(entry);
    }
    return groups;
  }

  private row(entry: RecordingHistoryEntry): HTMLElement {
    const selected = this.selected.has(entry.id);
    const row = $('div', `recording-row${selected ? ' recording-row--selected' : ''}`);
    row.dataset.recordingId = entry.id;
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-label', `Open ${entry.name}`);
    const open = () => { this.openId = entry.id; this.editingId = null; this.redraw(); };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });

    const box = this.selectionBox(selected, `Select ${entry.name}`);
    box.addEventListener('click', (event) => {
      event.stopPropagation();
      if (selected) this.selected.delete(entry.id); else this.selected.add(entry.id);
      this.redraw();
    });
    const dot = $('span', `recording-status-dot${entry.status === 'complete' ? '' : ` recording-status-dot--${entry.status}`}`);
    dot.title = statusLabel(entry.status);
    const name = $('span', 'recording-row__name');
    const nameText = $('span', 'recording-row__name-text'); nameText.title = entry.name;
    withHit(nameText, entry.name, this.query.trim().toLocaleLowerCase());
    name.append(nameText);
    if (entry.note) { const note = $('span', 'recording-row__note'); note.title = entry.note; note.textContent = '≡'; name.append(note); }
    const duration = $('span', 'recording-row__meta'); duration.textContent = formatDuration(entry);
    // The count chip plus the first note is what makes a row worth opening; a
    // recording with none shows a dash so the column never pads itself (f1).
    const notes = $('span', 'recording-row__notes');
    const summary = this.noteSummaries[entry.id];
    if (summary?.count) {
      const chip = $('span', 'recording-row__notes-chip');
      chip.innerHTML = NOTE_CHIP_ICON;
      chip.append(String(summary.count));
      const preview = $('span', 'recording-row__notes-preview');
      const label = summary.firstText || 'Unnamed';
      withHit(preview, `${formatDurationMs(summary.firstAtMs)} ${label}`, this.query.trim().toLocaleLowerCase());
      notes.append(chip, preview);
      notes.title = summary.count === 1 ? '1 note' : `${summary.count} notes`;
    } else {
      notes.classList.add('recording-row__notes--none');
      notes.textContent = '—';
    }
    const size = $('span', 'recording-row__meta'); size.textContent = formatSize(sizeOf(entry));
    const onDrive = entry.files.some((file) => file.destination === 'drive');
    const onLocal = entry.files.some((file) => file.destination === 'local');
    const destination = onDrive ? cloudIcon() : onLocal ? diskIcon() : $('span');
    destination.setAttribute('title', onDrive && onLocal ? 'Google Drive + local disk' : onDrive ? 'Google Drive' : 'Local disk');
    const time = $('span', 'recording-row__meta recording-row__time'); time.textContent = formatTime(entry.createdAt);
    const play = document.createElement('button');
    play.className = 'recording-row__play'; play.type = 'button';
    play.title = 'Play recording'; play.setAttribute('aria-label', `Play ${entry.name}`);
    play.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.8l7 4.2-7 4.2z"/></svg>';
    play.addEventListener('click', (event) => { event.stopPropagation(); this.callbacks.play(entry.id); });
    const remove = document.createElement('button');
    remove.className = 'recording-row__remove'; remove.type = 'button'; remove.title = 'Remove from history'; remove.setAttribute('aria-label', `Remove ${entry.name} from history`); remove.textContent = '×';
    remove.addEventListener('click', (event) => { event.stopPropagation(); this.callbacks.remove(entry.id); });
    row.append(box, dot, name, notes, duration, size, destination, time, play, remove);
    return row;
  }

  /**
   * Where this recording is filed. A recording made before destinations existed
   * simply reads as unfiled — it is in the built-in folder, which is the truth,
   * rather than being guessed into a destination.
   */
  private destinationPicker(entry: RecordingHistoryEntry): HTMLElement {
    const row = $('div', 'detail-destination');
    const listbox = createListboxSelect({
      label: 'Google Drive destination',
      className: 'detail-destination__select',
      options: [
        { value: '', label: 'Google Meet Records (unfiled)' },
        ...this.destinations.map((preset) => ({ value: preset.id, label: preset.name })),
      ],
      value: entry.driveFolderPresetId ?? '',
      onChange: (value) => {
        listbox.setDisabled(true);
        this.callbacks.fileTo(entry.id, value || null);
      },
    });
    this.destinationListbox = listbox;
    row.append(listbox.root);

    if (!this.destinations.length) {
      const hint = $('p', 'detail-destination__hint');
      hint.textContent = 'Add destinations in Settings to sort recordings into your own folders.';
      row.append(hint);
    }
    return row;
  }

  setDestinations(destinations: DriveFolderPreset[]): void {
    this.destinations = destinations;
    if (this.openId) this.redraw();
  }

  private selectionBox(selected: boolean, label: string): HTMLButtonElement {
    const box = document.createElement('button');
    box.className = `selection-box${selected ? ' selection-box--selected' : ''}`;
    box.type = 'button';
    box.title = label;
    box.setAttribute('aria-label', label);
    box.setAttribute('aria-pressed', String(selected));
    if (selected) box.append(checkIcon());
    return box;
  }

  private detail(entry: RecordingHistoryEntry): HTMLElement {
    const overlay = $('div', 'recording-detail-overlay');
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) { this.openId = null; this.editingId = null; this.redraw(); }
    });
    const dialog = $('article', 'recording-detail');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', `${entry.name} recording details`);
    const body = $('div', 'recording-detail__body');
    const heading = $('div', 'recording-detail__heading');
    if (this.editingId === entry.id) {
      const input = document.createElement('input');
      input.className = 'detail-title-input'; input.value = entry.name; input.setAttribute('aria-label', 'Recording name');
      const commit = () => {
        this.editingId = null;
        if (input.value.trim() && input.value.trim() !== entry.name) this.callbacks.rename(entry.id, input.value);
        this.redraw();
      };
      input.addEventListener('blur', commit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') input.blur();
        if (event.key === 'Escape') { event.stopPropagation(); this.editingId = null; this.redraw(); }
      });
      heading.append(input);
      requestAnimationFrame(() => input.focus());
    } else {
      const title = document.createElement('button');
      title.className = 'detail-title'; title.type = 'button'; title.title = 'Rename recording';
      const text = $('span', 'detail-title__text'); text.textContent = entry.name;
      title.append(text, editIcon());
      title.addEventListener('click', () => { this.editingId = entry.id; this.redraw(); });
      heading.append(title);
    }
    const status = $('span', `recording-status recording-status--${entry.status}`); status.textContent = statusLabel(entry.status);
    heading.append(status);
    const meta = $('p', 'recording-detail__meta');
    meta.textContent = `${fullDate(entry.createdAt)} · ${formatDuration(entry)} · ${formatSize(sizeOf(entry))} · ${entry.files.length} FILE${entry.files.length === 1 ? '' : 'S'}`;
    const noteLabel = $('div', 'detail-section-label'); noteLabel.textContent = 'NOTE';
    const note = document.createElement('textarea');
    note.className = 'detail-note'; note.value = entry.note ?? ''; note.placeholder = 'Add a note — agenda, decisions, follow-ups…'; note.setAttribute('aria-label', 'Recording note');
    note.addEventListener('blur', () => {
      if (note.value !== (entry.note ?? '')) this.callbacks.note(entry.id, note.value);
    });
    body.append(heading, meta, noteLabel, note);
    // Only a Drive recording can be filed: there is no folder to move otherwise.
    if (entry.storageMode === 'drive' && entry.driveFolderId) {
      const destinationLabel = $('div', 'detail-section-label');
      destinationLabel.textContent = 'DESTINATION';
      body.append(destinationLabel, this.destinationPicker(entry));
    } else if (entry.storageMode !== 'drive') {
      // Stated, not offered: a written download cannot be moved, so this says
      // where the file went rather than pretending it can still be changed.
      const destinationLabel = $('div', 'detail-section-label');
      destinationLabel.textContent = 'SAVED TO';
      const where = $('p', 'detail-destination__fixed');
      where.textContent = entry.localFolderName
        ? `Downloads / ${entry.localFolderName}`
        : 'Downloads';
      body.append(destinationLabel, where);
    }
    const fileLabel = $('div', 'detail-section-label'); fileLabel.textContent = 'FILES';
    body.append(fileLabel);
    dialog.append(body);

    const files = $('ul', 'recording-files');
    entry.files.forEach((file) => files.append(this.fileRow(entry, file)));
    dialog.append(files);

    const footer = $('footer', 'recording-detail__footer');
    const remove = document.createElement('button'); remove.className = 'modal-button modal-button--remove'; remove.type = 'button'; remove.textContent = 'Remove from history';
    remove.addEventListener('click', () => { this.openId = null; this.editingId = null; this.redraw(); this.callbacks.remove(entry.id); });
    const close = document.createElement('button'); close.className = 'modal-button modal-button--close'; close.type = 'button'; close.textContent = 'Close';
    close.addEventListener('click', () => { this.openId = null; this.editingId = null; this.redraw(); });
    footer.append(remove, close);
    dialog.append(footer);
    overlay.append(dialog);
    return overlay;
  }

  private fileRow(entry: RecordingHistoryEntry, file: RecordingHistoryFile): HTMLElement {
    const item = $('li', 'recording-files__row');
    const kind = $('span', 'file-kind'); kind.textContent = streamLabel(file.stream);
    const name = $('span', 'file-name'); name.textContent = file.filename; name.title = file.filename;
    const destination = $('span', `file-destination${file.status === 'available' ? '' : ` file-destination--${file.status}`}`);
    destination.textContent = file.destination.toUpperCase();
    item.append(kind, name, destination);
    if (file.destination === 'drive' && file.webViewLink) {
      const action = document.createElement('a'); action.className = 'file-action'; action.href = file.webViewLink; action.target = '_blank'; action.rel = 'noreferrer'; action.textContent = 'OPEN ↗';
      item.append(action);
    } else if (file.destination === 'local' && file.downloadId && file.status === 'available') {
      const action = document.createElement('button'); action.className = 'file-action'; action.type = 'button'; action.textContent = 'OPEN ↗';
      action.addEventListener('click', () => this.callbacks.openLocal(entry.id, file.id));
      item.append(action);
    } else {
      const unavailable = $('span', 'file-action'); unavailable.textContent = (file.error || file.status).toUpperCase(); unavailable.setAttribute('aria-label', file.error || file.status);
      item.append(unavailable);
    }
    return item;
  }

  private openSelected(entries: RecordingHistoryEntry[]) {
    for (const entry of entries) {
      for (const file of entry.files) {
        if (file.destination === 'drive' && file.webViewLink) window.open(file.webViewLink, '_blank', 'noopener');
        else if (file.destination === 'local' && file.downloadId && file.status === 'available') this.callbacks.openLocal(entry.id, file.id);
      }
    }
    this.selected.clear();
    this.redraw();
  }
}
