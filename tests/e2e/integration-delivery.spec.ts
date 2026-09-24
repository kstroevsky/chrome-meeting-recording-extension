import { expect, test, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IntegrationDataPolicy } from '../../src/integrations/contracts';
import type { IntegrationDelivery, IntegrationDestination } from '../../src/integrations/persistence';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  restartExtensionHarness,
  saveRecordingSettings,
  sendRuntimeMessage,
  startRecording,
  stopRecording,
  type ExtensionHarness,
} from './helpers/extensionHarness';
import {
  startIntegrationReceiver,
  type IntegrationReceiver,
  type IntegrationReceiverRequest,
} from './helpers/integrationReceiver';

const METADATA_POLICY: IntegrationDataPolicy = {
  metadata: true,
  meetingIdentity: false,
  userNote: false,
  notations: false,
  transcript: false,
  analysis: false,
  artifactMetadata: false,
  artifactLinks: false,
  transcriptSpeakers: 'omit',
};
const NOTE_POLICY: IntegrationDataPolicy = { ...METADATA_POLICY, userNote: true };

type CreatedDestination = {
  destination: IntegrationDestination;
  signingSecret: string;
};

test.describe('durable integration delivery @integration-e2e', () => {
  test.describe.configure({ mode: 'serial' });

  test('retries, reconstructs, preserves authorization ceilings, and resumes after restart', async ({}, testInfo) => {
    test.setTimeout(150_000);
    let harness: ExtensionHarness | null = null;
    let receiver: IntegrationReceiver | null = null;
    let deadReceiver: IntegrationReceiver | null = null;
    try {
      receiver = await startIntegrationReceiver(testInfo.outputPath('integration-receiver'));
      const extensionPath = await prepareIntegrationExtension(testInfo.outputPath('integration-extension'));
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), {
        extensionPath,
        ignoreHTTPSErrors: true,
      });

      const anchor = await createDestination(harness.controlPage, receiver.url('/anchor'), 'Anchor', METADATA_POLICY);
      expect(anchor.destination.enabled).toBe(true);

      const meet = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: 'opfs',
        micMode: 'off',
        recordSelfVideo: false,
      });
      const recordingA = await createRecording(harness, meet, meetTabId);
      const recordingB = await createRecording(harness, meet, meetTabId);
      await setRecordingNote(harness.controlPage, recordingA, 'private note A');
      await setRecordingNote(harness.controlPage, recordingB, 'private note B');

      // 503 -> durable retry -> success. Retry-After: 0 exercises the due-now
      // scheduler path without hiding the retry behind test-only entry points.
      receiver.plan('/retry-503', [
        { status: 503, headers: { 'Retry-After': '0' } },
        { status: 204 },
      ]);
      const retry503 = await createDestination(
        harness.controlPage,
        receiver.url('/retry-503'),
        'Retry 503',
        NOTE_POLICY,
      );
      const first503 = await sendRecording(harness.controlPage, retry503.destination.id, recordingA);
      expect(first503.state).toBe('retrying');
      const delivered503 = await waitForDestinationState(harness.controlPage, retry503.destination.id, 'delivered');
      const retry503Requests = await waitForRequestCount(receiver, '/retry-503', 2);
      expect(retry503Requests[1].body).toBe(retry503Requests[0].body);
      expect(header(retry503Requests[1], 'webhook-id')).toBe(header(retry503Requests[0], 'webhook-id'));
      expect(receiver.verify(retry503Requests[0], retry503.signingSecret)).toBe(true);
      expect(receiver.verify(retry503Requests[1], retry503.signingSecret)).toBe(true);
      expect(delivered503.attemptCount).toBe(2);
      await deleteDestination(harness.controlPage, retry503.destination.id);

      // Retry-After is normalized into durable wall-clock scheduling.
      receiver.plan('/retry-after', [{ status: 429, headers: { 'Retry-After': '120' } }]);
      const retryAfter = await createDestination(
        harness.controlPage,
        receiver.url('/retry-after'),
        'Retry after',
        METADATA_POLICY,
      );
      const retryAfterStarted = Date.now();
      const rateLimited = await sendRecording(harness.controlPage, retryAfter.destination.id, recordingA);
      expect(rateLimited.state).toBe('retrying');
      expect(rateLimited.lastStatus).toBe(429);
      expect(rateLimited.nextAttemptAt).toBeGreaterThanOrEqual(retryAfterStarted + 119_000);
      expect(rateLimited.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 121_000);
      await deleteDestination(harness.controlPage, retryAfter.destination.id);

      // A real connection failure becomes retryable durable work.
      deadReceiver = await startIntegrationReceiver(testInfo.outputPath('dead-integration-receiver'));
      const deadEndpoint = deadReceiver.url('/network-error');
      await deadReceiver.stop();
      deadReceiver = null;
      const network = await createDestination(harness.controlPage, deadEndpoint, 'Network error', METADATA_POLICY);
      const networkFailure = await sendRecording(harness.controlPage, network.destination.id, recordingA);
      expect(networkFailure).toEqual(expect.objectContaining({
        state: 'retrying',
        lastErrorCode: 'network-error',
      }));
      await deleteDestination(harness.controlPage, network.destination.id);

      // Receiver commits the exact request but the response disappears. Force
      // the durable retry due, restart Chrome, and prove startup reconstruction
      // replays the same event/body with a fresh timestamp/signature.
      receiver.plan(
        '/lost-response',
        Array.from({ length: 10 }, () => ({ dropResponse: true })),
      );
      const lost = await createDestination(
        harness.controlPage,
        receiver.url('/lost-response'),
        'Lost response',
        NOTE_POLICY,
      );
      const lostDelivery = await sendRecording(harness.controlPage, lost.destination.id, recordingA);
      expect(lostDelivery.state).toBe('retrying');
      const committed = (await waitForRequestCount(receiver, '/lost-response', 1))[0];
      await forceDeliveryDue(harness.controlPage, lostDelivery.id);
      await harness.context.close();
      const preRestartRequestCount = receiver.requests('/lost-response').length;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      receiver.plan('/lost-response', [{ status: 204 }]);
      harness = await restartExtensionHarness(harness, { ignoreHTTPSErrors: true });
      const lostRequests = await waitForRequestCount(
        receiver,
        '/lost-response',
        preRestartRequestCount + 1,
        30_000,
      );
      const replay = lostRequests[lostRequests.length - 1];
      expect(header(replay, 'webhook-id')).toBe(header(committed, 'webhook-id'));
      expect(replay.body).toBe(committed.body);
      expect(header(replay, 'webhook-timestamp')).not.toBe(header(committed, 'webhook-timestamp'));
      expect(header(replay, 'webhook-signature')).not.toBe(header(committed, 'webhook-signature'));
      expect(receiver.verify(committed, lost.signingSecret)).toBe(true);
      expect(receiver.verify(replay, lost.signingSecret)).toBe(true);
      await waitForDeliveryState(harness.controlPage, lostDelivery.id, 'delivered');
      await deleteDestination(harness.controlPage, lost.destination.id);

      // Canonical recording state changes before the failed attempt completes.
      // The retry reconstructs, detects a hash change, supersedes revision 1,
      // and sends a new full-state revision/event.
      receiver.plan('/recording-change', [
        { status: 503, headers: { 'Retry-After': '0' }, delayMs: 350 },
        { status: 204 },
      ]);
      const changed = await createDestination(
        harness.controlPage,
        receiver.url('/recording-change'),
        'Recording changes',
        NOTE_POLICY,
      );
      const changedSend = sendRecording(harness.controlPage, changed.destination.id, recordingA);
      const changedFirst = (await waitForRequestCount(receiver, '/recording-change', 1))[0];
      await setRecordingNote(harness.controlPage, recordingA, 'private note A revised');
      await changedSend;
      const changedRequests = await waitForRequestCount(receiver, '/recording-change', 2);
      const changedSecond = changedRequests[1];
      expect(header(changedSecond, 'webhook-id')).not.toBe(header(changedFirst, 'webhook-id'));
      expect(eventRevision(changedSecond)).toBe(2);
      expect(eventNote(changedFirst)).toBe('private note A');
      expect(eventNote(changedSecond)).toBe('private note A revised');
      const changedRows = await listDestinationDeliveries(harness.controlPage, changed.destination.id);
      expect(changedRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ revision: 1, state: 'superseded' }),
        expect.objectContaining({ revision: 2, state: 'delivered' }),
      ]));
      await deleteDestination(harness.controlPage, changed.destination.id);

      // Current policy narrowing applies immediately and therefore produces a
      // new, less-disclosing revision under the original authorization ceiling.
      receiver.plan('/policy-narrow', [
        { status: 503, headers: { 'Retry-After': '0' }, delayMs: 350 },
        { status: 204 },
      ]);
      const narrowed = await createDestination(
        harness.controlPage,
        receiver.url('/policy-narrow'),
        'Policy narrows',
        NOTE_POLICY,
      );
      const narrowSend = sendRecording(harness.controlPage, narrowed.destination.id, recordingA);
      const narrowFirst = (await waitForRequestCount(receiver, '/policy-narrow', 1))[0];
      await patchDestination(harness.controlPage, narrowed.destination.id, {
        dataPolicy: { ...NOTE_POLICY, userNote: false },
      });
      await narrowSend;
      const narrowRequests = await waitForRequestCount(receiver, '/policy-narrow', 2);
      expect(eventNote(narrowFirst)).toBe('private note A revised');
      expect(eventNote(narrowRequests[1])).toBeUndefined();
      expect(header(narrowRequests[1], 'webhook-id')).not.toBe(header(narrowFirst, 'webhook-id'));
      const narrowDelivered = await waitForDestinationState(harness.controlPage, narrowed.destination.id, 'delivered');
      expect(narrowDelivered.allowedPolicy?.userNote).toBe(true);
      await deleteDestination(harness.controlPage, narrowed.destination.id);

      // Later policy expansion can never expand the original logical send.
      receiver.plan('/policy-expand', [
        { status: 503, headers: { 'Retry-After': '0' }, delayMs: 350 },
        { status: 204 },
      ]);
      const expanded = await createDestination(
        harness.controlPage,
        receiver.url('/policy-expand'),
        'Policy expands',
        METADATA_POLICY,
      );
      const expandSend = sendRecording(harness.controlPage, expanded.destination.id, recordingA);
      const expandFirst = (await waitForRequestCount(receiver, '/policy-expand', 1))[0];
      await patchDestination(harness.controlPage, expanded.destination.id, { dataPolicy: NOTE_POLICY });
      await expandSend;
      const expandRequests = await waitForRequestCount(receiver, '/policy-expand', 2);
      expect(eventNote(expandFirst)).toBeUndefined();
      expect(eventNote(expandRequests[1])).toBeUndefined();
      expect(expandRequests[1].body).toBe(expandFirst.body);
      expect(header(expandRequests[1], 'webhook-id')).toBe(header(expandFirst, 'webhook-id'));
      await waitForDestinationState(harness.controlPage, expanded.destination.id, 'delivered');
      await deleteDestination(harness.controlPage, expanded.destination.id);

      // Destination deletion wins a race with a late response and no replay is
      // allowed after the durable cancellation.
      receiver.plan('/deleted', [{ status: 503, headers: { 'Retry-After': '0' }, delayMs: 350 }]);
      const deleted = await createDestination(
        harness.controlPage,
        receiver.url('/deleted'),
        'Deleted while queued',
        NOTE_POLICY,
      );
      const deleteSend = sendRecording(harness.controlPage, deleted.destination.id, recordingA);
      await waitForRequestCount(receiver, '/deleted', 1);
      await deleteDestination(harness.controlPage, deleted.destination.id);
      const canceled = await deleteSend;
      expect(canceled).toEqual(expect.objectContaining({ state: 'canceled' }));
      await harness.controlPage.waitForTimeout(500);
      expect(receiver.requests('/deleted')).toHaveLength(1);

      // Connection identity changes stop automatic replay. An explicit manual
      // retry approves the new connection and creates a fresh revision/event.
      receiver.plan('/connection-version', [
        { status: 503, headers: { 'Retry-After': '0' }, delayMs: 350 },
        { status: 204 },
      ]);
      const connection = await createDestination(
        harness.controlPage,
        receiver.url('/connection-version'),
        'Connection changes',
        NOTE_POLICY,
      );
      const connectionSend = sendRecording(harness.controlPage, connection.destination.id, recordingA);
      const connectionFirst = (await waitForRequestCount(receiver, '/connection-version', 1))[0];
      await patchDestination(harness.controlPage, connection.destination.id, { connectionVersion: 2 });
      await connectionSend;
      const blocked = await waitForDestinationState(harness.controlPage, connection.destination.id, 'action-required');
      expect(blocked.lastErrorCode).toBe('connection-version-changed');
      expect(receiver.requests('/connection-version')).toHaveLength(1);
      const manuallyRetried = await retryDelivery(harness.controlPage, blocked.id);
      expect(manuallyRetried).toEqual(expect.objectContaining({
        state: 'delivered',
        revision: 2,
        connectionVersion: 2,
      }));
      const connectionRequests = await waitForRequestCount(receiver, '/connection-version', 2);
      expect(header(connectionRequests[1], 'webhook-id')).not.toBe(header(connectionFirst, 'webhook-id'));
      await deleteDestination(harness.controlPage, connection.destination.id);

      // Stream-level locking must not serialize independent recordings bound to
      // the same destination. The second request reaches the receiver while the
      // first request is still deliberately waiting on its response.
      receiver.plan('/parallel-streams', [
        { status: 503, headers: { 'Retry-After': '120' }, delayMs: 600 },
        { status: 204 },
      ]);
      const parallel = await createDestination(
        harness.controlPage,
        receiver.url('/parallel-streams'),
        'Parallel streams',
        NOTE_POLICY,
      );
      const parallelA = sendRecording(harness.controlPage, parallel.destination.id, recordingA);
      const parallelB = sendRecording(harness.controlPage, parallel.destination.id, recordingB);
      const parallelRequests = await waitForRequestCount(receiver, '/parallel-streams', 2);
      expect(Math.abs(parallelRequests[1].receivedAt - parallelRequests[0].receivedAt)).toBeLessThan(500);
      const parallelStates = (await Promise.all([parallelA, parallelB])).map((delivery) => delivery.state).sort();
      expect(parallelStates).toEqual(['delivered', 'retrying']);
      await deleteDestination(harness.controlPage, parallel.destination.id);

      await deleteDestination(harness.controlPage, anchor.destination.id);
    } finally {
      await deadReceiver?.stop().catch(() => {});
      await receiver?.stop().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
    }
  });
});

