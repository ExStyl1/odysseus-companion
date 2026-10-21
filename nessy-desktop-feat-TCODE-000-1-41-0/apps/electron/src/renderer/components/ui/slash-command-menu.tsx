import * as React from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from "react-i18next"
import { Command as CommandPrimitive } from 'cmdk'
import { BarChart3, BookOpenText, Bot, CalendarClock, CircleHelp, Download, Eraser, FilePlus2, FileText, Flag, FolderTree, Gauge, GitCompare, GitFork, History, Lightbulb, MessageCircleQuestion, Minimize2, PackagePlus, PiggyBank, Plug, Server, Settings2, ShieldCheck, SlidersHorizontal, Wand2, Webhook } from 'lucide-react'
// The icons' own subpath, never the `@nessy-agent/ui` barrel: the barrel's graph
// reaches the Vite-only `pdfjs-dist/...?url` specifier `bun test` cannot resolve,
// and this was this module's only reach into it (P6.844). The icons module is a
// pure leaf — three components over a type-only `SVGProps` import.
import { Icon_Folder } from '@nessy-agent/ui/icons'
import { cn } from '@/lib/utils'
import {
  INLINE_MENU_FOOTER,
  INLINE_MENU_ITEM,
  INLINE_MENU_ITEM_SELECTED,
  INLINE_MENU_LIST,
  INLINE_MENU_ORIGIN,
  INLINE_MENU_SECTION_LABEL,
  INLINE_MENU_SEPARATOR,
  INLINE_MENU_SURFACE,
} from './inline-menu-styles'
import { PERMISSION_MODE_CONFIG, PERMISSION_MODE_ORDER, type PermissionMode } from '@nessy-agent/shared/agent/modes'
import { LOCALE_REGISTRY } from '@nessy-agent/shared/i18n'
import type { CustomSlashCommand, CustomSlashCommandId } from '@nessy-agent/shared/slash-commands/common'
import { PERMISSION_MODE_FULL_DESCRIPTION_KEYS, PERMISSION_MODE_PICKER_ORDER, type ComposerPermissionModeDisplay } from '@/lib/composer-permission-modes'

// ============================================================================
// Types
// ============================================================================

export type SlashCommandId = PermissionMode | CustomSlashCommandId | 'advisor' | 'approve' | 'agents' | 'automations' | 'btw' | 'cd' | 'compact' | 'config' | 'context' | 'diff' | 'create-skill' | 'create-plugin' | 'export' | 'goal' | 'hooks' | 'init' | 'memory' | 'model' | 'clear' | 'help' | 'mcp' | 'quota' | 'recap' | 'status' | 'subtask' | 'usage'

/** Union type for all item types in the slash menu */
export type SlashItemType = 'command' | 'folder'

export interface SlashCommand {
  id: SlashCommandId
  label: string
  description: string
  icon: React.ReactNode
  shortcut?: string
  /** Optional color for the command (hex color string) */
  color?: string
  customCommand?: CustomSlashCommand
  /**
   * `description` is already resolved for the active language and the active
   * session — do not re-resolve it from a key (R15).
   *
   * The mode rows are the reason this exists. `getTranslatedCommandDescription`
   * re-resolves every id in {@link MODE_COMMAND_IDS} through
   * `PERMISSION_MODE_FULL_DESCRIPTION_KEYS`, which is right for the
   * `DEFAULT_SLASH_COMMANDS` fallback (English literals that must follow the
   * user's language) and WRONG for a row built from
   * `ComposerPermissionModeDisplay`: those already carry `t()` output plus the
   * active runtime's note, and re-resolving threw both away. That is how the
   * Nestor cloud `modeOptions` override — live since the cloud modes shipped —
   * reached the picker and never the slash menu, and it is how the picker and
   * the slash menu would have disagreed about the same mode in one codex
   * session.
   */
  descriptionResolved?: boolean
}

/** Folder item for the slash menu */
export interface SlashFolderItem {
  id: string
  type: 'folder'
  label: string
  description: string
  path: string
}

/** Section with header for the inline slash menu */
export interface SlashSection {
  id: string
  label: string
  items: (SlashCommand | SlashFolderItem)[]
}

export interface CommandGroup {
  id: string
  commands: SlashCommand[]
}

// ============================================================================
// Permission Mode Icon Component
// ============================================================================

interface PermissionModeIconProps {
  mode: PermissionMode
  className?: string
}

/**
 * Exported as upstream v0.15.0 does, for the composer's mode chip and its menu (UB14.29). An
 * unknown mode draws `default`'s glyph — upstream falls back to its `ask`, which is our `default`.
 */
export function PermissionModeIcon({ mode, className }: PermissionModeIconProps) {
  const config = PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={config.svgPath} />
    </svg>
  )
}

// ============================================================================
// Default Commands
// ============================================================================

// Icon size constant (16px menu icons, spec §7.10)
const MENU_ICON_SIZE = 'size-4'

// English fallback text from the `en` locale — the render path re-resolves
// label and description through t() for the active language; these strings are
// only the t() defaultValue and the filter-matching text. i18n is the single
// source of mode text: no hard-coded label copies live here. F1.1052: the picker's order, no hidden dontAsk.
const EN_MESSAGES = LOCALE_REGISTRY.en.messages as Record<string, string>

