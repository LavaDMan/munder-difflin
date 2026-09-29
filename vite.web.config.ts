import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * The web-client bridge build.
 *
 * This compiles `src/preload/index.ts` — upstream's own file, unmodified — for
 * the BROWSER, with the `electron` import aliased to a WebSocket-backed shim.
 * The output is a classic (IIFE) script that sets `window.cth` to exactly the
 * same ~191-method object the Electron renderer receives.
 *
 * Doing it this way rather than hand-writing a browser client is the whole
 * point: the renderer<->main contract stays defined in ONE place, so a method
 * added upstream appears in the browser with no work and no drift.
 *
 * IIFE, not ESM, because the shim must have run before the renderer's own
 * module bundle executes. A classic script in <head> does; a module would be
 * deferred alongside it and could lose the race.
 */
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      electron: resolve(__dirname, 'src/webbridge/electronShim.ts'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    // The renderer's CSP is `script-src 'self'`, so this must be a real file,
    // not an inline blob.
    lib: {
      entry: resolve(__dirname, 'src/preload/index.ts'),
      formats: ['iife'],
      name: '__cthBridge',
      fileName: () => 'cth-bridge.js'
    },
    minify: false,     // this is the seam people will debug; keep it readable
    sourcemap: true
  }
});
