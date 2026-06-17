import { EventTableRenderer } from '../EventTableRenderer';
import type { PerfEventEntry, PerfDebugSnapshot } from '../../../shared/perf';

function entry(i: number): PerfEventEntry {
  return { source: 'offscreen', scope: 'runtime', event: `e${i}`, ts: 1000 + i, fields: { i } };
}

function snapshotOf(entries: PerfEventEntry[]): PerfDebugSnapshot {
  return { entries } as PerfDebugSnapshot;
}

function makeScrollEl(opts: { clientHeight: number; scrollHeight: number; scrollTop: number }) {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: opts.clientHeight });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: opts.scrollHeight });
  el.scrollTop = opts.scrollTop;
  return el;
}

describe('EventTableRenderer', () => {
  let body: HTMLTableSectionElement;

  beforeEach(() => {
    body = document.createElement('tbody');
  });

  it('renders all rows on the first update (no previous snapshot)', () => {
    const renderer = new EventTableRenderer(body, null);
    renderer.update([entry(0), entry(1)], null);
    expect(body.querySelectorAll('tr')).toHaveLength(2);
    expect(body.textContent).toContain('e0');
    expect(body.textContent).toContain('e1');
  });

  it('appends only the new rows when the prefix is unchanged', () => {
    const renderer = new EventTableRenderer(body, null);
    renderer.update([entry(0), entry(1)], null);
    renderer.update([entry(0), entry(1), entry(2)], snapshotOf([entry(0), entry(1)]));

    expect(body.querySelectorAll('tr')).toHaveLength(3);
    expect(body.textContent).toContain('e2');
  });

  it('does not re-render when the entry count is unchanged', () => {
    const renderer = new EventTableRenderer(body, null);
    renderer.update([entry(0), entry(1)], null);
    const firstRow = body.querySelector('tr');
    renderer.update([entry(0), entry(1)], snapshotOf([entry(0), entry(1)]));

    expect(body.querySelectorAll('tr')).toHaveLength(2);
    expect(body.querySelector('tr')).toBe(firstRow); // same node, not rebuilt
  });

  it('fully resets when the existing prefix changed', () => {
    const renderer = new EventTableRenderer(body, null);
    renderer.update([entry(0), entry(1)], null);
    renderer.update([entry(9), entry(8), entry(7)], snapshotOf([entry(0), entry(1)]));

    expect(body.querySelectorAll('tr')).toHaveLength(3);
    expect(body.textContent).toContain('e9');
    expect(body.textContent).not.toContain('e0');
  });

  it('resets when the entry list shrank below the rendered count', () => {
    const renderer = new EventTableRenderer(body, null);
    renderer.update([entry(0), entry(1), entry(2)], null);
    renderer.update([entry(0)], snapshotOf([entry(0), entry(1), entry(2)]));

    expect(body.querySelectorAll('tr')).toHaveLength(1);
  });

  it('auto-scrolls to the bottom when the viewport is already near the bottom', () => {
    const scrollEl = makeScrollEl({ clientHeight: 100, scrollHeight: 100, scrollTop: 0 });
    const renderer = new EventTableRenderer(body, scrollEl);
    renderer.update([entry(0)], null);
    expect(scrollEl.scrollTop).toBe(100);
  });

  it('reset() clears the rendered rows', () => {
    const renderer = new EventTableRenderer(body, null);
    renderer.update([entry(0), entry(1)], null);
    renderer.reset();
    expect(body.querySelectorAll('tr')).toHaveLength(0);
  });

  it('is a no-op when there is no events body element', () => {
    const renderer = new EventTableRenderer(null, null);
    expect(() => renderer.update([entry(0)], null)).not.toThrow();
  });
});
