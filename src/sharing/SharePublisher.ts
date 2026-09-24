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
import type { SharePublicationCoordinator } from './SharePublicationCoordinator';

export type SharePublisherDeps = {
  publications: Pick<SharePublicationCoordinator, 'publishNew'>
    & Partial<Pick<SharePublicationCoordinator, 'queueNew'>>;
  recordingBuilder?: PublishedManifestBuilderDeps;
  manifestBuilder?: ShareManifestBuilderDeps;
};

export type PublishShareResult = {
  manifest: PublishedPlaybackManifest;
  shareUrl: string;
};

export type QueuedShareResult = {
  manifest: PublishedPlaybackManifest;
  publication: import('./SharePublicationStore').SharePublication;
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

    const publication = await this.deps.publications.publishNew({ manifest, plans });
    if (publication.status !== 'active' || !publication.shareUrl) {
      throw new Error(`Share ${manifest.id} did not become active`);
    }
    return { manifest: publication.manifest, shareUrl: publication.shareUrl };
  }

  /**
   * Persists a publication and returns before network/upload work starts. The
   * offscreen runtime uses this seam so a page can close immediately after the
   * publish command while the durable coordinator continues independently.
   */
  async queue(
    recordings: readonly PublishedRecordingInput[],
    options: PublishRecordingOptions = {},
  ): Promise<QueuedShareResult> {
    if (recordings.length === 0) throw new Error('A share must contain at least one recording');
    if (!this.deps.publications.queueNew) throw new Error('This sharing runtime cannot queue publications');

    const plans = recordings.map((recording) =>
      buildPublishedRecording(recording, options, this.deps.recordingBuilder));
    const manifest = buildPublishedManifest(plans, this.deps.manifestBuilder);
    const publication = await this.deps.publications.queueNew({ manifest, plans });
    return { manifest: publication.manifest, publication };
  }
}
