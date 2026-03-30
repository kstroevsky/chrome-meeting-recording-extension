/**
 * @file offscreen/engine/RecorderEngineSetup.ts
 *
 * Stream acquisition and audio playback bridge helpers used during
 * recorder engine startup. Extracted from RecorderEngine to keep the facade
 * class under the 250-line budget.
 */

import { AudioPlaybackBridge, MixedAudioMixer } from '../RecorderAudio';
import { maybeGetMicStream } from '../RecorderCapture';
import { readStreamVideoMetrics } from '../RecorderVideoResizer';
import type { RecorderRuntimeSettingsSnapshot } from '../../shared/extensionSettings';
import { PERF_FLAGS } from '../../shared/perf';
import type { MicMode } from '../../shared/recording';
import type { RecorderEngineDeps } from './RecorderEngineTypes';

/** Logs the source stream dimensions for debugging and perf diagnostics. */
export function logStreamAcquired(stream: MediaStream, deps: RecorderEngineDeps): void {
  deps.log('tab source stream acquired:', readStreamVideoMetrics(stream));
}

/** Enables all audio tracks and optionally starts an audio playback bridge. */
export async function ensureAudiblePlayback(
  stream: MediaStream,
  deps: RecorderEngineDeps
): Promise<AudioPlaybackBridge | null> {
  const rawAudio = stream.getAudioTracks()[0];
  stream.getAudioTracks().forEach((t) => { try { t.enabled = true; } catch {} });

  if (!rawAudio) {
    deps.warn('WARNING: tab stream has NO audio track — tab recording will be silent');
    return null;
  }

  const settings = rawAudio.getSettings?.();
  const suppress = (settings as any)?.suppressLocalAudioPlayback;
  const shouldBridge = PERF_FLAGS.audioPlaybackBridgeMode === 'always'
    ? (suppress ?? true)
    : suppress === true;

  if (!shouldBridge) return null;

  const bridge = new AudioPlaybackBridge(deps);
  await bridge.start(rawAudio);
  return bridge;
}

/**
 * Sets up a MixedAudioMixer that combines tab and microphone audio into a
 * single stream for the tab MediaRecorder.
 */
export async function createMixedTabStream(
  baseStream: MediaStream,
  micStream: MediaStream,
  deps: RecorderEngineDeps
): Promise<{ mixer: MixedAudioMixer; stream: MediaStream }> {
  const mixer = new MixedAudioMixer(deps);
  const stream = await mixer.create(baseStream, micStream);
  return { mixer, stream };
}

/**
 * Acquires the mic stream required for mixed or separate mic modes.
 * Throws if the stream is unavailable or the run has become stale.
 */
export async function acquireMicStream(
  runId: number,
  currentRunId: () => number,
  currentState: () => string,
  micMode: MicMode,
  settings: RecorderRuntimeSettingsSnapshot,
  deps: RecorderEngineDeps
): Promise<MediaStream> {
  const mic = await maybeGetMicStream(micMode, settings.microphone, deps);
  if (!mic?.getAudioTracks().length) {
    throw new Error('Microphone stream is required for mixed microphone mode');
  }
  if (runId !== currentRunId() || currentState() === 'stopping' || currentState() === 'idle') {
    mic.getTracks().forEach((track) => track.stop());
    throw new Error('Microphone stream became stale before recording could start');
  }
  return mic;
}

/** Attaches a 'ended' listener on the first video track that stops all recorders. */
export function attachTabEndedHandler(
  stream: MediaStream,
  stopAll: () => void,
  log: (...a: any[]) => void
): void {
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    log('Video track ended');
    stopAll();
  });
}
