/**
 * @file shared/recordingDestinationPick.ts
 *
 * The "Save to" destination the user picked last (remember + confirm). It is a
 * preference, not routing: a remembered pick only preselects the popup list,
 * stays visible before Start, and is confirmed again when the recording ends.
 *
 * Kept outside the settings object so starting a recording never rewrites the
 * whole settings record (and never races the settings page saving it).
 */

import { getLocalStorageValues, setLocalStorageValues } from '../platform/chrome/storage';

export const RECORDING_DESTINATION_PICK_KEY = 'recordingDestinationPick';
const MAX_ID_LENGTH = 128;

export async function loadRememberedDestinationPick(): Promise<string | undefined> {
  const values = await getLocalStorageValues(RECORDING_DESTINATION_PICK_KEY);
  const value = values[RECORDING_DESTINATION_PICK_KEY];
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id && id.length <= MAX_ID_LENGTH ? id : undefined;
}

export async function rememberDestinationPick(profileId: string): Promise<void> {
  await setLocalStorageValues({ [RECORDING_DESTINATION_PICK_KEY]: profileId });
}
