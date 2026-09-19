import { RecordingsListView } from '../RecordingsListView';
import { sendToBackground } from '../../../shared/messages';
import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';
import { historyFile } from '../../../../tests/helpers/recordingHistoryFixtures';

jest.mock('../../../shared/messages', () => ({ sendToBackground: jest.fn() }));

const send = sendToBackground as jest.Mock;

function entry(id: string): RecordingHistoryEntry {
  return {
    id,
    name: id,
    createdAt: 1,
    storageMode: 'drive',
    status: 'complete',
    files: [historyFile({ id: `${id}:tab`, stream: 'tab', filename: `${id}.webm`, destination: 'drive', status: 'available' })],
  };
}

function mount() {
  document.body.innerHTML = `
    <section id="view-recordings" hidden>
      <div id="popup-recordings-list"></div>
      <p id="popup-recordings-empty" hidden>No recordings yet.</p>
    </section>`;
  const view = new RecordingsListView({
    openRecording: jest.fn(),
    openUpload: jest.fn(),
    loadNotations: jest.fn(async () => []),
    noteCounts: jest.fn(async () => ({})),
    activeUploads: () => [],
  });
  return {
    view,
    placeholders: () => document.querySelectorAll('.popup-recording-placeholder').length,
    rows: () => document.querySelectorAll('.popup-recording-row').length,
    empty: () => document.getElementById('popup-recordings-empty')!,
  };
}

/** Loads the list with history that answers only when `answer` is called. */
function loadDeferred(view: RecordingsListView) {
  let answer!: (entries: RecordingHistoryEntry[]) => void;
  send.mockImplementation(() => new Promise((resolve) => {
    answer = (entries) => resolve({ ok: true, entries, nextCursor: null });
  }));
  const loaded = view.load();
  return { loaded, answer: (entries: RecordingHistoryEntry[]) => { answer(entries); return loaded; } };
}

describe('RecordingsListView while history loads', () => {
  beforeEach(() => localStorage.clear());

  it('holds room for a full list the first time, then swaps in the rows', async () => {
    const { view, placeholders, rows } = mount();
    const { answer } = loadDeferred(view);
    expect(placeholders()).toBe(3);

    await answer([entry('a'), entry('b')]);
    expect(placeholders()).toBe(0);
    expect(rows()).toBe(2);
  });

  it('holds as many rows as the list showed last time', async () => {
    const first = mount();
    await loadDeferred(first.view).answer([entry('a'), entry('b')]);

    const second = mount();
    const { answer } = loadDeferred(second.view);
    expect(second.placeholders()).toBe(2);
    await answer([entry('a'), entry('b')]);
    expect(second.rows()).toBe(2);
  });

  it('holds the empty line\'s room, unseen, when the list was empty last time', async () => {
    const first = mount();
    await loadDeferred(first.view).answer([]);
    expect(first.empty().hidden).toBe(false);

    const second = mount();
    const { answer } = loadDeferred(second.view);
    expect(second.placeholders()).toBe(0);
    expect(second.empty().hidden).toBe(false);
    expect(second.empty().classList.contains('reserving')).toBe(true);

    await answer([entry('a')]);
    expect(second.empty().hidden).toBe(true);
    expect(second.empty().classList.contains('reserving')).toBe(false);
  });
});
