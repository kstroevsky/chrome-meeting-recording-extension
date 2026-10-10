import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { IntegrationDataPolicy } from "../../src/integrations/contracts";
import type { RecordingHistoryEntry } from "../../src/shared/recordingHistory";
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  restartExtensionHarness,
  saveRecordingSettings,
  sendRuntimeMessage,
  stopRecording,
  waitForSessionPhase,
  type ExtensionHarness,
} from "./helpers/extensionHarness";
import {
  startReferenceMediaReceiverProcess,
  type ReferenceMediaReceiverConfig,
  type ReferenceMediaReceiverProcess,
} from "./helpers/referenceMediaReceiver";

const MiB = 1024 * 1024;
const JM2_FIXTURE_BYTES = 100 * MiB;
const RESTART_FIXTURE_BYTES = 128 * MiB + 12_345;
const EXPIRY_FIXTURE_BYTES = 16 * MiB + 12_345;

const RUN_LARGE_TRANSFER = process.env.REFERENCE_MEDIA_RUN_LARGE_TRANSFER === "1";
const RUN_RESTART_RECOVERY = process.env.REFERENCE_MEDIA_RUN_RESTART_RECOVERY === "1";
const RUN_URL_EXPIRY = process.env.REFERENCE_MEDIA_RUN_URL_EXPIRY === "1";
const RUN_ATTEMPT_EXPIRY = process.env.REFERENCE_MEDIA_RUN_ATTEMPT_EXPIRY === "1";
const RUN_PLAYBACK_EXPIRY = process.env.REFERENCE_MEDIA_RUN_PLAYBACK_EXPIRY === "1";

const METADATA_POLICY: IntegrationDataPolicy = {
  metadata: true,
  meetingIdentity: true,
  userNote: false,
  notations: false,
  transcript: false,
  analysis: false,
  artifactMetadata: true,
  artifactLinks: false,
  transcriptSpeakers: "omit",
};

type R2Config = ReferenceMediaReceiverConfig["s3"];

type ConfiguredReference = {
  receiver: ReferenceMediaReceiverProcess;
  harness: ExtensionHarness;
  destination: { id: string };
  profile: { id: string };
  mediaBearer: string;
};

const R2 = readR2Config();

