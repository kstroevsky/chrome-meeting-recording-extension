/**
 * @file popup/history/recordingRouteActions.ts
 *
 * The popup's side of the routes a recording started with (plan E7): what the
 * end dialog shows, its answer, and the retry for routing that failed at Start.
 * The background owns all of it; these are the messages, and nothing else.
 */

import { sendToBackground } from '../../shared/messages';
import type { RecordingNameDialogRoute, RecordingNameDialogRouteCandidate } from '../RecordingNameDialog';
import type {
  RecordingRouteCandidate,
  RecordingRouteDecision,
  RecordingRouteView,
} from '../../integrations/RecordingRoutingService';

export type HeldRecording = { recordingId: string; name: string; routes: RecordingNameDialogRoute[] };
export type RecordingRouteEditorState = {
  items: RecordingNameDialogRoute[];
  candidates: RecordingNameDialogRouteCandidate[];
};

export type RecordingRouteActions = {
  /** The routes still to decide about: held ones and ones that could not be scheduled. */
  routes(recordingId: string): Promise<RecordingRouteEditorState>;
  retry(recordingId: string): Promise<RecordingNameDialogRoute[]>;
  change(
    recordingId: string,
    fromDestinationId: string | undefined,
    toDestinationId: string,
  ): Promise<RecordingRouteEditorState>;
  /** Applies only decisions for held routes this dialog actually observed. */
  confirm(recordingId: string, decisions: RecordingRouteDecision[]): Promise<void>;
  /** Finished recordings whose routes were never confirmed, because no dialog asked. */
  held(): Promise<HeldRecording[]>;
};

/** Only what the dialog can act on; released and skipped routes are already decided. */
export function undecidedRoutes(routes: readonly RecordingRouteView[]): RecordingNameDialogRoute[] {
  return routes.flatMap((route) => route.state === 'held' || route.state === 'not-scheduled'
    ? [{ destinationId: route.destinationId, destinationName: route.destinationName, state: route.state,
      ...(route.includesMedia ? { includesMedia: true as const } : {}),
      ...(route.mediaOnly ? { mediaOnly: true as const } : {}) }]
    : []);
}

function routeCandidates(candidates: readonly RecordingRouteCandidate[] | undefined): RecordingNameDialogRouteCandidate[] {
  return (candidates ?? []).map((candidate) => ({ ...candidate }));
}

export function backgroundRecordingRouteActions(): RecordingRouteActions {
  return {
    async routes(recordingId) {
      const response = await sendToBackground({ type: 'GET_RECORDING_ROUTES', recordingId });
      if (response.ok === false) throw new Error(response.error || 'Could not read where this recording goes');
      return { items: undecidedRoutes(response.routes), candidates: routeCandidates(response.candidates) };
    },
    async retry(recordingId) {
      const response = await sendToBackground({ type: 'RETRY_RECORDING_ROUTING', recordingId });
      if (response.ok === false) throw new Error(response.error || 'Could not schedule the automation');
      return undecidedRoutes(response.routes);
    },
    async change(recordingId, fromDestinationId, toDestinationId) {
      const response = await sendToBackground({
        type: 'CHANGE_RECORDING_ROUTE',
        recordingId,
        toDestinationId,
        ...(fromDestinationId ? { fromDestinationId } : {}),
      });
      if (response.ok === false) throw new Error(response.error || 'Could not change where this recording goes');
      return { items: undecidedRoutes(response.routes), candidates: routeCandidates(response.candidates) };
    },
    async confirm(recordingId, decisions) {
      const response = await sendToBackground({ type: 'CONFIRM_RECORDING_ROUTES', recordingId, decisions });
      if (response.ok === false) throw new Error(response.error || 'Could not confirm where this recording goes');
    },
    async held() {
      const response = await sendToBackground({ type: 'LIST_HELD_RECORDING_ROUTES' });
      if (response.ok === false) throw new Error(response.error || 'Could not list recordings waiting to be sent');
      return response.recordings.map((recording) => ({ ...recording, routes: undecidedRoutes(recording.routes) }));
    },
  };
}
