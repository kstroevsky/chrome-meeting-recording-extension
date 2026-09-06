import { expect, test } from '@playwright/test';
import {
  closeHarness,
  findMockMeetTabId,
  launchExtensionHarness,
  openMockMeetPage,
  saveRecordingSettings,
  startRecording,
  stopRecording,
} from './helpers/extensionHarness';
import { installDriveSimulator, setDriveMediaContent } from './helpers/driveSimulator';

const DRIVE_FILE_ID = 'mock-drive-media-1';
const DRIVE_FILE_ID_MARKER = 'mock-drive-media-1';

/**
 * Drive playback without a local copy: the picture comes from
 * `files.get?alt=media`, authorized by a tab-scoped declarativeNetRequest rule
 * that the page never sees. A successful Drive upload deletes its staging file,
 * so this is the shape most recordings actually have.
 */
test.describe('Drive playback (integration)', () => {
  test('streams a Drive-only recording through the DNR lease, with no token in the page', async ({}, testInfo) => {
    const harness = await launchExtensionHarness(testInfo.outputPath.bind(testInfo));
    try {
      const stats = await installDriveSimulator(harness.context, 'fast');

      // Produce real MediaRecorder bytes rather than a synthetic fixture, then
      // serve those same bytes as the Drive copy.
      const meetPage = await openMockMeetPage(harness.context);
      const meetTabId = await findMockMeetTabId(harness.controlPage);
      await saveRecordingSettings(harness.controlPage);
      await startRecording(harness.controlPage, meetTabId, {
        storageMode: 'local', micMode: 'off', recordSelfVideo: false,
      });
      await meetPage.waitForTimeout(1_500);
      await stopRecording(harness.controlPage);

      const page = await harness.context.newPage();
      await page.goto(`chrome-extension://${harness.extensionId}/recordings.html`, {
        waitUntil: 'domcontentloaded',
      });
      await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 20_000 });

      const encoded = await expect.poll(async () => await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const library = await root.getDirectoryHandle('library').catch(() => null);
        if (!library) return null;
        for await (const owner of (library as unknown as { keys(): AsyncIterable<string> }).keys()) {
          const dir = await library.getDirectoryHandle(owner);
          for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            const file = await (await dir.getFileHandle(name)).getFile();
            const buffer = new Uint8Array(await file.arrayBuffer());
            let binary = '';
            for (const byte of buffer) binary += String.fromCharCode(byte);
            return btoa(binary);
          }
        }
        return null;
      }), { timeout: 25_000 }).not.toBeNull();
      void encoded;
      const base64 = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const library = await root.getDirectoryHandle('library');
        for await (const owner of (library as unknown as { keys(): AsyncIterable<string> }).keys()) {
          const dir = await library.getDirectoryHandle(owner);
          for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
            const file = await (await dir.getFileHandle(name)).getFile();
            const buffer = new Uint8Array(await file.arrayBuffer());
            let binary = '';
            for (const byte of buffer) binary += String.fromCharCode(byte);
            return btoa(binary);
          }
        }
        throw new Error('no retained media');
      });
      setDriveMediaContent(DRIVE_FILE_ID, Buffer.from(base64, 'base64'));

      // Rewrite history into the shape a successful Drive upload leaves behind:
      // a Drive replica and no local copy at all.
      await page.evaluate(async (fileId) => {
        const open = () => new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('recording-history');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const db = await open();
        const store = db.transaction('recordings', 'readwrite').objectStore('recordings');
        const all: any[] = await new Promise((resolve) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result);
        });
        for (const entry of all) {
          for (const file of entry.files ?? []) {
            if (file.kind === 'notes') continue;
            file.locations = [{ kind: 'drive', fileId }];
            file.driveFileId = fileId;
            file.destination = 'drive';
            file.delivery = { requested: 'drive', status: 'uploaded' };
          }
          entry.storageMode = 'drive';
          store.put(entry);
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }, DRIVE_FILE_ID);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.locator('.recording-row').first()).toBeVisible({ timeout: 20_000 });
      await page.locator('.recording-row__play').first().click();
      await expect(page.locator('.player')).toBeVisible();

      // The element points at Drive, not at a local blob.
      const video = page.locator('.player__video');
      await expect.poll(async () => await video.getAttribute('src'), { timeout: 20_000 })
        .toMatch(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\//);

      /*
       * The security-critical assertion, and the one this harness *can* make:
       * the installed rule is the narrowest thing that works. Playwright fulfils
       * intercepted requests before declarativeNetRequest's `modifyHeaders`
       * runs, so whether the header reaches the wire is unobservable here — that
       * is proven against real Drive in `tests/spikes/drive-playback`.
       */
      const rules = await page.evaluate(async () => await chrome.declarativeNetRequest.getSessionRules());
      const rule = rules.find((candidate) => candidate.condition.regexFilter?.includes(DRIVE_FILE_ID_MARKER));
      expect(rule, 'a session rule authorizes this file').toBeDefined();
      expect(rule!.condition.requestMethods).toEqual(['get']);
      expect(rule!.condition.resourceTypes).toEqual(['media']);
      expect(rule!.condition.tabIds).toHaveLength(1);
      // Never a wildcard host: that would hand the token to every Google call.
      expect(rule!.condition.regexFilter).not.toContain('.*');
      expect(rule!.action.requestHeaders?.[0]).toMatchObject({ header: 'Authorization', operation: 'set' });

      // The media stack really fetched from Drive, and asked for byte ranges.
      await expect.poll(() => stats.mediaReads.length, { timeout: 20_000 }).toBeGreaterThan(0);
      expect(stats.mediaReads.every((read) => read.fileId === DRIVE_FILE_ID)).toBe(true);

      // The token reaches no surface the page can read. Taken from the rule the
      // worker installed, which is the only place it legitimately exists.
      const token = (rule!.action.requestHeaders?.[0].value ?? '').replace(/^Bearer /, '');
      expect(token.length).toBeGreaterThan(0);
      const surfaces = await page.evaluate(() => ({
        url: location.href,
        src: (document.querySelector('.player__video') as HTMLVideoElement)?.src ?? '',
        dom: document.documentElement.outerHTML,
        storage: JSON.stringify({ ...localStorage }),
      }));
      for (const [name, value] of Object.entries(surfaces)) {
        expect(`${name}:${value.includes(token)}`).toBe(`${name}:false`);
      }
    } finally {
      await closeHarness(harness);
    }
  });
});
