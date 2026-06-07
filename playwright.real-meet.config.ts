import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'real-meet.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  expect: {
    timeout: 15_000,
  },
  outputDir: 'output/real-meet/test-results',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'output/real-meet/html-report', open: 'never' }],
  ],
  use: {
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
});
