import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    viewport: { width: 390, height: 844 },
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: {
        ...devices['Pixel 7'],
        channel: 'chrome',
      },
    },
  ],
});
