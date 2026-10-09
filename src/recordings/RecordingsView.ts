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
import {
  hasRetainedMediaAwaitingExternalPlayback,
  verifiedRetainedMediaReleaseTargets,
  type RecordingHistoryEntry,
  type RecordingHistoryFile,
} from '../shared/recordingHistory';
import { fileDeletionFinalCheck, fileDeletionWarning } from './fileDeletion';
import { RecordingNotesSection, type RecordingNotesSectionActions } from './RecordingNotesSection';
import { NoteEditor, type NoteEditorDeps } from './NoteEditor';
import { ShareDialog, type QueuedShare, type ShareProgressReporter } from './ShareDialog';
import type { PublishRecordingOptions } from '../sharing/PublishedManifestBuilder';
import type { ShareRuntimeSnapshot } from '../sharing/ShareRuntime';
import type { ExternalMediaTransferStatus } from '../shared/protocol';

export type RecordingsViewCallbacks = {
  rename: (id: string, name: string) => void;
  note: (id: string, note: string) => void;
  /** `deleteFiles`: also delete the recording's Drive and Downloads files. */
  remove: (id: string, deleteFiles?: boolean) => void;
  removeMany: (ids: string[], deleteFiles?: boolean) => void;
  freeSpace?: (id: string) => void;
  /** "Sync with Drive": check Drive, preview, apply what the user chooses. */
  syncDrive?: () => void;
  openLocal: (recordingId: string, fileId: string) => void;
  fileTo: (recordingId: string, presetId: string | null) => void;
  play: (recordingId: string) => void;
  playRemote?: (recordingId: string) => void;
  loadMore: () => void;
  retryExternalMedia?: (destinationId: string, clientTransferId: string) => void;
  share?: (
    recordingIds: string[],
    options: PublishRecordingOptions,
    report: ShareProgressReporter,
  ) => Promise<QueuedShare>;
  shareSnapshot?: () => Promise<ShareRuntimeSnapshot>;
  revokeShare?: (shareId: string) => Promise<void>;
  sharesChanged?: () => void;
  /** The open recording's notes (f2); the view supplies the undo toast itself. */
  notes: Omit<RecordingNotesSectionActions, 'offerUndo' | 'openEditor'> & Partial<Pick<NoteEditorDeps['notes'], 'add' | 'update'>>;
  /** What the note editor (f5, f6) reads besides notes; without it there is no ADD. */
  editor?: Pick<NoteEditorDeps, 'transcript' | 'playback'> & { notesChanged?: () => void };
};

const WARNING_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.4"/><path d="M10 6.4v4.4M10 13.6v.5"/></svg>';
const PLAY_ICON = '<svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M3 1.8l7 4.2-7 4.2z"/></svg>';
const PENCIL_ICON = '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 1.7l2.8 2.8-8 8H3.5v-2.8l8-8z"/></svg>';

type SortKey = 'time' | 'name' | 'duration' | 'size' | 'notes';
type SortDirection = 'asc' | 'desc';
type Sort = { key: SortKey; dir: SortDirection };

/** The order a column sorts in when first picked: newest, A–Z, longest, largest, most notes. */
const FIRST_DIRECTION: Record<SortKey, SortDirection> = {
  time: 'desc', name: 'asc', duration: 'desc', size: 'desc', notes: 'desc',
};
const SORT_NAMES: Record<Exclude<SortKey, 'time'>, { label: string; asc: string; desc: string }> = {
  name: { label: 'NAME', asc: 'A–Z', desc: 'Z–A' },
  duration: { label: 'DURATION', asc: 'SHORTEST FIRST', desc: 'LONGEST FIRST' },
  size: { label: 'SIZE', asc: 'SMALLEST FIRST', desc: 'LARGEST FIRST' },
  notes: { label: 'NOTES', asc: 'FEWEST FIRST', desc: 'MOST FIRST' },
};

