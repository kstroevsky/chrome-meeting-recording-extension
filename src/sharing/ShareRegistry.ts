/**
 * @file sharing/ShareRegistry.ts
 *
 * Reconciles the durable local publication cache with the authenticated owner
 * registry. Terminal backend state is authoritative, while local revocation
 * intent is preserved until its idempotent DELETE succeeds.
 */

import type { SharePublication, SharePublicationStore } from './SharePublicationStore';
import type { RemoteShare, RemoteShareSummary, ShareRegistryApi } from './ShareServiceClient';

export type ShareRegistrySnapshot = {
  remote: RemoteShareSummary[];
  local: SharePublication[];
};

export class ShareRegistry {
  constructor(
    private readonly api: ShareRegistryApi,
    private readonly store: SharePublicationStore,
  ) {}

  async refresh(): Promise<ShareRegistrySnapshot> {
    const remote = await this.api.listShares();
    const local = await this.store.list();
    const remoteById = new Map(remote.map((share) => [share.id, share]));
    for (const publication of local) {
      const backend = remoteById.get(publication.id);
      if (backend) await this.reconcile(publication, backend);
    }
    return { remote, local: await this.store.list() };
  }

  async refreshOne(shareId: string): Promise<{ remote: RemoteShare; local?: SharePublication }> {
    const remote = await this.api.getShare(shareId);
    const local = await this.store.get(shareId);
    if (local) await this.reconcile(local, remote);
    return { remote, local: await this.store.get(shareId) };
  }

  private async reconcile(local: SharePublication, remote: RemoteShareSummary): Promise<void> {
    if (remote.status === 'revoked') {
      if (local.status === 'revoked' && !local.error && !local.resumeFrom) return;
      await this.store.put({
        ...local,
        status: 'revoked',
        resumeFrom: undefined,
        error: undefined,
        updatedAt: Math.max(local.updatedAt, remote.updatedAt),
      });
      return;
    }

    if (remote.status !== 'active' || isRevocationPending(local)) return;
    if (local.status === 'active' && local.shareUrl === remote.shareUrl && !local.error && !local.resumeFrom) return;
    await this.store.put({
      ...local,
      status: 'active',
      shareUrl: remote.shareUrl,
      resumeFrom: undefined,
      error: undefined,
      updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    });
  }
}

function isRevocationPending(publication: SharePublication): boolean {
  return publication.status === 'revoking'
    || publication.status === 'revoked'
    || (publication.status === 'failed' && publication.resumeFrom === 'revoking');
}
