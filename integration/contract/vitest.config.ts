import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
    }),
  ],
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.{spec,test}.ts'],
    setupFiles: ['reflect-metadata'],
    pool: 'forks',
    // Real-DB matrix (test:db) starts/stops containers per dialect — give it
    // room. SQLite (default `test`) finishes in well under this.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
