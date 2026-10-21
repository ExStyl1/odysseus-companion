import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry } from './types'
import { FileText, SquareSlash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FreeFormInput } from '@/components/app-shell/input/FreeFormInput'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { CUSTOM_SLASH_COMMAND_PREFIX, type CustomSlashCommandId } from '@nessy-agent/shared/slash-commands/common'
import { ensureMockElectronAPI, mockMcpResources } from '../mock-utils'
import {
  InlineSlashCommand,
  SlashCommandMenu,
  DEFAULT_SLASH_COMMANDS,
  buildPermissionModeCommands,
  type SlashCommand,
  type SlashCommandId,
  type SlashSection,
} from '@/components/ui/slash-command-menu'
import {
  InlineMentionMenu,
  mcpResourceToMentionItem,
  type MentionSection,
} from '@/components/ui/mention-menu'
import { InlineSkillMention } from '@/components/ui/skill-mention-menu'
import { RichTextInput } from '@/components/ui/rich-text-input'

// ============================================================================
// SlashCommandDemo - Full interactive demo
// ============================================================================

function SlashCommandDemo() {
  const [activeCommands, setActiveCommands] = React.useState<SlashCommandId[]>([])
  const [buttonMenuOpen, setButtonMenuOpen] = React.useState(false)
  const [inputValue, setInputValue] = React.useState('')
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('default')
  const [model, setModel] = React.useState('claude-sonnet-4-20250514')

  // FreeFormInput depends on Electron bridge APIs (attachments, clipboard, etc.)
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  // Handle command selection (toggle active state)
  const handleCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    setActiveCommands(prev =>
      prev.includes(commandId)
        ? prev.filter(id => id !== commandId)
        : [...prev, commandId]
    )
  }, [])

  const handleButtonSelect = (commandId: SlashCommandId) => {
    handleCommandSelect(commandId)
    setButtonMenuOpen(false)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Description */}
      <div className="shrink-0 p-4 border-b border-border/50">
        <h2 className="text-sm font-medium text-foreground/80 mb-2">
          Slash Command Menu Demo
        </h2>
        <p className="text-xs text-muted-foreground">
          Type <code className="px-1 py-0.5 bg-muted rounded">/</code> to trigger inline autocomplete in the real input component, or click the button to open the standalone menu.
          Active commands in the standalone menu show a checkmark.
        </p>
      </div>

      {/* Active Commands Display */}
      {activeCommands.length > 0 && (
        <div className="shrink-0 px-4 py-2 border-b border-border/50 flex flex-wrap gap-2">
          <span className="text-xs text-muted-foreground">Standalone menu active:</span>
          {activeCommands.map(id => {
            const cmd = DEFAULT_SLASH_COMMANDS.find(c => c.id === id)
            const color = cmd?.color || '#888'
            return cmd ? (
              <button
                key={id}
                onClick={() => setActiveCommands(prev => prev.filter(c => c !== id))}
                className="h-6 px-2 text-[11px] font-medium rounded flex items-center gap-1.5 transition-all border"
                style={{
                  backgroundColor: `${color}1A`, // 10% opacity
                  color: color,
                  borderColor: `${color}4D`, // 30% opacity
                }}
              >
                {cmd.icon}
                <span>{cmd.label}</span>
                <span className="opacity-60 hover:opacity-100">×</span>
              </button>
            ) : null
          })}
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex gap-4 p-4">
        {/* Left: Button Menu with Filter */}
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Button Menu (with filter input)
          </div>
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setButtonMenuOpen(!buttonMenuOpen)}
            >
              <SquareSlash className="h-4 w-4" />
              Commands
            </Button>
            {buttonMenuOpen && (
              <div className="absolute top-full left-0 mt-2 z-10">
                <SlashCommandMenu
                  commands={DEFAULT_SLASH_COMMANDS}
                  activeCommands={activeCommands}
                  onSelect={handleButtonSelect}
                  showFilter={true}
                  className="w-[240px]"
                />
              </div>
            )}
          </div>
        </div>

        {/* Right: Static Menu (no filter) */}
        <div className="flex-1">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Static Menu (no filter)
          </div>
          <SlashCommandMenu
            commands={DEFAULT_SLASH_COMMANDS}
            activeCommands={activeCommands}
            onSelect={handleButtonSelect}
            className="w-full"
          />
        </div>
      </div>

      {/* Input Area using the real app input component */}
      <div className="shrink-0 p-4 border-t border-border/50">
        <div className="text-xs font-medium text-muted-foreground mb-2">
          Real FreeFormInput (type / in the input)
        </div>
        <FreeFormInput
          placeholder="Type / to see commands..."
          currentModel={model}
          onModelChange={setModel}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          inputValue={inputValue}
          onInputChange={setInputValue}
          sessionId="playground-session"
          onSubmit={() => {}}
          onStop={() => {}}
        />
      </div>
    </div>
  )
}

// ============================================================================
// ComposerCaretMenus - UB14.21: each caret menu open on the floating material
// ============================================================================

