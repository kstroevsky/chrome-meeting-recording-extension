import {
  projectPhase,
  type DesiredState,
  type ObservedState,
  type RecordingInterruption,
  type RecordingRunConfig,
  type RecordingSessionSnapshot,
  type UploadJob,
  type UploadSummary,
} from '../../../shared/recording';
import type { OffscreenPhaseUpdate } from '../../../shared/protocol';
import { closeOpenSpan, elapsedRecordedMs, timerForPhase } from './RecordingClock';

export type RecordingTarget = {
  targetTabId: number;
  meetingSlug?: string;
};

export function startSession(
  snapshot: RecordingSessionSnapshot,
  runConfig: RecordingRunConfig,
  target: RecordingTarget | undefined,
  historyId: string,
  now: number,
): RecordingSessionSnapshot {
  const desired: DesiredState = 'recording';
  const observed: ObservedState = 'starting';
  const carriedUploads = snapshot.uploadJobs?.filter((job) => job.status === 'uploading');
  return {
    phase: projectPhase(desired, observed, false),
    desired,
    observed,
    failed: false,
    runConfig,
    targetTabId: target?.targetTabId,
    meetingSlug: target?.meetingSlug,
    historyId,
    interruption: undefined,
    warnings: undefined,
    epoch: (snapshot.epoch ?? 0) + 1,
    recordedSpans: undefined,
    finalization: undefined,
    uploadJobs: carriedUploads?.length ? carriedUploads : undefined,
    updatedAt: now,
  };
}

export function stoppingSession(
  snapshot: RecordingSessionSnapshot,
  interruption: RecordingInterruption | undefined,
  disposition: 'kept' | 'discarded',
  now: number,
): RecordingSessionSnapshot {
  const desired: DesiredState = 'idle';
  const observed = snapshot.observed ?? 'starting';
  const failed = snapshot.failed ?? false;
  const phase = projectPhase(desired, observed, failed);
  const durationMs = elapsedRecordedMs(snapshot, now);
  return {
    phase,
    desired,
    observed,
    failed,
    runConfig: snapshot.runConfig,
    targetTabId: snapshot.targetTabId,
    meetingSlug: snapshot.meetingSlug,
    historyId: snapshot.historyId,
    warnings: snapshot.warnings,
    micMuted: snapshot.micMuted,
    cameraMuted: snapshot.cameraMuted,
    paused: snapshot.paused,
    tabResolution: snapshot.tabResolution,
    capturedDevices: snapshot.capturedDevices,
    ...timerForPhase(snapshot, phase, now),
    epoch: snapshot.epoch,
    uploadJobs: snapshot.uploadJobs,
    interruption: interruption ?? snapshot.interruption,
    finalization: snapshot.historyId != null && snapshot.epoch != null
      ? {
          historyId: snapshot.historyId,
          epoch: snapshot.epoch,
          targetTabId: snapshot.targetTabId,
          durationMs,
          disposition,
        }
      : snapshot.finalization,
    updatedAt: now,
  };
}

export function idleSession(
  snapshot: RecordingSessionSnapshot,
  interruption: RecordingInterruption | undefined,
  uploadSummary: UploadSummary | undefined,
  warnings: string[] | undefined,
  closeAt: number,
  updatedAt: number,
): RecordingSessionSnapshot {
  return {
    phase: projectPhase('idle', 'idle', false),
    desired: 'idle',
    observed: 'idle',
    failed: false,
    runConfig: null,
    uploadSummary,
    warnings,
    epoch: snapshot.epoch,
    recordedSpans: closeOpenSpan(snapshot.recordedSpans, closeAt),
    finalization: snapshot.finalization,
    uploadJobs: snapshot.uploadJobs,
    interruption: interruption ?? snapshot.interruption,
    updatedAt,
  };
}

export function failedSession(
  snapshot: RecordingSessionSnapshot,
  error: string,
  now: number,
): RecordingSessionSnapshot {
  const desired = snapshot.desired ?? 'idle';
  const observed = snapshot.observed ?? 'starting';
  return {
    phase: projectPhase(desired, observed, true),
    desired,
    observed,
    failed: true,
    runConfig: snapshot.runConfig,
    targetTabId: snapshot.targetTabId,
    meetingSlug: snapshot.meetingSlug,
    historyId: snapshot.historyId,
    epoch: snapshot.epoch,
    error,
    warnings: snapshot.warnings,
    micMuted: snapshot.micMuted,
    cameraMuted: snapshot.cameraMuted,
    paused: snapshot.paused,
    tabResolution: snapshot.tabResolution,
    capturedDevices: snapshot.capturedDevices,
    recordedMs: elapsedRecordedMs(snapshot, now),
    runningSince: undefined,
    recordedSpans: closeOpenSpan(snapshot.recordedSpans, now),
    finalization: snapshot.finalization,
    uploadJobs: snapshot.uploadJobs,
    updatedAt: now,
  };
}

export function observedSession(
  snapshot: RecordingSessionSnapshot,
  update: OffscreenPhaseUpdate,
  now: number,
): RecordingSessionSnapshot {
  if (update.phase === 'idle' || update.phase === 'failed') {
    throw new Error(`Terminal offscreen phase must use its dedicated transition: ${update.phase}`);
  }
  const desired = snapshot.desired ?? 'idle';
  const failed = snapshot.failed ?? false;
  const observed: ObservedState = update.phase;
  const phase = projectPhase(desired, observed, failed);
  return {
    phase,
    desired,
    observed,
    failed,
    runConfig: snapshot.runConfig,
    targetTabId: snapshot.targetTabId,
    meetingSlug: snapshot.meetingSlug,
    historyId: snapshot.historyId,
    error: update.error,
    warnings: update.warnings,
    micMuted: snapshot.micMuted,
    cameraMuted: snapshot.cameraMuted,
    paused: snapshot.paused,
    tabResolution: update.tabResolution ?? snapshot.tabResolution,
    capturedDevices: update.capturedDevices ?? snapshot.capturedDevices,
    ...timerForPhase(snapshot, phase, now),
    uploadSummary: undefined,
    epoch: snapshot.epoch,
    uploadJobs: snapshot.uploadJobs,
    updatedAt: now,
  };
}

export function upsertUploadJob(
  snapshot: RecordingSessionSnapshot,
  job: UploadJob,
  now: number,
): RecordingSessionSnapshot {
  const existing = snapshot.uploadJobs ?? [];
  const next = existing.some((candidate) => candidate.id === job.id)
    ? existing.map((candidate) => (candidate.id === job.id ? job : candidate))
    : [...existing, job];
  return { ...snapshot, uploadJobs: next, updatedAt: now };
}

export function removeUploadJob(
  snapshot: RecordingSessionSnapshot,
  id: string,
  now: number,
): RecordingSessionSnapshot {
  const next = (snapshot.uploadJobs ?? []).filter((job) => job.id !== id);
  return {
    ...snapshot,
    uploadJobs: next.length ? next : undefined,
    updatedAt: now,
  };
}