test.describe("independent external-media receiver conformance @reference-media", () => {
  test.describe.configure({ mode: "serial" });

  test("JM0 validates capability origin and grants R2 access from the production user gesture", async ({}, testInfo) => {
    test.skip(!R2, missingR2Message());
    test.skip(
      process.env.PW_HEADLESS !== "0",
      "JM0 exercises Chrome's optional-host permission prompt and requires PW_HEADLESS=0.",
    );
    test.setTimeout(240_000);

    let configured: ConfiguredReference | null = null;
    try {
      configured = await configureReference(testInfo, {
        pregrantUpload: false,
        configureMedia: false,
      });

      await configured.receiver.restart({
        capabilityApiBase: "https://invalid-control.example/media",
      });
      const rejected = await testIntegration(configured.harness.controlPage, configured.destination.id);
      expect(rejected).toEqual(expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          ok: true,
          status: 200,
          capabilityError: "invalid-response",
        }),
      }));
      expect(rejected.result.mediaCapability).toBeUndefined();

      await configured.receiver.restart({ capabilityApiBase: undefined });
      await configured.harness.controlPage.reload({ waitUntil: "domcontentloaded" });
      const row = configured.harness.controlPage.locator(".integration-destination")
        .filter({ hasText: "Reference media receiver" });
      await row.getByRole("button", { name: "Test" }).click();
      await expect(configured.harness.controlPage.locator("#integration-status"))
        .toContainText("media-capable connection verified", { timeout: 20_000 });
      const grant = configured.harness.controlPage.getByRole("button", {
        name: "Grant storage access",
      });
      await expect(grant).toBeVisible();
      await grant.click();
      await expect(configured.harness.controlPage.locator("#integration-status"))
        .toContainText("storage access granted", { timeout: 20_000 });
      expect(await hasHostPermission(configured.harness.controlPage, R2!.uploadOrigin)).toBe(true);

      const discovery = await testIntegration(configured.harness.controlPage, configured.destination.id);
      expect(discovery.result.mediaCapability).toEqual({
        version: 1,
        apiBase: `${configured.receiver.origin}/media`,
        upload: { strategy: "multipart-put-v1", origins: [R2!.uploadOrigin] },
        playback: { strategy: "refreshable-url-v1" },
      });
      await configureMedia(
        configured.harness.controlPage,
        configured.destination.id,
        configured.mediaBearer,
      );
    } finally {
      await closeConfigured(configured);
    }
  });

  test("JM1 uploads through real presigned R2 multipart URLs and range-plays the verified artifact", async ({}, testInfo) => {
    test.skip(!R2, missingR2Message());
    test.setTimeout(360_000);

    let configured: ConfiguredReference | null = null;
    try {
      configured = await configureReference(testInfo);
      const recordingId = await createRecording(configured, { captureMs: 2_500 });
      expect(await confirmHeldRoutes(configured.harness.controlPage, recordingId))
        .toEqual(expect.objectContaining({ ok: true }));
      const transfers = await waitForTransfersAcknowledged(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
      );
      expect(transfers.length).toBeGreaterThan(0);
      expect(transfers.every((transfer) => transfer.bytesUploaded === transfer.bytesTotal)).toBe(true);

      const entry = await historyEntry(configured.harness.controlPage, recordingId);
      const external = firstExternalMedia(entry, configured.destination.id);
      expect(external.file.locations.some((location) => location.kind === "opfs")).toBe(true);
      const player = await openRecordingsPage(configured.harness);
      const playback = await prepareExternalPlayback(player, {
        recordingId,
        fileId: external.file.id,
        destinationId: configured.destination.id,
        artifactId: external.artifactId,
      });
      expect(playback.ok).toBe(true);
      if (!playback.url) throw new Error("JM1 receiver did not return a playback URL");

      const ranged = await rangedRead(
        player,
        playback.url,
        "bytes=0-1023",
      );
      expect(ranged.status).toBe(206);
      expect(ranged.contentRange).toMatch(/^bytes 0-\d+\/\d+$/);
      expect(ranged.bytes).toBeGreaterThan(0);
      await proveBrowserPlayback(player, playback.url, external.file.mimeType);
    } finally {
      await closeConfigured(configured);
    }
  });

  test("JM2 uploads a 100 MiB audio-sized source with exact multipart accounting and tail range", async ({}, testInfo) => {
    test.skip(!R2 || !RUN_LARGE_TRANSFER, `${missingR2Message()} Set REFERENCE_MEDIA_RUN_LARGE_TRANSFER=1 to run JM2.`);
    test.setTimeout(1_800_000);

    let configured: ConfiguredReference | null = null;
    try {
      configured = await configureReference(testInfo, {
        receiver: { partSizeBytes: 32 * MiB },
      });
      const recordingId = await createRecording(configured);
      const retained = await retainedOpfsMedia(configured.harness.controlPage, recordingId);
      expect(await resizeRetainedOpfsFixture(
        configured.harness.controlPage,
        retained.key,
        JM2_FIXTURE_BYTES,
      )).toBe(JM2_FIXTURE_BYTES);
      expect(await confirmHeldRoutes(configured.harness.controlPage, recordingId))
        .toEqual(expect.objectContaining({ ok: true }));

      const transfers = await waitForTransfersAcknowledged(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
        1_500_000,
      );
      expect(transfers).toHaveLength(1);
      expect(transfers[0]).toMatchObject({
        state: "acknowledged",
        bytesUploaded: JM2_FIXTURE_BYTES,
        bytesTotal: JM2_FIXTURE_BYTES,
      });
      const journal = await externalMediaJournal(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
      );
      expect(journal.request.artifact.bytes).toBe(JM2_FIXTURE_BYTES);
      const expectedParts = Math.ceil(JM2_FIXTURE_BYTES / journal.partSize);
      expect(journal.uploadedParts).toHaveLength(expectedParts);
      expect(new Set(journal.uploadedParts.map((part: any) => part.partNumber)).size).toBe(expectedParts);
      const finalPartBytes = JM2_FIXTURE_BYTES - (expectedParts - 1) * journal.partSize;
      expect(finalPartBytes).toBeGreaterThan(0);
      expect(finalPartBytes).toBeLessThanOrEqual(journal.partSize);

      const entry = await historyEntry(configured.harness.controlPage, recordingId);
      const external = firstExternalMedia(entry, configured.destination.id);
      const player = await openRecordingsPage(configured.harness);
      const playback = await prepareExternalPlayback(player, {
        recordingId,
        fileId: external.file.id,
        destinationId: configured.destination.id,
        artifactId: external.artifactId,
      });
      if (!playback.ok || !playback.url) throw new Error(`JM2 playback failed: ${playback.error ?? "missing URL"}`);
      expect(await rangedRead(
        player,
        playback.url,
        `bytes=${JM2_FIXTURE_BYTES - 1024}-${JM2_FIXTURE_BYTES - 1}`,
      )).toEqual({
        status: 206,
        contentRange: `bytes ${JM2_FIXTURE_BYTES - 1024}-${JM2_FIXTURE_BYTES - 1}/${JM2_FIXTURE_BYTES}`,
        bytes: 1024,
      });
    } finally {
      await closeConfigured(configured);
    }
  });

  test("JM3 resumes the same multipart identity after receiver and browser termination", async ({}, testInfo) => {
    test.skip(!R2 || !RUN_RESTART_RECOVERY, `${missingR2Message()} Set REFERENCE_MEDIA_RUN_RESTART_RECOVERY=1 to run JM3.`);
    test.setTimeout(1_200_000);

    let configured: ConfiguredReference | null = null;
    try {
      configured = await configureReference(testInfo, {
        receiver: { partSizeBytes: 5 * MiB },
      });
      const recordingId = await createRecording(configured);
      const retained = await retainedOpfsMedia(configured.harness.controlPage, recordingId);
      expect(await resizeRetainedOpfsFixture(
        configured.harness.controlPage,
        retained.key,
        RESTART_FIXTURE_BYTES,
      )).toBe(RESTART_FIXTURE_BYTES);
      expect(await confirmHeldRoutes(configured.harness.controlPage, recordingId))
        .toEqual(expect.objectContaining({ ok: true }));

      let beforeRestart: any;
      await expect.poll(async () => {
        beforeRestart = await externalMediaJournal(
          configured!.harness.controlPage,
          recordingId,
          configured!.destination.id,
        );
        if (!beforeRestart?.partSize) return false;
        const total = Math.ceil(RESTART_FIXTURE_BYTES / beforeRestart.partSize);
        return beforeRestart.state === "uploading" &&
          beforeRestart.uploadedParts?.length > 0 && beforeRestart.uploadedParts.length < total;
      }, { timeout: 240_000, intervals: [100, 250, 500, 1_000] }).toBe(true);

      const identity = {
        clientTransferId: beforeRestart.request.clientTransferId,
        artifactId: beforeRestart.artifactId,
        uploadId: beforeRestart.uploadId,
      };
      await configured.receiver.crash();
      await configured.receiver.restart();
      configured.harness = await restartExtensionHarness(configured.harness, {
        ignoreHTTPSErrors: true,
      });

      const transfers = await waitForTransfersAcknowledged(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
        900_000,
      );
      expect(transfers).toEqual([
        expect.objectContaining({
          clientTransferId: identity.clientTransferId,
          state: "acknowledged",
          bytesUploaded: RESTART_FIXTURE_BYTES,
          bytesTotal: RESTART_FIXTURE_BYTES,
        }),
      ]);
      const after = await externalMediaJournal(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
      );
      expect(after).toMatchObject({
        state: "acknowledged",
        artifactId: identity.artifactId,
        uploadId: identity.uploadId,
      });
      expect(after.request.clientTransferId).toBe(identity.clientTransferId);
    } finally {
      await closeConfigured(configured);
    }
  });

  test("JM4 renews an expired presigned UploadPart URL", async ({}, testInfo) => {
    test.skip(!R2 || !RUN_URL_EXPIRY, `${missingR2Message()} Set REFERENCE_MEDIA_RUN_URL_EXPIRY=1 to run JM4.`);
    test.setTimeout(600_000);

    let configured: ConfiguredReference | null = null;
    try {
      configured = await configureReference(testInfo, {
        receiver: {
          partSizeBytes: 5 * MiB,
          uploadUrlTtlSeconds: 2,
          partSignResponseDelayMsOnce: 4_500,
        },
      });
      const recordingId = await createRecording(configured);
      const retained = await retainedOpfsMedia(configured.harness.controlPage, recordingId);
      expect(await resizeRetainedOpfsFixture(
        configured.harness.controlPage,
        retained.key,
        EXPIRY_FIXTURE_BYTES,
      )).toBe(EXPIRY_FIXTURE_BYTES);
      expect(await confirmHeldRoutes(configured.harness.controlPage, recordingId))
        .toEqual(expect.objectContaining({ ok: true }));
      const transfers = await waitForTransfersAcknowledged(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
        480_000,
      );
      expect(transfers).toEqual([
        expect.objectContaining({
          state: "acknowledged",
          bytesUploaded: EXPIRY_FIXTURE_BYTES,
          bytesTotal: EXPIRY_FIXTURE_BYTES,
        }),
      ]);
      expect(await externalMediaJournal(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
      )).toMatchObject({ state: "acknowledged" });
    } finally {
      await closeConfigured(configured);
    }
  });

  test("JM5 replaces an expired upload attempt while preserving transfer and artifact identity", async ({}, testInfo) => {
    test.skip(!R2 || !RUN_ATTEMPT_EXPIRY, `${missingR2Message()} Set REFERENCE_MEDIA_RUN_ATTEMPT_EXPIRY=1 to run JM5.`);
    test.setTimeout(600_000);

    let configured: ConfiguredReference | null = null;
    try {
      configured = await configureReference(testInfo, {
        receiver: {
          partSizeBytes: 5 * MiB,
          uploadAttemptTtlMs: 5_000,
          partSignResponseDelayMsOnce: 7_000,
        },
      });
      const recordingId = await createRecording(configured);
      const retained = await retainedOpfsMedia(configured.harness.controlPage, recordingId);
      expect(await resizeRetainedOpfsFixture(
        configured.harness.controlPage,
        retained.key,
        EXPIRY_FIXTURE_BYTES,
      )).toBe(EXPIRY_FIXTURE_BYTES);
      expect(await confirmHeldRoutes(configured.harness.controlPage, recordingId))
        .toEqual(expect.objectContaining({ ok: true }));

      let firstAttempt: any;
      await expect.poll(async () => {
        firstAttempt = await externalMediaJournal(
          configured!.harness.controlPage,
          recordingId,
          configured!.destination.id,
        );
        return Boolean(firstAttempt?.clientTransferId || firstAttempt?.request?.clientTransferId)
          && Boolean(firstAttempt?.artifactId) && Boolean(firstAttempt?.uploadId);
      }, { timeout: 30_000, intervals: [100, 250, 500] }).toBe(true);
      const identity = {
        clientTransferId: firstAttempt.request.clientTransferId,
        artifactId: firstAttempt.artifactId,
        uploadId: firstAttempt.uploadId,
      };

      await waitForTransfersAcknowledged(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
        480_000,
      );
      const final = await externalMediaJournal(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
      );
      expect(final).toMatchObject({ state: "acknowledged", artifactId: identity.artifactId });
      expect(final.request.clientTransferId).toBe(identity.clientTransferId);
      expect(final.uploadId).not.toBe(identity.uploadId);
    } finally {
      await closeConfigured(configured);
    }
  });

  test("JM6 refreshes expired playback URLs and keeps external tab, mic, and camera tracks seekable", async ({}, testInfo) => {
    test.skip(!R2 || !RUN_PLAYBACK_EXPIRY, `${missingR2Message()} Set REFERENCE_MEDIA_RUN_PLAYBACK_EXPIRY=1 to run JM6.`);
    test.setTimeout(600_000);

    let configured: ConfiguredReference | null = null;
    try {
      configured = await configureReference(testInfo, {
        receiver: { playbackUrlTtlSeconds: 2 },
      });
      const recordingId = await createRecording(configured, {
        micMode: "separate",
        recordSelfVideo: true,
        captureMs: 4_000,
      });
      expect((await historyEntry(configured.harness.controlPage, recordingId)).files.filter((file) => !file.kind))
        .toHaveLength(3);
      expect(await confirmHeldRoutes(configured.harness.controlPage, recordingId))
        .toEqual(expect.objectContaining({ ok: true }));
      expect(await waitForTransfersAcknowledged(
        configured.harness.controlPage,
        recordingId,
        configured.destination.id,
        480_000,
      )).toHaveLength(3);

      const tracks = await projectHistoryToExternalOnly(
        configured.harness.controlPage,
        recordingId,
      );
      expect(tracks).toHaveLength(3);
      const player = await configured.harness.context.newPage();
      const rangeReads: string[] = [];
      player.on("request", (request) => {
        try {
          const url = new URL(request.url());
          if (request.method() === "GET" && url.origin === R2!.uploadOrigin) {
            const range = request.headers()["range"];
            if (range) rangeReads.push(range);
          }
        } catch {
          // Ignore browser-internal URLs.
        }
      });
      await player.goto(`chrome-extension://${configured.harness.extensionId}/recordings.html`, {
        waitUntil: "domcontentloaded",
      });
      await expect(player.locator(".recording-row").first()).toBeVisible({ timeout: 20_000 });
      await player.locator(".recording-row").first().click();
      await player.locator(".modal-button--watch").click();
      await expect(player.locator(".player")).toBeVisible();

      const video = player.locator(".player__video");
      const selfcam = player.locator(".player__selfcam");
      const microphone = player.locator(".player__aux audio");
      for (const element of [video, selfcam, microphone]) {
        await expect.poll(async () => element.evaluate((media: HTMLMediaElement) =>
          media.src ? new URL(media.src).origin : ""), { timeout: 30_000 }).toBe(R2!.uploadOrigin);
        await expect.poll(async () => element.evaluate((media: HTMLMediaElement) => media.readyState),
          { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      }

      for (let expiration = 0; expiration < 2; expiration += 1) {
        const expiredUrl = await video.evaluate((media: HTMLMediaElement) => media.src);
        await player.waitForTimeout(3_000);
        await video.evaluate((media: HTMLMediaElement) => media.load());
        await expect.poll(async () => video.evaluate((media: HTMLMediaElement) => media.src), {
          timeout: 30_000,
          intervals: [100, 250, 500, 1_000],
        }).not.toBe(expiredUrl);
        await expect.poll(async () => video.evaluate((media: HTMLMediaElement) =>
          media.src ? new URL(media.src).origin : ""), { timeout: 30_000 }).toBe(R2!.uploadOrigin);
        await expect.poll(async () => video.evaluate((media: HTMLMediaElement) => media.readyState),
          { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
      }

      await video.evaluate(async (media: HTMLVideoElement) => {
        media.currentTime = 1.5;
        await media.play().catch(() => {});
      });
      await expect.poll(async () => video.evaluate((media: HTMLVideoElement) => media.currentTime),
        { timeout: 15_000 }).toBeGreaterThan(1.4);
      await expect.poll(async () => microphone.evaluate((media: HTMLAudioElement) => media.currentTime),
        { timeout: 15_000 }).toBeGreaterThan(1.0);
      const spread = await player.evaluate(() => {
        const tab = document.querySelector(".player__video") as HTMLVideoElement;
        const cam = document.querySelector(".player__selfcam") as HTMLVideoElement;
        const mic = document.querySelector(".player__aux audio") as HTMLAudioElement;
        return [Math.abs(cam.currentTime - tab.currentTime), Math.abs(mic.currentTime - tab.currentTime)];
      });
      for (const delta of spread) expect(delta).toBeLessThan(0.6);
      await expect.poll(() => rangeReads.length, { timeout: 20_000 }).toBeGreaterThan(0);
      expect(rangeReads.every((range) => /^bytes=\d+-/i.test(range))).toBe(true);
    } finally {
      await closeConfigured(configured);
    }
  });
});

async function configureReference(
  testInfo: TestInfo,
  options: {
    pregrantUpload?: boolean;
    configureMedia?: boolean;
    receiver?: Partial<Omit<ReferenceMediaReceiverConfig, "webhookSecret" | "mediaBearer" | "s3">>;
  } = {},
): Promise<ConfiguredReference> {
  if (!R2) throw new Error(missingR2Message());
  const mediaBearer = `reference_${randomUUID()}`;
  const receiver = await startReferenceMediaReceiverProcess(
    testInfo.outputPath("reference-media-receiver"),
    {
      webhookSecret: `whsec_${Buffer.alloc(32, 19).toString("base64")}`,
      mediaBearer,
      s3: R2,
      ...options.receiver,
    },
  );
  let harness: ExtensionHarness | null = null;
  try {
    const extensionPath = await prepareReferenceExtension(
      testInfo.outputPath("reference-media-extension"),
      receiver.origin,
      R2.uploadOrigin,
      options.pregrantUpload ?? true,
    );
    harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo), {
      extensionPath,
      ignoreHTTPSErrors: true,
    });
    const created = await createIntegration(harness.controlPage, receiver.webhookUrl);
    await receiver.restart({ webhookSecret: created.signingSecret });
    if (options.configureMedia !== false) {
      const discovery = await testIntegration(harness.controlPage, created.destination.id);
      expect(discovery.result.mediaCapability).toEqual({
        version: 1,
        apiBase: `${receiver.origin}/media`,
        upload: { strategy: "multipart-put-v1", origins: [R2.uploadOrigin] },
        playback: { strategy: "refreshable-url-v1" },
      });
      await configureMedia(harness.controlPage, created.destination.id, mediaBearer);
    }
    return {
      receiver,
      harness,
      destination: created.destination,
      profile: created.profile,
      mediaBearer,
    };
  } catch (error) {
    if (harness) await closeHarness(harness).catch(() => {});
    await receiver.stop().catch(() => {});
    throw error;
  }
}

