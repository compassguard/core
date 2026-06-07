import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Vitest aparte para correr los tests heredados que viven en legacy/.
// El runner principal (vitest.back.config.ts, vitest.config.ts) excluye
// legacy/, así que estos tests solo corren a pedido con `npm run test:legacy`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['legacy/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
    exclude: ['node_modules/**', '.next/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(dirname, './legacy/front/src'),
      '@front': path.resolve(dirname, './legacy/front/src'),
      '@back': path.resolve(dirname, './legacy/back'),
      '@shared': path.resolve(dirname, './shared'),
    },
  },
});
