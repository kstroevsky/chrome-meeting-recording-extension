import { ExternalMediaClient, MediaHttpError, type ExternalMediaGrant } from '../../integrations/media/ExternalMediaClient';
import type { AuthorizedMediaRoute } from '../../integrations/RecordingRoutingService';
import type { RecordingHistoryEntry } from '../../shared/recordingHistory';
import type { ArtifactByteSource } from '../../media/ArtifactByteSource';
import { readFileByKey, type DirectoryHandleLike } from '../storage/opfsLayout';
import { ExternalMediaTransferRunner, MediaUploadCompletingError } from './ExternalMediaTransferRunner';
import {
  ExternalMediaTransferStore,
  type ExternalMediaTransfer,
  type EnqueueExternalMediaInput,
} from './ExternalMediaTransferStore';

const MAX_DURABLE_ATTEMPTS = 5;
const BASE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 15 * 60_000;

type EnqueueInput = Omit<EnqueueExternalMediaInput, 'getRoot'> & {
  recording: Pick<RecordingHistoryEntry, 'id' | 'status' | 'files' | 'deletedAt'>;
  grant: ExternalMediaGrant;
};

type RuntimeDeps = {
  store: ExternalMediaTransferStore;
  getRoot: () => Promise<DirectoryHandleLike>;
  onState: (transfer: ExternalMediaTransfer) => void;
  now?: () => number;
  createClient?: (grant: ExternalMediaGrant) => Pick<ExternalMediaClient,
    'create' | 'status' | 'uploadPart' | 'complete' | 'playback'>;
};

/**
 * Durable offscreen owner for external-media jobs. Exactly one artifact runs at
 * a time so the runner's 256 MiB per-transfer ceiling is also the global ceiling.
 */
export class ExternalMediaTransferRuntime {
  private readonly grants = new Map<string, ExternalMediaGrant>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly now: () => number;
  private activeKey: string | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduling = false;

  constructor(private readonly deps: RuntimeDeps) {
    this.now = deps.now ?? Date.now;
  }

  async enqueue(input: EnqueueInput): Promise<ExternalMediaTransfer> {
    assertGrantForRoute(input.grant, input.route);
    const transfer = await this.deps.store.enqueue({
      recording: input.recording,
      route: input.route,
      fileId: input.fileId,
      sealed: input.sealed,
      getRoot: this.deps.getRoot,
    });
    this.grants.set(keyOf(transfer), input.grant);
    this.deps.onState(transfer);
    void this.kick();
    return transfer;
  }

  async snapshot(): Promise<ExternalMediaTransfer[]> {
    return this.deps.store.list();
  }

  async acknowledge(destinationId: string, clientTransferId: string): Promise<void> {
    await this.deps.store.acknowledge(destinationId, clientTransferId);
    const transfer = await this.deps.store.get(destinationId, clientTransferId);
    if (transfer) {
      this.releaseGrant(transfer);
      this.deps.onState(transfer);
    }
    void this.kick();
  }

  async cancel(filter: { recordingId?: string; destinationId?: string; clientTransferId?: string }): Promise<number> {
    if (!filter.recordingId && !filter.destinationId && !filter.clientTransferId) {
      throw new Error('External media cancellation requires an owner');
    }
    let canceled = 0;
    for (const transfer of await this.deps.store.list()) {
      if (filter.recordingId && transfer.owner?.recordingId !== filter.recordingId) continue;
      if (filter.destinationId && transfer.destinationId !== filter.destinationId) continue;
      if (filter.clientTransferId && transfer.request.clientTransferId !== filter.clientTransferId) continue;
      if (transfer.state === 'canceled' || transfer.state === 'acknowledged') continue;
      this.aborts.get(keyOf(transfer))?.abort(new DOMException('Transfer canceled', 'AbortError'));
      await this.deps.store.cancel(transfer.destinationId, transfer.request.clientTransferId);
      const updated = await this.deps.store.get(transfer.destinationId, transfer.request.clientTransferId);
      if (updated) this.deps.onState(updated);
      this.releaseGrant(transfer);
      canceled += 1;
    }
    void this.kick();
    return canceled;
  }

