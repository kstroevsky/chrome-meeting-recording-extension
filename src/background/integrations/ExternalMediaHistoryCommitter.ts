import type { ExternalMediaTransferView } from '../../shared/protocol';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';
import type { RecordingHistoryRepository } from '../library/history/RecordingHistoryRepository';
import type { BackgroundIntegrationRuntime } from './BackgroundIntegrationRuntime';
import type { ExternalMediaCancelFilter } from './externalMediaCancellation';
import { isUploadableMedia, matchesOwner, recordingFileLabel } from './externalMediaStatus';

type Deps = {
  offscreen: OffscreenManager;
  integrations: BackgroundIntegrationRuntime;
  history: RecordingHistoryService;
  historyRepository: RecordingHistoryRepository;
  logger: { warn: (...args: any[]) => void };
};

/** Commits provider-ready media into canonical history before acknowledging the transfer. */
export class ExternalMediaHistoryCommitter {
  constructor(
    private readonly deps: Deps,
    private readonly cancel: (filter: ExternalMediaCancelFilter) => Promise<void>,
  ) {}

  async commitReady(transfer: ExternalMediaTransferView): Promise<void> {
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
      this.deps.logger.warn(
        'External media artifact conflicts with canonical history; keeping existing replica',
        recordingFileLabel(owner.recordingId, owner.fileId),
      );
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

  async syncPrimaryDelivery(transfer: ExternalMediaTransferView): Promise<void> {
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
}