const permissionModeCommands: SlashCommand[] = PERMISSION_MODE_PICKER_ORDER.map(mode => ({
  id: mode,
  label: EN_MESSAGES[`mode.${mode}`] ?? mode,
  description: EN_MESSAGES[PERMISSION_MODE_FULL_DESCRIPTION_KEYS[mode]] ?? '',
  icon: <PermissionModeIcon mode={mode} className={MENU_ICON_SIZE} />,
}))

export function buildPermissionModeCommands(displays?: ComposerPermissionModeDisplay[]): SlashCommand[] {
  if (!displays) return permissionModeCommands
  return displays.map(display => ({
    id: display.mode,
    label: display.label,
    description: display.description,
    descriptionResolved: true,
    icon: <PermissionModeIcon mode={display.iconMode} className={MENU_ICON_SIZE} />,
  }))
}

function buildCustomSlashCommandItems(customCommands: CustomSlashCommand[] = []): SlashCommand[] {
  return customCommands.map(command => ({
    id: command.id,
    label: command.label,
    description: command.description ?? command.label,
    icon: <FileText className={MENU_ICON_SIZE} />,
    customCommand: command,
  }))
}

/**
 * sub-agents.md:1013 — the in-session conversation fork. The name is
 * `/subtask`, not `/fork`: `:895` splits them, and `/fork` is now "a separate
 * background session with its own budget", which this app does not have.
 * Selecting it PREFILLS the composer rather than submitting, because the
 * command is nothing without its task text.
 */
const subtaskCommand: SlashCommand = {
  id: 'subtask',
  label: 'Subtask',
  description: 'Fork this conversation into a background agent that inherits it',
  icon: <GitFork className={MENU_ICON_SIZE} />,
}

/**
 * interactive-mode.md:359 — "Use `/btw` to ask a quick question about your
 * current work without adding to the conversation history." Answered
 * out-of-band in the SideQuestionOverlay (`:365` — dismissible overlay, never
 * enters history). Menu selection is the BARE form: it REOPENS the overlay on
 * the most recent exchange (`:374`), so this command must be neither a prefill
 * nor a submitted message.
 */
const btwCommand: SlashCommand = {
  id: 'btw',
  label: 'Side Question',
  description: 'Ask a side question that never enters the conversation history',
  icon: <MessageCircleQuestion className={MENU_ICON_SIZE} />,
}

/**
 * interactive-mode.md:402 — "Run `/recap` to generate a summary on demand";
 * `:400` binds the one-line form. Surfaced through the same SideQuestionOverlay
 * (a recap is an exchange whose question is the localized recap label).
 */
const recapCommand: SlashCommand = {
  id: 'recap',
  label: 'Recap',
  description: 'Generate a one-line recap of this session',
  icon: <History className={MENU_ICON_SIZE} />,
}

const compactCommand: SlashCommand = {
  id: 'compact',
  label: 'Compact Context',
  description: 'Summarize conversation context to free up token budget',
  icon: <Minimize2 className={MENU_ICON_SIZE} />,
}

const modelCommand: SlashCommand = {
  id: 'model',
  label: 'Model',
  description: 'Open model selection',
  icon: <SlidersHorizontal className={MENU_ICON_SIZE} />,
}

/**
 * P4.5 · `/advisor` was answered at the `BaseAgent.chat()` seam from the day
 * P2.1 shipped and was reachable only by typing it — P2.1's own closing ledger
 * records the gap as "absent from the renderer slash menu → owed to P4.5".
 * Offered unconditionally, unlike `/quota`: the advisor ships OFF, so the bare
 * form's job is to report that and tell the user how to turn it on, which is
 * exactly the state in which a discoverable entry is worth most.
 */
const advisorCommand: SlashCommand = {
  id: 'advisor',
  label: 'Advisor',
  description: 'Show or change whether the model may consult the advisor',
  icon: <Lightbulb className={MENU_ICON_SIZE} />,
}

/**
 * P2.217 · `/approve` parsed and executed from the day P3.25 shipped and was
 * offered nowhere — not here and not in `/help` — so only a user who already
 * knew the command existed could use it.
 *
 * Unlike `/advisor` above, this row IS conditional: it overrules the Codex
 * auto-review guardian and nothing else runs one, so
 * `resolveExcludedCommandIds` withdraws it off codex through the same table
 * that withdraws `/quota`, `/subtask` and `/compact`.
 */
const approveCommand: SlashCommand = {
  id: 'approve',
  label: 'Approve',
  description: 'Overrule a Codex auto-review guardian denial',
  icon: <ShieldCheck className={MENU_ICON_SIZE} />,
}

const agentsCommand: SlashCommand = {
  id: 'agents',
  label: 'Agents',
  description: 'Show agent definitions',
  icon: <Bot className={MENU_ICON_SIZE} />,
}

const automationsCommand: SlashCommand = {
  id: 'automations',
  label: 'Automations',
  description: 'Open automations',
  icon: <CalendarClock className={MENU_ICON_SIZE} />,
}

