/** Chrome optional-host-permission seam. Calls that request access must originate from a user gesture. */
export async function containsHostPermission(originPattern: string): Promise<boolean> {
  return await chrome.permissions.contains({ origins: [originPattern] });
}

export async function requestHostPermission(originPattern: string): Promise<boolean> {
  return await chrome.permissions.request({ origins: [originPattern] });
}

/** Request all required storage hosts in one explicit click, preserving user activation. */
export async function requestHostPermissions(originPatterns: string[]): Promise<boolean> {
  return await chrome.permissions.request({ origins: originPatterns });
}

export async function removeHostPermission(originPattern: string): Promise<boolean> {
  return await chrome.permissions.remove({ origins: [originPattern] });
}
