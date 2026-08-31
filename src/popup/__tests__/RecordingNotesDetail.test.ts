import {
  RecordingNotesDetail,
  type RecordingNotesDetailActions,
  type RecordingNotesDetailOptions,
} from '../RecordingNotesDetail';
import type { RecordingNotation } from '../../shared/notations';

const note = (id: string, tStartMs: number, tEndMs: number | undefined, text: string, endedBy?: 'user' | 'auto'): RecordingNotation =>
  ({ id, tStartMs, ...(tEndMs != null ? { tEndMs } : {}), ...(endedBy ? { endedBy } : {}), text });

const NO_DURATION = Symbol('no duration');

function harness(
  notations: RecordingNotation[],
  durationMs: number | typeof NO_DURATION = 1_360_000,
  options?: RecordingNotesDetailOptions,
) {
  let current = [...notations];
  const actions: RecordingNotesDetailActions & { calls: string[] } = {
    calls: [],
    load: async () => { actions.calls.push('load'); return current; },
    rename: async (_r, id, text) => {
      actions.calls.push(`rename:${id}:${text}`);
      current = current.map((n) => (n.id === id ? { ...n, text: text.trim() } : n));
      return current;
    },
    remove: async (_r, id) => {
      actions.calls.push(`remove:${id}`);
      current = current.filter((n) => n.id !== id);
      return current;
    },
  };
  const view = new RecordingNotesDetail('recording:1', durationMs === NO_DURATION ? undefined : durationMs, actions, options ?? { timeline: true });
  document.body.replaceChildren(view.element);
  return { view, actions, el: view.element };
}

const spans = (el: HTMLElement) => Array.from(el.querySelectorAll('.detail-notes-span')) as HTMLElement[];
const rows = (el: HTMLElement) => Array.from(el.querySelectorAll('.detail-notes-row')) as HTMLElement[];
/** jsdom keeps full float precision where a browser rounds, so compare numerically. */
const pct = (value: string) => Number.parseFloat(value);

