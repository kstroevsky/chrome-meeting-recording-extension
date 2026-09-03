/**
 * Throwaway spike service worker (ADR-0006).
 *
 * Holds the Drive access token in worker memory ONLY. The token is never sent
 * to the page, never put in a URL, and never logged — the spike asserts that.
 * The page can ask for a rule to be installed, but it cannot supply the tab id:
 * that comes from `sender.tab.id`, exactly as the real design requires.
 */

let token = null;
let installedRuleIds = [];

/** Escapes a Drive file id for use inside a DNR regexFilter. */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deliberately narrow: tab + GET + media + this exact media URL prefix. The
 * spike starts here and reports if playback needs anything broader, rather than
 * widening the rule up front.
 */
function buildRule(id, mediaUrl, tabId, accessToken) {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Authorization', operation: 'set', value: `Bearer ${accessToken}` }],
    },
    condition: {
      regexFilter: `^${escapeRegex(mediaUrl)}`,
      requestMethods: ['get'],
      resourceTypes: ['media'],
      tabIds: [tabId],
    },
  };
}

async function clearRules() {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  if (existing.length) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: existing.map((rule) => rule.id),
    });
  }
  installedRuleIds = [];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'SPIKE_INSTALL_RULE') {
    // The page never supplies a tab id; background reads it from the sender.
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse({ ok: false, error: 'No sender tab; refusing to install a rule' });
      return false;
    }
    if (!token) {
      sendResponse({ ok: false, error: 'No token in the spike worker' });
      return false;
    }
    (async () => {
      await clearRules();
      const rule = buildRule(1, msg.mediaUrl, tabId, token);
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
      installedRuleIds = [rule.id];
      const active = await chrome.declarativeNetRequest.getSessionRules();
      sendResponse({
        ok: true,
        tabId,
        // Echo the rule with the token redacted so the page can display it.
        rule: { ...rule, action: { ...rule.action, requestHeaders: [{ header: 'Authorization', operation: 'set', value: 'Bearer <redacted>' }] } },
        activeRuleCount: active.length,
      });
    })().catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  if (msg?.type === 'SPIKE_CLEAR_RULES') {
    clearRules()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }

  return false;
});

// The runner injects the token straight into worker scope, so it never travels
// through a page, a URL, or storage.
self.__setSpikeToken = (value) => { token = value; return true; };
self.__hasSpikeToken = () => Boolean(token);
self.__installedRuleIds = () => installedRuleIds;
