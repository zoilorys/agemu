import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Process fixtures spawn their own children; avoid oversubscribing the host.
    maxWorkers: 2,
    // Integration suites share the selected fixture app and Simulator.
    fileParallelism: process.env.AGEMU_NATIVE !== '1',
  },
});
