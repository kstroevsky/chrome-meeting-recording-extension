import { notationRow } from '../notationRow';
import type { RecordingNotation } from '../../../shared/notations';

const note = (
  tStartMs: number,
  tEndMs?: number,
  text = '',
  endedBy?: 'user' | 'auto',
): RecordingNotation => ({
  id: 'n1',
  tStartMs,
  ...(tEndMs != null ? { tEndMs } : {}),
  ...(endedBy ? { endedBy } : {}),
  text,
});

const at = (row: HTMLElement, selector: string) => row.querySelector(selector) as HTMLElement;

describe('notationRow', () => {
  it('says when the note starts, what it says, and how long it ran', () => {
    const row = notationRow(note(48_000, 85_000, 'Q3 target changed', 'user'));

    expect(at(row, '.detail-notes-start').textContent).toBe('00:48');
    expect(at(row, '.detail-notes-text').textContent).toBe('Q3 target changed');
    expect(at(row, '.detail-notes-length').textContent).toBe('0:37');
  });

  it('invites a name for a note nobody named, and bands the row', () => {
    const row = notationRow(note(48_000, 85_000, '', 'user'));

    const text = at(row, '.detail-notes-text');
    // The length column already says how long it ran, so the label does not.
    expect(text.textContent).toBe('Name this one');
    expect(text.classList.contains('untitled')).toBe(true);
    expect(row.classList.contains('untitled')).toBe(true);
    expect(at(row, '.detail-notes-length').textContent).toBe('0:37');
  });

  it('leaves a named row unbanded', () => {
    expect(notationRow(note(48_000, 85_000, 'named', 'user')).classList.contains('untitled')).toBe(false);
  });

  it('has no length to report while a note is still open', () => {
    expect(at(notationRow(note(48_000)), '.detail-notes-length').textContent).toBe('—');
  });

  it('reports where a note ended, not how long it ran, when the run sealed it', () => {
    const row = notationRow(note(372_000, 401_000, 'Renewal date', 'auto'), { sealedAtMs: 401_000 });

    expect(at(row, '.detail-notes-length').textContent).toBe('ENDED AT 06:41');
  });

  it('still reports a length for a note the user closed on that same screen', () => {
    const row = notationRow(note(48_000, 85_000, 'Q3 target changed', 'user'), { sealedAtMs: 401_000 });

    expect(at(row, '.detail-notes-length').textContent).toBe('0:37');
  });

  it('is inert, and carries no actions wrapper, where the screen only reports', () => {
    const row = notationRow(note(48_000, 85_000, 'first', 'user'), { sealedAtMs: 401_000 });

    expect(at(row, '.detail-notes-row-main').tagName).toBe('SPAN');
    expect(row.querySelector('.detail-notes-actions')).toBeNull();
    expect(row.querySelector('.detail-notes-edit')).toBeNull();
    // The length still sits directly on the row, which is what the layout expects.
    expect(row.lastElementChild!.className).toBe('detail-notes-length');
  });

  it('wires select, rename and delete where the screen can act', () => {
    const calls: string[] = [];
    let renamedRow: HTMLElement | undefined;
    const row = notationRow(note(48_000, 85_000, 'first', 'user'), {
      selected: true,
      actions: {
        select: (id) => calls.push(`select:${id}`),
        rename: (target) => { calls.push('rename'); renamedRow = target; },
        remove: (id) => calls.push(`remove:${id}`),
      },
    });

    expect(row.classList.contains('selected')).toBe(true);
    (at(row, '.detail-notes-row-main') as HTMLButtonElement).click();
    (at(row, '.detail-notes-edit') as HTMLButtonElement).click();
    (at(row, '.detail-notes-delete') as HTMLButtonElement).click();

    expect(calls).toEqual(['select:n1', 'rename', 'remove:n1']);
    // Handed its own row, so a rename can swap the label in place.
    expect(renamedRow).toBe(row);
  });

  it('names the note in each control, so the list is navigable without sight', () => {
    const row = notationRow(note(48_000, 85_000, 'first', 'user'), {
      actions: { select: () => {}, rename: () => {}, remove: () => {} },
    });

    expect(at(row, '.detail-notes-edit').getAttribute('aria-label')).toBe('Rename note at 00:48');
    expect(at(row, '.detail-notes-delete').getAttribute('aria-label')).toBe('Delete note at 00:48');
  });
});
