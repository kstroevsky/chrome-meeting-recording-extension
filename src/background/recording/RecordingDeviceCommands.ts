import { isStoppablePhase, type RecordingInputDevice } from '../../shared/recording';
import type { CommandResult } from '../../shared/protocol';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { RecordingTranscriptCapture } from '../library/transcript/RecordingTranscriptCapture';
import type { RecordingSession } from './session/RecordingSession';

type ResultFactory = {
  ok: () => CommandResult;
  fail: (error: string) => CommandResult;
};

export class RecordingDeviceCommands {
  constructor(
    private readonly deps: {
      L: { warn: (...a: any[]) => void };
      offscreen: OffscreenManager;
      session: RecordingSession;
      transcriptCapture?: RecordingTranscriptCapture;
      result: ResultFactory;
    },
  ) {}

  async retryUpload(jobId: string): Promise<CommandResult> {
    return this.simpleRpc(
      { type: 'OFFSCREEN_RETRY_UPLOAD', jobId },
      'Retry failed in offscreen',
      'RETRY_UPLOAD',
    );
  }

  async cancelUpload(jobId: string): Promise<CommandResult> {
    return this.simpleRpc(
      { type: 'OFFSCREEN_CANCEL_UPLOAD', jobId },
      'Cancel failed in offscreen',
      'CANCEL_UPLOAD',
    );
  }

  async setMicMuted(muted: boolean): Promise<CommandResult> {
    const snapshot = this.deps.session.getSnapshot();
    if (!isStoppablePhase(snapshot.phase)) {
      return this.deps.result.fail('Mic mute requested but no recording is active');
    }
    const micMode = snapshot.runConfig?.micMode;
    if (micMode !== 'mixed' && micMode !== 'separate') {
      return this.deps.result.fail('Mic mute requested but this recording has no microphone');
    }

    return this.liveToggle(
      { type: 'OFFSCREEN_SET_MIC_MUTED', muted },
      'Mic mute failed in offscreen',
      'SET_MIC_MUTED',
      () => this.deps.session.setMicMuted(muted),
    );
  }

  async setCameraMuted(muted: boolean): Promise<CommandResult> {
    const snapshot = this.deps.session.getSnapshot();
    if (!isStoppablePhase(snapshot.phase)) {
      return this.deps.result.fail('Camera hide requested but no recording is active');
    }
    if (snapshot.runConfig?.recordSelfVideo !== true) {
      return this.deps.result.fail('Camera hide requested but this recording has no camera');
    }

    return this.liveToggle(
      { type: 'OFFSCREEN_SET_CAMERA_MUTED', muted },
      'Camera hide failed in offscreen',
      'SET_CAMERA_MUTED',
      () => this.deps.session.setCameraMuted(muted),
    );
  }

  async setInputDevice(
    device: RecordingInputDevice,
    deviceId: string,
  ): Promise<CommandResult> {
    const snapshot = this.deps.session.getSnapshot();
    if (snapshot.phase !== 'recording') {
      return this.deps.result.fail('Input device can only be changed while recording');
    }
    if (device === 'microphone') {
      const micMode = snapshot.runConfig?.micMode;
      if (micMode !== 'mixed' && micMode !== 'separate') {
        return this.deps.result.fail('This recording has no microphone');
      }
    } else if (device === 'camera') {
      if (snapshot.runConfig?.recordSelfVideo !== true) {
        return this.deps.result.fail('This recording has no camera');
      }
    } else {
      return this.deps.result.fail('Invalid input device type');
    }
    if (typeof deviceId !== 'string' || !deviceId) {
      return this.deps.result.fail('Missing input device');
    }

    try {
      await this.deps.offscreen.ensureReady();
      const result = await this.deps.offscreen.rpc<{
        ok: boolean;
        label?: string;
        error?: string;
      }>({ type: 'OFFSCREEN_SET_INPUT_DEVICE', device, deviceId });
      if (!result?.ok || !result.label) {
        return this.deps.result.fail(
          result?.error || 'Input device change failed in offscreen',
        );
      }
      this.deps.session.setCapturedDevice(device, result.label);
      return this.deps.result.ok();
    } catch (error: any) {
      return this.deps.result.fail(
        `SET_INPUT_DEVICE failed: ${error?.message || error}`,
      );
    }
  }

  async setPaused(paused: boolean): Promise<CommandResult> {
    const snapshot = this.deps.session.getSnapshot();
    if (!isStoppablePhase(snapshot.phase)) {
      return this.deps.result.fail('Pause requested but no recording is active');
    }

    const result = await this.liveToggle(
      { type: 'OFFSCREEN_SET_PAUSED', paused },
      'Pause failed in offscreen',
      'SET_PAUSED',
      () => this.deps.session.setPaused(paused),
    );
    if (!result.ok || !paused || !snapshot.historyId) return result;

    void this.deps.transcriptCapture?.flushAtBoundary(snapshot.historyId)
      .catch((error) => this.deps.L.warn(
        'Could not flush captions at the pause boundary:',
        error,
      ));
    return result;
  }

  private async liveToggle(
    request: Record<string, unknown>,
    rejectedMessage: string,
    failurePrefix: string,
    apply: () => void,
  ): Promise<CommandResult> {
    try {
      await this.deps.offscreen.ensureReady();
      const response = await this.deps.offscreen.rpc<{ ok: boolean; error?: string }>(
        request as any,
      );
      if (!response?.ok) {
        return this.deps.result.fail(response?.error || rejectedMessage);
      }
      apply();
      return this.deps.result.ok();
    } catch (error: any) {
      return this.deps.result.fail(
        `${failurePrefix} failed: ${error?.message || error}`,
      );
    }
  }

  private async simpleRpc(
    request: Record<string, unknown>,
    rejectedMessage: string,
    failurePrefix: string,
  ): Promise<CommandResult> {
    try {
      await this.deps.offscreen.ensureReady();
      const response = await this.deps.offscreen.rpc<{ ok: boolean; error?: string }>(
        request as any,
      );
      if (!response?.ok) {
        return this.deps.result.fail(response?.error || rejectedMessage);
      }
      return this.deps.result.ok();
    } catch (error: any) {
      return this.deps.result.fail(
        `${failurePrefix} failed: ${error?.message || error}`,
      );
    }
  }
}
