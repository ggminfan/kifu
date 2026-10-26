import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // a throwaway HOME: no test reaches the user's real agent homes
    setupFiles: ['test/setup.ts'],
  },
});
