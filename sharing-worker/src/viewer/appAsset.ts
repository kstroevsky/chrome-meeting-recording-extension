import { VIEWER_APP_JS } from './app.generated';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export function viewerAppScript(): Response {
  return new Response(VIEWER_APP_JS, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/javascript; charset=utf-8',
    },
  });
}
