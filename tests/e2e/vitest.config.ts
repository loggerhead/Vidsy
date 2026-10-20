import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['specs/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 90_000,
    retry: 0,
  },
});
