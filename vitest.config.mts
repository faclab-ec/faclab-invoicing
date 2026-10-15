import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^#\/(.*)$/, replacement: fileURLToPath(new URL('./src/$1', import.meta.url)) },
      // Vite would load the ESM build for src and the SDK requires the CommonJS one: two copies of
      // the API, and a tracer provider registered in one is invisible to the other. One copy, as
      // in the service (CommonJS)
      { find: /^@opentelemetry\/api$/, replacement: require.resolve('@opentelemetry/api') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
