import { sendToBackground } from '../../shared/messages';
import { historyFile } from '../../../tests/helpers/recordingHistoryFixtures';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import { RecordingsController } from '../RecordingsController';
import type { RecordingsView } from '../RecordingsView';
import type { PlaybackManifest } from '../../shared/playback';

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
    setTopicSummaries: jest.fn(),
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
    if (message.type === 'LIST_RECORDING_TOPIC_SUMMARIES') return { ok: true, summaries: {} } as any;
    throw new Error(`unexpected message: ${message.type}`);
  });
}

describe('RecordingsController', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends a confirmed file deletion straight through: the dialog already asked', async () => {
    const nativeConfirm = jest.spyOn(window, 'confirm');
    const view = makeView();
    const controller = new RecordingsController(view);
    respond({
      LIST_RECORDING_HISTORY: [{ ok: true, entries: [entry('a', 2)], total: 1 }],
      REMOVE_RECORDING_HISTORY: [{ ok: true, removed: true, filesDeleted: 1, fileErrors: ['Drive file x.webm: not found in Google Drive'] }],
    });
    await controller.init();

    await controller.remove('a', true);
    expect(send).toHaveBeenCalledWith({ type: 'REMOVE_RECORDING_HISTORY', id: 'a', deleteFiles: true });
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([], false, 0);
    expect(view.showError).toHaveBeenLastCalledWith('Removed, but 1 file could not be deleted — Drive file x.webm: not found in Google Drive');
    nativeConfirm.mockRestore();
  });

  it('removes without a second, native confirmation and counts the library down', async () => {
    const nativeConfirm = jest.spyOn(window, 'confirm');
    const view = makeView();
    const controller = new RecordingsController(view);
    respond({
      LIST_RECORDING_HISTORY: [{ ok: true, entries: [entry('a', 2), entry('b', 1)], nextCursor: { createdAt: 1, id: 'b' }, total: 120 }],
      REMOVE_RECORDING_HISTORY: [{ ok: true, removed: true }, { ok: true, removed: true }],
    });
    await controller.init();

    await controller.remove('a');
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([entry('b', 1)], true, 119);
    await controller.removeMany(['b']);
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([], true, 118);
    expect(nativeConfirm).not.toHaveBeenCalled();
    nativeConfirm.mockRestore();
  });

  it('reads history in bounded pages and only appends an explicitly requested next page', async () => {
    const view = makeView();
    const controller = new RecordingsController(view);
    respond({
      LIST_RECORDING_HISTORY: [
        { ok: true, entries: [entry('new', 2)], nextCursor: { createdAt: 2, id: 'new' }, total: 2 },
        { ok: true, entries: [entry('old', 1)] },
      ],
    });

    await controller.init();
    expect(historyCalls()).toEqual([{ type: 'LIST_RECORDING_HISTORY' }]);
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([entry('new', 2)], true, 2);

    await controller.loadMore();

    expect(historyCalls()[historyCalls().length - 1]).toEqual({ type: 'LIST_RECORDING_HISTORY', cursor: { createdAt: 2, id: 'new' } });
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([entry('new', 2), entry('old', 1)], false, 2);
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
    expect((view.render as jest.Mock)).toHaveBeenLastCalledWith([{ ...entry('one'), name: 'Standup' }], false, undefined);
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
    expect((view.render as jest.Mock)).toHaveBeenCalledWith([entry('one')], false, undefined);
    expect(view.setNoteSummaries).not.toHaveBeenCalled();
  });

  it('reads the topics digest for the loaded page and hands it to the view', async () => {
    const view = makeView();
    const controller = new RecordingsController(view);
    respond({
      LIST_RECORDING_HISTORY: [{ ok: true, entries: [entry('one'), entry('two', 2)] }],
      LIST_RECORDING_TOPIC_SUMMARIES: [
        { ok: true, summaries: { one: { keywords: ['redis', 'pool'], search: 'redis pool', topicCount: 1 } } },
      ],
    });

    await controller.init();

    // One read for the whole page, alongside the notes digest rather than instead of it.
    const digest = send.mock.calls
      .map(([message]) => message as { type: string; recordingIds?: string[] })
      .filter((message) => message.type === 'LIST_RECORDING_TOPIC_SUMMARIES');
    expect(digest).toHaveLength(1);
    expect(digest[0].recordingIds).toEqual(['one', 'two']);
    expect(view.setTopicSummaries).toHaveBeenCalledWith({
      one: { keywords: ['redis', 'pool'], search: 'redis pool', topicCount: 1 },
    });
    expect(view.setNoteSummaries).toHaveBeenCalled();
  });

  it('still lists the recordings when the topics digest cannot be read', async () => {
    const view = makeView();
    const controller = new RecordingsController(view);
    respond({
      LIST_RECORDING_HISTORY: [{ ok: true, entries: [entry('one')] }],
      LIST_RECORDING_TOPIC_SUMMARIES: [{ ok: false, error: 'analysis is unavailable' }],
    });

    await controller.init();

    expect(view.setTopicSummaries).not.toHaveBeenCalled();
    expect(view.render).toHaveBeenCalledWith([entry('one')], false, undefined);
  });

  it('builds a selected share from playback manifests and requested transcripts', async () => {
    const view = makeView();
    const controller = new RecordingsController(view, { enabled: true });
    const manifest: PlaybackManifest = {
      recordingId: 'one',
      title: 'Recording one',
      createdAt: 1,
      transcriptStatus: 'ready',
      notations: [],
      topics: [],
      tracks: [],
    };
    const transcript = {
      source: 'meet-captions' as const,
      segments: [{ tStartMs: 0, tEndMs: 1000, speaker: 'A', text: 'Hello' }],
    };
    respond({
      LIST_RECORDING_HISTORY: [{ ok: true, entries: [entry('one')] }],
      GET_RECORDING_PLAYBACK_MANIFEST: [{ ok: true, manifest }],
      GET_RECORDING_TRANSCRIPT: [{ ok: true, transcript }],
      PUBLISH_SHARE: [{ ok: true, shareId: 'share-public-id' }],
    });
    await controller.init();
    const progress: string[] = [];

    const result = await controller.share(['one'], {
      includeTranscript: true,
      includeTopics: true,
      includeNotations: false,
      includeSelfVideo: false,
    }, (message) => progress.push(message));

    expect(send).toHaveBeenCalledWith({
      type: 'PUBLISH_SHARE',
      recordings: [{ manifest, transcript }],
      options: expect.objectContaining({ includeTranscript: true, includeTopics: true }),
    });
    expect(result).toEqual({ shareId: 'share-public-id' });
    expect(progress).toEqual([
      'Preparing 1 recording…',
      'Starting publication…',
      'Publication continues in the background.',
    ]);
  });

  it('routes share revocation through the background sharing runtime', async () => {
    const view = makeView();
    const controller = new RecordingsController(view, { enabled: true });
    respond({ REVOKE_SHARE: [{ ok: true }] });

    await controller.revokeShare('share-public-id');

    expect(send).toHaveBeenCalledWith({ type: 'REVOKE_SHARE', shareId: 'share-public-id' });
  });
});
