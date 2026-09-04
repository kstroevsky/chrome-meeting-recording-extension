/**
 * @file background/DrivePlaybackAuthLeaseManager.ts
 *
 * Lends a `<video>` element the right to read one Drive file, and nothing else
 * (ADR-0006 §16-17).
 *
 * A media element cannot set an `Authorization` header, so a declarativeNetRequest
 * session rule adds it on the way out. The rule is deliberately the narrowest
 * thing that works — one tab, `GET`, `media` resource type, and one exact file
 * URL — because a rule scoped to `www.googleapis.com/*` would hand the user's
 * OAuth token to every Google API call that tab makes.
 *
 * **The token never leaves this worker.** The player receives a URL.
 *
 * Session rules outlive the service worker, so `getSessionRules()` is the
 * durable state: ids are allocated against what is already installed, and a
 * restart reconciles rules whose tab is gone.
 */

import { getSessionRules, updateSessionRules, type SessionRule } from '../platform/chrome/declarativeNetRequest';

/** Marks the rules this manager owns, so it never disturbs anyone else's. */
const RULE_ID_BASE = 9_000;
const RULE_ID_CEILING = 9_999;

export const DRIVE_MEDIA_ORIGIN = 'https://www.googleapis.com';

/**
 * The spike (2026-09-04) showed this endpoint answers `206` directly with no
 * redirect, so the rule stays scoped to this one host. Do not widen it without
 * new evidence.
 */
export function driveMediaUrl(fileId: string): string {
  return `${DRIVE_MEDIA_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type DrivePlaybackAuthLeaseManagerDeps = {
  /** The extension's existing Drive token acquisition — never a second OAuth. */
  getToken: (options?: { refresh?: boolean }) => Promise<string>;
  warn?: (...args: unknown[]) => void;
};

export class DrivePlaybackAuthLeaseManager {
  constructor(private readonly deps: DrivePlaybackAuthLeaseManagerDeps) {}

  /**
   * Authorizes one file for one tab and returns the URL to play. Re-authorizing
   * the same pair replaces the rule, which is how a token refresh works.
   */
  async authorize(tabId: number, fileId: string, options?: { refresh?: boolean }): Promise<string> {
    const url = driveMediaUrl(fileId);
    const token = await this.deps.getToken(options);
    const existing = await this.owned();
    const stale = existing.filter((rule) => matches(rule, tabId, url)).map((rule) => rule.id);

    await updateSessionRules({
      removeRuleIds: stale,
      addRules: [this.rule(nextId(existing, stale), tabId, url, token)],
    });
    return url;
  }

  /** Releases every rule held for a tab — call when the player closes. */
  async releaseTab(tabId: number): Promise<void> {
    const ids = (await this.owned())
      .filter((rule) => rule.condition.tabIds?.includes(tabId))
      .map((rule) => rule.id);
    if (ids.length) await updateSessionRules({ removeRuleIds: ids });
  }

  /**
   * Drops authorizations whose tab no longer exists. Session rules survive a
   * service-worker restart but tabs do not, so without this a closed player
   * could leave a live credential attached to a recycled tab id.
   */
  async reconcile(liveTabIds: readonly number[]): Promise<number> {
    const live = new Set(liveTabIds);
    const orphaned = (await this.owned())
      .filter((rule) => !(rule.condition.tabIds ?? []).some((id) => live.has(id)))
      .map((rule) => rule.id);
    if (orphaned.length) await updateSessionRules({ removeRuleIds: orphaned });
    return orphaned.length;
  }

  private async owned(): Promise<SessionRule[]> {
    try {
      return (await getSessionRules()).filter((rule) => rule.id >= RULE_ID_BASE && rule.id <= RULE_ID_CEILING);
    } catch (error) {
      this.deps.warn?.('Could not read Drive playback rules', error);
      return [];
    }
  }

  private rule(id: number, tabId: number, url: string, token: string): SessionRule {
    return {
      id,
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [{
          header: 'Authorization',
          operation: 'set' as chrome.declarativeNetRequest.HeaderOperation,
          value: `Bearer ${token}`,
        }],
      },
      condition: {
        // Anchored to this exact media URL, so a different Drive file in the
        // same tab gets nothing.
        regexFilter: `^${escapeRegex(url)}`,
        requestMethods: ['get' as chrome.declarativeNetRequest.RequestMethod],
        resourceTypes: ['media' as chrome.declarativeNetRequest.ResourceType],
        tabIds: [tabId],
      },
    };
  }
}

function matches(rule: SessionRule, tabId: number, url: string): boolean {
  return (rule.condition.tabIds ?? []).includes(tabId)
    && rule.condition.regexFilter === `^${escapeRegex(url)}`;
}

function nextId(existing: SessionRule[], reusable: number[]): number {
  const taken = new Set(existing.map((rule) => rule.id).filter((id) => !reusable.includes(id)));
  for (let id = RULE_ID_BASE; id <= RULE_ID_CEILING; id += 1) if (!taken.has(id)) return id;
  throw new Error('No free Drive playback rule id');
}
