import { CompletedNamingPrompt, type CompletedNamingActions } from '../CompletedNamingPrompt';
import { sendToBackground } from '../../../shared/messages';
import type { RecordingNameDialog, RecordingNameDialogOptions, RecordingNameDialogOutcome } from '../../RecordingNameDialog';
import type { RecordingRouteActions } from '../recordingRouteActions';
import type { RecordingStatusView, UploadJob } from '../../../shared/recording';

jest.mock('../../../shared/messages', () => ({ sendToBackground: jest.fn() }));
const mockSend = sendToBackground as jest.MockedFunction<typeof sendToBackground>;

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const CRM = { destinationId: 'destination_crm', destinationName: 'CheekyCheeseIT CRM', state: 'held' as const };
const localOnly = () => ({ uploadJobs: [] } as unknown as RecordingStatusView);

type Answer = {
  outcome: RecordingNameDialogOutcome;
  remove?: string[];
  replace?: { from?: string; to: string };
  name?: string;
};

/** Answers each prompt as a person would: × first, then a button (Save runs onSave). */
function answeringDialog(answers: Answer[]) {
  const asks: RecordingNameDialogOptions[] = [];
  const dialog = {
    isOpen: () => false,
    ask: jest.fn(async (options: RecordingNameDialogOptions) => {
      asks.push(options);
      const answer = answers.shift() ?? { outcome: 'dismissed' as const };
      if (answer.remove) options.routes?.onChange(answer.remove);
      if (answer.replace) await options.routes?.onReplace?.(answer.replace.from, answer.replace.to);
      if (answer.outcome === 'saved') await options.onSave(answer.name ?? options.initialValue, null);
      return answer.outcome;
    }),
  };
  return { dialog: dialog as unknown as RecordingNameDialog, asks };
}

function routing(over: Partial<RecordingRouteActions> = {}): jest.Mocked<RecordingRouteActions> {
  return {
    routes: jest.fn(async () => ({ items: [CRM], candidates: [] })),
    retry: jest.fn(async () => [CRM]),
    change: jest.fn(async () => ({ items: [CRM], candidates: [] })),
    confirm: jest.fn(async () => {}),
    held: jest.fn(async () => []),
    ...over,
  } as jest.Mocked<RecordingRouteActions>;
}

function actions(over: Partial<CompletedNamingActions> = {}): jest.Mocked<CompletedNamingActions> {
  return {
    notify: jest.fn(),
    rename: jest.fn(async () => undefined),
    destinations: jest.fn(() => []),
    driveRootFolder: jest.fn(() => 'Recordings'),
    createDestination: jest.fn(async () => null),
    recordingNames: jest.fn(() => []),
    fileTo: jest.fn(async () => undefined),
    localFolders: jest.fn(() => []),
    pendingLocal: jest.fn(() => []),
    deliverLocal: jest.fn(async () => undefined),
    applySession: jest.fn(),
    reveal: jest.fn(),
    latest: jest.fn(() => ({ phase: 'idle' as const })),
    suspended: jest.fn(() => false),
    ...over,
  } as jest.Mocked<CompletedNamingActions>;
}

