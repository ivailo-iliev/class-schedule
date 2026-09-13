import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://localhost:4173';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