const clearCommand: SlashCommand = {
  id: 'clear',
  label: 'Clear',
  description: 'Clear the current conversation',
  icon: <Eraser className={MENU_ICON_SIZE} />,
}

const helpCommand: SlashCommand = {
  id: 'help',
  label: 'Help',
  description: 'Show available slash commands',
  icon: <CircleHelp className={MENU_ICON_SIZE} />,
}

const memoryCommand: SlashCommand = {
  id: 'memory',
  label: 'Memory',
  description: 'Open session MEMORY.md',
  icon: <BookOpenText className={MENU_ICON_SIZE} />,
}

const usageCommand: SlashCommand = {
  id: 'usage',
  label: 'Usage',
  description: 'Show session token usage',
  icon: <BarChart3 className={MENU_ICON_SIZE} />,
}

/**
 * `/quota` is offered only where a quota endpoint exists behind the runtime
 * (the Nessy gateway); `ComposerCapabilities.slash.excludedCommandIds` removes
 * it everywhere else. Distinct from `/usage`, which counts THIS session's
 * tokens — this one reports the account's remaining daily budget.
 */
const quotaCommand: SlashCommand = {
  id: 'quota',
  label: 'Quota',
  description: 'Show the remaining usage budget',
  icon: <PiggyBank className={MENU_ICON_SIZE} />,
}

// P6.410 — the row is `config`, matching `SESSION_COMMAND_HELP_ENTRIES`; the menu
// and the help listing must name the same id or `resolveExcludedCommandIds`
// cannot withdraw it.
const configCommand: SlashCommand = {
  id: 'config',
  label: 'Config',
  description: 'Show or change a setting from the prompt',
  icon: <Settings2 className={MENU_ICON_SIZE} />,
}

// P6.509 — the id matches `SESSION_COMMAND_HELP_ENTRIES`, same rule as `config`
// and `mcp`. It PREFILLS rather than submitting (`PREFILL_COMMANDS` in
// `slash-command-actions.ts`): a `/cd` with no path is a typo, not a command.
const cdCommand: SlashCommand = {
  id: 'cd',
  label: 'Cd',
  description: 'Move this session\'s working directory',
  icon: <FolderTree className={MENU_ICON_SIZE} />,
}

// P6.352 — the id matches `SESSION_COMMAND_HELP_ENTRIES`; the menu and the help
// listing must name the same id or `resolveExcludedCommandIds` cannot withdraw it.
// P6.278 — the id matches `SESSION_COMMAND_HELP_ENTRIES`, same rule as `mcp`.
const diffCommand: SlashCommand = {
  id: 'diff',
  label: 'Diff',
  description: 'Summarize uncommitted changes',
  icon: <GitCompare className={MENU_ICON_SIZE} />,
}

const mcpCommand: SlashCommand = {
  id: 'mcp',
  label: 'MCP',
  description: 'List MCP servers with status and tool counts',
  icon: <Server className={MENU_ICON_SIZE} />,
}

// P6.294 — the id matches `SESSION_COMMAND_HELP_ENTRIES`, same rule as `mcp`
// and `diff`: the menu and the help listing must name the same id or
// `resolveExcludedCommandIds` cannot withdraw it.
const hooksCommand: SlashCommand = {
  id: 'hooks',
  label: 'Hooks',
  description: 'List the hooks this session will run, by event',
  icon: <Webhook className={MENU_ICON_SIZE} />,
}

// P6.322 half 2 — the id matches `SESSION_COMMAND_HELP_ENTRIES`, same rule as
// `mcp` and `config`. NOT `plan`: that id is a `PermissionMode` and the
// dispatcher's mode branch claims it first — see `prompts/goal.ts`.
const goalCommand: SlashCommand = {
  id: 'goal',
  label: 'Goal',
  description: 'Interview me and set a session goal with a checkable condition',
  icon: <Flag className={MENU_ICON_SIZE} />,
}

// P6.447 — the id matches `SESSION_COMMAND_HELP_ENTRIES`, same rule as `mcp`,
// `diff` and `hooks`: the menu and the help listing must name the same id or
// `resolveExcludedCommandIds` cannot withdraw it. Typed-only until now — the
// parser row and the seam arm existed and nothing offered the command.
const statusCommand: SlashCommand = {
  id: 'status',
  label: 'Status',
  description: 'Show this session\'s endpoint, credential source and proxy',
  icon: <Plug className={MENU_ICON_SIZE} />,
}

const contextCommand: SlashCommand = {
  id: 'context',
  label: 'Context',
  description: 'Show context window breakdown',
  icon: <Gauge className={MENU_ICON_SIZE} />,
}

const exportCommand: SlashCommand = {
  id: 'export',
  label: 'Export',
  description: 'Export session transcript',
  icon: <Download className={MENU_ICON_SIZE} />,
}

const initCommand: SlashCommand = {
  id: 'init',
  label: 'Init',
  description: 'Draft a starter AGENTS.md',
  icon: <FilePlus2 className={MENU_ICON_SIZE} />,
}

