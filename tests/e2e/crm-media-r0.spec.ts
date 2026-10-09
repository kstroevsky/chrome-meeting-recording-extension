import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
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
  startHttpsReverseProxy,
  type HttpsReverseProxy,
} from "./helpers/httpsReverseProxy";

const CRM_UPSTREAM = process.env.R0_CRM_UPSTREAM;
const CRM_PUBLIC_ORIGIN =
  process.env.R0_CRM_PUBLIC_ORIGIN ?? "https://127.0.0.1:3443";
const R2_UPLOAD_ORIGIN = process.env.R0_R2_UPLOAD_ORIGIN;
const CRM_ADMIN_EMAIL =
  process.env.R0_CRM_ADMIN_EMAIL ?? "yaremenkomaksym99@gmail.com";
const RUN_LARGE_TRANSFER = process.env.R0_RUN_LARGE_TRANSFER === "1";
const RUN_RESTART_RECOVERY = process.env.R0_RUN_RESTART_RECOVERY === "1";
const RUN_URL_EXPIRY = process.env.R0_RUN_URL_EXPIRY === "1";
const RUN_ATTEMPT_EXPIRY = process.env.R0_RUN_ATTEMPT_EXPIRY === "1";
const RUN_PLAYBACK_EXPIRY = process.env.R0_RUN_PLAYBACK_EXPIRY === "1";
const RUN_AUTH_ISOLATION = process.env.R0_RUN_AUTH_ISOLATION === "1";
const RUN_LIFECYCLE = process.env.R0_RUN_LIFECYCLE === "1";
const RUN_PROTOCOL_HARDENING =
  process.env.R0_RUN_PROTOCOL_HARDENING === "1";
const LARGE_FIXTURE_BYTES = 1024 * 1024 * 1024 + 12_345;
const RESTART_FIXTURE_BYTES = 256 * 1024 * 1024 + 12_345;
const URL_EXPIRY_FIXTURE_BYTES = 64 * 1024 * 1024 + 12_345;
const ATTEMPT_EXPIRY_FIXTURE_BYTES = 64 * 1024 * 1024 + 12_345;

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