async function closeConfigured(configured: ConfiguredReference | null): Promise<void> {
  if (!configured) return;
  await closeHarness(configured.harness).catch(() => {});
  await configured.receiver.stop().catch(() => {});
}

async function prepareReferenceExtension(
  destination: string,
  receiverOrigin: string,
  uploadOrigin: string,
  pregrantUpload: boolean,
): Promise<string> {
  const source = path.resolve(process.cwd(), process.env.EXTENSION_PATH ?? "dist-e2e");
  await fs.cp(source, destination, { recursive: true });
  const manifestPath = path.join(destination, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    host_permissions?: string[];
  };
  const grants = [chromeHostPermission(receiverOrigin)];
  if (pregrantUpload) grants.push(chromeHostPermission(uploadOrigin));
  manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions ?? []), ...grants]));
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

function chromeHostPermission(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

async function hasHostPermission(page: Page, origin: string): Promise<boolean> {
  const pattern = chromeHostPermission(origin);
  return page.evaluate(async (hostPattern) =>
    await chrome.permissions.contains({ origins: [hostPattern] }), pattern);
}

async function createIntegration(
  page: Page,
  endpoint: string,
): Promise<{
  destination: { id: string };
  signingSecret: string;
  profile: { id: string };
}> {
  const response = await sendRuntimeMessage<any>(page, {
    type: "CREATE_INTEGRATION",
    input: {
      name: "Reference media receiver",
      endpoint,
      routingDefault: "manual",
      dataPolicy: METADATA_POLICY,
      requestAuth: { type: "none" },
    },
  });
  if (!response?.ok || !response.created?.destination?.id ||
      !response.created?.signingSecret || !response.profile?.id) {
    throw new Error(`CREATE_INTEGRATION failed: ${response?.error ?? "incomplete response"}`);
  }
  return { ...response.created, profile: response.profile };
}

async function testIntegration(page: Page, destinationId: string): Promise<any> {
  const response = await sendRuntimeMessage<any>(page, {
    type: "TEST_INTEGRATION",
    destinationId,
  });
  if (!response?.ok) throw new Error(`TEST_INTEGRATION failed: ${response?.error}`);
  return response;
}

async function configureMedia(page: Page, destinationId: string, bearer: string): Promise<void> {
  const configured = await sendRuntimeMessage<any>(page, {
    type: "CONFIGURE_INTEGRATION_MEDIA",
    destinationId,
    bearer,
  });
  if (!configured?.ok) throw new Error(`CONFIGURE_INTEGRATION_MEDIA failed: ${configured?.error}`);
}

async function createRecording(
  configured: ConfiguredReference,
  options: {
    micMode?: "off" | "mixed" | "separate";
    recordSelfVideo?: boolean;
    captureMs?: number;
  } = {},
): Promise<string> {
  const meet = await openMockMeetPage(configured.harness.context);
  const tabId = await findMockMeetTabId(configured.harness.controlPage);
  await saveRecordingSettings(configured.harness.controlPage, {
    recordingMode: "opfs",
    micMode: options.micMode ?? "off",
    recordSelfVideo: options.recordSelfVideo ?? false,
  });
  return record(
    configured.harness.controlPage,
    meet,
    tabId,
    configured.profile.id,
    options,
  );
}

async function record(
  page: Page,
  meet: Page,
  tabId: number,
  destinationProfileId: string,
  options: {
    micMode?: "off" | "mixed" | "separate";
    recordSelfVideo?: boolean;
    captureMs?: number;
  } = {},
): Promise<string> {
  const response = await sendRuntimeMessage<any>(page, {
    type: "START_RECORDING",
    tabId,
    runConfig: {
      storageMode: "local",
      micMode: options.micMode ?? "off",
      recordSelfVideo: options.recordSelfVideo ?? false,
      destinationProfileId,
    },
  });
  if (!response?.ok) throw new Error(`START_RECORDING failed: ${response?.error}`);
  await waitForSessionPhase(page, "recording", 30_000);
  const recordingId = await page.evaluate(async () =>
    ((await chrome.storage.session.get("recordingSession")) as any)?.recordingSession?.historyId as string | undefined);
  if (!recordingId) throw new Error("Recording session did not expose its history id");
  await meet.waitForTimeout(options.captureMs ?? 2_500);
  await stopRecording(page);
  return recordingId;
}

async function recordingRoutes(page: Page, recordingId: string): Promise<any[]> {
  const response = await sendRuntimeMessage<any>(page, {
    type: "GET_RECORDING_ROUTES",
    recordingId,
  });
  if (!response?.ok) throw new Error(`GET_RECORDING_ROUTES failed: ${response?.error}`);
  return response.routes;
}

async function confirmHeldRoutes(page: Page, recordingId: string): Promise<any> {
  const decisions = (await recordingRoutes(page, recordingId)).flatMap((route) =>
    route.state === "held" ? [{ destinationId: route.destinationId, action: "release" as const }] : []);
  return sendRuntimeMessage<any>(page, {
    type: "CONFIRM_RECORDING_ROUTES",
    recordingId,
    decisions,
  });
}

async function waitForTransfersAcknowledged(
  page: Page,
  recordingId: string,
  destinationId: string,
  timeoutMs = 180_000,
): Promise<any[]> {
  let last: any[] = [];
  await expect.poll(async () => {
    const response = await sendRuntimeMessage<any>(page, {
      type: "LIST_EXTERNAL_MEDIA_TRANSFERS",
      recordingId,
    });
    if (!response?.ok) throw new Error(`LIST_EXTERNAL_MEDIA_TRANSFERS failed: ${response?.error}`);
    last = response.transfers.filter((transfer: any) => transfer.destinationId === destinationId);
    const failed = last.find((transfer) => transfer.state === "action-required");
    if (failed) throw new Error(`External media transfer requires action: ${failed.errorCategory ?? "unknown"}`);
    return last.length > 0 && last.every((transfer) => transfer.state === "acknowledged");
  }, { timeout: timeoutMs, intervals: [250, 500, 1_000, 2_000, 5_000] }).toBe(true);
  return last;
}

async function historyEntry(page: Page, recordingId: string): Promise<RecordingHistoryEntry> {
  const response = await sendRuntimeMessage<any>(page, { type: "LIST_RECORDING_HISTORY" });
  if (!response?.ok) throw new Error(`LIST_RECORDING_HISTORY failed: ${response?.error}`);
  const entry = (response.entries as RecordingHistoryEntry[]).find((candidate) => candidate.id === recordingId);
  if (!entry) throw new Error("Completed recording is missing from extension history");
  return entry;
}

function firstExternalMedia(entry: RecordingHistoryEntry, destinationId: string) {
  for (const file of entry.files) {
    if (file.kind) continue;
    const location = file.locations.find((candidate) =>
      candidate.kind === "external" && candidate.destinationId === destinationId);
    if (location?.kind === "external") return { file, artifactId: location.artifactId };
  }
  throw new Error("Recording has no external media replica");
}

async function retainedOpfsMedia(page: Page, recordingId: string): Promise<{ key: string }> {
  const entry = await historyEntry(page, recordingId);
  for (const file of entry.files) {
    if (file.kind) continue;
    const location = file.locations.find((candidate) => candidate.kind === "opfs");
    if (location?.kind === "opfs") return { key: location.key };
  }
  throw new Error("Recording has no retained OPFS media");
}

async function resizeRetainedOpfsFixture(page: Page, key: string, bytes: number): Promise<number> {
  return page.evaluate(async ({ key, bytes }) => {
    const segments = key.split("/").filter(Boolean);
    const filename = segments.pop();
    if (!filename || bytes <= 0) throw new Error("Invalid reference media fixture request");
    let directory = await navigator.storage.getDirectory();
    for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
    const handle = await directory.getFileHandle(filename);
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.truncate(bytes);
      await writable.seek(bytes - 1);
      await writable.write(new Uint8Array([0x7f]));
    } finally {
      await writable.close();
    }
    return (await handle.getFile()).size;
  }, { key, bytes });
}

