import { expect, test, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IntegrationDataPolicy } from '../../src/integrations/contracts';
import type { IntegrationDestination } from '../../src/integrations/persistence';
import type { RecordingDestinationProfile } from '../../src/shared/recordingDestinations';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  saveRecordingSettings,
  sendRuntimeMessage,
  stopRecording,
  waitForSessionPhase,
  type ExtensionHarness,
} from './helpers/extensionHarness';
import { startIntegrationReceiver, type IntegrationReceiver } from './helpers/integrationReceiver';

/** Metadata only, so nothing waits for a transcript or an analysis before sending. */
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

/** How long "nothing was sent" is watched for; the planner acts within a second when it may. */
const QUIET_MS = 3_000;

type RouteView = { destinationId: string; destinationName: string | null; state: string };

/**
 * Plan E1–E8, end to end through the real background: a connected integration
 * is offered under Save to, a recording started with it holds its routes until
 * the end dialog's answer, × keeps the data in the browser, a built-in routes
 * nowhere, and a deleted integration can no longer be picked.
 *
 * Driven by runtime messages, the popup's own wire protocol, like the other
 * integration specs; the popup and settings views are unit-tested.
 */
test.describe('Save to destinations @integration-e2e', () => {
  test.describe.configure({ mode: 'serial' });

  test('sends only what the end dialog confirms', async ({}, testInfo) => {
    test.setTimeout(150_000);
    let harness: ExtensionHarness | null = null;
    let receiver: IntegrationReceiver | null = null;
    try {
      receiver = await startIntegrationReceiver(testInfo.outputPath('save-to-receiver'));
      const extensionPath = await prepareIntegrationExtension(testInfo.outputPath('save-to-extension'));
      harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), { extensionPath, ignoreHTTPSErrors: true });
      const page = harness.controlPage;

      // Connecting an integration adds it to Save to (E4).
      const { destination, signingSecret, profile } = await createIntegration(page, receiver.url('/crm'), 'CheekyCheeseIT CRM');
      expect(profile).toEqual(expect.objectContaining({
        name: 'CheekyCheeseIT CRM',
        mediaTarget: { kind: 'local' },
        dataRoutes: [{ destinationId: destination.id, mode: 'auto' }],
      }));
      const listed = await listDestinations(page);
      expect(listed.destinations.map((option: any) => option.id)).toEqual(['builtin:drive', 'builtin:local', profile.id]);
      expect(listed.destinations[2]).toEqual(expect.objectContaining({ available: true, storageMode: 'local' }));

      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(page);
      await saveRecordingSettings(page, { recordingMode: 'opfs', micMode: 'off', recordSelfVideo: false });

      // Picked at Start: the profile decides the storage, even when the popup said Drive (E1/E5).
      await start(page, tabId, 'drive', profile.id);
      const running = await sessionRunConfig(page);
      expect(running).toEqual(expect.objectContaining({ storageMode: 'local', destinationProfileId: profile.id }));
      expect(await routes(page)).toEqual([{ destinationId: destination.id, destinationName: 'CheekyCheeseIT CRM', state: 'held' }]);
      // The pick is remembered for the next Start.
      expect((await listDestinations(page)).rememberedId).toBe(profile.id);

      await meet.waitForTimeout(900);
      const kept = await stop(page);
      // Held: the recording is finished, but nothing leaves before the answer (E7).
      await page.waitForTimeout(QUIET_MS);
      expect(receiver.requests('/crm')).toHaveLength(0);
      const held = await heldRecordings(page);
      expect(held.map((recording: any) => recording.recordingId)).toContain(kept);

      await confirm(page, kept, []);
      await expect.poll(() => receiver!.requests('/crm').length, { timeout: 20_000 }).toBe(1);
      const sent = receiver.requests('/crm')[0]!;
      expect(receiver.verify(sent, signingSecret)).toBe(true);
      expect(JSON.parse(sent.body).type).toMatch(/\.recording\.ready\.v1$/);
      expect(await routes(page, kept)).toEqual([expect.objectContaining({ state: 'released' })]);
      // Sending to an integration is independent from public Sharing (Joint Test 14).
      expect(await sharePublications(page)).toEqual([]);
      // Confirming again changes nothing.
      await confirm(page, kept, []);
      await page.waitForTimeout(1_000);
      expect(receiver.requests('/crm')).toHaveLength(1);

      // × in the end dialog: the data stays in the browser (E7, Joint Test 12).
      await start(page, tabId, 'local', profile.id);
      await meet.waitForTimeout(900);
      const removed = await stop(page);
      await confirm(page, removed, [destination.id]);
      await page.waitForTimeout(QUIET_MS);
      expect(receiver.requests('/crm')).toHaveLength(1);
      expect(await routes(page, removed)).toEqual([expect.objectContaining({ state: 'skipped' })]);

      // A built-in routes nowhere.
      await start(page, tabId, 'local', 'builtin:local');
      expect(await routes(page)).toEqual([]);
      await meet.waitForTimeout(900);
      const builtin = await stop(page);
      expect(await routes(page, builtin)).toEqual([]);

      // Deleting the integration: its destination stays listed but cannot be picked (E2).
      const deleted = await sendRuntimeMessage<any>(page, { type: 'DELETE_INTEGRATION', destinationId: destination.id });
      expect(deleted.ok).toBe(true);
      const afterDelete = await listDestinations(page);
      expect(afterDelete.destinations[2]).toEqual(expect.objectContaining({
        id: profile.id, available: false, unavailableReason: 'destination-missing',
      }));
      expect(afterDelete.rememberedId).not.toBe(profile.id);
      // Starting with it anyway still records, routed nowhere; the dialog says why.
      await start(page, tabId, 'local', profile.id);
      expect(await routes(page)).toEqual([{ destinationId: destination.id, destinationName: null, state: 'not-scheduled' }]);
      await meet.waitForTimeout(500);
      await stopRecording(page);
      await page.waitForTimeout(1_000);
      expect(receiver.requests('/crm')).toHaveLength(1);
    } finally {
      await receiver?.stop().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
    }
  });
});

