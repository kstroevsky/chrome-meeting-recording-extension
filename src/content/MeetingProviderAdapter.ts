/**
 * @file content/MeetingProviderAdapter.ts
 *
 * Provider adapter contract used by the transcript collector so Meet-specific
 * DOM selectors stay isolated from the generic collection pipeline.
 */

import type { MeetingProviderInfo } from '../shared/provider';

export type CaptionBlockData = {
  key: string;
  speakerName: string;
  textNode: HTMLElement;
};

export interface MeetingProviderAdapter {
  getProviderInfo(location: Location, root: ParentNode): MeetingProviderInfo;
  findCaptionsRegion(root: ParentNode): HTMLElement | null;
  collectCaptionBlocks(node: Node): HTMLElement[];
  getCaptionBlockData(block: HTMLElement): CaptionBlockData | null;
}
