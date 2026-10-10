import { containsHostPermission } from '../../platform/chrome/permissions';
import { loadRememberedDestinationPick, rememberDestinationPick } from '../../shared/recordingDestinationPick';
import { loadExtensionSettingsFromStorage, saveExtensionSettingsToStorage } from '../../shared/settings';
import type { BackgroundIntegrationRuntime } from '../integrations/BackgroundIntegrationRuntime';
import type { RecordingRoutingPort } from '../recording/recordingRoutingPorts';
import type { RecordingContext } from '../../shared/recordingContext';
import { RecordingDestinationsRuntime } from './RecordingDestinationsRuntime';

/** Builds the "Save to" owner and the routing port recording lifecycle code uses. */
export function createDestinationRuntime(
  integrations: BackgroundIntegrationRuntime,
  getRecordingContext: (recordingId: string) => Promise<RecordingContext | undefined>,
): {
  destinations: RecordingDestinationsRuntime;
  routing: RecordingRoutingPort;
} {
  const destinations = new RecordingDestinationsRuntime({
    loadSettings: loadExtensionSettingsFromStorage,
    saveSettings: saveExtensionSettingsToStorage,
    listIntegrationDestinations: () => integrations.listDestinations(),
    containsHostPermission,
    loadPick: loadRememberedDestinationPick,
    rememberPick: rememberDestinationPick,
    getRecordingContext,
  });
  return {
    destinations,
    routing: {
      begin: (recordingId, routes) => integrations.beginRecordingRouting(recordingId, routes),
      forget: (recordingId) => integrations.forgetRecordingRouting(recordingId),
    },
  };
}
