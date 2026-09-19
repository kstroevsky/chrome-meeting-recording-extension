import { NoteEditor, type NoteEditorDeps } from '../NoteEditor';
import type { RecordingNotation } from '../../shared/notations';
import type { TranscriptSegment } from '../../shared/transcript';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const seg = (startS: number, endS: number, text: string): TranscriptSegment => ({ tStartMs: startS * 1000, tEndMs: endS * 1000, speaker: 'Alex', text });
const NOTES: RecordingNotation[] = [
  { id: 'n1', tStartMs: 19_000, tEndMs: 30_000, endedBy: 'user', text: 'Migration owner' },
];
const SEGMENTS = [seg(10, 12, 'a'), seg(20, 22, 'b'), seg(40, 42, 'c'), seg(50, 52, 'd'), seg(60, 62, 'e')];

function make(over: { segments?: TranscriptSegment[] | null } & Partial<NoteEditorDeps> = {}) {
  let notes = [...NOTES];
  const deps = {
    recording: { id: 'weekly', name: 'Weekly sync', durationMs: 100_000 },
    notes: {
      load: jest.fn(async () => notes),
      rename: jest.fn(async () => notes),
      remove: jest.fn(async () => notes),
      offerUndo: jest.fn(async () => false),
      add: jest.fn(async (_id: string, note: { tStartMs: number; tEndMs?: number; text: string }) => {
        notes = [...notes, { id: `new${notes.length}`, endedBy: 'user' as const, ...note }].sort((a, b) => a.tStartMs - b.tStartMs);
        return notes;
      }),
      update: jest.fn(async (_id: string, noteId: string, patch: object) => {
        notes = notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n));
        return notes;
      }),
    },
    transcript: jest.fn(async () => (over.segments === null ? undefined : { source: 'meet-captions' as const, segments: over.segments ?? SEGMENTS })),
    onDetails: jest.fn(),
    onClose: jest.fn(),
    ...over,
  };
  const editor = new NoteEditor(deps);
  document.body.append(editor.element);
  const q = <T extends HTMLElement>(selector: string) => editor.element.querySelector<T>(selector)!;
  return { editor, deps, q };
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.note-editor__line'));
const drag = (from: number, to: number) => {
  rows()[from].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  rows()[to].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  document.dispatchEvent(new Event('pointerup'));
};

afterEach(() => { document.body.replaceChildren(); });

describe('NoteEditor with a transcript (f5)', () => {
  it('lists the lines, naming a saved note beside the first line it covers', async () => {
    const { editor, q } = make();
    await editor.open();
    expect(rows()).toHaveLength(5);
    expect(Array.from(document.querySelectorAll('.note-editor__note-name'), (n) => n.textContent)).toEqual(['Migration owner']);
    expect(q('.note-editor__video-chip').hidden).toBe(false);
    expect(q('.note-editor__no-transcript').hidden).toBe(true);
    expect(q('.note-editor__hint').textContent).toBe('DRAG OVER LINES TO SET THE RANGE');
  });

  it('turns a drag over lines into a span, and saves it with its name', async () => {
    const { editor, deps, q } = make();
    await editor.open();
    drag(2, 3);

    expect(q('.note-editor__composer').hidden).toBe(false);
    expect(q('.note-editor__range').textContent).toBe('00:40 → 00:52');
    expect(q('.note-editor__length').textContent).toBe('0:12');
    expect(q('.note-editor__count').textContent).toBe('1 NOTE · 1 OPEN');
    expect(rows().filter((row) => row.classList.contains('note-editor__line--draft'))).toHaveLength(2);

    q<HTMLInputElement>('.note-editor__name').value = 'Checklist owner';
    q<HTMLButtonElement>('.note-editor__primary').click();
    await flush();

    expect(deps.notes.add).toHaveBeenCalledWith('weekly', { tStartMs: 40_000, tEndMs: 52_000, text: 'Checklist owner' });
    expect(q('.note-editor__composer').hidden).toBe(true);
    expect(q('.note-editor__count').textContent).toBe('2 NOTES');
  });

  it('plays from a line that is clicked rather than dragged', async () => {
    const { editor, q } = make();
    await editor.open();
    rows()[3].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    document.dispatchEvent(new Event('pointerup'));
    expect(q('.note-editor__composer').hidden).toBe(true);
    expect(q('.note-editor__clock').textContent).toBe('00:50');
  });

  it('opens a saved note for editing only through its name, and writes it back', async () => {
    const { editor, deps, q } = make();
    await editor.open();
    q('.note-editor__note-name').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));

    expect(q<HTMLInputElement>('.note-editor__name').value).toBe('Migration owner');
    expect(q('.note-editor__range').textContent).toBe('00:19 → 00:30');
    // Editing a saved note opens nothing new.
    expect(q('.note-editor__count').textContent).toBe('1 NOTE');

    q<HTMLInputElement>('.note-editor__name').value = 'Migration owner — Sasha';
    q<HTMLButtonElement>('.note-editor__primary').click();
    await flush();
    expect(deps.notes.update).toHaveBeenCalledWith('weekly', 'n1', { tStartMs: 19_000, tEndMs: 30_000, text: 'Migration owner — Sasha' });
  });

  it('trims a span by its grab handles, and says the range while one is held', async () => {
    const { editor, q } = make();
    await editor.open();
    drag(2, 3);
    q('.note-editor__scrub').getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 16, right: 1000, bottom: 16, x: 0, y: 0, toJSON: () => ({}) });

    q('.note-editor__handle--end').dispatchEvent(new Event('pointerdown'));
    document.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 700 }));
    expect(q('.note-editor__range').textContent).toBe('00:40 → 01:10');
    expect(q('.note-editor__bubble').hidden).toBe(false);

    document.dispatchEvent(new Event('pointerup'));
    expect(q('.note-editor__bubble').hidden).toBe(true);
  });

  it('cancels a selection without writing anything', async () => {
    const { editor, deps, q } = make();
    await editor.open();
    drag(2, 3);
    q<HTMLButtonElement>('.note-editor__secondary').click();
    expect(q('.note-editor__composer').hidden).toBe(true);
    expect(rows().some((row) => row.classList.contains('note-editor__line--draft'))).toBe(false);
    expect(deps.notes.add).not.toHaveBeenCalled();
  });

  it('keeps a finished span on Done, and returns to Details', async () => {
    const { editor, deps, q } = make();
    await editor.open();
    drag(2, 3);
    q<HTMLButtonElement>('.note-editor__done').click();
    await flush();
    expect(deps.notes.add).toHaveBeenCalledWith('weekly', { tStartMs: 40_000, tEndMs: 52_000, text: '' });
    expect(deps.onDetails).toHaveBeenCalled();
  });

  it('closes on × without writing a half-made span', async () => {
    const { editor, deps, q } = make();
    await editor.open();
    drag(2, 3);
    q<HTMLButtonElement>('.note-editor__close').click();
    expect(deps.onClose).toHaveBeenCalled();
    expect(deps.notes.add).not.toHaveBeenCalled();
  });
});

