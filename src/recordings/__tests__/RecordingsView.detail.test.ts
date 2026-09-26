import { NOTES_WAIT_MS, RecordingsView, type RecordingsViewCallbacks } from '../RecordingsView';
import { NOTE_UNDO_MS } from '../RecordingNotesSection';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { RecordingNotation } from '../../shared/notations';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function entry(id = 'weekly', name = 'Weekly sync'): RecordingHistoryEntry {
  return {
    id,
    name,
    createdAt: 1,
    storageMode: 'drive',
    status: 'complete',
    files: [historyFile({ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination: 'drive', status: 'available', webViewLink: 'https://drive.google.com/file/d/tab/view' })],
  };
}

const NOTES: RecordingNotation[] = [
  { id: 'n1', tStartMs: 48_000, tEndMs: 85_000, endedBy: 'user', text: 'Q3 target changed' },
  { id: 'n2', tStartMs: 312_000, tEndMs: 376_000, endedBy: 'user', text: 'Migration owner' },
];

function mount() {
  let notes = [...NOTES];
  const callbacks = {
    rename: jest.fn(), note: jest.fn(), remove: jest.fn(), removeMany: jest.fn(),
    openLocal: jest.fn(), fileTo: jest.fn(), play: jest.fn(), loadMore: jest.fn(),
    notes: {
      load: jest.fn(async () => notes),
      rename: jest.fn(async () => notes),
      remove: jest.fn(async (_recording: string, id: string) => { notes = notes.filter((n) => n.id !== id); return notes; }),
    },
  } satisfies RecordingsViewCallbacks;
  const list = document.createElement('div');
  const empty = document.createElement('div');
  const error = document.createElement('div');
  const loadMore = document.createElement('button');
  document.body.replaceChildren(list, empty, error, loadMore);
  const view = new RecordingsView(list, empty, error, loadMore, callbacks);
  return { view, list, callbacks };
}

async function open(list: HTMLElement): Promise<void> {
  list.querySelector<HTMLElement>('.recording-row')!.click();
  await flush();
}

