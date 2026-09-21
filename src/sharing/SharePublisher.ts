/**
 * @file sharing/SharePublisher.ts
 *
 * Owner-side publishing orchestration. The backend receives only the sanitized
 * public manifest; private storage identifiers remain confined to upload jobs.
 */

import type { PublishedPlaybackManifest } from '../shared/sharing';
import {
  buildPublishedManifest,
  buildPublishedRecording,
  type PublishedManifestBuilderDeps,
  type PublishedRecordingInput,
  type PublishRecordingOptions,
  type ShareManifestBuilderDeps,
} from './PublishedManifestBuilder';
import type { ShareUploadManager } from './ShareUploadManager';

export interface SharePublicationApi {
  createShare(manifest: PublishedPlaybackManifest): Promise<void>;
  finalizeShare(shareId: string): Promise<{ shareUrl: string }>;
}

export type SharePublisherDeps = {
  api: SharePublicationApi;
  uploads: Pick<ShareUploadManager, 'upload' | 'clearShare'>;
  recordingBuilder?: PublishedManifestBuilderDeps;
  manifestBuilder?: ShareManifestBuilderDeps;
};

export type PublishShareResult = {
  manifest: PublishedPlaybackManifest;
  shareUrl: string;
};

export class SharePublisher {
  constructor(private readonly deps: SharePublisherDeps) {}

  async publish(
    recordings: readonly PublishedRecordingInput[],
    options: PublishRecordingOptions = {},
  ): Promise<PublishShareResult> {
    if (recordings.length === 0) throw new Error('A share must contain at least one recording');

    const plans = recordings.map((recording) =>
      buildPublishedRecording(recording, options, this.deps.recordingBuilder));
    const manifest = buildPublishedManifest(plans, this.deps.manifestBuilder);

    // `manifest` is the only metadata object allowed to cross this boundary.
    await this.deps.api.createShare(structuredClone(manifest));
    await this.deps.uploads.upload(manifest.id, plans);
    const { shareUrl } = await this.deps.api.finalizeShare(manifest.id);
    await this.deps.uploads.clearShare(manifest.id);
    return { manifest, shareUrl };
  }
}