const createSkillCommand: SlashCommand = {
  id: 'create-skill',
  label: 'Create Skill',
  description: 'Create a new skill with the skill-creator',
  icon: <Wand2 className={MENU_ICON_SIZE} />,
}

const createPluginCommand: SlashCommand = {
  id: 'create-plugin',
  label: 'Create Plugin',
  description: 'Create a new plugin with the plugin-creator',
  icon: <PackagePlus className={MENU_ICON_SIZE} />,
}

const featureCommands: SlashCommand[] = [
  modelCommand,
  advisorCommand,
  approveCommand,
  agentsCommand,
  automationsCommand,
  btwCommand,
  cdCommand,
  compactCommand,
  configCommand,
  contextCommand,
  createSkillCommand,
  createPluginCommand,
  diffCommand,
  exportCommand,
  goalCommand,
  hooksCommand,
  initCommand,
  clearCommand,
  helpCommand,
  mcpCommand,
  memoryCommand,
  quotaCommand,
  recapCommand,
  statusCommand,
  subtaskCommand,
  usageCommand,
]

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  ...permissionModeCommands,
  ...featureCommands,
]

export const DEFAULT_SLASH_COMMAND_GROUPS: CommandGroup[] = [
  { id: 'modes', commands: permissionModeCommands },
]

// ============================================================================
// Shared Styles (floating menu material: inline-menu-styles.ts)
// ============================================================================

// UB14.21 — the surface is upstream's `popover-styled` (radius 12 + elev-2). The
// radius used to follow the composer's own (its radius token − 8px, the
// Codex-parity coupling); the look now follows upstream (R6-05's logged decision,
// reversible). The list keeps OUR `max-h-[40dvh]` cap over upstream's 260px: the
// menu carries the whole command catalogue, custom commands and recent folders.
const MENU_CONTAINER_STYLE = cn(INLINE_MENU_SURFACE, 'min-w-[200px]')
const MENU_LIST_STYLE = cn(INLINE_MENU_LIST, 'max-h-[40dvh]')
const MENU_ITEM_STYLE = INLINE_MENU_ITEM
const MENU_ITEM_SELECTED = INLINE_MENU_ITEM_SELECTED
// Our extra row parts (label · argument hint · description), on upstream's roles:
// secondary icons, tertiary hint and description (spec §7.10).
const MENU_ICON_STYLE = 'size-4 shrink-0 text-secondary'
const MENU_TITLE_STYLE = 'shrink-0 font-medium'
const MENU_DESCRIPTION_STYLE = 'min-w-0 truncate text-tertiary'
/**
 * The `argument-hint` slot, between the label and the description. `shrink-0`
 * like the label rather than `min-w-0 truncate` like the description: the hint
 * is short by construction and is the one part of the row that tells the user
 * what to type next, so the description is what gives way when the row is
 * narrow.
 */
const MENU_ARGUMENT_HINT_STYLE = 'shrink-0 text-tertiary'
const MENU_SECTION_HEADER = INLINE_MENU_SECTION_LABEL

interface SlashMenuContextStatus {
  inputTokens?: number
  contextWindow?: number
}

// ============================================================================
// Shared: Filter utilities
// ============================================================================

function filterCommands(commands: SlashCommand[], filter: string): SlashCommand[] {
  if (!filter) return commands
  const lowerFilter = filter.toLowerCase()
  return commands.filter(
    cmd =>
      cmd.label.toLowerCase().includes(lowerFilter) ||
      cmd.id.toLowerCase().includes(lowerFilter)
  )
}

/**
 * THE menu's gate. Both exclusion lists are computed in one place server-side
 * (`composer-capabilities.ts:resolveExcludedCommandIds`) from the same
 * predicates the dispatch seams read, and this is where the menu obeys them —
 * so a row the seam would refuse is never offered. It runs over the mode rows,
 * the feature rows AND the custom rows, which is what lets one mechanism close
 * `/subtask` (a feature id) and `/workflow-name` (a custom id minted per
 * session) together.
 *
 * Exported for the offered-vs-dispatchable enumeration in
 * `__tests__/slash-command-menu.test.tsx`: the claim "the menu does not offer
 * X" needs an instrument that reads the menu, not one that reads the seam.
 */
export function filterCommandsByCapability(
  commands: SlashCommand[],
  enabledCommandIds?: string[] | 'all',
  excludedCommandIds?: string[],
  excludedCommandIdPrefixes?: string[],
): SlashCommand[] {
  // `slash.excludedCommandIds` subtracts from `commandIds` (ComposerCapabilities
  // in dto.ts): 'all' cannot express "all except", and the id vocabulary lives
  // here in the renderer.
  const withoutExcluded = excludedCommandIds?.length
    ? commands.filter(command => !excludedCommandIds.includes(command.id))
    : commands
  // `slash.excludedCommandIdPrefixes` subtracts the FAMILIES the resolver cannot
  // enumerate — a saved workflow's id carries its name — so the workflow rows
  // leave the menu on a runtime that cannot dispatch a recipe (P2.279).
  const withoutExcludedFamilies = excludedCommandIdPrefixes?.length
    ? withoutExcluded.filter(command =>
        !excludedCommandIdPrefixes.some(prefix => command.id.startsWith(prefix)))
    : withoutExcluded
  if (enabledCommandIds === undefined || enabledCommandIds === 'all') return withoutExcludedFamilies
  return withoutExcludedFamilies.filter(command => enabledCommandIds.includes(command.id))
}