describe('RecordingsView detail (f2, f17)', () => {
  afterEach(() => jest.useRealTimers());

  it('removes from the library only, unless "also delete its files" is ticked', async () => {
    const { view, list, callbacks } = mount();
    const onDrive = entry();
    onDrive.files = [{ ...onDrive.files[0], driveFileId: 'drive-tab', locations: [{ kind: 'drive', fileId: 'drive-tab' }] }];
    view.render([onDrive]);
    const card = () => document.querySelector<HTMLElement>('.confirm-card')!;

    const quiet = jest.spyOn(window, 'confirm');
    list.querySelector<HTMLButtonElement>('.recording-row__remove')!.click();
    expect(card().querySelector('.confirm-card__body')!.textContent).toContain('stays in Drive');
    card().querySelector<HTMLButtonElement>('.confirm-card__confirm')!.click();
    expect(callbacks.remove).toHaveBeenLastCalledWith('weekly', false);
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();

    list.querySelector<HTMLButtonElement>('.recording-row__remove')!.click();
    const box = card().querySelector<HTMLInputElement>('.confirm-card__checkbox')!;
    expect(box.checked).toBe(false);
    box.click();
    expect(card().querySelector('.confirm-card__body')!.textContent)
      .toContain('1 file goes to the Google Drive trash (recoverable for 30 days).');
    expect(card().querySelector('.confirm-card__body')!.textContent).toContain('the share ends');
    expect(card().querySelector('.confirm-card__confirm')!.textContent).toBe('Remove and delete files');

    // Deleting files asks once more, natively. Declining keeps the dialog open
    // and removes nothing; accepting goes ahead.
    const nativeConfirm = jest.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    card().querySelector<HTMLButtonElement>('.confirm-card__confirm')!.click();
    expect(nativeConfirm).toHaveBeenLastCalledWith(expect.stringContaining('move 1 file to the Google Drive trash'));
    expect(callbacks.remove).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.confirm-card')).not.toBeNull();

    card().querySelector<HTMLButtonElement>('.confirm-card__confirm')!.click();
    expect(callbacks.remove).toHaveBeenLastCalledWith('weekly', true);
    expect(document.querySelector('.confirm-card')).toBeNull();
    expect(nativeConfirm).toHaveBeenCalledTimes(2);
    nativeConfirm.mockRestore();
  });

  it('keeps the list where it was scrolled when a recording opens', async () => {
    const { view, list } = mount();
    view.render(Array.from({ length: 30 }, (_, i) => entry(`rec-${i}`, `Recording ${i}`)));
    list.querySelector<HTMLElement>('.recording-table__scroll')!.scrollTop = 420;

    list.querySelectorAll<HTMLElement>('.recording-row')[20].click();
    await flush();

    expect(list.querySelector('.recording-detail')).not.toBeNull();
    expect(list.querySelector<HTMLElement>('.recording-table__scroll')!.scrollTop).toBe(420);
  });

  it('rows carry no play control; watching starts from the detail (f2)', async () => {
    const { view, list, callbacks } = mount();
    view.render([entry()]);
    expect(list.querySelector('.recording-row__play')).toBeNull();

    await open(list);
    expect(list.querySelector('.detail-section-label')?.textContent).toBe('DESCRIPTION');
    list.querySelector<HTMLButtonElement>('.modal-button--watch')!.click();
    expect(callbacks.play).toHaveBeenCalledWith('weekly');
  });

  it('opens once the notes are in, so the modal never grows after it appears', async () => {
    const { view, list, callbacks } = mount();
    let answer!: (notes: RecordingNotation[]) => void;
    callbacks.notes.load.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    view.render([entry()]);

    list.querySelector<HTMLElement>('.recording-row')!.click();
    await flush();
    expect(list.querySelector('.recording-detail')).toBeNull();

    answer(NOTES);
    await flush();
    expect(list.querySelector('.recording-detail')).not.toBeNull();
    expect(list.querySelectorAll('.detail-notes__row')).toHaveLength(2);
  });

  it('opens anyway when the notes are slow, and lets them follow', async () => {
    jest.useFakeTimers();
    const { view, list, callbacks } = mount();
    let answer!: (notes: RecordingNotation[]) => void;
    callbacks.notes.load.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    view.render([entry()]);

    list.querySelector<HTMLElement>('.recording-row')!.click();
    jest.advanceTimersByTime(NOTES_WAIT_MS);
    await flush();
    expect(list.querySelector('.recording-detail')).not.toBeNull();
    expect(list.querySelectorAll('.detail-notes__row')).toHaveLength(0);

    answer(NOTES);
    await flush();
    expect(list.querySelectorAll('.detail-notes__row')).toHaveLength(2);
  });

  it('lists the notes under a spoiler that folds to a one-line range', async () => {
    const { view, list } = mount();
    view.render([entry()]);
    await open(list);

    expect(list.querySelectorAll('.detail-notes__row')).toHaveLength(2);
    list.querySelector<HTMLButtonElement>('.detail-notes__toggle')!.click();
    expect(list.querySelector<HTMLElement>('.detail-notes__list')!.hidden).toBe(true);
    expect(list.querySelector('.detail-notes__range')?.textContent).toBe('00:48 → 05:12 · 2 named');
  });

  it('asks before removing a recording, naming what goes and what stays (f17)', async () => {
    const { view, list, callbacks } = mount();
    view.setNoteSummaries({ weekly: { count: 2, search: '', firstAtMs: 48_000, firstText: 'Q3 target changed' } });
    view.render([entry()]);

    list.querySelector<HTMLButtonElement>('.recording-row__remove')!.click();
    const card = document.querySelector('.confirm-card')!;
    expect(card.textContent).toContain('Remove “Weekly sync” from history?');
    expect(card.textContent).toContain('The 2 notes and the transcript are deleted with it.');
    expect(callbacks.remove).not.toHaveBeenCalled();

    document.querySelector<HTMLButtonElement>('.confirm-card__cancel')!.click();
    expect(document.querySelector('.confirm-card')).toBeNull();
    expect(callbacks.remove).not.toHaveBeenCalled();

    list.querySelector<HTMLButtonElement>('.recording-row__remove')!.click();
    document.querySelector<HTMLButtonElement>('.confirm-card__confirm')!.click();
    expect(callbacks.remove).toHaveBeenCalledWith('weekly', false);
  });

  it('arms a note delete in its row and only writes it once the undo window passes', async () => {
    jest.useFakeTimers();
    const { view, list, callbacks } = mount();
    view.render([entry()]);
    await open(list);

    list.querySelectorAll<HTMLButtonElement>('.detail-notes__delete')[1].click();
    expect(list.querySelector('.detail-notes__row--armed')?.textContent).toContain('Delete this note?');
    list.querySelector<HTMLButtonElement>('.detail-notes__confirm')!.click();
    await flush();

    // Gone from the list, announced with UNDO, not yet written.
    expect(list.querySelectorAll('.detail-notes__row')).toHaveLength(1);
    expect(document.querySelector('.undo-toast')?.textContent).toContain('“Migration owner” deleted');
    expect(callbacks.notes.remove).not.toHaveBeenCalled();

    jest.advanceTimersByTime(NOTE_UNDO_MS);
    await flush();
    expect(callbacks.notes.remove).toHaveBeenCalledWith('weekly', 'n2');
    expect(document.querySelector('.undo-toast')).toBeNull();
  });

  it('puts an undone note back without writing anything', async () => {
    const { view, list, callbacks } = mount();
    view.render([entry()]);
    await open(list);

    list.querySelectorAll<HTMLButtonElement>('.detail-notes__delete')[0].click();
    list.querySelector<HTMLButtonElement>('.detail-notes__confirm')!.click();
    await flush();
    document.querySelector<HTMLButtonElement>('.undo-toast__undo')!.click();
    await flush();

    expect(callbacks.notes.remove).not.toHaveBeenCalled();
    expect(list.querySelectorAll('.detail-notes__row')).toHaveLength(2);
  });
});

