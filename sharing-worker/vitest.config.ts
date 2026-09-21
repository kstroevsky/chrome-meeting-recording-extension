import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

process.env.OWNER_API_TOKEN ??= 'test-owner-token';
process.env.CAPABILITY_KEY ??= 'test-capability-key-with-enough-entropy';
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
          OWNER_API_TOKEN: 'test-owner-token',
          CAPABILITY_KEY: 'test-capability-key-with-enough-entropy',
          SESSION_KEY: 'test-session-key-with-enough-entropy',
          TEST_D1_MIGRATIONS: migrations,
        },
      },
    }),
  ],
});
