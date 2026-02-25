import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode ?? 'test', process.cwd(), '');
  return {
    test: {
      // Integration tests hit real Azure endpoints — allow up to 30 s per test
      testTimeout: 30_000,
      include: ['test/**/*.test.ts'],
      reporters: ['verbose'],
      // Expose all .env variables to tests via process.env
      env,
    },
  };
});
