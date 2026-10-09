import type { RecordingHistoryEntry, RecordingHistoryFile } from '../../shared/recordingHistory';
import type { ExternalMediaTransferStatus, ExternalMediaTransferView } from '../../shared/protocol';
import type { AuthorizedMediaRoute } from '../../integrations/RecordingRoutingService';
import type { BackgroundIntegrationRuntime } from './BackgroundIntegrationRuntime';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';
import type { RecordingHistoryRepository } from '../library/history/RecordingHistoryRepository';
import type { ExternalMediaRetryScheduler } from './ExternalMediaRetryScheduler';
import type { RecordingContextService } from '../library/context/RecordingContextService';
import {
  hasExternalReplica,
  isUploadableMedia,
  listExternalMediaStatuses,
  matchesOwner,
  recordingFileLabel,
  retryExternalMediaTransfer,
} from './externalMediaStatus';
import { sendExternalMediaCancel, type ExternalMediaCancelFilter } from './externalMediaCancellation';

type Logger = { warn: (...args: any[]) => void };

type Deps = {
  offscreen: OffscreenManager;
  integrations: BackgroundIntegrationRuntime;
  history: RecordingHistoryService;
  historyRepository: RecordingHistoryRepository;
  recordingContexts: Pick<RecordingContextService, 'get'>;
  listHistory: () => Promise<RecordingHistoryEntry[]>;
  retryScheduler: ExternalMediaRetryScheduler;
  logger: Logger;
};

/** Background owner of consent/history reconciliation for external media. */
export class ExternalMediaCoordinator {
  private readonly recordingRuns = new Map<string, { again: boolean; done: Promise<void> }>();
  private readonly readyRuns = new Map<string, Promise<void>>();
  private reconcileRun: Promise<void> | null = null;
  private readonly sourceReleaseLocks = new Set<string>();

  constructor(private readonly deps: Deps) {}

  reconcile(): Promise<void> {
    if (this.reconcileRun) return this.reconcileRun;
    const run = this.reconcileAll().finally(() => {
      if (this.reconcileRun === run) this.reconcileRun = null;
    });
    this.reconcileRun = run;
    return run;
  }

  private async reconcileAll(): Promise<void> {
    await this.deps.offscreen.ensureReady();
    const snapshot = await this.snapshot();
    await this.deps.retryScheduler.sync(snapshot);
    for (const transfer of snapshot) await this.reconcileTransfer(transfer);
    for (const entry of await this.deps.listHistory()) {
      if (!entry.deletedAt) await this.reconcileRecording(entry.id);
    }
  }

