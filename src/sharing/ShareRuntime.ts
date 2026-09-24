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
import {
  createShareOriginCleanupStore,
  ShareOriginCleanupCoordinator,
} from './ShareOriginCleanupQueue';
import { SharePublisher } from './SharePublisher';
import { ShareRegistry } from './ShareRegistry';
import { ShareServiceClient } from './ShareServiceClient';
import { createShareMediaSourceResolver } from './ShareMediaSourceResolver';
import { createShareDriveOriginRegistry } from './ShareDriveOriginRegistry';
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
  const driveOriginRegistry = createShareDriveOriginRegistry();
  const cleanupStore = createShareOriginCleanupStore();
  const origins = new DriveOriginPreparer({
    store: uploadStore,
    source: createShareMediaSourceResolver({ getDriveToken: auth.getDriveToken }),
    api: service,
    registry: driveOriginRegistry,
    getDriveToken: auth.getDriveToken,
  });
  const cleanup = new ShareOriginCleanupCoordinator({
    api: service,
    origins,
    store: cleanupStore,
  });
  const publications = new SharePublicationCoordinator({
    api: {
      createShare: (manifest) => service.createShare(manifest),
      finalizeShare: (shareId) => service.finalizeShare(shareId),
      revokeShare: async (shareId) => {
        const local = await publicationStore.get(shareId);
        await cleanup.run(shareId, 'revoke', local?.origins);
      },
    },
    origins,
    store: publicationStore,
  });
  const registry = new ShareRegistry(service, publicationStore);

  return {
    service,
    publications,
    publisher: new SharePublisher({ publications }),
    registry,
    async resumePending(): Promise<void> {
      await publications.resumePending();
      await cleanup.resumePending();
    },
    async revoke(shareId: string): Promise<void> {
      const local = await publicationStore.get(shareId);
      if (local) await publications.revoke(shareId);
      else await cleanup.run(shareId, 'revoke');
    },
    async delete(shareId: string): Promise<void> {
      const local = await publicationStore.get(shareId);
      // The durable cleanup job performs the server deletion first, then removes
      // only the relay permission/publication pin. It never deletes the Drive file.
      await cleanup.run(shareId, 'delete', local?.origins);
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
