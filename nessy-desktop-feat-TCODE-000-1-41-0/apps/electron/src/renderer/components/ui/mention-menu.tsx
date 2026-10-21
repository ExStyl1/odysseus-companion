import { skillRussianDescription } from '@/lib/odysseus-skills'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Bot, MessagesSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { FileSearchResult, FuzzyFileSearchResult, FuzzyResourceSearchResult } from '../../../shared/types'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import {
  agentMentionInvocationId,
  isComposerSelectableSkillRow,
  skillMentionInvocationId,
} from '@/lib/capability-catalog'
import {
  INLINE_MENU_ITEM,
  INLINE_MENU_ITEM_SELECTED,
  INLINE_MENU_LIST,
  INLINE_MENU_ORIGIN,
  INLINE_MENU_SECTION_LABEL,
  INLINE_MENU_SURFACE,
} from './inline-menu-styles'

// ============================================================================
// Types
// ============================================================================

/**
 * P6.311 added `'agent'`. C3.224 (= row D1.80, carried from P6.464) added
 * `'session'` — one more union member, one more insert arm and one more section,
 * which is what that note predicted.
 */
export type MentionItemType = 'skill' | 'source' | 'file' | 'folder' | 'resource' | 'agent' | 'session'

export interface MentionItem {
  id: string
  type: MentionItemType
  label: string
  description?: string
  disabled?: boolean
  // Type-specific data
  skill?: SafeCapabilitySummary
  source?: SafeCapabilitySummary
  /** A materialized subagent definition — `sub-agents.md` § Invoke subagents explicitly. */
  agent?: SafeCapabilitySummary
  file?: { path: string; type: 'file' | 'directory'; relativePath: string }
  /** An MCP resource offered alongside files (`mcp.md` § Use MCP resources). */
  resource?: { server: string; uri: string }
  /**
   * C3.224 — another LIVE session on this machine
   * (`cross-session-messaging.md#message-another-session`). The `id` is carried
   * for the row's key and for a future disambiguation surface; what the mention
   * INSERTS is the name, because the name is what the model hands to
   * `send_agent_message`.
   */
  session?: { id: string; name: string }
}

export interface MentionSection {
  id: string
  label: string
  items: MentionItem[]
}

export interface InlineMentionMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: MentionSection[]
  onSelect: (item: MentionItem) => void
  filter?: string
  position: { x: number; y: number }
  workspaceId?: string
  anchorRef?: React.RefObject<HTMLElement | null>
  className?: string
  /** Whether file search is in progress */
  isSearching?: boolean
}

// ============================================================================
// Shared Styles (floating menu material: inline-menu-styles.ts)
// ============================================================================

// UB14.21 — upstream v0.15.0's material. The radius no longer follows the
// composer's (its radius token − 8px, the Codex-parity coupling; R6-05's
// logged decision). OUR `max-h-[40dvh]` cap stays over upstream's 240px, and OUR
// sectioned rows (a header per kind, label · description) stay: upstream's flat
// list with a type chip per row has no reader here.
const MENU_CONTAINER_STYLE = cn(INLINE_MENU_SURFACE, INLINE_MENU_ORIGIN)
const MENU_LIST_STYLE = cn(INLINE_MENU_LIST, 'max-h-[40dvh]')
const MENU_ITEM_STYLE = cn(INLINE_MENU_ITEM, 'gap-2.5')
const MENU_ITEM_SELECTED = INLINE_MENU_ITEM_SELECTED
const MENU_ICON_SIZE = 'size-4'
const MENU_ICON_STYLE = 'size-4 shrink-0 text-secondary'
const MENU_TITLE_STYLE = 'shrink-0 font-medium'
const MENU_DESCRIPTION_STYLE = 'min-w-0 truncate text-tertiary'
const MENU_SECTION_HEADER = INLINE_MENU_SECTION_LABEL

// ============================================================================
// Path utilities
// ============================================================================

/** Extract parent directory from a relative path (e.g. "src/components/Button.tsx" → "src/components/") */
function getParentDir(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/')
  if (lastSlash <= 0) return ''
  return relativePath.slice(0, lastSlash + 1)
}

/** Check if query characters appear in order within target.
 *  Returns true if all characters of query are found sequentially in target.
 *  Note: comparison is literal — pass lowercased inputs for case-insensitive matching. */
function subsequenceMatch(target: string, query: string): boolean {
  let qi = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++
  }
  return qi === query.length
}

/** Filter cached FileSearchResults by query and convert to MentionItems.
 *  Uses substring matching first (score 2), then subsequence matching as
 *  fallback (score 1) so queries like "appav" find "app availability.md". */
