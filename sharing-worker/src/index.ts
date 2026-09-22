import { json } from './http/responses';
import { route } from './router';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('sharing worker request failed', error);
      return json({ code: 'INTERNAL_ERROR', message: 'Unexpected sharing service error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