  async retry(destinationId: string, clientTransferId: string, grant: ExternalMediaGrant): Promise<ExternalMediaTransfer> {
    const transfer = await this.deps.store.get(destinationId, clientTransferId);
    if (!transfer?.owner) throw new Error('External media transfer does not exist');
    assertGrantForOwner(grant, transfer);
    if (transfer.state !== 'retry-wait' && transfer.state !== 'action-required') {
      throw new Error('External media transfer is not retryable');
    }
    const { nextAttemptAt: _nextAttemptAt, errorCategory: _errorCategory, ...rest } = transfer;
    const queued: ExternalMediaTransfer = { ...rest, state: 'queued', updatedAt: this.now() };
    await this.deps.store.put(queued);
    this.grants.set(keyOf(queued), grant);
    const persisted = await this.deps.store.get(destinationId, clientTransferId) ?? queued;
    this.deps.onState(persisted);
    void this.kick();
    return persisted;
  }

  /** Replay journal state after a Port reconnect without reading media bytes. */
  async replay(): Promise<void> {
    for (const transfer of await this.deps.store.list()) this.deps.onState(transfer);
    void this.kick();
  }

  private async kick(): Promise<void> {
    if (this.scheduling) return;
    this.scheduling = true;
    try {
      if (this.activeKey) return;
      this.clearWakeTimer();
      const now = this.now();
      const candidates = (await this.deps.store.list())
        .filter((transfer) => this.grants.has(keyOf(transfer)))
        .filter((transfer) => transfer.state === 'queued' || transfer.state === 'pending' ||
          transfer.state === 'uploading' || transfer.state === 'verifying-capability' ||
          transfer.state === 'retry-wait')
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
      const ready = candidates.find((transfer) => transfer.state !== 'retry-wait' ||
        (transfer.nextAttemptAt ?? 0) <= now);
      if (ready) {
        void this.run(ready);
        return;
      }
      const next = candidates
        .filter((transfer) => transfer.state === 'retry-wait' && transfer.nextAttemptAt != null)
        .reduce<number | undefined>((earliest, transfer) => (
          earliest == null ? transfer.nextAttemptAt : Math.min(earliest, transfer.nextAttemptAt!)
        ), undefined);
      if (next != null) {
        this.wakeTimer = setTimeout(() => {
          this.wakeTimer = null;
          void this.kick();
        }, Math.max(0, next - now));
      }
    } finally {
      this.scheduling = false;
    }
  }

  private async run(initial: ExternalMediaTransfer): Promise<void> {
    const key = keyOf(initial);
    if (this.activeKey) return;
    const grant = this.grants.get(key);
    if (!grant) return;
    this.activeKey = key;
    const abort = new AbortController();
    this.aborts.set(key, abort);
    try {
      const current = await this.deps.store.get(initial.destinationId, initial.request.clientTransferId);
      if (!current || current.state === 'canceled' || current.state === 'acknowledged' ||
          current.state === 'ready-unacknowledged') return;
      assertGrantForOwner(grant, current);
      const attempts = (current.attempts ?? 0) + 1;
      const resumeVerification = current.state === 'verifying-capability' ||
        current.resumeFrom === 'verifying-capability';
      const {
        nextAttemptAt: _nextAttemptAt,
        errorCategory: _errorCategory,
        resumeFrom: _resumeFrom,
        ...rest
      } = current;
      const running: ExternalMediaTransfer = {
        ...rest,
        state: resumeVerification ? 'verifying-capability' : 'uploading',
        attempts,
        updatedAt: this.now(),
      };
      await this.deps.store.put(running);
      this.deps.onState(await this.deps.store.get(running.destinationId, running.request.clientTransferId) ?? running);

      const client = this.deps.createClient?.(grant) ?? new ExternalMediaClient(
        grant.capability, grant.endpoint, async () => grant.bearer, undefined,
        async (origin) => grant.capability.upload.origins.includes(origin),
      );
      const runner = new ExternalMediaTransferRunner(client, this.deps.store);
      if (resumeVerification) {
        await runner.transfer(running, undefined, abort.signal);
      } else {
        const file = await readFileByKey(await this.deps.getRoot(), running.source.key);
        if (!file) throw new SourceUnavailableError();
        await runner.transfer(running, fileSource(file), abort.signal);
      }
      const ready = await this.deps.store.get(running.destinationId, running.request.clientTransferId);
      if (ready) this.deps.onState(ready);
    } catch (error) {
      const current = await this.deps.store.get(initial.destinationId, initial.request.clientTransferId);
      if (!current || current.state === 'canceled' || current.state === 'acknowledged' ||
          current.state === 'ready-unacknowledged' || abort.signal.aborted) return;
      const transient = isTransient(error);
      const attempts = current.attempts ?? 1;
      const retryable = transient && attempts < MAX_DURABLE_ATTEMPTS;
      const resumeFrom = current.state === 'verifying-capability' ||
        current.resumeFrom === 'verifying-capability'
        ? 'verifying-capability' as const
        : undefined;
      const next: ExternalMediaTransfer = retryable
        ? {
            ...current,
            state: 'retry-wait',
            nextAttemptAt: this.now() + Math.min(BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_MS),
            errorCategory: classifyError(error),
            resumeFrom,
            updatedAt: this.now(),
          }
        : {
            ...current,
            state: 'action-required',
            errorCategory: classifyError(error),
            nextAttemptAt: undefined,
            resumeFrom,
            updatedAt: this.now(),
          };
      await this.deps.store.put(next);
      const persisted = await this.deps.store.get(next.destinationId, next.request.clientTransferId) ?? next;
      this.deps.onState(persisted);
    } finally {
      this.aborts.delete(key);
      if (this.activeKey === key) this.activeKey = null;
      void this.kick();
    }
  }

