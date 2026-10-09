import type { RecordingDestinationRoute } from '../shared/recordingDestinations';
import { createIntegrationId } from './ids';
import type {
  IntegrationDestination,
  IntegrationStream,
  RecordingIntegrationIntent,
  RecordingIntegrationIntentDestination,
} from './persistence';

/** How one data route of a recording looks to the person deciding about it. */
export type RecordingRouteState =
  /** Written at Start; nothing leaves the browser until the save is confirmed. */
  | 'held'
  /** Confirmed; the planner and dispatcher own it from here. */
  | 'released'
  /** Removed for this recording only. */
  | 'skipped'
  /** The destination picked at Start, but no intent was written for it. */
  | 'not-scheduled';

export type RecordingRouteView = {
  destinationId: string;
  /** Null when the destination no longer exists. */
  destinationName: string | null;
  state: RecordingRouteState;
  /** True only when video/audio was explicitly authorized at recording Start. */
  includesMedia?: true;
};

export type RecordingRouteDecision = {
  destinationId: string;
  action: 'release' | 'skip';
};

export type RecordingRouteCandidate = {
  destinationId: string;
  destinationName: string;
  includesMedia?: true;
};

export type RecordingRouteChangeResult = 'changed' | 'stale' | 'unavailable';

/** Candidate for upload; the caller must also prove the OPFS artifact is sealed and owned. */
export type AuthorizedMediaRoute = {
  destinationId: string;
  externalRecordingId: string;
  connectionVersion: number;
  receiver: NonNullable<RecordingIntegrationIntentDestination['mediaAuthorization']>;
};

function sameOrigins(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((origin, index) => origin === right[index]);
}

export type RecordingRoutingBeginResult = {
  scheduled: string[];
  /** Routes whose destination is missing or disabled; nothing was written for them. */
  unavailable: string[];
};

type Deps = {
  destinations: { get(id: string): Promise<IntegrationDestination | undefined> };
  routing: {
    get(recordingId: string): Promise<RecordingIntegrationIntent | undefined>;
    list(): Promise<RecordingIntegrationIntent[]>;
  };
  streams: { get(destinationId: string, recordingId: string): Promise<IntegrationStream | undefined> };
  unitOfWork: {
    beginRecordingRouting(
      recordingId: string,
      entries: RecordingIntegrationIntentDestination[],
      streams: IntegrationStream[],
    ): Promise<string[]>;
    confirmRecordingRouting(recordingId: string, decisions: readonly RecordingRouteDecision[]): Promise<boolean>;
    changeRecordingRouting(
      recordingId: string,
      fromDestinationId: string | undefined,
      entry: RecordingIntegrationIntentDestination,
      stream: IntegrationStream,
    ): Promise<RecordingRouteChangeResult>;
    forgetRecordingRouting(recordingId: string, updatedAt: number): Promise<void>;
  };
  /** Hands a recording to the planner after its routing changed. */
  consider(recordingId: string): Promise<void>;
  now?: () => number;
};

/**
 * The per-recording routing decided by the "Save to" destination: written when
 * the recording starts, held until the end dialog confirms the save, and
 * forgotten when the recording is discarded or removed. Everything after the
 * confirmation is the existing planner's job.
 */
