/**
 * @file content/GoogleMeetAdapter.ts
 *
 * Google Meet implementation of `MeetingProviderAdapter`.
 */

import type { MeetingProviderAdapter, CaptionBlockData } from './MeetingProviderAdapter';
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
} as const;

const CAMERA_ENABLED_LABELS = [
  'turn off camera',
  'turn off your camera',
  'camera off',
];

const CAMERA_DISABLED_LABELS = [
  'turn on camera',
  'turn on your camera',
  'camera on',
];

/** Normalizes button labels so camera-state matching is resilient to whitespace and casing. */
function normalizeLabel(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Infers the local Meet camera state from accessible toolbar/button labels when possible. */
function detectLocalCameraEnabled(root: ParentNode): boolean | null {
  const candidates = root.querySelectorAll<HTMLElement>('button[aria-label], [role="button"][aria-label]');

  for (const candidate of Array.from(candidates)) {
    const label = normalizeLabel(candidate.getAttribute('aria-label'));
    if (!label.includes('camera')) continue;

    if (CAMERA_ENABLED_LABELS.some((pattern) => label.includes(pattern))) {
      return true;
    }

    if (CAMERA_DISABLED_LABELS.some((pattern) => label.includes(pattern))) {
      return false;
    }
  }

  return null;
}

export class GoogleMeetAdapter implements MeetingProviderAdapter {
  getProviderInfo(location: Location, root: ParentNode): MeetingProviderInfo {
    const meetingId = location.pathname.split('/').pop() || null;
    return {
      providerId: 'google-meet',
      meetingId,
      supportsCaptions: true,
      localCameraEnabled: detectLocalCameraEnabled(root),
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
}
