import { defineConfig } from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = Number(process.env.E2E_PORT ?? 3101);
const baseURL = `http://127.0.0.1:${port}`;
const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
// A fresh database for every invocation; tests never alter the normal demo database.
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'naryad-e2e-'));

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  // End-to-end scenarios include login, several screens and screenshots on the demo laptop.
  // Individual expectations still have their own shorter deadline below.
  timeout: 90_000,
  expect: { timeout: 12_000 },
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    locale: 'ru-RU',
    timezoneId: 'Asia/Qyzylorda',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? (existsSync(edge) ? edge : undefined),
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // Run `npm run build` before `npm run test:e2e` to serve the production PWA.
    command: 'node server/index.mjs',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 45_000,
    env: {
      PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
      NODE_ENV: 'production', COOKIE_SECURE: 'false',
      AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '', AI_SEND_PHOTOS: 'false',
    },
  },
});