/** Check if an item is a folder */
function isFolder(item: SlashCommand | SlashFolderItem): item is SlashFolderItem {
  return 'type' in item && item.type === 'folder'
}

/** Filter sections by label/id, keeping sections grouped */
function filterSections(sections: SlashSection[], filter: string): SlashSection[] {
  if (!filter) return sections
  const lowerFilter = filter.toLowerCase()

  // Filter items within each section, keeping section structure
  return sections
    .map(section => ({
      ...section,
      items: section.items.filter(item =>
        item.label.toLowerCase().includes(lowerFilter) ||
        item.id.toLowerCase().includes(lowerFilter) ||
        item.description?.toLowerCase().includes(lowerFilter)
      ),
    }))
    .filter(section => section.items.length > 0)
}

/** Flatten sections into a single array of items */
function flattenSections(sections: SlashSection[]): (SlashCommand | SlashFolderItem)[] {
  return sections.flatMap(section => section.items)
}

// ============================================================================
// Shared: Command Item Content
// ============================================================================

const MODE_COMMAND_IDS = new Set<string>(PERMISSION_MODE_ORDER)
const TRANSLATED_COMMAND_IDS = new Set<string>(['advisor', 'approve', 'agents', 'automations', 'btw', 'cd', 'clear', 'compact', 'config', 'context', 'create-plugin', 'create-skill', 'diff', 'export', 'goal', 'help', 'hooks', 'init', 'mcp', 'memory', 'model', 'quota', 'recap', 'status', 'subtask', 'usage'])

function getContextUsagePercent(contextStatus?: SlashMenuContextStatus): number | null {
  if (contextStatus?.inputTokens == null || contextStatus?.contextWindow == null || contextStatus.contextWindow <= 0) {
    return null
  }
  return Math.round((contextStatus.inputTokens / contextStatus.contextWindow) * 100)
}

function getTranslatedCommandLabel(command: SlashCommand, t: ReturnType<typeof useTranslation>['t']): string {
  if (MODE_COMMAND_IDS.has(command.id)) return t(`mode.${command.id}`, command.label)
  if (TRANSLATED_COMMAND_IDS.has(command.id)) return t(`commands.${command.id}.label`, command.label)
  return command.label
}

export function getTranslatedCommandDescription(command: SlashCommand, t: ReturnType<typeof useTranslation>['t']): string {
  // R15. Before this flag, every mode id was re-resolved from
  // `PERMISSION_MODE_FULL_DESCRIPTION_KEYS`, discarding whatever description the
  // display carried in — so the picker and this menu would have said different
  // things about the same mode in one Codex session.
  //
  // KNOWN CONSEQUENCE, recorded rather than hidden: it also stops discarding a
  // BACKEND-supplied override, which is correct, and the one backend that
  // supplies one (Nestor cloud, `NESTOR_CLOUD_MODE_OPTIONS`) hardcodes English
  // literals. So a Russian user on that connection now reads the backend's own
  // English here, where before they read a translated string that was not the
  // one the backend sent. Right content in the wrong language, in place of the
  // wrong content in the right one. The real fix is to localize the cloud
  // overrides at their source in `composer-capabilities.ts`; that is a separate
  // change to a shared package and is NOT part of this row.
  if (command.descriptionResolved) return command.description
  if (MODE_COMMAND_IDS.has(command.id)) return t(PERMISSION_MODE_FULL_DESCRIPTION_KEYS[command.id as PermissionMode], command.description)
  if (TRANSLATED_COMMAND_IDS.has(command.id)) return t(`commands.${command.id}.description`, command.description)
  return command.description
}

