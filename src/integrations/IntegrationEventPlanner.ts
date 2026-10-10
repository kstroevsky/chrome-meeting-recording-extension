import type {
  IntegrationDataPolicy,
  IntegrationReadiness,
  IntegrationReadinessEvaluation,
} from './contracts';
import { createIntegrationId } from './ids';
import {
  assertIntegrationPayloadWithinLimit,
  INTEGRATION_MAX_PAYLOAD_BYTES,
  IntegrationPayloadTooLargeError,
} from './payload';
import type {
  IntegrationDelivery,
  IntegrationDestination,
  IntegrationSpeakerAlias,
  IntegrationStream,
  RecordingIntegrationIntent,
  RecordingIntegrationIntentDestination,
} from './persistence';
import { intersectIntegrationPolicy } from './policy';
import { integrationProjectionHash } from './IntegrationProjectionFingerprint';
import { sha256Hex } from './serialization';

/** Product wake-up bound; protocol consumers must not depend on this exact duration. */
export const INTEGRATION_READY_TIMEOUT_MS = 15 * 60 * 1000;

type SnapshotEnvelope = {
  eventTypePrefix: string;
  eventKind: 'recording.ready.v1' | 'recording.updated.v1';
  eventId: string;
  eventTime: number;
  producerId: string;
  externalRecordingId: string;
  revision: number;
};

type BuiltSnapshot = {
  body: string;
  totalBytes: number;
  transcriptBytes: number;
  otherBytes: number;
  readiness: IntegrationReadiness;
  speakerAliases?: IntegrationSpeakerAlias[];
};

type PlannerDeps = {
  destinations: { get(id: string): Promise<IntegrationDestination | undefined> };
  routing: { get(recordingId: string): Promise<RecordingIntegrationIntent | undefined> };
  streams: {
    get(destinationId: string, recordingId: string): Promise<IntegrationStream | undefined>;
    put(stream: IntegrationStream): Promise<void>;
  };
  unitOfWork: {
    planDelivery(delivery: IntegrationDelivery, stream: IntegrationStream): Promise<void>;
  };
  snapshots: {
    evaluateReadiness(recordingId: string, policy: IntegrationDataPolicy): Promise<IntegrationReadinessEvaluation>;
    build(
      recordingId: string,
      policy: IntegrationDataPolicy,
      envelope: SnapshotEnvelope,
      currentSpeakerAliases?: readonly IntegrationSpeakerAlias[],
      incompleteRelease?: Extract<IntegrationReadiness['release'], 'manual' | 'timeout'>,
    ): Promise<BuiltSnapshot>;
  };
  isRecordingFinalized(recordingId: string): Promise<boolean>;
  eventTypePrefix: string;
  readyTimeoutMs?: number;
  now?: () => number;
};

export type IntegrationPlanResult =
  | { kind: 'noop' }
  | { kind: 'wait'; readyDeadlineAt: number }
  | { kind: 'planned'; delivery: IntegrationDelivery; body: string }
  /** Planned but not sendable as built (too large); parked for the user's Retry. */
  | { kind: 'action-required'; delivery: IntegrationDelivery };

/** Owns revision decisions above the durable delivery/dispatcher boundary. */
export class IntegrationEventPlanner {
  private readonly now: () => number;
  private readonly readyTimeoutMs: number;
  private readonly streamRuns = new Map<string, Promise<void>>();

  constructor(private readonly deps: PlannerDeps) {
    this.now = deps.now ?? Date.now;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? INTEGRATION_READY_TIMEOUT_MS;
  }

  planManual(destination: IntegrationDestination, recordingId: string): Promise<IntegrationPlanResult> {
    return this.serialized(destination.id, recordingId, async () => {
      const current = await this.deps.streams.get(destination.id, recordingId);
      return await this.planSnapshot({
        destination,
        recordingId,
        allowedPolicy: destination.dataPolicy,
        effectivePolicy: destination.dataPolicy,
        current,
        incompleteRelease: 'manual',
        compareProjection: false,
      });
    });
  }

  consider(destinationId: string, recordingId: string): Promise<IntegrationPlanResult> {
    return this.serialized(destinationId, recordingId, async () => {
      const [destination, routing, current, finalized] = await Promise.all([
        this.deps.destinations.get(destinationId),
        this.deps.routing.get(recordingId),
        this.deps.streams.get(destinationId, recordingId),
        this.deps.isRecordingFinalized(recordingId),
      ]);
      if (!destination?.enabled || !routing || !finalized) {
        await this.clearReadyDeadline(current);
        return { kind: 'noop' };
      }
      const intent = activeAutomaticIntent(routing, destinationId, current);
      if (!intent || intent.connectionVersion !== destination.connectionVersion) {
        await this.clearReadyDeadline(current);
        return { kind: 'noop' };
      }

      const effectivePolicy = intersectIntegrationPolicy(intent.allowedPolicy, destination.dataPolicy);
      // Only the first send waits for pending data. Once a destination has the
      // recording, each change goes out as it lands; the data still pending is
      // named in the readiness block, and arrives as its own update.
      const readiness = current?.readyCreated
        ? undefined
        : await this.deps.snapshots.evaluateReadiness(recordingId, effectivePolicy);
      if (readiness && !readiness.complete) {
        const deadline = current?.readyDeadlineAt ?? (this.now() + this.readyTimeoutMs);
        if (deadline > this.now()) {
          const stream = current ?? createStream(destinationId, recordingId);
          if (stream.readyDeadlineAt !== deadline) {
            await this.deps.streams.put({ ...stream, readyDeadlineAt: deadline });
          }
          return { kind: 'wait', readyDeadlineAt: deadline };
        }
      }

      return await this.planSnapshot({
        destination,
        recordingId,
        allowedPolicy: intent.allowedPolicy,
        effectivePolicy,
        current,
        incompleteRelease: 'timeout',
        compareProjection: true,
      });
    });
  }

