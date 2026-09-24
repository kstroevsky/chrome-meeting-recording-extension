export type NormalizedWebhookEndpoint = {
  endpoint: string;
  hostPermission: string;
};

/** Production V1 follows the manifest's verified arbitrary-HTTPS permission boundary. */
export function normalizeWebhookEndpoint(value: string): NormalizedWebhookEndpoint {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Webhook endpoint is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('Webhook endpoint must use HTTPS');
  if (url.username || url.password) throw new Error('Webhook endpoint must not contain URL credentials');
  if (url.hash) throw new Error('Webhook endpoint must not contain a fragment');
  return {
    endpoint: url.toString(),
    hostPermission: `${url.origin}/*`,
  };
}
