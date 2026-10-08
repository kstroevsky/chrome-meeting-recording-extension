import { getRuntimeId, getRuntimeUrl } from '../../platform/chrome/runtime';
import type { PopupToBg } from '../../shared/protocol';
import type { MessageHandlersDeps, RuntimeSendResponse } from './types';

function isExtensionPlayerSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== getRuntimeId()) return false;
  const url = sender.url ?? '';
  return url.startsWith(getRuntimeUrl('')) && url.includes('recordings.html');
}

export async function handlePlaybackMessage(
  msg: PopupToBg,
  sender: chrome.runtime.MessageSender,
  sendResponse: RuntimeSendResponse,
  deps: MessageHandlersDeps,
): Promise<boolean> {
  const { driveAuthLease, history, playback, playbackLeases } = deps;
  const driveArtifacts = deps.driveLibrary?.artifacts;

  if (msg.type === 'GET_RECORDING_PLAYBACK_MANIFEST') {
    if (!playback) throw new Error('Playback is unavailable');
    let manifest = await playback.getManifest(msg.recordingId);
    if (!manifest) {
      sendResponse({ ok: false, error: 'This recording is no longer available' });
      return true;
    }
    const readerTab = sender.tab?.id;
    if (readerTab != null && playbackLeases && isExtensionPlayerSender(sender)) {
      const keys = manifest.tracks.flatMap((track) => track.sources
        .filter((source) => source.kind === 'opfs')
        .map((source) => (source as { key: string }).key));
      await playbackLeases.acquire(readerTab, manifest.recordingId, keys);
      // Deletion may have tombstoned the row between the first read and lease
      // acquisition. Re-read after the lease is durable so we never hand a
      // player a manifest whose retained bytes were already allowed to vanish.
      manifest = await playback.getManifest(msg.recordingId);
      if (!manifest) {
        await playbackLeases.release(readerTab, msg.recordingId);
        sendResponse({ ok: false, error: 'This recording is no longer available' });
        return true;
      }
    }
    sendResponse({ ok: true, manifest });
    return true;
  }

  if (
    msg.type === 'PREPARE_RECORDING_PLAYBACK_SOURCE'
    || msg.type === 'REFRESH_RECORDING_PLAYBACK_SOURCE'
  ) {
    if (!driveAuthLease || !playback) throw new Error('Drive playback is unavailable');
    const tabId = sender.tab?.id;
    if (tabId == null || !isExtensionPlayerSender(sender)) {
      sendResponse({
        ok: false,
        error: 'Playback can only be prepared by an extension page',
      });
      return true;
    }

    const manifest = await playback.getManifest(msg.recordingId);
    const track = manifest?.tracks.find((candidate) => candidate.fileId === msg.fileId);
    const drive = track?.sources.find((source) => source.kind === 'drive');
    if (!drive || drive.kind !== 'drive') {
      sendResponse({ ok: false, error: 'This file has no Drive copy to stream' });
      return true;
    }

    let fileId = drive.fileId;
    if (driveArtifacts) {
      const state = await driveArtifacts.resolve({
        fileId,
        folderId: (await playback.getFolderId(msg.recordingId)) ?? undefined,
        filename: track!.filename,
        ...(track!.bytes != null ? { bytes: track!.bytes } : {}),
      });
      if (state.status === 'trashed') {
        sendResponse({
          ok: false,
          error: 'This file is in your Google Drive trash. Restore it to play the recording.',
        });
        return true;
      }
      if (state.status === 'missing') {
        sendResponse({ ok: false, error: 'This file is no longer in Google Drive.' });
        return true;
      }
      if (state.status === 'relinked') {
        fileId = state.fileId;
        await history?.recordArtifactLocation(
          msg.recordingId,
          msg.fileId,
          { kind: 'drive', fileId },
        );
      }
    }

    const url = await driveAuthLease.authorize(tabId, fileId, {
      refresh: msg.type === 'REFRESH_RECORDING_PLAYBACK_SOURCE',
    });
    sendResponse({ ok: true, url });
    return true;
  }

  return false;
}
