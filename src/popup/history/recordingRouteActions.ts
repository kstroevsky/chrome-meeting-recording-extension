/**
 * @file popup/history/recordingRouteActions.ts
 *
 * The popup's side of the routes a recording started with (plan E7): what the
 * end dialog shows, its answer, and the retry for routing that failed at Start.
 * The background owns all of it; these are the messages, and nothing else.
 */

import { sendToBackground } from '../../shared/messages';
import type { RecordingNameDialogRoute } from '../RecordingNameDialog';
import type { RecordingRouteView } from '../../integrations/RecordingRoutingService';

export type HeldRecording = { recordingId: string; name: string; routes: RecordingNameDialogRoute[] };

export type RecordingRouteActions = {
  /** The routes still to decide about: held ones and ones that could not be scheduled. */
  routes(recordingId: string): Promise<RecordingNameDialogRoute[]>;
  retry(recordingId: string): Promise<RecordingNameDialogRoute[]>;
  /** The answer: every held route is released except the removed ones. */
  confirm(recordingId: string, removedDestinationIds: string[]): Promise<void>;
  /** Finished recordings whose routes were never confirmed, because no dialog asked. */
  held(): Promise<HeldRecording[]>;
};

/** Only what the dialog can act on; released and skipped routes are already decided. */
export function undecidedRoutes(routes: readonly RecordingRouteView[]): RecordingNameDialogRoute[] {
  return routes.flatMap((route) => route.state === 'held' || route.state === 'not-scheduled'
    ? [{ destinationId: route.destinationId, destinationName: route.destinationName, state: route.state,
      ...(route.includesMedia ? { includesMedia: true as const } : {}) }]
    : []);
}

export function backgroundRecordingRouteActions(): RecordingRouteActions {
  return {
    async routes(recordingId) {
      const response = await sendToBackground({ type: 'GET_RECORDING_ROUTES', recordingId });
      if (response.ok === false) throw new Error(response.error || 'Could not read where this recording goes');
      return undecidedRoutes(response.routes);
    },
    async retry(recordingId) {
      const response = await sendToBackground({ type: 'RETRY_RECORDING_ROUTING', recordingId });
      if (response.ok === false) throw new Error(response.error || 'Could not schedule the automation');
      return undecidedRoutes(response.routes);
    },
    async confirm(recordingId, removedDestinationIds) {
      const response = await sendToBackground({ type: 'CONFIRM_RECORDING_ROUTES', recordingId, removedDestinationIds });
      if (response.ok === false) throw new Error(response.error || 'Could not confirm where this recording goes');
    },
    async held() {
      const response = await sendToBackground({ type: 'LIST_HELD_RECORDING_ROUTES' });
      if (response.ok === false) throw new Error(response.error || 'Could not list recordings waiting to be sent');
      return response.recordings.map((recording) => ({ ...recording, routes: undecidedRoutes(recording.routes) }));
    },
  };
}
