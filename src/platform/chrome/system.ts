/** Optional development-only system CPU access. */

export function hasSystemCpuInfo(): boolean {
  return typeof chrome !== 'undefined'
    && !!chrome.system?.cpu
    && typeof chrome.system.cpu.getInfo === 'function';
}

export async function getSystemCpuInfo(): Promise<chrome.system.cpu.CpuInfo | null> {
  if (!hasSystemCpuInfo()) return null;
  return await chrome.system.cpu.getInfo();
}