function filterCacheResults(cache: FileSearchResult[], query: string): MentionItem[] {
  const lowerQuery = query.trimEnd().toLowerCase()
  if (!lowerQuery) return []

  const scored = cache
    .map(f => {
      const name = f.name.toLowerCase()
      const path = f.relativePath.toLowerCase()
      let score = 0
      if (name.includes(lowerQuery) || path.includes(lowerQuery)) {
        score = 2
      } else if (subsequenceMatch(name, lowerQuery) || subsequenceMatch(path, lowerQuery)) {
        score = 1
      }
      return { f, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  return scored.map(({ f }) => ({
    id: f.path,
    type: f.type === 'directory' ? 'folder' as const : 'file' as const,
    label: f.name,
    description: f.relativePath,
    file: { path: f.path, type: f.type, relativePath: f.relativePath },
  }))
}

function codexFuzzyResultToMentionItem(result: FuzzyFileSearchResult): MentionItem {
  const relativePath = result.path
  const absolutePath = result.path.startsWith('/')
    ? result.path
    : `${result.root.replace(/\/$/, '')}/${result.path.replace(/^\//, '')}`
  const type = result.match_type === 'directory' ? 'folder' as const : 'file' as const

  return {
    id: absolutePath,
    type,
    label: result.file_name || relativePath.split('/').pop() || relativePath,
    description: relativePath,
    file: { path: absolutePath, type: result.match_type, relativePath },
  }
}

/**
 * One MCP resource row.
 *
 * `mcp.md` § Use MCP resources: "Type `@` in your prompt to see available
 * resources from all connected MCP servers. Resources appear alongside files in
 * the autocomplete menu", referenced as `@server:protocol://resource/path`. The
 * id IS that reference, because it is also the text inserted on select.
 */
export function mcpResourceToMentionItem(result: FuzzyResourceSearchResult): MentionItem {
  return {
    id: `${result.server}:${result.uri}`,
    type: 'resource',
    label: result.name || result.uri,
    description: result.description || result.uri,
    resource: { server: result.server, uri: result.uri },
  }
}

/**
 * Filter cached resource candidates client-side, the same way `filterCacheResults`
 * filters cached files: the RPC populated the cache for a shorter query, and
 * appending characters can only narrow it.
 */
function filterResourceCache(cache: FuzzyResourceSearchResult[], query: string): MentionItem[] {
  const lowerQuery = query.trimEnd().toLowerCase()
  const matched = !lowerQuery
    ? cache
    : cache.filter(resource =>
      resource.uri.toLowerCase().includes(lowerQuery)
      || resource.server.toLowerCase().includes(lowerQuery)
      || (resource.name?.toLowerCase().includes(lowerQuery) ?? false)
      || (resource.description?.toLowerCase().includes(lowerQuery) ?? false))
  return matched.slice(0, 20).map(mcpResourceToMentionItem)
}

/**
 * Split ONE session-mention RPC response into the two things it carries.
 *
 * `resources` is read on every backend: the host resolves resource candidates
 * from the session's own MCP pool, so a Pi session with a resource-advertising
 * server answers even though its agent has no fuzzy file search at all.
 *
 * `files` is `null` when the caller must fall through to the local filesystem
 * search — either the backend does not implement the fuzzy file RPC, or it
 * returned nothing. Only the backend that implements it may REPLACE the local
 * walk; anything else would silently empty the file rows.
 */
export function mentionSearchResults(
  response: { files: FuzzyFileSearchResult[]; resources?: FuzzyResourceSearchResult[] } | null,
  options: { useCodexFuzzyFileSearch: boolean },
): { resources: MentionItem[]; files: MentionItem[] | null } {
  const resources = (response?.resources ?? []).map(mcpResourceToMentionItem)
  return {
    resources,
    files: options.useCodexFuzzyFileSearch && response
      ? response.files.map(codexFuzzyResultToMentionItem)
      : null,
  }
}

/**
 * The text ONE selected row inserts, with the trigger `@` already sliced off by
 * the caller.
 *
 * Skills, sources, files and folders use the `[kind:value]` bracket syntax the
 * agent's mention parser reads. An MCP resource does NOT: `mcp.md` documents
 * `@server:protocol://resource/path`, which is what `parseMcpResourceMentions`
 * matches and `resolveMcpResourceMentions` fetches and inlines before the turn.
 */
/**
 * C3.224 — `cross-session-messaging.md#message-another-session`'s quoting rule,
 * read as written: quotes are needed for *"a name with a space or other
 * characters outside letters, digits, hyphens, and underscores"*, so the
 * unquoted set is exactly those four classes and nothing else. A `"` inside the
 * name is escaped rather than left to close the quoting early — the page does
 * not say, and a mention that silently ends mid-name would address the wrong
 * session, which is the one outcome this whole row exists to prevent.
 */
export function quoteSessionMentionName(name: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(name)) return name
  return `"${name.replace(/(["\\])/g, '\\$1')}"`
}

/**
 * C3.316 — the names more than ONE offered session answers to.
 *
 * Exported and pure so the rule can be driven without a renderer, which is the
 * same trade every other verb in this module makes (there is no React DOM
 * harness in this tree). The comparison is the raw name, deliberately: it is the
 * string the mention INSERTS and the string `resolveCrossSessionTarget` matches
 * on host-side, so a case- or whitespace-insensitive notion of "shared" here
 * would warn about pairs the host resolves fine and stay silent on a pair it
 * cannot.
 */
export function sharedSessionMentionNames(
  sessions: readonly { name: string }[],
): Set<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const session of sessions) {
    if (seen.has(session.name)) shared.add(session.name)
    else seen.add(session.name)
  }
  return shared
}