async function externalMediaJournal(page: Page, recordingId: string, destinationId: string): Promise<any> {
  return page.evaluate(async ({ recordingId, destinationId }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("pending-external-media-transfers");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction("transfers", "readonly");
      const rows = await new Promise<any[]>((resolve, reject) => {
        const request = transaction.objectStore("transfers").getAll();
        request.onsuccess = () => resolve(request.result as any[]);
        request.onerror = () => reject(request.error);
      });
      return rows.find((row) => row?.destinationId === destinationId && row?.owner?.recordingId === recordingId);
    } finally {
      database.close();
    }
  }, { recordingId, destinationId });
}

async function prepareExternalPlayback(
  page: Page,
  input: { recordingId: string; fileId: string; destinationId: string; artifactId: string },
): Promise<{ ok: boolean; url?: string; error?: string }> {
  return page.evaluate(async (request) =>
    await chrome.runtime.sendMessage({ type: "PREPARE_EXTERNAL_PLAYBACK_SOURCE", ...request }), input);
}

async function openRecordingsPage(harness: ExtensionHarness): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
    waitUntil: "domcontentloaded",
  });
  return page;
}

async function rangedRead(page: Page, url: string, range: string) {
  return page.evaluate(async ({ url, range }) => {
    const response = await fetch(url, {
      headers: { Range: range },
      credentials: "omit",
      cache: "no-store",
    });
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      bytes: (await response.arrayBuffer()).byteLength,
    };
  }, { url, range });
}

