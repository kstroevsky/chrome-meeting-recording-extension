/**
 * Browser-page composition for the owner side of sharing. The runtime keeps
 * private source locators in local IndexedDB and sends only canonical published
 * manifests through the authenticated sharing service client.
 */

import type { TokenProvider } from '../offscreen/drive/request';
import { SharePublicationCoordinator } from './SharePublicationCoordinator';
import { createSharePublicationStore } from './SharePublicationStore';
import { SharePublisher } from './SharePublisher';
import { ShareRegistry } from './ShareRegistry';
import { ShareServiceClient } from './ShareServiceClient';
import { ShareUploadManager } from './ShareUploadManager';
import { createShareUploadSourceResolver } from './ShareUploadSourceResolver';
import { createShareUploadStore } from './ShareUploadStore';

export type ShareRuntime = ReturnType<typeof createShareRuntime>;

export function createShareRuntime(serviceOrigin: string, getToken: TokenProvider) {
  const service = new ShareServiceClient(serviceOrigin, {
    headers: async (options) => ({
      authorization: `Bearer ${await getToken(options?.refresh ? { refresh: true } : undefined)}`,
    }),
  });
  const publicationStore = createSharePublicationStore();
  const uploads = new ShareUploadManager({
    store: createShareUploadStore(),
    source: createShareUploadSourceResolver({ getDriveToken: getToken }),
    transport: service,
  });
  const publications = new SharePublicationCoordinator({
    api: service,
    uploads,
    store: publicationStore,
  });

  return {
    service,
    publications,
    publisher: new SharePublisher({ publications }),
    registry: new ShareRegistry(service, publicationStore),
  };
}
