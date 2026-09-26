/** Sharing service origin stamped into the extension bundle at build time. */
export function sharingServiceOrigin(): string {
  return typeof __SHARING_SERVICE_ORIGIN__ === 'string' ? __SHARING_SERVICE_ORIGIN__ : '';
}

/**
 * The service-account email this build expects as Drive reader, or '' when the
 * build did not pin one (then only the service-account shape is enforced).
 */
export function sharingReaderEmail(): string {
  return typeof __SHARING_READER_EMAIL__ === 'string' ? __SHARING_READER_EMAIL__ : '';
}