describe('NoteEditor without a transcript (f6)', () => {
  it('lists the saved notes in their detail rows, and says there is no transcript', async () => {
    const { editor, q } = make({ segments: null });
    await editor.open();
    await flush();
    expect(q('.note-editor__no-transcript').hidden).toBe(false);
    expect(q('.note-editor__video-chip').hidden).toBe(true);
    expect(document.querySelectorAll('.detail-notes__row')).toHaveLength(1);
    expect(q('.note-editor__hint').textContent).toBe('NOTE OPENS A SPAN AT THE PLAYHEAD');
  });

  it('opens a span at the playhead on NOTE, lists it as running, and keeps it on END', async () => {
    const { editor, deps, q } = make({ segments: null });
    await editor.open();
    await flush();
    q('.note-editor__scrub').getBoundingClientRect = () => ({ left: 0, width: 1000, top: 0, height: 16, right: 1000, bottom: 16, x: 0, y: 0, toJSON: () => ({}) });
    q('.note-editor__scrub').dispatchEvent(Object.assign(new Event('pointerdown'), { clientX: 400 }));

    q<HTMLButtonElement>('.note-editor__span-button').click();
    expect(q('.note-editor__span-button').textContent).toBe('END');
    expect(q('.note-editor__range').textContent).toBe('00:40 → running');
    expect(q<HTMLButtonElement>('.note-editor__primary').hidden).toBe(true);
    expect(q('.note-editor__secondary').textContent).toBe('Discard');
    expect(q('.note-editor__hint').textContent).toBe('PRESS END TO CLOSE THE SPAN');

    const name = q<HTMLInputElement>('.note-editor__name');
    name.value = 'Checklist owner';
    name.dispatchEvent(new Event('input'));
    const open = q('.detail-notes__row--open');
    expect(open.textContent).toContain('Checklist owner');
    expect(open.textContent).toContain('running');

    q('.note-editor__scrub').dispatchEvent(Object.assign(new Event('pointerdown'), { clientX: 450 }));
    q<HTMLButtonElement>('.note-editor__span-button').click();
    await flush();
    expect(deps.notes.add).toHaveBeenCalledWith('weekly', { tStartMs: 40_000, tEndMs: 45_000, text: 'Checklist owner' });
    expect(q('.note-editor__span-button').textContent).toBe('NOTE');
  });

  it('throws a running span away on Discard rather than saving it unnamed', async () => {
    const { editor, deps, q } = make({ segments: null });
    await editor.open();
    await flush();
    q<HTMLButtonElement>('.note-editor__span-button').click();
    q<HTMLButtonElement>('.note-editor__secondary').click();
    expect(document.querySelector('.detail-notes__row--open')).toBeNull();
    expect(q('.note-editor__span-button').textContent).toBe('NOTE');
    expect(deps.notes.add).not.toHaveBeenCalled();
  });
});
