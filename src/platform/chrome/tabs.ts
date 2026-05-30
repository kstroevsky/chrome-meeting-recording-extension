/**
 * @file platform/chrome/tabs.ts
 *
 * Shared wrappers for active-tab queries, runtime-page tabs, tab messaging,
 * and tab capture stream IDs.
 */

import { getRuntimeUrl } from './runtime';
import { E2E_MOCK_TAB_STREAM_ID, isE2EMockCaptureBuild } from '../../shared/build';

export async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

export async function createRuntimeTab(path: string): Promise<chrome.tabs.Tab> {
  return await chrome.tabs.create({ url: getRuntimeUrl(path) });
}

/** Resolves a tab by id, returning null when it no longer exists. */
export async function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

export async function sendTabMessage<T = unknown>(tabId: number, message: unknown): Promise<T> {
  return await chrome.tabs.sendMessage(tabId, message) as T;
}

export function getMediaStreamIdForTab(tabId: number): Promise<string> {
  if (isE2EMockCaptureBuild()) {
    return Promise.resolve(`${E2E_MOCK_TAB_STREAM_ID}:${tabId}`);
  }

  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id?: string) => {
        const error = chrome.runtime.lastError?.message;
        if (error) return reject(new Error(error));
        if (!id) return reject(new Error('Empty streamId'));
        resolve(id);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function getCapturedTabs(): Promise<chrome.tabCapture.CaptureInfo[]> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getCapturedTabs((result) => {
        const error = chrome.runtime.lastError?.message;
        if (error) return reject(new Error(error));
        resolve(result ?? []);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function addTabRemovedListener(
  listener: (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void
): void {
  chrome.tabs.onRemoved.addListener(listener);
}

export function addTabUpdatedListener(
  listener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void
): void {
  chrome.tabs.onUpdated.addListener(listener);
}
