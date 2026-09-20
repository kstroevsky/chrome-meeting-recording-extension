import type { DriveFolderPreset } from '../shared/settings';
import { DRIVE_DEFAULT_DESTINATION_NAME } from '../shared/settings';
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
import type { RecordingTopicSummary } from '../shared/analysis/storedAnalysis';
import type { RecordingHistoryEntry, RecordingHistoryFile } from '../shared/recordingHistory';
import { RecordingNotesSection, type RecordingNotesSectionActions } from './RecordingNotesSection';
import { NoteEditor, type NoteEditorDeps } from './NoteEditor';

export type RecordingsViewCallbacks = {
  rename: (id: string, name: string) => void;
  note: (id: string, note: string) => void;
  remove: (id: string) => void;
  removeMany: (ids: string[]) => void;
  openLocal: (recordingId: string, fileId: string) => void;
  fileTo: (recordingId: string, presetId: string | null) => void;
  play: (recordingId: string) => void;
  loadMore: () => void;
  /** The open recording's notes (f2); the view supplies the undo toast itself. */
  notes: Omit<RecordingNotesSectionActions, 'offerUndo' | 'openEditor'> & Partial<Pick<NoteEditorDeps['notes'], 'add' | 'update'>>;
  /** What the note editor (f5, f6) reads besides notes; without it there is no ADD. */
  editor?: Pick<NoteEditorDeps, 'transcript' | 'playback'> & { notesChanged?: () => void };
};

const WARNING_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.4"/><path d="M10 6.4v4.4M10 13.6v.5"/></svg>';
const PLAY_ICON = '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.8l7 4.2-7 4.2z"/></svg>';
const PENCIL_ICON = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';

type Sort = 'time-desc' | 'time-asc' | 'name' | 'duration' | 'size' | 'notes';

const NOTE_CHIP_ICON = '<svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';


const $ = (tag: string, className?: string): HTMLElement => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
};
















/**
 * How long typing settles before the table repaints. Long enough to collapse a
 * burst, short enough that the list feels attached to the box.
 */
const SEARCH_REPAINT_MS = 120;

/**
 * How long opening a recording waits for its notes. They normally arrive well
 * inside this, and then the modal opens at its full height instead of growing
 * after it appears; a slow read opens it anyway and the notes follow.
 */
export const NOTES_WAIT_MS = 200;

/** DOM-only renderer for the standalone, paged recordings history. */
export class RecordingsView {
  private entries: RecordingHistoryEntry[] = [];
  private hasMore = false;
  private query = '';
  private sort: Sort = 'time-desc';
  private selected = new Set<string>();
  /** Note counts + searchable note text per recording (ADR-0005). */
  private noteSummaries: Record<string, RecordingNotationSummary> = {};
  /** Until the digest lands, the column stays blank rather than claiming a dash. */
  private noteSummariesRead = false;
  /** Topic keywords per recording, for the column and the search (ADR-0007). */
  private topicSummaries: Record<string, RecordingTopicSummary> = {};

  /**
   * Supplies the notes digest for the loaded page. Repainting is the caller's
   * job — it owns the entry list `render` needs.
   */
  setNoteSummaries(summaries: Record<string, RecordingNotationSummary>): void {
    this.noteSummaries = summaries;
    this.noteSummariesRead = true;
  }

  /**
   * Supplies the topics digest for the loaded page, on the same terms as the
   * notes one: arriving late is normal, and the table is complete without it.
   */
  setTopicSummaries(summaries: Record<string, RecordingTopicSummary>): void {
    this.topicSummaries = summaries;
  }
  private openId: string | null = null;
  private destinations: DriveFolderPreset[] = [];
  /** The open modal's picker, torn down with the modal so its listeners go too. */
  private destinationListbox: ListboxSelect | null = null;
  private editingId: string | null = null;
  /** The open recording's notes, kept across redraws so they load once. */
  private notesSection: { id: string; section: RecordingNotesSection; loaded: Promise<void> } | null = null;
  /** The recording waiting on its notes to open, so a slow one cannot open over a later click. */
  private pendingOpenId: string | null = null;
  /** The note editor (f5, f6), while it is open. */
  private editor: NoteEditor | null = null;
  /** The page's one toast, for UNDO after a note is deleted (f17). */
  private toast: { element: HTMLElement; settle: (undone: boolean) => void } | null = null;
  /** The remove-from-history confirmation (f17), while it is open. */
  private confirmHost: HTMLElement | null = null;
  /**
   * The list is split into three hosts built once. The toolbar host matters:
   * rebuilding it destroyed the very input the user was typing into, which is
   * why a redraw used to restore focus and caret by hand.
   */
  private toolbarHost: HTMLElement | null = null;
  private tableHost: HTMLElement | null = null;
  private detailHost: HTMLElement | null = null;
  /** Which toolbar is mounted, so it is only rebuilt when the kind changes. */
  private toolbarKind: 'search' | 'bulk' | null = null;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;

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
      if (this.confirmHost) return;
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

