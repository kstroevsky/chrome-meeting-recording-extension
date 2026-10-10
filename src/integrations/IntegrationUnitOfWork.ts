import {
  INTEGRATION_DELIVERIES_STORE,
  INTEGRATION_DESTINATIONS_STORE,
  INTEGRATION_ROUTING_INTENTS_STORE,
  INTEGRATION_SECRETS_STORE,
  INTEGRATION_STREAMS_STORE,
  openIntegrationDatabase,
} from './IntegrationDatabase';
import {
  normalizeIntegrationDelivery,
  normalizeIntegrationDestination,
  normalizeIntegrationSecret,
  normalizeIntegrationStream,
  normalizeRecordingIntegrationIntent,
  type IntegrationDelivery,
  type IntegrationDestination,
  type IntegrationSecret,
  type IntegrationStream,
  type RecordingIntegrationIntentDestination,
} from './persistence';
import type { MediaCapability } from './media/MediaCapability';

/**
 * Multi-store mutations whose invariants would be broken by separate
 * transactions. Every method resolves only after its transaction commits.
 */
export class IntegrationUnitOfWork {
  constructor(private readonly factory?: IDBFactory) {}

  async createDestination(
    destination: IntegrationDestination,
    secrets: IntegrationSecret[],
  ): Promise<void> {
    const normalizedDestination = normalizeIntegrationDestination(destination);
    const normalizedSecrets = secrets.map(normalizeIntegrationSecret);
    if (!normalizedDestination || normalizedSecrets.some((secret) => !secret)) {
      throw new Error('Invalid integration destination transaction');
    }

    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_DESTINATIONS_STORE, INTEGRATION_SECRETS_STORE],
      (transaction) => {
        const secretStore = transaction.objectStore(INTEGRATION_SECRETS_STORE);
        for (const secret of normalizedSecrets as IntegrationSecret[]) {
          secretStore.put(secret);
        }
        transaction.objectStore(INTEGRATION_DESTINATIONS_STORE).put(normalizedDestination);
      },
      'Could not create integration destination',
    );
  }

  /** Rotate the media bearer and capability together. Re-read the live destination
   * inside the transaction so a racing delete cannot resurrect credentials. */
  async configureMedia(destinationId: string, secret: IntegrationSecret, capability: MediaCapability, updatedAt: number): Promise<void> {
    const normalizedSecret = normalizeIntegrationSecret(secret);
    if (!normalizedSecret || normalizedSecret.kind !== 'media-auth') throw new Error('Invalid media credential');
    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(database, [INTEGRATION_DESTINATIONS_STORE, INTEGRATION_SECRETS_STORE], (transaction) => {
      const destinations = transaction.objectStore(INTEGRATION_DESTINATIONS_STORE);
      const secrets = transaction.objectStore(INTEGRATION_SECRETS_STORE);
      const request = destinations.get(destinationId);
      request.onsuccess = () => {
        const current = normalizeIntegrationDestination(request.result);
        if (!current) {
          transaction.abort();
          return;
        }
        const updated = normalizeIntegrationDestination({
          ...current, media: { secretId: normalizedSecret.id, capability }, updatedAt,
        });
        if (!updated) { transaction.abort(); return; }
        secrets.put(normalizedSecret);
        destinations.put(updated);
        if (current.media) secrets.delete(current.media.secretId);
      };
    }, 'Could not configure media connection');
  }

  /**
   * Turns automatic routing on or off without discarding connection credentials.
   * Disabling also removes historical routing intents and cancels unresolved
   * deliveries so a later re-enable cannot resurrect work that was pending.
   */
  async setDestinationEnabled(destinationId: string, enabled: boolean, updatedAt: number): Promise<void> {
    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [
        INTEGRATION_DESTINATIONS_STORE,
        INTEGRATION_ROUTING_INTENTS_STORE,
        INTEGRATION_DELIVERIES_STORE,
      ],
      (transaction) => {
        const destinations = transaction.objectStore(INTEGRATION_DESTINATIONS_STORE);
        const request = destinations.get(destinationId);
        request.onsuccess = () => {
          const current = normalizeIntegrationDestination(request.result);
          if (!current) {
            transaction.abort();
            return;
          }
          const updated = normalizeIntegrationDestination({ ...current, enabled, updatedAt });
          if (!updated) {
            transaction.abort();
            return;
          }
          destinations.put(updated);
        };
        if (!enabled) {
          removeDestinationFromRouting(transaction, destinationId);
          cancelDestinationDeliveries(transaction, destinationId, updatedAt, 'destination-disabled');
        }
      },
      'Could not update integration automation state',
    );
  }

  async planDelivery(delivery: IntegrationDelivery, stream: IntegrationStream): Promise<void> {
    const normalizedDelivery = normalizeIntegrationDelivery(delivery);
    const normalizedStream = normalizeIntegrationStream(stream);
    if (!normalizedDelivery || !normalizedDelivery.allowedPolicy || !normalizedStream) {
      throw new Error('Invalid integration delivery transaction');
    }

    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_DELIVERIES_STORE, INTEGRATION_STREAMS_STORE],
      (transaction) => {
        const deliveries = transaction.objectStore(INTEGRATION_DELIVERIES_STORE);
        supersedeOlderStreamDeliveries(deliveries, normalizedDelivery);
        deliveries.put(normalizedDelivery);
        transaction.objectStore(INTEGRATION_STREAMS_STORE).put(normalizedStream);
      },
      'Could not atomically plan integration delivery',
    );
  }

  async supersedeDelivery(
    previous: IntegrationDelivery,
    replacement: IntegrationDelivery,
    stream: IntegrationStream,
  ): Promise<void> {
    const normalizedPrevious = normalizeIntegrationDelivery(previous);
    const normalizedReplacement = normalizeIntegrationDelivery(replacement);
    const normalizedStream = normalizeIntegrationStream(stream);
    if (!normalizedPrevious || !normalizedReplacement || !normalizedStream) {
      throw new Error('Invalid integration delivery supersession transaction');
    }
    if (normalizedPrevious.state !== 'superseded' || normalizedReplacement.state !== 'pending') {
      throw new Error('Invalid integration delivery supersession states');
    }

    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_DELIVERIES_STORE, INTEGRATION_STREAMS_STORE],
      (transaction) => {
        const deliveries = transaction.objectStore(INTEGRATION_DELIVERIES_STORE);
        deliveries.put(normalizedPrevious);
        deliveries.put(normalizedReplacement);
        transaction.objectStore(INTEGRATION_STREAMS_STORE).put(normalizedStream);
      },
      'Could not atomically supersede integration delivery',
    );
  }

  /**
   * Adds the routes chosen at recording start to the recording's intent, with
   * the stream identities they need, in one transaction. Each destination is
   * re-read inside it, so a destination deleted or disabled meanwhile is not
   * written back. An entry already present for a destination wins, and a stream
   * that already exists keeps its identity and revision: the receiver may have
   * seen it. Resolves to the destinations actually added.
   */
  async beginRecordingRouting(
    recordingId: string,
    entries: RecordingIntegrationIntentDestination[],
    streams: IntegrationStream[],
  ): Promise<string[]> {
    const normalizedIntent = normalizeRecordingIntegrationIntent({ recordingId, destinations: entries });
    const normalizedStreams = streams.map(normalizeIntegrationStream);
    if (!normalizedIntent || normalizedStreams.some((stream) => !stream)) {
      throw new Error('Invalid recording routing transaction');
    }

    const added: string[] = [];
    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_DESTINATIONS_STORE, INTEGRATION_ROUTING_INTENTS_STORE, INTEGRATION_STREAMS_STORE],
      (transaction) => {
        const destinationStore = transaction.objectStore(INTEGRATION_DESTINATIONS_STORE);
        const intentStore = transaction.objectStore(INTEGRATION_ROUTING_INTENTS_STORE);
        const streamStore = transaction.objectStore(INTEGRATION_STREAMS_STORE);
        const existingIntent = intentStore.get(recordingId);
        existingIntent.onsuccess = () => {
          const kept = normalizeRecordingIntegrationIntent(existingIntent.result)?.destinations ?? [];
          const candidates = normalizedIntent.destinations
            .filter((entry) => !kept.some((row) => row.destinationId === entry.destinationId));
          const live: RecordingIntegrationIntentDestination[] = [];
          let remaining = candidates.length;
          const finish = () => {
            if (!live.length) return;
            intentStore.put({ recordingId, destinations: [...kept, ...live] });
            for (const entry of live) {
              added.push(entry.destinationId);
              const stream = (normalizedStreams as IntegrationStream[])
                .find((candidate) => candidate.destinationId === entry.destinationId);
              if (!stream) continue;
              const existingStream = streamStore.get([stream.destinationId, stream.recordingId]);
              existingStream.onsuccess = () => {
                if (existingStream.result === undefined) streamStore.put(stream);
              };
            }
          };
          if (!remaining) return;
          for (const entry of candidates) {
            const destination = destinationStore.get(entry.destinationId);
            destination.onsuccess = () => {
              const current = normalizeIntegrationDestination(destination.result);
              if (current?.enabled) {
                // Recheck the receiver inside the same transaction as the Start intent.
                // A concurrent media enable or receiver edit must never widen consent.
                live.push(revalidateMediaAuthorization(entry, current));
              }
              remaining -= 1;
              if (!remaining) finish();
            };
          }
        };
      },
      'Could not write recording routing',
    );
    return added;
  }

  /**
   * Applies only the held routes the answering dialog actually observed. A route
   * added by a newer dialog stays held when an older dialog answers later.
   */
  async confirmRecordingRouting(
    recordingId: string,
    decisions: readonly { destinationId: string; action: 'release' | 'skip' }[],
  ): Promise<boolean> {
    const decisionsById = new Map(decisions.map((decision) => [decision.destinationId, decision.action]));
    let changed = false;
    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_ROUTING_INTENTS_STORE],
      (transaction) => {
        const store = transaction.objectStore(INTEGRATION_ROUTING_INTENTS_STORE);
        const request = store.get(recordingId);
        request.onsuccess = () => {
          const intent = normalizeRecordingIntegrationIntent(request.result);
          if (!intent) return;
          const destinations = intent.destinations.map((entry) => {
            const action = entry.releaseAfter ? decisionsById.get(entry.destinationId) : undefined;
            if (!action) return entry;
            changed = true;
            const { releaseAfter: _released, ...rest } = entry;
            return action === 'skip' ? { ...rest, state: 'skipped' as const } : rest;
          });
          if (changed) store.put({ recordingId, destinations });
        };
      },
      'Could not confirm recording routing',
    );
    return changed;
  }

  /**
   * An explicit end-dialog receiver change. The old route is skipped and the
   * new one is created held, with its stream identity, in one transaction. A
   * stale dialog cannot replace an already-decided route.
   */
  async changeRecordingRouting(
    recordingId: string,
    fromDestinationId: string | undefined,
    entry: RecordingIntegrationIntentDestination,
    stream: IntegrationStream,
  ): Promise<'changed' | 'stale' | 'unavailable'> {
    const normalizedIntent = normalizeRecordingIntegrationIntent({ recordingId, destinations: [entry] });
    const normalizedStream = normalizeIntegrationStream(stream);
    const normalizedEntry = normalizedIntent?.destinations[0];
    if (!normalizedEntry || !normalizedStream || normalizedEntry.destinationId !== normalizedStream.destinationId) {
      throw new Error('Invalid recording route change transaction');
    }

    let result: 'changed' | 'stale' | 'unavailable' = 'stale';
    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_DESTINATIONS_STORE, INTEGRATION_ROUTING_INTENTS_STORE, INTEGRATION_STREAMS_STORE],
      (transaction) => {
        const destinationStore = transaction.objectStore(INTEGRATION_DESTINATIONS_STORE);
        const intentStore = transaction.objectStore(INTEGRATION_ROUTING_INTENTS_STORE);
        const streamStore = transaction.objectStore(INTEGRATION_STREAMS_STORE);
        const existingIntent = intentStore.get(recordingId);
        existingIntent.onsuccess = () => {
          const kept = normalizeRecordingIntegrationIntent(existingIntent.result)?.destinations ?? [];
          if (kept.some((candidate) => candidate.destinationId === normalizedEntry.destinationId)) return;
          if (fromDestinationId) {
            const source = kept.find((candidate) => candidate.destinationId === fromDestinationId);
            if (source?.state !== 'selected' || source.releaseAfter !== 'save-confirmed') return;
          }

          const destinationRequest = destinationStore.get(normalizedEntry.destinationId);
          destinationRequest.onsuccess = () => {
            const current = normalizeIntegrationDestination(destinationRequest.result);
            if (!current?.enabled) {
              result = 'unavailable';
              return;
            }
            const liveEntry = revalidateMediaAuthorization(normalizedEntry, current);
            const destinations = kept.map((candidate) => {
              if (!fromDestinationId || candidate.destinationId !== fromDestinationId) return candidate;
              const { releaseAfter: _held, ...rest } = candidate;
              return { ...rest, state: 'skipped' as const };
            });
            intentStore.put({ recordingId, destinations: [...destinations, liveEntry] });

            const existingStream = streamStore.get([normalizedStream.destinationId, recordingId]);
            existingStream.onsuccess = () => {
              if (existingStream.result === undefined) streamStore.put(normalizedStream);
            };
            result = 'changed';
          };
        };
      },
      'Could not change recording routing',
    );
    return result;
  }

  /**
   * Forgets a recording the user removed: its routing intent goes, work not yet
   * delivered is canceled, and streams never attempted are dropped. A stream the
   * receiver already saw is kept, so its identity is never reused by accident.
   */
  async forgetRecordingRouting(recordingId: string, updatedAt: number): Promise<void> {
    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [INTEGRATION_ROUTING_INTENTS_STORE, INTEGRATION_STREAMS_STORE, INTEGRATION_DELIVERIES_STORE],
      (transaction) => {
        transaction.objectStore(INTEGRATION_ROUTING_INTENTS_STORE).delete(recordingId);
        deleteUnattemptedStreams(transaction, recordingId);
        cancelRecordingDeliveries(transaction, recordingId, updatedAt);
      },
      'Could not forget recording routing',
    );
  }

  async deleteDestination(destination: IntegrationDestination, updatedAt: number): Promise<void> {
    const normalizedDestination = normalizeIntegrationDestination(destination);
    if (!normalizedDestination) throw new Error('Invalid integration destination deletion');

    const database = await openIntegrationDatabase(this.factory);
    await runTransaction(
      database,
      [
        INTEGRATION_DESTINATIONS_STORE,
        INTEGRATION_SECRETS_STORE,
        INTEGRATION_ROUTING_INTENTS_STORE,
        INTEGRATION_STREAMS_STORE,
        INTEGRATION_DELIVERIES_STORE,
      ],
      (transaction) => {
        const destinations = transaction.objectStore(INTEGRATION_DESTINATIONS_STORE);
        const request = destinations.get(normalizedDestination.id);
        request.onsuccess = () => {
          // A media token can rotate between the coordinator's initial read and
          // this transaction. Delete credentials from the live row, not its snapshot.
          const current = normalizeIntegrationDestination(request.result);
          if (current) {
            const secrets = transaction.objectStore(INTEGRATION_SECRETS_STORE);
            secrets.delete(current.signingSecretId);
            if (current.media) secrets.delete(current.media.secretId);
            if (current.requestAuth.type !== 'none') secrets.delete(current.requestAuth.secretId);
          }
          destinations.delete(normalizedDestination.id);
        };
        deleteMatchingStreams(transaction, normalizedDestination.id);
        removeDestinationFromRouting(transaction, normalizedDestination.id);
        cancelDestinationDeliveries(transaction, normalizedDestination.id, updatedAt);
      },
      'Could not delete integration destination',
    );
  }
}

