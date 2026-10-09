import { createIndexedDbKeyValueArea, type KeyValueArea } from '../storage/indexedDbKeyValueArea';
import type { MediaArtifactRole, MediaPart, UploadCreate } from '../../integrations/media/ExternalMediaClient';
import type { AuthorizedMediaRoute } from '../../integrations/RecordingRoutingService';
import type { RecordingHistoryEntry, RecordingHistoryFile } from '../../shared/recordingHistory';
import { parseLibraryKey, readFileByKey, type DirectoryHandleLike } from '../storage/opfsLayout';

/** Stable OPFS locator; credentials, signed URLs and media bytes are never persisted here. */
export type ExternalMediaTransfer = {
  destinationId: string;
  source: { kind: 'opfs'; key: string };
  request: UploadCreate;
  /** Identity and owner of a newly consented, finalized recording; absent on legacy test journals. */
  owner?: { recordingId: string; fileId: string; connectionVersion: number;
    producerId: string; endpoint: string; apiBase: string };
  logicalKey?: string;
  createdAt?: number;
  updatedAt?: number;
  nextAttemptAt?: number;
  attempts?: number;
  errorCategory?: 'network' | 'provider' | 'permission' | 'source' | 'conflict';
  uploadId?: string;
  artifactId?: string;
  partSize?: number;
  maxConcurrency?: number;
  uploadedParts: MediaPart[];
  state: 'pending' | 'queued' | 'uploading' | 'verifying-capability' |
    'retry-wait' | 'action-required' | 'ready-unacknowledged' | 'acknowledged' | 'canceled';
};

const PREFIX = 'externalMediaTransfer:';
const LOGICAL_PREFIX = `${PREFIX}logical:`;

export type EnqueueExternalMediaInput = {
  /** Must be supplied from the persisted, released Start-time route, never current defaults. */
  route: AuthorizedMediaRoute;
  /** History must be finalized, and `sealed` must come from the media finalization owner. */
  recording: Pick<RecordingHistoryEntry, 'id' | 'status' | 'files' | 'deletedAt'>;
  fileId: string;
  sealed: true;
  getRoot: () => Promise<DirectoryHandleLike>;
};

const MEDIA_TYPES: Record<RecordingHistoryFile['stream'], Record<string, string>> = {
  tab: { webm: 'video/webm', mp4: 'video/mp4' },
  mic: { webm: 'audio/webm', m4a: 'audio/mp4' },
  'self-video': { webm: 'video/webm', mp4: 'video/mp4' },
};
const MEDIA_ROLES: Record<RecordingHistoryFile['stream'], MediaArtifactRole> = {
  tab: 'tab-recording', mic: 'microphone-recording', 'self-video': 'self-video',
};

/** Validate the owning history/route without requiring the retained bytes for ready-result replay. */
function inspect(input: EnqueueExternalMediaInput) {
  const { recording, fileId, route } = input;
  if (input.sealed !== true || recording.deletedAt || recording.status === 'saving') {
    throw new Error('Media must be sealed and retained before enqueue');
  }
  if (!route.destinationId || !route.receiver.producerId || !route.receiver.endpoint ||
      !route.receiver.apiBase || !route.externalRecordingId ||
      !Number.isSafeInteger(route.connectionVersion) || route.connectionVersion < 1) {
    throw new Error('Invalid authorized receiver');
  }
  const file = recording.files.find((entry) => entry.id === fileId);
  if (!file || file.kind || !/^[^\\/\\\r\\\n]{1,255}$/.test(file.filename)) {
    throw new Error('Unsupported media artifact');
  }
  const extension = /\.([a-z0-9]+)$/i.exec(file.filename)?.[1]?.toLowerCase() ?? '';
  const expectedMime = MEDIA_TYPES[file.stream]?.[extension];
  if (!expectedMime || file.mimeType !== expectedMime) throw new Error('Unsupported media MIME type');
  const source = file.locations.find((location) => {
    if (location.kind !== 'opfs') return false;
    const owner = parseLibraryKey(location.key);
    return owner?.historyId === recording.id && owner.fileId === fileId;
  });
  const owner = {
    recordingId: recording.id, fileId, connectionVersion: route.connectionVersion,
    producerId: route.receiver.producerId,
    endpoint: route.receiver.endpoint, apiBase: route.receiver.apiBase,
  };
  const logicalKey = JSON.stringify([owner.recordingId, owner.fileId, route.destinationId,
    owner.producerId, owner.endpoint, owner.apiBase, owner.connectionVersion]);
  return { owner, logicalKey, sourceKey: source?.kind === 'opfs' ? source.key : undefined,
    role: MEDIA_ROLES[file.stream], filename: file.filename, mimeType: expectedMime };
}