function getCommandDescription(
  command: SlashCommand,
  t: ReturnType<typeof useTranslation>['t'],
  contextStatus?: SlashMenuContextStatus,
): string {
  const baseDescription = getTranslatedCommandDescription(command, t)
  if (command.id !== 'compact') return baseDescription

  const percent = getContextUsagePercent(contextStatus)
  return percent == null
    ? baseDescription
    : `${baseDescription} (${percent}% full)`
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

function CommandItemContent({
  command,
  description,
}: {
  command: SlashCommand
  description?: string
}) {
  const { t } = useTranslation()
  const label = getTranslatedCommandLabel(command, t)
  const displayDescription = description ?? getTranslatedCommandDescription(command, t)
  // P6.612 / P6.406 — what the command expects after its name, drawn beside the
  // label because that is where the user is typing. Not translated: it is the
  // author's own literal (`[issue-number]`, `<file>`), and only a custom command
  // has one — the built-in and permission-mode rows carry no `customCommand`.
  const argumentHint = command.customCommand?.argumentHint
  return (
    <>
      <div className={MENU_ICON_STYLE}>{command.icon}</div>
      <span className={MENU_TITLE_STYLE}>{label}</span>
      {argumentHint && <span className={MENU_ARGUMENT_HINT_STYLE}>{argumentHint}</span>}
      {displayDescription && (
        <span
          className={MENU_DESCRIPTION_STYLE}
          // R15 — the tooltip is what keeps the two surfaces honest here. The
          // composer's picker wraps the whole description (general statement +
          // per-runtime note); this list truncates to one line by design, and
          // the note sits at the END, so it is the FIRST thing an ellipsis
          // removes. Truncation is right for a command palette, so the tail is
          // recovered on hover rather than the row being re-laid out. Without
          // it the two surfaces agree as strings and disagree as rendered text,
          // which is the repo's own recorded trap: verify the consequence, not
          // the identifier.
          title={displayDescription}
        >
          {displayDescription}
        </span>
      )}
    </>
  )
}

// ============================================================================
// SlashCommandMenu Component (Button-triggered popup)
// ============================================================================

export interface SlashCommandMenuProps {
  /** Flat list of commands (use this OR commandGroups, not both) */
  commands?: SlashCommand[]
  /** Grouped commands with separators between groups */
  commandGroups?: CommandGroup[]
  activeCommands?: SlashCommandId[]
  onSelect: (commandId: SlashCommandId) => void
  showFilter?: boolean
  filterPlaceholder?: string
  className?: string
  /** Render without its own floating material (the host popover already draws it) */
  bare?: boolean
  /** Non-interactive hint row under the list (e.g. the mode-cycling shortcut) */
  footer?: React.ReactNode
}

/**
 * Upstream v0.15.0 also takes `showDescriptions` (each mode's one-line
 * description after its name). Not taken: every row here ALWAYS shows its
 * description (`CommandItemContent`), from `PERMISSION_MODE_FULL_DESCRIPTION_KEYS`
 * over our six modes or the runtime-aware text a display carried in (R15).
 */
export function SlashCommandMenu({
  commands,
  commandGroups,
  activeCommands = [],
  onSelect,
  showFilter = false,
  filterPlaceholder,
  className,
  bare = false,
  footer,
}: SlashCommandMenuProps) {
  const { t } = useTranslation()
  const effectiveFilterPlaceholder = filterPlaceholder ?? t("commands.searchCommands")
  const [filter, setFilter] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  // If groups provided, filter within each group; otherwise use flat commands
  const filteredGroups = React.useMemo(() => {
    if (commandGroups) {
      return commandGroups.map(group => ({
        ...group,
        commands: filterCommands(group.commands, filter),
      })).filter(group => group.commands.length > 0)
    }
    return null
  }, [commandGroups, filter])

  const filteredCommands = React.useMemo(() => {
    if (commands && !commandGroups) {
      return filterCommands(commands, filter)
    }
    return null
  }, [commands, commandGroups, filter])

  // Get all commands for defaultValue calculation
  const allFilteredCommands = filteredGroups
    ? filteredGroups.flatMap(g => g.commands)
    : (filteredCommands ?? [])

  // Default to the first active command, or first command if none active
  const defaultValue = activeCommands[0] ?? allFilteredCommands[0]?.id

  React.useEffect(() => {
    // Don't auto-focus the filter on touch devices — it pulls up the virtual keyboard
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
    if (showFilter && inputRef.current && !isTouchDevice) {
      inputRef.current.focus()
    }
  }, [showFilter])

  if (allFilteredCommands.length === 0 && !showFilter) return null

  // Render a single command item
  const renderCommandItem = (cmd: SlashCommand) => {
    return (
      <CommandPrimitive.Item
        key={cmd.id}
        value={cmd.id}
        onSelect={() => onSelect(cmd.id)}
        data-tutorial={`permission-mode-${cmd.id}`}
        className={cn(
          MENU_ITEM_STYLE,
          'outline-none',
          'data-[selected=true]:bg-fill-hover'
        )}
      >
        <CommandItemContent command={cmd} />
      </CommandPrimitive.Item>
    )
  }

  return (
    <CommandPrimitive
      label={effectiveFilterPlaceholder}
      className={cn(bare ? 'min-w-[220px] overflow-hidden text-foreground' : MENU_CONTAINER_STYLE, className)}
      shouldFilter={false}
      defaultValue={defaultValue}
    >
      {showFilter && (
        <div className="flex h-control-xl items-center border-b border-subtle px-3">
          <CommandPrimitive.Input
            ref={inputRef}
            value={filter}
            onValueChange={setFilter}
            placeholder={effectiveFilterPlaceholder}
            className="w-full bg-transparent text-label outline-none placeholder:text-tertiary"
          />
        </div>
      )}
      <CommandPrimitive.List className={MENU_LIST_STYLE}>
        {allFilteredCommands.length === 0 ? (
          <CommandPrimitive.Empty className="py-4 text-center text-label text-tertiary">
            {t('commands.noCommandsFound')}
          </CommandPrimitive.Empty>
        ) : filteredGroups ? (
          // Group-based rendering with smart separators
          filteredGroups.map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              {group.commands.map(renderCommandItem)}
              {/* Separator: only show if there's another group after this one */}
              {groupIndex < filteredGroups.length - 1 && (
                <div className={INLINE_MENU_SEPARATOR} />
              )}
            </React.Fragment>
          ))
        ) : (
          // Flat list rendering
          filteredCommands?.map(renderCommandItem)
        )}
      </CommandPrimitive.List>
      {footer && (
        <>
          <div className="bg-separator h-px" />
          <div className={INLINE_MENU_FOOTER}>{footer}</div>
        </>
      )}
    </CommandPrimitive>
  )
}

