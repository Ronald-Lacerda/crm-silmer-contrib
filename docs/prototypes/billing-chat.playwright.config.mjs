import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '../../test/e2e',
  testMatch: 'prototype-billing-chat.spec.js',
  workers: 1,
  timeout: 30000,
  use: {
    browserName: 'chromium',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  reporter: 'list',
});
