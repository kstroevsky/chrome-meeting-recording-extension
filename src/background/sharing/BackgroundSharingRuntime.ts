import type { PublishedRecordingInput, PublishRecordingOptions } from '../../sharing/PublishedManifestBuilder';
import { createShareOriginCleanupStore } from '../../sharing/ShareOriginCleanupQueue';
import { createSharePublicationStore } from '../../sharing/SharePublicationStore';
import type { ShareRuntimeSnapshot } from '../../sharing/ShareRuntime';
import type { OffscreenManager } from '../offscreen/OffscreenManager';

type RpcFailure = { ok: false; error: string };

/** Command-plane bridge for the offscreen sharing runtime. */
export class BackgroundSharingRuntime {
  private readonly publications = createSharePublicationStore();
  private readonly cleanups = createShareOriginCleanupStore();

  constructor(private readonly offscreen: OffscreenManager) {}

  async resumeIfPending(): Promise<void> {
    const pending = (await this.publications.list()).some((publication) =>
      (publication.status !== 'active' && publication.status !== 'revoked')
      || publication.originAclCleanupPending === true);
    const pendingCleanup = (await this.cleanups.list()).length > 0;
    if (pending || pendingCleanup) await this.offscreen.ensureReady();
  }

  async publish(
    recordings: PublishedRecordingInput[],
    options: PublishRecordingOptions,
  ): Promise<{ shareId: string }> {
    await this.offscreen.ensureReady();
    const response = await this.offscreen.rpc<{ ok: true; shareId: string } | RpcFailure>({
      type: 'OFFSCREEN_SHARE_PUBLISH', recordings, options,
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not start sharing');
    return { shareId: response.shareId };
  }

  async snapshot(): Promise<ShareRuntimeSnapshot> {
    await this.offscreen.ensureReady();
    const response = await this.offscreen.rpc<{ ok: true; snapshot: ShareRuntimeSnapshot } | RpcFailure>({
      type: 'OFFSCREEN_SHARE_SNAPSHOT',
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not load shared recordings');
    return response.snapshot;
  }

  async revoke(shareId: string): Promise<void> {
    await this.offscreen.ensureReady();
    const response = await this.offscreen.rpc<{ ok: true } | RpcFailure>({
      type: 'OFFSCREEN_SHARE_REVOKE', shareId,
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not revoke share');
  }

  async delete(shareId: string): Promise<void> {
    await this.offscreen.ensureReady();
    const response = await this.offscreen.rpc<{ ok: true } | RpcFailure>({
      type: 'OFFSCREEN_SHARE_DELETE', shareId,
    });
    if (!response?.ok) throw new Error(response?.error || 'Could not delete published data');
  }
}