export function buildMentionInsertText(item: MentionItem): string {
  const bracket = (kind: 'skill' | 'source' | 'file' | 'folder' | 'agent', value: string): string =>
    '[' + kind + ':' + value + '] '

  /**
   * P6.311 — an AGENT uses the bracket syntax, and the page's own two spellings
   * are recorded here rather than copied, because they are Claude Code's
   * terminal composer talking to Claude Code's own parser.
   *
   * `sub-agents.md#invoke-subagents-explicitly`, verbatim: *"Type `@` and pick
   * the subagent from the typeahead, the same way you @-mention files"*, which
   * inserts `@"code-reviewer (agent)"`; and *"You can also type the mention
   * manually without using the picker: `@agent-<name>` for local subagents, or
   * `@agent-` followed by the scoped name for plugin subagents"*.
   *
   * Neither form is what THIS composer's host reads. Every other row here emits
   * `[kind:value]`, which is the syntax `lib/mentions.ts` and the host's own
   * parser match, and the one documented exception — an MCP resource — is an
   * exception precisely because `mcp.md` defines that wire between the user and
   * an MCP server rather than between our composer and our host. So `agent`
   * follows the house syntax, and accepting the page's `@agent-<name>` typed by
   * hand is a separate, additive question for the lane that adds the host-side
   * resolution (see this row's report).
   */
  /**
   * C3.224 — a SESSION is the one row besides an MCP resource that does NOT use
   * the bracket syntax, and for the same kind of reason: the bracket forms are a
   * wire between this composer and our own mention PARSER, and there is no
   * session parser to speak to. What the page specifies is plain text the MODEL
   * reads — `cross-session-messaging.md#message-another-session`, verbatim:
   * *"Claude Code inserts the mention, such as `@api-worker`, and tells Claude
   * which session it names, so Claude can message that session without listing
   * your sessions first."* The model then hands that name to
   * `send_agent_message`, whose `sessionId` resolves a live name host-side on one
   * unambiguous match (`session-tools-core/src/handlers/send-agent-message.ts`
   * symbol `resolveCrossSessionTarget`). So the two halves compose with no new
   * parser anywhere.
   *
   * The quoting is the page's own rule, not a guess — *"A name with a space or
   * other characters outside letters, digits, hyphens, and underscores: type it
   * in double quotes, such as `@"release notes"`. When you pick the session from
   * the typeahead, Claude Code inserts the quotes for you."*
   */
  if (item.type === 'session') return `@${quoteSessionMentionName(item.session?.name ?? item.label)} `
  if (item.type === 'agent') return bracket('agent', item.id)
  if (item.type === 'skill') return bracket('skill', item.id)
  if (item.type === 'source') return bracket('source', item.id)
  if (item.type === 'file') return bracket('file', item.file?.relativePath || item.id)
  if (item.type === 'folder') return bracket('folder', item.file?.relativePath || item.id)
  if (item.type === 'resource') return `@${item.resource?.server ?? ''}:${item.resource?.uri ?? ''} `
  return bracket('skill', item.id)
}

// ============================================================================
// Filter utilities
// ============================================================================

/**
 * Get match priority score for filtering (higher = better match)
 * 3 = starts with filter (first word)
 * 2 = word boundary match (2nd+ word after space/hyphen/underscore)
 * 1 = contains filter (mid-word)
 * 0 = no match
 */
function getMatchScore(text: string, filter: string): number {
  const lowerText = text.toLowerCase()
  // Best: starts with filter (first word)
  if (lowerText.startsWith(filter)) return 3
  // Good: word boundary match (after space/hyphen/underscore)
  const escapedFilter = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordBoundaryPattern = new RegExp(`[\\s\\-_]${escapedFilter}`)
  if (wordBoundaryPattern.test(lowerText)) return 2
  // OK: contains filter anywhere
  if (lowerText.includes(filter)) return 1
  return 0
}

function filterSections(sections: MentionSection[], filter: string, t: ReturnType<typeof useTranslation>['t']): MentionSection[] {
  if (!filter) return sections
  const lowerFilter = filter.trimEnd().toLowerCase()
  if (!lowerFilter) return sections

  // Collect all matching items across sections
  const allItems = sections.flatMap(section => section.items)
  const matchingItems = allItems.filter(item =>
    item.label?.toLowerCase().includes(lowerFilter) ||
    item.id?.toLowerCase().includes(lowerFilter) ||
    item.description?.toLowerCase().includes(lowerFilter)
  )

  // Sort by match priority: first word > later word > contains
  matchingItems.sort((a, b) => {
    const aLabelScore = getMatchScore(a.label, lowerFilter)
    const bLabelScore = getMatchScore(b.label, lowerFilter)
    const aIdScore = getMatchScore(a.id, lowerFilter)
    const bIdScore = getMatchScore(b.id, lowerFilter)

    // Compare by best score (label or id)
    const aScore = Math.max(aLabelScore, aIdScore)
    const bScore = Math.max(bLabelScore, bIdScore)
    if (aScore !== bScore) return bScore - aScore

    // Same score tier: alphabetical by label
    return a.label.localeCompare(b.label)
  })

  // Return as flat list in a single virtual section (headers hidden when filtering)
  if (matchingItems.length === 0) return []
  return [{ id: 'results', label: t('chat.mentionSection.results'), items: matchingItems }]
}

function flattenItems(sections: MentionSection[]): MentionItem[] {
  return sections.flatMap(section => section.items)
}

function getMentionDescription(item: MentionItem): string | undefined {
  if ((item.type === 'file' || item.type === 'folder') && item.file?.relativePath) {
    return getParentDir(item.file.relativePath) || item.description
  }
  return item.description
}

