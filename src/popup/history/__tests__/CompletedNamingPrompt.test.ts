import { CompletedNamingPrompt, type CompletedNamingActions } from '../CompletedNamingPrompt';
import { sendToBackground } from '../../../shared/messages';
import type { RecordingNameDialog, RecordingNameDialogOptions } from '../../RecordingNameDialog';
import type { RecordingStatusView, UploadJob } from '../../../shared/recording';

jest.mock('../../../shared/messages', () => ({ sendToBackground: jest.fn() }));
const mockSend = sendToBackground as jest.MockedFunction<typeof sendToBackground>;

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const job = (): UploadJob => ({
  id: 'job-1', label: 'Meet recording', status: 'completed', namingStatus: 'pending',
  historyId: 'rec-1', startedAt: 1, finishedAt: 2,
} as UploadJob);

const session = (): RecordingStatusView => ({ uploadJobs: [job()] } as RecordingStatusView);

/** Captures the options so a test can drive Save the way the real dialog does. */
function stubDialog() {
  const asks: RecordingNameDialogOptions[] = [];
  const dialog = {
    isOpen: () => false,
    ask: jest.fn(async (options: RecordingNameDialogOptions) => {
      asks.push(options);
      return 'saved' as const;
    }),
  };
  return {
    dialog: dialog as unknown as RecordingNameDialog,
    asked: () => asks[asks.length - 1]!,
    /** The nth prompt, for cases where one answer leads to another. */
    askedAt: (index: number) => asks[index]!,
    ask: dialog.ask,
  };
}

function makeActions(over: Partial<CompletedNamingActions> = {}): jest.Mocked<CompletedNamingActions> {
  return {
    notify: jest.fn(),
    rename: jest.fn(async () => undefined),
    destinations: jest.fn(() => [{ id: 'dest-a', name: 'Psychotherapy' }]),
    fileTo: jest.fn(async () => undefined),
    localFolders: jest.fn(() => [{ id: 'local-a', name: 'Therapy 2026' }]),
    pendingLocal: jest.fn(() => []),
    deliverLocal: jest.fn(async () => undefined),
    applySession: jest.fn(),
    reveal: jest.fn(),
    latest: jest.fn(() => ({ phase: 'idle' as const })),
    suspended: jest.fn(() => false),
    ...over,
  } as jest.Mocked<CompletedNamingActions>;
}

