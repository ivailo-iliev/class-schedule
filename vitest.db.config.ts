import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/db/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
