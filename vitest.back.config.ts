import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['back/services/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