  private releaseGrant(transfer: ExternalMediaTransfer): void {
    const key = keyOf(transfer);
    this.grants.delete(key);
    this.aborts.delete(key);
  }

  private clearWakeTimer(): void {
    if (!this.wakeTimer) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }
}

function fileSource(file: File): ArtifactByteSource {
  return {
    size: file.size,
    async read(start, end, signal) {
      signal?.throwIfAborted();
      return file.slice(start, end);
    },
  };
}

function keyOf(transfer: Pick<ExternalMediaTransfer, 'destinationId' | 'request'>): string {
  return `${transfer.destinationId}\u0000${transfer.request.clientTransferId}`;
}

function assertGrantForRoute(grant: ExternalMediaGrant, route: AuthorizedMediaRoute): void {
  if (grant.destinationId !== route.destinationId || grant.connectionVersion !== route.connectionVersion ||
      grant.producerId !== route.receiver.producerId || grant.endpoint !== route.receiver.endpoint ||
      grant.capability.apiBase !== route.receiver.apiBase ||
      grant.capability.upload.origins.length !== route.receiver.uploadOrigins.length ||
      !grant.capability.upload.origins.every((origin, index) => origin === route.receiver.uploadOrigins[index]) ||
      !grant.bearer) {
    throw new Error('External media grant does not match recording authorization');
  }
}

function assertGrantForOwner(grant: ExternalMediaGrant, transfer: ExternalMediaTransfer): void {
  const owner = transfer.owner;
  if (!owner || grant.destinationId !== transfer.destinationId ||
      grant.connectionVersion !== owner.connectionVersion || grant.producerId !== owner.producerId ||
      grant.endpoint !== owner.endpoint || grant.capability.apiBase !== owner.apiBase ||
      grant.capability.upload.origins.length !== owner.uploadOrigins.length ||
      !grant.capability.upload.origins.every((origin, index) => origin === owner.uploadOrigins[index]) ||
      !grant.bearer) {
    throw new Error('External media grant does not match transfer owner');
  }
}

class SourceUnavailableError extends Error {}

function isTransient(error: unknown): boolean {
  return error instanceof MediaUploadCompletingError || error instanceof TypeError || (error instanceof MediaHttpError &&
    (error.status === 429 || error.status >= 500));
}

function classifyError(error: unknown): ExternalMediaTransfer['errorCategory'] {
  if (error instanceof SourceUnavailableError) return 'source';
  if (error instanceof MediaUploadCompletingError) return 'provider';
  if (error instanceof MediaHttpError) {
    if (error.status === 401 || error.status === 403) return 'permission';
    if (error.status === 409) return 'conflict';
    return 'provider';
  }
  if (error instanceof TypeError) return 'network';
  return 'provider';
}
