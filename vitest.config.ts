import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Tests share process.env overrides; run files one at a time.
    fileParallelism: false,
  },
});
