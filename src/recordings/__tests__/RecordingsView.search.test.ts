import { RecordingsView, type RecordingsViewCallbacks } from '../RecordingsView';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';

function entry(id: string, name: string, createdAt = 1): RecordingHistoryEntry {
  return {
    id,
    name,
    createdAt,
    storageMode: 'local',
    status: 'complete',
    files: [historyFile({ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination: 'local', status: 'available' })],
  };
}

const callbacks = {
  rename: jest.fn(), note: jest.fn(), remove: jest.fn(), removeMany: jest.fn(),
  openLocal: jest.fn(), fileTo: jest.fn(), play: jest.fn(), loadMore: jest.fn(),
} as unknown as RecordingsViewCallbacks;

function mount() {
  const list = document.createElement('div');
  const empty = document.createElement('div');
  const error = document.createElement('div');
  const loadMore = document.createElement('button');
  document.body.replaceChildren(list, empty, error, loadMore);
  return { view: new RecordingsView(list, empty, error, loadMore, callbacks), list };
}

/** Types into the live search box; the count updates without the debounce. */
function search(list: HTMLElement, query: string): string {
  const input = list.querySelector<HTMLInputElement>('.recording-search')!;
  input.value = query;
  input.dispatchEvent(new Event('input'));
  return list.querySelector<HTMLElement>('.recordings-count')!.textContent ?? '';
}

describe('RecordingsView search', () => {
  it('finds a recording by a topic keyword nobody put in its name', () => {
    const { view, list } = mount();
    view.render([entry('one', 'Weekly sync'), entry('two', 'Design review', 2)]);
    view.setTopicSummaries({
      one: { keywords: ['redis', 'pool'], search: 'redis pool timeout', topicCount: 1 },
    });
    view.render([entry('one', 'Weekly sync'), entry('two', 'Design review', 2)]);

    // "1 OF 2" — the topic-bearing row matched, the other did not.
    expect(search(list, 'redis')).toBe('1 OF 2 · IN NAMES, NOTES AND TOPICS');
  });

  it('still matches the name and the note, which topics only add to', () => {
    const { view, list } = mount();
    const withNote = { ...entry('one', 'Weekly sync'), note: 'pricing objection' };
    view.render([withNote, entry('two', 'Design review', 2)]);
    view.setTopicSummaries({ two: { keywords: ['redis'], search: 'redis', topicCount: 1 } });
    view.render([withNote, entry('two', 'Design review', 2)]);

    expect(search(list, 'weekly')).toBe('1 OF 2 · IN NAMES, NOTES AND TOPICS');
    expect(search(list, 'pricing')).toBe('1 OF 2 · IN NAMES, NOTES AND TOPICS');
    expect(search(list, 'redis')).toBe('1 OF 2 · IN NAMES, NOTES AND TOPICS');
  });

  it('matches a keyword case-insensitively, as the rest of the search does', () => {
    const { view, list } = mount();
    view.render([entry('one', 'Weekly sync')]);
    view.setTopicSummaries({ one: { keywords: ['Redis'], search: 'redis', topicCount: 1 } });
    view.render([entry('one', 'Weekly sync')]);

    expect(search(list, 'REDIS')).toBe('1 OF 1 · IN NAMES, NOTES AND TOPICS');
  });

  it('searches names normally before any digest has arrived', () => {
    const { view, list } = mount();
    view.render([entry('one', 'Weekly sync'), entry('two', 'Design review', 2)]);

    // The digest is fire-and-forget, so the first paint has none.
    expect(search(list, 'design')).toBe('1 OF 2 · IN NAMES, NOTES AND TOPICS');
    expect(search(list, 'redis')).toBe('0 OF 2 · IN NAMES, NOTES AND TOPICS');
  });

  it('says it searches topics too', () => {
    const { view, list } = mount();
    view.render([entry('one', 'Weekly sync')]);
    const input = list.querySelector<HTMLInputElement>('.recording-search')!;
    expect(input.placeholder).toBe('Search name, note or topic…');
  });
});