const CARET_MENU_WORKSPACE = 'playground-workspace'

/** Path-free capability rows (no iconUrl: nothing is fetched; the avatars draw their fallback). */
function caretMenuCapability(
  partial: Pick<SafeCapabilitySummary, 'key' | 'kind' | 'logicalName'> & Partial<SafeCapabilitySummary>,
): SafeCapabilitySummary {
  return {
    origin: 'native',
    scope: { kind: 'workspace', workspaceId: CARET_MENU_WORKSPACE },
    state: 'active',
    readOnly: false,
    trustState: 'not-required',
    credentialState: 'not-required',
    selectedAsUnqualifiedAlias: true,
    diagnosticCodes: [],
    ...partial,
  }
}

const CARET_MENU_SKILLS: SafeCapabilitySummary[] = [
  caretMenuCapability({ key: 'skill:code-review', kind: 'skill', logicalName: 'code-review', description: 'Review the working tree against the project rules' }),
  caretMenuCapability({ key: 'skill:release-notes', kind: 'skill', logicalName: 'release-notes', description: 'Draft release notes from the merged changelog' }),
  caretMenuCapability({ key: 'skill:api-design', kind: 'skill', logicalName: 'api-design', description: 'Design and review public API changes' }),
]

const CARET_MENU_SOURCES: SafeCapabilitySummary[] = [
  caretMenuCapability({ key: 'source:local-files', kind: 'source', sourceType: 'local', logicalName: 'local-files', description: 'Files in the working directory' }),
]

const CARET_MENU_AGENT = caretMenuCapability({ key: 'agent:code-reviewer', kind: 'agent', logicalName: 'code-reviewer', description: 'Reviews diffs for correctness' })

/** The argument-hint slot (P6.612) is drawn by a custom command only. */
const CARET_MENU_CUSTOM_COMMAND_ID: CustomSlashCommandId = `${CUSTOM_SLASH_COMMAND_PREFIX}fix-issue`
const CARET_MENU_CUSTOM_COMMAND: SlashCommand = {
  id: CARET_MENU_CUSTOM_COMMAND_ID,
  label: '/fix-issue',
  description: 'Fix a tracked issue and open a branch for it',
  icon: <FileText className="size-4" />,
  customCommand: { id: CARET_MENU_CUSTOM_COMMAND_ID, name: 'fix-issue', label: '/fix-issue', argumentHint: '[issue-number]' },
}

type CaretMenuKind = 'slash' | 'mention' | 'skill' | 'badges' | 'badges-selected'

interface ComposerCaretMenusProps {
  menu: CaretMenuKind
}

/**
 * Each composer caret menu, open, anchored above a stand-in composer the way
 * FreeFormInput anchors them (the slash and mention menus take the composer as
 * `anchorRef`; the deprecated skill menu follows a caret position). The badge
 * states render the RichTextInput's own mention badges; "selected" selects the
 * whole text so the badges take the `--selection` tint.
 */