type Inspected = ReturnType<typeof inspect>;

function assertRegistered(value: unknown, candidate: Inspected, input: EnqueueExternalMediaInput):
  asserts value is ExternalMediaTransfer {
  if (!isTransfer(value) || value.logicalKey !== candidate.logicalKey ||
      JSON.stringify(value.owner) !== JSON.stringify(candidate.owner) ||
      value.destinationId !== input.route.destinationId ||
      value.request.recordingId !== input.route.externalRecordingId ||
      (candidate.sourceKey && value.source.key !== candidate.sourceKey) ||
      parseLibraryKey(value.source.key)?.historyId !== input.recording.id ||
      parseLibraryKey(value.source.key)?.fileId !== input.fileId) {
    throw new Error('Invalid existing media journal');
  }
}

/** Build a new candidate from real retained bytes, without trusting history's optional byte count. */
async function prepare(input: EnqueueExternalMediaInput, inspected: Inspected): Promise<ExternalMediaTransfer> {
  if (!inspected.sourceKey) throw new Error('Owned retained media is unavailable');
  const actualFile = await readFileByKey(await input.getRoot(), inspected.sourceKey);
  if (!actualFile || !Number.isSafeInteger(actualFile.size) || actualFile.size <= 0) {
    throw new Error('Owned retained media is unavailable');
  }
  const now = Date.now();
  return {
    destinationId: input.route.destinationId, source: { kind: 'opfs', key: inspected.sourceKey },
    owner: inspected.owner, logicalKey: inspected.logicalKey,
    request: {
      clientTransferId: crypto.randomUUID(), recordingId: input.route.externalRecordingId,
      artifact: { role: inspected.role, filename: inspected.filename,
        mimeType: inspected.mimeType, bytes: actualFile.size },
    },
    uploadedParts: [], state: 'queued', createdAt: now, updatedAt: now, attempts: 0,
  };
}

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
    (row.state === 'pending' || row.state === 'queued' || row.state === 'uploading' ||
      row.state === 'verifying-capability' || row.state === 'retry-wait' ||
      row.state === 'action-required' || row.state === 'ready-unacknowledged' ||
      row.state === 'acknowledged' || row.state === 'canceled');
}

export class ExternalMediaTransferStore {
  constructor(private readonly area: KeyValueArea) {}

  async get(destinationId: string, clientTransferId: string): Promise<ExternalMediaTransfer | undefined> {
    // IndexedDB stores newly registered jobs under their logical owner identity.
    // Legacy runner journals still use the transfer ID key.
    return (await this.list()).find((row) => row.destinationId === destinationId &&
      row.request.clientTransferId === clientTransferId);
  }

  async enqueue(input: EnqueueExternalMediaInput): Promise<ExternalMediaTransfer> {
    if (!this.area.setIfAbsent || !this.area.get || !this.area.update) {
      throw new Error('An atomic IndexedDB journal is required');
    }
    const inspected = inspect(input);
    const key = `${LOGICAL_PREFIX}${inspected.logicalKey}`;
    const existing = await this.area.get(key);
    if (existing !== undefined) {
      assertRegistered(existing, inspected, input);
      return existing;
    }
    const candidate = await prepare(input, inspected);
    const row = await this.area.setIfAbsent(key, candidate);
    assertRegistered(row, inspected, input);
    // Duplicate enqueue returns the exact original immutable request, including its
    // filename/size, even after history rename or a lost enqueue response.
    return row;
  }

