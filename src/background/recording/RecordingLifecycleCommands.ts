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
    let snapshot = this.deps.session.getSnapshot();
    if (snapshot.phase === 'stopping' && snapshot.finalization?.disposition === 'kept') {
      return this.finishKeptStop(
        snapshot.finalization.historyId,
        reason,
        snapshot.finalization.epoch,
      );
    }
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
    await this.deps.session.flush();
    snapshot = this.deps.session.getSnapshot();
    this.deps.L.log('Stopping recording:', reason);
    return this.finishKeptStop(
      historyId,
      reason,
      snapshot.finalization?.epoch ?? snapshot.epoch,
    );
  }

  async discard(reason = 'user requested discard'): Promise<CommandResult> {
    let snapshot = this.deps.session.getSnapshot();
    if (snapshot.phase === 'stopping') {
      if (snapshot.finalization?.disposition === 'discarded') {
        return this.finishDiscard(snapshot.historyId, reason, snapshot);
      }
      return this.deps.result.fail('Discard cannot replace a stop that is already finalizing');
    }
    if (!isStoppablePhase(snapshot.phase)) {
      return this.deps.result.fail(
        'Discard requested but no recording session is active',
      );
    }

    const { historyId } = snapshot;
    this.deps.session.markStopping(undefined, 'discarded');
    await this.deps.session.flush();
    snapshot = this.deps.session.getSnapshot();
    this.deps.L.log('Discarding recording:', reason);
    return this.finishDiscard(historyId, reason, snapshot);
  }

  async resumePendingFinalization(): Promise<CommandResult | null> {
    const snapshot = this.deps.session.getSnapshot();
    const finalization = snapshot.finalization;
    if (!finalization) return null;
    if (
      snapshot.phase === 'idle'
      && finalization.disposition === 'discarded'
      && !finalization.backgroundFinalized
    ) {
      const cleaned = await this.finalizeDiscardBackground(
        finalization.historyId,
        finalization.epoch,
      );
      return cleaned
        ? this.deps.result.ok()
        : this.deps.result.fail('Discard cleanup is still pending');
    }
    if (snapshot.phase !== 'stopping') return null;
    return finalization.disposition === 'discarded'
      ? this.finishDiscard(finalization.historyId, 'resume after service-worker restart', snapshot)
      : this.finishKeptStop(
          finalization.historyId,
          'resume after service-worker restart',
          finalization.epoch,
        );
  }

  private async finalizeKeptBackground(historyId: string): Promise<void> {
    const finalization = this.deps.session.getSnapshot().finalization;
    if (finalization?.historyId !== historyId || finalization.backgroundFinalized) return;
    await this.deps.transcriptCapture?.finish(historyId)
      .catch((error) => this.deps.L.warn('Could not finish transcript capture:', error));
    await this.deps.notations?.closeOpenSpans(historyId, finalization.durationMs)
      .catch((error) => this.deps.L.warn('Could not close open notations:', error));
    this.deps.session.markBackgroundFinalized(historyId);
    await this.deps.session.flush();
  }

  private async finishKeptStop(
    historyId: string | undefined,
    reason: string,
    epoch: number | undefined,
  ): Promise<CommandResult> {
    if (historyId) await this.finalizeKeptBackground(historyId);

    const [notesSidecar, transcriptSidecar, driveRootFolderName] = await Promise.all([
      this.deps.sidecars.notes(historyId),
      this.deps.sidecars.transcript(historyId),
      this.deps.sidecars.driveRootFolderName(),
    ]);

    try {
      await this.deps.offscreen.ensureReady();
      if (epoch == null) return this.deps.result.fail('Stop requested without a recording epoch');
      const response = await this.deps.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_STOP',
        epoch,
        ...(notesSidecar ? { notesSidecar } : {}),
        ...(transcriptSidecar ? { transcriptSidecar } : {}),
        ...(driveRootFolderName ? { driveRootFolderName } : {}),
      });
      if (!response?.ok) {
        const message = response?.error || 'Stop failed in offscreen';
        this.deps.session.fail(message);
        return this.deps.result.fail(message);
      }
      this.deps.L.log('Stop command completed:', reason);
      return this.deps.result.ok();
    } catch (error: any) {
      const message = `STOP outcome unknown: ${error?.message || error}`;
      this.deps.L.warn(message);
      return this.deps.result.fail(message);
    }
  }

  private async finalizeDiscardBackground(
    historyId: string,
    epoch: number | undefined,
  ): Promise<boolean> {
    await this.deps.transcriptCapture?.abandon(epoch)
      .catch((error) => this.deps.L.warn(
        'Could not disarm transcript capture for the discarded run:',
        error,
      ));

    let cleanupComplete = true;
    await this.deps.notations?.removeAll(historyId)
      .catch((error) => {
        cleanupComplete = false;
        this.deps.L.warn('Discarding recording notations failed:', error);
      });
    await this.deps.transcripts?.removeAll(historyId)
      .catch((error) => {
        cleanupComplete = false;
        this.deps.L.warn('Discarding recording transcript failed:', error);
      });

    if (cleanupComplete) {
      this.deps.session.markBackgroundFinalized(historyId);
      await this.deps.session.flush();
    }
    return cleanupComplete;
  }

  private async finishDiscard(
    historyId: string | undefined,
    reason: string,
    snapshot = this.deps.session.getSnapshot(),
  ): Promise<CommandResult> {
    const finalization = snapshot.finalization;
    if (historyId && finalization?.backgroundFinalized !== true) {
      await this.finalizeDiscardBackground(historyId, finalization?.epoch);
    }

    try {
      await this.deps.offscreen.ensureReady();
      const commandEpoch = finalization?.epoch ?? snapshot.epoch;
      if (commandEpoch == null) {
        return this.deps.result.fail('Discard requested without a recording epoch');
      }
      const response = await this.deps.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_DISCARD',
        epoch: commandEpoch,
      });
      if (!response?.ok) {
        const message = response?.error || 'Discard failed in offscreen';
        this.deps.session.fail(message);
        return this.deps.result.fail(message);
      }
      this.deps.L.log('Discard command completed:', reason);
      return this.deps.result.ok();
    } catch (error: any) {
      const message = `DISCARD outcome unknown: ${error?.message || error}`;
      this.deps.L.warn(message);
      return this.deps.result.fail(message);
    }
  }
}
