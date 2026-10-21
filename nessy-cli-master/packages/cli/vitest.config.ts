/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

const isCI = process.env.CI === 'true';
const coverageEnabled = process.env.NESSY_TEST_COVERAGE !== 'false';

export default defineConfig({
  resolve: {
    alias: {
      '@nestor/nessy-cli-core': path.resolve(__dirname, '../core/index.ts'),
      ink: path.resolve(__dirname, 'node_modules/ink/build/index.js'),
      // cli's daemon-status-provider.test.ts imports `FakeAgent` /
      // `makeChannel` from acp-bridge's package-private
      // `internal/testUtils` module. This alias overrides the runtime
      // resolution so vitest reads the .ts source directly instead of
      // the build-then-stale `dist/` copy.
      '@nestor/nessy-cli-acp-bridge/internal/testUtils': path.resolve(
        __dirname,
        '../acp-bridge/src/internal/testUtils.ts',
      ),
      // Same rationale as above: bridgeErrors and status subpaths
      // resolve to dist/ via package.json exports, but tests in the
      // monorepo worktree need the live source (dist may be stale or
      // absent during development).
      '@nestor/nessy-cli-acp-bridge/bridgeErrors': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeErrors.ts',
      ),
      '@nestor/nessy-cli-acp-bridge/status': path.resolve(
        __dirname,
        '../acp-bridge/src/status.ts',
      ),
      '@nestor/nessy-cli-acp-bridge/bridge': path.resolve(
        __dirname,
        '../acp-bridge/src/bridge.ts',
      ),
      '@nestor/nessy-cli-acp-bridge/spawnChannel': path.resolve(
        __dirname,
        '../acp-bridge/src/spawnChannel.ts',
      ),
      '@nestor/nessy-cli-acp-bridge/bridgeClient': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeClient.ts',
      ),
      '@nestor/nessy-cli-acp-bridge/bridgeOptions': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeOptions.ts',
      ),
      '@nestor/nessy-cli-acp-bridge/bridgeTypes': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeTypes.ts',
      ),
      '@nestor/nessy-cli-acp-bridge/bridgeFileSystem': path.resolve(
        __dirname,
        '../acp-bridge/src/bridgeFileSystem.ts',
      ),
      '@nestor/nessy-cli-acp-bridge/workspacePaths': path.resolve(
        __dirname,
        '../acp-bridge/src/workspacePaths.ts',
      ),
      '@nestor/nessy-cli-audio-capture': path.resolve(
        __dirname,
        '../audio-capture/src/index.ts',
      ),
    },
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,
    include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)', 'config.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/cypress/**'],
    environment: 'jsdom',
    globals: true,
    reporters: ['default', 'junit'],
    silent: true,
    outputFile: {
      junit: 'junit.xml',
    },
    setupFiles: ['./test-setup.ts'],
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
        // CI Kubernetes runners are memory-constrained; the local values can
        // get the CLI suite OOM-killed before tests even start, so keep the
        // test runner strictly single-threaded there.
        minThreads: isCI ? 1 : 8,
        maxThreads: isCI ? 1 : 16,
      },
    },
    server: {
      deps: {
        inline: [/@nestor\/nessy-cli-core/, 'ink-testing-library'],
      },
    },
  },
});
