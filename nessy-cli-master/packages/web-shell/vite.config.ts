import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json' with { type: 'json' };

const daemonProxy: ProxyOptions = {
  target: process.env['NESSY_DAEMON_URL'] ?? 'http://127.0.0.1:4170',
  changeOrigin: true,
  bypass: (req) => {
    if (req.url?.startsWith('/api/')) return undefined;
    const fetchMode = req.headers['sec-fetch-mode'];
    const fetchDest = req.headers['sec-fetch-dest'];
    const accept = req.headers.accept ?? '';
    const isDocumentNavigation =
      fetchMode === 'navigate' ||
      fetchDest === 'document' ||
      accept.trim().toLowerCase().startsWith('text/html');
    if (isDocumentNavigation) {
      return '/index.html';
    }
    return undefined;
  },
  configure: (proxy) => {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.removeHeader('origin');
      proxyReq.removeHeader('referer');
    });
  },
};

export default defineConfig(({ command }) => ({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias:
      command === 'serve'
        ? {
            '@nestor/nessy-cli-webui/daemon-react-sdk': resolve(
              __dirname,
              '../webui/src/daemon-react-sdk.ts',
            ),
            '@nestor/nessy-cli-webui': resolve(__dirname, '../webui/src/index.ts'),
            '@nestor/nessy-cli-sdk/daemon': resolve(
              __dirname,
              '../sdk-typescript/src/daemon/index.ts',
            ),
            '@nestor/nessy-cli-sdk': resolve(
              __dirname,
              '../sdk-typescript/src/index.ts',
            ),
          }
        : {},
    dedupe: ['react', 'react-dom', '@nestor/nessy-cli-webui', '@nestor/nessy-cli-sdk'],
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  define: {
    __WEB_SHELL_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    cors: false,
    port: 5173,
    proxy: {
      '/health': daemonProxy,
      '/capabilities': daemonProxy,
      '/session': daemonProxy,
      '/permission': daemonProxy,
      '/workspace': daemonProxy,
      '/file': daemonProxy,
      '/stat': daemonProxy,
      '/list': daemonProxy,
      '/glob': daemonProxy,
    },
  },
}));