  async put(transfer: ExternalMediaTransfer): Promise<void> {
    const key = transfer.logicalKey
      ? `${LOGICAL_PREFIX}${transfer.logicalKey}`
      : externalTransferKey(transfer.destinationId, transfer.request.clientTransferId);
    if (!transfer.logicalKey) {
      await this.area.set({ [key]: transfer }); // compatibility with pre-E1 journals
      return;
    }
    if (!this.area.update) throw new Error('An atomic IndexedDB journal is required');
    await this.area.update(key, (existing) => {
      if (!isTransfer(existing) ||
          JSON.stringify(existing.request) !== JSON.stringify(transfer.request) ||
          JSON.stringify(existing.source) !== JSON.stringify(transfer.source) ||
          JSON.stringify(existing.owner) !== JSON.stringify(transfer.owner) ||
          existing.logicalKey !== transfer.logicalKey ||
          existing.destinationId !== transfer.destinationId) {
        throw new Error('Media transfer identity or immutable metadata changed');
      }
      if (existing.state === 'canceled' || existing.state === 'acknowledged' ||
          (existing.state === 'ready-unacknowledged' && transfer.state !== 'ready-unacknowledged') ||
          transfer.state === 'canceled' || transfer.state === 'acknowledged') {
        throw new Error('Media transfer is terminal or awaiting acknowledgement');
      }
      if (existing.state === 'ready-unacknowledged' &&
          existing.artifactId !== transfer.artifactId) {
        throw new Error('Ready media artifact identity changed');
      }
      return { ...transfer, createdAt: existing.createdAt, updatedAt: Date.now() };
    });
  }

  async list(): Promise<ExternalMediaTransfer[]> {
    const entries = await this.area.getAll();
    return Object.entries(entries).filter(([key]) => key.startsWith(PREFIX))
      .map(([, value]) => value).filter(isTransfer);
  }

  async acknowledge(destinationId: string, clientTransferId: string): Promise<void> {
    const transfer = await this.get(destinationId, clientTransferId);
    if (transfer?.state === 'acknowledged') return;
    if (!transfer || transfer.state !== 'ready-unacknowledged') {
      throw new Error('External media is not ready for acknowledgement');
    }
    if (transfer.logicalKey) {
      // Tombstone the logical identity: a later duplicate reconciliation must not
      // generate a second receiver artifact if the history ACK response was lost.
      if (!this.area.update) throw new Error('An atomic IndexedDB journal is required');
      await this.area.update(`${LOGICAL_PREFIX}${transfer.logicalKey}`, (current) => {
        if (!isTransfer(current) || current.request.clientTransferId !== clientTransferId ||
            current.destinationId !== destinationId ||
            (current.state !== 'ready-unacknowledged' && current.state !== 'acknowledged')) {
          throw new Error('External media is not ready for acknowledgement');
        }
        return { ...current, state: 'acknowledged', updatedAt: Date.now() };
      });
    } else {
      await this.area.remove(externalTransferKey(destinationId, clientTransferId));
    }
  }

  /** Local cancellation is a tombstone, never deletion of a remote CRM object. */
  async cancel(destinationId: string, clientTransferId: string): Promise<void> {
    const transfer = await this.get(destinationId, clientTransferId);
    if (!transfer || transfer.state === 'canceled') return;
    if (transfer.state === 'acknowledged') return;
    if (!transfer.logicalKey || !this.area.update) {
      throw new Error('An atomic IndexedDB journal is required');
    }
    await this.area.update(`${LOGICAL_PREFIX}${transfer.logicalKey}`, (current) => {
      if (!isTransfer(current) || current.destinationId !== destinationId ||
          current.request.clientTransferId !== clientTransferId) {
        throw new Error('Invalid external media cancellation identity');
      }
      return current.state === 'acknowledged' ? current :
        { ...current, state: 'canceled', updatedAt: Date.now() };
    });
  }
}

export function createExternalMediaTransferStore(factory?: IDBFactory): ExternalMediaTransferStore {
  // Transfers must never silently pretend to be durable in environments without IndexedDB.
  if (!factory && typeof indexedDB === 'undefined') throw new Error('IndexedDB is required for external media uploads');
  return new ExternalMediaTransferStore(createIndexedDbKeyValueArea({
    databaseName: 'pending-external-media-transfers', storeName: 'transfers', factory,
  }));
}