  private redraw() {
    // The picker owns document-level listeners; a redraw discards its element,
    // so it has to be torn down here rather than only when a new one is built.
    this.destinationListbox?.destroy();
    this.destinationListbox = null;
    this.empty.hidden = this.entries.length > 0;
    this.loadMoreButton.hidden = !this.hasMore;

    if (!this.toolbarHost) {
      this.toolbarHost = $('div', 'recordings-toolbar-host');
      this.tableHost = $('div', 'recordings-table-host');
      this.detailHost = $('div', 'recordings-detail-host');
      this.list.append(this.toolbarHost, this.tableHost, this.detailHost);
    }
    this.list.hidden = !this.entries.length;
    if (!this.entries.length) {
      this.tableHost!.replaceChildren();
      this.detailHost!.replaceChildren();
      return;
    }

    const visible = this.visibleEntries();
    this.syncToolbar(visible.length);
    this.tableHost!.replaceChildren(this.table(visible));
    const openEntry = this.entries.find((entry) => entry.id === this.openId);
    // A redraw while a recording waits to open must not drop the notes it waits on.
    if (!openEntry && this.notesSection?.id !== this.pendingOpenId) this.notesSection = null;
    this.detailHost!.replaceChildren(...(openEntry ? [this.detail(openEntry)] : []));
  }

  /**
   * Swaps between the search and bulk toolbars, and otherwise leaves the
   * mounted one alone so a live search input keeps its focus and caret.
   */
  private syncToolbar(visibleCount: number): void {
    const kind = this.selected.size ? 'bulk' : 'search';
    if (kind !== this.toolbarKind) {
      this.toolbarKind = kind;
      this.toolbarHost!.replaceChildren(kind === 'bulk' ? this.bulkToolbar() : this.searchToolbar());
    }
    if (kind === 'search') this.updateSearchCount(visibleCount);
  }

  private updateSearchCount(visibleCount: number): void {
    const total = this.toolbarHost?.querySelector<HTMLElement>('.recordings-count');
    if (!total) return;
    // While searching, the count is only useful next to what it was drawn from,
    // and saying where the match came from is the point of the split below (f2).
    total.textContent = this.query.trim()
      ? `${visibleCount} OF ${this.entries.length} · IN NAMES, NOTES AND TOPICS`
      : `${visibleCount} RECORDING${visibleCount === 1 ? '' : 'S'}`;
  }

