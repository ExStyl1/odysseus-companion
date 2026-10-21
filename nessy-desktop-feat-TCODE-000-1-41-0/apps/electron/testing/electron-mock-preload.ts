/**
 * Bun test preload: mock the `electron` module so main-process suites collect
 * without the native binary.
 *
 * CI installs deps with `ELECTRON_SKIP_BINARY_DOWNLOAD=true`, so
 * `node_modules/electron` has no `path.txt` and its `index.js` does
 * `module.exports = <path string>` — a CommonJS module with NO named exports.
 * A static `import { ipcMain, BrowserWindow } from 'electron'` therefore fails
 * to link ("Export named 'ipcMain' not found") on strict (Linux) bun, and the
 * missing-binary branch throws "Electron failed to install" at import.
 *
 * The mock MUST expose the named exports as OWN ENUMERABLE KEYS of a plain
 * object — a bare `Proxy` (get-trap only) has no own keys, so bun can't derive
 * the ESM named exports from it and the static import still fails on Linux even
 * though it "works" on macOS. Each value is a recursive stub that is callable,
 * constructable, and property-accessible, so `new BrowserWindow().webContents.on(…)`,
 * `app.getPath(…)`, `Menu.buildFromTemplate([])`, `ipcMain.handle(…)` all no-op.
 *
 * Files needing specific behaviour still declare their own
 * `mock.module('electron', …)`, which overrides this baseline for that file.
 * Registered in both the top-level and `[test]` `preload` arrays in bunfig.toml
 * (bun test reads `[test].preload`).
 */
import { mock } from 'bun:test';

function stub(): unknown {
  const fn = function stubFn() {
    return stub();
  };
  return new Proxy(fn, {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a thenable (await import safe)
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === Symbol.iterator) return undefined;
      return stub();
    },
    apply() {
      return stub();
    },
    construct() {
      return stub();
    },
  });
}

// Every electron identifier imported anywhere in apps/electron/src, plus common
// extras, as own keys so `import { X } from 'electron'` links on strict bun.
const NAMES = [
  'app', 'BrowserWindow', 'BrowserView', 'WebContentsView', 'ipcMain', 'ipcRenderer',
  'contextBridge', 'shell', 'dialog', 'Menu', 'MenuItem', 'Tray', 'Notification',
  'nativeImage', 'nativeTheme', 'session', 'Session', 'protocol', 'net', 'screen',
  'powerMonitor', 'powerSaveBlocker', 'globalShortcut', 'clipboard', 'webUtils',
  'webContents', 'systemPreferences', 'desktopCapturer', 'safeStorage',
];

function buildElectronMock(): Record<string, unknown> {
  const mod: Record<string, unknown> = {};
  for (const name of NAMES) mod[name] = stub();
  // CJS/ESM interop: some importers use `import electron from 'electron'`.
  mod.default = mod;
  return mod;
}

mock.module('electron', buildElectronMock);

function buildElectronLogMock(): Record<string, unknown> {
  const noop = () => {};
  const logger: Record<string, unknown> = {
    transports: {
      file: { level: false },
      console: { level: false },
    },
    scope: () => logger,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    log: noop,
  };
  logger.default = logger;
  return logger;
}

mock.module('electron-log/main', buildElectronLogMock);