// ============================================================================
// InlineSlashCommand - Autocomplete that follows cursor
// ============================================================================

export interface InlineSlashCommandProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: SlashSection[]
  activeCommands?: SlashCommandId[]
  onSelectCommand: (commandId: SlashCommandId) => void
  onSelectFolder: (path: string) => void
  filter?: string
  position: { x: number; y: number }
  anchorRef?: React.RefObject<HTMLElement | null>
  contextStatus?: SlashMenuContextStatus
  className?: string
}

export function InlineSlashCommand({
  open,
  onOpenChange,
  sections,
  onSelectCommand,
  onSelectFolder,
  filter = '',
  position,
  anchorRef,
  contextStatus,
  className,
}: InlineSlashCommandProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const filteredSections = filterSections(sections, filter)
  const flatItems = flattenSections(filteredSections)
  const menuGeometry = useAnchoredMenuGeometry(open, anchorRef, position, 260)

  // Reset selection when filter changes
  React.useEffect(() => {
    setSelectedIndex(0)
  }, [filter])

  // Scroll selected item into view
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  // Handle item selection
  const handleSelect = React.useCallback((item: SlashCommand | SlashFolderItem) => {
    if (isFolder(item)) {
      onSelectFolder(item.path)
    } else {
      onSelectCommand(item.id)
    }
    onOpenChange(false)
  }, [onSelectCommand, onSelectFolder, onOpenChange])

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
          if (flatItems[selectedIndex]) {
            handleSelect(flatItems[selectedIndex])
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
  }, [open, flatItems, selectedIndex, handleSelect, onOpenChange])

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

  // Hide if no results or not open
  if (!open || flatItems.length === 0) return null

  // Track current item index across all sections
  let currentItemIndex = 0

  const menu = (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, INLINE_MENU_ORIGIN, className)}
      style={menuGeometry}
    >
      <div ref={listRef} className={MENU_LIST_STYLE}>
        {filteredSections.map((section, sectionIndex) => (
          <React.Fragment key={section.id}>
            {/* Section header */}
            <div className={MENU_SECTION_HEADER}>
              {section.label}
            </div>

            {/* Section items */}
            {section.items.map((item) => {
              const itemIndex = currentItemIndex++
              const isSelected = itemIndex === selectedIndex

              if (isFolder(item)) {
                // Folder item - single line with path
                return (
                  <div
                    key={`${section.id}-${item.id}`}
                    data-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    className={cn(
                      MENU_ITEM_STYLE,
                      isSelected && MENU_ITEM_SELECTED
                    )}
                  >
                    <div className={MENU_ICON_STYLE}>
                      <Icon_Folder className={MENU_ICON_SIZE} strokeWidth={1.75} />
                    </div>
                    <span className={MENU_TITLE_STYLE}>{item.label}</span>
                    <span className={MENU_DESCRIPTION_STYLE}>{item.description}</span>
                  </div>
                )
              } else {
                // Command item
                return (
                  <div
                    key={item.id}
                    data-selected={isSelected}
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    className={cn(
                      MENU_ITEM_STYLE,
                      isSelected && MENU_ITEM_SELECTED
                    )}
                  >
                    <CommandItemContent command={item} description={getCommandDescription(item, t, contextStatus)} />
                  </div>
                )
              }
            })}

          </React.Fragment>
        ))}
      </div>
    </div>
  )

  return typeof document === 'undefined' ? menu : createPortal(menu, document.body)
}

// ============================================================================
// Hook for managing inline slash command state
// ============================================================================

/** Interface for elements that can be used with useInlineSlashCommand */
export interface SlashCommandInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

/**
 * Format path for display, shortening home directory
 */
function formatPathForDisplay(path: string, homeDir?: string): string {
  if (homeDir && path.startsWith(homeDir)) {
    return '~' + path.slice(homeDir.length)
  }
  return path
}

/**
 * Get folder name from path
 */
function getFolderName(path: string): string {
  return path.split('/').pop() || path
}

export interface UseInlineSlashCommandOptions {
  /** Ref to input element (textarea or RichTextInput handle) */
  inputRef: React.RefObject<SlashCommandInputElement | null>
  onSelectCommand: (commandId: SlashCommandId) => void
  onSelectFolder: (path: string) => void
  activeCommands?: SlashCommandId[]
  permissionModeDisplays?: ComposerPermissionModeDisplay[]
  enabledCommandIds?: string[] | 'all'
  /** ComposerCapabilities.slash.excludedCommandIds — subtracted from the enabled set. */
  excludedCommandIds?: string[]
  /**
   * ComposerCapabilities.slash.excludedCommandIdPrefixes — the same
   * subtraction for per-session command FAMILIES (workflow recipes). P2.279.
   */
  excludedCommandIdPrefixes?: string[]
  customCommands?: CustomSlashCommand[]
  recentFolders?: string[]
  homeDir?: string
}

