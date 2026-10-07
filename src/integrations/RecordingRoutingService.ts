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
};

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
  unitOfWork: {
    beginRecordingRouting(
      recordingId: string,
      entries: RecordingIntegrationIntentDestination[],
      streams: IntegrationStream[],
    ): Promise<string[]>;
    confirmRecordingRouting(recordingId: string, removedDestinationIds: readonly string[]): Promise<boolean>;
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
  ): Promise<RecordingRoutingBeginResult> {
    const scheduled: string[] = [];
    const unavailable: string[] = [];
    const entries: RecordingIntegrationIntentDestination[] = [];
    for (const route of routes) {
      const destination = await this.deps.destinations.get(route.destinationId);
      if (!destination?.enabled || route.mode !== 'auto') {
        unavailable.push(route.destinationId);
        continue;
      }
      entries.push({
        destinationId: destination.id,
        mode: 'auto',
        state: 'selected',
        allowedPolicy: { ...destination.dataPolicy },
        connectionVersion: destination.connectionVersion,
        releaseAfter: 'save-confirmed',
      });
      scheduled.push(destination.id);
    }
    if (!entries.length) return { scheduled, unavailable };

    // Every candidate gets a fresh identity; the transaction keeps an existing one.
    const streams: IntegrationStream[] = entries.map((entry) => ({
      destinationId: entry.destinationId,
      recordingId,
      externalRecordingId: createIntegrationId('recording'),
      nextRevision: 1,
      readyCreated: false,
      everAttempted: false,
    }));
    await this.deps.unitOfWork.beginRecordingRouting(recordingId, entries, streams);
    return { scheduled, unavailable };
  }

  async confirm(recordingId: string, removedDestinationIds: readonly string[]): Promise<void> {
    if (await this.deps.unitOfWork.confirmRecordingRouting(recordingId, removedDestinationIds)) {
      await this.deps.consider(recordingId);
    }
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
}
