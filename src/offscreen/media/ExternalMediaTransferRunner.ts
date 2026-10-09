import type { ArtifactByteSource } from '../../media/ArtifactByteSource';
import {
  ExternalMediaClient, MediaHttpError, type MediaPart,
} from '../../integrations/media/ExternalMediaClient';
import {
  ExternalMediaTransferStore, externalTransferKey, type ExternalMediaTransfer,
} from './ExternalMediaTransferStore';

const MiB = 1024 * 1024;
const MAX_IN_FLIGHT = 256 * MiB;
const MAX_RESTARTS = 3;
const RETRIES = 4;

type Ready = { state: 'ready'; artifactId: string };

/** A completion/status 409 means the receiver still owns a bounded completion lease. */
export class MediaUploadCompletingError extends Error {
  constructor(readonly httpError: MediaHttpError) {
    super('Media upload completion is still in progress');
    this.name = 'MediaUploadCompletingError';
  }
}

function assertUploadParameters(partSize: number, maxConcurrency: number): number {
  if (!Number.isSafeInteger(partSize) || partSize < 5 * MiB || partSize > MAX_IN_FLIGHT ||
      !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 3) {
    throw new Error('Unsupported upload parameters');
  }
  return Math.min(maxConcurrency, Math.floor(MAX_IN_FLIGHT / partSize));
}

async function retry<T>(operation: () => Promise<T>, signal?: AbortSignal,
  retryCompleting = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); } catch (error) {
      const completing = retryCompleting && error instanceof MediaHttpError &&
        error.status === 409 && error.code === 'MEDIA_UPLOAD_COMPLETING';
      const transient = error instanceof TypeError || (error instanceof MediaHttpError &&
        (error.status === 429 || error.status >= 500 || completing));
      if (!transient || signal?.aborted || attempt >= RETRIES) {
        if (completing && error instanceof MediaHttpError) {
          throw new MediaUploadCompletingError(error);
        }
        throw error;
      }
      const delay = Math.min(500 * 2 ** attempt, 5_000);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, delay);
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('Transfer aborted')); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}

/**
 * Offscreen-only multipart executor. A persisted ready result is retained until the caller
 * has durably stored its external ArtifactLocation and explicitly acknowledges it.
 */
export class ExternalMediaTransferRunner {
  // Offscreen operations can instantiate more than one runner in the same document.
  private static readonly active = new Set<string>();

  constructor(private readonly client: Pick<ExternalMediaClient,
    'create' | 'status' | 'uploadPart' | 'complete' | 'playback'>,
    private readonly store: ExternalMediaTransferStore) {}

  async transfer(input: Pick<ExternalMediaTransfer, 'destinationId' | 'source' | 'request'>,
    bytes?: ArtifactByteSource, signal?: AbortSignal): Promise<Ready> {
    const key = externalTransferKey(input.destinationId, input.request.clientTransferId);
    if (ExternalMediaTransferRunner.active.has(key)) throw new Error('External media transfer is already running');
    ExternalMediaTransferRunner.active.add(key);
    try { return await this.run(input, bytes, signal); }
    finally { ExternalMediaTransferRunner.active.delete(key); }
  }