function ComposerCaretMenus({ menu }: ComposerCaretMenusProps) {
  const { t } = useTranslation()
  const anchorRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLDivElement>(null)
  const [caret, setCaret] = React.useState({ x: 0, y: 0 })
  const [badgeText, setBadgeText] = React.useState('Review [skill:code-review] with [source:local-files] before the release ')

  React.useLayoutEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (rect) setCaret({ x: rect.left + 24, y: rect.top })
  }, [menu])

  React.useEffect(() => {
    if (menu !== 'badges-selected') return
    const textbox = inputRef.current?.querySelector('[role="textbox"]')
    const selection = typeof window !== 'undefined' ? window.getSelection() : null
    if (!textbox || !selection) return
    const range = document.createRange()
    range.selectNodeContents(textbox)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [menu])

  const slashSections = React.useMemo((): SlashSection[] => [
    { id: 'modes', label: t('commands.sections.modes'), items: buildPermissionModeCommands() },
    { id: 'commands', label: t('commands.sections.commands'), items: DEFAULT_SLASH_COMMANDS.filter(command => ['model', 'compact', 'help'].includes(command.id)) },
    { id: 'custom-commands', label: t('commands.sections.customCommands'), items: [CARET_MENU_CUSTOM_COMMAND] },
    { id: 'folders', label: t('commands.sections.recentFolders'), items: [{ id: '/Users/demo/projects/nessy', type: 'folder', label: 'nessy', description: '~/projects/nessy', path: '/Users/demo/projects/nessy' }] },
  ], [t])

  const mentionSections = React.useMemo((): MentionSection[] => [
    { id: 'skills', label: t('chat.mentionSection.skills'), items: CARET_MENU_SKILLS.slice(0, 2).map(skill => ({ id: skill.logicalName, type: 'skill' as const, label: skill.logicalName, description: skill.description, skill })) },
    { id: 'agents', label: t('chat.mentionSection.agents'), items: [{ id: CARET_MENU_AGENT.logicalName, type: 'agent' as const, label: CARET_MENU_AGENT.logicalName, description: CARET_MENU_AGENT.description, agent: CARET_MENU_AGENT }] },
    { id: 'sources', label: t('chat.mentionSection.sources'), items: CARET_MENU_SOURCES.map(source => ({ id: source.logicalName, type: 'source' as const, label: source.logicalName, description: source.description, source })) },
    { id: 'resources', label: t('chat.mentionSection.resources'), items: mockMcpResources.slice(0, 2).map(mcpResourceToMentionItem) },
    { id: 'files', label: t('chat.mentionSection.files'), items: [
      { id: '/Users/demo/projects/nessy/src/app.ts', type: 'file' as const, label: 'app.ts', description: 'src/app.ts', file: { path: '/Users/demo/projects/nessy/src/app.ts', type: 'file' as const, relativePath: 'src/app.ts' } },
      { id: '/Users/demo/projects/nessy/docs', type: 'folder' as const, label: 'docs', description: 'docs', file: { path: '/Users/demo/projects/nessy/docs', type: 'directory' as const, relativePath: 'docs' } },
      { id: '/Users/demo/projects/nessy/vendor/blob.bin', type: 'file' as const, label: 'blob.bin', description: 'vendor/blob.bin', disabled: true, file: { path: '/Users/demo/projects/nessy/vendor/blob.bin', type: 'file' as const, relativePath: 'vendor/blob.bin' } },
    ] },
  ], [t])

  const noop = React.useCallback(() => {}, [])
  const isBadges = menu === 'badges' || menu === 'badges-selected'

  return (
    <div className="flex h-full w-full max-w-[640px] flex-col justify-end gap-3 p-6">
      {isBadges ? (
        <div ref={inputRef} className="rounded-xl bg-raised p-3 shadow-elev-1">
          <RichTextInput
            value={badgeText}
            onChange={setBadgeText}
            skills={CARET_MENU_SKILLS}
            sources={CARET_MENU_SOURCES}
            workspaceId={CARET_MENU_WORKSPACE}
          />
        </div>
      ) : (
        <div ref={anchorRef} className="h-[88px] rounded-xl bg-raised p-3 text-label text-tertiary shadow-elev-1">
          {menu === 'slash' ? '/' : '@'}
        </div>
      )}
      {menu === 'slash' && (
        <InlineSlashCommand
          open
          onOpenChange={noop}
          sections={slashSections}
          onSelectCommand={noop}
          onSelectFolder={noop}
          position={caret}
          anchorRef={anchorRef}
          contextStatus={{ inputTokens: 64_000, contextWindow: 200_000 }}
        />
      )}
      {menu === 'mention' && (
        <InlineMentionMenu
          open
          onOpenChange={noop}
          sections={mentionSections}
          onSelect={noop}
          position={caret}
          anchorRef={anchorRef}
          workspaceId={CARET_MENU_WORKSPACE}
        />
      )}
      {menu === 'skill' && (
        <InlineSkillMention
          open
          onOpenChange={noop}
          skills={CARET_MENU_SKILLS}
          onSelect={noop}
          position={caret}
          workspaceId={CARET_MENU_WORKSPACE}
        />
      )}
    </div>
  )
}

// ============================================================================
// Component Registry Entries
// ============================================================================

export const slashCommandComponents: ComponentEntry[] = [
  {
    id: 'slash-command-demo',
    name: 'Slash Command Demo',
    category: 'Chat Inputs',
    description: 'Interactive demo showing both button-triggered and inline slash command menus',
    component: SlashCommandDemo,
    layout: 'full',
    props: [],
    variants: [],
    mockData: () => ({}),
  },
  {
    id: 'composer-caret-menus',
    name: 'Composer Caret Menus',
    category: 'Chat Inputs',
    description: 'The / and @ menus, the deprecated skill menu and the mention badges on the floating menu material (UB14.21)',
    component: ComposerCaretMenus,
    layout: 'full',
    props: [
      {
        name: 'menu',
        description: 'Which caret surface is open',
        control: {
          type: 'select',
          options: [
            { label: 'Slash commands', value: 'slash' },
            { label: 'Mentions', value: 'mention' },
            { label: 'Skill mentions (deprecated menu)', value: 'skill' },
            { label: 'Mention badges', value: 'badges' },
            { label: 'Mention badges, selected', value: 'badges-selected' },
          ],
        },
        defaultValue: 'slash',
      },
    ],
    variants: [
      { name: 'Slash commands', description: 'Modes, commands, a custom command with its argument hint, a recent folder', props: { menu: 'slash' } },
      { name: 'Mentions', description: 'Skills, agents, sources, MCP resources, files and a disabled row', props: { menu: 'mention' } },
      { name: 'Skill mentions', description: 'The deprecated skill-only menu', props: { menu: 'skill' } },
      { name: 'Mention badges', description: 'Badges in the composer text', props: { menu: 'badges' } },
      { name: 'Mention badges, selected', description: 'Badges inside a selection take the --selection tint', props: { menu: 'badges-selected' } },
    ],
    mockData: () => ({}),
  },
]
