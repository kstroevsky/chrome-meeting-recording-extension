import { RecordingNotesView, type RecordingNotesElements } from '../RecordingNotesView';
import type { RecordingNotation } from '../../shared/notations';
import type { RecordingStatusView } from '../../shared/recording';

function build(): { el: RecordingNotesElements; root: HTMLElement } {
  const root = document.createElement('div');
  root.innerHTML = `
    <div id="ribbon"><div id="track"></div><span id="elapsed"></span><span id="playhead"></span></div>
    <span id="openTimer"></span>
    <button id="toggle"><span data-note-toggle-label></span></button>
    <div id="row"><button id="startButton"><span id="startLabel"></span></button><span id="count"></span></div>
    <p id="hint"></p>
    <div id="editor" hidden><div data-note-editor-dismiss></div>
      <span id="editorIndex"></span><span id="editorRange"></span><span id="editorLength"></span>
      <input id="editorText"><button id="editorSave"></button>
      <button id="editorDelete"></button><button id="editorClose"></button>
    </div>`;
  const q = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  return {
    root,
    el: {
      ribbon: q('ribbon'), track: q('track'), elapsed: q('elapsed'), playhead: q('playhead'),
      openTimer: q('openTimer'), toggle: q<HTMLButtonElement>('toggle'), row: q('row'),
      startButton: q<HTMLButtonElement>('startButton'), startLabel: q('startLabel'),
      count: q('count'), hint: q('hint'), editor: q('editor'),
      editorIndex: q('editorIndex'), editorRange: q('editorRange'), editorLength: q('editorLength'),
      editorText: q<HTMLInputElement>('editorText'), editorSave: q<HTMLButtonElement>('editorSave'),
      editorDelete: q<HTMLButtonElement>('editorDelete'), editorClose: q<HTMLButtonElement>('editorClose'),
    },
  };
}

const actions = () => ({
  mark: jest.fn().mockResolvedValue(undefined),
  end: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockResolvedValue(undefined),
  remove: jest.fn().mockResolvedValue(undefined),
});

/** A live session whose clock reads exactly `recordedMs`. */
const recording = (recordedMs: number): RecordingStatusView =>
  ({ phase: 'recording', recordedMs, runConfig: null, updatedAt: 0 } as unknown as RecordingStatusView);

const spans = (root: HTMLElement) => Array.from(root.querySelectorAll('.note-span')) as HTMLElement[];

