import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests spawn child processes — give them time
    // Local reasoning models can be very slow (~8 tok/s + 30-60s thinking per call).
    // Batch tests with 3 files need ~6-10 min; single-file tests need ~2-3 min.
    testTimeout: 900_000,
    hookTimeout: 120_000,
    // Only run integration + unit tests by default — live tests require LM Studio
    // Run live tests explicitly: npx vitest run src/live.test.ts
    include: [
      'src/index.test.ts',
      'src/grouping.test.ts',
    ],
  },
});
