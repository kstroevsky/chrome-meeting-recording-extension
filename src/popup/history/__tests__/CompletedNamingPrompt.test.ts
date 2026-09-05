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
  let asked: RecordingNameDialogOptions | undefined;
  const dialog = {
    isOpen: () => false,
    ask: jest.fn(async (options: RecordingNameDialogOptions) => {
      asked = options;
      return 'saved' as const;
    }),
  };
  return { dialog: dialog as unknown as RecordingNameDialog, asked: () => asked!, ask: dialog.ask };
}

function makeActions(over: Partial<CompletedNamingActions> = {}): jest.Mocked<CompletedNamingActions> {
  return {
    notify: jest.fn(),
    rename: jest.fn(async () => undefined),
    destinations: jest.fn(() => [{ id: 'dest-a', name: 'Psychotherapy' }]),
    fileTo: jest.fn(async () => undefined),
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
});
