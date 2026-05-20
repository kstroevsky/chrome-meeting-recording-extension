/**
 * @file content/GoogleMeetAdapter.ts
 *
 * Google Meet implementation of `MeetingProviderAdapter`.
 */

import type { MeetingProviderAdapter, CaptionBlockData, MeetingLifecycleState } from './MeetingProviderAdapter';
import type { MeetingProviderInfo } from '../shared/provider';

/**
 * ⚠️  FRAGILE SELECTORS — Reverse-engineered from Google Meet's obfuscated CSS.
 *
 * These WILL break if Google updates their frontend. When captions stop working:
 *   1. Open meet.google.com and start a meeting with captions ON.
 *   2. Open DevTools → Elements and inspect an active caption bubble.
 *   3. Find the element containing the spoken text and update captionText.
 *   4. Find the element containing the speaker's name and update speakerName.
 *   5. Find the parent container (one per active speaker) and update captionBlock.
 *
 * Also check: the aria-label of the region element in findCaptionsRegion()
 * in case Google renames the "Captions" region.
 *
 * Last verified: 2026-03
 */
const MEET_SELECTORS = {
  captionText: '.ygicle',
  speakerName: '.NWpY1d',
  captionBlock: '.nMcdL',
  leaveCallControl: [
    '[aria-label*="Leave call" i]',
    '[aria-label*="Leave meeting" i]',
    '[data-tooltip*="Leave call" i]',
    '[data-tooltip*="Leave meeting" i]',
  ].join(','),
} as const;

const ENDED_TEXT_PATTERNS = [
  /\byou'?ve left the meeting\b/i,
  /\byou left the meeting\b/i,
  /\bthe meeting has ended\b/i,
  /\bthis meeting has ended\b/i,
  /\breturn to home screen\b/i,
  /\brejoin\b/i,
  /\bre-join\b/i,
];

export class GoogleMeetAdapter implements MeetingProviderAdapter {
  getProviderInfo(location: Location, _root: ParentNode): MeetingProviderInfo {
    const meetingId = location.pathname.split('/').pop() || null;
    return {
      providerId: 'google-meet',
      meetingId,
      supportsCaptions: true,
    };
  }

  findCaptionsRegion(root: ParentNode): HTMLElement | null {
    return root.querySelector<HTMLElement>('div[role="region"][aria-label="Captions"]');
  }

  collectCaptionBlocks(node: Node): HTMLElement[] {
    if (!(node instanceof HTMLElement)) return [];

    const blocks: HTMLElement[] = [];
    if (node.matches(MEET_SELECTORS.captionBlock)) {
      blocks.push(node);
    }
    node.querySelectorAll<HTMLElement>(MEET_SELECTORS.captionBlock).forEach((block) => blocks.push(block));
    return blocks;
  }

  getCaptionBlockData(block: HTMLElement): CaptionBlockData | null {
    const textNode = block.querySelector<HTMLElement>(MEET_SELECTORS.captionText);
    if (!textNode) return null;

    const speakerName =
      block.querySelector<HTMLElement>(MEET_SELECTORS.speakerName)?.textContent?.trim() ?? ' ';

    return {
      key: block.getAttribute('data-participant-id') || speakerName,
      speakerName,
      textNode,
    };
  }

  getMeetingLifecycleState(root: ParentNode): MeetingLifecycleState {
    if (root.querySelector(MEET_SELECTORS.leaveCallControl)) return 'active';

    const bodyText = root instanceof Document
      ? root.body?.innerText || root.body?.textContent || ''
      : root.textContent || '';
    return ENDED_TEXT_PATTERNS.some((pattern) => pattern.test(bodyText))
      ? 'ended'
      : 'unknown';
  }
}
