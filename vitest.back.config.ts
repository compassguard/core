import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@back': path.resolve(__dirname, 'back'),
      '@shared': path.resolve(__dirname, 'shared/types'),
      '@hosted': path.resolve(__dirname, 'hosted'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'back/**/*.{test,spec}.?(c|m)[jt]s?(x)',
      'hosted/**/*.{test,spec}.?(c|m)[jt]s?(x)',
    ],
    exclude: ['node_modules/**', '.next/**'],
  },
});