  reconcileRecording(recordingId: string): Promise<void> {
    if (this.sourceReleaseLocks.has(recordingId)) return Promise.resolve();
    const running = this.recordingRuns.get(recordingId);
    if (running) {
      running.again = true;
      return running.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    this.recordingRuns.set(recordingId, entry);
    entry.done = this.drainRecordingReconciliation(recordingId, entry);
    return entry.done;
  }

  async withRetainedSourceRelease<T>(
    recordingId: string,
    sourceKeys: readonly string[],
    release: () => Promise<T>,
  ): Promise<{ busy: true } | { busy: false; value: T }> {
    const running = this.recordingRuns.get(recordingId);
    if (running) await running.done;
    if (this.sourceReleaseLocks.has(recordingId)) return { busy: true };
    this.sourceReleaseLocks.add(recordingId);
    try {
      await this.deps.offscreen.ensureReady();
      const keys = new Set(sourceKeys);
      const busy = (await this.snapshot()).some((transfer) =>
        keys.has(transfer.source.key) && transferNeedsRetainedSource(transfer));
      if (busy) return { busy: true };
      return { busy: false, value: await release() };
    } finally {
      this.sourceReleaseLocks.delete(recordingId);
      void this.reconcileRecording(recordingId);
    }
  }

  private async drainRecordingReconciliation(
    recordingId: string,
    entry: { again: boolean },
  ): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      do {
        entry.again = false;
        failure = undefined;
        try {
          await this.reconcileRecordingNow(recordingId);
        } catch (error) {
          failure = { error };
        }
      } while (entry.again);
    } finally {
      if (this.recordingRuns.get(recordingId) === entry) this.recordingRuns.delete(recordingId);
    }
    if (failure) throw failure.error;
  }

  async handleState(transfer: ExternalMediaTransferView): Promise<void> {
    await this.deps.retryScheduler.observe(transfer);
    await this.syncPrimaryDelivery(transfer);
    if (transfer.state !== 'ready-unacknowledged') return;
    const key = `${transfer.destinationId}\u0000${transfer.request.clientTransferId}`;
    const running = this.readyRuns.get(key);
    if (running) return running;
    const run = this.commitReady(transfer).finally(() => {
      if (this.readyRuns.get(key) === run) this.readyRuns.delete(key);
    });
    this.readyRuns.set(key, run);
    return run;
  }

  async cancelRecording(recordingId: string): Promise<void> {
    await this.cancel({ recordingId });
  }

  async cancelDestination(destinationId: string): Promise<void> {
    await this.cancel({ destinationId });
  }

  /** Disconnect must prove local transfer work stopped before credentials vanish. */
  async cancelDestinationStrict(destinationId: string): Promise<void> {
    await sendExternalMediaCancel(this.deps.offscreen, { destinationId });
  }

  async userStatuses(recordingId?: string): Promise<ExternalMediaTransferStatus[]> {
    return listExternalMediaStatuses(this.deps, recordingId);
  }

  async retryTransfer(destinationId: string, clientTransferId: string): Promise<ExternalMediaTransferStatus> {
    return retryExternalMediaTransfer(
      this.deps,
      destinationId,
      clientTransferId,
      (transfer) => this.handleState(transfer),
    );
  }

  private async reconcileRecordingNow(recordingId: string): Promise<void> {
    await this.deps.offscreen.ensureReady();
    const entry = await this.deps.historyRepository.get(recordingId);
    if (!entry || entry.deletedAt) {
      await this.cancel({ recordingId });
      return;
    }
    // Capture finalization is a recording-level fact; aggregate history status
    // also includes notes/transcript delivery and must not gate media ownership.
    // A failed local sidecar cannot strand otherwise sealed external-primary media.
    const context = await this.deps.recordingContexts.get(recordingId);
    if (context?.endedAt == null) return;
    const [routes, routeViews] = await Promise.all([
      this.deps.integrations.authorizedMediaRoutes(recordingId),
      this.deps.integrations.recordingRoutes(recordingId),
    ]);
    for (const file of entry.files) {
      const requested = file.delivery.requested;
      if (typeof requested !== 'object' || requested.kind !== 'external') continue;
      const route = routeViews.find((candidate) => candidate.destinationId === requested.destinationId);
      if (route?.state === 'skipped') {
        await this.deps.history.setExternalDeliveryState(
          recordingId, file.id, requested.destinationId, 'failed', 'External delivery was skipped',
        );
      }
    }
    const routeIds = new Set(routes.map((route) => route.destinationId));
    for (const transfer of await this.snapshot()) {
      if (transfer.owner?.recordingId === recordingId && !routeIds.has(transfer.destinationId)) {
        await this.cancel({ recordingId, destinationId: transfer.destinationId });
      }
    }
    for (const route of routes) {
      for (const file of entry.files) {
        if (!isUploadableMedia(file) || hasExternalReplica(file, route.destinationId)) continue;
        await this.enqueue(entry, file, route);
      }
    }
  }

  private async enqueue(
    entry: RecordingHistoryEntry,
    file: RecordingHistoryFile,
    route: AuthorizedMediaRoute,
  ): Promise<void> {
    if (!file.locations.some((location) => location.kind === 'opfs')) return;
    try {
      const grant = await this.deps.integrations.mediaGrant(route);
      await this.deps.offscreen.ensureReady();
      const response = await this.deps.offscreen.rpc<{
        ok: boolean;
        transfer?: ExternalMediaTransferView;
        error?: string;
      }>({
        type: 'OFFSCREEN_MEDIA_ENQUEUE',
        recording: entry,
        route,
        fileId: file.id,
        sealed: true,
        grant,
      });
      if (!response?.ok || !response.transfer) {
        throw new Error(response?.error || 'External media enqueue failed');
      }
      await this.handleState(response.transfer);
    } catch (error) {
      this.deps.logger.warn('External media enqueue deferred:', recordingFileLabel(entry.id, file.id), error);
    }
  }

  private async reconcileTransfer(transfer: ExternalMediaTransferView): Promise<void> {
    const owner = transfer.owner;
    if (!owner || transfer.state === 'acknowledged' || transfer.state === 'canceled') return;
    const entry = await this.deps.historyRepository.get(owner.recordingId);
    if (!entry || entry.deletedAt) {
      await this.cancel({ recordingId: owner.recordingId, destinationId: transfer.destinationId });
      return;
    }
    const routes = await this.deps.integrations.authorizedMediaRoutes(owner.recordingId);
    const route = routes.find((candidate) => matchesOwner(candidate, transfer));
    if (!route) {
      await this.cancel({ recordingId: owner.recordingId, destinationId: transfer.destinationId });
      return;
    }
    if (transfer.state === 'ready-unacknowledged') await this.handleState(transfer);
  }

  private async commitReady(transfer: ExternalMediaTransferView): Promise<void> {
    const owner = transfer.owner;
    if (!owner || !transfer.artifactId) return;
    const entry = await this.deps.historyRepository.get(owner.recordingId);
    const file = entry?.files.find((candidate) => candidate.id === owner.fileId);
    if (!entry || entry.deletedAt || !file || !isUploadableMedia(file)) {
      await this.cancel({ recordingId: owner.recordingId, destinationId: transfer.destinationId });
      return;
    }
    const routes = await this.deps.integrations.authorizedMediaRoutes(owner.recordingId);
    if (!routes.some((route) => matchesOwner(route, transfer))) {
      await this.cancel({ recordingId: owner.recordingId, destinationId: transfer.destinationId });
      return;
    }
    const existing = file.locations.find((location) =>
      location.kind === 'external' && location.destinationId === transfer.destinationId);
    if (existing?.kind === 'external' && existing.artifactId !== transfer.artifactId) {
      this.deps.logger.warn('External media artifact conflicts with canonical history; keeping existing replica',
        recordingFileLabel(owner.recordingId, owner.fileId));
      await this.cancel({
        destinationId: transfer.destinationId,
        clientTransferId: transfer.request.clientTransferId,
      });
      return;
    }
    if (!existing) {
      await this.deps.history.recordArtifactLocation(owner.recordingId, owner.fileId, {
        kind: 'external',
        destinationId: transfer.destinationId,
        artifactId: transfer.artifactId,
      });
    }
    const durable = await this.deps.historyRepository.get(owner.recordingId);
    const persisted = durable && !durable.deletedAt
      ? durable.files.find((candidate) => candidate.id === owner.fileId)?.locations.some((location) =>
          location.kind === 'external' && location.destinationId === transfer.destinationId &&
          location.artifactId === transfer.artifactId)
      : false;
    if (!persisted) {
      await this.cancel({ recordingId: owner.recordingId, destinationId: transfer.destinationId });
      return;
    }
    const response = await this.deps.offscreen.rpc<{ ok: boolean; error?: string }>({
      type: 'OFFSCREEN_MEDIA_ACK',
      destinationId: transfer.destinationId,
      clientTransferId: transfer.request.clientTransferId,
    });
    if (!response?.ok) throw new Error(response?.error || 'External media acknowledgement failed');
  }

  private async syncPrimaryDelivery(transfer: ExternalMediaTransferView): Promise<void> {
    const owner = transfer.owner;
    if (!owner) return;
    if (transfer.state === 'retry-wait' || transfer.state === 'action-required') {
      await this.deps.history.setExternalDeliveryState(
        owner.recordingId, owner.fileId, transfer.destinationId, 'pending',
      );
      return;
    }
    if (transfer.state === 'canceled') {
      await this.deps.history.setExternalDeliveryState(
        owner.recordingId, owner.fileId, transfer.destinationId, 'failed', 'External delivery was canceled',
      );
    }
  }

  private async snapshot(): Promise<ExternalMediaTransferView[]> {
    const response = await this.deps.offscreen.rpc<{
      ok: boolean;
      transfers?: ExternalMediaTransferView[];
      error?: string;
    }>({ type: 'OFFSCREEN_MEDIA_SNAPSHOT' });
    if (!response?.ok || !Array.isArray(response.transfers)) {
      throw new Error(response?.error || 'External media snapshot failed');
    }
    return response.transfers;
  }

  private async cancel(filter: ExternalMediaCancelFilter): Promise<void> {
    try {
      await sendExternalMediaCancel(this.deps.offscreen, filter);
    } catch (error) {
      this.deps.logger.warn('External media cancellation deferred:', filter, error);
    }
  }
}

export function transferNeedsRetainedSource(transfer: ExternalMediaTransferView): boolean {
  if (transfer.state === 'verifying-capability' || transfer.state === 'ready-unacknowledged'
      || transfer.state === 'acknowledged' || transfer.state === 'canceled') return false;
  if ((transfer.state === 'retry-wait' || transfer.state === 'action-required')
      && transfer.resumeFrom === 'verifying-capability') return false;
  return true;
}