/** A consent snapshot can survive the transaction only while its receiver is unchanged. */
function revalidateMediaAuthorization(
  entry: RecordingIntegrationIntentDestination,
  current: IntegrationDestination,
): RecordingIntegrationIntentDestination {
  const consent = entry.mediaAuthorization;
  const mediaUnchanged = consent && current.media &&
    consent.producerId === current.producerId &&
    consent.endpoint === current.endpoint &&
    consent.apiBase === current.media.capability.apiBase &&
    consent.uploadOrigins.length === current.media.capability.upload.origins.length &&
    consent.uploadOrigins.every((origin, index) => origin === current.media!.capability.upload.origins[index]) &&
    entry.connectionVersion === current.connectionVersion;
  return mediaUnchanged ? entry : { ...entry, mediaAuthorization: undefined };
}

function supersedeOlderStreamDeliveries(
  deliveries: IDBObjectStore,
  replacement: IntegrationDelivery,
): void {
  const request = deliveries.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = normalizeIntegrationDelivery(cursor.value);
    const stale = row
      && row.id !== replacement.id
      && row.destinationId === replacement.destinationId
      && row.recordingId === replacement.recordingId
      && row.revision < replacement.revision
      && (row.state === 'pending' || row.state === 'delivering' || row.state === 'retrying');
    if (stale) {
      const superseded: IntegrationDelivery = {
        ...row,
        state: 'superseded',
        lastErrorCode: 'newer-revision-planned',
        updatedAt: replacement.createdAt,
      };
      delete superseded.nextAttemptAt;
      cursor.update(superseded);
    }
    cursor.continue();
  };
}

