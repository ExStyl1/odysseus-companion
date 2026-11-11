import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [{ name: 'companion-third-party-notices', generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source:
      ['react', 'react-dom'].map(name => `${name}\n${readFileSync(new URL(`./node_modules/${name}/LICENSE`, import.meta.url), 'utf8')}`).join('\n\n') });
  } }],
  build: {
    outDir: '../ui', emptyOutDir: true, target: 'chrome120',
    lib: { entry: 'src/main.tsx', name: 'CompanionReact', formats: ['iife'], fileName: () => 'companion-ui.js' },
    cssCodeSplit: false,
    rollupOptions: { output: { assetFileNames: 'companion-ui.[ext]' } }
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') }
});