function useAnchoredMenuGeometry(
  open: boolean,
  anchorRef: React.RefObject<HTMLElement | null> | undefined,
  position: { x: number; y: number },
  fallbackWidth: number,
): React.CSSProperties | undefined {
  const [geometry, setGeometry] = React.useState<React.CSSProperties>()

  React.useLayoutEffect(() => {
    if (!open) {
      setGeometry(undefined)
      return
    }

    const updateGeometry = () => {
      const anchorRect = anchorRef?.current?.getBoundingClientRect()
      if (anchorRect && anchorRect.width > 0) {
        setGeometry({
          left: Math.round(anchorRect.left),
          bottom: window.innerHeight - Math.round(anchorRect.top) + 8,
          width: Math.round(anchorRect.width),
        })
        return
      }

      setGeometry({
        left: Math.round(position.x) - 10,
        bottom: window.innerHeight - Math.round(position.y) + 8,
        width: fallbackWidth,
      })
    }

    updateGeometry()
    const anchor = anchorRef?.current
    const resizeObserver = anchor && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateGeometry)
      : null
    if (anchor && resizeObserver) {
      resizeObserver.observe(anchor)
    }
    window.addEventListener('resize', updateGeometry)
    window.addEventListener('scroll', updateGeometry, true)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateGeometry)
      window.removeEventListener('scroll', updateGeometry, true)
    }
  }, [open, anchorRef, position.x, position.y, fallbackWidth])

  return geometry
}

/**
 * Check if the @ character at the given position is a valid mention trigger.
 * Valid triggers are:
 * - @ at the start of input (position 0)
 * - @ preceded by whitespace (space, tab, newline)
 * - @ preceded by opening brackets or quotes: ( " '
 *
 * Invalid triggers (returns false):
 * - @ in the middle of a word (e.g., "test@example.com")
 * - @ preceded by alphanumeric or other characters
 *
 * @param textBeforeCursor - The text from start of input to cursor position
 * @param atPosition - The position of the @ character in textBeforeCursor
 * @returns true if this @ should trigger the mention menu
 */
export function isValidMentionTrigger(textBeforeCursor: string, atPosition: number): boolean {
  if (atPosition < 0) return false
  if (atPosition === 0) return true
  const charBefore = textBeforeCursor[atPosition - 1]
  if (charBefore === undefined) return false
  // Allow whitespace or opening brackets/quotes before @
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}

// ============================================================================
// InlineMentionMenu Component
// ============================================================================

export function InlineMentionMenu({
  open,
  onOpenChange,
  sections,
  onSelect,
  filter = '',
  position,
  workspaceId,
  anchorRef,
  className,
}: InlineMentionMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSections = filterSections(sections, filter, t)
  const flatItems = flattenItems(filteredSections)
  const menuGeometry = useAnchoredMenuGeometry(open, anchorRef, position, 280)

  // Reset selection when filter changes
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Keyboard navigation
  // Don't attach listener when no items - allows Enter to propagate to input handler
  React.useEffect(() => {
    if (!open || flatItems.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < flatItems.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : flatItems.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (flatItems[selectedIndex] && !flatItems[selectedIndex].disabled) {
            onSelect(flatItems[selectedIndex])
            onOpenChange(false)
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChange(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, flatItems, selectedIndex, onSelect, onOpenChange])

  // Close on click outside
  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChange(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open, onOpenChange])

  // Scroll selected item into view when navigating with keyboard
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!open) return null

  let currentItemIndex = 0

  const menu = (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={menuGeometry}
    >
      <div ref={listRef} className={MENU_LIST_STYLE}>
        {flatItems.length === 0 && filter && (
          <div className="px-2 py-2 text-label-sm text-tertiary">{t('chat.noResults')}</div>
        )}
        {filteredSections.map((section) => (
          <React.Fragment key={section.id}>
            <div className={MENU_SECTION_HEADER}>
              {section.label}
            </div>
            {section.items.map((item) => {
              const itemIndex = currentItemIndex++
              const isSelected = itemIndex === selectedIndex
              const isDisabled = !!item.disabled
              const description = getMentionDescription(item)

              return (
                <div
                  key={`${item.type}-${item.id}`}
                  data-selected={isSelected}
                  onClick={() => {
                    if (isDisabled) return
                    onSelect(item)
                    onOpenChange(false)
                  }}
                  onMouseEnter={() => {
                    if (!isDisabled) setSelectedIndex(itemIndex)
                  }}
                  className={cn(
                    MENU_ITEM_STYLE,
                    isSelected && MENU_ITEM_SELECTED,
                    isDisabled && 'cursor-default opacity-45'
                  )}
                >
                  <div className={MENU_ICON_STYLE}>
                    {item.type === 'skill' && item.skill && (
                      <SkillAvatar skill={item.skill} size="sm" workspaceId={workspaceId} />
                    )}
                    {item.type === 'source' && item.source && (
                      <SourceAvatar source={item.source} size="sm" />
                    )}
                    {item.type === 'agent' && (
                      <Bot className={MENU_ICON_SIZE} strokeWidth={1.5} />
                    )}
                    {/* C3.224 — another live session is a conversation, not an agent definition. */}
                    {item.type === 'session' && (
                      <MessagesSquare className={MENU_ICON_SIZE} strokeWidth={1.5} />
                    )}
                    {item.type === 'folder' && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className={MENU_ICON_SIZE}>
                        <path d="M20.5 10C20.5 9.07003 20.5 8.60504 20.3978 8.22354C20.1204 7.18827 19.3117 6.37962 18.2765 6.10222C17.895 6 17.43 6 16.5 6H13.1008C12.4742 6 12.1609 6 11.8739 5.91181C11.6824 5.85298 11.5009 5.76572 11.3353 5.65295C11.0871 5.48389 10.8914 5.23926 10.5 4.75L10.4095 4.63693C10.107 4.25881 9.9558 4.06975 9.7736 3.92674C9.54464 3.74703 9.27921 3.61946 8.99585 3.55294C8.77037 3.5 8.52825 3.5 8.04402 3.5C6.60485 3.5 5.88527 3.5 5.32008 3.74178C4.61056 4.0453 4.0453 4.61056 3.74178 5.32008C3.5 5.88527 3.5 6.60485 3.5 8.04402V10M9.46502 20.5H14.535C16.9102 20.5 18.0978 20.5 18.9301 19.8113C19.7624 19.1226 19.9846 17.9559 20.429 15.6227L20.8217 13.5613C21.1358 11.9121 21.2929 11.0874 20.843 10.5437C20.393 10 19.5536 10 17.8746 10H6.12537C4.44643 10 3.60696 10 3.15704 10.5437C2.70713 11.0874 2.8642 11.9121 3.17835 13.5613L3.57099 15.6227C4.01541 17.9559 4.23763 19.1226 5.06992 19.8113C5.90221 20.5 7.08981 20.5 9.46502 20.5Z"/>
                      </svg>
                    )}
                    {item.type === 'file' && (
                      <FileMenuIcon name={item.label} />
                    )}
                    {item.type === 'resource' && (
                      <McpResourceMenuIcon />
                    )}
                  </div>
                  <span className={MENU_TITLE_STYLE}>{item.label}</span>
                  {description && (
                    <span className={MENU_DESCRIPTION_STYLE}>{description}</span>
                  )}
                </div>
              )
            })}
          </React.Fragment>
        ))}

      </div>
    </div>
  )

  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}

