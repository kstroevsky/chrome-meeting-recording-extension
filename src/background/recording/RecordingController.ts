/**
 * Stable facade for recording commands. Concrete command groups keep lifecycle,
 * live device control, sidecar delivery, and notation ownership separate.
 */

import { toStatusView, type RecordingInputDevice, type RecordingInterruption } from '../../shared/recording';
import type { CommandResult, NotationResult } from '../../shared/protocol';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { RecordingNotationService } from '../library/notations/RecordingNotationService';
import type { RecordingTranscriptService } from '../library/transcript/RecordingTranscriptService';
import type { RecordingTranscriptCapture } from '../library/transcript/RecordingTranscriptCapture';
import type { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import type { RecordingSession } from './session/RecordingSession';
import { RecordingLifecycleCommands } from './RecordingLifecycleCommands';
import {
  RecordingStartCommands,
  type StartRecordingMessage,
} from './RecordingStartCommands';
import { RecordingDeviceCommands } from './RecordingDeviceCommands';
import { RecordingNotationCommands } from './RecordingNotationCommands';
import { RecordingSidecars } from './RecordingSidecars';

export type { StartRecordingMessage } from './RecordingStartCommands';

export type RecordingControllerDeps = {
  L: {
    log: (...a: any[]) => void;
    warn: (...a: any[]) => void;
    error: (...a: any[]) => void;
  };
  offscreen: OffscreenManager;
  session: RecordingSession;
  telemetry?: TelemetryRuntime;
  notations?: RecordingNotationService;
  transcripts?: RecordingTranscriptService;
  transcriptCapture?: RecordingTranscriptCapture;
};

export class RecordingController {
  private readonly starts: RecordingStartCommands;
  private readonly lifecycle: RecordingLifecycleCommands;
  private readonly devices: RecordingDeviceCommands;
  private readonly notations: RecordingNotationCommands;
  private lifecycleTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RecordingControllerDeps) {
    const result = {
      ok: () => this.ok(),
      fail: (error: string) => this.fail(error),
    };
    const sidecars = new RecordingSidecars({
      L: deps.L,
      session: deps.session,
      notations: deps.notations,
      transcripts: deps.transcripts,
    });
    this.starts = new RecordingStartCommands({
      L: deps.L,
      offscreen: deps.offscreen,
      session: deps.session,
      telemetry: deps.telemetry,
      result,
    });
    this.lifecycle = new RecordingLifecycleCommands({
      ...deps,
      sidecars,
      result,
    });
    this.devices = new RecordingDeviceCommands({
      L: deps.L,
      offscreen: deps.offscreen,
      session: deps.session,
      transcriptCapture: deps.transcriptCapture,
      result,
    });
    this.notations = new RecordingNotationCommands({
      L: deps.L,
      session: deps.session,
      notations: deps.notations,
    });
  }

  start(msg: StartRecordingMessage): Promise<CommandResult> {
    return this.serializeLifecycle(() => this.starts.start(msg));
  }

  stop(
    reason = 'user requested stop',
    interruption?: RecordingInterruption['reason'],
  ): Promise<CommandResult> {
    return this.serializeLifecycle(() => this.lifecycle.stop(reason, interruption));
  }

  discard(reason = 'user requested discard'): Promise<CommandResult> {
    return this.serializeLifecycle(() => this.lifecycle.discard(reason));
  }

  resumePendingFinalization(): Promise<CommandResult | null> {
    return this.serializeLifecycle(() => this.lifecycle.resumePendingFinalization());
  }

  retryUpload(jobId: string): Promise<CommandResult> {
    return this.devices.retryUpload(jobId);
  }

  cancelUpload(jobId: string): Promise<CommandResult> {
    return this.devices.cancelUpload(jobId);
  }

  setMicMuted(muted: boolean): Promise<CommandResult> {
    return this.devices.setMicMuted(muted);
  }

  setCameraMuted(muted: boolean): Promise<CommandResult> {
    return this.devices.setCameraMuted(muted);
  }

  setInputDevice(
    device: RecordingInputDevice,
    deviceId: string,
  ): Promise<CommandResult> {
    return this.devices.setInputDevice(device, deviceId);
  }

  setPaused(paused: boolean): Promise<CommandResult> {
    return this.devices.setPaused(paused);
  }

  markNotation(text?: string): Promise<NotationResult> {
    return this.notations.mark(text);
  }

  toggleNotation(): Promise<NotationResult> {
    return this.notations.toggle();
  }

  endNotation(id: string): Promise<NotationResult> {
    return this.notations.end(id);
  }

  private ok(): CommandResult {
    return { ok: true, session: toStatusView(this.deps.session.getSnapshot()) };
  }

  private fail(error: string): CommandResult {
    return {
      ok: false,
      error,
      session: toStatusView(this.deps.session.getSnapshot()),
    };
  }

  private serializeLifecycle<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.catch(() => {}).then(work);
    this.lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  }
}
