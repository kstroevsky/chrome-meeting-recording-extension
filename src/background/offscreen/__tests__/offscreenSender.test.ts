import { isTrustedOffscreenSender } from '../offscreenSender';

const OFFSCREEN = 'chrome-extension://ext-id/offscreen.html';

describe('isTrustedOffscreenSender', () => {
  // Sender shapes below were captured from Chrome, not invented.
  it('accepts the offscreen document (no tab, no frame id)', () => {
    expect(isTrustedOffscreenSender({ id: 'ext-id', url: OFFSCREEN }, OFFSCREEN, null)).toBe(true);
  });

  it('accepts the recorder tab runtime at the top frame', () => {
    const sender = { url: `${OFFSCREEN}?runtime=tab`, frameId: 0, tab: { id: 5 } as chrome.tabs.Tab };
    expect(isTrustedOffscreenSender(sender, OFFSCREEN, null)).toBe(true);
    expect(isTrustedOffscreenSender(sender, OFFSCREEN, 5)).toBe(true);
  });

  it('refuses a tab runtime that is not the known recorder tab', () => {
    const sender = { url: `${OFFSCREEN}?runtime=tab`, frameId: 0, tab: { id: 6 } as chrome.tabs.Tab };
    expect(isTrustedOffscreenSender(sender, OFFSCREEN, 5)).toBe(false);
  });

  it('refuses offscreen.html framed inside a web page', () => {
    const sender = {
      url: OFFSCREEN,
      frameId: 4,
      tab: { id: 9, url: 'https://attacker.example/' } as chrome.tabs.Tab,
    };
    expect(isTrustedOffscreenSender(sender, OFFSCREEN, null)).toBe(false);
  });

  it('refuses any other page, origin, or a missing sender', () => {
    expect(isTrustedOffscreenSender(undefined, OFFSCREEN, null)).toBe(false);
    expect(isTrustedOffscreenSender({ url: 'chrome-extension://ext-id/popup.html' }, OFFSCREEN, null)).toBe(false);
    expect(isTrustedOffscreenSender({ url: 'chrome-extension://other-id/offscreen.html' }, OFFSCREEN, null)).toBe(false);
    expect(isTrustedOffscreenSender({ url: 'not a url' }, OFFSCREEN, null)).toBe(false);
  });
});
