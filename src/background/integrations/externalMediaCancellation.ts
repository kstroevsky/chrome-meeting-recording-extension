import type { OffscreenManager } from '../offscreen/OffscreenManager';

export type ExternalMediaCancelFilter = {
  recordingId?: string;
  destinationId?: string;
  clientTransferId?: string;
};

export async function sendExternalMediaCancel(
  offscreen: OffscreenManager,
  filter: ExternalMediaCancelFilter,
): Promise<void> {
  await offscreen.ensureReady();
  const response = await offscreen.rpc<{ ok: boolean; error?: string }>({
    type: 'OFFSCREEN_MEDIA_CANCEL',
    ...filter,
  });
  if (!response?.ok) throw new Error(response?.error || 'External media cancellation failed');
}
