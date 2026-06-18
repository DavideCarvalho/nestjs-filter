import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';

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
    // *.db.spec.ts need live MySQL/Postgres (docker-compose) and run only via `test:db`.
    // Exclude them from the default suite so the no-DB CI `test` job doesn't hit ECONNREFUSED.
    exclude: [...configDefaults.exclude, 'test/**/*.db.spec.ts'],
    setupFiles: ['reflect-metadata'],
    pool: 'forks',
  },
});
