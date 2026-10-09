import {
  expect,
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
const LARGE_FIXTURE_BYTES = 1024 * 1024 * 1024 + 12_345;
const RESTART_FIXTURE_BYTES = 256 * 1024 * 1024 + 12_345;

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
): Promise<void> {
  const response = await request.post(`${origin}/api/auth/dev-login`, {
    data: { email: CRM_ADMIN_EMAIL },
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
  return { connection, created };
}

async function record(
  page: Page,
  meet: Page,
  tabId: number,
  destinationProfileId: string,
): Promise<string> {
  const response = await sendRuntimeMessage<any>(page, {
    type: "START_RECORDING",
    tabId,
    runConfig: {
      storageMode: "local",
      micMode: "off",
      recordSelfVideo: false,
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
  await meet.waitForTimeout(2_500);
  await stopRecording(page);
  return recordingId;
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
