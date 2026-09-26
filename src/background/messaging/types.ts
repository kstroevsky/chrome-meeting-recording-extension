import type { DriveLibraryCoordinator } from '../drive/DriveLibraryCoordinator';
import type { RootRenameResult } from '../drive/DriveRootFolder';
import type { RecordingAnalysisService } from '../library/analysis/RecordingAnalysisService';
import type { RecordingHistoryService } from '../library/history/RecordingHistoryService';
import type { RecordingNotationService } from '../library/notations/RecordingNotationService';
import type { RecordingTranscriptCapture } from '../library/transcript/RecordingTranscriptCapture';
import type { RecordingTranscriptService } from '../library/transcript/RecordingTranscriptService';
import type { CpuSampler } from '../observability/perf/CpuSampler';
import type { PerfDebugStore } from '../observability/perf/PerfDebugStore';
import type { TelemetryRuntime } from '../observability/telemetry/TelemetryRuntime';
import type { DrivePlaybackAuthLeaseManager } from '../playback/DrivePlaybackAuthLeaseManager';
import type { PlaybackLeaseManager } from '../playback/PlaybackLeaseManager';
import type { RecordingPlaybackService } from '../playback/RecordingPlaybackService';
import type { RecordingController } from '../recording/RecordingController';
import type { RecordingSession } from '../recording/session/RecordingSession';
import type { BackgroundSharingRuntime } from '../sharing/BackgroundSharingRuntime';
import type { BackgroundIntegrationRuntime } from '../integrations/BackgroundIntegrationRuntime';

export type MessageHandlersDeps = {
  L: {
    log: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
  session: RecordingSession;
  perfDebugStore: PerfDebugStore;
  controller: RecordingController;
  cpuSampler?: CpuSampler | null;
  history?: RecordingHistoryService;
  notations?: RecordingNotationService;
  transcripts?: RecordingTranscriptService;
  analyses?: RecordingAnalysisService;
  transcriptCapture?: RecordingTranscriptCapture;
  playback?: RecordingPlaybackService;
  playbackLeases?: PlaybackLeaseManager;
  /** Drive-side library work: artifact checks, filing, sync. */
  driveLibrary?: DriveLibraryCoordinator;
  fileToDestination?: (
    recordingId: string,
    presetId: string | null,
  ) => Promise<void>;
  renameDriveRootFolder?: (
    from: string,
    to: string,
  ) => Promise<RootRenameResult>;
  listUnsavedRecordings?: () => Promise<
    import('../../offscreen/storage/recoverOrphanRecordings').UnsavedRecording[]
  >;
  resolveUnsavedRecording?: (
    key: string,
    action: 'save' | 'discard',
    name?: string,
  ) => Promise<void>;
  storageUsage?: () => Promise<import('../../shared/playback').StorageUsage>;
  listPendingLocal?: () => Promise<{ id: string; name: string }[]>;
  deliverLocal?: (recordingId: string, folderId: string | null) => Promise<void>;
  driveAuthLease?: DrivePlaybackAuthLeaseManager;
  telemetry?: TelemetryRuntime;
  sharing?: BackgroundSharingRuntime;
  integrations?: BackgroundIntegrationRuntime;
  /** E2E-only probe for real offscreen analysis work; never routed in production builds. */
  e2eAnalysisWork?: () => Promise<boolean>;
  waitUntilReady?: () => Promise<void>;
};

export type RuntimeSendResponse = (response?: unknown) => void;