describe('RecordingNotesDetail', () => {
  it('says so, and teaches the shortcut, for a recording nobody noted (f4)', async () => {
    const { view, el } = harness([]);
    await view.load();

    expect(el.hidden).toBe(false);
    expect((el.querySelector('.detail-notes-empty') as HTMLElement).hidden).toBe(false);
    expect(el.querySelector('.detail-notes-empty-title')!.textContent).toBe('No notes in this recording');
    expect(el.querySelector('.detail-notes-empty-body kbd')!.textContent).toBe('⌥M');
    // The heading and list stay out of the way; the track keeps the shape.
    expect((el.querySelector('.detail-notes-head') as HTMLElement).hidden).toBe(true);
    expect(el.querySelector('.detail-notes-track')).not.toBeNull();
  });

  it('stays out of the saved screen entirely when there is nothing to fold', async () => {
    const { view, el } = harness([], 1_360_000, { timeline: false, collapsible: true });
    await view.load();
    expect(el.hidden).toBe(true);
  });

  it('draws every span against the recording duration', async () => {
    const { view, el } = harness([
      note('n1', 48_000, 85_000, 'Q3 target changed', 'user'),
      note('n2', 312_000, 376_000, 'Migration owner', 'user'),
      note('n3', 1_074_000, 1_119_000, '', 'auto'),
    ]);
    await view.load();

    expect(el.hidden).toBe(false);
    expect(el.querySelector('.detail-notes-count')!.textContent).toBe('3');
    // 48s and 312s of 1360s.
    expect(pct(spans(el)[0].style.left)).toBeCloseTo(3.53, 2);
    expect(pct(spans(el)[1].style.left)).toBeCloseTo(22.94, 2);
    // The run sealed the last one, so it reads muted.
    expect(spans(el)[2].classList.contains('auto-ended')).toBe(true);
  });

  it('falls back to the notes themselves when the row has no duration', async () => {
    const { view, el } = harness([note('n1', 100_000, 200_000, 'only note', 'user')], NO_DURATION);
    await view.load();
    // Scaled to the last end rather than dividing by zero.
    expect(pct(spans(el)[0].style.left)).toBeCloseTo(50, 5);
  });

  it('lists each note with its start and length', async () => {
    const { view, el } = harness([note('n1', 48_000, 85_000, 'Q3 target changed', 'user')]);
    await view.load();

    const row = rows(el)[0];
    expect(row.querySelector('.detail-notes-start')!.textContent).toBe('0:48');
    expect(row.querySelector('.detail-notes-text')!.textContent).toBe('Q3 target changed');
    expect(row.querySelector('.detail-notes-length')!.textContent).toBe('0:37');
  });

  it('invites a name for a note that was marked but never written', async () => {
    const { view, el } = harness([note('n1', 1_000, 2_000, '', 'auto')]);
    await view.load();

    const text = el.querySelector('.detail-notes-text')!;
    expect(text.textContent).toBe('Name this one');
    expect(text.classList.contains('untitled')).toBe(true);
    // The row is banded, so it reads as the one item still open.
    expect(rows(el)[0].classList.contains('untitled')).toBe(true);
  });

  it('selecting a span marks its row and drops the marker on it', async () => {
    const { view, el } = harness([
      note('n1', 48_000, 85_000, 'first', 'user'),
      note('n2', 312_000, 376_000, 'second', 'user'),
    ]);
    await view.load();

    spans(el)[1].click();

    expect(spans(el)[1].classList.contains('selected')).toBe(true);
    expect(rows(el)[1].classList.contains('selected')).toBe(true);
    expect(pct((el.querySelector('.detail-notes-marker') as HTMLElement).style.left)).toBeCloseTo(22.94, 2);
  });

  it('selecting the same span again clears it', async () => {
    const { view, el } = harness([note('n1', 48_000, 85_000, 'first', 'user')]);
    await view.load();

    spans(el)[0].click();
    spans(el)[0].click();

    expect(el.querySelector('.detail-notes-marker')).toBeNull();
  });

  it('renames in place on Enter', async () => {
    const { view, el, actions } = harness([note('n1', 48_000, 85_000, 'old', 'user')]);
    await view.load();

    (rows(el)[0].querySelector('.detail-notes-edit') as HTMLButtonElement).click();
    const input = rows(el)[0].querySelector('.detail-notes-input') as HTMLInputElement;
    input.value = 'new';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actions.calls).toContain('rename:n1:new');
    expect(el.querySelector('.detail-notes-text')!.textContent).toBe('new');
  });

  it('abandons a rename on Escape without writing', async () => {
    const { view, el, actions } = harness([note('n1', 48_000, 85_000, 'old', 'user')]);
    await view.load();

    (rows(el)[0].querySelector('.detail-notes-edit') as HTMLButtonElement).click();
    const input = rows(el)[0].querySelector('.detail-notes-input') as HTMLInputElement;
    input.value = 'discarded';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actions.calls.some((call) => call.startsWith('rename'))).toBe(false);
    expect(el.querySelector('.detail-notes-text')!.textContent).toBe('old');
  });

  it('deletes a note and updates the count', async () => {
    const { view, el, actions } = harness([
      note('n1', 48_000, 85_000, 'first', 'user'),
      note('n2', 312_000, 376_000, 'second', 'user'),
    ]);
    await view.load();

    (rows(el)[0].querySelector('.detail-notes-delete') as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(actions.calls).toContain('remove:n1');
    expect(rows(el)).toHaveLength(1);
    expect(el.querySelector('.detail-notes-count')!.textContent).toBe('1');
  });

  it('keeps the detail view usable when the notes cannot be read', async () => {
    const failing: RecordingNotesDetailActions = {
      load: async () => { throw new Error('offline'); },
      rename: async () => [],
      remove: async () => [],
    };
    const view = new RecordingNotesDetail('recording:1', 1_000, failing);
    await expect(view.load()).resolves.toBeUndefined();
    // Reads as "no notes" rather than breaking the detail screen.
    expect(view.element.querySelector('.detail-notes-list')!.children).toHaveLength(0);
  });

  describe('folded variant (n2a → n2c)', () => {
    const collapsible = (notes: RecordingNotation[]) =>
      harness(notes, 1_360_000, { timeline: false, collapsible: true });

    it('hides the timeline and folds the list behind its heading', async () => {
      const { view, el } = collapsible([note('n1', 48_000, 85_000, 'Q3 target changed', 'user')]);
      await view.load();

      expect((el.querySelector('.detail-notes-timeline') as HTMLElement).hidden).toBe(true);
      expect((el.querySelector('.detail-notes-list') as HTMLElement).hidden).toBe(true);
      expect(el.querySelector('.detail-notes-toggle')!.getAttribute('aria-expanded')).toBe('false');
      // The count is legible while folded — that is the point of the fold.
      expect(el.querySelector('.detail-notes-count')!.textContent).toBe('1');
    });

    it('opens and closes on the heading', async () => {
      const { view, el } = collapsible([note('n1', 48_000, 85_000, 'first', 'user')]);
      await view.load();
      const toggle = el.querySelector('.detail-notes-toggle') as HTMLButtonElement;

      toggle.click();
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect((el.querySelector('.detail-notes-list') as HTMLElement).hidden).toBe(false);

      toggle.click();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect((el.querySelector('.detail-notes-list') as HTMLElement).hidden).toBe(true);
    });

    it('still lists the same rows as the always-open variant', async () => {
      const { view, el } = collapsible([
        note('n1', 48_000, 85_000, 'Q3 target changed', 'user'),
        note('n2', 312_000, 376_000, '', 'auto'),
      ]);
      await view.load();
      (el.querySelector('.detail-notes-toggle') as HTMLButtonElement).click();

      expect(rows(el)).toHaveLength(2);
      expect(rows(el)[1].querySelector('.detail-notes-text')!.textContent).toBe('Name this one');
    });
  });
});
