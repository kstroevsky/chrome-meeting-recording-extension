'use strict';

function normalizeSharingServiceOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('SHARING_SERVICE_ORIGIN must be a valid HTTPS origin');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SHARING_SERVICE_ORIGIN must be a bare HTTPS origin');
  }
  return url.origin;
}

function sharingHostPermission(value) {
  const origin = normalizeSharingServiceOrigin(value);
  return origin ? `${origin}/*` : null;
}

module.exports = { normalizeSharingServiceOrigin, sharingHostPermission };
