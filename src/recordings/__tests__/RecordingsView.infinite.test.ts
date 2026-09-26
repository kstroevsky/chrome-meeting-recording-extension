/**
 * The list pages itself in: no button, the next page is asked for as the end of
 * the list comes near. jsdom has no IntersectionObserver, so a recording fake
 * stands in and lets each test say when the end comes into view.
 */
import { RecordingsView, type RecordingsViewCallbacks } from '../RecordingsView';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';

type Watch = { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; targets: Element[]; disconnected: boolean };
const watches: Watch[] = [];

class FakeIntersectionObserver {
  private readonly watch: Watch;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.watch = { callback, options, targets: [], disconnected: false };
    watches.push(this.watch);
  }
  observe(target: Element) { this.watch.targets.push(target); }
  disconnect() { this.watch.disconnected = true; }
  unobserve() {}
  takeRecords() { return []; }
}

function entry(id: string, createdAt = 1): RecordingHistoryEntry {
  return {
    id,
    name: `Recording ${id}`,
    createdAt,
    storageMode: 'local',
    status: 'complete',
    files: [historyFile({ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination: 'local', status: 'available' })],
  };
}

function mount() {
  const loadMore = jest.fn();
  const callbacks = {
    rename: jest.fn(), note: jest.fn(), remove: jest.fn(), removeMany: jest.fn(),
    openLocal: jest.fn(), fileTo: jest.fn(), play: jest.fn(), loadMore,
  } as unknown as RecordingsViewCallbacks;
  const list = document.createElement('div');
  const empty = document.createElement('div');
  const error = document.createElement('div');
  document.body.replaceChildren(list, empty, error);
  return { view: new RecordingsView(list, empty, error, callbacks), list, loadMore };
}

const live = () => watches.filter((watch) => !watch.disconnected);
const comeIntoView = (watch: Watch, isIntersecting: boolean) =>
  watch.callback([{ isIntersecting, target: watch.targets[0] } as IntersectionObserverEntry], watch as unknown as IntersectionObserver);

beforeEach(() => {
  watches.length = 0;
  (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
});
afterEach(() => { delete (globalThis as any).IntersectionObserver; });

describe('RecordingsView paging', () => {
  it('has no Load more button and asks for the next page as the end of the list comes near', () => {
    const { view, list, loadMore } = mount();
    view.render([entry('a', 2), entry('b', 1)], true, 120);

    expect(list.querySelector('button.load-more')).toBeNull();
    expect(Array.from(list.querySelectorAll('button')).some((button) => /load more/i.test(button.textContent ?? ''))).toBe(false);
    const scroller = list.querySelector('.recording-table__scroll')!;
    const marker = scroller.querySelector('.recording-table__more')!;
    expect(marker.textContent).toBe('Loading more recordings…');
    expect(scroller.lastElementChild).toBe(marker);

    const [watch] = live();
    expect(watch.targets).toEqual([marker]);
    expect(watch.options).toEqual({ root: scroller, rootMargin: '0px 0px 600px 0px' });

    comeIntoView(watch, false);
    expect(loadMore).not.toHaveBeenCalled();
    comeIntoView(watch, true);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('watches only the newest list, and nothing once the library is fully loaded', () => {
    const { view, list } = mount();
    view.render([entry('a', 2)], true, 3);
    view.render([entry('a', 2), entry('b', 1)], true, 3);
    expect(watches).toHaveLength(2);
    expect(watches[0].disconnected).toBe(true);
    expect(live()).toHaveLength(1);

    view.render([entry('a', 3), entry('b', 2), entry('c', 1)], false, 3);
    expect(live()).toHaveLength(0);
    expect(list.querySelector('.recording-table__more')).toBeNull();
  });
});
