import type { AuthorizedMediaRoute } from '../../integrations/RecordingRoutingService';
import type { RecordingHistoryFile } from '../../shared/recordingHistory';
import type { ExternalMediaTransferStatus, ExternalMediaTransferView } from '../../shared/protocol';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { BackgroundIntegrationRuntime } from './BackgroundIntegrationRuntime';

type UserRecoveryDeps = {
  offscreen: OffscreenManager;
  integrations: BackgroundIntegrationRuntime;
};

export function isUploadableMedia(file: RecordingHistoryFile): boolean {
  return !file.kind && (file.stream === 'tab' || file.stream === 'mic' || file.stream === 'self-video');
}

export function hasExternalReplica(file: RecordingHistoryFile, destinationId: string): boolean {
  return file.locations.some((location) => location.kind === 'external' && location.destinationId === destinationId);
}

export function matchesOwner(route: AuthorizedMediaRoute, transfer: ExternalMediaTransferView): boolean {
  const owner = transfer.owner;
  return Boolean(owner && route.destinationId === transfer.destinationId &&
    route.connectionVersion === owner.connectionVersion && route.receiver.producerId === owner.producerId &&
    route.receiver.endpoint === owner.endpoint && route.receiver.apiBase === owner.apiBase);
}

export function recordingFileLabel(recordingId: string, fileId: string): string {
  return `${recordingId}/${fileId}`;
}

export function toExternalMediaStatus(
  transfer: ExternalMediaTransferView,
  destinationName?: string,
): ExternalMediaTransferStatus | undefined {
  const owner = transfer.owner;
  if (!owner || transfer.state === 'canceled') return undefined;
  const bytesTotal = Math.max(0, transfer.request.artifact.bytes);
  const complete = transfer.state === 'ready-unacknowledged' || transfer.state === 'acknowledged' ||
    transfer.state === 'verifying-capability';
  let bytesUploaded = complete ? bytesTotal : 0;
  if (!complete && transfer.partSize && transfer.partSize > 0 && bytesTotal > 0) {
    const seen = new Set<number>();
    for (const part of transfer.uploadedParts) {
      if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || seen.has(part.partNumber)) continue;
      seen.add(part.partNumber);
      const start = (part.partNumber - 1) * transfer.partSize;
      if (start >= bytesTotal) continue;
      bytesUploaded += Math.min(transfer.partSize, bytesTotal - start);
    }
    bytesUploaded = Math.min(bytesUploaded, bytesTotal);
  }
  return {
    recordingId: owner.recordingId,
    fileId: owner.fileId,
    destinationId: transfer.destinationId,
    ...(destinationName ? { destinationName } : {}),
    clientTransferId: transfer.request.clientTransferId,
    state: transfer.state,
    bytesUploaded,
    bytesTotal,
    attempts: transfer.attempts ?? 0,
    ...(transfer.errorCategory ? { errorCategory: transfer.errorCategory } : {}),
    ...(transfer.nextAttemptAt != null ? { nextAttemptAt: transfer.nextAttemptAt } : {}),
  };
}

export async function listExternalMediaStatuses(
  deps: UserRecoveryDeps,
  recordingId?: string,
): Promise<ExternalMediaTransferStatus[]> {
  const [transfers, destinations] = await Promise.all([
    mediaSnapshot(deps.offscreen),
    deps.integrations.listDestinations(),
  ]);
  const names = new Map(destinations.map((destination) => [destination.id, destination.name]));
  return transfers
    .filter((transfer) => !recordingId || transfer.owner?.recordingId === recordingId)
    .map((transfer) => toExternalMediaStatus(transfer, names.get(transfer.destinationId)))
    .filter((status): status is ExternalMediaTransferStatus => Boolean(status));
}

export async function retryExternalMediaTransfer(
  deps: UserRecoveryDeps,
  destinationId: string,
  clientTransferId: string,
  onState: (transfer: ExternalMediaTransferView) => Promise<void>,
): Promise<ExternalMediaTransferStatus> {
  const transfer = (await mediaSnapshot(deps.offscreen)).find((candidate) =>
    candidate.destinationId === destinationId && candidate.request.clientTransferId === clientTransferId);
  if (!transfer?.owner || (transfer.state !== 'retry-wait' && transfer.state !== 'action-required')) {
    throw new Error('External media transfer is not retryable');
  }
  const routes = await deps.integrations.authorizedMediaRoutes(transfer.owner.recordingId);
  const route = routes.find((candidate) => matchesOwner(candidate, transfer));
  if (!route) throw new Error('Media connection no longer matches recording authorization');
  const grant = await deps.integrations.mediaGrant(route);
  const response = await deps.offscreen.rpc<{
    ok: boolean;
    transfer?: ExternalMediaTransferView;
    error?: string;
  }>({
    type: 'OFFSCREEN_MEDIA_RETRY',
    destinationId,
    clientTransferId,
    grant,
  });
  if (!response?.ok || !response.transfer) {
    throw new Error(response?.error || 'External media retry failed');
  }
  await onState(response.transfer);
  const destinations = await deps.integrations.listDestinations();
  const name = destinations.find((destination) => destination.id === destinationId)?.name;
  const status = toExternalMediaStatus(response.transfer, name);
  if (!status) throw new Error('External media retry did not return visible work');
  return status;
}

async function mediaSnapshot(offscreen: OffscreenManager): Promise<ExternalMediaTransferView[]> {
  await offscreen.ensureReady();
  const response = await offscreen.rpc<{
    ok: boolean;
    transfers?: ExternalMediaTransferView[];
    error?: string;
  }>({ type: 'OFFSCREEN_MEDIA_SNAPSHOT' });
  if (!response?.ok || !Array.isArray(response.transfers)) {
    throw new Error(response?.error || 'External media snapshot failed');
  }
  return response.transfers;
}
