import type { AuthorizedMediaRoute } from '../../../integrations/RecordingRoutingService';
import type { ExternalMediaTransferView } from '../../../shared/protocol';
import type { RecordingHistoryEntry } from '../../../shared/recordingHistory';
import { ExternalMediaCoordinator } from '../ExternalMediaCoordinator';

const route: AuthorizedMediaRoute = {
  destinationId: 'crm',
  externalRecordingId: 'recording_external',
  connectionVersion: 2,
  receiver: {
    producerId: 'crm-receiver',
    endpoint: 'https://crm.example.test/hooks',
    apiBase: 'https://crm.example.test/media',
    uploadOrigins: ['https://bucket.r2.cloudflarestorage.com'],
  },
};

function entry(): RecordingHistoryEntry {
  return {
    id: 'recording-local',
    name: 'Interview',
    createdAt: 1,
    storageMode: 'local',
    status: 'complete',
    files: [{
      id: 'recording-local:tab',
      stream: 'tab',
      filename: 'interview.webm',
      mimeType: 'video/webm',
      locations: [{ kind: 'opfs', key: 'library/recording-local/recording-local%3Atab/interview.webm', retainedAt: 1 }],
      delivery: { requested: 'local', status: 'downloaded' },
      destination: 'local',
      status: 'available',
    }],
  };
}

function externalPrimaryEntry(): RecordingHistoryEntry {
  const current = entry();
  return {
    ...current,
    files: current.files.map((file) => ({
      ...file,
      delivery: { requested: { kind: 'external' as const, destinationId: 'crm' }, status: 'pending' as const },
    })),
  };
}

function transfer(state: ExternalMediaTransferView['state'] = 'ready-unacknowledged'): ExternalMediaTransferView {
  return {
    destinationId: 'crm',
    source: { kind: 'opfs', key: 'library/recording-local/recording-local%3Atab/interview.webm' },
    owner: {
      recordingId: 'recording-local',
      fileId: 'recording-local:tab',
      connectionVersion: 2,
      producerId: 'crm-receiver',
      endpoint: 'https://crm.example.test/hooks',
      apiBase: 'https://crm.example.test/media',
      uploadOrigins: ['https://bucket.r2.cloudflarestorage.com'],
    },
    request: {
      clientTransferId: 'transfer-1',
      recordingId: 'recording_external',
      artifact: { role: 'tab-recording', filename: 'interview.webm', mimeType: 'video/webm', bytes: 123 },
    },
    uploadedParts: [],
    state,
    artifactId: state === 'ready-unacknowledged' ? 'media-1' : undefined,
  };
}

function setup() {
  let current = entry();
  let transfers: ExternalMediaTransferView[] = [];
  const historyRepository = {
    get: jest.fn(async () => current),
    listAllIncludingDeleted: jest.fn(async () => [current]),
  };
  const history = {
    recordArtifactLocation: jest.fn(async (_recordingId: string, fileId: string, location: any) => {
      current = {
        ...current,
        files: current.files.map((file) => file.id === fileId
          ? { ...file, locations: [...file.locations, location] }
          : file),
      };
    }),
    setExternalDeliveryState: jest.fn(async () => {}),
  };
  const integrations = {
    authorizedMediaRoutes: jest.fn(async () => [route]),
    recordingRoutes: jest.fn(async (): Promise<any[]> => [{
      destinationId: 'crm', destinationName: 'CheekyCheeseIT CRM', state: 'released' as const, includesMedia: true as const,
    }]),
    listDestinations: jest.fn(async () => [{ id: 'crm', name: 'CheekyCheeseIT CRM' }]),
    mediaGrant: jest.fn(async () => ({
      destinationId: 'crm', connectionVersion: 2, producerId: 'crm-receiver',
      endpoint: route.receiver.endpoint, capability: { apiBase: route.receiver.apiBase }, bearer: 'secret',
    })),
  };
  const offscreen = {
    ensureReady: jest.fn(async () => {}),
    rpc: jest.fn(async (message: any) => {
      if (message.type === 'OFFSCREEN_MEDIA_SNAPSHOT') return { ok: true, transfers };
      if (message.type === 'OFFSCREEN_MEDIA_ENQUEUE') return { ok: true, transfer: transfer('queued') };
      if (message.type === 'OFFSCREEN_MEDIA_RETRY') {
        const original = transfers.find((candidate) =>
          candidate.destinationId === message.destinationId &&
          candidate.request.clientTransferId === message.clientTransferId);
        return { ok: true, transfer: { ...original, state: 'queued', nextAttemptAt: undefined } };
      }
      return { ok: true };
    }),
  };
  const retryScheduler = { sync: jest.fn(async () => {}), observe: jest.fn(async () => {}) };
  const recordingContexts: { get: jest.Mock } = {
    get: jest.fn(async () => ({
      recordingId: 'recording-local',
      startedAt: 1,
      endedAt: 2,
      source: { kind: 'meeting' as const },
    })),
  };
  const logger = { warn: jest.fn() };
  const coordinator = new ExternalMediaCoordinator({
    offscreen: offscreen as any,
    integrations: integrations as any,
    history: history as any,
    historyRepository: historyRepository as any,
    recordingContexts: recordingContexts as any,
    listHistory: async () => [current],
    retryScheduler: retryScheduler as any,
    logger,
  });
  return { coordinator, offscreen, integrations, history, historyRepository, recordingContexts, retryScheduler,
    setEntry: (next: RecordingHistoryEntry) => { current = next; },
    setTransfers: (next: ExternalMediaTransferView[]) => { transfers = next; } };
}