test.describe("CRM real-R2 media pilot @r0-real-media", () => {
  test.describe.configure({ mode: "serial" });

  test("uploads a real recording to R2, associates it in CRM, and range-plays it", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN,
      "Set R0_CRM_UPSTREAM and R0_R2_UPLOAD_ORIGIN to run the destructive real-R2 pilot.",
    );
    test.setTimeout(360_000);

    let proxy: HttpsReverseProxy | null = null;
    let harness: ExtensionHarness | null = null;
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
      );
      const extensionPath = await preparePilotExtension(
        testInfo.outputPath("crm-r0-extension"),
        proxy.origin,
        R2_UPLOAD_ORIGIN!,
      );
      harness = await launchExtensionHarness(
        testInfo.outputPath.bind(testInfo),
        {
          extensionPath,
          ignoreHTTPSErrors: true,
        },
      );

      const admin = harness.context.request;
      await crmLogin(admin, proxy.origin);
      const connection = await crmCreateConnection(admin, proxy.origin);

      const created = await createIntegration(
        harness.controlPage,
        `${proxy.origin}${connection.webhookPath}`,
      );
      await crmSetSigningSecret(
        admin,
        proxy.origin,
        connection.id,
        created.signingSecret,
      );
      const mediaBearer = await crmReplaceMediaToken(
        admin,
        proxy.origin,
        connection.id,
      );

      const discovery = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "TEST_INTEGRATION",
        destinationId: created.destination.id,
      });
      expect(discovery).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            ok: true,
            status: 200,
            mediaCapability: expect.objectContaining({
              version: 1,
              apiBase: `${proxy.origin}/api/integrations/meeting-recorder/media`,
              upload: expect.objectContaining({
                strategy: "multipart-put-v1",
                origins: [R2_UPLOAD_ORIGIN],
              }),
              playback: { strategy: "refreshable-url-v1" },
            }),
          }),
        }),
      );

      const configured = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "CONFIGURE_INTEGRATION_MEDIA",
        destinationId: created.destination.id,
        bearer: mediaBearer,
      });
      expect(configured).toEqual({ ok: true });

      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: "opfs",
        micMode: "off",
        recordSelfVideo: false,
      });
      const recordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        created.profile.id,
      );

      const routeBeforeRelease = await recordingRoutes(
        harness.controlPage,
        recordingId,
      );
      expect(routeBeforeRelease).toEqual([
        expect.objectContaining({
          destinationId: created.destination.id,
          state: "held",
          includesMedia: true,
        }),
      ]);
      const confirmed = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "CONFIRM_RECORDING_ROUTES",
        recordingId,
        removedDestinationIds: [],
      });
      expect(confirmed.ok).toBe(true);

      const transfers = await waitForTransfersAcknowledged(
        harness.controlPage,
        recordingId,
        created.destination.id,
      );
      expect(transfers.length).toBeGreaterThan(0);
      expect(
        transfers.every(
          (transfer) => transfer.bytesUploaded === transfer.bytesTotal,
        ),
      ).toBe(true);

      const history = await historyEntry(harness.controlPage, recordingId);
      const mediaFiles = history.files.filter(
        (file) =>
          !file.kind &&
          (file.mimeType.startsWith("video/") ||
            file.mimeType.startsWith("audio/")),
      );
      expect(mediaFiles.length).toBeGreaterThan(0);
      for (const file of mediaFiles) {
        // R0 retains the original OPFS source even after remote playback is proven.
        expect(
          file.locations.some((location) => location.kind === "opfs"),
        ).toBe(true);
        expect(
          file.locations.some(
            (location) =>
              location.kind === "external" &&
              location.destinationId === created.destination.id,
          ),
        ).toBe(true);
      }

      const crmRecording = await waitForCrmRecording(
        admin,
        proxy.origin,
        connection.id,
      );
      const crmMedia = await crmGet<any[]>(
        admin,
        proxy.origin,
        `/api/interview-recordings/${crmRecording.id}/media`,
      );
      const external = mediaFiles.flatMap((file) =>
        file.locations.filter(
          (location) =>
            location.kind === "external" &&
            location.destinationId === created.destination.id,
        ),
      );
      expect(crmMedia.map((artifact) => artifact.artifactId).sort()).toEqual(
        external.map((location: any) => location.artifactId).sort(),
      );

      const first = crmMedia[0];
      expect(first).toBeTruthy();
      const playback = await crmPost<{ url: string; expiresAt: string }>(
        admin,
        proxy.origin,
        `/api/interview-recordings/${crmRecording.id}/media/${first.artifactId}/playback`,
      );
      expect(new URL(playback.url).origin).toBe(R2_UPLOAD_ORIGIN);

      const player = await harness.context.newPage();
      await player.goto(
        `chrome-extension://${harness.extensionId}/recordings.html`,
        {
          waitUntil: "domcontentloaded",
        },
      );
      const ranged = await player.evaluate(async (url) => {
        const response = await fetch(url, {
          headers: { Range: "bytes=0-1023" },
          credentials: "omit",
          cache: "no-store",
        });
        return {
          status: response.status,
          contentRange: response.headers.get("content-range"),
          bytes: (await response.arrayBuffer()).byteLength,
        };
      }, playback.url);
      expect(ranged.status).toBe(206);
      expect(ranged.contentRange).toMatch(/^bytes 0-\d+\/\d+$/);
      expect(ranged.bytes).toBeGreaterThan(0);
      await proveBrowserPlayback(player, playback.url, first.mimeType);

      const publications = await sharePublications(harness.controlPage);
      expect(publications).toEqual([]);
    } finally {
      if (harness) await closeHarness(harness).catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });

  test("uploads a >=1 GiB retained artifact with exact multipart sizing", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN || !RUN_LARGE_TRANSFER,
      "Set R0_RUN_LARGE_TRANSFER=1 with the real-R2 pilot variables to run JM2.",
    );
    test.setTimeout(1_800_000);

    let proxy: HttpsReverseProxy | null = null;
    let harness: ExtensionHarness | null = null;
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-large-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
      );
      const extensionPath = await preparePilotExtension(
        testInfo.outputPath("crm-r0-large-extension"),
        proxy.origin,
        R2_UPLOAD_ORIGIN!,
      );
      harness = await launchExtensionHarness(
        testInfo.outputPath.bind(testInfo),
        {
          extensionPath,
          ignoreHTTPSErrors: true,
        },
      );

      const admin = harness.context.request;
      await crmLogin(admin, proxy.origin);
      const connection = await crmCreateConnection(admin, proxy.origin);
      const created = await createIntegration(
        harness.controlPage,
        `${proxy.origin}${connection.webhookPath}`,
      );
      await crmSetSigningSecret(
        admin,
        proxy.origin,
        connection.id,
        created.signingSecret,
      );
      const mediaBearer = await crmReplaceMediaToken(
        admin,
        proxy.origin,
        connection.id,
      );
      const discovery = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "TEST_INTEGRATION",
        destinationId: created.destination.id,
      });
      expect(discovery?.result?.mediaCapability?.upload).toEqual(
        expect.objectContaining({
          strategy: "multipart-put-v1",
          origins: [R2_UPLOAD_ORIGIN],
        }),
      );
      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "CONFIGURE_INTEGRATION_MEDIA",
          destinationId: created.destination.id,
          bearer: mediaBearer,
        }),
      ).toEqual({ ok: true });

      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: "opfs",
        micMode: "off",
        recordSelfVideo: false,
      });
      const recordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        created.profile.id,
      );
      const before = await historyEntry(harness.controlPage, recordingId);
      const retained = before.files.find(
        (file) => !file.kind && file.locations.some((location) => location.kind === "opfs"),
      );
      if (!retained) throw new Error("JM2 recording has no retained OPFS media");
      const opfs = retained.locations.find((location) => location.kind === "opfs");
      if (!opfs || opfs.kind !== "opfs") throw new Error("JM2 OPFS location is missing");
      expect(
        await resizeRetainedOpfsFixture(
          harness.controlPage,
          opfs.key,
          LARGE_FIXTURE_BYTES,
        ),
      ).toBe(LARGE_FIXTURE_BYTES);

      const routeBeforeRelease = await recordingRoutes(
        harness.controlPage,
        recordingId,
      );
      expect(routeBeforeRelease).toEqual([
        expect.objectContaining({
          destinationId: created.destination.id,
          state: "held",
          includesMedia: true,
        }),
      ]);
      const confirmed = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "CONFIRM_RECORDING_ROUTES",
        recordingId,
        removedDestinationIds: [],
      });
      expect(confirmed.ok).toBe(true);

      const transfers = await waitForTransfersAcknowledged(
        harness.controlPage,
        recordingId,
        created.destination.id,
        1_500_000,
      );
      expect(transfers).toHaveLength(1);
      expect(transfers[0]).toMatchObject({
        state: "acknowledged",
        bytesUploaded: LARGE_FIXTURE_BYTES,
        bytesTotal: LARGE_FIXTURE_BYTES,
      });

      const journal = await externalMediaJournal(
        harness.controlPage,
        recordingId,
        created.destination.id,
      );
      expect(journal).toBeTruthy();
      expect(journal.request.artifact.bytes).toBe(LARGE_FIXTURE_BYTES);
      expect(journal.state).toBe("acknowledged");
      expect(Number.isSafeInteger(journal.partSize) && journal.partSize > 0).toBe(true);
      const expectedPartCount = Math.ceil(LARGE_FIXTURE_BYTES / journal.partSize);
      expect(journal.uploadedParts).toHaveLength(expectedPartCount);
      expect(new Set(journal.uploadedParts.map((part: any) => part.partNumber)).size)
        .toBe(expectedPartCount);
      const finalPartBytes =
        LARGE_FIXTURE_BYTES - (expectedPartCount - 1) * journal.partSize;
      expect(finalPartBytes).toBeGreaterThan(0);
      expect(finalPartBytes).toBeLessThanOrEqual(journal.partSize);

      const crmRecording = await waitForCrmRecording(
        admin,
        proxy.origin,
        connection.id,
      );
      const crmMedia = await crmGet<any[]>(
        admin,
        proxy.origin,
        `/api/interview-recordings/${crmRecording.id}/media`,
      );
      const artifact = crmMedia.find((item) => item.bytes === LARGE_FIXTURE_BYTES);
      expect(artifact).toBeTruthy();
      const playback = await crmPost<{ url: string; expiresAt: string }>(
        admin,
        proxy.origin,
        `/api/interview-recordings/${crmRecording.id}/media/${artifact.artifactId}/playback`,
      );
      const player = await harness.context.newPage();
      await player.goto(
        `chrome-extension://${harness.extensionId}/recordings.html`,
        { waitUntil: "domcontentloaded" },
      );
      const tail = await player.evaluate(
        async ({ url, start, end }) => {
          const response = await fetch(url, {
            headers: { Range: `bytes=${start}-${end}` },
            credentials: "omit",
            cache: "no-store",
          });
          return {
            status: response.status,
            contentRange: response.headers.get("content-range"),
            bytes: (await response.arrayBuffer()).byteLength,
          };
        },
        {
          url: playback.url,
          start: LARGE_FIXTURE_BYTES - 1024,
          end: LARGE_FIXTURE_BYTES - 1,
        },
      );
      expect(tail).toEqual({
        status: 206,
        contentRange: `bytes ${LARGE_FIXTURE_BYTES - 1024}-${LARGE_FIXTURE_BYTES - 1}/${LARGE_FIXTURE_BYTES}`,
        bytes: 1024,
      });

      await testInfo.attach("jm2-large-transfer-evidence.json", {
        body: JSON.stringify(
          {
            bytes: LARGE_FIXTURE_BYTES,
            partSize: journal.partSize,
            partCount: expectedPartCount,
            finalPartBytes,
            transferState: transfers[0].state,
            crmArtifactBytes: artifact.bytes,
            tailRangeStatus: tail.status,
            tailContentRange: tail.contentRange,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      if (harness) await closeHarness(harness).catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });

  test("resumes the same multipart artifact after a browser restart", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN || !RUN_RESTART_RECOVERY,
      "Set R0_RUN_RESTART_RECOVERY=1 with the real-R2 pilot variables to run JM3.",
    );
    test.setTimeout(1_200_000);

    let proxy: HttpsReverseProxy | null = null;
    let harness: ExtensionHarness | null = null;
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-restart-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
      );
      const extensionPath = await preparePilotExtension(
        testInfo.outputPath("crm-r0-restart-extension"),
        proxy.origin,
        R2_UPLOAD_ORIGIN!,
      );
      harness = await launchExtensionHarness(
        testInfo.outputPath.bind(testInfo),
        { extensionPath, ignoreHTTPSErrors: true },
      );
      const configured = await configureRealR2Destination(harness, proxy.origin);

      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: "opfs",
        micMode: "off",
        recordSelfVideo: false,
      });
      const recordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        configured.created.profile.id,
      );
      const before = await historyEntry(harness.controlPage, recordingId);
      const retained = before.files.find(
        (file) => !file.kind && file.locations.some((location) => location.kind === "opfs"),
      );
      const opfs = retained?.locations.find((location) => location.kind === "opfs");
      if (!retained || !opfs || opfs.kind !== "opfs") {
        throw new Error("JM3 recording has no retained OPFS media");
      }
      expect(
        await resizeRetainedOpfsFixture(
          harness.controlPage,
          opfs.key,
          RESTART_FIXTURE_BYTES,
        ),
      ).toBe(RESTART_FIXTURE_BYTES);

      const confirmed = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "CONFIRM_RECORDING_ROUTES",
        recordingId,
        removedDestinationIds: [],
      });
      expect(confirmed.ok).toBe(true);

      let beforeRestart: any;
      await expect.poll(
        async () => {
          beforeRestart = await externalMediaJournal(
            harness!.controlPage,
            recordingId,
            configured.created.destination.id,
          );
          return Boolean(
            beforeRestart?.state === "uploading" &&
              beforeRestart?.uploadedParts?.length > 0 &&
              beforeRestart?.uploadedParts?.length <
                Math.ceil(RESTART_FIXTURE_BYTES / beforeRestart.partSize),
          );
        },
        { timeout: 240_000, intervals: [250, 500, 1_000, 2_000] },
      ).toBe(true);
      const identityBefore = {
        clientTransferId: beforeRestart.request.clientTransferId,
        artifactId: beforeRestart.artifactId,
        uploadId: beforeRestart.uploadId,
        uploadedParts: beforeRestart.uploadedParts.length,
      };
      expect(identityBefore.artifactId).toBeTruthy();
      expect(identityBefore.uploadId).toBeTruthy();

      harness = await restartExtensionHarness(harness, {
        ignoreHTTPSErrors: true,
      });
      const transfers = await waitForTransfersAcknowledged(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
        900_000,
      );
      expect(transfers).toHaveLength(1);
      expect(transfers[0]).toMatchObject({
        clientTransferId: identityBefore.clientTransferId,
        state: "acknowledged",
        bytesUploaded: RESTART_FIXTURE_BYTES,
        bytesTotal: RESTART_FIXTURE_BYTES,
      });
      const afterRestart = await externalMediaJournal(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
      );
      expect(afterRestart).toMatchObject({
        state: "acknowledged",
        artifactId: identityBefore.artifactId,
        uploadId: identityBefore.uploadId,
      });
      expect(afterRestart.request.clientTransferId).toBe(identityBefore.clientTransferId);
      expect(afterRestart.uploadedParts.length).toBe(
        Math.ceil(RESTART_FIXTURE_BYTES / afterRestart.partSize),
      );

      const admin = harness.context.request;
      await crmLogin(admin, proxy.origin);
      const crmRecording = await waitForCrmRecording(
        admin,
        proxy.origin,
        configured.connection.id,
      );
      const crmMedia = await crmGet<any[]>(
        admin,
        proxy.origin,
        `/api/interview-recordings/${crmRecording.id}/media`,
      );
      expect(crmMedia).toEqual([
        expect.objectContaining({
          artifactId: identityBefore.artifactId,
          bytes: RESTART_FIXTURE_BYTES,
        }),
      ]);

      await testInfo.attach("jm3-restart-recovery-evidence.json", {
        body: JSON.stringify(
          {
            bytes: RESTART_FIXTURE_BYTES,
            uploadedPartsBeforeRestart: identityBefore.uploadedParts,
            clientTransferIdPreserved:
              afterRestart.request.clientTransferId === identityBefore.clientTransferId,
            artifactIdPreserved: afterRestart.artifactId === identityBefore.artifactId,
            uploadAttemptPreserved: afterRestart.uploadId === identityBefore.uploadId,
            finalPartCount: afterRestart.uploadedParts.length,
            transferState: afterRestart.state,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      if (harness) await closeHarness(harness).catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });

  test("renews an actually expired R2 part URL in Chromium", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN || !RUN_URL_EXPIRY,
      "Set R0_RUN_URL_EXPIRY=1 and a short CRM part-URL TTL to run JM4.",
    );
    test.setTimeout(600_000);

    let proxy: HttpsReverseProxy | null = null;
    let harness: ExtensionHarness | null = null;
    let partOneSignRequests = 0;
    let delayed = false;
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-url-expiry-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
        {
          responseDelayMs: ({ method, pathname }) => {
            if (
              method === "POST" &&
              /\/media\/v1\/uploads\/upload_[^/]+\/parts\/1$/.test(pathname)
            ) {
              partOneSignRequests += 1;
              if (!delayed) {
                delayed = true;
                return 4_500;
              }
            }
            return 0;
          },
        },
      );
      const extensionPath = await preparePilotExtension(
        testInfo.outputPath("crm-r0-url-expiry-extension"),
        proxy.origin,
        R2_UPLOAD_ORIGIN!,
      );
      harness = await launchExtensionHarness(
        testInfo.outputPath.bind(testInfo),
        { extensionPath, ignoreHTTPSErrors: true },
      );
      const configured = await configureRealR2Destination(harness, proxy.origin);
      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: "opfs",
        micMode: "off",
        recordSelfVideo: false,
      });
      const recordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        configured.created.profile.id,
      );
      const before = await historyEntry(harness.controlPage, recordingId);
      const retained = before.files.find(
        (file) => !file.kind && file.locations.some((location) => location.kind === "opfs"),
      );
      const opfs = retained?.locations.find((location) => location.kind === "opfs");
      if (!retained || !opfs || opfs.kind !== "opfs") {
        throw new Error("JM4 recording has no retained OPFS media");
      }
      expect(
        await resizeRetainedOpfsFixture(
          harness.controlPage,
          opfs.key,
          URL_EXPIRY_FIXTURE_BYTES,
        ),
      ).toBe(URL_EXPIRY_FIXTURE_BYTES);
      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "CONFIRM_RECORDING_ROUTES",
          recordingId,
          removedDestinationIds: [],
        }),
      ).toEqual(expect.objectContaining({ ok: true }));

      const transfers = await waitForTransfersAcknowledged(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
        480_000,
      );
      expect(delayed).toBe(true);
      expect(partOneSignRequests).toBeGreaterThanOrEqual(2);
      expect(transfers).toEqual([
        expect.objectContaining({
          state: "acknowledged",
          bytesUploaded: URL_EXPIRY_FIXTURE_BYTES,
          bytesTotal: URL_EXPIRY_FIXTURE_BYTES,
        }),
      ]);
      const journal = await externalMediaJournal(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
      );
      expect(journal).toMatchObject({ state: "acknowledged" });
      expect(journal.request.artifact.bytes).toBe(URL_EXPIRY_FIXTURE_BYTES);

      await testInfo.attach("jm4-url-expiry-evidence.json", {
        body: JSON.stringify(
          {
            bytes: URL_EXPIRY_FIXTURE_BYTES,
            delayedPart: 1,
            delayMs: 4500,
            firstPartSignRequests: partOneSignRequests,
            transferState: journal.state,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      if (harness) await closeHarness(harness).catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });

  test("replaces an expired multipart attempt without changing artifact identity", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN || !RUN_ATTEMPT_EXPIRY,
      "Set R0_RUN_ATTEMPT_EXPIRY=1 and a short CRM upload lifetime to run JM5.",
    );
    test.setTimeout(600_000);

    let proxy: HttpsReverseProxy | null = null;
    let harness: ExtensionHarness | null = null;
    let delayed = false;
    let createRequests = 0;
    let partOneSignRequests = 0;
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-attempt-expiry-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
        {
          responseDelayMs: ({ method, pathname }) => {
            if (method === "POST" && /\/media\/v1\/uploads$/.test(pathname)) {
              createRequests += 1;
            }
            if (
              method === "POST" &&
              /\/media\/v1\/uploads\/upload_[^/]+\/parts\/1$/.test(pathname)
            ) {
              partOneSignRequests += 1;
              if (!delayed) {
                delayed = true;
                return 35_000;
              }
            }
            return 0;
          },
        },
      );
      const extensionPath = await preparePilotExtension(
        testInfo.outputPath("crm-r0-attempt-expiry-extension"),
        proxy.origin,
        R2_UPLOAD_ORIGIN!,
      );
      harness = await launchExtensionHarness(
        testInfo.outputPath.bind(testInfo),
        { extensionPath, ignoreHTTPSErrors: true },
      );
      const configured = await configureRealR2Destination(harness, proxy.origin);
      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: "opfs",
        micMode: "off",
        recordSelfVideo: false,
      });
      const recordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        configured.created.profile.id,
      );
      const before = await historyEntry(harness.controlPage, recordingId);
      const retained = before.files.find(
        (file) => !file.kind && file.locations.some((location) => location.kind === "opfs"),
      );
      const opfs = retained?.locations.find((location) => location.kind === "opfs");
      if (!retained || !opfs || opfs.kind !== "opfs") {
        throw new Error("JM5 recording has no retained OPFS media");
      }
      expect(
        await resizeRetainedOpfsFixture(
          harness.controlPage,
          opfs.key,
          ATTEMPT_EXPIRY_FIXTURE_BYTES,
        ),
      ).toBe(ATTEMPT_EXPIRY_FIXTURE_BYTES);
      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "CONFIRM_RECORDING_ROUTES",
          recordingId,
          removedDestinationIds: [],
        }),
      ).toEqual(expect.objectContaining({ ok: true }));

      let firstAttempt: any;
      await expect.poll(
        async () => {
          firstAttempt = await externalMediaJournal(
            harness!.controlPage,
            recordingId,
            configured.created.destination.id,
          );
          return Boolean(firstAttempt?.uploadId && firstAttempt?.artifactId);
        },
        { timeout: 60_000, intervals: [100, 250, 500] },
      ).toBe(true);
      const firstIdentity = {
        clientTransferId: firstAttempt.request.clientTransferId,
        artifactId: firstAttempt.artifactId,
        uploadId: firstAttempt.uploadId,
      };

      const transfers = await waitForTransfersAcknowledged(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
        480_000,
      );
      const finalJournal = await externalMediaJournal(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
      );
      expect(delayed).toBe(true);
      expect(createRequests).toBeGreaterThanOrEqual(2);
      expect(partOneSignRequests).toBeGreaterThanOrEqual(2);
      expect(finalJournal).toMatchObject({
        state: "acknowledged",
        artifactId: firstIdentity.artifactId,
      });
      expect(finalJournal.request.clientTransferId).toBe(firstIdentity.clientTransferId);
      expect(finalJournal.uploadId).not.toBe(firstIdentity.uploadId);
      expect(transfers).toEqual([
        expect.objectContaining({
          clientTransferId: firstIdentity.clientTransferId,
          state: "acknowledged",
          bytesUploaded: ATTEMPT_EXPIRY_FIXTURE_BYTES,
          bytesTotal: ATTEMPT_EXPIRY_FIXTURE_BYTES,
        }),
      ]);

      const admin = harness.context.request;
      await crmLogin(admin, proxy.origin);
      const crmRecording = await waitForCrmRecording(
        admin,
        proxy.origin,
        configured.connection.id,
      );
      const crmMedia = await crmGet<any[]>(
        admin,
        proxy.origin,
        `/api/interview-recordings/${crmRecording.id}/media`,
      );
      expect(crmMedia).toEqual([
        expect.objectContaining({
          artifactId: firstIdentity.artifactId,
          bytes: ATTEMPT_EXPIRY_FIXTURE_BYTES,
        }),
      ]);

      await testInfo.attach("jm5-attempt-expiry-evidence.json", {
        body: JSON.stringify(
          {
            bytes: ATTEMPT_EXPIRY_FIXTURE_BYTES,
            forcedDelayMs: 35000,
            createRequests,
            partOneSignRequests,
            clientTransferIdPreserved:
              finalJournal.request.clientTransferId === firstIdentity.clientTransferId,
            artifactIdPreserved: finalJournal.artifactId === firstIdentity.artifactId,
            uploadAttemptReplaced: finalJournal.uploadId !== firstIdentity.uploadId,
            transferState: finalJournal.state,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      if (harness) await closeHarness(harness).catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });

  test("plays and seeks external multi-track media across repeated URL expiry", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN || !RUN_PLAYBACK_EXPIRY,
      "Set R0_RUN_PLAYBACK_EXPIRY=1 and a short CRM playback-URL TTL to run JM6/JM7.",
    );
    test.setTimeout(600_000);

    let proxy: HttpsReverseProxy | null = null;
    let harness: ExtensionHarness | null = null;
    const playbackSignRequests = new Map<string, number>();
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-playback-expiry-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
        {
          responseDelayMs: ({ method, pathname }) => {
            const match = pathname.match(
              /\/media\/v1\/artifacts\/(media_[^/]+)\/playback$/,
            );
            if (method === "POST" && match?.[1]) {
              playbackSignRequests.set(
                match[1],
                (playbackSignRequests.get(match[1]) ?? 0) + 1,
              );
            }
            return 0;
          },
        },
      );
      const extensionPath = await preparePilotExtension(
        testInfo.outputPath("crm-r0-playback-expiry-extension"),
        proxy.origin,
        R2_UPLOAD_ORIGIN!,
      );
      harness = await launchExtensionHarness(
        testInfo.outputPath.bind(testInfo),
        { extensionPath, ignoreHTTPSErrors: true },
      );
      const configured = await configureRealR2Destination(harness, proxy.origin);
      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: "opfs",
        micMode: "separate",
        recordSelfVideo: true,
      });
      const recordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        configured.created.profile.id,
        { micMode: "separate", recordSelfVideo: true, captureMs: 4_000 },
      );
      const recorded = await historyEntry(harness.controlPage, recordingId);
      expect(recorded.files.filter((file) => !file.kind)).toHaveLength(3);
      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "CONFIRM_RECORDING_ROUTES",
          recordingId,
          removedDestinationIds: [],
        }),
      ).toEqual(expect.objectContaining({ ok: true }));
      const transfers = await waitForTransfersAcknowledged(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
        480_000,
      );
      expect(transfers).toHaveLength(3);

      const externalTracks = await projectHistoryToExternalOnly(
        harness.controlPage,
        recordingId,
      );
      expect(externalTracks).toHaveLength(3);
      const master =
        externalTracks.find((track) => track.stream === "tab") ?? externalTracks[0];
      if (!master) throw new Error("JM6/JM7 has no external master track");

      const player = await harness.context.newPage();
      const rangeReads: string[] = [];
      player.on("request", (request) => {
        try {
          if (
            request.method() === "GET" &&
            new URL(request.url()).origin === R2_UPLOAD_ORIGIN
          ) {
            const range = request.headers()["range"];
            if (range) rangeReads.push(range);
          }
        } catch {
          // Ignore non-URL browser-internal requests.
        }
      });
      await player.goto(
        `chrome-extension://${harness.extensionId}/recordings.html`,
        { waitUntil: "domcontentloaded" },
      );
      await player.evaluate(() => {
        (window as any).__r0CspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          let blockedOrigin = event.blockedURI;
          try {
            blockedOrigin = new URL(event.blockedURI).origin;
          } catch {}
          (window as any).__r0CspViolations.push({
            directive: event.effectiveDirective,
            blockedOrigin,
          });
        });
      });
      await expect(player.locator(".recording-row").first()).toBeVisible({
        timeout: 20_000,
      });
      await player.locator(".recording-row").first().click();
      await player.locator(".modal-button--watch").click();
      await expect(player.locator(".player")).toBeVisible();

      const video = player.locator(".player__video");
      const selfcam = player.locator(".player__selfcam");
      const microphone = player.locator(".player__aux audio");
      for (const element of [video, selfcam, microphone]) {
        await expect.poll(
          async () =>
            element.evaluate((media: HTMLMediaElement) =>
              media.src ? new URL(media.src).origin : "",
            ),
          { timeout: 30_000 },
        ).toBe(R2_UPLOAD_ORIGIN);
        await expect.poll(
          async () => element.evaluate((media: HTMLMediaElement) => media.readyState),
          { timeout: 30_000 },
        ).toBeGreaterThanOrEqual(1);
      }

      const initialMasterSigns = playbackSignRequests.get(master.artifactId) ?? 0;
      expect(initialMasterSigns).toBeGreaterThanOrEqual(1);
      for (let expiry = 0; expiry < 2; expiry += 1) {
        await player.waitForTimeout(3_000);
        const beforeRefresh = playbackSignRequests.get(master.artifactId) ?? 0;
        await video.evaluate((media: HTMLMediaElement) => media.load());
        await expect.poll(
          () => playbackSignRequests.get(master.artifactId) ?? 0,
          { timeout: 30_000, intervals: [100, 250, 500, 1_000] },
        ).toBeGreaterThan(beforeRefresh);
        await expect.poll(
          async () => video.evaluate((media: HTMLMediaElement) => media.readyState),
          { timeout: 30_000 },
        ).toBeGreaterThanOrEqual(1);
      }
      expect(playbackSignRequests.get(master.artifactId)).toBeGreaterThanOrEqual(
        initialMasterSigns + 2,
      );

      await video.evaluate(async (media: HTMLVideoElement) => {
        media.currentTime = 1.5;
        await media.play().catch(() => {});
      });
      await expect.poll(
        async () => video.evaluate((media: HTMLVideoElement) => media.currentTime),
        { timeout: 15_000 },
      ).toBeGreaterThan(1.4);
      await expect.poll(
        async () => microphone.evaluate((media: HTMLAudioElement) => media.currentTime),
        { timeout: 15_000 },
      ).toBeGreaterThan(1.0);
      const spread = await player.evaluate(() => {
        const tab = document.querySelector(".player__video") as HTMLVideoElement;
        const cam = document.querySelector(".player__selfcam") as HTMLVideoElement;
        const mic = document.querySelector(".player__aux audio") as HTMLAudioElement;
        return [
          Math.abs(cam.currentTime - tab.currentTime),
          Math.abs(mic.currentTime - tab.currentTime),
        ];
      });
      for (const delta of spread) expect(delta).toBeLessThan(0.6);
      await expect.poll(() => rangeReads.length, { timeout: 20_000 }).toBeGreaterThan(0);
      expect(rangeReads.every((range) => /^bytes=\d+-/i.test(range))).toBe(true);
      const cspViolations = await player.evaluate(
        () => (window as any).__r0CspViolations as Array<unknown>,
      );
      expect(cspViolations).toEqual([]);
      await expect(player.locator(".player__status")).toBeHidden();

      await testInfo.attach("jm6-jm7-playback-expiry-evidence.json", {
        body: JSON.stringify(
          {
            tracks: externalTracks.map((track) => track.stream).sort(),
            masterPlaybackSignRequests:
              playbackSignRequests.get(master.artifactId) ?? 0,
            repeatedExpiriesRecovered: 2,
            nativeRangeRequestsObserved: rangeReads.length,
            deepSeekSeconds: 1.5,
            auxiliaryMaxDriftSeconds: Math.max(...spread),
            cspViolationCount: cspViolations.length,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      if (harness) await closeHarness(harness).catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });

  test("isolates connections, revokes replaced tokens, and preserves CRM RBAC playback after disable", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN || !RUN_AUTH_ISOLATION,
      "Set R0_RUN_AUTH_ISOLATION=1 with the real-R2 pilot variables to run JM8/JM13.",
    );
    test.setTimeout(600_000);

    let proxy: HttpsReverseProxy | null = null;
    let harness: ExtensionHarness | null = null;
    const roleContexts: APIRequestContext[] = [];
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-auth-isolation-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
      );
      const extensionPath = await preparePilotExtension(
        testInfo.outputPath("crm-r0-auth-isolation-extension"),
        proxy.origin,
        R2_UPLOAD_ORIGIN!,
      );
      harness = await launchExtensionHarness(
        testInfo.outputPath.bind(testInfo),
        { extensionPath, ignoreHTTPSErrors: true },
      );
      const configured = await configureRealR2Destination(harness, proxy.origin);
      const admin = harness.context.request;
      const otherConnection = await crmCreateConnection(admin, proxy.origin);
      const otherBearer = await crmReplaceMediaToken(
        admin,
        proxy.origin,
        otherConnection.id,
      );

      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: "opfs",
        micMode: "off",
        recordSelfVideo: false,
      });
      const recordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        configured.created.profile.id,
      );
      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "CONFIRM_RECORDING_ROUTES",
          recordingId,
          removedDestinationIds: [],
        }),
      ).toEqual(expect.objectContaining({ ok: true }));
      await waitForTransfersAcknowledged(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
        480_000,
      );

      const journal = await externalMediaJournal(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
      );
      if (!journal?.uploadId || !journal?.artifactId) {
        throw new Error("JM8/JM13 transfer did not retain provider identities");
      }
      const artifactId = journal.artifactId as string;
      const uploadId = journal.uploadId as string;

      const ownPlayback = await mediaRequest(
        admin,
        proxy.origin,
        configured.mediaBearer,
        "POST",
        `/artifacts/${artifactId}/playback`,
      );
      expect(ownPlayback.status).toBe(200);

      const crossUpload = await mediaRequest(
        admin,
        proxy.origin,
        otherBearer,
        "GET",
        `/uploads/${uploadId}`,
      );
      expect(crossUpload).toMatchObject({ status: 403, code: "MEDIA_FORBIDDEN" });
      const crossPlayback = await mediaRequest(
        admin,
        proxy.origin,
        otherBearer,
        "POST",
        `/artifacts/${artifactId}/playback`,
      );
      expect(crossPlayback).toMatchObject({ status: 403, code: "MEDIA_FORBIDDEN" });

      const rotatedBearer = await crmReplaceMediaToken(
        admin,
        proxy.origin,
        configured.connection.id,
      );
      const oldBearerAfterRotation = await mediaRequest(
        admin,
        proxy.origin,
        configured.mediaBearer,
        "POST",
        `/artifacts/${artifactId}/playback`,
      );
      expect(oldBearerAfterRotation).toMatchObject({
        status: 401,
        code: "MEDIA_UNAUTHORIZED",
      });
      expect(
        await mediaRequest(
          admin,
          proxy.origin,
          rotatedBearer,
          "POST",
          `/artifacts/${artifactId}/playback`,
        ),
      ).toMatchObject({ status: 200 });

      const crmRecording = await waitForCrmRecording(
        admin,
        proxy.origin,
        configured.connection.id,
      );
      const unmatchedAdmin = await crmGet<any[]>(
        admin,
        proxy.origin,
        "/api/interview-recordings/unmatched",
      );
      expect(unmatchedAdmin.some((recording) => recording.id === crmRecording.id)).toBe(true);

      const ownerSenior = await crmRoleContext(proxy.origin, "oleksiy.kovalenko@cheekycheese.dev");
      const ownerHr = await crmRoleContext(proxy.origin, "anna.lysenko@cheekycheese.dev");
      const otherSenior = await crmRoleContext(proxy.origin, "dmytro.marchenko@cheekycheese.dev");
      const otherHr = await crmRoleContext(proxy.origin, "kateryna.shevchenko@cheekycheese.dev");
      roleContexts.push(ownerSenior, ownerHr, otherSenior, otherHr);

      for (const context of [ownerSenior, ownerHr]) {
        expect(
          await crmStatus(context, proxy.origin, "/api/interview-recordings/unmatched"),
        ).toBe(403);
      }

      const interviews = await crmGet<any[]>(
        admin,
        proxy.origin,
        "/api/interviews?seniorId=c1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f55",
      );
      const interviewId = interviews[0]?.id;
      if (typeof interviewId !== "string") {
        throw new Error("JM13 could not find the seeded Oleksiy interview");
      }
      await crmPatch(
        admin,
        proxy.origin,
        `/api/interview-recordings/${crmRecording.id}/link`,
        { interviewId },
      );

      const recordingPath = `/api/interview-recordings/${crmRecording.id}`;
      const mediaPath = `${recordingPath}/media`;
      const crmPlaybackPath = `${mediaPath}/${artifactId}/playback`;
      for (const context of [ownerSenior, ownerHr]) {
        expect(await crmStatus(context, proxy.origin, recordingPath)).toBe(200);
        expect(await crmStatus(context, proxy.origin, mediaPath)).toBe(200);
        expect(await crmStatus(context, proxy.origin, crmPlaybackPath, "POST")).toBe(201);
      }
      for (const context of [otherSenior, otherHr]) {
        expect(await crmStatus(context, proxy.origin, recordingPath)).toBe(403);
        expect(await crmStatus(context, proxy.origin, mediaPath)).toBe(403);
        expect(await crmStatus(context, proxy.origin, crmPlaybackPath, "POST")).toBe(403);
      }

      await crmPatch(
        admin,
        proxy.origin,
        `/api/integrations/meeting-recorder/connections/${configured.connection.id}`,
        { enabled: false },
      );
      const disabledBearer = await mediaRequest(
        admin,
        proxy.origin,
        rotatedBearer,
        "POST",
        `/artifacts/${artifactId}/playback`,
      );
      expect(disabledBearer).toMatchObject({
        status: 410,
        code: "MEDIA_CONNECTION_DISABLED",
      });
      expect(await crmStatus(admin, proxy.origin, crmPlaybackPath, "POST")).toBe(201);
      expect(await crmStatus(ownerSenior, proxy.origin, crmPlaybackPath, "POST")).toBe(201);
      expect(await crmStatus(ownerHr, proxy.origin, crmPlaybackPath, "POST")).toBe(201);

      await testInfo.attach("jm8-jm13-auth-isolation-evidence.json", {
        body: JSON.stringify(
          {
            connectionIsolation: {
              uploadStatus: crossUpload.status,
              playbackStatus: crossPlayback.status,
            },
            tokenReplacement: {
              oldBearerStatus: oldBearerAfterRotation.status,
              replacementBearerStatus: 200,
            },
            unmatchedNonAdminStatus: 403,
            interviewRbac: {
              ownerSenior: 201,
              ownerHr: 201,
              crossTeamSenior: 403,
              crossTeamHr: 403,
            },
            disabledBearerStatus: disabledBearer.status,
            crmPlaybackAfterDisableStatus: 201,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      for (const context of roleContexts) await context.dispose().catch(() => {});
      if (harness) await closeHarness(harness).catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });

  test("separates disable, Save-to removal, local deletion, and disconnect without deleting CRM media", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN || !RUN_LIFECYCLE,
      "Set R0_RUN_LIFECYCLE=1 with the real-R2 pilot variables to run JM9/JM10.",
    );
    test.setTimeout(600_000);

    let proxy: HttpsReverseProxy | null = null;
    let harness: ExtensionHarness | null = null;
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-lifecycle-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
      );
      const extensionPath = await preparePilotExtension(
        testInfo.outputPath("crm-r0-lifecycle-extension"),
        proxy.origin,
        R2_UPLOAD_ORIGIN!,
      );
      harness = await launchExtensionHarness(
        testInfo.outputPath.bind(testInfo),
        { extensionPath, ignoreHTTPSErrors: true },
      );
      const configured = await configureRealR2Destination(harness, proxy.origin);
      const admin = harness.context.request;

      const meet = await openMockMeetPage(harness.context);
      const tabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage, {
        recordingMode: "opfs",
        micMode: "off",
        recordSelfVideo: false,
      });
      const recordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        configured.created.profile.id,
      );
      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "CONFIRM_RECORDING_ROUTES",
          recordingId,
          removedDestinationIds: [],
        }),
      ).toEqual(expect.objectContaining({ ok: true }));
      await waitForTransfersAcknowledged(
        harness.controlPage,
        recordingId,
        configured.created.destination.id,
        480_000,
      );

      const entry = await historyEntry(harness.controlPage, recordingId);
      const mediaFile = entry.files.find((file) =>
        !file.kind &&
        file.locations.some(
          (location) =>
            location.kind === "external" &&
            location.destinationId === configured.created.destination.id,
        ),
      );
      const external = mediaFile?.locations.find(
        (location) =>
          location.kind === "external" &&
          location.destinationId === configured.created.destination.id,
      );
      if (!mediaFile || !external || external.kind !== "external") {
        throw new Error("JM9/JM10 recording has no ready external replica");
      }
      const crmRecording = await waitForCrmRecording(
        admin,
        proxy.origin,
        configured.connection.id,
      );
      const crmMediaPath = `/api/interview-recordings/${crmRecording.id}/media`;
      const crmPlaybackPath =
        `${crmMediaPath}/${external.artifactId}/playback`;
      expect(
        await crmGet<any[]>(admin, proxy.origin, crmMediaPath),
      ).toEqual([
        expect.objectContaining({ artifactId: external.artifactId }),
      ]);

      const disabled = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "SET_INTEGRATION_ENABLED",
        destinationId: configured.created.destination.id,
        enabled: false,
      });
      expect(disabled).toEqual(
        expect.objectContaining({
          ok: true,
          destination: expect.objectContaining({ enabled: false }),
        }),
      );

      const player = await harness.context.newPage();
      await player.goto(
        `chrome-extension://${harness.extensionId}/recordings.html`,
        { waitUntil: "domcontentloaded" },
      );
      const disabledPlayback = await prepareExternalPlayback(player, {
        recordingId,
        fileId: mediaFile.id,
        destinationId: configured.created.destination.id,
        artifactId: external.artifactId,
      });
      expect(disabledPlayback.ok).toBe(true);
      expect(new URL(disabledPlayback.url!).origin).toBe(R2_UPLOAD_ORIGIN);
      await proveBrowserPlayback(player, disabledPlayback.url!, mediaFile.mimeType);

      const disabledRecordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        configured.created.profile.id,
      );
      expect(await recordingRoutes(harness.controlPage, disabledRecordingId)).toEqual([
        expect.objectContaining({
          destinationId: configured.created.destination.id,
          state: "not-scheduled",
        }),
      ]);
      const disabledTransfers = await sendRuntimeMessage<any>(
        harness.controlPage,
        {
          type: "LIST_EXTERNAL_MEDIA_TRANSFERS",
          recordingId: disabledRecordingId,
        },
      );
      expect(disabledTransfers).toEqual(
        expect.objectContaining({ ok: true, transfers: [] }),
      );

      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "SET_INTEGRATION_ENABLED",
          destinationId: configured.created.destination.id,
          enabled: true,
        }),
      ).toEqual(
        expect.objectContaining({
          ok: true,
          destination: expect.objectContaining({ enabled: true }),
        }),
      );

      const heldRecordingId = await record(
        harness.controlPage,
        meet,
        tabId,
        configured.created.profile.id,
      );
      expect(await recordingRoutes(harness.controlPage, heldRecordingId)).toEqual([
        expect.objectContaining({
          destinationId: configured.created.destination.id,
          state: "held",
          includesMedia: true,
        }),
      ]);
      await expect
        .poll(
          async () => {
            const response = await sendRuntimeMessage<any>(
              harness!.controlPage,
              { type: "LIST_HELD_RECORDING_ROUTES" },
            );
            return response.recordings?.some(
              (candidate: any) => candidate.recordingId === heldRecordingId,
            );
          },
          { timeout: 20_000, intervals: [100, 250, 500] },
        )
        .toBe(true);

      const syntheticCount = 60;
      await injectExternalHistoryRows(
        harness.controlPage,
        configured.created.destination.id,
        syntheticCount,
      );
      const impact = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "GET_INTEGRATION_DISCONNECT_IMPACT",
        destinationId: configured.created.destination.id,
      });
      expect(impact).toEqual({
        ok: true,
        affectedRecordings: syntheticCount + 1,
      });

      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "REMOVE_RECORDING_DESTINATION",
          profileId: configured.created.profile.id,
        }),
      ).toEqual({ ok: true, removed: true });
      const heldAfterProfileRemoval = await sendRuntimeMessage<any>(
        harness.controlPage,
        { type: "LIST_HELD_RECORDING_ROUTES" },
      );
      expect(
        heldAfterProfileRemoval.recordings.some(
          (candidate: any) => candidate.recordingId === heldRecordingId,
        ),
      ).toBe(true);
      expect(
        await crmGet<any[]>(admin, proxy.origin, crmMediaPath),
      ).toEqual([
        expect.objectContaining({ artifactId: external.artifactId }),
      ]);
      expect(
        await crmStatus(admin, proxy.origin, crmPlaybackPath, "POST"),
      ).toBe(201);

      const disconnected = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "DELETE_INTEGRATION",
        destinationId: configured.created.destination.id,
      });
      expect(disconnected).toEqual(
        expect.objectContaining({ ok: true, removed: true }),
      );
      const destinationsAfterDisconnect = await sendRuntimeMessage<any>(
        harness.controlPage,
        { type: "LIST_INTEGRATIONS" },
      );
      expect(
        destinationsAfterDisconnect.destinations.some(
          (destination: any) =>
            destination.id === configured.created.destination.id,
        ),
      ).toBe(false);
      const heldAfterDisconnect = await sendRuntimeMessage<any>(
        harness.controlPage,
        { type: "LIST_HELD_RECORDING_ROUTES" },
      );
      expect(
        heldAfterDisconnect.recordings.some(
          (candidate: any) => candidate.recordingId === heldRecordingId,
        ),
      ).toBe(false);
      const disconnectedPlayback = await prepareExternalPlayback(player, {
        recordingId,
        fileId: mediaFile.id,
        destinationId: configured.created.destination.id,
        artifactId: external.artifactId,
      });
      expect(disconnectedPlayback.ok).toBe(false);
      expect(disconnectedPlayback.error).toContain("does not exist");

      expect(
        await crmGet<any[]>(admin, proxy.origin, crmMediaPath),
      ).toEqual([
        expect.objectContaining({ artifactId: external.artifactId }),
      ]);
      expect(
        await crmStatus(admin, proxy.origin, crmPlaybackPath, "POST"),
      ).toBe(201);

      expect(
        await sendRuntimeMessage<any>(harness.controlPage, {
          type: "REMOVE_RECORDING_HISTORY",
          id: recordingId,
        }),
      ).toEqual(expect.objectContaining({ ok: true, removed: true }));
      const removedPage = await sendRuntimeMessage<any>(harness.controlPage, {
        type: "LIST_RECORDING_HISTORY",
      });
      expect(
        removedPage.entries.some((candidate: any) => candidate.id === recordingId),
      ).toBe(false);
      expect(
        await crmGet<any[]>(admin, proxy.origin, crmMediaPath),
      ).toEqual([
        expect.objectContaining({ artifactId: external.artifactId }),
      ]);
      expect(
        await crmStatus(admin, proxy.origin, crmPlaybackPath, "POST"),
      ).toBe(201);

      await testInfo.attach("jm9-jm10-lifecycle-evidence.json", {
        body: JSON.stringify(
          {
            playbackWhileAutomationDisabled: true,
            newRecordingWhileDisabled: {
              routeState: "not-scheduled",
              externalTransferCount: 0,
            },
            disconnectImpactCount: impact.affectedRecordings,
            saveToProfileRemovalPreservedHeldRoute: true,
            disconnectCanceledHeldRoute: true,
            localPlaybackAfterDisconnectAvailable: disconnectedPlayback.ok,
            crmMediaAfterProfileRemoval: true,
            crmMediaAfterDisconnect: true,
            crmMediaAfterLocalHistoryRemoval: true,
            crmPlaybackStatusAfterDisconnect: 201,
            crmPlaybackStatusAfterLocalHistoryRemoval: 201,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      if (harness) await closeHarness(harness).catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });

  test("rejects unsafe upload metadata and keeps R2 keys and content type canonical", async ({}, testInfo) => {
    test.skip(
      !CRM_UPSTREAM || !R2_UPLOAD_ORIGIN || !RUN_PROTOCOL_HARDENING,
      "Set R0_RUN_PROTOCOL_HARDENING=1 with the real-R2 pilot variables to run JM14–JM16.",
    );
    test.setTimeout(180_000);

    let proxy: HttpsReverseProxy | null = null;
    const admin = await playwrightRequest.newContext({
      ignoreHTTPSErrors: true,
    });
    try {
      proxy = await startHttpsReverseProxy(
        testInfo.outputPath("crm-r0-protocol-hardening-proxy"),
        CRM_PUBLIC_ORIGIN,
        CRM_UPSTREAM!,
      );
      await crmLogin(admin, proxy.origin);
      const connection = await crmCreateConnection(admin, proxy.origin);
      const bearer = await crmReplaceMediaToken(
        admin,
        proxy.origin,
        connection.id,
      );
      const recordingId =
        "recording_77777777-7777-4777-8777-777777777777";
      const base = {
        clientTransferId: "jm14_invalid",
        recordingId,
        artifact: {
          role: "tab-recording",
          filename: "meeting.webm",
          mimeType: "video/webm",
          bytes: 5,
        },
      };

      const invalidCases: Array<{ name: string; body: unknown; status: number }> = [
        {
          name: "role",
          body: {
            ...base,
            artifact: { ...base.artifact, role: "transcript" },
          },
          status: 422,
        },
        {
          name: "mime",
          body: {
            ...base,
            artifact: { ...base.artifact, mimeType: "text/html" },
          },
          status: 422,
        },
        {
          name: "filename-controls-only",
          body: {
            ...base,
            artifact: { ...base.artifact, filename: "\r\n\u0000\u007f" },
          },
          status: 422,
        },
        {
          name: "filename-too-long",
          body: {
            ...base,
            artifact: {
              ...base.artifact,
              filename: `${"x".repeat(252)}.webm`,
            },
          },
          status: 422,
        },
        {
          name: "strict-extra-field",
          body: { ...base, storageKey: "attacker-controlled" },
          status: 422,
        },
      ];
      const invalidStatuses: Record<string, number> = {};
      for (const candidate of invalidCases) {
        const response = await mediaJsonRequest(
          admin,
          proxy.origin,
          bearer,
          "POST",
          "/uploads",
          candidate.body,
        );
        invalidStatuses[candidate.name] = response.status;
        expect(response.status).toBe(candidate.status);
        expect(response.code).toBe("MEDIA_UPLOAD_INVALID");
      }

      const hostileFilename = '../candidate"\r\n..\\meeting.webm';
      const create = await mediaJsonRequest<{
        state?: unknown;
        artifactId?: unknown;
        uploadId?: unknown;
        partSize?: unknown;
        maxConcurrency?: unknown;
      }>(
        admin,
        proxy.origin,
        bearer,
        "POST",
        "/uploads",
        {
          clientTransferId: "jm14_canonical",
          recordingId,
          artifact: {
            role: "tab-recording",
            filename: hostileFilename,
            mimeType: "VIDEO/WEBM; codecs=vp8",
            bytes: 5,
          },
        },
      );
      expect(create.status).toBe(200);
      if (
        create.body?.state !== "uploading" ||
        typeof create.body.artifactId !== "string" ||
        typeof create.body.uploadId !== "string"
      ) {
        throw new Error("JM14–JM16 create response was not an upload attempt");
      }
      const artifactId = create.body.artifactId;
      const uploadId = create.body.uploadId;
      const artifactUuid = artifactId.slice("media_".length);
      const attemptUuid = uploadId.slice("upload_".length);

      const part = await mediaJsonRequest<{
        method?: unknown;
        url?: unknown;
        headers?: unknown;
      }>(
        admin,
        proxy.origin,
        bearer,
        "POST",
        `/uploads/${uploadId}/parts/1`,
      );
      if (
        part.status !== 200 ||
        part.body?.method !== "PUT" ||
        typeof part.body.url !== "string" ||
        !part.body.headers ||
        typeof part.body.headers !== "object" ||
        Array.isArray(part.body.headers)
      ) {
        throw new Error("JM14–JM16 part signing response was invalid");
      }
      const signedUrl = new URL(part.body.url);
      const expectedKey =
        `meeting-recordings/${connection.id}/${artifactUuid}/${attemptUuid}`;
      const objectPathIsIdOnly = decodeURIComponent(signedUrl.pathname).endsWith(
        `/${expectedKey}`,
      );
      const signedHeaderNames = Object.keys(
        part.body.headers as Record<string, unknown>,
      );

      const payload = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00]);
      const put = await fetch(signedUrl.href, {
        method: "PUT",
        headers: part.body.headers as Record<string, string>,
        body: payload,
      });
      expect(put.ok).toBe(true);
      const etag = put.headers.get("etag");
      if (!etag) throw new Error("R2 did not return an ETag for JM14–JM16");

      const completed = await mediaJsonRequest<{
        state?: unknown;
        artifactId?: unknown;
      }>(
        admin,
        proxy.origin,
        bearer,
        "POST",
        `/uploads/${uploadId}/complete`,
        { parts: [{ partNumber: 1, etag }] },
      );
      expect(completed.status).toBe(200);
      expect(completed.body?.state).toBe("ready");
      expect(completed.body?.artifactId).toBe(artifactId);

      const playback = await mediaJsonRequest<{
        url?: unknown;
        expiresAt?: unknown;
      }>(
        admin,
        proxy.origin,
        bearer,
        "POST",
        `/artifacts/${artifactId}/playback`,
      );
      if (playback.status !== 200 || typeof playback.body?.url !== "string") {
        throw new Error("JM14–JM16 playback response was invalid");
      }
      const ranged = await fetch(playback.body.url, {
        headers: { Range: "bytes=0-4" },
      });
      const playbackBytes = new Uint8Array(await ranged.arrayBuffer());
      const playbackContentType =
        ranged.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

      expect(signedUrl.origin).toBe(R2_UPLOAD_ORIGIN);
      expect(objectPathIsIdOnly).toBe(true);
      expect(signedHeaderNames).toEqual([]);
      expect(signedUrl.pathname).not.toContain("candidate");
      expect(signedUrl.pathname).not.toContain("meeting.webm");
      expect(playbackContentType).toBe("video/webm");
      expect([200, 206]).toContain(ranged.status);
      expect(playbackBytes).toEqual(payload);

      await testInfo.attach("jm14-jm16-protocol-hardening-evidence.json", {
        body: JSON.stringify(
          {
            invalidStatuses,
            validCreateStatus: create.status,
            objectPathIsIdOnly,
            signedHeaderNames,
            playbackStatus: ranged.status,
            playbackContentType,
            playbackBytes: playbackBytes.byteLength,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } finally {
      await admin.dispose().catch(() => {});
      await proxy?.stop().catch(() => {});
    }
  });
});

async function preparePilotExtension(
  destination: string,
  crmOrigin: string,
  r2Origin: string,
): Promise<string> {
  const source = path.resolve(
    process.cwd(),
    process.env.EXTENSION_PATH ?? "dist-e2e",
  );
  await fs.cp(source, destination, { recursive: true });
  const manifestPath = path.join(destination, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
    host_permissions?: string[];
  };
  manifest.host_permissions = Array.from(
    new Set([
      ...(manifest.host_permissions ?? []),
      chromeHostPermission(crmOrigin),
      chromeHostPermission(r2Origin),
    ]),
  );
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return destination;
}

function chromeHostPermission(origin: string): string {
  const url = new URL(origin);
  // Chrome match patterns do not include ports. Match the same normalized
  // permission shape used by the production webhook endpoint code so the
  // local HTTPS proxy on :3443 is covered by https://127.0.0.1/*.
  return `${url.protocol}//${url.hostname}/*`;
}

async function crmLogin(
  request: APIRequestContext,
  origin: string,
  email = CRM_ADMIN_EMAIL,
): Promise<void> {
  const response = await request.post(`${origin}/api/auth/dev-login`, {
    data: { email },
  });
  await expectResponse(response, "CRM dev-login");
}

async function crmCreateConnection(
  request: APIRequestContext,
  origin: string,
): Promise<{
  id: string;
  webhookPath: string;
}> {
  return crmPost(
    request,
    origin,
    "/api/integrations/meeting-recorder/connections",
    {
      name: `R0 Chrome pilot ${new Date().toISOString()}`,
    },
  );
}

async function crmSetSigningSecret(
  request: APIRequestContext,
  origin: string,
  connectionId: string,
  secret: string,
): Promise<void> {
  const response = await request.put(
    `${origin}/api/integrations/meeting-recorder/connections/${connectionId}/secret`,
    { data: { secret } },
  );
  await expectResponse(response, "set CRM Meeting Recorder signing secret");
}

async function crmReplaceMediaToken(
  request: APIRequestContext,
  origin: string,
  connectionId: string,
): Promise<string> {
  const response = await request.put(
    `${origin}/api/integrations/meeting-recorder/connections/${connectionId}/token`,
  );
  await expectResponse(response, "provision CRM Meeting Recorder media token");
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token.startsWith("mrmt_")) {
    throw new Error("CRM did not return a one-time media token");
  }
  return body.token;
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
      name: "CRM R0 real-R2 pilot",
      endpoint,
      routingDefault: "manual",
      dataPolicy: METADATA_POLICY,
      requestAuth: { type: "none" },
    },
  });
  if (
    !response?.ok ||
    !response.created?.destination?.id ||
    !response.created?.signingSecret ||
    !response.profile?.id
  ) {
    throw new Error(
      `CREATE_INTEGRATION failed: ${response?.error ?? "incomplete response"}`,
    );
  }
  return { ...response.created, profile: response.profile };
}

