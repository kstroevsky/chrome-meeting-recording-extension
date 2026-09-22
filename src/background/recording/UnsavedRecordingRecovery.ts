import { loadExtensionSettingsFromStorage, toStorageMode } from '../../shared/settings';
import type { UnsavedRecording } from '../../offscreen/storage/recoverOrphanRecordings';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { RecordingSession } from './session/RecordingSession';
import {
  captureMayBeUnsaved,
  markCaptureSettled,
  recordedCaptureDurationMs,
} from './unsavedCaptureFlag';

type Logger = {
  warn: (...args: any[]) => void;
};

/** Crash-recovery commands for recorder staging files that never reached delivery. */
export class UnsavedRecordingRecovery {
  constructor(
    private readonly offscreen: OffscreenManager,
    private readonly session: RecordingSession,
    private readonly logger: Logger,
  ) {}

  async list(): Promise<UnsavedRecording[]> {
    if (!await captureMayBeUnsaved()) return [];
    if (this.session.getSnapshot().phase !== 'idle') return [];

    try {
      await this.offscreen.ensureReady();
      const response = await this.offscreen.rpc<{ ok: boolean; recordings?: UnsavedRecording[] }>({
        type: 'OFFSCREEN_LIST_UNSAVED',
      });
      const found = response?.recordings ?? [];
      const recordings = await Promise.all(found.map(async (recording) => {
        const recorded = await recordedCaptureDurationMs(recording.lastModifiedMs);
        return recorded != null ? { ...recording, approxDurationMs: recorded } : recording;
      }));
      if (!recordings.length) await markCaptureSettled();
      return recordings;
    } catch (error) {
      this.logger.warn('Could not look for unsaved recordings:', error);
      return [];
    }
  }

  async resolve(key: string, action: 'save' | 'discard', name?: string): Promise<void> {
    const settings = await loadExtensionSettingsFromStorage();
    await this.offscreen.ensureReady();
    const response = await this.offscreen.rpc<{ ok: boolean; error?: string }>({
      type: 'OFFSCREEN_RESOLVE_UNSAVED',
      key,
      action,
      ...(name ? { name } : {}),
      storageMode: toStorageMode(settings.basic.recordingMode),
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not save that recording');
    const remaining = await this.offscreen.rpc<{ ok: boolean; recordings?: UnsavedRecording[] }>({
      type: 'OFFSCREEN_LIST_UNSAVED',
    });
    if (remaining?.ok && (remaining.recordings?.length ?? 0) === 0) {
      await markCaptureSettled();
    }
  }
}
