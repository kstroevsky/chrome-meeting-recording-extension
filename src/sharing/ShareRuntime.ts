/**
 * Browser-page composition for the owner side of sharing. The runtime keeps
 * private source locators in local IndexedDB and sends only canonical published
 * manifests through the authenticated sharing service client.
 */

import type { TokenProvider } from '../offscreen/drive/request';
import { DriveOriginPreparer } from './DriveOriginPreparer';
import { SharePublicationCoordinator } from './SharePublicationCoordinator';
import { createSharePublicationStore } from './SharePublicationStore';
import { ShareOwnerSession } from './ShareOwnerSession';
import { SharePublisher } from './SharePublisher';
import { ShareRegistry } from './ShareRegistry';
import { ShareServiceClient } from './ShareServiceClient';
import { createShareUploadSourceResolver } from './ShareUploadSourceResolver';
import { createShareUploadStore } from './ShareUploadStore';
import type { RemoteShareSummary } from './ShareServiceClient';
import type { SharePublication } from './SharePublicationStore';
import type { ShareUploadJob } from './ShareUploadStore';

export type ShareRuntime = ReturnType<typeof createShareRuntime>;

export type ShareRuntimeAuth = {
  getDriveToken: TokenProvider;
  getIdentityToken: TokenProvider;
};

export type ShareRuntimeSnapshot = {
  remote: RemoteShareSummary[];
  local: SharePublication[];
  uploads: ShareUploadJob[];
  refreshedAt: number;
  /** Local durable state is still returned when the remote registry is temporarily unavailable. */
  remoteError?: string;
};

export function createShareRuntime(serviceOrigin: string, auth: ShareRuntimeAuth) {
  const ownerSession = new ShareOwnerSession(serviceOrigin, auth.getIdentityToken);
  const service = new ShareServiceClient(serviceOrigin, {
    headers: (options) => ownerSession.headers(options),
  });
  const publicationStore = createSharePublicationStore();
  const uploadStore = createShareUploadStore();
  const origins = new DriveOriginPreparer({
    store: uploadStore,
    source: createShareUploadSourceResolver({ getDriveToken: auth.getDriveToken }),
    api: service,
    getDriveToken: auth.getDriveToken,
  });
  const publications = new SharePublicationCoordinator({
    api: service,
    origins,
    store: publicationStore,
  });
  const registry = new ShareRegistry(service, publicationStore);

  return {
    service,
    publications,
    publisher: new SharePublisher({ publications }),
    registry,
    async revoke(shareId: string): Promise<void> {
      const local = await publicationStore.get(shareId);
      if (local) await publications.revoke(shareId);
      else await service.revokeShare(shareId);
    },
    async delete(shareId: string): Promise<void> {
      const local = await publicationStore.get(shareId);
      // Server deletion is the public/control-plane boundary and is idempotent.
      await service.deleteShare(shareId);
      // The user's actual Drive file is never deleted here. Only the explicit
      // relay permission and the publication pin are released.
      if (local?.origins?.length) await origins.cleanupPublishedData(local.origins);
      await origins.clearShare(shareId).catch(() => {});
      await publicationStore.remove(shareId);
    },
    async snapshot(): Promise<ShareRuntimeSnapshot> {
      let remote: RemoteShareSummary[] = [];
      let local = await publicationStore.list();
      let remoteError: string | undefined;
      try {
        const refreshed = await registry.refresh();
        remote = refreshed.remote;
        local = refreshed.local;
      } catch (error) {
        remoteError = error instanceof Error ? error.message : String(error);
      }
      return {
        remote,
        local,
        uploads: await uploadStore.list(),
        refreshedAt: Date.now(),
        ...(remoteError ? { remoteError } : {}),
      };
    },
  };
}
