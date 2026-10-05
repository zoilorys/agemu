import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration suites share the selected fixture app and Simulator.
    fileParallelism: process.env.AGEMU_NATIVE !== '1',
  },
});