describe('ExternalMediaCoordinator', () => {
  it('persists and proves the exact external replica before acknowledging the journal', async () => {
    const ctx = setup();

    await ctx.coordinator.handleState(transfer());

    expect(ctx.history.recordArtifactLocation).toHaveBeenCalledWith(
      'recording-local',
      'recording-local:tab',
      { kind: 'external', destinationId: 'crm', artifactId: 'media-1' },
    );
    const ack = ctx.offscreen.rpc.mock.calls.find(([message]) => message.type === 'OFFSCREEN_MEDIA_ACK');
    expect(ack?.[0]).toMatchObject({ destinationId: 'crm', clientTransferId: 'transfer-1' });
    const rpcOrder = ctx.offscreen.rpc.mock.invocationCallOrder;
    expect(ctx.history.recordArtifactLocation.mock.invocationCallOrder[0])
      .toBeLessThan(rpcOrder[rpcOrder.length - 1]);
  });

  it('replays a lost acknowledgement without writing a second history replica', async () => {
    const ctx = setup();
    await ctx.coordinator.handleState(transfer());
    ctx.history.recordArtifactLocation.mockClear();
    ctx.offscreen.rpc.mockClear();

    await ctx.coordinator.handleState(transfer());

    expect(ctx.history.recordArtifactLocation).not.toHaveBeenCalled();
    expect(ctx.offscreen.rpc).toHaveBeenCalledWith(expect.objectContaining({ type: 'OFFSCREEN_MEDIA_ACK' }));
  });

  it('cancels a ready journal instead of resurrecting deleted history', async () => {
    const ctx = setup();
    ctx.setEntry({ ...entry(), deletedAt: 10 });

    await ctx.coordinator.handleState(transfer());

    expect(ctx.history.recordArtifactLocation).not.toHaveBeenCalled();
    expect(ctx.offscreen.rpc).toHaveBeenCalledWith({
      type: 'OFFSCREEN_MEDIA_CANCEL',
      recordingId: 'recording-local',
      destinationId: 'crm',
    });
  });

  it('discovers a missing transfer from complete history and the persisted Start authorization', async () => {
    const ctx = setup();

    await ctx.coordinator.reconcileRecording('recording-local');

    expect(ctx.integrations.mediaGrant).toHaveBeenCalledWith(route);
    expect(ctx.offscreen.rpc).toHaveBeenCalledWith(expect.objectContaining({
      type: 'OFFSCREEN_MEDIA_ENQUEUE',
      recording: expect.objectContaining({ id: 'recording-local', status: 'complete' }),
      route,
      fileId: 'recording-local:tab',
      sealed: true,
    }));
  });

  it('does not upload before capture finalization even when retained media is already present', async () => {
    const ctx = setup();
    ctx.recordingContexts.get.mockResolvedValueOnce({
      recordingId: 'recording-local',
      startedAt: 1,
      source: { kind: 'meeting' },
    });

    await ctx.coordinator.reconcileRecording('recording-local');

    expect(ctx.integrations.mediaGrant).not.toHaveBeenCalled();
    expect(ctx.offscreen.rpc).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'OFFSCREEN_MEDIA_ENQUEUE' }));
  });

  it('uploads sealed media after capture finalization even when a local sidecar makes history partial', async () => {
    const ctx = setup();
    const current = externalPrimaryEntry();
    ctx.setEntry({
      ...current,
      status: 'partial',
      files: [
        ...current.files,
        {
          id: 'recording-local:notes',
          stream: 'tab',
          kind: 'notes',
          filename: 'interview-notes.vtt',
          mimeType: 'text/vtt',
          locations: [],
          delivery: { requested: 'local', status: 'failed' },
          destination: 'local',
          status: 'unavailable',
        },
      ],
    });

    await ctx.coordinator.reconcileRecording('recording-local');

    expect(ctx.offscreen.rpc).toHaveBeenCalledWith(expect.objectContaining({
      type: 'OFFSCREEN_MEDIA_ENQUEUE',
      fileId: 'recording-local:tab',
    }));
  });

  it('reruns reconciliation when the retained OPFS location lands during an in-flight pass', async () => {
    const ctx = setup();
    const retained = externalPrimaryEntry();
    const beforeRetention = {
      ...retained,
      files: retained.files.map((file) => ({ ...file, locations: [] })),
    };
    ctx.setEntry(beforeRetention);

    let entered!: () => void;
    let release!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => { entered = resolve; });
    const firstReadBlocked = new Promise<void>((resolve) => { release = resolve; });
    ctx.historyRepository.get.mockImplementationOnce(async () => {
      entered();
      await firstReadBlocked;
      return beforeRetention;
    });

    const first = ctx.coordinator.reconcileRecording('recording-local');
    await firstReadStarted;
    ctx.setEntry(retained);
    const second = ctx.coordinator.reconcileRecording('recording-local');
    release();
    await Promise.all([first, second]);

    expect(ctx.historyRepository.get).toHaveBeenCalledTimes(2);
    expect(ctx.offscreen.rpc).toHaveBeenCalledWith(expect.objectContaining({
      type: 'OFFSCREEN_MEDIA_ENQUEUE',
      fileId: 'recording-local:tab',
    }));
  });

  it('keeps retryable external-primary transfer states pending and retained', async () => {
    const ctx = setup();
    ctx.setEntry(externalPrimaryEntry());

    await ctx.coordinator.handleState(transfer('action-required'));

    expect(ctx.history.setExternalDeliveryState).toHaveBeenCalledWith(
      'recording-local', 'recording-local:tab', 'crm', 'pending',
    );
    expect(ctx.history.recordArtifactLocation).not.toHaveBeenCalled();
  });

  it('reflects terminal cancellation as failed external-primary delivery', async () => {
    const ctx = setup();
    ctx.setEntry(externalPrimaryEntry());

    await ctx.coordinator.handleState(transfer('canceled'));

    expect(ctx.history.setExternalDeliveryState).toHaveBeenCalledWith(
      'recording-local', 'recording-local:tab', 'crm', 'failed', 'External delivery was canceled',
    );
  });

  it('reflects an explicit skipped primary route as failed without enqueueing bytes', async () => {
    const ctx = setup();
    ctx.setEntry(externalPrimaryEntry());
    ctx.integrations.authorizedMediaRoutes.mockResolvedValueOnce([]);
    ctx.integrations.recordingRoutes.mockResolvedValueOnce([{
      destinationId: 'crm', destinationName: 'CheekyCheeseIT CRM', state: 'skipped', includesMedia: true,
    }]);

    await ctx.coordinator.reconcileRecording('recording-local');

    expect(ctx.history.setExternalDeliveryState).toHaveBeenCalledWith(
      'recording-local', 'recording-local:tab', 'crm', 'failed', 'External delivery was skipped',
    );
    expect(ctx.offscreen.rpc).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'OFFSCREEN_MEDIA_ENQUEUE' }));
  });

  it('projects only UI-safe progress and reacquires authorization for explicit retry', async () => {
    const ctx = setup();
    const waiting = {
      ...transfer('action-required'),
      state: 'action-required' as const,
      artifactId: undefined,
      partSize: 100,
      uploadedParts: [{ partNumber: 1, etag: 'secret-provider-etag' }],
      errorCategory: 'network' as const,
      attempts: 2,
    };
    ctx.setTransfers([waiting]);

    const statuses = await ctx.coordinator.userStatuses('recording-local');
    expect(statuses).toEqual([expect.objectContaining({
      recordingId: 'recording-local',
      fileId: 'recording-local:tab',
      destinationId: 'crm',
      destinationName: 'CheekyCheeseIT CRM',
      clientTransferId: 'transfer-1',
      state: 'action-required',
      bytesUploaded: 100,
      bytesTotal: 123,
      attempts: 2,
      errorCategory: 'network',
    })]);
    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain('secret-provider-etag');
    expect(serialized).not.toContain('receiver.example');
    expect(serialized).not.toContain('library/');

    await expect(ctx.coordinator.retryTransfer('crm', 'transfer-1')).resolves.toMatchObject({
      state: 'queued',
      destinationName: 'CheekyCheeseIT CRM',
    });
    expect(ctx.integrations.mediaGrant).toHaveBeenCalledWith(route);
    expect(ctx.offscreen.rpc).toHaveBeenCalledWith(expect.objectContaining({
      type: 'OFFSCREEN_MEDIA_RETRY',
      destinationId: 'crm',
      clientTransferId: 'transfer-1',
      grant: expect.objectContaining({ bearer: 'secret' }),
    }));
  });

  it('makes disconnect cancellation strict while ordinary reconciliation remains best-effort', async () => {
    const ctx = setup();
    ctx.offscreen.rpc.mockImplementation(async (message: any) => {
      if (message.type === 'OFFSCREEN_MEDIA_CANCEL') return { ok: false, error: 'offscreen busy' };
      return { ok: true, transfers: [] };
    });

    await expect(ctx.coordinator.cancelDestinationStrict('crm')).rejects.toThrow('offscreen busy');
    await expect(ctx.coordinator.cancelDestination('crm')).resolves.toBeUndefined();
    expect(ctx.history.recordArtifactLocation).not.toHaveBeenCalled();
  });

  it('blocks retained-source release while an active transfer still needs those bytes', async () => {
    const ctx = setup();
    ctx.setTransfers([transfer('uploading')]);
    const release = jest.fn(async () => 'released');

    await expect(ctx.coordinator.withRetainedSourceRelease(
      'recording-local',
      ['library/recording-local/recording-local%3Atab/interview.webm'],
      release,
    )).resolves.toEqual({ busy: true });
    expect(release).not.toHaveBeenCalled();
  });

  it('allows release once transfer completion no longer needs the retained source', async () => {
    const ctx = setup();
    ctx.setTransfers([transfer('ready-unacknowledged')]);
    const release = jest.fn(async () => 'released');

    await expect(ctx.coordinator.withRetainedSourceRelease(
      'recording-local',
      ['library/recording-local/recording-local%3Atab/interview.webm'],
      release,
    )).resolves.toEqual({ busy: false, value: 'released' });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent release attempts for one recording', async () => {
    const ctx = setup();
    let entered!: () => void;
    let unblock!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { unblock = resolve; });
    const first = ctx.coordinator.withRetainedSourceRelease(
      'recording-local',
      ['library/recording-local/recording-local%3Atab/interview.webm'],
      async () => { entered(); await held; return 'first'; },
    );
    await inside;

    await expect(ctx.coordinator.withRetainedSourceRelease(
      'recording-local',
      ['library/recording-local/recording-local%3Atab/interview.webm'],
      async () => 'second',
    )).resolves.toEqual({ busy: true });

    unblock();
    await expect(first).resolves.toEqual({ busy: false, value: 'first' });
  });
});
