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
      { timeout: 180_000, intervals: [250, 500, 1_000, 2_000] },
    )
    .toBe(true);
  return last;
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