describe('CompletedNamingPrompt destinations', () => {
  beforeEach(() => { mockSend.mockReset(); });

  it('offers the configured destinations, starting unfiled', async () => {
    const { dialog, asked } = stubDialog();
    const actions = makeActions();
    new CompletedNamingPrompt(dialog, actions).queue('idle', session());
    await flush();

    expect(asked().destinations).toEqual({
      presets: [{ id: 'dest-a', name: 'Psychotherapy' }],
      unfiledLabel: 'Google Meet Records',
      initialId: null,
    });
  });

  it('omits the picker when no destinations are configured', async () => {
    const { dialog, asked } = stubDialog();
    new CompletedNamingPrompt(dialog, makeActions({ destinations: jest.fn(() => []) })).queue('idle', session());
    await flush();

    expect(asked().destinations).toBeUndefined();
  });

  it('renames before filing, so the move carries the new name', async () => {
    const { dialog, asked } = stubDialog();
    const order: string[] = [];
    const actions = makeActions({
      rename: jest.fn(async () => { order.push('rename'); return undefined; }),
      fileTo: jest.fn(async () => { order.push('file'); return undefined; }),
    });
    new CompletedNamingPrompt(dialog, actions).queue('idle', session());
    await flush();
    await asked().onSave('Session 12', 'dest-a');

    expect(order).toEqual(['rename', 'file']);
    expect(actions.rename).toHaveBeenCalledWith('rec-1', 'Session 12');
    expect(actions.fileTo).toHaveBeenCalledWith('rec-1', 'dest-a');
  });

  it('does not touch Drive folders when the built-in folder is kept', async () => {
    const { dialog, asked } = stubDialog();
    const actions = makeActions();
    new CompletedNamingPrompt(dialog, actions).queue('idle', session());
    await flush();
    await asked().onSave('Session 12', null);

    expect(actions.rename).toHaveBeenCalledWith('rec-1', 'Session 12');
    expect(actions.fileTo).not.toHaveBeenCalled();
  });

  it('keeps the name when filing fails, and surfaces the failure', async () => {
    const { dialog, asked } = stubDialog();
    const actions = makeActions({
      fileTo: jest.fn(async () => { throw new Error('Could not move the recording folder (503)'); }),
    });
    new CompletedNamingPrompt(dialog, actions).queue('idle', session());
    await flush();

    // The dialog reports this inline and stays open; the rename already landed.
    await expect(asked().onSave('Session 12', 'dest-a')).rejects.toThrow('503');
    expect(actions.rename).toHaveBeenCalledWith('rec-1', 'Session 12');
  });

  describe('a recording saved to this computer', () => {
    const pending = [{ id: 'rec-1', name: 'google-meet-20260906T1030' }];
    /** No upload job: nothing was uploaded, so nothing was named that way. */
    const localOnly = () => ({ uploadJobs: [] } as unknown as RecordingStatusView);

    it('asks for a name and a folder before the file is written', async () => {
      const { dialog, asked } = stubDialog();
      const actions = makeActions({ pendingLocal: jest.fn(() => pending) });
      new CompletedNamingPrompt(dialog, actions).queue('idle', localOnly());
      await flush();

      expect(asked().initialValue).toBe('google-meet-20260906T1030');
      expect(asked().destinations).toEqual({
        presets: [{ id: 'local-a', name: 'Therapy 2026' }],
        unfiledLabel: 'Downloads',
        initialId: null,
      });
    });

    it('renames before delivering, because the name becomes the filename', async () => {
      const { dialog, asked } = stubDialog();
      const order: string[] = [];
      const actions = makeActions({
        pendingLocal: jest.fn(() => pending),
        rename: jest.fn(async () => { order.push('rename'); return undefined; }),
        deliverLocal: jest.fn(async () => { order.push('deliver'); return undefined; }),
      });
      new CompletedNamingPrompt(dialog, actions).queue('idle', localOnly());
      await flush();
      await asked().onSave('Session 12', 'local-a');

      expect(order).toEqual(['rename', 'deliver']);
      expect(actions.deliverLocal).toHaveBeenCalledWith('rec-1', 'local-a');
    });

    it('still writes the file when the prompt is skipped', async () => {
      const { dialog } = stubDialog();
      const actions = makeActions({ pendingLocal: jest.fn(() => pending) });
      // Skipping must not strand the recording in the library.
      (dialog.ask as jest.Mock).mockImplementationOnce(async () => 'canceled' as const);
      new CompletedNamingPrompt(dialog, actions).queue('idle', localOnly());
      await flush();

      expect(actions.deliverLocal).toHaveBeenCalledWith('rec-1', null);
    });

    it('delivers to the download directory when no folder is chosen', async () => {
      const { dialog, asked } = stubDialog();
      const actions = makeActions({ pendingLocal: jest.fn(() => pending) });
      new CompletedNamingPrompt(dialog, actions).queue('idle', localOnly());
      await flush();
      await asked().onSave('Session 12', null);

      expect(actions.deliverLocal).toHaveBeenCalledWith('rec-1', null);
    });

    it('asks about the Drive upload first, then the local recording', async () => {
      const { dialog, askedAt } = stubDialog();
      const actions = makeActions({ pendingLocal: jest.fn(() => pending) });
      new CompletedNamingPrompt(dialog, actions).queue('idle', session());
      await flush();

      // The upload job is claimed first and keeps the Drive wording; the local
      // recording is then asked about in turn rather than being skipped.
      expect(askedAt(0).message).toContain('uploaded media file');
      expect(askedAt(0).destinations?.unfiledLabel).toBe('Google Meet Records');
      expect(askedAt(1).message).toBe('The saved file will use this name.');
      expect(askedAt(1).destinations?.unfiledLabel).toBe('Downloads');
    });
  });

  describe('several local recordings waiting', () => {
    const two = [
      { id: 'rec-1', name: 'first recording' },
      { id: 'rec-2', name: 'second recording' },
    ];
    const localOnly = () => ({ uploadJobs: [] } as unknown as RecordingStatusView);

    /** Answers the prompt the way the real dialog does: runs onSave, then saves. */
    const answering = (dialog: RecordingNameDialog) =>
      (dialog.ask as jest.Mock).mockImplementation(async (options: RecordingNameDialogOptions) => {
        await options.onSave(options.initialValue, null);
        return 'saved' as const;
      });

    it('asks about each one, not just the first', async () => {
      const { dialog, ask } = stubDialog();
      answering(dialog);
      const actions = makeActions({ pendingLocal: jest.fn(() => two) });
      new CompletedNamingPrompt(dialog, actions).queue('idle', localOnly());
      await flush();

      expect(ask).toHaveBeenCalledTimes(2);
      expect(actions.deliverLocal).toHaveBeenNthCalledWith(1, 'rec-1', null);
      expect(actions.deliverLocal).toHaveBeenNthCalledWith(2, 'rec-2', null);
    });

    it('does not re-offer one whose delivery failed', async () => {
      const { dialog, ask } = stubDialog();
      answering(dialog);
      const actions = makeActions({
        pendingLocal: jest.fn(() => [two[0]]),
        deliverLocal: jest.fn(async () => { throw new Error('disk full'); }),
      });
      new CompletedNamingPrompt(dialog, actions).queue('idle', localOnly());
      await flush();

      // A failure leaves it pending; re-offering it would spin the prompt.
      expect(ask).toHaveBeenCalledTimes(1);
      expect(actions.notify).toHaveBeenCalledWith('disk full');
    });
  });
});
