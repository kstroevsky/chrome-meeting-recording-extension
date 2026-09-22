import { sendTabMessage } from '../../platform/chrome/tabs';
import type { CommandResult } from '../../shared/protocol';
import { isStoppablePhase, type RecordingInterruption } from '../../shared/recording';
import type { TelemetrySnapshot } from '../../shared/telemetry';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { RecordingNotationService } from '../library/notations/RecordingNotationService';
import type { RecordingTranscriptCapture } from '../library/transcript/RecordingTranscriptCapture';
import type { RecordingTranscriptService } from '../library/transcript/RecordingTranscriptService';
import type { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import type { RecordingSession } from './session/RecordingSession';
import type { RecordingSidecars } from './RecordingSidecars';

type ResultFactory = {
  ok: () => CommandResult;
  fail: (error: string) => CommandResult;
};

export class RecordingLifecycleCommands {
  constructor(
    private readonly deps: {
      L: { log: (...a: any[]) => void; warn: (...a: any[]) => void };
      offscreen: OffscreenManager;
      session: RecordingSession;
      telemetry?: TelemetryRuntime;
      notations?: RecordingNotationService;
      transcripts?: RecordingTranscriptService;
      transcriptCapture?: RecordingTranscriptCapture;
      sidecars: RecordingSidecars;
      result: ResultFactory;
    },
  ) {}

  async stop(
    reason = 'user requested stop',
    interruption?: RecordingInterruption['reason'],
  ): Promise<CommandResult> {
    const snapshot = this.deps.session.getSnapshot();
    if (!isStoppablePhase(snapshot.phase)) {
      return this.deps.result.fail('Stop requested but no recording session is active');
    }

    if (typeof snapshot.targetTabId === 'number') {
      try {
        const response = await sendTabMessage<{ snapshot?: TelemetrySnapshot }>(
          snapshot.targetTabId,
          { type: 'TELEMETRY_GET_SNAPSHOT' },
        );
        if (response?.snapshot) {
          await this.deps.telemetry?.receive(response.snapshot, true);
        }
      } catch {}
    }

    const { historyId } = snapshot;
    this.deps.session.markStopping(interruption);
    this.deps.L.log('Stopping recording:', reason);
    if (historyId) {
      await this.deps.transcriptCapture?.flushAtBoundary(historyId)
        .catch((error) => this.deps.L.warn(
          'Could not flush captions at the stop boundary:',
          error,
        ));
    }

    const [notesSidecar, transcriptSidecar, driveRootFolderName] = await Promise.all([
      this.deps.sidecars.notes(historyId),
      this.deps.sidecars.transcript(historyId),
      this.deps.sidecars.driveRootFolderName(),
    ]);

    try {
      await this.deps.offscreen.ensureReady();
      const response = await this.deps.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_STOP',
        ...(notesSidecar ? { notesSidecar } : {}),
        ...(transcriptSidecar ? { transcriptSidecar } : {}),
        ...(driveRootFolderName ? { driveRootFolderName } : {}),
      });
      if (!response?.ok) {
        const message = response?.error || 'Stop failed in offscreen';
        this.deps.session.fail(message);
        return this.deps.result.fail(message);
      }
      return this.deps.result.ok();
    } catch (error: any) {
      const message = `STOP failed: ${error?.message || error}`;
      this.deps.session.fail(message);
      return this.deps.result.fail(message);
    }
  }

  async discard(reason = 'user requested discard'): Promise<CommandResult> {
    const snapshot = this.deps.session.getSnapshot();
    if (!isStoppablePhase(snapshot.phase)) {
      return this.deps.result.fail(
        'Discard requested but no recording session is active',
      );
    }

    const { historyId } = snapshot;
    this.deps.session.markStopping(undefined, 'discarded');
    this.deps.L.log('Discarding recording:', reason);
    if (historyId) {
      await this.deps.notations?.removeAll(historyId)
        .catch((error) => this.deps.L.warn(
          'Discarding recording notations failed:',
          error,
        ));
      await this.deps.transcripts?.removeAll(historyId)
        .catch((error) => this.deps.L.warn(
          'Discarding recording transcript failed:',
          error,
        ));
    }

    try {
      await this.deps.offscreen.ensureReady();
      const response = await this.deps.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_DISCARD',
      });
      if (!response?.ok) {
        const message = response?.error || 'Discard failed in offscreen';
        this.deps.session.fail(message);
        return this.deps.result.fail(message);
      }
      return this.deps.result.ok();
    } catch (error: any) {
      const message = `DISCARD failed: ${error?.message || error}`;
      this.deps.session.fail(message);
      return this.deps.result.fail(message);
    }
  }
}
