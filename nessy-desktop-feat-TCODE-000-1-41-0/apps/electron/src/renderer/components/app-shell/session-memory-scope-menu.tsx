/**
 * P6.703 — the per-CHAT memory scope, as a menu.
 *
 * The whole model shipped in `agent/memory/session-memory-scope.ts` and nothing
 * persisted a `SessionMemoryScopeOverride`, so the resolver was called with
 * `undefined` on every turn: a chat could be kept out of memory in theory and by
 * nobody in practice. This is the input half.
 *
 * ## Two axes, and each of them has THREE states
 *
 * May this chat READ existing memories, and may it FEED future ones. Each axis
 * is independently unset, and unset is not "off" — it FOLLOWS the app-wide
 * switch, which is what "without touching the global setting" means. So the menu
 * shows the resolved value on the checkmark and says, separately, whether the
 * chat has an opinion at all. Collapsing the two would tell a user who turned
 * memory off globally that every chat had been excluded individually.
 *
 * The reset item exists for the same reason: without it, a chat that once said
 * anything could never go back to following the global switch, and the third
 * state would be unreachable from the UI that created it.
 *
 * ## The residue line, and why it is not hidden
 *
 * `describeSessionMemoryScopeResidue` covers the half neither runtime can
 * express: codex's `ThreadMemoryMode` is ONE enum and claude's
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is ONE boolean, each governing reading and
 * writing together, so the projection is the CONJUNCTION — the runtime's own
 * store is enabled only when both axes are on. The host still honours the axis
 * the user kept; the runtime's private store does not. That is a real narrowing
 * and it is printed rather than left to be discovered.
 *
 * ## Why it renders nothing until the host answers
 *
 * The read can REFUSE — the session record that stores the override is another
 * lane's file and the verb says so by name rather than answering a default. An
 * unrecorded override that reads back as "no override" is indistinguishable from
 * a chat the user did exclude, which is the exact failure this row closes, so the
 * menu shows no memory section at all rather than a switch that does nothing.
 *
 * ## D1.215 / D1.139 — the same read now carries the RUNTIME's own postures
 *
 * Four claude facts were decided this month and every one reached a channel a
 * user of the packaged app never opens: the auto-memory disposition had ONE
 * consumer, a `debug(...)` a packaged build never prints; the restricted-mode
 * notice reaches the transcript banner, which is PUSH and only at session start;
 * the search-filter KEEP and the worktree cwd divergence were written into their
 * own docblocks. D1.215's reading is that this component is already the pull
 * surface they want — it does a per-session read, it already prints a runtime
 * residue line, and one field on that response carries all four.
 *
 * So this file renders TWO submenus from ONE read. The memory notice sits in the
 * memory submenu because its subject is memory; the rest sit in a second one,
 * which is absent entirely when the list is empty — every non-claude session
 * today. The alternative, a component per posture, is what W19-e's *"one info
 * surface, both rows"* refuses, and it would cost a second read each time.
 *
 * The wire carries the DISPOSITION and never the sentence: see
 * {@link runtimeNoticeKey}.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Check, Info, RotateCcw } from 'lucide-react'
import type {
  SessionMemoryScope,
  SessionMemoryScopeOverride,
} from '@nessy-agent/shared/agent/memory/session-memory-scope'
import type {
  SessionRuntimeNoticeIdV1,
  SessionRuntimeNoticeV1,
} from '@nessy-agent/shared/protocol/session-runtime-notices'
import { useMenuComponents } from '@/components/ui/menu-context'

export interface SessionMemoryScopeState {
  scope: SessionMemoryScope
  override: SessionMemoryScopeOverride
  /**
   * D1.215 — the runtime postures this session carries, resolved by the host on
   * the same read. Optional: a server that predates the field, and the
   * playground's injected reader, simply have none.
   */
  notices?: readonly SessionRuntimeNoticeV1[]
}

/**
 * D1.215 — one notice id, one locale key, through a switch that cannot be
 * satisfied by omission.
 *
 * The `never` binding is the whole guard: an id added to
 * `session-runtime-notices.ts` without words here fails `typecheck:electron`,
 * which is the only thing that stops a host-resolved posture arriving at a
 * surface that silently renders nothing — the failure D1.139 exists to close,
 * one layer up.
 *
 * The host sends the DISPOSITION and this maps it to a sentence, rather than the
 * host sending its own English sentence, because the modules that own these
 * postures write theirs for the transcript banner and the doctor — one English
 * voice each, deliberately, and the restricted-mode one relays the runtime's own
 * changelog wording verbatim. This surface is in the user's language.
 */
export function runtimeNoticeKey(id: SessionRuntimeNoticeIdV1): string {
  switch (id) {
    case 'claude-auto-memory-runtime-default': return 'sessionMenu.runtimeNote.claudeAutoMemoryOn'
    case 'claude-auto-memory-off-by-host': return 'sessionMenu.runtimeNote.claudeAutoMemoryOff'
    case 'claude-auto-memory-forced-on': return 'sessionMenu.runtimeNote.claudeAutoMemoryForcedOn'
    case 'claude-restricted-mode': return 'sessionMenu.runtimeNote.claudeRestrictedMode'
    case 'claude-search-results-filtered': return 'sessionMenu.runtimeNote.claudeSearchResultsFiltered'
    case 'claude-worktree-cwd-may-move': return 'sessionMenu.runtimeNote.claudeWorktreeCwd'
    default: {
      const unhandled: never = id
      return unhandled
    }
  }
}