const sameFolder = (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase();

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
  private sort: Sort = { key: 'time', dir: 'desc' };
  /** Only recordings filed in this folder are listed; set by clicking a folder tag. */
  private folderFilter: string | null = null;
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
  setExternalMediaTransfers(transfers: ExternalMediaTransferStatus[]): void {
    this.externalMediaTransfers = transfers;
    if (!this.openId || !this.detailHost) return;
    const section = this.detailHost.querySelector<HTMLElement>('.recording-external-media');
    const entry = this.entries.find((candidate) => candidate.id === this.openId);
    if (section?.dataset.recordingId === this.openId && entry) this.fillExternalMediaSection(section, entry);
  }
  private openId: string | null = null;
  private destinations: DriveFolderPreset[] = [];
  private externalMediaTransfers: ExternalMediaTransferStatus[] = [];
  private total: number | undefined;
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
  /** The bulk toolbar's live parts, updated in place as the selection changes. */
  private bulkParts: { count: HTMLElement; move: HTMLButtonElement; open: HTMLButtonElement } | null = null;
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  /** Watches the end of the list and asks for the next page as it comes near. */
  private moreObserver: IntersectionObserver | null = null;

  constructor(
    private readonly list: HTMLElement,
    private readonly empty: HTMLElement,
    private readonly error: HTMLElement,
    private readonly callbacks: RecordingsViewCallbacks,
  ) {
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
      } else if (this.folderFilter) {
        this.setFolderFilter(null);
      }
    });
  }

  render(entries: RecordingHistoryEntry[], hasMore = false, total?: number) {
    this.entries = entries;
    this.hasMore = hasMore;
    this.total = total;
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
    this.moreObserver?.disconnect();
    this.moreObserver = null;

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
    // The table is rebuilt on every redraw — opening a recording included — so
    // its scroll position has to be carried across, or the list jumps to the top.
    const scrollTop = this.tableHost!.querySelector<HTMLElement>('.recording-table__scroll')?.scrollTop ?? 0;
    this.tableHost!.replaceChildren(this.table(visible));
    const scroller = this.tableHost!.querySelector<HTMLElement>('.recording-table__scroll');
    if (scroller && scrollTop) scroller.scrollTop = scrollTop;
    if (scroller) this.watchForMore(scroller);
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
    if (kind === 'search') {
      this.updateFolderFilterChip();
      this.updateSearchCount(visibleCount);
    } else {
      this.updateBulkToolbar();
    }
  }

  private selectedEntries(): RecordingHistoryEntry[] {
    return this.entries.filter((entry) => this.selected.has(entry.id));
  }

  /**
   * The bulk toolbar is built once per selection session, so what depends on
   * the selection is refreshed here — built into it, the count and the buttons
   * froze on the first recording selected.
   */
  private updateBulkToolbar(): void {
    if (!this.bulkParts) return;
    const selection = this.selectedEntries();
    this.bulkParts.count.textContent = `${this.selected.size} SELECTED`;
    this.bulkParts.open.disabled = !selection.some((entry) => entry.files.some((file) =>
      (file.destination === 'drive' && file.webViewLink) || (file.destination === 'local' && file.downloadId && file.status === 'available')));
    // Nothing to move when every file of every selected recording is on Drive.
    this.bulkParts.move.hidden = selection.length > 0 && selection.every((entry) =>
      entry.files.length > 0 && entry.files.every((file) => file.destination === 'drive'));
  }

  /** Says which folder the list is narrowed to, and undoes it in one click. */
  private updateFolderFilterChip(): void {
    const host = this.toolbarHost?.querySelector<HTMLElement>('.recordings-folder-filter');
    if (!host) return;
    host.hidden = !this.folderFilter;
    if (!this.folderFilter) {
      host.replaceChildren();
      return;
    }
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'folder-filter-chip';
    chip.title = 'Show every folder';
    chip.setAttribute('aria-label', `Showing only “${this.folderFilter}”. Show every folder`);
    const label = $('span', 'folder-filter-chip__label');
    label.textContent = this.folderFilter;
    const clear = $('span', 'folder-filter-chip__clear');
    clear.setAttribute('aria-hidden', 'true');
    clear.textContent = '×';
    chip.append(label, clear);
    chip.addEventListener('click', () => this.setFolderFilter(null));
    host.replaceChildren(chip);
  }

  private updateSearchCount(visibleCount: number): void {
    const total = this.toolbarHost?.querySelector<HTMLElement>('.recordings-count');
    if (!total) return;
    // While searching, the count is only useful next to what it was drawn from,
    // and saying where the match came from is the point of the split below (f2).
    total.textContent = this.query.trim()
      ? `${visibleCount} OF ${this.entries.length} · IN NAMES, NOTES AND TOPICS`
      // The folder chip beside it already says which folder.
      : this.folderFilter
        ? `${visibleCount} OF ${this.entries.length}`
        // Not the page: the library, which may hold more than has loaded.
        : `${this.total ?? visibleCount} RECORDING${(this.total ?? visibleCount) === 1 ? '' : 'S'}`;
  }

  private visibleEntries(): RecordingHistoryEntry[] {
    const query = this.query.trim().toLocaleLowerCase();
    const folder = this.folderFilter;
    const filtered = this.entries.filter((entry) => (!query
      // Topic keywords join the same haystack as the title and the notes, so
      // "redis" finds a call nobody thought to name after it (ADR-0007 §8).
      || `${entry.name} ${entry.note ?? ''} ${this.noteSummaries[entry.id]?.search ?? ''} ${this.topicSummaries[entry.id]?.search ?? ''}`
        .toLocaleLowerCase().includes(query))
      && (!folder || sameFolder(this.folderOf(entry) ?? '', folder)));
    const { key, dir } = this.sort;
    const valueOf = (entry: RecordingHistoryEntry): number | string | undefined => {
      if (key === 'time') return entry.createdAt;
      if (key === 'name') return entry.name;
      if (key === 'duration') return durationOf(entry);
      if (key === 'size') return sizeOf(entry) || undefined; // shown as "—": unknown, not small
      return this.noteSummaries[entry.id]?.count ?? 0;
    };
    return [...filtered].sort((left, right) => {
      const a = valueOf(left);
      const b = valueOf(right);
      // A value nobody knows (a duration never read, a size never recorded) sorts last either way.
      if (a == null || b == null) {
        if (a != null) return -1;
        if (b != null) return 1;
      } else {
        const ascending = typeof a === 'string' && typeof b === 'string'
          ? a.localeCompare(b)
          : Number(a) - Number(b);
        if (ascending) return dir === 'asc' ? ascending : -ascending;
      }
      return right.createdAt - left.createdAt;
    });
  }

  /**
   * The folder a recording is filed in, as the user named it: its Drive
   * destination, or else the Downloads folder it was written into. The default
   * destination is not a choice anyone made, so it is not shown.
   */
  private folderOf(entry: RecordingHistoryEntry): string | undefined {
    const name = (entry.driveFolderPresetId
      ? this.destinations.find((preset) => preset.id === entry.driveFolderPresetId)?.name
      : undefined) ?? entry.localFolderName;
    const trimmed = name?.trim();
    if (!trimmed || sameFolder(trimmed, DRIVE_DEFAULT_DESTINATION_NAME)) return undefined;
    return trimmed;
  }

  private setFolderFilter(folder: string | null): void {
    this.folderFilter = folder;
    this.redraw();
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
    toolbar.append(search, $('span', 'recordings-folder-filter'), $('span', 'recordings-count'));
    if (this.callbacks.syncDrive) {
      const sync = document.createElement('button');
      sync.type = 'button';
      sync.className = 'bulk-button bulk-button--ghost recordings-sync';
      sync.textContent = 'Sync with Drive';
      sync.title = 'Compare the library with your Google Drive folders';
      sync.addEventListener('click', () => this.callbacks.syncDrive?.());
      toolbar.append(sync);
    }
    return toolbar;
  }

  private bulkToolbar(): HTMLElement {
    const toolbar = $('div', 'bulk-toolbar');
    const count = $('span', 'bulk-toolbar__count');
    const actions = $('div', 'bulk-toolbar__actions');

    const share = document.createElement('button');
    share.className = 'bulk-button bulk-button--primary';
    share.type = 'button';
    share.textContent = 'Share';
    share.hidden = !this.callbacks.share;
    share.addEventListener('click', () => this.openShareDialog(this.selectedEntries()));

    const move = document.createElement('button');
    move.className = 'bulk-button bulk-button--ghost';
    move.type = 'button';
    move.textContent = 'Move to Drive';
    move.disabled = true;
    move.title = 'Moving completed local files to Google Drive is not available after capture.';

    const open = document.createElement('button');
    open.className = 'bulk-button bulk-button--ghost';
    open.type = 'button';
    open.textContent = 'Download';
    open.addEventListener('click', () => this.openSelected(this.selectedEntries()));

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
    actions.append(share, move, open, remove, clear);
    toolbar.append(count, actions);
    this.bulkParts = { count, move, open };
    return toolbar;
  }

  private openShareDialog(entries: RecordingHistoryEntry[]): void {
    if (!this.callbacks.share || !this.callbacks.shareSnapshot || !entries.length) return;
    const ids = entries.map((entry) => entry.id);
    const dialog = new ShareDialog(entries.map((entry) => entry.name), {
      publish: (options, report) => this.callbacks.share!(ids, options, report),
      snapshot: () => this.callbacks.shareSnapshot!(),
      ...(this.callbacks.revokeShare ? { revoke: (shareId: string) => this.callbacks.revokeShare!(shareId) } : {}),
      ...(this.callbacks.sharesChanged ? { changed: () => this.callbacks.sharesChanged!() } : {}),
    });
    dialog.open();
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
    const folder = $('span', 'table-header-text table-header-text--left'); folder.textContent = 'FOLDER';
    header.append(master, $('span'), this.headerButton('NAME', 'name'), folder, this.headerButton('NOTES', 'notes'), this.headerButton('DUR', 'duration', true), this.headerButton('SIZE', 'size', true));
    const destination = $('span', 'table-header-text'); destination.textContent = 'DEST';
    header.append(destination, this.headerButton('TIME', 'time', true));
    table.append(header);

    const scroll = $('div', 'recording-table__scroll');
    if (!entries.length) {
      const empty = $('div', 'recording-no-results');
      const folderName = this.folderFilter?.toLocaleUpperCase();
      empty.textContent = this.query.trim()
        ? `NO RECORDINGS MATCH “${this.query.toUpperCase()}”${folderName ? ` IN “${folderName}”` : ''}`
        : `NO RECORDINGS IN “${folderName ?? ''}”`;
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
    // The next page loads as this comes near, so there is nothing to press.
    if (this.hasMore) {
      const more = $('div', 'recording-table__more');
      more.textContent = 'Loading more recordings…';
      scroll.append(more);
    }
    table.append(scroll);
    return table;
  }

  /**
   * Loads the next page before the list runs out: once the end marker is within
   * a screenful of view. A page that does not fill the list leaves the marker in
   * view, so the next one follows straight away. Each redraw builds a new list
   * and watches its marker afresh; the controller ignores asks while a page is
   * already on its way.
   */
  private watchForMore(scroller: HTMLElement): void {
    const marker = scroller.querySelector('.recording-table__more');
    if (!marker || typeof IntersectionObserver === 'undefined') return;
    this.moreObserver = new IntersectionObserver((seen) => {
      if (seen.some((entry) => entry.isIntersecting)) this.callbacks.loadMore();
    }, { root: scroller, rootMargin: '0px 0px 600px 0px' });
    this.moreObserver.observe(marker);
  }

  /** Picks a column to sort by; picking the sorted column again reverses it. */
  private headerButton(label: string, key: SortKey, right = false): HTMLButtonElement {
    const active = this.sort.key === key;
    const button = document.createElement('button');
    button.className = `table-header-button${right ? ' table-header-button--right' : ''}${active ? ' table-header-button--active' : ''}${key === 'notes' ? ' table-header-button--notes' : ''}`;
    button.type = 'button';
    button.textContent = label;
    button.title = active ? 'Reverse the order' : `Sort by ${label.toLocaleLowerCase()}`;
    if (active) {
      const arrow = $('span', 'table-header-button__arrow');
      arrow.textContent = this.sort.dir === 'asc' ? '▴' : '▾';
      arrow.setAttribute('aria-label', this.sort.dir === 'asc' ? 'ascending' : 'descending');
      button.append(arrow);
    }
    button.addEventListener('click', () => {
      this.sort = active
        ? { key, dir: this.sort.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: FIRST_DIRECTION[key] };
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
    if (this.sort.key !== 'time') {
      const named = SORT_NAMES[this.sort.key];
      return [{ label: `SORTED BY ${named.label} · ${named[this.sort.dir]} · ${entries.length}`, entries }];
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
    // Only the count, so the name keeps the width; the first note is the
    // tooltip. A recording with none shows a dash so the column never pads
    // itself (f1).
    const notes = $('span', 'recording-row__notes');
    const summary = this.noteSummaries[entry.id];
    if (summary?.count) {
      const chip = $('span', 'recording-row__notes-chip');
      chip.innerHTML = NOTE_CHIP_ICON;
      chip.append(String(summary.count));
      notes.append(chip);
      notes.title = `${summary.count === 1 ? '1 note' : `${summary.count} notes`} · first at ${formatDurationMs(summary.firstAtMs)}: ${summary.firstText || 'Unnamed'}`;
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
    // Removing lives in the detail and the bulk toolbar; the row keeps to what it says.
    row.append(box, dot, name, this.folderTag(entry), notes, duration, size, destination, time);
    return row;
  }

  /** The recording's folder as a tag; clicking it lists only that folder (again: all). */
  private folderTag(entry: RecordingHistoryEntry): HTMLElement {
    const cell = $('span', 'recording-row__folder-cell');
    const folder = this.folderOf(entry);
    if (!folder) return cell;
    const active = this.folderFilter != null && sameFolder(folder, this.folderFilter);
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = `recording-row__folder${active ? ' recording-row__folder--active' : ''}`;
    tag.textContent = folder;
    tag.title = active ? `Showing only “${folder}” — click to show every folder` : `Show only “${folder}”`;
    tag.setAttribute('aria-pressed', String(active));
    tag.addEventListener('click', (event) => {
      event.stopPropagation();
      this.setFolderFilter(active ? null : folder);
    });
    // Enter and Space press the tag, not the row it sits in.
    tag.addEventListener('keydown', (event) => event.stopPropagation());
    cell.append(tag);
    return cell;
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
    // Folder tags are named from these, so the table is redrawn too.
    if (this.entries.length) this.redraw();
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
    dialog.append(files, this.externalMediaSection(entry));

    const footer = $('footer', 'recording-detail__footer');
    const remove = document.createElement('button'); remove.className = 'modal-button modal-button--remove'; remove.type = 'button'; remove.textContent = 'Remove from history';
    remove.addEventListener('click', () => void this.confirmRemove(entry));
    const actions = $('span', 'recording-detail__footer-actions');
    if (this.callbacks.playRemote && hasRetainedMediaAwaitingExternalPlayback(entry)) {
      const playRemote = document.createElement('button');
      playRemote.className = 'modal-button modal-button--close';
      playRemote.type = 'button';
      playRemote.textContent = 'Play remote copy';
      playRemote.title = 'Play the saved external copy before freeing local space';
      playRemote.addEventListener('click', () => {
        this.closeDetail();
        this.callbacks.playRemote?.(entry.id);
      });
      actions.append(playRemote);
    }
    if (this.callbacks.freeSpace && verifiedRetainedMediaReleaseTargets(entry).length) {
      const freeSpace = document.createElement('button');
      freeSpace.className = 'modal-button modal-button--close';
      freeSpace.type = 'button';
      freeSpace.textContent = 'Free up space';
      freeSpace.title = 'Delete the extension-retained local copy after verified remote playback';
      freeSpace.addEventListener('click', () => this.callbacks.freeSpace?.(entry.id));
      actions.append(freeSpace);
    }
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
    return this.askConfirm(`Remove “${entry.name}” from history?`, `${goes} ${stays}`, (deleteFiles) => {
      if (this.openId === entry.id) this.closeDetail();
      this.callbacks.remove(entry.id, deleteFiles);
    }, { label: 'Also delete its files', body: `${goes} ${fileDeletionWarning([entry])}`, finalCheck: fileDeletionFinalCheck([entry]) });
  }

  private confirmRemoveMany(ids: string[]): Promise<boolean> {
    if (!ids.length) return Promise.resolve(false);
    const goes = 'Their notes and transcripts are deleted with them.';
    const entries = this.entries.filter((entry) => ids.includes(entry.id));
    return this.askConfirm(
      `Remove ${ids.length} recording${ids.length === 1 ? '' : 's'} from history?`,
      `${goes} The files stay in Drive and Downloads.`,
      (deleteFiles) => { this.selected.clear(); this.redraw(); this.callbacks.removeMany(ids, deleteFiles); },
      { label: 'Also delete their files', body: `${goes} ${fileDeletionWarning(entries)}`, finalCheck: fileDeletionFinalCheck(entries) },
    );
  }

  /**
   * The page's own confirmation. `option` adds the "also delete files" choice,
   * unticked: ticking it swaps the body for what will actually be deleted and
   * renames the button — and then Remove asks once more, natively, because
   * deleting files is the one step that cannot be taken back. Declining that
   * keeps this dialog open: nothing has been closed, cleared or removed.
   */
  private askConfirm(
    title: string,
    body: string,
    onConfirm: (optionChecked: boolean) => void,
    option?: { label: string; body: string; finalCheck: string },
  ): Promise<boolean> {
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
      card.append(head);
      let optionChecked = false;
      if (option) {
        const row = document.createElement('label'); row.className = 'confirm-card__option';
        const box = document.createElement('input'); box.type = 'checkbox'; box.className = 'confirm-card__checkbox';
        const label = $('span'); label.textContent = option.label;
        row.append(box, label);
        box.addEventListener('change', () => {
          optionChecked = box.checked;
          text.textContent = optionChecked ? option.body : body;
          confirm.textContent = optionChecked ? 'Remove and delete files' : 'Remove';
        });
        card.append(row);
      }
      card.append(actions);
      overlay.append(card);
      const done = (confirmed: boolean) => {
        overlay.remove();
        if (this.confirmHost === overlay) this.confirmHost = null;
        document.removeEventListener('keydown', onKey, true);
        if (confirmed) onConfirm(optionChecked);
        resolve(confirmed);
      };
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.stopPropagation(); done(false); }
      };
      document.addEventListener('keydown', onKey, true);
      cancel.addEventListener('click', () => done(false));
      confirm.addEventListener('click', () => {
        if (optionChecked && option && !window.confirm(option.finalCheck)) return;
        done(true);
      });
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

  private externalMediaSection(entry: RecordingHistoryEntry): HTMLElement {
    const section = $('section', 'recording-external-media');
    section.dataset.recordingId = entry.id;
    this.fillExternalMediaSection(section, entry);
    return section;
  }

  private fillExternalMediaSection(section: HTMLElement, entry: RecordingHistoryEntry): void {
    const transfers = this.externalMediaTransfers.filter((transfer) => transfer.recordingId === entry.id);
    section.hidden = transfers.length === 0;
    section.replaceChildren();
    if (!transfers.length) return;
    const label = $('div', 'detail-section-label'); label.textContent = 'EXTERNAL COPIES';
    const list = $('ul', 'external-media-list');
    for (const transfer of transfers) {
      const row = $('li', 'external-media-row');
      const copy = $('span', 'external-media-copy');
      const destination = $('span', 'external-media-destination');
      destination.textContent = transfer.destinationName || 'External service';
      const filename = entry.files.find((file) => file.id === transfer.fileId)?.filename;
      const file = $('span', 'external-media-file');
      file.textContent = filename || 'Recording media';
      copy.append(destination, file);
      const status = $('span', `external-media-status external-media-status--${transfer.state}`);
      status.textContent = externalMediaStatusLabel(transfer);
      row.append(copy, status);
      if ((transfer.state === 'action-required' || transfer.state === 'retry-wait') &&
          this.callbacks.retryExternalMedia) {
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'file-action external-media-retry'; retry.textContent = 'RETRY';
        retry.addEventListener('click', () => {
          retry.disabled = true;
          retry.textContent = 'RETRYING…';
          this.callbacks.retryExternalMedia?.(transfer.destinationId, transfer.clientTransferId);
        });
        row.append(retry);
      }
      list.append(row);
    }
    section.append(label, list);
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

function externalMediaStatusLabel(transfer: ExternalMediaTransferStatus): string {
  const percent = transfer.bytesTotal > 0
    ? Math.min(100, Math.floor(transfer.bytesUploaded / transfer.bytesTotal * 100))
    : 0;
  switch (transfer.state) {
    case 'acknowledged': return 'SAVED';
    case 'ready-unacknowledged': return 'FINALIZING';
    case 'verifying-capability': return 'VERIFYING';
    case 'uploading': return `UPLOADING ${percent}%`;
    case 'queued':
    case 'pending': return 'QUEUED';
    case 'retry-wait': return `RETRY SCHEDULED · ${percent}%`;
    case 'action-required':
      if (transfer.errorCategory === 'source') return 'SOURCE UNAVAILABLE';
      if (transfer.errorCategory === 'permission') return 'AUTHORIZATION REQUIRED';
      if (transfer.errorCategory === 'conflict') return 'RECEIVER CONFLICT';
      return `UPLOAD PAUSED · ${percent}%`;
    case 'canceled': return 'CANCELED';
  }
}
