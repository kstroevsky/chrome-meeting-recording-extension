import { pokeRuntime } from '../../platform/chrome/runtime';
import { isBusyPhase, type RecordingPhase } from '../../shared/recording';

let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

/** Keeps the MV3 service worker alive while critical background work is active. */
export function startKeepAlive(): void {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => pokeRuntime(), 20_000);
}

/** Stops the keep-alive loop once no critical work remains. */
export function stopKeepAlive(): void {
  if (!keepAliveTimer) return;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/** True when a phase transition begins a fresh recording run. */
export function isFreshRecordingStart(
  previousPhase: RecordingPhase,
  nextPhase: RecordingPhase,
): boolean {
  return !isBusyPhase(previousPhase) && isBusyPhase(nextPhase);
}
