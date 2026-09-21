import {
  activateTab,
  getCapturedTabs,
  getMediaStreamIdForTab,
  getTab,
} from '../../platform/chrome/tabs';
import { isE2ERealCaptureTabBuild } from '../../shared/build';
import { getPerfSettingsSnapshot } from '../../shared/perf';
import type { CommandResult } from '../../shared/protocol';
import { parseRunConfig } from '../../shared/recording';
import {
  loadRecorderRuntimeSettingsSnapshot,
  type RecorderRuntimeSettingsSnapshot,
} from '../../shared/settings';
import { createTelemetryId } from '../../shared/telemetry';
import type { OffscreenManager } from '../offscreen/OffscreenManager';
import type { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import { markCaptureStarted } from './unsavedCaptureFlag';
import type { RecordingSession } from './session/RecordingSession';

export type StartRecordingMessage = {
  type: 'START_RECORDING';
  tabId: unknown;
  runConfig: unknown;
};

type ResultFactory = {
  ok: () => CommandResult;
  fail: (error: string) => CommandResult;
};

export class RecordingStartCommands {
  constructor(
    private readonly deps: {
      L: {
        log: (...a: any[]) => void;
        warn: (...a: any[]) => void;
        error: (...a: any[]) => void;
      };
      offscreen: OffscreenManager;
      session: RecordingSession;
      telemetry?: TelemetryRuntime;
      result: ResultFactory;
    },
  ) {}

  async start(msg: StartRecordingMessage): Promise<CommandResult> {
    if (typeof msg.tabId !== 'number') return this.deps.result.fail('Missing tabId');
    const runConfig = parseRunConfig(msg.runConfig);
    if (!runConfig) {
      return this.deps.result.fail('Missing or invalid run configuration');
    }

    const conflict = await this.findTabCaptureConflict(msg.tabId);
    if (conflict) {
      return this.deps.result.fail(
        `This tab already has an active tab capture (${conflict.status}). Stop the existing capture and try again.`,
      );
    }

    const telemetryRunId = this.deps.telemetry?.start(runConfig) ?? createTelemetryId();
    let recorderSettings: RecorderRuntimeSettingsSnapshot;
    try {
      recorderSettings = await loadRecorderRuntimeSettingsSnapshot();
    } catch (error: any) {
      const message = `Failed to load recorder settings: ${error?.message || error}`;
      this.deps.L.error(message);
      this.deps.telemetry?.incident({
        kind: 'recording_start_failed',
        stage: 'settings_load',
        error,
      });
      return this.deps.result.fail(message);
    }

    if (runConfig.tabContentType && recorderSettings.tab?.output) {
      recorderSettings.tab.output.contentType = runConfig.tabContentType;
    }

    const meetingSlug = await this.resolveMeetingSlug(msg.tabId);
    const started = this.deps.session.start(runConfig, {
      targetTabId: msg.tabId,
      meetingSlug: meetingSlug || undefined,
    });
    this.deps.telemetry?.configureRun(
      telemetryRunId,
      runConfig,
      recorderSettings,
      started.epoch,
    );
    this.deps.telemetry?.context('capture_requested');
    void chrome.tabs.sendMessage(msg.tabId, {
      type: 'TELEMETRY_RUN',
      runId: telemetryRunId,
      enabled: this.deps.telemetry?.isEnabled() ?? false,
    }).catch(() => {});
    this.deps.L.log('Popup requested START_RECORDING for tabId', msg.tabId);

    let recorderRuntimeTabId: number | undefined;
    try {
      if (isE2ERealCaptureTabBuild()) {
        recorderRuntimeTabId = await this.deps.offscreen.ensureRecorderTabReady();
        this.deps.L.warn(
          'E2E real capture tab runtime selected before requesting the first stream ID',
        );
      } else {
        await this.deps.offscreen.ensureReady();
        this.deps.L.log('ensureReady() completed');
      }
    } catch (error: any) {
      return this.failStart(
        `Recording runtime not ready: ${error?.message || error}`,
        'runtime_ready',
        error,
      );
    }

    try {
      const streamId = await getMediaStreamIdForTab(msg.tabId);
      await markCaptureStarted();
      const response = await this.deps.offscreen.rpc<{ ok: boolean; error?: string }>({
        type: 'OFFSCREEN_START',
        streamId,
        meetingSlug,
        runConfig,
        recorderSettings,
        perfSettings: getPerfSettingsSnapshot(),
        historyId: started.historyId ?? '',
        telemetryRunId,
        epoch: started.epoch ?? 0,
      });
      await this.restoreTargetTab(msg.tabId, recorderRuntimeTabId);
      this.deps.L.log('rpc(OFFSCREEN_START) response', response);
      if (response?.ok) return this.deps.result.ok();

      const message = response?.error || 'Failed to start';
      return this.failStart(message, 'offscreen_start', new Error(message));
    } catch (error: any) {
      await this.restoreTargetTab(msg.tabId, recorderRuntimeTabId);
      this.deps.L.error('OFFSCREEN_START failed', error);
      return this.failStart(
        `OFFSCREEN_START failed: ${error?.message || error}`,
        'offscreen_rpc',
        error,
      );
    }
  }

  private failStart(
    message: string,
    stage: 'runtime_ready' | 'offscreen_start' | 'offscreen_rpc',
    error: unknown,
  ): CommandResult {
    this.deps.telemetry?.incident({ kind: 'recording_start_failed', stage, error });
    this.deps.session.fail(message);
    return this.deps.result.fail(message);
  }

  private async findTabCaptureConflict(
    tabId: number,
  ): Promise<chrome.tabCapture.CaptureInfo | null> {
    try {
      const captures = await getCapturedTabs();
      return captures.find((capture) =>
        capture.tabId === tabId
        && capture.status !== 'stopped'
        && capture.status !== 'error'
      ) ?? null;
    } catch (error) {
      this.deps.L.warn(
        'tabCapture.getCapturedTabs preflight failed; continuing without conflict check',
        error,
      );
      return null;
    }
  }

  private async restoreTargetTab(
    tabId: number,
    recorderRuntimeTabId?: number,
  ): Promise<void> {
    if (recorderRuntimeTabId == null) return;
    try {
      await activateTab(tabId);
    } catch (error) {
      this.deps.L.warn('Failed to restore the captured tab after stream acquisition', error);
    }
  }

  private async resolveMeetingSlug(tabId: number): Promise<string> {
    try {
      const tab = await getTab(tabId);
      if (!tab?.url) return '';
      const url = new URL(tab.url);
      if (url.hostname === 'meet.google.com') {
        const code = url.pathname.split('/').filter(Boolean).pop() ?? '';
        return code ? `meet-${code}` : '';
      }
      const titleSlug = tab.title ? sanitizeAsSlug(tab.title) : '';
      return titleSlug || sanitizeAsSlug(`${url.hostname}${url.pathname}`);
    } catch {
      return '';
    }
  }
}

function sanitizeAsSlug(text: string, maxLength = 48): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}
