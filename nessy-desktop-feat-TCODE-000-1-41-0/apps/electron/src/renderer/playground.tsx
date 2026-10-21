// IMPORTANT: keep `mock-utils` as the FIRST local import. It installs the
// mock `window.electronAPI` as a top-level side effect on import, so that
// any renderer module that reads `window.electronAPI.*` at module-load time
// (e.g. `SessionFilesSection.tsx`'s top-level `getRuntimeEnvironment()`
// call) finds the mock in place before its own module is evaluated.
// The named import below is that same side-effecting import: the names it
// brings in are what the bridge check at the bottom of this file reads, and
// taking them from here rather than a second module is what keeps the install
// and the verdict in one place.
import { playgroundBridgeKind, playgroundBridgeRefusalHtml } from './playground/mock-utils'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { setupI18n } from '@nessy-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { ThemeProvider } from './context/ThemeContext'
import { Toaster } from './components/ui/sonner'
import { PlaygroundApp } from './playground/PlaygroundApp'
import { EscapeInterruptProvider } from './context/EscapeInterruptContext'
import { PlaygroundAppShellProvider } from './playground/PlaygroundAppShellProvider'
import './index.css'

// Initialize i18n before any React rendering. `useTranslation()` reads from
// the shared global instance, so we don't need an <I18nextProvider>.
setupI18n([initReactI18next])

const root = document.getElementById('root')!

/**
 * REFUSE to mount when the bridge is not the fixture (P6.668).
 *
 * `ensureMockElectronAPI()` installs the mock only `if (!window.electronAPI)`,
 * and every app `BrowserWindow` preloads `bootstrap-preload.cjs`, which has
 * already `contextBridge.exposeInMainWorld`-ed the real bridge by the time this
 * entry evaluates. So this page opened inside an app window renders every
 * registry entry against the LIVE session — real RPC, real sessions, real files
 * — and silently, because yielding to an existing bridge looks like politeness.
 * Already observed: `overrideElectronApiMethod`'s docblock records the
 * `input-container` entry crashing on `Cannot assign to read only property`
 * because the real API was there.
 *
 * A refusal, not a fallback: wrapping the real bridge in something mock-shaped
 * means deciding per method which live calls are safe, which is wrong the moment
 * a method is added and wrong invisibly. And a VISIBLE one — a design surface
 * that failed closed without saying so would be read as a broken playground and
 * worked around.
 *
 * Residue, stated rather than implied: this stops the RENDER, which is what
 * drives RPC. It cannot stop an import-time read of `window.electronAPI` in a
 * module the imports above already pulled in, because ESM imports are hoisted
 * above every statement here. Those are reads, not session-driving calls, and
 * closing them would mean the page could not be built at all.
 */
if (playgroundBridgeKind() === 'foreign') {
  console.error('[Playground] Refusing to mount: window.electronAPI was already present')
  // Static markup with no interpolation (see the function's docblock), which is
  // why this is `innerHTML` and not a node builder: the test environment here
  // has no DOM, and a refusal nobody can test is a refusal nobody can trust.
  root.innerHTML = playgroundBridgeRefusalHtml()
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <JotaiProvider>
        <ThemeProvider>
          <EscapeInterruptProvider>
            <PlaygroundAppShellProvider>
              <PlaygroundApp />
              <Toaster />
            </PlaygroundAppShellProvider>
          </EscapeInterruptProvider>
        </ThemeProvider>
      </JotaiProvider>
    </React.StrictMode>
  )
}
