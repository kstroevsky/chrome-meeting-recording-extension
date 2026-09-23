/**
 * Browser-page composition for the owner side of sharing. The runtime keeps
 * private source locators in local IndexedDB and sends only canonical published
 * manifests through the authenticated sharing service client.
 */

import type { TokenProvider } from '../offscreen/drive/request';
import { SharePublicationCoordinator } from './SharePublicationCoordinator';
import { createSharePublicationStore } from './SharePublicationStore';
import { ShareOwnerSession } from './ShareOwnerSession';
import { SharePublisher } from './SharePublisher';
import { ShareRegistry } from './ShareRegistry';
import { ShareServiceClient } from './ShareServiceClient';
import { ShareUploadManager } from './ShareUploadManager';
import { createShareUploadSourceResolver } from './ShareUploadSourceResolver';
import { createShareUploadStore } from './ShareUploadStore';
import type { RemoteShare } from './ShareServiceClient';
import type { SharePublication } from './SharePublicationStore';
import type { ShareUploadJob } from './ShareUploadStore';

export type ShareRuntime = ReturnType<typeof createShareRuntime>;

export type ShareRuntimeAuth = {
  getDriveToken: TokenProvider;
  getIdentityToken: TokenProvider;
};

export type ShareRuntimeSnapshot = {
  remote: RemoteShare[];
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
  const uploads = new ShareUploadManager({
    store: uploadStore,
    source: createShareUploadSourceResolver({ getDriveToken: auth.getDriveToken }),
    transport: service,
  });
  const publications = new SharePublicationCoordinator({
    api: service,
    uploads,
    store: publicationStore,
  });
  const registry = new ShareRegistry(service, publicationStore);

  return {
    service,
    publications,
    publisher: new SharePublisher({ publications }),
    registry,
    async snapshot(): Promise<ShareRuntimeSnapshot> {
      let remote: RemoteShare[] = [];
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