async function prepareIntegrationExtension(destination: string): Promise<string> {
  const source = path.resolve(process.cwd(), process.env.EXTENSION_PATH ?? 'dist-e2e');
  await fs.cp(source, destination, { recursive: true });
  const manifestPath = path.join(destination, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { host_permissions?: string[] };
  manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions ?? []), 'https://127.0.0.1/*']));
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

async function sharePublications(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === 'published-share-publications')) return [];

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('published-share-publications');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains('publications')) {
      db.close();
      return [];
    }
    const tx = db.transaction('publications', 'readonly');
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore('publications').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return values;
  });
}

async function createIntegration(page: Page, endpoint: string, name: string): Promise<{
  destination: IntegrationDestination;
  signingSecret: string;
  profile: RecordingDestinationProfile;
}> {
  const response = await sendRuntimeMessage<any>(page, {
    type: 'CREATE_INTEGRATION',
    input: { name, endpoint, routingDefault: 'manual', dataPolicy: METADATA_POLICY, requestAuth: { type: 'none' } },
  });
  if (!response?.ok) throw new Error(`CREATE_INTEGRATION failed: ${response?.error ?? 'unknown error'}`);
  if (!response.profile) throw new Error('CREATE_INTEGRATION did not add the integration to Save to');
  return { ...response.created, profile: response.profile };
}

async function listDestinations(page: Page): Promise<any> {
  const response = await sendRuntimeMessage<any>(page, { type: 'LIST_RECORDING_DESTINATIONS' });
  if (!response?.ok) throw new Error(`LIST_RECORDING_DESTINATIONS failed: ${response?.error}`);
  return response;
}

async function start(page: Page, tabId: number, storageMode: 'local' | 'drive', destinationProfileId: string): Promise<void> {
  const response = await sendRuntimeMessage<any>(page, {
    type: 'START_RECORDING',
    tabId,
    runConfig: { storageMode, micMode: 'off', recordSelfVideo: false, destinationProfileId },
  });
  if (!response?.ok) throw new Error(`START_RECORDING failed: ${response?.error}`);
  await waitForSessionPhase(page, 'recording', 30_000);
}

async function sessionRunConfig(page: Page): Promise<unknown> {
  return page.evaluate(async () => ((await chrome.storage.session.get('recordingSession')) as any)?.recordingSession?.runConfig);
}

/** Stops the run and answers its history ID, read while the session still names it. */
async function stop(page: Page): Promise<string> {
  const historyId = await page.evaluate(async () => ((await chrome.storage.session.get('recordingSession')) as any)?.recordingSession?.historyId as string | undefined);
  if (!historyId) throw new Error('No running recording to stop');
  await stopRecording(page);
  return historyId;
}

async function routes(page: Page, recordingId?: string): Promise<RouteView[]> {
  const response = await sendRuntimeMessage<any>(page, { type: 'GET_RECORDING_ROUTES', ...(recordingId ? { recordingId } : {}) });
  if (!response?.ok) throw new Error(`GET_RECORDING_ROUTES failed: ${response?.error}`);
  return response.routes;
}

async function heldRecordings(page: Page): Promise<any[]> {
  const response = await sendRuntimeMessage<any>(page, { type: 'LIST_HELD_RECORDING_ROUTES' });
  if (!response?.ok) throw new Error(`LIST_HELD_RECORDING_ROUTES failed: ${response?.error}`);
  return response.recordings;
}

async function confirm(page: Page, recordingId: string, removedDestinationIds: string[]): Promise<void> {
  const removed = new Set(removedDestinationIds);
  const decisions = (await routes(page, recordingId)).flatMap((route) => route.state === 'held'
    ? [{ destinationId: route.destinationId, action: removed.has(route.destinationId) ? 'skip' : 'release' }]
    : []);
  const response = await sendRuntimeMessage<any>(page, { type: 'CONFIRM_RECORDING_ROUTES', recordingId, decisions });
  if (!response?.ok) throw new Error(`CONFIRM_RECORDING_ROUTES failed: ${response?.error}`);
}
