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
    include: ['test/**/*.db.spec.ts'],
    setupFiles: ['reflect-metadata'],
    pool: 'forks',
    testTimeout: 60_000,
  },
});
