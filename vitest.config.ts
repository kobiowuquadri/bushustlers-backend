import { defineConfig } from 'vitest/config';

// Integration tests run against a disposable local MySQL database (never the shared Clever Cloud database).
// Override with TEST_DB_* variables; tests/global-setup.ts refuses to run against a non-local or non-*_test database.
const testEnv: Record<string, string> = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  // A path that does not exist, so tests never read the developer's .env (which may point at a shared database)
  ENV_FILE: 'tests/.env.does-not-exist',
  SECRET_KEY: 'test-secret-key-for-integration-tests-only-0123456789',
  FRONTEND_URL: 'http://localhost:3000',
  CORS_ORIGIN: 'http://localhost:3000',
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3307',
  DB_USER: process.env.TEST_DB_USER || 'bushustlers',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'local-dev-only',
  DB_NAME: process.env.TEST_DB_NAME || 'bushustlers_test',
  PAYMENTS_PROVIDER: 'demo',
  DEMO_TOOLS: 'true',
  DEV_MAILBOX: 'true',
  RECONCILE_INTERVAL_SECONDS: '0',
  BUSHA_STABLECOIN_OPTIONS: 'USDT:TRX,USDC:BASE',
};

// Applied here as well so the global setup (main process) and the test workers see the same values
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: testEnv,
  },
});