export class RecordingRoutingService {
  private readonly now: () => number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
  }

  async begin(
    recordingId: string,
    routes: readonly RecordingDestinationRoute[],
    /** Retries at the end of capture must never acquire media permission retroactively. */
    allowMediaAuthorization = true,
  ): Promise<RecordingRoutingBeginResult> {
    const unavailable: string[] = [];
    const entries: RecordingIntegrationIntentDestination[] = [];
    for (const route of routes) {
      const destination = await this.deps.destinations.get(route.destinationId);
      if (!destination?.enabled || route.mode !== 'auto') {
        unavailable.push(route.destinationId);
        continue;
      }
      entries.push(this.heldEntry(destination, allowMediaAuthorization));
    }
    if (!entries.length) return { scheduled: [], unavailable };

    // Every candidate gets a fresh identity; the transaction keeps an existing one.
    const streams = entries.map((entry) => this.newStream(recordingId, entry.destinationId));
    const scheduled = await this.deps.unitOfWork.beginRecordingRouting(recordingId, entries, streams);
    return { scheduled, unavailable };
  }

  /** Only persisted Start consent, confirmation and the original stream can authorize media. */
  async authorizedMediaRoutes(recordingId: string): Promise<AuthorizedMediaRoute[]> {
    const intent = await this.deps.routing.get(recordingId);
    const authorized: AuthorizedMediaRoute[] = [];
    for (const entry of intent?.destinations ?? []) {
      if (entry.mode !== 'auto' || entry.state !== 'selected' || entry.releaseAfter || !entry.mediaAuthorization) continue;
      const [destination, stream] = await Promise.all([
        this.deps.destinations.get(entry.destinationId),
        this.deps.streams.get(entry.destinationId, recordingId),
      ]);
      if (!destination?.enabled || !destination.media || !stream ||
          entry.connectionVersion !== destination.connectionVersion ||
          entry.mediaAuthorization.producerId !== destination.producerId ||
          entry.mediaAuthorization.endpoint !== destination.endpoint ||
          entry.mediaAuthorization.apiBase !== destination.media.capability.apiBase ||
          !sameOrigins(entry.mediaAuthorization.uploadOrigins, destination.media.capability.upload.origins)) continue;
      authorized.push({
        destinationId: entry.destinationId,
        externalRecordingId: stream.externalRecordingId,
        connectionVersion: entry.connectionVersion,
        receiver: entry.mediaAuthorization,
      });
    }
    return authorized;
  }

  async confirm(recordingId: string, decisions: readonly RecordingRouteDecision[]): Promise<void> {
    if (await this.deps.unitOfWork.confirmRecordingRouting(recordingId, decisions)) {
      await this.deps.consider(recordingId);
    }
  }

  /**
   * Creates authorization only from an explicit end-dialog action. The new
   * receiver stays held until a later confirm decision releases it.
   */
  async change(
    recordingId: string,
    fromDestinationId: string | undefined,
    toDestinationId: string,
  ): Promise<RecordingRouteChangeResult> {
    const destination = await this.deps.destinations.get(toDestinationId);
    if (!destination?.enabled) return 'unavailable';
    return this.deps.unitOfWork.changeRecordingRouting(
      recordingId,
      fromDestinationId,
      this.heldEntry(destination, true, 'end-dialog'),
      this.newStream(recordingId, destination.id),
    );
  }

  /** Recordings with a route still waiting for its confirmation. */
  async held(): Promise<string[]> {
    return (await this.deps.routing.list())
      .filter((intent) => intent.destinations.some((entry) => entry.releaseAfter))
      .map((intent) => intent.recordingId);
  }

  forget(recordingId: string): Promise<void> {
    return this.deps.unitOfWork.forgetRecordingRouting(recordingId, this.now());
  }

  async routes(
    recordingId: string,
    expected: readonly RecordingDestinationRoute[] = [],
  ): Promise<RecordingRouteView[]> {
    const intent = await this.deps.routing.get(recordingId);
    const views: RecordingRouteView[] = [];
    for (const entry of intent?.destinations ?? []) {
      views.push({
        destinationId: entry.destinationId,
        destinationName: await this.nameOf(entry.destinationId),
        state: entry.releaseAfter ? 'held' : entry.state === 'skipped' ? 'skipped' : 'released',
        ...(entry.mediaAuthorization ? { includesMedia: true as const } : {}),
      });
    }
    for (const route of expected) {
      if (views.some((view) => view.destinationId === route.destinationId)) continue;
      views.push({
        destinationId: route.destinationId,
        destinationName: await this.nameOf(route.destinationId),
        state: 'not-scheduled',
      });
    }
    return views;
  }

  private async nameOf(destinationId: string): Promise<string | null> {
    return (await this.deps.destinations.get(destinationId))?.name ?? null;
  }

  private heldEntry(
    destination: IntegrationDestination,
    allowMediaAuthorization: boolean,
    selectionSource?: 'end-dialog',
  ): RecordingIntegrationIntentDestination {
    return {
      destinationId: destination.id,
      mode: 'auto',
      state: 'selected',
      allowedPolicy: { ...destination.dataPolicy },
      connectionVersion: destination.connectionVersion,
      ...(selectionSource ? { selectionSource } : {}),
      ...(allowMediaAuthorization && destination.media ? {
        mediaAuthorization: {
          producerId: destination.producerId,
          endpoint: destination.endpoint,
          apiBase: destination.media.capability.apiBase,
          uploadOrigins: [...destination.media.capability.upload.origins],
        },
      } : {}),
      releaseAfter: 'save-confirmed',
    };
  }

  private newStream(recordingId: string, destinationId: string): IntegrationStream {
    return {
      destinationId,
      recordingId,
      externalRecordingId: createIntegrationId('recording'),
      nextRevision: 1,
      readyCreated: false,
      everAttempted: false,
    };
  }
}
