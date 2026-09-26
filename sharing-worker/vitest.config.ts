import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

process.env.CAPABILITY_KEY ??= 'test-capability-key-with-enough-entropy';
process.env.CAPABILITY_KEYS_JSON ??= JSON.stringify({ v1: 'test-capability-v1-with-enough-entropy' });
process.env.SESSION_KEY ??= 'test-session-key-with-enough-entropy';

const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          ALLOWED_EXTENSION_ORIGINS: 'chrome-extension://test-extension',
          VIEWER_SESSION_TTL_SECONDS: '3600',
          OWNER_SESSION_TTL_SECONDS: '3600',
          GOOGLE_OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
          CAPABILITY_KEY_ID: 'v1',
          CAPABILITY_KEY: 'test-capability-key-with-enough-entropy',
          CAPABILITY_KEYS_JSON: JSON.stringify({ v1: 'test-capability-v1-with-enough-entropy' }),
          SESSION_KEY: 'test-session-key-with-enough-entropy',
          OWNER_MUTATION_RATE_PER_MINUTE: '120',
          MAX_SHARES_PER_OWNER: '200',
          MAX_OWNER_STORED_BYTES: '536870912000',
          STALE_DRAFT_TTL_SECONDS: '604800',
          REVOKED_RETENTION_SECONDS: '2592000',
          TEST_D1_MIGRATIONS: migrations,
        },
      },
    }),
  ],
});