async function prepareIntegrationExtension(destination: string): Promise<string> {
  const source = path.resolve(process.cwd(), process.env.EXTENSION_PATH ?? 'dist-e2e');
  await fs.cp(source, destination, { recursive: true });
  const manifestPath = path.join(destination, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
    host_permissions?: string[];
  };
  manifest.host_permissions = Array.from(new Set([
    ...(manifest.host_permissions ?? []),
    'https://127.0.0.1/*',
  ]));
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

async function createDestination(
  page: Page,
  endpoint: string,
  name: string,
  dataPolicy: IntegrationDataPolicy,
): Promise<CreatedDestination> {
  const response = await sendRuntimeMessage<any>(page, {
    type: 'CREATE_INTEGRATION',
    input: {
      name,
      endpoint,
      routingDefault: 'manual',
      dataPolicy,
      requestAuth: { type: 'none' },
    },
  });
  if (!response?.ok) throw new Error(`CREATE_INTEGRATION failed: ${response?.error ?? 'unknown error'}`);
  return response.created as CreatedDestination;
}

async function deleteDestination(page: Page, destinationId: string): Promise<void> {
  const response = await sendRuntimeMessage<any>(page, { type: 'DELETE_INTEGRATION', destinationId });
  if (!response?.ok) throw new Error(`DELETE_INTEGRATION failed: ${response?.error ?? 'unknown error'}`);
}

async function createRecording(
  harness: ExtensionHarness,
  meet: Page,
  meetTabId: number,
): Promise<string> {
  const before = new Set((await listRecordings(harness.controlPage)).map((entry) => entry.id));
  await startRecording(harness.controlPage, meetTabId, {
    storageMode: 'local',
    micMode: 'off',
    recordSelfVideo: false,
  });
  await meet.waitForTimeout(900);
  await stopRecording(harness.controlPage);
  const created = (await listRecordings(harness.controlPage)).find((entry) => !before.has(entry.id) && entry.available);
  if (!created) throw new Error('Could not resolve newly created integration recording');
  return created.id;
}

async function listRecordings(page: Page): Promise<Array<{ id: string; available: boolean }>> {
  const response = await sendRuntimeMessage<any>(page, { type: 'LIST_INTEGRATION_RECORDINGS' });
  if (!response?.ok) throw new Error(`LIST_INTEGRATION_RECORDINGS failed: ${response?.error ?? 'unknown error'}`);
  return response.recordings;
}

async function setRecordingNote(page: Page, recordingId: string, note: string): Promise<void> {
  const response = await sendRuntimeMessage<any>(page, {
    type: 'SET_RECORDING_HISTORY_NOTE',
    id: recordingId,
    note,
  });
  if (!response?.ok) throw new Error(`SET_RECORDING_HISTORY_NOTE failed: ${response?.error ?? 'unknown error'}`);
}

async function sendRecording(page: Page, destinationId: string, recordingId: string): Promise<IntegrationDelivery> {
  const response = await sendRuntimeMessage<any>(page, {
    type: 'SEND_RECORDING_TO_INTEGRATION',
    destinationId,
    recordingId,
  });
  if (!response?.ok) throw new Error(`SEND_RECORDING_TO_INTEGRATION failed: ${response?.error ?? 'unknown error'}`);
  return response.delivery;
}

async function retryDelivery(page: Page, deliveryId: string): Promise<IntegrationDelivery> {
  const response = await sendRuntimeMessage<any>(page, { type: 'RETRY_INTEGRATION_DELIVERY', deliveryId });
  if (!response?.ok) throw new Error(`RETRY_INTEGRATION_DELIVERY failed: ${response?.error ?? 'unknown error'}`);
  return response.delivery;
}

async function listDeliveries(page: Page): Promise<IntegrationDelivery[]> {
  const response = await sendRuntimeMessage<any>(page, { type: 'LIST_INTEGRATION_DELIVERIES' });
  if (!response?.ok) throw new Error(`LIST_INTEGRATION_DELIVERIES failed: ${response?.error ?? 'unknown error'}`);
  return response.deliveries;
}

async function listDestinationDeliveries(page: Page, destinationId: string): Promise<IntegrationDelivery[]> {
  return (await listDeliveries(page)).filter((delivery) => delivery.destinationId === destinationId);
}

async function waitForDeliveryState(
  page: Page,
  deliveryId: string,
  state: IntegrationDelivery['state'],
  timeout = 15_000,
): Promise<IntegrationDelivery> {
  let latest: IntegrationDelivery | undefined;
  await expect.poll(async () => {
    latest = (await listDeliveries(page)).find((delivery) => delivery.id === deliveryId);
    return latest?.state;
  }, { timeout }).toBe(state);
  return latest!;
}

async function waitForDestinationState(
  page: Page,
  destinationId: string,
  state: IntegrationDelivery['state'],
  timeout = 15_000,
): Promise<IntegrationDelivery> {
  let latest: IntegrationDelivery | undefined;
  await expect.poll(async () => {
    latest = (await listDestinationDeliveries(page, destinationId))
      .sort((left, right) => right.revision - left.revision)[0];
    return latest?.state;
  }, { timeout }).toBe(state);
  return latest!;
}

async function waitForRequestCount(
  receiver: IntegrationReceiver,
  pathname: string,
  count: number,
  timeout = 15_000,
): Promise<IntegrationReceiverRequest[]> {
  await expect.poll(() => receiver.requests(pathname).length, { timeout }).toBeGreaterThanOrEqual(count);
  return receiver.requests(pathname);
}

async function forceDeliveryDue(page: Page, deliveryId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const database = await openIntegrationDatabaseForTest();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('deliveries', 'readwrite');
      const store = transaction.objectStore('deliveries');
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) {
          transaction.abort();
          reject(new Error(`Missing integration delivery ${id}`));
          return;
        }
        store.put({ ...request.result, nextAttemptAt: Date.now() - 1, updatedAt: Date.now() });
      };
      request.onerror = () => reject(request.error ?? new Error('Could not read integration delivery'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not update integration delivery'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Integration delivery update aborted'));
    });
    database.close();

    function openIntegrationDatabaseForTest(): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('meeting-integrations');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Could not open integration database'));
      });
    }
  }, deliveryId);
}