describe('RecordingsView note editor entry (f2 → f5)', () => {
  function mountEditable(initial: RecordingNotation[] = NOTES) {
    let notes = [...initial];
    const notesChanged = jest.fn();
    const callbacks = {
      rename: jest.fn(), note: jest.fn(), remove: jest.fn(), removeMany: jest.fn(),
      openLocal: jest.fn(), fileTo: jest.fn(), play: jest.fn(), loadMore: jest.fn(),
      notes: {
        load: jest.fn(async () => notes),
        rename: jest.fn(async () => notes),
        remove: jest.fn(async () => notes),
        add: jest.fn(async (_recording: string, note: { tStartMs: number; tEndMs?: number; text: string }) => {
          notes = [...notes, { id: 'added', endedBy: 'user' as const, ...note }];
          return notes;
        }),
        update: jest.fn(async () => notes),
      },
      editor: { transcript: jest.fn(async () => undefined), notesChanged },
    } satisfies RecordingsViewCallbacks;
    const list = document.createElement('div');
    const empty = document.createElement('div');
    const error = document.createElement('div');
    const loadMore = document.createElement('button');
    document.body.replaceChildren(list, empty, error, loadMore);
    const view = new RecordingsView(list, empty, error, loadMore, callbacks);
    return { view, list, callbacks, notesChanged };
  }

  it('offers no ADD where the page cannot edit notes', async () => {
    const { view, list } = mount();
    view.render([entry()]);
    await open(list);
    expect(list.querySelector('.detail-notes__add')).toBeNull();
  });

  it('keeps the empty track and ADD on a recording nobody noted (f4)', async () => {
    const { view, list } = mountEditable([]);
    view.render([entry()]);
    await open(list);
    const section = list.querySelector<HTMLElement>('.detail-notes')!;
    expect(section.hidden).toBe(false);
    expect(section.classList.contains('detail-notes--empty')).toBe(true);
    expect(list.querySelector('.detail-notes__count')?.textContent).toBe('0');
    expect(list.querySelector('.detail-notes__add')).not.toBeNull();
  });

  it('opens the editor in the details dialog\'s place, and Done returns to Details with the new note', async () => {
    const { view, list, notesChanged } = mountEditable();
    view.render([entry()]);
    await open(list);

    list.querySelector<HTMLButtonElement>('.detail-notes__add')!.click();
    await flush();
    expect(list.querySelector('.recording-detail')).toBeNull();
    const editor = document.querySelector<HTMLElement>('.note-editor')!;
    expect(editor.getAttribute('aria-label')).toBe('Add notes to Weekly sync');

    editor.querySelector<HTMLButtonElement>('.note-editor__span-button')!.click();
    editor.querySelector<HTMLButtonElement>('.note-editor__span-button')!.click();
    await flush();
    editor.querySelector<HTMLButtonElement>('.note-editor__done')!.click();
    await flush();
    await flush();

    expect(document.querySelector('.note-editor')).toBeNull();
    expect(notesChanged).toHaveBeenCalled();
    expect(list.querySelector('.recording-detail')).not.toBeNull();
    expect(list.querySelector('.detail-notes__count')?.textContent).toBe('3');
  });
});