/**
 * MCP resource icon — a linked document, so a resource row reads as "a document
 * that lives somewhere else" next to the plain file rows it shares the menu with.
 */
function McpResourceMenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-secondary">
      <path d="M10.5 9.5H8.5C6.84315 9.5 5.5 10.8431 5.5 12.5C5.5 14.1569 6.84315 15.5 8.5 15.5H10.5M13.5 9.5H15.5C17.1569 9.5 18.5 10.8431 18.5 12.5C18.5 14.1569 17.1569 15.5 15.5 15.5H13.5M9 12.5H15"/>
      <path d="M21.5 12.5C21.5 17.4706 17.4706 21.5 12.5 21.5C7.52944 21.5 3.5 17.4706 3.5 12.5C3.5 7.52944 7.52944 3.5 12.5 3.5" strokeOpacity="0.35"/>
    </svg>
  )
}

// ============================================================================
// File icon component - picks icon variant based on file extension
// ============================================================================

/** Known code file extensions that get the code file icon (< >) */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])

/** Known image file extensions that get the image icon */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif',
])

function getFileIconType(name: string): 'code' | 'image' | 'generic' {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return 'generic'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'generic'
}

/** Renders the appropriate file icon based on extension (code, image, or generic) */
function FileMenuIcon({ name }: { name: string }) {
  const iconType = getFileIconType(name)

  if (iconType === 'code') {
    // Code file icon (document with < > brackets)
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-secondary">
        <path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M10.5 12.8799C9.70024 13.2985 9.10807 13.8275 8.64232 14.5478C8.51063 14.7515 8.44479 14.8533 8.44489 15.0011C8.44498 15.1488 8.51099 15.2506 8.643 15.4542C9.1095 16.1736 9.70167 16.7028 10.5 17.1225M13.5 12.8799C14.2998 13.2985 14.8919 13.8275 15.3577 14.5478C15.4894 14.7515 15.5552 14.8533 15.5551 15.0011C15.555 15.1488 15.489 15.2506 15.357 15.4542C14.8905 16.1736 14.2983 16.7028 13.5 17.1225M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/>
      </svg>
    )
  }

  if (iconType === 'image') {
    // Image file icon (landscape frame with mountain/sun)
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-secondary">
        <path d="M8 8.5C8 8.77614 7.77614 9 7.5 9C7.22386 9 7 8.77614 7 8.5C7 8.22386 7.22386 8 7.5 8C7.77614 8 8 8.22386 8 8.5Z" fill="currentColor"/>
        <path d="M20.9998 16.1004L17.9497 13.0503C16.6163 11.7169 15.9496 11.0503 15.1212 11.0503C14.2928 11.0503 13.6261 11.7169 12.2928 13.0503L5.34323 20M8 8.5C8 8.77614 7.77614 9 7.5 9C7.22386 9 7 8.77614 7 8.5C7 8.22386 7.22386 8 7.5 8C7.77614 8 8 8.22386 8 8.5ZM10.5 20.5H13.5C17.2712 20.5 19.1569 20.5 20.3284 19.3284C21.5 18.1569 21.5 16.2712 21.5 12.5V11.5C21.5 7.72876 21.5 5.84315 20.3284 4.67157C19.1569 3.5 17.2712 3.5 13.5 3.5H10.5C6.72876 3.5 4.84315 3.5 3.67157 4.67157C2.5 5.84315 2.5 7.72876 2.5 11.5V12.5C2.5 16.2712 2.5 18.1569 3.67157 19.3284C4.84315 20.5 6.72876 20.5 10.5 20.5Z"/>
      </svg>
    )
  }

  // Generic file icon (document with folded corner)
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-secondary">
      <path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M9 16H15M9 12H10M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/>
    </svg>
  )
}

