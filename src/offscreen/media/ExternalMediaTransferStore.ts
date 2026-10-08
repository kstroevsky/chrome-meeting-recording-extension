import { createIndexedDbKeyValueArea, type KeyValueArea } from '../storage/indexedDbKeyValueArea';
import type { MediaPart, UploadCreate } from '../../integrations/media/ExternalMediaClient';

/** Stable OPFS locator; credentials, signed URLs and media bytes are never persisted here. */
export type ExternalMediaTransfer = {
  destinationId: string;
  source: { kind: 'opfs'; key: string };
  request: UploadCreate;
  uploadId?: string;
  artifactId?: string;
  partSize?: number;
  maxConcurrency?: number;
  uploadedParts: MediaPart[];
  state: 'pending' | 'uploading' | 'ready-unacknowledged';
};

const PREFIX = 'externalMediaTransfer:';

export function externalTransferKey(destinationId: string, clientTransferId: string): string {
  if (!destinationId || !clientTransferId || /[:\r\n]/.test(destinationId)) {
    throw new Error('Invalid external transfer identity');
  }
  return `${PREFIX}${destinationId}:${clientTransferId}`;
}

function isTransfer(value: unknown): value is ExternalMediaTransfer {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<ExternalMediaTransfer>;
  return typeof row.destinationId === 'string' && row.destinationId.length > 0 &&
    row.source?.kind === 'opfs' && typeof row.source.key === 'string' &&
    typeof row.request?.clientTransferId === 'string' &&
    typeof row.request?.recordingId === 'string' &&
    typeof row.request?.artifact?.bytes === 'number' &&
    Array.isArray(row.uploadedParts) &&
    (row.state === 'pending' || row.state === 'uploading' || row.state === 'ready-unacknowledged');
}

export class ExternalMediaTransferStore {
  constructor(private readonly area: KeyValueArea) {}

  async get(destinationId: string, clientTransferId: string): Promise<ExternalMediaTransfer | undefined> {
    const row = (await this.area.getAll())[externalTransferKey(destinationId, clientTransferId)];
    return isTransfer(row) ? row : undefined;
  }

  async put(transfer: ExternalMediaTransfer): Promise<void> {
    await this.area.set({ [externalTransferKey(transfer.destinationId, transfer.request.clientTransferId)]: transfer });
  }

  async list(): Promise<ExternalMediaTransfer[]> {
    const entries = await this.area.getAll();
    return Object.entries(entries).filter(([key]) => key.startsWith(PREFIX))
      .map(([, value]) => value).filter(isTransfer);
  }

  async acknowledge(destinationId: string, clientTransferId: string): Promise<void> {
    const transfer = await this.get(destinationId, clientTransferId);
    if (!transfer || transfer.state !== 'ready-unacknowledged') {
      throw new Error('External media is not ready for acknowledgement');
    }
    await this.area.remove(externalTransferKey(destinationId, clientTransferId));
  }
}

export function createExternalMediaTransferStore(): ExternalMediaTransferStore {
  // Transfers must never silently pretend to be durable in environments without IndexedDB.
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is required for external media uploads');
  return new ExternalMediaTransferStore(createIndexedDbKeyValueArea({
    databaseName: 'pending-external-media-transfers', storeName: 'transfers',
  }));
}