describe('RecordingNotesView', () => {
  it('shows the row and the shortcut tip, and hides the ribbon, before any note exists', () => {
    const { el, root } = build();
    const view = new RecordingNotesView(el, actions());

    view.sync('recording', recording(10_000));
    view.setNotations([]);

    expect(el.count!.textContent).toBe('NONE YET');
    expect(el.hint!.hidden).toBe(false);
    expect(el.ribbon!.hidden).toBe(true);
    expect(spans(root)).toHaveLength(0);
  });

  it('retires the tip and reveals the ribbon once a note exists', () => {
    const { el } = build();
    const view = new RecordingNotesView(el, actions());

    view.sync('recording', recording(10_000));
    view.setNotations([{ id: 'n1', tStartMs: 1_000, tEndMs: 2_000, text: '' }]);

    expect(el.hint!.hidden).toBe(true);
    expect(el.ribbon!.hidden).toBe(false);
    expect(el.count!.textContent).toBe('1 NOTE');

    view.setNotations([
      { id: 'n1', tStartMs: 1_000, tEndMs: 2_000, text: '' },
      { id: 'n2', tStartMs: 3_000, tEndMs: 4_000, text: '' },
    ]);
    expect(el.count!.textContent).toBe('2 NOTES');
  });

  it('draws spans to scale, with the playhead short of the right edge', () => {
    const { el, root } = build();
    const view = new RecordingNotesView(el, actions());

    // 82s elapsed scales the track to 100s, so the numbers read directly.
    view.sync('recording', recording(82_000));
    view.setNotations([{ id: 'n1', tStartMs: 25_000, tEndMs: 50_000, text: 'quarter in' }]);

    const [span] = spans(root);
    expect(span.style.left).toBe('25%');
    expect(span.style.width).toBe('25%');
    // A live recording has no known end, so "now" keeps headroom to its right.
    expect(el.elapsed!.style.width).toBe('82%');
    expect(el.playhead!.style.left).toBe('82%');
  });

  it('draws an open span up to now, and shows its running length', () => {
    const { el, root } = build();
    const view = new RecordingNotesView(el, actions());

    view.sync('recording', recording(82_000));
    view.setNotations([{ id: 'n1', tStartMs: 40_000, text: 'still going' }]);

    const [span] = spans(root);
    expect(span.classList.contains('open')).toBe(true);
    expect(span.style.left).toBe('40%');
    // The open span runs up to "now" — its leading edge is the playhead.
    expect(span.style.width).toBe('42%');
    expect(el.openTimer!.hidden).toBe(false);
    expect(el.openTimer!.textContent).toBe('0:42');
  });

  it('marks a span the run sealed on the way out', () => {
    const { el, root } = build();
    const view = new RecordingNotesView(el, actions());

    view.sync('recording', recording(10_000));
    view.setNotations([{ id: 'n1', tStartMs: 1_000, tEndMs: 2_000, endedBy: 'auto', text: '' }]);

    expect(spans(root)[0].classList.contains('auto-ended')).toBe(true);
  });

  it('toggles between starting and ending, and never opens the editor doing so', () => {
    const { el } = build();
    const acts = actions();
    const view = new RecordingNotesView(el, acts);
    view.sync('recording', recording(10_000));

    view.setNotations([]);
    el.toggle!.click();
    expect(acts.mark).toHaveBeenCalledTimes(1);

    view.setNotations([{ id: 'n1', tStartMs: 1_000, text: '' }]);
    expect(el.toggle!.getAttribute('aria-pressed')).toBe('true');
    el.toggle!.click();
    expect(acts.end).toHaveBeenCalledWith('n1');

    // Ending a note is silent by design.
    expect(el.editor!.hidden).toBe(true);
  });

  it('opens the editor only when a closed span is clicked', () => {
    const { el, root } = build();
    const view = new RecordingNotesView(el, actions());
    view.sync('recording', recording(200_000));
    view.setNotations([
      { id: 'n1', tStartMs: 10_000, tEndMs: 20_000, text: 'first' },
      { id: 'n2', tStartMs: 154_000, tEndMs: 209_000, text: 'Pricing objection' },
    ]);

    spans(root)[1].click();

    expect(el.editor!.hidden).toBe(false);
    expect(el.editorIndex!.textContent).toBe('NOTE 2');
    expect(el.editorRange!.textContent).toBe('2:34 → 3:29');
    expect(el.editorLength!.textContent).toBe('0:55');
    expect(el.editorText!.value).toBe('Pricing objection');
    expect(spans(root)[1].classList.contains('editing')).toBe(true);
  });

  it('will not open the editor on an open span — there is no span to describe yet', () => {
    const { el, root } = build();
    const view = new RecordingNotesView(el, actions());
    view.sync('recording', recording(100_000));
    view.setNotations([{ id: 'n1', tStartMs: 10_000, text: '' }]);

    spans(root)[0].click();

    expect(el.editor!.hidden).toBe(true);
  });

  it('saves and deletes the edited note, then closes', async () => {
    const { el, root } = build();
    const acts = actions();
    const view = new RecordingNotesView(el, acts);
    view.sync('recording', recording(100_000));
    view.setNotations([{ id: 'n1', tStartMs: 10_000, tEndMs: 20_000, text: '' }]);

    spans(root)[0].click();
    el.editorText!.value = 'Renewal date';
    el.editorSave!.click();
    await Promise.resolve();
    expect(acts.save).toHaveBeenCalledWith('n1', 'Renewal date');
    expect(el.editor!.hidden).toBe(true);

    spans(root)[0].click();
    el.editorDelete!.click();
    await Promise.resolve();
    expect(acts.remove).toHaveBeenCalledWith('n1');
    expect(el.editor!.hidden).toBe(true);
  });

  it('closes the editor when the note disappears underneath it', () => {
    const { el, root } = build();
    const view = new RecordingNotesView(el, actions());
    view.sync('recording', recording(100_000));
    view.setNotations([{ id: 'n1', tStartMs: 10_000, tEndMs: 20_000, text: '' }]);
    spans(root)[0].click();
    expect(el.editor!.hidden).toBe(false);

    view.setNotations([]);

    expect(el.editor!.hidden).toBe(true);
  });

  it('reuses span elements across re-renders so a click target survives the tick', () => {
    const { el, root } = build();
    const view = new RecordingNotesView(el, actions());
    view.sync('recording', recording(100_000));
    const notations: RecordingNotation[] = [{ id: 'n1', tStartMs: 10_000, tEndMs: 20_000, text: '' }];
    view.setNotations(notations);
    const first = spans(root)[0];

    view.setNotations([...notations]);

    expect(spans(root)[0]).toBe(first);
  });

  it('hides the whole feature outside a live recording', () => {
    const { el } = build();
    const view = new RecordingNotesView(el, actions());
    view.setNotations([{ id: 'n1', tStartMs: 1_000, tEndMs: 2_000, text: '' }]);

    view.sync('idle', undefined);

    expect(el.row!.hidden).toBe(true);
    expect(el.ribbon!.hidden).toBe(true);
    expect(el.hint!.hidden).toBe(true);
  });

  it('tolerates a missing element group rather than crashing the popup', () => {
    expect(() => new RecordingNotesView(undefined, actions()).sync('recording', recording(1_000)))
      .not.toThrow();
  });
});