  private visibleEntries(): RecordingHistoryEntry[] {
    const query = this.query.trim().toLocaleLowerCase();
    const filtered = this.entries.filter((entry) => !query
      // Topic keywords join the same haystack as the title and the notes, so
      // "redis" finds a call nobody thought to name after it (ADR-0007 §8).
      || `${entry.name} ${entry.note ?? ''} ${this.noteSummaries[entry.id]?.search ?? ''} ${this.topicSummaries[entry.id]?.search ?? ''}`
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

  private searchToolbar(): HTMLElement {
    const toolbar = $('div', 'recordings-toolbar');
    const search = document.createElement('input');
    search.className = 'recording-search';
    search.type = 'search';
    search.value = this.query;
    search.placeholder = 'Search name, note or topic…';
    search.setAttribute('aria-label', 'Search recordings');
    // Repainting the table costs about 24µs a row, so a burst of keystrokes is
    // collapsed into one repaint. The count is not debounced: it is one text
    // node, and it is the feedback that the search is live.
    search.addEventListener('input', () => {
      this.query = search.value;
      this.updateSearchCount(this.visibleEntries().length);
      if (this.searchDebounce) clearTimeout(this.searchDebounce);
      this.searchDebounce = setTimeout(() => {
        this.searchDebounce = null;
        this.redraw();
      }, SEARCH_REPAINT_MS);
    });
    toolbar.append(search, $('span', 'recordings-count'));
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
    remove.addEventListener('click', () => void this.confirmRemoveMany([...this.selected]));

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
    const open = () => { void this.openDetail(entry); };
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
    } else if (this.noteSummariesRead) {
      notes.classList.add('recording-row__notes--none');
      notes.textContent = '—';
    }
    const size = $('span', 'recording-row__meta'); size.textContent = formatSize(sizeOf(entry));
    const onDrive = entry.files.some((file) => file.destination === 'drive');
    const onLocal = entry.files.some((file) => file.destination === 'local');
    const destination = onDrive ? cloudIcon() : onLocal ? diskIcon() : $('span');
    destination.setAttribute('title', onDrive && onLocal ? 'Google Drive + local disk' : onDrive ? 'Google Drive' : 'Local disk');
    const time = $('span', 'recording-row__meta recording-row__time'); time.textContent = formatTime(entry.createdAt);
    // Watching starts from the recording's detail, which says what is being watched (f2).
    const remove = document.createElement('button');
    remove.className = 'recording-row__remove'; remove.type = 'button'; remove.title = 'Remove from history'; remove.setAttribute('aria-label', `Remove ${entry.name} from history`); remove.textContent = '×';
    remove.addEventListener('click', (event) => { event.stopPropagation(); void this.confirmRemove(entry); });
    row.append(box, dot, name, notes, duration, size, destination, time, remove);
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
        { value: '', label: `${DRIVE_DEFAULT_DESTINATION_NAME} (unfiled)` },
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
      hint.textContent = 'Add folders in Settings to sort recordings into your own.';
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

  private closeDetail(): void {
    this.openId = null;
    this.editingId = null;
    this.redraw();
  }

  /** Opens a recording's modal once its notes are in, or once the wait runs out. */
  private async openDetail(entry: RecordingHistoryEntry): Promise<void> {
    this.pendingOpenId = entry.id;
    const { loaded } = this.notesFor(entry);
    await Promise.race([loaded, new Promise<void>((resolve) => { setTimeout(resolve, NOTES_WAIT_MS); })]);
    if (this.pendingOpenId !== entry.id) return;
    this.pendingOpenId = null;
    this.openId = entry.id;
    this.editingId = null;
    this.redraw();
  }

  private canEditNotes(): boolean {
    return Boolean(this.callbacks.editor && this.callbacks.notes.add && this.callbacks.notes.update);
  }

  /**
   * ADD beside the note count (f2 → f5): the editor takes the details dialog's
   * place, and returns to it rather than closing, since naming and deleting
   * the rest still happen there.
   */
  private async openEditor(entry: RecordingHistoryEntry): Promise<void> {
    const { add, update } = this.callbacks.notes;
    const editorDeps = this.callbacks.editor;
    if (!add || !update || !editorDeps) return;
    this.editor?.close();
    this.closeDetail();
    const finish = (details: boolean) => {
      editor.close();
      if (this.editor === editor) this.editor = null;
      editorDeps.notesChanged?.();
      if (details) void this.openDetail(entry);
    };
    const editor = new NoteEditor({
      recording: { id: entry.id, name: entry.name, ...(durationOf(entry) ? { durationMs: durationOf(entry) } : {}) },
      notes: { ...this.callbacks.notes, add, update, offerUndo: (message, windowMs) => this.offerUndo(message, windowMs) },
      ...(editorDeps.transcript ? { transcript: editorDeps.transcript } : {}),
      ...(editorDeps.playback ? { playback: editorDeps.playback } : {}),
      onDetails: () => finish(true),
      onClose: () => finish(false),
    });
    this.editor = editor;
    document.body.append(editor.element);
    await editor.open();
  }

  /** The recording's notes section, started on first use and then kept. */
  private notesFor(entry: RecordingHistoryEntry): { section: RecordingNotesSection; loaded: Promise<void> } {
    if (this.notesSection?.id !== entry.id) {
      const section = new RecordingNotesSection(entry.id, durationOf(entry), {
        ...this.callbacks.notes,
        offerUndo: (message, windowMs) => this.offerUndo(message, windowMs),
        ...(this.canEditNotes() ? { openEditor: () => void this.openEditor(entry) } : {}),
      });
      this.notesSection = { id: entry.id, section, loaded: section.load() };
    }
    return this.notesSection;
  }

  private detail(entry: RecordingHistoryEntry): HTMLElement {
    const overlay = $('div', 'recording-detail-overlay');
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) this.closeDetail();
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
    body.append(heading, meta);

    // The notes come first (f2): the timeline and the spoiler list, above
    // everything that describes where the recording is stored.
    const notes = $('div', 'recording-detail__notes');
    notes.append(this.notesFor(entry).section.element);
    dialog.append(body, notes);

    const more = $('div', 'recording-detail__body recording-detail__body--more');
    // "Note" now means a timecoded span, so the free-text field is the recording's DESCRIPTION.
    const noteLabel = $('div', 'detail-section-label'); noteLabel.textContent = 'DESCRIPTION';
    const describe = $('div', 'detail-note-field');
    const note = document.createElement('textarea');
    note.className = 'detail-note'; note.value = entry.note ?? ''; note.placeholder = 'Add a description — agenda, decisions, follow-ups…'; note.setAttribute('aria-label', 'Recording description');
    note.addEventListener('blur', () => {
      if (note.value !== (entry.note ?? '')) this.callbacks.note(entry.id, note.value);
    });
    const pencil = $('span', 'detail-note-field__icon'); pencil.innerHTML = PENCIL_ICON; pencil.setAttribute('aria-hidden', 'true');
    describe.append(note, pencil);
    more.append(noteLabel, describe);
    // Only a Drive recording can be filed: there is no folder to move otherwise.
    if (entry.storageMode === 'drive' && entry.driveFolderId) {
      const destinationLabel = $('div', 'detail-section-label');
      destinationLabel.textContent = 'DESTINATION';
      more.append(destinationLabel, this.destinationPicker(entry));
    } else if (entry.storageMode !== 'drive') {
      // Stated, not offered: a written download cannot be moved, so this says
      // where the file went rather than pretending it can still be changed.
      const destinationLabel = $('div', 'detail-section-label');
      destinationLabel.textContent = 'SAVED TO';
      const where = $('p', 'detail-destination__fixed');
      where.textContent = entry.localFolderName
        ? `Downloads / ${entry.localFolderName}`
        : 'Downloads';
      more.append(destinationLabel, where);
    }
    const fileLabel = $('div', 'detail-section-label'); fileLabel.textContent = 'FILES';
    more.append(fileLabel);
    dialog.append(more);

    const files = $('ul', 'recording-files');
    entry.files.forEach((file) => files.append(this.fileRow(entry, file)));
    dialog.append(files);

    const footer = $('footer', 'recording-detail__footer');
    const remove = document.createElement('button'); remove.className = 'modal-button modal-button--remove'; remove.type = 'button'; remove.textContent = 'Remove from history';
    remove.addEventListener('click', () => void this.confirmRemove(entry));
    const actions = $('span', 'recording-detail__footer-actions');
    const close = document.createElement('button'); close.className = 'modal-button modal-button--close'; close.type = 'button'; close.textContent = 'Close';
    close.addEventListener('click', () => this.closeDetail());
    // The one action the modal was missing (f2 → f3).
    const watch = document.createElement('button'); watch.className = 'modal-button modal-button--watch'; watch.type = 'button';
    watch.title = 'Open the player'; watch.innerHTML = PLAY_ICON; watch.append('Watch recording');
    // The player takes the modal's place (f3), over the same list.
    watch.addEventListener('click', () => { this.closeDetail(); this.callbacks.play(entry.id); });
    actions.append(close, watch);
    footer.append(remove, actions);
    dialog.append(footer);
    overlay.append(dialog);
    return overlay;
  }

  /**
   * A recording takes its notes and transcript with it, so removing one gets a
   * modal that names what goes and what stays (f17) — and no typed confirmation,
   * since the media itself is still in Drive or Downloads.
   */
  /** The same confirmation, asked from outside the table — the player's f16 action. */
  askToRemove(id: string): Promise<boolean> {
    const entry = this.entries.find((candidate) => candidate.id === id);
    return entry ? this.confirmRemove(entry) : Promise.resolve(false);
  }

  private confirmRemove(entry: RecordingHistoryEntry): Promise<boolean> {
    const notes = this.noteSummaries[entry.id]?.count ?? 0;
    const goes = notes
      ? `The ${notes === 1 ? 'note' : `${notes} notes`} and the transcript are deleted with it.`
      : 'Its transcript is deleted with it.';
    const stays = entry.files.some((file) => file.destination === 'drive')
      ? `The video file${entry.files.length === 1 ? '' : 's'} ${entry.files.length === 1 ? 'stays' : 'stay'} in Drive.`
      : 'The files stay in your Downloads folder.';
    return this.askConfirm(`Remove “${entry.name}” from history?`, `${goes} ${stays}`, () => {
      if (this.openId === entry.id) this.closeDetail();
      this.callbacks.remove(entry.id);
    });
  }

  private confirmRemoveMany(ids: string[]): Promise<boolean> {
    if (!ids.length) return Promise.resolve(false);
    return this.askConfirm(
      `Remove ${ids.length} recording${ids.length === 1 ? '' : 's'} from history?`,
      'Their notes and transcripts are deleted with them. The files stay in Drive and Downloads.',
      () => { this.selected.clear(); this.redraw(); this.callbacks.removeMany(ids); },
    );
  }

  private askConfirm(title: string, body: string, onConfirm: () => void): Promise<boolean> {
    this.confirmHost?.remove();
    return new Promise((resolve) => {
      const overlay = $('div', 'confirm-overlay');
      const card = $('div', 'confirm-card');
      card.setAttribute('role', 'alertdialog');
      card.setAttribute('aria-modal', 'true');
      const head = $('div', 'confirm-card__head');
      const icon = $('span', 'confirm-card__icon'); icon.innerHTML = WARNING_ICON;
      const copy = $('span', 'confirm-card__copy');
      const heading = $('span', 'confirm-card__title'); heading.textContent = title;
      const text = $('span', 'confirm-card__body'); text.textContent = body;
      copy.append(heading, text);
      head.append(icon, copy);
      const actions = $('div', 'confirm-card__actions');
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'confirm-card__cancel'; cancel.textContent = 'Cancel';
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'confirm-card__confirm'; confirm.textContent = 'Remove';
      actions.append(cancel, confirm);
      card.append(head, actions);
      overlay.append(card);
      const done = (confirmed: boolean) => {
        overlay.remove();
        if (this.confirmHost === overlay) this.confirmHost = null;
        document.removeEventListener('keydown', onKey, true);
        if (confirmed) onConfirm();
        resolve(confirmed);
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.stopPropagation(); done(false); }
      };
      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => done(false));
      confirm.addEventListener('click', () => done(true));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) done(false); });
      this.confirmHost = overlay;
      document.body.append(overlay);
      // Cancel is the safe default for a destructive prompt.
      cancel.focus();
    });
  }

  /** The dark toast with UNDO and its draining bar (f17); one at a time. */
  private offerUndo(message: string, windowMs: number): Promise<boolean> {
    this.toast?.settle(false);
    return new Promise((resolve) => {
      const element = $('div', 'undo-toast');
      element.setAttribute('role', 'status');
      const text = $('span', 'undo-toast__text'); text.textContent = message;
      const side = $('span', 'undo-toast__side');
      const bar = $('span', 'undo-toast__bar');
      const fill = $('span', 'undo-toast__fill');
      fill.style.animationDuration = `${windowMs}ms`;
      bar.append(fill);
      const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'undo-toast__undo'; undo.textContent = 'UNDO';
      side.append(bar, undo);
      element.append(text, side);
      const timer = setTimeout(() => settle(false), windowMs);
      const settle = (undone: boolean) => {
        clearTimeout(timer);
        element.remove();
        if (this.toast?.element === element) this.toast = null;
        resolve(undone);
      };
      undo.addEventListener('click', () => settle(true));
      this.toast = { element, settle };
      document.body.append(element);
    });
  }

  private fileRow(entry: RecordingHistoryEntry, file: RecordingHistoryFile): HTMLElement {
    const item = $('li', 'recording-files__row');
    // A sidecar rides a media stream, so its stream says nothing: it is named
    // for what it is. VTT for the transcript, matching the popup's own label.
    const kind = $('span', 'file-kind');
    kind.textContent = file.kind === 'notes' ? 'NOTES' : file.kind === 'transcript' ? 'VTT' : streamLabel(file.stream);
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