/** The notices whose subject is MEMORY; they belong in the memory submenu. */
export function isMemoryRuntimeNotice(notice: SessionRuntimeNoticeV1): boolean {
  return notice.id.startsWith('claude-auto-memory-')
}

export interface SessionMemoryScopeMenuItemsProps {
  sessionId: string
  workspaceId: string
  /** Injected by the playground; the app uses the real bridge. */
  read?: () => Promise<SessionMemoryScopeState>
  write?: (override: SessionMemoryScopeOverride) => Promise<SessionMemoryScopeState>
}

/** True when the runtime's own store loses one of the two axes (the conjunction). */
export function projectionIsLossy(scope: SessionMemoryScope): boolean {
  return scope.read !== scope.write
}

export function SessionMemoryScopeMenuItems({
  sessionId,
  workspaceId,
  read,
  write,
}: SessionMemoryScopeMenuItemsProps) {
  const { t } = useTranslation()
  const { MenuItem, Sub, SubTrigger, SubContent } = useMenuComponents()
  const [state, setState] = React.useState<SessionMemoryScopeState | null>(null)

  React.useEffect(() => {
    let live = true
    const reader = read ?? (() => window.electronAPI.getSessionMemoryScope(sessionId, workspaceId))
    void reader()
      .then(next => { if (live) setState(next) })
      // A refusal is no section, never a broken menu — see this file's header.
      .catch(() => { if (live) setState(null) })
    return () => { live = false }
  }, [read, sessionId, workspaceId])

  const apply = React.useCallback(async (next: SessionMemoryScopeOverride) => {
    const writer = write ?? ((value: SessionMemoryScopeOverride) =>
      window.electronAPI.setSessionMemoryScope(sessionId, workspaceId, value))
    try {
      setState(await writer(next))
    } catch {
      // Leave the last known state on screen rather than a guess about what the
      // host now believes.
    }
  }, [write, sessionId, workspaceId])

  if (!state) return null

  const { scope, override } = state
  const followsGlobal = override.read === undefined && override.write === undefined
  const notices = state.notices ?? []
  const memoryNotices = notices.filter(isMemoryRuntimeNotice)
  const otherNotices = notices.filter(notice => !isMemoryRuntimeNotice(notice))

  return (
    <>
    <Sub>
      <SubTrigger className="pr-2">
        <Brain className="h-3.5 w-3.5" />
        <span className="flex-1">{t('sessionMenu.memoryScope')}</span>
      </SubTrigger>
      <SubContent>
        <MenuItem
          data-testid="memory-scope-read"
          onClick={() => void apply({ ...override, read: !scope.read })}
        >
          {scope.read ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
          <span className="flex-1">{t('sessionMenu.memoryScopeRead')}</span>
        </MenuItem>
        <MenuItem
          data-testid="memory-scope-write"
          onClick={() => void apply({ ...override, write: !scope.write })}
        >
          {scope.write ? <Check className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />}
          <span className="flex-1">{t('sessionMenu.memoryScopeWrite')}</span>
        </MenuItem>
        {!followsGlobal && (
          <MenuItem data-testid="memory-scope-reset" onClick={() => void apply({})}>
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="flex-1">{t('sessionMenu.memoryScopeReset')}</span>
          </MenuItem>
        )}
        <div className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground/80">
          {followsGlobal
            ? t('sessionMenu.memoryScopeFollowsGlobal')
            : projectionIsLossy(scope)
              ? t('sessionMenu.memoryScopeLossy')
              : null}
        </div>
        {/* D1.139 — where the RUNTIME's own notes go, which no host surface said
            until now. In this submenu because its subject is memory, and below
            the residue line because that one is about the switches above it. */}
        {memoryNotices.map(notice => (
          <div
            key={notice.id}
            data-testid={`runtime-notice-${notice.id}`}
            className="px-2 py-1.5 max-w-[22rem] text-[11px] leading-relaxed text-muted-foreground/80 break-words"
          >
            {t(runtimeNoticeKey(notice.id), { path: notice.path ?? '' })}
          </div>
        ))}
      </SubContent>
    </Sub>
    {/* D1.215 — the postures that are not about memory. A second submenu rather
        than a second read: one RPC field carries all of them, and W19-e's "one
        info surface, both rows" is what keeps a posture from needing a page of
        its own each time one is decided. Absent entirely when the list is
        empty, which is every non-claude session. */}
    {otherNotices.length > 0 && (
      <Sub>
        <SubTrigger className="pr-2">
          <Info className="h-3.5 w-3.5" />
          <span className="flex-1">{t('sessionMenu.runtimeNotes')}</span>
        </SubTrigger>
        <SubContent>
          {otherNotices.map(notice => (
            <div
              key={notice.id}
              data-testid={`runtime-notice-${notice.id}`}
              className="px-2 py-1.5 max-w-[22rem] text-[11px] leading-relaxed text-muted-foreground/80 break-words"
            >
              {t(runtimeNoticeKey(notice.id), { path: notice.path ?? '' })}
            </div>
          ))}
        </SubContent>
      </Sub>
    )}
    </>
  )
}