export interface UseInlineSlashCommandReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  sections: SlashSection[]
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  activeCommands: SlashCommandId[]
  handleSelectCommand: (commandId: SlashCommandId) => string
  handleSelectFolder: (path: string) => string
}

export function useInlineSlashCommand({
  inputRef,
  onSelectCommand,
  onSelectFolder,
  activeCommands = [],
  permissionModeDisplays,
  enabledCommandIds = 'all',
  excludedCommandIds,
  excludedCommandIdPrefixes,
  customCommands = [],
  recentFolders = [],
  homeDir,
}: UseInlineSlashCommandOptions): UseInlineSlashCommandReturn {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [slashStart, setSlashStart] = React.useState(-1)
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // Build sections from commands and folders
  const sections = React.useMemo((): SlashSection[] => {
    const result: SlashSection[] = []
    const modeCommands = filterCommandsByCapability(
      buildPermissionModeCommands(permissionModeDisplays),
      enabledCommandIds,
      excludedCommandIds,
      excludedCommandIdPrefixes,
    )
    const commandItems = filterCommandsByCapability(
      featureCommands,
      enabledCommandIds,
      excludedCommandIds,
      excludedCommandIdPrefixes,
    )
    const customCommandItems = filterCommandsByCapability(
      buildCustomSlashCommandItems(customCommands),
      enabledCommandIds,
      excludedCommandIds,
      excludedCommandIdPrefixes,
    )

    // Modes section
    if (modeCommands.length > 0) {
      result.push({
        id: 'modes',
        label: t('commands.sections.modes'),
        items: modeCommands,
      })
    }

    // Commands section
    if (commandItems.length > 0) {
      result.push({
        id: 'commands',
        label: t('commands.sections.commands'),
        items: commandItems,
      })
    }

    if (customCommandItems.length > 0) {
      result.push({
        id: 'custom-commands',
        label: t('commands.sections.customCommands'),
        items: customCommandItems,
      })
    }

    // Recent folders section - sorted alphabetically by folder name, show all
    if (recentFolders.length > 0) {
      const sortedFolders = [...recentFolders]
        .sort((a, b) => {
          const nameA = getFolderName(a).toLowerCase()
          const nameB = getFolderName(b).toLowerCase()
          return nameA.localeCompare(nameB)
        })

      result.push({
        id: 'folders',
        label: t('commands.sections.recentFolders'),
        items: sortedFolders.map(path => ({
          id: path,
          type: 'folder' as const,
          label: getFolderName(path),
          description: formatPathForDisplay(path, homeDir),
          path,
        })),
      })
    }

    return result
  }, [customCommands, enabledCommandIds, excludedCommandIds, excludedCommandIdPrefixes, homeDir, permissionModeDisplays, recentFolders, t])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/([a-zA-Z0-9._-]*)$/)

    // Only show menu if we have sections with items
    const hasItems = sections.some(s => s.items.length > 0)

    if (slashMatch && hasItems) {
      const filterText = slashMatch[1] || ''
      // Check if there are any filtered results before opening menu
      // This ensures Enter key works normally when no matches exist
      const filteredSections = filterSections(sections, filterText)
      const hasFilteredItems = filteredSections.some(s => s.items.length > 0)

      if (!hasFilteredItems) {
        // No results after filtering - close menu to allow normal Enter handling
        setIsOpen(false)
        setFilter('')
        setSlashStart(-1)
        return
      }

      const matchStart = textBeforeCursor.lastIndexOf('/')
      setSlashStart(matchStart)
      setFilter(filterText)

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
      setSlashStart(-1)
    }
  }, [inputRef, sections])

  const handleSelectCommand = React.useCallback((commandId: SlashCommandId): string => {
    // Capture values BEFORE any state changes to avoid race conditions
    let result = ''
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, slashStart)
      const after = currentValue.slice(cursorPosition)
      result = (before + after).trim()
    }

    // Now safe to trigger state changes
    onSelectCommand(commandId)
    setIsOpen(false)

    return result
  }, [onSelectCommand, slashStart])

  const handleSelectFolder = React.useCallback((path: string): string => {
    // Capture values BEFORE any state changes to avoid race conditions
    // Folder selection directly changes working directory, doesn't insert text
    let result = ''
    if (slashStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, slashStart)
      const after = currentValue.slice(cursorPosition)
      // Just remove the /command text, no badge insertion
      result = (before + after).trim()
    }

    // Trigger working directory change
    onSelectFolder(path)
    setIsOpen(false)

    return result
  }, [onSelectFolder, slashStart])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setSlashStart(-1)
  }, [])

  return {
    isOpen,
    filter,
    position,
    sections,
    handleInputChange,
    close,
    activeCommands,
    handleSelectCommand,
    handleSelectFolder,
  }
}
