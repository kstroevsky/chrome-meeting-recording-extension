/** Chrome optional-host-permission seam. Calls that request access must originate from a user gesture. */
export async function containsHostPermission(originPattern: string): Promise<boolean> {
  return await chrome.permissions.contains({ origins: [originPattern] });
}

export async function requestHostPermission(originPattern: string): Promise<boolean> {
  return await chrome.permissions.request({ origins: [originPattern] });
}

export async function removeHostPermission(originPattern: string): Promise<boolean> {
  return await chrome.permissions.remove({ origins: [originPattern] });
}