describe('CompletedNamingPrompt — the routes picked at Start (E7)', () => {
  beforeEach(() => { mockSend.mockReset(); });

  describe('a recording saved to this computer', () => {
    const pending = [{ id: 'rec-1', name: 'Acme interview' }];

    it('shows the routes and confirms them, minus the removed one, only after the file is written', async () => {
      const order: string[] = [];
      const route = routing({ confirm: jest.fn(async () => { order.push('confirm'); }) });
      const { dialog, asks } = answeringDialog([{ outcome: 'saved', remove: ['destination_crm'] }]);
      const act = actions({
        pendingLocal: jest.fn(() => pending),
        deliverLocal: jest.fn(async () => { order.push('deliver'); return undefined; }),
        routing: route,
      });
      new CompletedNamingPrompt(dialog, act).queue('idle', localOnly());
      await flush();

      expect(asks[0]!.routes?.items).toEqual([CRM]);
      expect(order).toEqual(['deliver', 'confirm']);
      expect(route.confirm).toHaveBeenCalledWith('rec-1', [
        { destinationId: 'destination_crm', action: 'skip' },
      ]);
    });

    it('confirms on the quiet button too: it only skips renaming', async () => {
      const route = routing();
      const { dialog } = answeringDialog([{ outcome: 'canceled' }]);
      new CompletedNamingPrompt(dialog, actions({ pendingLocal: jest.fn(() => pending), routing: route })).queue('idle', localOnly());
      await flush();
      expect(route.confirm).toHaveBeenCalledWith('rec-1', [
        { destinationId: 'destination_crm', action: 'release' },
      ]);
    });

    it('writes the file but decides nothing about the data on Escape', async () => {
      const route = routing();
      const { dialog } = answeringDialog([{ outcome: 'dismissed' }]);
      const act = actions({ pendingLocal: jest.fn(() => pending), routing: route });
      new CompletedNamingPrompt(dialog, act).queue('idle', localOnly());
      await flush();
      expect(act.deliverLocal).toHaveBeenCalledWith('rec-1', null);
      expect(route.confirm).not.toHaveBeenCalled();
    });

    it('keeps the routes held when the file could not be written', async () => {
      const route = routing();
      const { dialog } = answeringDialog([{ outcome: 'canceled' }]);
      const act = actions({
        pendingLocal: jest.fn(() => pending),
        deliverLocal: jest.fn(async () => { throw new Error('Disk full'); }),
        routing: route,
      });
      new CompletedNamingPrompt(dialog, act).queue('idle', localOnly());
      await flush();
      expect(route.confirm).not.toHaveBeenCalled();
      expect(act.notify).toHaveBeenCalledWith('Disk full');
    });

    it('starts on the folder the Save to destination files into', async () => {
      const { dialog, asks } = answeringDialog([{ outcome: 'dismissed' }]);
      const act = actions({
        pendingLocal: jest.fn(() => [{ ...pending[0]!, folderId: 'local-b' }]),
        localFolders: jest.fn(() => [{ id: 'local-a', name: 'Therapy' }, { id: 'local-b', name: 'Interviews' }]),
      });
      new CompletedNamingPrompt(dialog, act).queue('idle', localOnly());
      await flush();
      expect(asks[0]!.destinations?.initialId).toBe('local-b');
    });

    it('shows no rows and confirms nothing when the routes cannot be read', async () => {
      const route = routing({ routes: jest.fn(async () => { throw new Error('offline'); }) });
      const { dialog, asks } = answeringDialog([{ outcome: 'saved' }]);
      new CompletedNamingPrompt(dialog, actions({ pendingLocal: jest.fn(() => pending), routing: route })).queue('idle', localOnly());
      await flush();
      expect(asks[0]!.routes).toBeUndefined();
      expect(route.confirm).not.toHaveBeenCalled();
    });

    it('can explicitly add a receiver, then confirms only that newly held route', async () => {
      const NOTES = { destinationId: 'destination_notes', destinationName: 'Notes archive', state: 'held' as const };
      const route = routing({
        routes: jest.fn(async () => ({
          items: [],
          candidates: [{ destinationId: 'destination_notes', destinationName: 'Notes archive' }],
        })),
        change: jest.fn(async () => ({ items: [NOTES], candidates: [] })),
      });
      const { dialog, asks } = answeringDialog([{ outcome: 'canceled', replace: { to: 'destination_notes' } }]);
      new CompletedNamingPrompt(dialog, actions({ pendingLocal: jest.fn(() => pending), routing: route })).queue('idle', localOnly());
      await flush();

      expect(asks[0]!.routes?.items).toEqual([]);
      expect(asks[0]!.routes?.candidates).toEqual([{ destinationId: 'destination_notes', destinationName: 'Notes archive' }]);
      expect(route.change).toHaveBeenCalledWith('rec-1', undefined, 'destination_notes');
      expect(route.confirm).toHaveBeenCalledWith('rec-1', [
        { destinationId: 'destination_notes', action: 'release' },
      ]);
    });

    it('does not turn a newly available settings candidate into authorization without an explicit dialog choice', async () => {
      const route = routing({
        routes: jest.fn(async () => ({
          items: [CRM],
          candidates: [{ destinationId: 'destination_new', destinationName: 'New integration', includesMedia: true as const }],
        })),
      });
      const { dialog } = answeringDialog([{ outcome: 'canceled' }]);
      new CompletedNamingPrompt(dialog, actions({ pendingLocal: jest.fn(() => pending), routing: route })).queue('idle', localOnly());
      await flush();

      expect(route.change).not.toHaveBeenCalled();
      expect(route.confirm).toHaveBeenCalledWith('rec-1', [
        { destinationId: 'destination_crm', action: 'release' },
      ]);
    });
  });

  it('confirms a Drive recording after its naming was skipped', async () => {
    const job = {
      id: 'job-1', label: 'Acme interview', status: 'completed', namingStatus: 'pending',
      historyId: 'rec-2', startedAt: 1, finishedAt: 2,
    } as UploadJob;
    mockSend.mockResolvedValue({ ok: true } as never);
    const route = routing();
    const { dialog } = answeringDialog([{ outcome: 'canceled' }]);
    new CompletedNamingPrompt(dialog, actions({ routing: route })).queue('idle', { uploadJobs: [job] } as RecordingStatusView);
    await flush();
    expect(mockSend).toHaveBeenCalledWith({ type: 'SKIP_RECORDING_NAMING', jobId: 'job-1' });
    expect(route.confirm).toHaveBeenCalledWith('rec-2', [
      { destinationId: 'destination_crm', action: 'release' },
    ]);
  });

  describe('a recording saved without a prompt', () => {
    const held = [{ recordingId: 'rec-3', name: 'Acme interview', routes: [CRM] }];

    it('is asked about afterwards, only for its routes', async () => {
      const route = routing({ held: jest.fn(async () => held) });
      const { dialog, asks } = answeringDialog([{ outcome: 'canceled' }]);
      const act = actions({ routing: route });
      new CompletedNamingPrompt(dialog, act).queue('idle', localOnly());
      await flush();

      expect(asks[0]).toEqual(expect.objectContaining({ title: 'Confirm where this recording goes', initialValue: 'Acme interview' }));
      expect(asks[0]!.destinations).toBeUndefined();
      expect(route.confirm).toHaveBeenCalledWith('rec-3', [
        { destinationId: 'destination_crm', action: 'release' },
      ]);
      expect(act.rename).not.toHaveBeenCalled();
    });

    it('replaces a held receiver explicitly and confirms the refreshed held route', async () => {
      const NOTES = { destinationId: 'destination_notes', destinationName: 'Notes archive', state: 'held' as const };
      const route = routing({
        held: jest.fn(async () => held),
        routes: jest.fn(async () => ({
          items: [CRM],
          candidates: [{ destinationId: 'destination_notes', destinationName: 'Notes archive' }],
        })),
        change: jest.fn(async () => ({ items: [NOTES], candidates: [] })),
      });
      const { dialog } = answeringDialog([{
        outcome: 'canceled',
        replace: { from: 'destination_crm', to: 'destination_notes' },
      }]);
      new CompletedNamingPrompt(dialog, actions({ routing: route })).queue('idle', localOnly());
      await flush();

      expect(route.change).toHaveBeenCalledWith('rec-3', 'destination_crm', 'destination_notes');
      expect(route.confirm).toHaveBeenCalledWith('rec-3', [
        { destinationId: 'destination_notes', action: 'release' },
      ]);
    });

    it('renames only when the name changed', async () => {
      const route = routing({ held: jest.fn(async () => held) });
      const { dialog } = answeringDialog([{ outcome: 'saved', name: 'Acme — round 2' }]);
      const act = actions({ routing: route });
      new CompletedNamingPrompt(dialog, act).queue('idle', localOnly());
      await flush();
      expect(act.rename).toHaveBeenCalledWith('rec-3', 'Acme — round 2');
      expect(route.confirm).toHaveBeenCalledWith('rec-3', [
        { destinationId: 'destination_crm', action: 'release' },
      ]);
    });

    it('is not asked again in the same popup once dismissed, and is not confirmed', async () => {
      const route = routing({ held: jest.fn(async () => held) });
      const { dialog, asks } = answeringDialog([{ outcome: 'dismissed' }]);
      const prompt = new CompletedNamingPrompt(dialog, actions({ routing: route }));
      prompt.queue('idle', localOnly());
      await flush();
      prompt.queue('idle', localOnly());
      await flush();
      expect(asks).toHaveLength(1);
      expect(route.confirm).not.toHaveBeenCalled();
    });

    it('waits while a run is in progress, and looks again when it ends', async () => {
      const route = routing({ held: jest.fn(async () => []) });
      const { dialog, asks } = answeringDialog([{ outcome: 'canceled' }]);
      const prompt = new CompletedNamingPrompt(dialog, actions({ routing: route }));
      prompt.queue('idle', localOnly());
      await flush();
      expect(route.held).toHaveBeenCalledTimes(1);

      prompt.queue('recording', localOnly());
      await flush();
      route.held.mockResolvedValue(held);
      prompt.queue('idle', localOnly());
      await flush();
      expect(route.held).toHaveBeenCalledTimes(2);
      expect(asks).toHaveLength(1);
    });
  });
});
