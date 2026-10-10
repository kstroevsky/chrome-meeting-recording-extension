/**
 * The table's columns: every sortable header reverses on a second click, and a
 * recording's folder is a tag that narrows the list to that folder.
 */
import { RecordingsView, type RecordingsViewCallbacks } from '../RecordingsView';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';

function entry(id: string, overrides: Partial<RecordingHistoryEntry> & { bytes?: number } = {}): RecordingHistoryEntry {
  const { bytes, ...rest } = overrides;
  return {
    id,
    name: `Recording ${id}`,
    createdAt: 1_700_000_000_000,
    storageMode: 'local',
    status: 'complete',
    files: [historyFile({ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination: 'local', status: 'available', ...(bytes != null ? { bytes } : {}) })],
    ...rest,
  };
}

function mount() {
  const callbacks = {
    rename: jest.fn(), note: jest.fn(), remove: jest.fn(), removeMany: jest.fn(),
    openLocal: jest.fn(), fileTo: jest.fn(), play: jest.fn(), loadMore: jest.fn(),
  } as unknown as RecordingsViewCallbacks;
  const list = document.createElement('div');
  const empty = document.createElement('div');
  const error = document.createElement('div');
  document.body.replaceChildren(list, empty, error);
  return { view: new RecordingsView(list, empty, error, callbacks), list, callbacks };
}

const order = (list: HTMLElement) =>
  Array.from(list.querySelectorAll<HTMLElement>('.recording-row')).map((row) => row.dataset.recordingId);
const header = (list: HTMLElement, label: string) =>
  Array.from(list.querySelectorAll<HTMLButtonElement>('.table-header-button')).find((button) => button.textContent?.startsWith(label))!;
const groupLabel = (list: HTMLElement) => list.querySelector('.recording-day__label')?.textContent;

describe('RecordingsView sorting', () => {
  it('reverses duration on a second click, keeping unknown durations last', () => {
    const { view, list } = mount();
    view.render([
      entry('short', { durationMs: 60_000, bytes: 3_000 }),
      entry('long', { durationMs: 600_000, bytes: 1_000 }),
      entry('unknown', { bytes: 2_000 }),
      entry('mid', { durationMs: 300_000, bytes: 4_000 }),
    ]);

    header(list, 'DUR').click();
    expect(order(list)).toEqual(['long', 'mid', 'short', 'unknown']);
    expect(groupLabel(list)).toBe('SORTED BY DURATION · LONGEST FIRST · 4');
    expect(header(list, 'DUR').textContent).toBe('DUR▾');

    header(list, 'DUR').click();
    expect(order(list)).toEqual(['short', 'mid', 'long', 'unknown']);
    expect(groupLabel(list)).toBe('SORTED BY DURATION · SHORTEST FIRST · 4');
    expect(header(list, 'DUR').textContent).toBe('DUR▴');
  });

  it('reverses size on a second click, keeping unknown sizes last', () => {
    const { view, list } = mount();
    view.render([
      entry('small', { bytes: 1_000, createdAt: 4 }),
      entry('large', { bytes: 4_000, createdAt: 3 }),
      entry('no-size', { createdAt: 2 }),
      entry('medium', { bytes: 2_000, createdAt: 1 }),
    ]);

    header(list, 'SIZE').click();
    expect(order(list)).toEqual(['large', 'medium', 'small', 'no-size']);
    expect(groupLabel(list)).toBe('SORTED BY SIZE · LARGEST FIRST · 4');
    header(list, 'SIZE').click();
    expect(order(list)).toEqual(['small', 'medium', 'large', 'no-size']);
    expect(groupLabel(list)).toBe('SORTED BY SIZE · SMALLEST FIRST · 4');
  });

  it('reverses name and time too, and starts each column in its natural order', () => {
    const { view, list } = mount();
    view.render([
      entry('b', { name: 'Beta', createdAt: 2 }),
      entry('a', { name: 'Alpha', createdAt: 1 }),
      entry('c', { name: 'Gamma', createdAt: 3 }),
    ]);
    expect(order(list)).toEqual(['c', 'b', 'a']); // newest first by default

    header(list, 'NAME').click();
    expect(order(list)).toEqual(['a', 'b', 'c']);
    header(list, 'NAME').click();
    expect(order(list)).toEqual(['c', 'b', 'a']);
    expect(groupLabel(list)).toBe('SORTED BY NAME · Z–A · 3');

    header(list, 'TIME').click();
    expect(order(list)).toEqual(['c', 'b', 'a']);
    header(list, 'TIME').click();
    expect(order(list)).toEqual(['a', 'b', 'c']);
  });
});

