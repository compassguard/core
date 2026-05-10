import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['BACK/services/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
  resolve: {
    alias: {
      '@': path.resolve(dirname, './FRONT/src'),
      '@front': path.resolve(dirname, './FRONT/src'),
      '@back': path.resolve(dirname, './BACK'),
      '@shared': path.resolve(dirname, './shared'),
    },
  },
});