async function proveBrowserPlayback(page: Page, url: string, mimeType: string): Promise<void> {
  const result = await page.evaluate(async ({ mediaUrl, type }) => {
    const element = document.createElement(type.startsWith("audio/") ? "audio" : "video");
    element.muted = true;
    element.preload = "auto";
    element.src = mediaUrl;
    document.body.append(element);
    const wait = (event: string, timeoutMs = 20_000) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeoutMs);
      element.addEventListener(event, () => { clearTimeout(timer); resolve(); }, { once: true });
      element.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Media error ${element.error?.code ?? "unknown"}`));
      }, { once: true });
    });
    await wait("loadedmetadata");
    await element.play();
    await wait("timeupdate");
    const duration = element.duration;
    if (Number.isFinite(duration) && duration > 0.4) {
      element.currentTime = Math.min(duration / 2, 1);
      await wait("seeked");
    }
    const currentTime = element.currentTime;
    element.remove();
    return { duration, currentTime };
  }, { mediaUrl: url, type: mimeType });
  expect(result.currentTime).toBeGreaterThanOrEqual(0);
}

async function projectHistoryToExternalOnly(
  page: Page,
  recordingId: string,
): Promise<Array<{ fileId: string; stream: string; artifactId: string }>> {
  return page.evaluate(async (recordingId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("recording-history");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction("recordings", "readwrite");
      const store = transaction.objectStore("recordings");
      const entry = await new Promise<any>((resolve, reject) => {
        const request = store.get(recordingId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!entry) throw new Error("JM6 recording is missing from history");
      const tracks: Array<{ fileId: string; stream: string; artifactId: string }> = [];
      for (const file of entry.files ?? []) {
        if (file.kind) continue;
        const external = (file.locations ?? []).filter((location: any) => location.kind === "external");
        if (external.length !== 1) throw new Error(`JM6 expected one external replica for ${file.stream}`);
        file.locations = external;
        tracks.push({ fileId: file.id, stream: file.stream, artifactId: external[0].artifactId });
      }
      store.put(entry);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      return tracks;
    } finally {
      database.close();
    }
  }, recordingId);
}

function readR2Config(): R2Config | undefined {
  const endpoint = firstEnv("REFERENCE_MEDIA_S3_ENDPOINT", "S3_ENDPOINT", "MEETING_RECORDER_MEDIA_S3_ENDPOINT");
  const bucket = firstEnv("REFERENCE_MEDIA_S3_BUCKET", "S3_BUCKET", "MEETING_RECORDER_MEDIA_S3_BUCKET");
  const accessKeyId = firstEnv(
    "REFERENCE_MEDIA_AWS_ACCESS_KEY_ID",
    "AWS_ACCESS_KEY_ID",
    "MEETING_RECORDER_MEDIA_AWS_ACCESS_KEY_ID",
  );
  const secretAccessKey = firstEnv(
    "REFERENCE_MEDIA_AWS_SECRET_ACCESS_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "MEETING_RECORDER_MEDIA_AWS_SECRET_ACCESS_KEY",
  );
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  const parsed = new URL(endpoint);
  const uploadOrigin = firstEnv("REFERENCE_MEDIA_S3_UPLOAD_ORIGIN", "R0_R2_UPLOAD_ORIGIN")
    ?? `${parsed.protocol}//${bucket}.${parsed.host}`;
  return {
    endpoint,
    bucket,
    region: firstEnv("REFERENCE_MEDIA_S3_REGION", "S3_REGION", "MEETING_RECORDER_MEDIA_S3_REGION") ?? "auto",
    forcePathStyle: false,
    accessKeyId,
    secretAccessKey,
    uploadOrigin,
  };
}

function firstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function missingR2Message(): string {
  return "Set REFERENCE_MEDIA_S3_ENDPOINT, REFERENCE_MEDIA_S3_BUCKET, REFERENCE_MEDIA_AWS_ACCESS_KEY_ID, and REFERENCE_MEDIA_AWS_SECRET_ACCESS_KEY (or their S3/AWS aliases) to run the real-R2 reference receiver suite.";
}
