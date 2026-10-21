/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineConfig } from 'vitest/config';

const isCI = process.env.CI === 'true';
const coverageEnabled = process.env.NESSY_TEST_COVERAGE !== 'false';

export default defineConfig({
  test: {
    testTimeout: 30000,
    teardownTimeout: 30000,
    reporters: ['default', 'junit'],
    silent: true,
    setupFiles: ['./test-setup.ts'],
    outputFile: {
      junit: 'junit.xml',
    },
    fileParallelism: !isCI,
    coverage: {
      enabled: coverageEnabled,
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*'],
      reporter: [
        ['text', { file: 'full-text-summary.txt' }],
        'html',
        'json',
        'lcov',
        'cobertura',
        ['json-summary', { outputFile: 'coverage-summary.json' }],
      ],
    },
    poolOptions: {
      threads: {
        minThreads: isCI ? 1 : 8,
        maxThreads: isCI ? 1 : 16,
      },
    },
  },
});