async function configureRealR2Destination(
  harness: ExtensionHarness,
  crmOrigin: string,
): Promise<{
  connection: { id: string; webhookPath: string };
  created: Awaited<ReturnType<typeof createIntegration>>;
  mediaBearer: string;
}> {
  const admin = harness.context.request;
  await crmLogin(admin, crmOrigin);
  const connection = await crmCreateConnection(admin, crmOrigin);
  const created = await createIntegration(
    harness.controlPage,
    `${crmOrigin}${connection.webhookPath}`,
  );
  await crmSetSigningSecret(
    admin,
    crmOrigin,
    connection.id,
    created.signingSecret,
  );
  const mediaBearer = await crmReplaceMediaToken(
    admin,
    crmOrigin,
    connection.id,
  );
  const discovery = await sendRuntimeMessage<any>(harness.controlPage, {
    type: "TEST_INTEGRATION",
    destinationId: created.destination.id,
  });
  expect(discovery).toEqual(
    expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        ok: true,
        status: 200,
        mediaCapability: expect.objectContaining({
          version: 1,
          apiBase: `${crmOrigin}/api/integrations/meeting-recorder/media`,
          upload: expect.objectContaining({
            strategy: "multipart-put-v1",
            origins: [R2_UPLOAD_ORIGIN],
          }),
          playback: { strategy: "refreshable-url-v1" },
        }),
      }),
    }),
  );
  expect(
    await sendRuntimeMessage<any>(harness.controlPage, {
      type: "CONFIGURE_INTEGRATION_MEDIA",
      destinationId: created.destination.id,
      bearer: mediaBearer,
    }),
  ).toEqual({ ok: true });
  return { connection, created, mediaBearer };
}

