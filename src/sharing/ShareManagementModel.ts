import type { RecordingStream } from '../shared/recording';
import type { SharePublicationStatus } from './SharePublicationStore';
import type { ShareRuntimeSnapshot } from './ShareRuntime';

export type ManagedShareTrack = {
  id: string;
  recordingTitle: string;
  stream: RecordingStream;
  bytes?: number;
  uploadedBytes: number;
  status: 'pending' | 'uploading' | 'retrying' | 'resuming' | 'failed' | 'completed';
};

export type ManagedShare = {
  id: string;
  createdAt: number;
  updatedAt: number;
  recordingTitles: string[];
  sourceRecordingIds: string[];
  status: SharePublicationStatus;
  phaseLabel: string;
  shareUrl?: string;
  error?: string;
  tracks: ManagedShareTrack[];
  trackCount: number;
  uploadedBytes: number;
  totalBytes?: number;
  percent?: number;
  resumable: boolean;
};

/** Combines the server registry with local durable publication/upload state. */
export function managedShares(snapshot: ShareRuntimeSnapshot): ManagedShare[] {
  const remoteById = new Map(snapshot.remote.map((share) => [share.id, share]));
  const localById = new Map(snapshot.local.map((share) => [share.id, share]));
  const ids = new Set([...remoteById.keys(), ...localById.keys()]);

  return [...ids].map((id): ManagedShare | null => {
    const remote = remoteById.get(id);
    const local = localById.get(id);
    const manifest = local?.manifest;
    if (!manifest && !remote) return null;
    const jobs = snapshot.uploads.filter((job) => job.shareId === id);
    const jobByTrack = new Map(jobs.map((job) => [`${job.recordingId}:${job.trackId}`, job]));
    const terminalActive = local?.status === 'active' || (!local && remote?.status === 'active');

    const tracks: ManagedShareTrack[] = manifest ? manifest.recordings.flatMap((recording) =>
      recording.tracks.map((track) => {
        const job = jobByTrack.get(`${recording.id}:${track.id}`);
        const bytes = job?.bytes ?? track.bytes;
        const completed = job?.status === 'completed' || (terminalActive && !job);
        return {
          id: track.id,
          recordingTitle: recording.title,
          stream: track.stream,
          ...(bytes != null ? { bytes } : {}),
          uploadedBytes: completed ? bytes ?? 0 : Math.min(job?.offset ?? 0, bytes ?? Number.MAX_SAFE_INTEGER),
          status: completed
            ? 'completed'
            : job?.status === 'failed'
              ? 'failed'
              : job?.activity === 'retrying'
                ? 'retrying'
                : job?.activity === 'resuming'
                  ? 'resuming'
                  : job?.status === 'uploading'
                    ? 'uploading'
                    : 'pending',
        };
      })) : [];

    const knownSizes = tracks.filter((track) => track.bytes != null);
    const totalBytes = manifest && knownSizes.length === tracks.length
      ? knownSizes.reduce((sum, track) => sum + (track.bytes ?? 0), 0)
      : undefined;
    const uploadedBytes = tracks.reduce((sum, track) => sum + track.uploadedBytes, 0);
    const status = local?.status ?? remoteStatus(remote?.status);

    return {
      id,
      createdAt: local?.createdAt ?? remote?.createdAt ?? manifest!.createdAt,
      updatedAt: Math.max(local?.updatedAt ?? 0, remote?.updatedAt ?? 0, manifest?.createdAt ?? 0),
      recordingTitles: manifest?.recordings.map((recording) => recording.title) ?? remote?.recordingTitles ?? [],
      sourceRecordingIds: local?.sourceRecordingIds ?? [],
      status,
      phaseLabel: phaseLabel(status, local?.resumeFrom, jobs),
      ...(local?.shareUrl ?? remote?.shareUrl ? { shareUrl: local?.shareUrl ?? remote?.shareUrl } : {}),
      ...(local?.error ? { error: local.error } : {}),
      tracks,
      trackCount: manifest ? tracks.length : remote?.trackCount ?? 0,
      uploadedBytes,
      ...((totalBytes ?? remote?.totalBytes) != null ? {
        totalBytes: totalBytes ?? remote?.totalBytes,
      } : {}),
      ...(totalBytes != null ? {
        percent: totalBytes === 0 ? 100 : Math.min(100, Math.floor((uploadedBytes / totalBytes) * 100)),
      } : {}),
      resumable: Boolean(local && status !== 'active' && status !== 'revoked'),
    };
  }).filter((share): share is ManagedShare => share != null)
    .sort((left, right) => right.createdAt - left.createdAt);
}

function remoteStatus(status: 'draft' | 'uploading' | 'active' | 'revoked' | undefined): SharePublicationStatus {
  return status ?? 'failed';
}

function phaseLabel(
  status: SharePublicationStatus,
  resumeFrom: import('./SharePublicationStore').SharePublicationPhase | undefined,
  jobs: ShareRuntimeSnapshot['uploads'],
): string {
  if (status === 'active') return 'Active';
  if (status === 'revoked') return 'Revoked';
  if (status === 'revoking') return 'Revoking';
  if (status === 'finalizing') return 'Finalizing';
  if (status === 'draft') return 'Preparing · authenticating';
  if (status === 'failed') {
    if (resumeFrom === 'revoking') return 'Revoke failed';
    if (resumeFrom === 'finalizing') return 'Finalization failed · resumable';
    return 'Publishing failed · resumable';
  }
  if (jobs.some((job) => job.activity === 'retrying')) return 'Retrying';
  if (jobs.some((job) => job.activity === 'resuming' || (job.offset > 0 && job.status !== 'completed'))) return 'Resuming';
  return 'Uploading';
}