async function patchDestination(
  page: Page,
  destinationId: string,
  patch: { dataPolicy?: IntegrationDataPolicy; connectionVersion?: number },
): Promise<void> {
  await page.evaluate(async ({ id, next }) => {
    const database = await openIntegrationDatabaseForTest();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('destinations', 'readwrite');
      const store = transaction.objectStore('destinations');
      const request = store.get(id);
      request.onsuccess = () => {
        const current = request.result;
        if (!current) {
          transaction.abort();
          reject(new Error(`Missing integration destination ${id}`));
          return;
        }
        store.put({ ...current, ...next, updatedAt: Date.now() });
      };
      request.onerror = () => reject(request.error ?? new Error('Could not read integration destination'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not update integration destination'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Integration destination update aborted'));
    });
    database.close();

    function openIntegrationDatabaseForTest(): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('meeting-integrations');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Could not open integration database'));
      });
    }
  }, { id: destinationId, next: patch });
}

function header(request: IntegrationReceiverRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parsedEvent(request: IntegrationReceiverRequest): any {
  return JSON.parse(request.body);
}

function eventRevision(request: IntegrationReceiverRequest): number {
  return parsedEvent(request).data.revision;
}

function eventNote(request: IntegrationReceiverRequest): string | undefined {
  return parsedEvent(request).data.recording.note;
}