  private async run(input: Pick<ExternalMediaTransfer, 'destinationId' | 'source' | 'request'>,
    bytes?: ArtifactByteSource, signal?: AbortSignal): Promise<Ready> {
    let state = await this.store.get(input.destinationId, input.request.clientTransferId);
    if (state && (JSON.stringify(state.request) !== JSON.stringify(input.request) ||
        JSON.stringify(state.source) !== JSON.stringify(input.source))) {
      throw new Error('Transfer identity was reused with different content');
    }
    if (state?.state === 'ready-unacknowledged') {
      if (!state.artifactId) throw new Error('Missing confirmed artifact');
      return { state: 'ready', artifactId: state.artifactId };
    }
    if (state?.state === 'verifying-capability') {
      if (!state.artifactId) throw new Error('Missing confirmed artifact');
      return await this.ready(state, state.artifactId);
    }
    if (state?.state === 'canceled' || state?.state === 'acknowledged') {
      throw new Error('External media transfer is already terminal');
    }
    if (!bytes || !Number.isSafeInteger(bytes.size) || bytes.size <= 0 ||
        bytes.size !== input.request.artifact.bytes) {
      throw new Error('Media source does not match declared upload size');
    }
    state ??= { ...input, uploadedParts: [], state: 'pending' };
    await this.store.put(state);

    for (let restart = 0; restart < MAX_RESTARTS; restart++) {
      signal?.throwIfAborted();
      try {
        // The server's ListParts (and underlying provider) always wins after a restart.
        let status = state.uploadId ? await retry(() => this.client.status(state!.uploadId!, signal), signal, true) : undefined;
        if (status?.state === 'ready') return await this.ready(state, status.artifactId);
        if (!state.uploadId || !status || !state.partSize || !state.maxConcurrency) {
          const created = await retry(() => this.client.create(input.request, signal), signal);
          if (created.state === 'ready') return await this.ready(state, created.artifactId);
          // A newly provisioned upload supersedes all local part receipts.
          if (state.uploadId !== created.uploadId) state.uploadedParts = [];
          state = { ...state, state: 'uploading', uploadId: created.uploadId,
            artifactId: created.artifactId, partSize: created.partSize,
            maxConcurrency: created.maxConcurrency };
          await this.store.put(state);
          status = await retry(() => this.client.status(created.uploadId, signal), signal, true);
          if (status.state === 'ready') return await this.ready(state, status.artifactId);
        }
        const partSize = state.partSize!;
        const workers = assertUploadParameters(partSize, state.maxConcurrency!);
        const count = Math.ceil(bytes.size / partSize);
        if (count > 10_000) throw new Error('Unsupported upload parameters');
        const authoritativeParts = status!.uploadedParts;
        const parts = new Map<number, string>();
        for (const part of authoritativeParts) {
          if (part.partNumber > count) throw new Error('Server returned an invalid media part');
          parts.set(part.partNumber, part.etag);
        }
        state.uploadedParts = [...parts].map(([partNumber, etag]) => ({ partNumber, etag }));
        await this.store.put(state);
        const missing = Array.from({ length: count }, (_, index) => index + 1)
          .filter((partNumber) => !parts.has(partNumber));
        let next = 0;
        let persistence = Promise.resolve();
        let failure: unknown;
        const worker = async () => {
          while (next < missing.length && !failure) {
            const partNumber = missing[next++]!;
            try {
              signal?.throwIfAborted();
              const start = (partNumber - 1) * partSize;
              const end = Math.min(start + partSize, bytes.size);
              const blob = await bytes.read(start, end, signal);
              if (blob.size !== end - start) throw new Error('Media source returned the wrong part length');
              const etag = await retry(() => this.client.uploadPart(state!.uploadId!, partNumber, blob, signal), signal);
              parts.set(partNumber, etag);
              // Serialize writes from concurrent workers so no later receipt is lost.
              persistence = persistence.then(async () => {
                state!.uploadedParts = [...parts].sort((a, b) => a[0] - b[0])
                  .map(([number, tag]) => ({ partNumber: number, etag: tag }));
                await this.store.put(state!);
              });
              await persistence;
            } catch (error) { failure ??= error; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(workers, missing.length) }, () => worker()));
        if (failure) throw failure;
        const manifest: MediaPart[] = Array.from({ length: count }, (_, index) => ({
          partNumber: index + 1, etag: parts.get(index + 1)!,
        }));
        const completed = await retry(() => this.client.complete(state!.uploadId!, manifest, signal), signal, true);
        return await this.ready(state, completed.artifactId);
      } catch (error) {
        if (!(error instanceof MediaHttpError) || error.status !== 410 || restart === MAX_RESTARTS - 1) throw error;
        // Retry create using the same logical transfer; the server issues a new upload attempt.
        state = { ...state, state: 'pending', uploadId: undefined, partSize: undefined,
          maxConcurrency: undefined, uploadedParts: [] };
        await this.store.put(state);
      }
    }
    throw new Error('External media upload retry exhausted');
  }

  private async ready(state: ExternalMediaTransfer, artifactId: string): Promise<Ready> {
    // The server verifies HEAD/size before returning ready. Confirm playback capability too.
    const verifying: ExternalMediaTransfer = {
      ...state,
      state: 'verifying-capability',
      artifactId,
    };
    await this.store.put(verifying);
    await this.client.playback(artifactId);
    await this.store.put({ ...verifying, state: 'ready-unacknowledged', artifactId });
    return { state: 'ready', artifactId };
  }
}
