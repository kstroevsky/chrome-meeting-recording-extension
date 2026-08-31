import { NotationRibbon, describeNotation } from '../notationRibbon';
import type { RecordingNotation } from '../../../shared/notations';

const note = (
  id: string,
  tStartMs: number,
  tEndMs?: number,
  text = '',
  endedBy?: 'user' | 'auto',
): RecordingNotation => ({
  id,
  tStartMs,
  ...(tEndMs != null ? { tEndMs } : {}),
  ...(endedBy ? { endedBy } : {}),
  text,
});

function track(): HTMLElement {
  const el = document.createElement('div');
  document.body.replaceChildren(el);
  return el;
}

const spans = (el: HTMLElement) => Array.from(el.querySelectorAll('.note-span')) as HTMLElement[];
/** jsdom keeps full float precision where a browser rounds, so compare numerically. */
const pct = (value: string) => Number.parseFloat(value);

describe('NotationRibbon', () => {
  it('places a span where it sits in the scaled track', () => {
    const el = track();
    new NotationRibbon(el, { spanClass: 'note-span' })
      .draw([note('n1', 25_000, 50_000)], { scaleMs: 100_000 });

    expect(pct(spans(el)[0].style.left)).toBeCloseTo(25, 5);
    expect(pct(spans(el)[0].style.width)).toBeCloseTo(25, 5);
  });

  it('draws an open span to the position the surface says is now', () => {
    const el = track();
    new NotationRibbon(el, { spanClass: 'note-span' })
      .draw([note('n1', 20_000)], { scaleMs: 100_000, openEndsAtMs: 60_000 });

    expect(pct(spans(el)[0].style.width)).toBeCloseTo(40, 5);
  });

  it('gives an open span no length when the surface has no "now" to offer', () => {
    const el = track();
    new NotationRibbon(el, { spanClass: 'note-span' })
      .draw([note('n1', 20_000)], { scaleMs: 100_000 });

    expect(pct(spans(el)[0].style.width)).toBeCloseTo(0, 5);
  });

  it('floors a point mark so it stays visible when asked to', () => {
    const el = track();
    new NotationRibbon(el, { spanClass: 'note-span', minWidthPct: 1 })
      .draw([note('n1', 10_000, 10_000)], { scaleMs: 100_000 });

    expect(pct(spans(el)[0].style.width)).toBeCloseTo(1, 5);
  });

  it('never runs a span past the end of the track', () => {
    const el = track();
    new NotationRibbon(el, { spanClass: 'note-span' })
      .draw([note('n1', 900_000, 5_000_000)], { scaleMs: 1_000_000 });

    const [span] = spans(el);
    expect(pct(span.style.left)).toBeCloseTo(90, 5);
    expect(pct(span.style.width)).toBeCloseTo(10, 5);
  });

  it('marks how a span ended, and which one the surface is acting on', () => {
    const el = track();
    new NotationRibbon(el, { spanClass: 'note-span', activeClass: 'editing' }).draw(
      [note('n1', 0, 1_000, '', 'user'), note('n2', 2_000, 3_000, '', 'auto'), note('n3', 4_000)],
      { scaleMs: 10_000, activeId: 'n1' },
    );

    const [first, second, third] = spans(el);
    expect(first.classList.contains('editing')).toBe(true);
    expect(second.classList.contains('auto-ended')).toBe(true);
    expect(third.classList.contains('open')).toBe(true);
    expect(first.classList.contains('auto-ended')).toBe(false);
  });

  it('keeps the same element across redraws, so a click target survives a tick', () => {
    const el = track();
    const ribbon = new NotationRibbon(el, { spanClass: 'note-span' });
    ribbon.draw([note('n1', 0, 1_000)], { scaleMs: 10_000 });
    const first = spans(el)[0];

    ribbon.draw([note('n1', 0, 2_000)], { scaleMs: 10_000 });

    expect(spans(el)[0]).toBe(first);
    expect(pct(first.style.width)).toBeCloseTo(20, 5);
  });

  it('drops a span that is no longer in the list', () => {
    const el = track();
    const ribbon = new NotationRibbon(el, { spanClass: 'note-span' });
    ribbon.draw([note('n1', 0, 1_000), note('n2', 2_000, 3_000)], { scaleMs: 10_000 });

    ribbon.draw([note('n2', 2_000, 3_000)], { scaleMs: 10_000 });

    expect(spans(el)).toHaveLength(1);
  });

  it('leaves children it did not draw alone', () => {
    const el = track();
    const playhead = document.createElement('span');
    playhead.className = 'note-playhead';
    el.appendChild(playhead);
    const ribbon = new NotationRibbon(el, { spanClass: 'note-span' });

    ribbon.draw([note('n1', 0, 1_000)], { scaleMs: 10_000 });
    ribbon.draw([], { scaleMs: 10_000 });
    ribbon.clear();

    expect(spans(el)).toHaveLength(0);
    expect(el.contains(playhead)).toBe(true);
  });

  it('reports clicks only where the surface wants them', () => {
    const el = track();
    const selected: string[] = [];
    new NotationRibbon(el, { spanClass: 'note-span', onSelect: (id) => selected.push(id) })
      .draw([note('n1', 0, 1_000)], { scaleMs: 10_000 });
    spans(el)[0].click();
    expect(selected).toEqual(['n1']);

    const inert = track();
    new NotationRibbon(inert, { spanClass: 'note-span' }).draw([note('n1', 0, 1_000)], { scaleMs: 10_000 });
    expect(spans(inert)[0].tagName).toBe('SPAN');
  });

  it('labels a span by its range, and by its message when it has one', () => {
    expect(describeNotation(note('n1', 41_000, 78_000))).toBe('0:41 → 1:18');
    expect(describeNotation(note('n1', 41_000, 78_000, 'Q3 target changed')))
      .toBe('0:41 → 1:18 · Q3 target changed');
    expect(describeNotation(note('n1', 41_000))).toBe('0:41 → …');
  });
});
