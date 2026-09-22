/**
 * @file background/offscreen/OffscreenManager.ts
 *
 * Public facade for the offscreen data plane. Connection state, runtime hosting,
 * and inbound event bookkeeping live in focused collaborators while this class
 * preserves the background-facing API.
 */
import { hasOffscreenDocument } from '../../platform/chrome/offscreen';
import type { AnalysisJob } from '../../shared/analysis/job';
import type { AnalysisProvenance } from '../../shared/analysis/provenance';
import type { AnalysisConfig } from '../../shared/analysis/types';
import { makeLogger } from '../../shared/logger';
import type { BgToOffscreenRpc } from '../../shared/protocol';
import {
  isBusyPhase,
  isStoppablePhase,
  type RecordingPhase,
  type UploadJob,
} from '../../shared/recording';
import type { TranscriptSegment } from '../../shared/transcript';
import { OffscreenConnection } from './OffscreenConnection';
import {
  OffscreenEventRouter,
  type OffscreenAnalysisListener,
  type OffscreenAnalysisResultListener,
  type OffscreenSaveListener,
  type OffscreenStateListener,
  type OffscreenUploadListener,
} from './OffscreenEventRouter';
import { OffscreenHost } from './OffscreenHost';

const L = makeLogger('background');

export type {
  OffscreenAnalysisListener,
  OffscreenAnalysisResultListener,
  OffscreenSaveListener,
  OffscreenStateListener,
  OffscreenUploadListener,
} from './OffscreenEventRouter';

export class OffscreenManager {
  private readonly connection = new OffscreenConnection();
  private readonly host = new OffscreenHost(this.connection, L);
  private readonly events = new OffscreenEventRouter(this.host);

  private get port(): chrome.runtime.Port | null {
    return this.connection.currentPort;
  }

  get onStateChanged(): OffscreenStateListener | undefined {
    return this.events.onStateChanged;
  }

  set onStateChanged(listener: OffscreenStateListener | undefined) {
    this.events.onStateChanged = listener;
  }

  get onSaveRequested(): OffscreenSaveListener | undefined {
    return this.events.onSaveRequested;
  }

  set onSaveRequested(listener: OffscreenSaveListener | undefined) {
    this.events.onSaveRequested = listener;
  }

  get onUploadJobChanged(): OffscreenUploadListener | undefined {
    return this.events.onUploadJobChanged;
  }

  set onUploadJobChanged(listener: OffscreenUploadListener | undefined) {
    this.events.onUploadJobChanged = listener;
  }

  get onAnalysisJobChanged(): OffscreenAnalysisListener | undefined {
    return this.events.onAnalysisJobChanged;
  }

  set onAnalysisJobChanged(listener: OffscreenAnalysisListener | undefined) {
    this.events.onAnalysisJobChanged = listener;
  }

  get onAnalysisResult(): OffscreenAnalysisResultListener | undefined {
    return this.events.onAnalysisResult;
  }

  set onAnalysisResult(listener: OffscreenAnalysisResultListener | undefined) {
    this.events.onAnalysisResult = listener;
  }

  attachPort(port: chrome.runtime.Port): void {
    L.log('Offscreen connected');
    this.connection.attach(
      port,
      (message) => this.events.route(message),
      () => {
        L.warn('Offscreen disconnected');
        this.events.handleDisconnected();
      },
      () => this.host.isTransitioning(),
    );
  }

  hydratePhase(phase: RecordingPhase): void {
    this.events.hydratePhase(phase);
  }

  hydrateUploadJobs(jobs: UploadJob[] | undefined): void {
    this.events.hydrateUploadJobs(jobs);
  }

  releaseBufferedIngress(): void {
    this.events.releaseBufferedIngress();
  }

  getRecordingStatus(): RecordingPhase {
    return this.events.phase;
  }

  async ensureReady(): Promise<void> {
    await this.host.ensureReady();
  }

  async ensureRecorderTabReady(): Promise<number> {
    return this.host.ensureRecorderTabReady();
  }

  async closeForUpdate(): Promise<boolean> {
    const busy = isBusyPhase(this.events.phase) || this.events.hasBackgroundWork;
    return this.host.closeForUpdate(busy);
  }

  async rpc<TRes = any>(msg: BgToOffscreenRpc): Promise<TRes> {
    if (msg.type === 'OFFSCREEN_START') this.host.cancelRecorderTabCleanup();
    return this.connection.rpc<TRes>(msg);
  }

  async stopIfPossibleOnSuspend(epoch?: number): Promise<void> {
    try {
      if (this.port && epoch != null && isStoppablePhase(this.events.phase)) {
        await this.rpc({ type: 'OFFSCREEN_STOP', epoch });
      }
    } catch {}
    this.events.showIdleBadge();
  }

  async openRetained(key: string): Promise<string | undefined> {
    await this.ensureReady();
    const response = await this.rpc({ type: 'OFFSCREEN_OPEN_RETAINED', key }) as
      { ok?: boolean; blobUrl?: string } | undefined;
    return response?.ok ? response.blobUrl : undefined;
  }

  revokeBlobUrl(blobUrl: string, opfsFilename?: string): void {
    this.connection.post({ type: 'REVOKE_BLOB_URL', blobUrl, opfsFilename });
  }

  acknowledgeUploadState(jobId: string): void {
    this.connection.post({ type: 'OFFSCREEN_ACK_UPLOAD_STATE', jobId });
  }

  hydrateAnalysisJobs(jobs: AnalysisJob[] | undefined): void {
    this.events.hydrateAnalysisJobs(jobs);
  }

  hasActiveAnalysisJobs(): boolean {
    return this.events.hasActiveAnalysisJobs;
  }

  async refreshAnalysisWork(): Promise<boolean> {
    if (!this.host.hasRecorderTab() && !(await this.hasOffscreenContext())) {
      this.events.replaceAnalysisJobs([]);
      return false;
    }
    await this.ensureReady();
    const response = await this.rpc<{ ok: boolean; jobIds?: string[] }>({
      type: 'OFFSCREEN_LIST_ANALYSIS_WORK',
    });
    if (!response?.ok || !Array.isArray(response.jobIds)) {
      throw new Error('The offscreen document did not report its analysis work');
    }
    this.events.replaceAnalysisJobs(response.jobIds);
    return this.events.hasActiveAnalysisJobs;
  }

  async analyzeTranscript(
    historyId: string,
    transcript: TranscriptSegment[],
    config: AnalysisConfig,
    provenance: AnalysisProvenance,
  ): Promise<{ ok: boolean; jobId?: string; error?: string }> {
    return this.rpc({
      type: 'OFFSCREEN_ANALYZE_TRANSCRIPT',
      historyId,
      transcript,
      config,
      provenance,
    });
  }

  async cancelAnalysis(jobId: string): Promise<{ ok: boolean; error?: string }> {
    return this.rpc({ type: 'OFFSCREEN_CANCEL_ANALYSIS', jobId });
  }

  acknowledgeAnalysisState(jobId: string): void {
    this.events.acknowledgeAnalysis(jobId);
    this.connection.post({ type: 'OFFSCREEN_ACK_ANALYSIS_STATE', jobId });
  }

  private async hasOffscreenContext(): Promise<boolean> {
    return hasOffscreenDocument();
  }
}
