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
    // The ids are blanked explicitly, and this is not belt-and-braces.
    //
    // This builds in production mode, which loads .env.production, so the real
    // GA4 and PostHog ids were compiled in and every test run sent a few hundred
    // page_view events to production from localhost. An empty value in the
    // environment wins over the dotenv file, so nothing third-party loads.
    //
    // A test asserts the result, which is how this was caught.
    command:
      'PUBLIC_GA_ID= PUBLIC_POSTHOG_KEY= PUBLIC_GOOGLE_VERIFICATION= ' +
      'npm run build:fast && npm run preview -- --port 4331',
    url: 'http://localhost:4331',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
