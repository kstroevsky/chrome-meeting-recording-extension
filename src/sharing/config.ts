/** Sharing service origin stamped into the extension bundle at build time. */
export function sharingServiceOrigin(): string {
  return typeof __SHARING_SERVICE_ORIGIN__ === 'string' ? __SHARING_SERVICE_ORIGIN__ : '';
}
