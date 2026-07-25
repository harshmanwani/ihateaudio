import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : [['list']],

  use: {
    // Deliberately not 4321. Sharing a port with the dev server lets
    // reuseExistingServer silently point the suite at an unbuilt dev bundle,
    // which fails in ways that look like product bugs.
    baseURL: 'http://localhost:4331',
    trace: 'on-first-retry',
  },

  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    // The ringtone and social-edit tools are overwhelmingly used on phones, so
    // mobile is a first-class target rather than an afterthought.
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],

  // Always the built output: these tests exist to check what ships, and the
  // dev server's on-the-fly transforms are not that.
  webServer: {
    command: 'npm run build:fast && npm run preview -- --port 4331',
    url: 'http://localhost:4331',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