async function crmRoleContext(origin: string, email: string): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
  await crmLogin(context, origin, email);
  return context;
}

async function prepareExternalPlayback(
  page: Page,
  input: {
    recordingId: string;
    fileId: string;
    destinationId: string;
    artifactId: string;
  },
): Promise<{ ok: boolean; url?: string; error?: string }> {
  return page.evaluate(
    async (request) =>
      (await chrome.runtime.sendMessage({
        type: "PREPARE_EXTERNAL_PLAYBACK_SOURCE",
        ...request,
      })) as { ok: boolean; url?: string; error?: string },
    input,
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
  if (!response?.ok)
    throw new Error(`START_RECORDING failed: ${response?.error}`);
  await waitForSessionPhase(page, "recording", 30_000);
  const recordingId = await page.evaluate(
    async () =>
      ((await chrome.storage.session.get("recordingSession")) as any)
        ?.recordingSession?.historyId as string | undefined,
  );
  if (!recordingId)
    throw new Error("Recording session did not expose its history id");
  await meet.waitForTimeout(options.captureMs ?? 2_500);
  await stopRecording(page);
  return recordingId;
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
      if (!entry) throw new Error("JM6/JM7 recording is missing from history");
      const tracks: Array<{ fileId: string; stream: string; artifactId: string }> = [];
      for (const file of entry.files ?? []) {
        if (file.kind) continue;
        const external = (file.locations ?? []).filter(
          (location: any) => location.kind === "external",
        );
        if (external.length !== 1) {
          throw new Error(`JM6/JM7 expected one external replica for ${file.stream}`);
        }
        file.locations = external;
        tracks.push({
          fileId: file.id,
          stream: file.stream,
          artifactId: external[0].artifactId,
        });
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

async function injectExternalHistoryRows(
  page: Page,
  destinationId: string,
  count: number,
): Promise<void> {
  await page.evaluate(
    async ({ destinationId, count }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("recording-history");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("recordings", "readwrite");
          const store = transaction.objectStore("recordings");
          const base = Date.now() + 100_000;
          for (let index = 0; index < count; index += 1) {
            const id = `recording:jm9-synthetic-${index}`;
            const createdAt = base + index;
            store.put({
              id,
              name: `JM9 synthetic external recording ${index}`,
              createdAt,
              activeCreatedAt: createdAt,
              storageMode: "local",
              status: "complete",
              files: [
                {
                  id: `${id}:tab`,
                  stream: "tab",
                  filename: `jm9-synthetic-${index}.webm`,
                  mimeType: "audio/webm",
                  destination: "local",
                  status: "available",
                  delivery: { requested: "local", status: "downloaded" },
                  locations: [
                    {
                      kind: "external",
                      destinationId,
                      artifactId: `media_jm9_synthetic_${index}`,
                    },
                  ],
                },
              ],
            });
          }
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    { destinationId, count },
  );
}

async function recordingRoutes(
  page: Page,
  recordingId: string,
): Promise<any[]> {
  const response = await sendRuntimeMessage<any>(page, {
    type: "GET_RECORDING_ROUTES",
    recordingId,
  });
  if (!response?.ok)
    throw new Error(`GET_RECORDING_ROUTES failed: ${response?.error}`);
  return response.routes;
}

async function waitForTransfersAcknowledged(
  page: Page,
  recordingId: string,
  destinationId: string,
  timeoutMs = 180_000,
): Promise<any[]> {
  let last: any[] = [];
  await expect
    .poll(
      async () => {
        const response = await sendRuntimeMessage<any>(page, {
          type: "LIST_EXTERNAL_MEDIA_TRANSFERS",
          recordingId,
        });
        if (!response?.ok)
          throw new Error(
            `LIST_EXTERNAL_MEDIA_TRANSFERS failed: ${response?.error}`,
          );
        last = response.transfers.filter(
          (transfer: any) => transfer.destinationId === destinationId,
        );
        const failed = last.find(
          (transfer) => transfer.state === "action-required",
        );
        if (failed)
          throw new Error(
            `External media transfer requires action: ${failed.errorCategory ?? "unknown"}`,
          );
        return (
          last.length > 0 &&
          last.every((transfer) => transfer.state === "acknowledged")
        );
      },
      { timeout: timeoutMs, intervals: [250, 500, 1_000, 2_000, 5_000] },
    )
    .toBe(true);
  return last;
}

async function resizeRetainedOpfsFixture(
  page: Page,
  key: string,
  bytes: number,
): Promise<number> {
  return page.evaluate(
    async ({ key, bytes }) => {
      const segments = key.split("/").filter(Boolean);
      const filename = segments.pop();
      if (!filename || bytes <= 0) throw new Error("Invalid JM2 fixture request");
      let directory = await navigator.storage.getDirectory();
      for (const segment of segments) {
        directory = await directory.getDirectoryHandle(segment);
      }
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
    },
    { key, bytes },
  );
}

async function externalMediaJournal(
  page: Page,
  recordingId: string,
  destinationId: string,
): Promise<any> {
  return page.evaluate(
    async ({ recordingId, destinationId }) => {
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
        return rows.find(
          (row) =>
            row?.destinationId === destinationId &&
            row?.owner?.recordingId === recordingId,
        );
      } finally {
        database.close();
      }
    },
    { recordingId, destinationId },
  );
}

async function historyEntry(
  page: Page,
  recordingId: string,
): Promise<RecordingHistoryEntry> {
  const response = await sendRuntimeMessage<any>(page, {
    type: "LIST_RECORDING_HISTORY",
  });
  if (!response?.ok)
    throw new Error(`LIST_RECORDING_HISTORY failed: ${response?.error}`);
  const entry = (response.entries as RecordingHistoryEntry[]).find(
    (candidate) => candidate.id === recordingId,
  );
  if (!entry)
    throw new Error("Completed recording is missing from extension history");
  return entry;
}

async function waitForCrmRecording(
  request: APIRequestContext,
  origin: string,
  connectionId: string,
): Promise<{ id: string; connectionId: string }> {
  let match: { id: string; connectionId: string } | undefined;
  await expect
    .poll(
      async () => {
        const rows = await crmGet<Array<{ id: string; connectionId: string }>>(
          request,
          origin,
          "/api/interview-recordings/unmatched",
        );
        match = rows.find((row) => row.connectionId === connectionId);
        return Boolean(match);
      },
      { timeout: 60_000, intervals: [250, 500, 1_000, 2_000] },
    )
    .toBe(true);
  return match!;
}

async function crmGet<T>(
  request: APIRequestContext,
  origin: string,
  pathname: string,
): Promise<T> {
  const response = await request.get(`${origin}${pathname}`);
  await expectResponse(response, `GET ${pathname}`);
  return (await response.json()) as T;
}

async function crmPost<T>(
  request: APIRequestContext,
  origin: string,
  pathname: string,
  data?: unknown,
): Promise<T> {
  const response = await request.post(
    `${origin}${pathname}`,
    data === undefined ? {} : { data },
  );
  await expectResponse(response, `POST ${pathname}`);
  return (await response.json()) as T;
}

async function crmPatch<T>(
  request: APIRequestContext,
  origin: string,
  pathname: string,
  data: unknown,
): Promise<T> {
  const response = await request.patch(`${origin}${pathname}`, { data });
  await expectResponse(response, `PATCH ${pathname}`);
  return (await response.json()) as T;
}

async function crmStatus(
  request: APIRequestContext,
  origin: string,
  pathname: string,
  method: "GET" | "POST" = "GET",
): Promise<number> {
  const response = await request.fetch(`${origin}${pathname}`, { method });
  return response.status();
}

async function mediaRequest(
  request: APIRequestContext,
  origin: string,
  bearer: string,
  method: "GET" | "POST",
  pathname: string,
): Promise<{ status: number; code?: string }> {
  const response = await request.fetch(
    `${origin}/api/integrations/meeting-recorder/media/v1${pathname}`,
    {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
    },
  );
  let code: string | undefined;
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body.code === "string") code = body.code;
  } catch {
    // Successful playback responses contain JSON, while provider or framework
    // failures are still represented by the status if the body is not JSON.
  }
  return { status: response.status(), ...(code ? { code } : {}) };
}

async function mediaJsonRequest<T extends Record<string, unknown>>(
  request: APIRequestContext,
  origin: string,
  bearer: string,
  method: "GET" | "POST",
  pathname: string,
  data?: unknown,
): Promise<{ status: number; code?: string; body?: T }> {
  const response = await request.fetch(
    `${origin}/api/integrations/meeting-recorder/media/v1${pathname}`,
    {
      method,
      headers: { Authorization: `Bearer ${bearer}` },
      ...(data === undefined ? {} : { data }),
    },
  );
  let body: T | undefined;
  let code: string | undefined;
  try {
    body = (await response.json()) as T;
    const candidate = body as Record<string, unknown>;
    if (typeof candidate.code === "string") code = candidate.code;
  } catch {
    // Status still captures malformed/non-JSON receiver failures.
  }
  return {
    status: response.status(),
    ...(code ? { code } : {}),
    ...(body ? { body } : {}),
  };
}

async function expectResponse(
  response: Awaited<ReturnType<APIRequestContext["get"]>>,
  label: string,
) {
  if (!response.ok()) {
    throw new Error(
      `${label} failed: HTTP ${response.status()} — ${await response.text()}`,
    );
  }
}

async function proveBrowserPlayback(
  page: Page,
  url: string,
  mimeType: string,
): Promise<void> {
  const result = await page.evaluate(
    async ({ mediaUrl, type }) => {
      const element = document.createElement(
        type.startsWith("audio/") ? "audio" : "video",
      );
      element.muted = true;
      element.preload = "auto";
      element.src = mediaUrl;
      document.body.append(element);
      const wait = (event: string, timeoutMs = 20_000) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for ${event}`)),
            timeoutMs,
          );
          element.addEventListener(
            event,
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          element.addEventListener(
            "error",
            () => {
              clearTimeout(timer);
              reject(
                new Error(`Media error ${element.error?.code ?? "unknown"}`),
              );
            },
            { once: true },
          );
        });
      await wait("loadedmetadata");
      await element.play();
      await wait("timeupdate");
      const duration = element.duration;
      let sought = false;
      if (Number.isFinite(duration) && duration > 0.2) {
        element.currentTime = Math.min(
          duration * 0.5,
          Math.max(0.1, duration - 0.1),
        );
        await wait("seeked");
        sought = true;
      }
      element.pause();
      element.remove();
      return { duration, sought };
    },
    { mediaUrl: url, type: mimeType },
  );
  expect(result.duration).toBeGreaterThan(0);
  expect(result.sought).toBe(true);
}

async function sharePublications(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (
      !databases.some(
        (database) => database.name === "published-share-publications",
      )
    )
      return [];
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("published-share-publications");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains("publications")) {
      db.close();
      return [];
    }
    const tx = db.transaction("publications", "readonly");
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const request = tx.objectStore("publications").getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return values;
  });
}