// ============================================================================
// Hook for managing inline mention state
// ============================================================================

/**
 * A stable empty default for `agents`, so a composer that supplies none does not
 * re-run the sections memo on every render.
 */
const EMPTY_AGENTS: SafeCapabilitySummary[] = []

/** The same stable default for `sessions`, and for the same reason. */
const EMPTY_SESSIONS: { id: string; name: string }[] = []

/** Interface for elements that can be used with useInlineMention */
export interface MentionInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

export interface UseInlineMentionOptions {
  /** Ref to input element (textarea or RichTextInput handle) */
  inputRef: React.RefObject<MentionInputElement | null>
  skills: SafeCapabilitySummary[]
  sources: SafeCapabilitySummary[]
  /**
   * P6.311 — the session's materialized subagent definitions. Optional so the
   * two composers that do not have them (the mobile preview, the playground)
   * need no change; an empty list renders no section at all.
   */
  agents?: SafeCapabilitySummary[]
  /**
   * C3.224 — the OTHER live sessions this machine can address
   * (`cross-session-messaging.md#message-another-session`: *"The typeahead
   * lists your other live sessions on this machine"*). Optional for the same
   * reason `agents` is: a composer without them renders no section at all.
   *
   * Deliberately a `{ id, name }` pair rather than the renderer's session
   * record: what the mention inserts is the NAME, the id is the row key, and
   * nothing else about a session belongs in a typeahead.
   */
  sessions?: { id: string; name: string }[]
  /** Base path for file search (working directory) */
  basePath?: string
  /**
   * Session-scoped mention search. Needed for MCP resources on EVERY backend —
   * the host answers those from the session's MCP pool, not from the agent —
   * and for the Codex fuzzy FILE search on the backend that implements it.
   */
  sessionId?: string
  /**
   * Whether the session's agent implements the Codex fuzzy FILE search, which
   * REPLACES the local filesystem walk. Files only: a backend without it still
   * needs `searchFiles`, so this must not gate the resource half.
   */
  useCodexFuzzyFileSearch?: boolean
  onSelect: (item: MentionItem) => void
  /** Workspace ID for fully-qualified skill names */
  workspaceId?: string
}

export interface UseInlineMentionReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  sections: MentionSection[]
  /** Whether file search is in progress */
  isSearching: boolean
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (item: MentionItem) => { value: string; cursorPosition: number }
}

