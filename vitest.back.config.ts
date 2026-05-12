import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['back/services/**/*.{test,spec}.?(c|m)[jt]s?(x)', 'app/api/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  },
  resolve: {
    alias: {
      '@': path.resolve(dirname, './front/src'),
      '@front': path.resolve(dirname, './front/src'),
      '@back': path.resolve(dirname, './back'),
      '@shared': path.resolve(dirname, './shared'),
    },
  },
});