  private async planSnapshot(input: {
    destination: IntegrationDestination;
    recordingId: string;
    allowedPolicy: IntegrationDataPolicy;
    effectivePolicy: IntegrationDataPolicy;
    current?: IntegrationStream;
    incompleteRelease: 'manual' | 'timeout';
    compareProjection: boolean;
  }): Promise<IntegrationPlanResult> {
    const stream = input.current ?? createStream(input.destination.id, input.recordingId);
    const eventTime = this.now();
    const eventKind = stream.readyCreated ? 'recording.updated.v1' : 'recording.ready.v1';
    const eventId = createIntegrationId('event');
    const revision = stream.nextRevision;
    const snapshot = await this.deps.snapshots.build(
      input.recordingId,
      input.effectivePolicy,
      {
        eventTypePrefix: this.deps.eventTypePrefix,
        eventKind,
        eventId,
        eventTime,
        producerId: input.destination.producerId,
        externalRecordingId: stream.externalRecordingId,
        revision,
      },
      stream.speakerAliases,
      input.incompleteRelease,
    );
    let oversized = false;
    try {
      assertIntegrationPayloadWithinLimit(snapshot, INTEGRATION_MAX_PAYLOAD_BYTES);
    } catch (error) {
      // A manual send tells the person at once. An automatic one parks the
      // snapshot where Retry can reach it: thrown, it kept a passed deadline
      // and was rebuilt on every wake-up (ADR-0008 §40: no blind retries).
      if (!(error instanceof IntegrationPayloadTooLargeError) || !input.compareProjection) throw error;
      oversized = true;
    }
    const projectionHash = await integrationProjectionHash(snapshot.body);
    if (input.compareProjection && stream.lastPlannedProjectionHash === projectionHash) {
      if (stream.readyDeadlineAt != null) {
        const { readyDeadlineAt: _dropped, ...withoutDeadline } = stream;
        await this.deps.streams.put(withoutDeadline);
      }
      return { kind: 'noop' };
    }

    const delivery: IntegrationDelivery = {
      id: createIntegrationId('delivery'),
      destinationId: input.destination.id,
      recordingId: input.recordingId,
      externalRecordingId: stream.externalRecordingId,
      eventId,
      eventType: eventKind,
      revision,
      eventTime,
      connectionVersion: input.destination.connectionVersion,
      allowedPolicy: { ...input.allowedPolicy },
      readinessRelease: snapshot.readiness.release,
      state: oversized ? 'action-required' : 'pending',
      attemptCount: 0,
      ...(oversized ? { lastErrorCode: 'payload-too-large' } : { nextAttemptAt: eventTime }),
      bodyHash: await sha256Hex(snapshot.body),
      totalBytes: snapshot.totalBytes,
      transcriptBytes: snapshot.transcriptBytes,
      createdAt: eventTime,
      updatedAt: eventTime,
    };
    const nextStream: IntegrationStream = {
      destinationId: stream.destinationId,
      recordingId: stream.recordingId,
      externalRecordingId: stream.externalRecordingId,
      nextRevision: revision + 1,
      readyCreated: true,
      everAttempted: true,
      lastPlannedProjectionHash: projectionHash,
      ...((snapshot.speakerAliases?.length || stream.speakerAliases?.length)
        ? { speakerAliases: snapshot.speakerAliases ?? stream.speakerAliases }
        : {}),
    };
    await this.deps.unitOfWork.planDelivery(delivery, nextStream);
    if (oversized) return { kind: 'action-required', delivery };
    return { kind: 'planned', delivery, body: snapshot.body };
  }

  private serialized<T>(destinationId: string, recordingId: string, run: () => Promise<T>): Promise<T> {
    const key = `${destinationId}\u0000${recordingId}`;
    const prior = this.streamRuns.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.catch(() => {}).then(() => gate);
    this.streamRuns.set(key, queued);
    return prior.catch(() => {}).then(run).finally(() => {
      release();
      if (this.streamRuns.get(key) === queued) this.streamRuns.delete(key);
    });
  }

  private async clearReadyDeadline(stream: IntegrationStream | undefined): Promise<void> {
    if (stream?.readyDeadlineAt == null) return;
    const { readyDeadlineAt: _dropped, ...withoutDeadline } = stream;
    await this.deps.streams.put(withoutDeadline);
  }
}

function createStream(destinationId: string, recordingId: string): IntegrationStream {
  return {
    destinationId,
    recordingId,
    externalRecordingId: createIntegrationId('recording'),
    nextRevision: 1,
    readyCreated: false,
    everAttempted: false,
  };
}

function activeAutomaticIntent(
  routing: RecordingIntegrationIntent,
  destinationId: string,
  stream: IntegrationStream | undefined,
): RecordingIntegrationIntentDestination | undefined {
  const intent = routing.destinations.find((candidate) => candidate.destinationId === destinationId);
  if (!intent) return undefined;
  if (intent.mode === 'auto') return intent.state === 'selected' ? intent : undefined;
  // REVIEW approval may release its first snapshot. Later revision approval is Phase 8.
  if (intent.mode === 'review' && intent.state === 'approved' && !stream?.readyCreated) return intent;
  return undefined;
}