describe('RecordingsView folder tags', () => {
  function library() {
    return [
      entry('therapy-1', { driveFolderPresetId: 'p-therapy', createdAt: 5 }),
      entry('work', { driveFolderPresetId: 'p-work', createdAt: 4 }),
      entry('rest', { createdAt: 3 }),
      entry('local-therapy', { localFolderName: 'Therapy', createdAt: 2 }),
      entry('gone-preset', { driveFolderPresetId: 'p-deleted', createdAt: 1 }),
    ];
  }

  it('shows the folder a recording is filed in, and nothing for the default one', () => {
    const { view, list } = mount();
    view.setDestinations([{ id: 'p-therapy', name: 'Therapy' }, { id: 'p-work', name: 'Work' }]);
    view.render(library());

    const tags = Object.fromEntries(Array.from(list.querySelectorAll<HTMLElement>('.recording-row'))
      .map((row) => [row.dataset.recordingId, row.querySelector('.recording-row__folder')?.textContent ?? null]));
    expect(tags).toEqual({
      'therapy-1': 'Therapy', work: 'Work', rest: null, 'local-therapy': 'Therapy', 'gone-preset': null,
    });
    expect(list.querySelector('.recording-table__header')!.textContent).toContain('FOLDER');
    expect(list.querySelector('.recording-row__remove')).toBeNull();
  });

  it('narrows the list to a folder on click, says so, and undoes it', () => {
    const { view, list, callbacks } = mount();
    view.setDestinations([{ id: 'p-therapy', name: 'Therapy' }, { id: 'p-work', name: 'Work' }]);
    view.render(library(), false, 5);

    list.querySelector<HTMLButtonElement>('[data-recording-id="therapy-1"] .recording-row__folder')!.click();
    expect(order(list)).toEqual(['therapy-1', 'local-therapy']);
    expect(callbacks.play).not.toHaveBeenCalled();
    expect(list.querySelector('.recordings-detail-host')!.childElementCount).toBe(0);
    expect(list.querySelector('.recordings-count')!.textContent).toBe('2 OF 5');
    const chip = list.querySelector<HTMLButtonElement>('.folder-filter-chip')!;
    expect(chip.textContent).toContain('Therapy');
    expect(list.querySelector('.recording-row__folder--active')!.getAttribute('aria-pressed')).toBe('true');

    chip.click();
    expect(order(list)).toHaveLength(5);
    expect(list.querySelector('.folder-filter-chip')).toBeNull();
    expect(list.querySelector('.recordings-count')!.textContent).toBe('5 RECORDINGS');

    list.querySelector<HTMLButtonElement>('[data-recording-id="work"] .recording-row__folder')!.click();
    expect(order(list)).toEqual(['work']);
    list.querySelector<HTMLButtonElement>('[data-recording-id="work"] .recording-row__folder')!.click();
    expect(order(list)).toHaveLength(5);

    list.querySelector<HTMLButtonElement>('[data-recording-id="work"] .recording-row__folder')!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(order(list)).toHaveLength(5);
  });
});

describe('RecordingsView selection toolbar', () => {
  const driveEntry = (id: string) => entry(id, {
    storageMode: 'drive',
    files: [historyFile({ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination: 'drive', status: 'available', driveFileId: `drive-${id}` })],
  });
  const select = (list: HTMLElement, id: string) =>
    list.querySelector<HTMLElement>(`.recording-row[data-recording-id="${id}"] .selection-box`)!.click();
  const move = (list: HTMLElement) =>
    Array.from(list.querySelectorAll<HTMLButtonElement>('.bulk-toolbar button')).find((button) => button.textContent === 'Move to Drive')!;

  it('offers no Move to Drive when everything selected is already on Drive', () => {
    const { view, list } = mount();
    view.render([driveEntry('a'), driveEntry('b')]);
    select(list, 'a');
    select(list, 'b');
    expect(move(list).hidden).toBe(true);
  });

  it('follows the selection as it grows: the count, and what Download acts on', () => {
    // Built into the toolbar once, these froze on the first recording selected.
    const { view, list, callbacks } = mount();
    const local = entry('b', { files: [historyFile({ id: 'b:tab', stream: 'tab', filename: 'b.webm', destination: 'local', status: 'available', downloadId: 7 })] });
    view.render([driveEntry('a'), local]);
    select(list, 'a');
    expect(list.querySelector('.bulk-toolbar__count')!.textContent).toBe('1 SELECTED');
    const download = () => Array.from(list.querySelectorAll<HTMLButtonElement>('.bulk-toolbar button')).find((button) => button.textContent === 'Download')!;
    expect(download().disabled).toBe(true);

    select(list, 'b');
    expect(list.querySelector('.bulk-toolbar__count')!.textContent).toBe('2 SELECTED');
    expect(download().disabled).toBe(false);
    download().click();
    expect(callbacks.openLocal).toHaveBeenCalledWith('b', 'b:tab');
  });

  it('keeps it in view when anything selected is local', () => {
    const { view, list } = mount();
    view.render([driveEntry('a'), entry('b')]);
    select(list, 'a');
    select(list, 'b');
    expect(move(list).hidden).toBe(false);
  });
});

describe('RecordingsView NOTES cell', () => {
  it('shows only the count, with the first note as its tooltip', () => {
    const { view, list } = mount();
    view.setNoteSummaries({ a: { count: 3, search: '', firstAtMs: 48_000, firstText: 'Q3 target changed' } });
    view.render([entry('a')]);
    const cell = list.querySelector<HTMLElement>('.recording-row__notes')!;
    expect(cell.textContent).toBe('3');
    expect(cell.title).toBe('3 notes · first at 00:48: Q3 target changed');
  });
});
