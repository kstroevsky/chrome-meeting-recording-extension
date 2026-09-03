import { sendToBackground } from '../../shared/messages';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import { RecordingsController } from '../RecordingsController';
import type { RecordingsView } from '../RecordingsView';

jest.mock('../../shared/messages', () => ({ sendToBackground: jest.fn() }));

const send = sendToBackground as jest.MockedFunction<typeof sendToBackground>;

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

function makeView() {
  return {
    render: jest.fn(),
    showError: jest.fn(),
    setNoteSummaries: jest.fn(),
  } as unknown as RecordingsView;
}

/** Only the history reads — the page also fetches a notes digest per load. */
const historyCalls = () =>
  send.mock.calls.map(([message]) => message as { type: string })
    .filter((message) => message.type === 'LIST_RECORDING_HISTORY');

/**
 * Answers by message type rather than call order, so the notes digest the page
 * fetches alongside each page cannot consume a queued history response.
 */
function respond(handlers: Record<string, unknown[]>) {
  const queues: Record<string, unknown[]> = { ...handlers };
  send.mockImplementation(async (message: any) => {
    const queue = queues[message.type];
    if (queue?.length) return queue.shift() as any;
    if (message.type === 'LIST_RECORDING_NOTATION_SUMMARIES') return { ok: true, summaries: {} } as any;
    throw new Error(`unexpected message: ${message.type}`);
  });
}

describe('RecordingsController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reads history in bounded pages and only appends an explicitly requested next page', async () => {
    const view = makeView();
    const controller = new RecordingsController(view);
    respond({
      LIST_RECORDING_HISTORY: [
        { ok: true, entries: [entry('new', 2)], nextCursor: { createdAt: 2, id: 'new' } },
        { ok: true, entries: [entry('old', 1)] },
      ],
    });

    await controller.init();
    expect(historyCalls()).toEqual([{ type: 'LIST_RECORDING_HISTORY' }]);
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([entry('new', 2)], true);

    await controller.loadMore();

    expect(historyCalls()[historyCalls().length - 1]).toEqual({ type: 'LIST_RECORDING_HISTORY', cursor: { createdAt: 2, id: 'new' } });
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([entry('new', 2), entry('old', 1)], false);
  });

  it('updates loaded cards after a rename without re-reading the full history', async () => {
    const view = makeView();
    const controller = new RecordingsController(view);
    respond({
      LIST_RECORDING_HISTORY: [{ ok: true, entries: [entry('one')] }],
      RENAME_RECORDING_HISTORY: [{ ok: true, entry: { ...entry('one'), name: 'Standup' } }],
    });

    await controller.init();
    await controller.rename('one', 'Standup');

    // The rename must not trigger a second full history read.
    expect(historyCalls()).toHaveLength(1);
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([{ ...entry('one'), name: 'Standup' }], false);
  });

  it('reads the notes digest for the loaded page and hands it to the view', async () => {
    const view = makeView();
    const controller = new RecordingsController(view);
    respond({
      LIST_RECORDING_HISTORY: [{ ok: true, entries: [entry('one'), entry('two', 2)] }],
      LIST_RECORDING_NOTATION_SUMMARIES: [
        { ok: true, summaries: { one: { count: 3, search: 'pricing objection' } } },
      ],
    });

    await controller.init();

    // One read for the whole page, not one per row.
    const digest = send.mock.calls
      .map(([message]) => message as { type: string; recordingIds?: string[] })
      .filter((message) => message.type === 'LIST_RECORDING_NOTATION_SUMMARIES');
    expect(digest).toHaveLength(1);
    expect(digest[0].recordingIds).toEqual(['one', 'two']);
    expect(view.setNoteSummaries).toHaveBeenCalledWith({ one: { count: 3, search: 'pricing objection' } });
  });

  it('still lists the recordings when the notes digest cannot be read', async () => {
    const view = makeView();
    const controller = new RecordingsController(view);
    send.mockImplementation(async (message: any) => {
      if (message.type === 'LIST_RECORDING_HISTORY') return { ok: true, entries: [entry('one')] } as any;
      throw new Error('offline');
    });

    await expect(controller.init()).resolves.toBeUndefined();
    expect((view.render as jest.Mock)).toHaveBeenCalledWith([entry('one')], false);
    expect(view.setNoteSummaries).not.toHaveBeenCalled();
  });
});
