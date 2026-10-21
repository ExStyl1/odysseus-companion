import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Safe mode's visible half (`env-vars.md:318`).
 *
 * A session that loads no CLAUDE.md, skills, plugins, hooks, MCP servers,
 * commands or agents is indistinguishable from a broken one, so the posture
 * must be stated in the app rather than only in the environment.
 *
 * NOT dismissible, unlike `GatewayAuthBanner`: this is a security posture that
 * holds for the life of the process, and a user who dismissed it would be
 * looking at an empty capability list with no explanation. It also says the
 * half that makes safe mode a posture rather than a debug flag — that managed
 * policy still applies.
 */
export function SafeModeBanner() {
  const { t } = useTranslation()
  // Optional on the API so a thin-client/legacy preload stays valid; absent
  // reads as "not safe mode", which is the non-alarming default.
  if (!window.electronAPI?.isSafeModeSession?.()) return null

  return (
    <div
      role="status"
      className="h-12 shrink-0 pl-4 pr-4 flex items-center gap-3 border-b border-foreground/10 bg-background select-none"
    >
      <ShieldAlert className="h-4 w-4 shrink-0 text-muted-foreground" />
      <h3 className="text-sm font-medium text-foreground font-sans min-w-0 truncate">
        {t('safeMode.bannerTitle')}
        <span className="ml-2 text-xs font-normal text-muted-foreground">{t('safeMode.bannerNote')}</span>
      </h3>
      {/* P6.451 — the way back out, on the surface that says you are in.
          Before this row a relaunch inherited the environment it was started
          with, so a safe-mode session could only be left from a terminal; the
          relaunch clears BOTH accepted spellings, which is what makes a session
          started by a wrapper leavable at all. `ml-auto` rather than a
          `justify-between` on the row, so the truncating title keeps the space
          it already had. */}
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto shrink-0"
        onClick={() => { void window.electronAPI?.relaunchApp({ safeMode: false }) }}
      >
        {t('safeMode.bannerLeave')}
      </Button>
    </div>
  )
}