function deleteMatchingStreams(transaction: IDBTransaction, destinationId: string): void {
  const request = transaction.objectStore(INTEGRATION_STREAMS_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if ((cursor.value as { destinationId?: unknown }).destinationId === destinationId) {
      cursor.delete();
    }
    cursor.continue();
  };
}

function deleteUnattemptedStreams(transaction: IDBTransaction, recordingId: string): void {
  const request = transaction.objectStore(INTEGRATION_STREAMS_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as { recordingId?: unknown; everAttempted?: unknown };
    if (row.recordingId === recordingId && row.everAttempted !== true) cursor.delete();
    cursor.continue();
  };
}

function cancelRecordingDeliveries(
  transaction: IDBTransaction,
  recordingId: string,
  updatedAt: number,
): void {
  const request = transaction.objectStore(INTEGRATION_DELIVERIES_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as IntegrationDelivery;
    const unresolved = row.recordingId === recordingId
      && ['pending', 'delivering', 'retrying', 'action-required'].includes(row.state);
    if (unresolved) {
      const next = { ...row, state: 'canceled' as const, lastErrorCode: 'recording-removed', updatedAt };
      delete next.nextAttemptAt;
      cursor.update(next);
    }
    cursor.continue();
  };
}

function removeDestinationFromRouting(transaction: IDBTransaction, destinationId: string): void {
  const request = transaction.objectStore(INTEGRATION_ROUTING_INTENTS_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as { destinations?: Array<{ destinationId?: unknown }> };
    if (Array.isArray(row.destinations)) {
      const destinations = row.destinations.filter((item) => item.destinationId !== destinationId);
      if (destinations.length !== row.destinations.length) {
        if (destinations.length) cursor.update({ ...row, destinations });
        else cursor.delete();
      }
    }
    cursor.continue();
  };
}

function cancelDestinationDeliveries(
  transaction: IDBTransaction,
  destinationId: string,
  updatedAt: number,
  errorCode = 'destination-deleted',
): void {
  const request = transaction.objectStore(INTEGRATION_DELIVERIES_STORE).openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const row = cursor.value as IntegrationDelivery;
    const unresolved = row.destinationId === destinationId
      && ['pending', 'delivering', 'retrying', 'action-required'].includes(row.state);
    if (unresolved) {
      const next = {
        ...row,
        state: 'canceled' as const,
        lastErrorCode: errorCode,
        updatedAt,
      };
      delete next.nextAttemptAt;
      cursor.update(next);
    }
    cursor.continue();
  };
}

async function runTransaction(
  database: IDBDatabase,
  storeNames: string[],
  mutate: (transaction: IDBTransaction) => void,
  errorMessage: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeNames, 'readwrite');
    mutate(transaction);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(errorMessage));
    transaction.onabort = () => reject(transaction.error ?? new Error(`${errorMessage} (aborted)`));
  });
}
