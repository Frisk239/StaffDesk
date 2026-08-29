import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/brain/**/*.ts'],
      thresholds: {
        lines: 80,
      },
      reporter: ['text', 'text-summary'],
    },
  },
});
