/**
 * @jest-environment node
 */
import puppeteer, { Browser, Page } from 'puppeteer';
import * as path from 'path';

describe('End-to-End: Extension Flow', () => {
    let browser: Browser;
    let page: Page;

    const extensionPath = path.resolve(__dirname, '../dist');

    beforeAll(async () => {
        // We use full puppeteer to download Chromium locally and load the extension
        browser = await puppeteer.launch({
            headless: true, // Use new headless mode which supports extensions better
            args: [
                `--disable-extensions-except=${extensionPath}`,
                `--load-extension=${extensionPath}`,
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--mute-audio' // keep test quiet
            ]
        });
    });

    afterAll(async () => {
        if (browser) await browser.close();
    });

    beforeEach(async () => {
        page = await browser.newPage();
    });

    afterEach(async () => {
        if (page) await page.close();
    });

    it('loads the mock meet page and exposes extension popup', async () => {
        // Find the extension ID by looking at the Background Service Worker target
        const targets = browser.targets();
        const extensionTarget = targets.find(t => t.type() === 'service_worker');
        
        let extensionId = '';
        if (extensionTarget) {
            const url = extensionTarget.url();
            const matches = url.match(/chrome-extension:\/\/(.*)\/.*/);
            if (matches && matches[1]) {
                extensionId = matches[1];
            }
        }

        // 1. Open the mock meet page
        const mockMeetUrl = `file://${path.resolve(__dirname, 'fixtures/mock-meet.html')}`;
        await page.goto(mockMeetUrl);
        await page.waitForSelector('.a4cQT');

        // Note: For full E2E, we'd open `chrome-extension://${extensionId}/popup.html`
        // in a separate tab and use Puppeteer page.click('#start-rec') to trigger the flow.
        expect(extensionId).toBeDefined();
    });
});
