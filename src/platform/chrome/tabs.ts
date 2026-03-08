import { getRuntimeUrl } from './runtime';

export async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

export async function createRuntimeTab(path: string): Promise<chrome.tabs.Tab> {
  return await chrome.tabs.create({ url: getRuntimeUrl(path) });
}

export async function sendTabMessage<T = unknown>(tabId: number, message: unknown): Promise<T> {
  return await chrome.tabs.sendMessage(tabId, message) as T;
}

export function getMediaStreamIdForTab(tabId: number): Promise<string> {
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
