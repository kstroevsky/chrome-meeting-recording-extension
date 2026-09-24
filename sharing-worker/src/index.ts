import { PayloadTooLargeError, json, withSecurityHeaders } from './http/responses';
import { withOwnerCors } from './http/cors';
import { cleanupExpiredMediaCache } from './cache/mediaCache';
import { cleanupExpiredShares } from './maintenance/cleanup';
import { route } from './router';

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try {
      return withSecurityHeaders(await route(request, env, ctx));
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        return withSecurityHeaders(withOwnerCors(json({ code: 'PAYLOAD_TOO_LARGE' }, 413), request, env));
      }
      console.error(JSON.stringify({ event: 'sharing_request_failed', method: request.method }));
      return withSecurityHeaders(withOwnerCors(
        json({ code: 'INTERNAL_ERROR', message: 'Unexpected sharing service error' }, 500),
        request,
        env,
      ));
    }
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(Promise.all([
      cleanupExpiredMediaCache(env),
      cleanupExpiredShares(env),
    ])
      .then(([cache, shares]) => {
        console.log(JSON.stringify({ event: 'sharing_cleanup', cache, shares }));
      })
      .catch(() => {
        console.error(JSON.stringify({ event: 'sharing_cleanup_failed' }));
      }));
  },
} satisfies ExportedHandler<Env>;
