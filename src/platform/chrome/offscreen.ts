/**
 * @file platform/chrome/offscreen.ts
 *
 * Small wrappers around MV3 offscreen-document lifecycle APIs.
 */

import { getRuntimeUrl, trySendRuntimeMessage } from './runtime';

type OffscreenReason = 'BLOBS' | 'AUDIO_PLAYBACK' | 'USER_MEDIA';

export async function createOffscreenDocument(
  path: string,
  options: { reasons: OffscreenReason[]; justification: string }
): Promise<void> {
  await chrome.offscreen.createDocument({
    url: getRuntimeUrl(path),
    reasons: options.reasons as any,
    justification: options.justification,
  });
}

export async function requestOffscreenReconnect(): Promise<void> {
  await trySendRuntimeMessage({ type: 'OFFSCREEN_CONNECT' });
}

export async function hasOffscreenDocument(): Promise<boolean> {
  try {
    const getContexts = (chrome.runtime as any).getContexts as
      | ((q: { contextTypes: ('OFFSCREEN_DOCUMENT' | string)[] }) => Promise<any[]>)
      | undefined;

    if (getContexts) {
      const contexts = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
      return Array.isArray(contexts) && contexts.length > 0;
    }
  } catch {}

  try {
    return !!(await (chrome.offscreen as any).hasDocument?.());
  } catch {
    return false;
  }
}
