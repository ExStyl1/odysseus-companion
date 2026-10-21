/**
 * Browser Toolbar — React entry point
 *
 * Renders the shared BrowserControls component inside a chromeless
 * BrowserWindow. Communicates with the main process via a dedicated
 * preload script (browser-toolbar preload).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { initReactI18next, useTranslation } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { setupI18n } from '@nessy-agent/shared/i18n'
import { EyeOff, ShieldAlert, X, XCircle } from 'lucide-react'
import { BrowserControls } from '@nessy-agent/ui'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import './index.css'

/**
 * P6.705 — this window gets the app's language, like every other window.
 *
 * The toolbar renders in its own `BrowserWindow` with its own entry chunk, so
 * nothing `main.tsx` does reaches it: `setupI18n` is a per-realm call and
 * without it `useTranslation()` returns the KEY, not the string. It is called
 * here, at module scope and before the first render, exactly as `main.tsx`
 * does, and with the same two plugins — `LanguageDetector` so the window
 * follows the language the user picked in Appearance (which the main window
 * caches in `localStorage` under `i18nextLng`, the detector's first source,
 * with the navigator language behind it), and `initReactI18next` so
 * `useTranslation` works at all. No IPC and no new channel: the language was
 * already on this origin.
 */
setupI18n([LanguageDetector, initReactI18next])

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** P6.536 — the per-origin question this pane is asking, if any. */
interface TrustPrompt {
  origin: string
  gate: 'navigation' | 'cdp'
}

interface ToolbarState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  themeColor?: string | null
  trustPrompt?: TrustPrompt | null
}