export function useInlineMention({
  inputRef,
  skills,
  sources,
  agents = EMPTY_AGENTS,
  sessions = EMPTY_SESSIONS,
  basePath,
  sessionId,
  useCodexFuzzyFileSearch = false,
  onSelect,
  workspaceId,
}: UseInlineMentionOptions): UseInlineMentionReturn {
  // P6.311 — the section headings were hardcoded English until this row; the
  // hook builds the sections, so the hook is where they are translated.
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  // committedFilter: only updates when IPC returns (or immediately when no IPC needed).
  // Prevents visual jumps — the menu shows all items until results are ready,
  // then applies filter + file results in a single frame.
  const [committedFilter, setCommittedFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [atStart, setAtStart] = React.useState(-1)
  const [fileResults, setFileResults] = React.useState<MentionItem[]>([])
  const [resourceResults, setResourceResults] = React.useState<MentionItem[]>([])
  const fileSearchTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cache of raw IPC file search results for the current menu session.
  // Allows instant client-side filtering when user edits the query (add/delete chars)
  // without waiting for a new IPC round-trip. Cleared when menu closes.
  const fileCache = React.useRef<FileSearchResult[]>([])
  // Same cache, for the MCP resources the same RPC returns. Without it, the
  // cache-first file path would skip the RPC on the next keystroke and the
  // resource rows would vanish mid-typing.
  const resourceCache = React.useRef<FuzzyResourceSearchResult[]>([])
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // Cleanup pending timeout on unmount
  React.useEffect(() => {
    return () => {
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
      }
    }
  }, [])

  // Build sections from available data (skills, sources, and file search results)
  const sections = React.useMemo((): MentionSection[] => {
    const result: MentionSection[] = []

    // Skills section
    const selectableSkills = skills.filter(isComposerSelectableSkillRow)
    if (selectableSkills.length > 0) {
      result.push({
        id: 'skills',
        label: t('chat.mentionSection.skills'),
        items: selectableSkills.map(skill => ({
          id: skillMentionInvocationId(skill),
          type: 'skill' as const,
          label: skill.mention?.label ?? skill.logicalName,
          description: skillRussianDescription(skill),
          skill,
        })),
      })
    }

    // Agents section — `sub-agents.md#invoke-subagents-explicitly`: "Type `@`
    // and pick the subagent from the typeahead". Placed directly after skills
    // and ahead of sources and files, because picking an agent decides WHO does
    // the work, which is a larger choice than the context the rows below add.
    //
    // NOT filtered on `state === 'active'` the way skills are: a skill row's
    // state is its enablement and an inactive one cannot be invoked, whereas an
    // agent definition the catalog materialized is invocable by name. If a
    // per-agent enablement ever lands, this is the line it belongs on.
    const selectableAgents = agents.filter(agent => agent.logicalName)
    if (selectableAgents.length > 0) {
      result.push({
        id: 'agents',
        label: t('chat.mentionSection.agents'),
        items: selectableAgents.map(agent => ({
          id: agentMentionInvocationId(agent),
          type: 'agent' as const,
          label: agent.mention?.label ?? agent.logicalName,
          description: agent.description,
          agent,
        })),
      })
    }

    // C3.224 — Sessions section. After agents and ahead of sources: picking a
    // session decides WHO the turn talks to, which is the same class of choice
    // as picking an agent and a larger one than the context the rows below add.
    if (sessions.length > 0) {
      // C3.316 — a name TWO live sessions answer to identifies neither, and the
      // typeahead can offer both rows: the uniqueness rule the page specifies
      // runs on the EXPLICIT naming path only and excludes, in its own words,
      // "AI-generated titles or default display names" — which is how most
      // sessions here get their name. Both rows then insert the same `@name`,
      // so picking one of them cannot mean what the user thinks it means.
      //
      // The row SAYS so rather than the menu hiding or merging them: the send is
      // refused host-side and the model asks which one is meant
      // (`session-tools-core/src/handlers/send-agent-message.ts` symbol
      // `resolveCrossSessionTarget`), which is exactly what the page describes,
      // so the honest composer-side job is to warn before the round trip rather
      // than to invent a second addressing syntax the model's parser does not
      // read.
      const sharedNames = sharedSessionMentionNames(sessions)
      result.push({
        id: 'sessions',
        label: t('chat.mentionSection.sessions'),
        items: sessions.map(session => ({
          id: session.id,
          type: 'session' as const,
          label: session.name,
          ...(sharedNames.has(session.name)
            ? { description: t('chat.mentionSection.sessionNameShared') }
            : {}),
          session,
        })),
      })
    }

    // Sources section
    if (sources.length > 0) {
      result.push({
        id: 'sources',
        label: t('chat.mentionSection.sources'),
        items: sources
          .filter(source => (source.mention?.id ?? source.logicalName) && source.logicalName)
          .map(source => ({
            id: source.mention?.id ?? source.logicalName,
            type: 'source' as const,
            label: source.mention?.label ?? source.logicalName,
            description: source.description,
            source,
          })),
      })
    }

    // Resources section — `mcp.md`: resources "appear alongside files in the
    // autocomplete menu".
    if (resourceResults.length > 0) {
      result.push({
        id: 'resources',
        label: t('chat.mentionSection.resources'),
        items: resourceResults,
      })
    }

    // Files section (from async search results)
    if (fileResults.length > 0) {
      result.push({
        id: 'files',
        label: t('chat.mentionSection.files'),
        items: fileResults,
      })
    }

    return result
  }, [t, skills, sources, agents, sessions, resourceResults, fileResults])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // Match @ followed by up to 100 chars (word chars, hyphens, slashes, dots, and spaces).
    // Spaces are allowed so users can type filenames with spaces (e.g. @app availability.md).
    // The menu auto-closes when a space produces no matches (Slack-style behavior).
    const atMatch = textBeforeCursor.match(/@([\w\-\/.\s]{0,100})?$/)

    // Check if this is a valid @ mention trigger
    const matchStart = atMatch ? textBeforeCursor.lastIndexOf('@') : -1
    const isValidTrigger = atMatch && isValidMentionTrigger(textBeforeCursor, matchStart)

    if (isValidTrigger) {
      const filterText = atMatch[1] || ''

      // Slack-style auto-close: if the query contains a space and the file cache is
      // populated but produces zero matches, close the menu. This prevents the
      // "infinite spaces" problem while still allowing multi-word queries like
      // "app availability.md". Skills/sources rarely have spaces in names, so
      // file cache is the authoritative signal here.
      if (filterText.includes(' ') && fileCache.current.length > 0) {
        const fileMatches = filterCacheResults(fileCache.current, filterText)
        if (fileMatches.length === 0) {
          setIsOpen(false)
          setFilter('')
          setCommittedFilter('')
          setAtStart(-1)
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          setFileResults([])
          setResourceResults([])
          fileCache.current = []
          resourceCache.current = []
          return
        }
      }

      setAtStart(matchStart)
      setFilter(filterText)

      // Cache-first file search: if cache has entries from a previous IPC call,
      // filter client-side instantly (no IPC, no debounce). Otherwise fire a
      // debounced IPC to populate the cache. Cache clears when menu closes.
      window.electronAPI.debugLog?.('[mention] filterText:', filterText, 'basePath:', basePath, 'cacheSize:', fileCache.current.length)
      // The session RPC answers TWO things: the Codex fuzzy file search, which
      // only that backend implements, and the MCP resource candidates, which the
      // host resolves from the session's own pool on every backend. Gating the
      // whole call on the provider type is what made resource mentions
      // unreachable on Pi, the shipped default.
      const canQuerySession = !!sessionId && filterText.length >= 1
      const canUseCodexFuzzy = useCodexFuzzyFileSearch && canQuerySession
      if ((basePath || canQuerySession) && filterText.length >= 1) {
        if (!canUseCodexFuzzy && fileCache.current.length > 0) {
          // Cache exists — filter client-side instantly, no IPC needed
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          const filtered = filterCacheResults(fileCache.current, filterText)
          window.electronAPI.debugLog?.('[mention] cache hit:', filtered.length, 'items')
          setFileResults(filtered)
          setResourceResults(filterResourceCache(resourceCache.current, filterText))
          setCommittedFilter(filterText)
        } else {
          // First search — fire debounced IPC to populate cache
          if (fileSearchTimeout.current) clearTimeout(fileSearchTimeout.current)

          fileSearchTimeout.current = setTimeout(async () => {
            const runLocalFileSearch = async () => {
              if (!basePath) {
                setFileResults([])
                setCommittedFilter(filterText)
                return
              }

              window.electronAPI.debugLog?.('[mention] calling IPC searchFiles:', basePath, filterText)
              const results = await window.electronAPI.searchFiles(basePath, filterText)
              window.electronAPI.debugLog?.('[mention] IPC returned:', results?.length, 'results')
              fileCache.current = results
              const filtered = filterCacheResults(fileCache.current, filterText)
              window.electronAPI.debugLog?.('[mention] after cache filter:', filtered.length, 'items')
              setFileResults(filtered)
              setCommittedFilter(filterText)
            }

            try {
              if (canQuerySession && sessionId) {
                window.electronAPI.debugLog?.('[mention] calling IPC fuzzyFileSearch:', sessionId, filterText)
                const response = await window.electronAPI.fuzzyFileSearch(sessionId, filterText)
                const outcome = mentionSearchResults(response, { useCodexFuzzyFileSearch: canUseCodexFuzzy })
                resourceCache.current = [...(response?.resources ?? [])]
                setResourceResults(outcome.resources)
                window.electronAPI.debugLog?.('[mention] fuzzyFileSearch resources:', outcome.resources.length)
                if (outcome.files) {
                  window.electronAPI.debugLog?.('[mention] fuzzyFileSearch returned:', outcome.files.length, 'results')
                  fileCache.current = []
                  setFileResults(outcome.files)
                  setCommittedFilter(filterText)
                  return
                }
              }

              await runLocalFileSearch()
            } catch (err) {
              // A backend without the RPC rejects here; the local filesystem
              // search still runs and the menu degrades without throwing.
              window.electronAPI.debugLog?.('[mention] file search error:', String(err))
              try {
                await runLocalFileSearch()
              } catch (fallbackErr) {
                window.electronAPI.debugLog?.('[mention] local fallback searchFiles error:', String(fallbackErr))
              }
            }
          }, canUseCodexFuzzy ? 200 : 150)
        }
      } else {
        window.electronAPI.debugLog?.('[mention] skipping file search (no basePath or empty filter)')
        if (fileSearchTimeout.current) {
          clearTimeout(fileSearchTimeout.current)
          fileSearchTimeout.current = null
        }
        setFileResults([])
        setResourceResults([])
        resourceCache.current = []
        setCommittedFilter(filterText)
      }

      if (inputRef.current) {
        // Try to get actual caret position from the input element
        const caretRect = inputRef.current.getCaretRect?.()

        if (caretRect && caretRect.x > 0) {
          // Use actual caret position
          setPosition({
            x: caretRect.x,
            y: caretRect.y,
          })
        } else {
          // Fallback: position at input element's left edge
          const rect = inputRef.current.getBoundingClientRect()
          const lineHeight = 20
          const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
          setPosition({
            x: rect.left,
            y: rect.top + (linesBeforeCursor + 1) * lineHeight,
          })
        }
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setCommittedFilter('')
      setAtStart(-1)
      // Clear file search state and cache when menu closes
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
        fileSearchTimeout.current = null
      }
      setFileResults([])
      setResourceResults([])
      fileCache.current = []
      resourceCache.current = []
    }
  }, [inputRef, basePath, sessionId, useCodexFuzzyFileSearch])

  const handleSelect = React.useCallback((item: MentionItem): { value: string; cursorPosition: number } => {
    let result = ''
    let newCursorPosition = 0

    if (atStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, atStart)
      const after = currentValue.slice(cursorPosition)

      // The trigger `@` was sliced off with `before`; a resource row writes its
      // own back (see `buildMentionInsertText`).
      const mentionText = buildMentionInsertText(item)

      result = before + mentionText + after
      newCursorPosition = before.length + mentionText.length
    }

    onSelect(item)
    setIsOpen(false)
    setCommittedFilter('')
    // Clear file search state and cache to prevent stale results on next open
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    setResourceResults([])
    fileCache.current = []
    resourceCache.current = []

    return { value: result, cursorPosition: newCursorPosition }
  }, [onSelect, atStart, workspaceId])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setCommittedFilter('')
    setAtStart(-1)
    // Clear file search state and cache to prevent stale results on next open
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    setResourceResults([])
    fileCache.current = []
    resourceCache.current = []
  }, [])

  return {
    isOpen,
    filter: committedFilter,
    position,
    sections,
    isSearching: false,
    handleInputChange,
    close,
    handleSelect,
  }
}
