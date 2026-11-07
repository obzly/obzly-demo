// Vite config for the live demo. scripts/setup.sh copies it into an Obzly
// checkout's frontend/ next to the app's own vite.config.ts, which it extends.
import { type ConfigEnv, type Plugin, defineConfig, mergeConfig } from 'vite';

import appConfig from './vite.config';

// A control plane: its one Site is simulated too, so Synthetics and the Site
// picker show.
const RUNTIME_CONFIG_JS = `window.__RUNTIME_CONFIG__ = ${JSON.stringify({ MODE: 'control-plane' })};\n`;

function demo(): Plugin {
  return {
    name: 'obzly-demo',
    // Start from the demo entry, which installs the demo and then loads main.tsx.
    // 'pre', so the swap happens before Vite resolves the page's scripts.
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace('/src/main.tsx', '/src/demo/entry.ts'),
    },
    configureServer(server) {
      server.middlewares.use('/runtime-config.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(RUNTIME_CONFIG_JS);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'runtime-config.js', source: RUNTIME_CONFIG_JS });
    },
  };
}

export default defineConfig(async (env: ConfigEnv) => {
  const app = typeof appConfig === 'function' ? await appConfig(env) : await appConfig;
  return mergeConfig(app, {
    plugins: [demo()],
    // scripts/setup.sh --link symlinks src/demo; keep its imports inside the checkout.
    resolve: { preserveSymlinks: true },
  });
});
