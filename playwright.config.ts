import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/generated',
  reporter: 'list',
  use: {
    channel: 'chrome',
  },
});