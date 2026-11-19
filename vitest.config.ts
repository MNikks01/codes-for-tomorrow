import { defineConfig } from 'vitest/config';

// Infra-backed suites run against an isolated database and the Firestore emulator,
// never against development or production data.
const infraEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL:
    process.env['TEST_DATABASE_URL'] ?? 'postgresql://chat:chat@localhost:5432/chat_test',
  FIRESTORE_EMULATOR_HOST: process.env['FIRESTORE_EMULATOR_HOST'] ?? 'localhost:8080',
  FIREBASE_PROJECT_ID: 'demo-chat-backend',
  JWT_ACCESS_SECRET: 'test-only-secret-which-is-long-enough-0123456789',
};

export default defineConfig({
  test: {
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/server.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          env: infraEnv,
          globalSetup: ['tests/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts', 'tests/security/**/*.test.ts'],
          env: infraEnv,
          globalSetup: ['tests/helpers/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
