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
  publications: Pick<SharePublicationCoordinator, 'publishNew'>;
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

    const publication = await this.deps.publications.publishNew({ manifest, plans });
    if (publication.status !== 'active' || !publication.shareUrl) {
      throw new Error(`Share ${manifest.id} did not become active`);
    }
    return { manifest: publication.manifest, shareUrl: publication.shareUrl };
  }
}
