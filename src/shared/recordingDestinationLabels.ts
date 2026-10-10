/**
 * @file shared/recordingDestinationLabels.ts
 *
 * How a "Save to" destination is described wherever it is listed: the popup's
 * picker and the settings page say the same thing in the same words.
 */

import type { RecordingDestinationOption } from '../background/destinations/RecordingDestinationsRuntime';

const UNAVAILABLE_TEXT: Record<NonNullable<RecordingDestinationOption['unavailableReason']>, string> = {
  'destination-missing': 'Integration deleted · fix in Settings',
  'destination-disabled': 'Integration disabled · fix in Settings',
  'media-unavailable': 'Media upload unavailable · fix in Settings',
  'permission-missing': 'Needs site access · fix in Settings',
};

/** One line under the name: where files go and where data goes, or why it cannot be picked. */
export function describeDestination(option: RecordingDestinationOption): string {
  if (!option.available && option.unavailableReason) return UNAVAILABLE_TEXT[option.unavailableReason];
  const data = option.dataRoutes.map((route) => route.destinationName ?? 'deleted integration').join(', ');
  return data ? `Files: ${option.filesLabel} · Data: ${data}` : `Files: ${option.filesLabel}`;
}