declare global {
  interface Window {
    browserToolbar: {
      instanceId: string
      navigate: (url: string) => Promise<void>
      goBack: () => Promise<void>
      goForward: () => Promise<void>
      reload: () => Promise<void>
      stop: () => Promise<void>
      setMenuGeometry: (open: boolean, height?: number) => Promise<void>
      hideWindow: () => Promise<void>
      closeWindowEntirely: () => Promise<void>
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onThemeColor: (callback: (color: string | null) => void) => () => void
      onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => () => void
      decideTrust: (verdict: 'allow-once' | 'always-allow' | 'deny') => Promise<void>
    }
  }
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function BrowserToolbarApp() {
  const { t } = useTranslation()
  const [state, setState] = useState<ToolbarState>({
    url: 'about:blank',
    title: t('browser.newTab'),
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  })
  const [themeColor, setThemeColor] = useState<string | null>(null)
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
  const menuContentRef = useRef<HTMLDivElement | null>(null)

  const api = window.browserToolbar

  useEffect(() => {
    if (!api) return
    return api.onStateUpdate((s) => {
      setState(s)
      // Sync theme color from full state push (initial load / reconnection)
      if ('themeColor' in s) {
        setThemeColor((s as ToolbarState).themeColor ?? null)
      }
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onThemeColor(setThemeColor)
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onForceCloseMenu(() => {
      setWindowMenuOpen(false)
    })
  }, [api])

  useEffect(() => {
    if (!api) return

    if (!windowMenuOpen) {
      void api.setMenuGeometry(false, 0)
      return
    }

    // Prime expansion immediately to avoid a constrained first measurement.
    void api.setMenuGeometry(true, 120)

    const sendGeometry = () => {
      const height = Math.ceil(menuContentRef.current?.getBoundingClientRect().height ?? 0)
      void api.setMenuGeometry(true, height)
    }

    let frame = requestAnimationFrame(sendGeometry)
    const observer = new ResizeObserver(() => {
      sendGeometry()
    })

    if (menuContentRef.current) {
      observer.observe(menuContentRef.current)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      void api.setMenuGeometry(false, 0)
    }
  }, [api, windowMenuOpen])

  const handleNavigate = useCallback((url: string) => {
    void api?.navigate(url)
  }, [api])

  const handleGoBack = useCallback(() => {
    void api?.goBack()
  }, [api])

  const handleGoForward = useCallback(() => {
    void api?.goForward()
  }, [api])

  const handleReload = useCallback(() => {
    void api?.reload()
  }, [api])

  const handleStop = useCallback(() => {
    void api?.stop()
  }, [api])

  const handleHideWindow = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.hideWindow()
  }, [api])

  const handleCloseWindowEntirely = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.closeWindowEntirely()
  }, [api])

  /**
   * P6.536 — the per-origin trust card.
   *
   * It expands the TOOLBAR window over the page rather than opening a dialog of
   * its own, through the same `setMenuGeometry` the window menu already uses:
   * the question is about the page underneath, so it has to sit in front of it,
   * and reusing the existing geometry channel means no new window, no new
   * lifecycle and no second way for a pane to be covered.
   *
   * The three buttons are exactly the owner's three verdicts. There is no
   * fourth "remember for this site and every subdomain": the store is keyed per
   * subdomain deliberately, and a control that widened it would silently undo
   * that.
   *
   * P6.705 — the strings are keys now, and so is every other string in this
   * window. The card was the row's occasion, but a window with three
   * translated labels and five English literals beside them is not a
   * translated window, so the menu items and the trigger's aria-label went with
   * them. The origin is interpolated rather than concatenated: both headings
   * are questions, and the word order around the origin differs by locale.
   */
  const trustPrompt = state.trustPrompt ?? null
  useEffect(() => {
    if (!api) return
    void api.setMenuGeometry(!!trustPrompt, trustPrompt ? 220 : 0)
  }, [api, trustPrompt])

  const decideTrust = useCallback((verdict: 'allow-once' | 'always-allow' | 'deny') => {
    void api?.decideTrust(verdict)
  }, [api])

  return (
    <>
      {/*
        Full-window outside-tap catcher while menu is open.
        Critical for draggable titlebar windows (Windows) where outside-click
        dismissal can be unreliable if events fall into app-region: drag zones.
      */}
      {windowMenuOpen && (
        <div
          className="fixed inset-0 z-[90] titlebar-no-drag bg-black/[0.0039215686]"
          onPointerDown={(event) => {
            event.preventDefault()
            setWindowMenuOpen(false)
          }}
        />
      )}

      {trustPrompt && (
        <div className="fixed inset-x-0 top-12 bottom-0 z-[120] titlebar-no-drag bg-background/95 backdrop-blur-sm px-6 py-5 flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground break-words">
                {trustPrompt.gate === 'cdp'
                  ? t('browser.trust.cdpTitle', { origin: trustPrompt.origin })
                  : t('browser.trust.navigationTitle', { origin: trustPrompt.origin })}
              </div>
              <div className="mt-1 text-xs text-foreground/60">
                {trustPrompt.gate === 'cdp'
                  ? t('browser.trust.cdpBody')
                  : t('browser.trust.navigationBody')}
              </div>
            </div>
          </div>
          <div className="mt-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => decideTrust('allow-once')}
              className="px-3 py-1.5 text-xs rounded-md bg-background shadow-minimal hover:bg-foreground/5"
            >
              {t('browser.trust.allowOnce')}
            </button>
            <button
              type="button"
              onClick={() => decideTrust('always-allow')}
              className="px-3 py-1.5 text-xs rounded-md bg-background shadow-minimal hover:bg-foreground/5"
            >
              {t('browser.trust.alwaysAllow')}
            </button>
            <button
              type="button"
              onClick={() => decideTrust('deny')}
              className="px-3 py-1.5 text-xs rounded-md text-destructive hover:bg-destructive/10"
            >
              {t('browser.trust.deny')}
            </button>
          </div>
        </div>
      )}

      <BrowserControls
        url={state.url}
        loading={state.isLoading}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        onNavigate={handleNavigate}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onReload={handleReload}
        onStop={handleStop}
        trailingContent={(
          <div className="ml-2 flex items-center gap-1.5 titlebar-no-drag">
            <DropdownMenu open={windowMenuOpen} onOpenChange={setWindowMenuOpen}>
              <DropdownMenuTrigger asChild>
                <HeaderIconButton
                  icon={<X className="h-3.5 w-3.5" />}
                  aria-label={t('browser.window.options')}
                  className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
                  style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
                />
              </DropdownMenuTrigger>

              <StyledDropdownMenuContent
                ref={menuContentRef}
                align="end"
                side="bottom"
                sideOffset={6}
                minWidth="min-w-44"
                className="titlebar-no-drag z-[110] max-h-none overflow-visible"
              >
                <StyledDropdownMenuItem onSelect={handleHideWindow}>
                  <EyeOff className="h-3.5 w-3.5" />
                  {t('browser.window.hide')}
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem variant="destructive" onSelect={handleCloseWindowEntirely}>
                  <XCircle className="h-3.5 w-3.5" />
                  {t('browser.window.closeEntirely')}
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        themeColor={themeColor}
        urlBarClassName="max-w-[600px]"
        className="titlebar-drag-region bg-background"
      />
    </>
  )
}

/* ------------------------------------------------------------------ */
/*  Mount                                                              */
/* ------------------------------------------------------------------ */

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserToolbarApp />
  </React.StrictMode>,
)
