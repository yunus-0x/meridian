import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^(\.{1,2}\/.*)\.js$/,
        replacement: '$1.ts',
      },
    ],
  },
  test: {
    // Enable Vitest global APIs (describe, test, it, expect, vi, beforeAll, afterAll)
    globals: true,

    // Node.js execution environment
    environment: 'node',

    // Test file pattern matching
    include: ['test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/.agents/**',
    ],

    // Timeouts configured for Solana/DLMM cryptographic ops and file I/O
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 30000,

    // CRITICAL ISOLATION SETTINGS:
    // 1. fileParallelism: false ensures sequential file-by-file execution.
    // Prevents concurrent mutations of root JSON state files (state.json,
    // pool-memory.json, etc.) and standalone.lock race conditions.
    fileParallelism: false,

    // 2. isolate: true runs each test file in a clean, isolated worker context
    // so module-level registries and caches do not leak across suites.
    isolate: true,

    // 3. maxConcurrency: 1 prevents intra-file test concurrency.
    maxConcurrency: 1,

    // Mock hygiene: automatically reset, clear, and unstub after each test
    restoreMocks: true,
    clearMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,

    // Global setup hook file for offline guarantees and state snapshots
    setupFiles: ['./test/setup.ts'],

    // Code coverage configuration via v8 provider
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: [
        'src/**/*.ts',
        'standalone/**/*.ts',
        'tools/**/*.ts',
        '*.ts',
      ],
      exclude: [
        'test/**',
        'scripts/**',
        'node_modules/**',
        '**/*.d.ts',
        'vitest.config.ts',
      ],
    },

    // Module interop for smooth CJS/ESM dependency resolution
    deps: {
      interopDefault: true,
    },
  },
});
