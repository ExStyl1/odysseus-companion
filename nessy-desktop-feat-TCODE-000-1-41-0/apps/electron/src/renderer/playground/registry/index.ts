import type { ComponentEntry, CategoryGroup, Category } from './types'
import { onboardingComponents } from './onboarding'
import { chatComponents } from './chat'
import { chatHeaderComponents } from './chat-header' // UB14.6 (v0.15.1)
import { turnCardComponents, fullscreenOverlayComponents } from './turn-card'
import { turnCardModesComponents } from './turn-card-modes'
import { messagesComponents } from './messages'
import { inputComponents } from './input'
import { slashCommandComponents } from './slash-command'
import { markdownComponents } from './markdown'
import { iconComponents } from './icons'
import { oauthComponents } from './oauth'
import { toastsComponents } from './toasts'
import { primitivesComponents } from './primitives'
// UB14.36 (v0.15.1) — the rename / reset / create-project dialogs and the inline colour row on the button vocabulary; ours: upstream has no entry.
import { dialogComponents } from './dialogs'
// UB14.39 — our own dialogs (bypass, folder trust, task run, published page extend/delete, skill preview) on the same vocabulary.
import { oursDialogComponents } from './ours-dialogs'
import { sessionListComponents } from './session-list'
// UB4.11 (v0.14.1) — the left sidebar's one-line titles (short, long page, long top-level, collapsed); ours: upstream has no entry.
import { leftSidebarComponents } from './left-sidebar'
// UB14.2 (v0.15.1) — the panel stack: the joined paper card, a second card, sidebar / list hidden, compact; ours: upstream has no entry.
import { panelStackComponents } from './panel-stack'
// UA2.6 (v0.13.4) — the Kanban board, the tile anatomy (needs-input, runtime chip knobs).
import { kanbanComponents } from './kanban'
// UA3.7 (v0.13.4) — the Task editor design mock (category Kanban, after the board as upstream orders it).
import { taskEditorComponents } from './task-editor'
// UA5.9 (v0.13.4) — project colours on the real session rows (category Session List, after the task editor as upstream).
import { projectColorsComponents } from './project-colors'
// UB7.2 — the workspace avatar states (deterministic hues, fallbacks, sizes), swept in dark.
import { workspaceAvatarComponents } from './workspace-avatar'
// UA7.5 — Pages: the library (empty, the three kinds, posters), one tile per kind, the delete dialog.
import { pagesComponents } from './pages'
import { editPopoverComponents } from './edit-popover'
import { automationComponents } from './automations'
import { entityListComponents } from './entity-lists'
import { browserUiComponents } from './browser-ui'
import { plannerComponents } from './planner'
import { customShadowsComponents } from './custom-shadows'
import { transportBannerComponents } from './transport-banner'
import { containerTransitionsComponents } from './container-transitions'
import { apiKeyInputComponents } from './api-key-input'
import { imageSupportComponents } from './image-support'
import { mobileWebUIComponents } from './mobile-webui'
import { orchestrationComponents } from './orchestration'
import { parityUiComponents } from './parity-ui'
import { usageCostComponents } from './usage-cost'
import { capabilityDetailComponents } from './capability-detail'
// UB14.43 — the info primitives at v0.15.1 (Info_Page states and hero, Info_Alert ×4, badges and state pills).
import { infoPrimitiveComponents } from './info-primitives'
// UB14.58 — the info data tables at v0.15.1 (labels, auto-apply rules, permissions, tools; fullscreen button).
import { infoDataTableComponents } from './info-data-tables'
import { sourcesManagementComponents } from './sources-management'
import { marketplaceComponents } from './marketplace'
import { pluginConfigurationComponents } from './plugin-configuration'
import { pluginInstallChecklistComponents } from './plugin-install-checklist'
import { pendingAuthNoticeComponents } from './pending-auth-notice'
// P6.681 — the five-status source dot, which had zero callers and no screen
// anyone could open it on until this entry.
import { sourceStatusIndicatorComponents } from './source-status-indicator'
// P6.334 — the offer that replaces an immediate spawn.
import { deferredSpawnChipComponents } from './deferred-spawn-chip'
// P6.424 — the spinner tip, the one suggestion surface that renders while the
// user is waiting; silent on every install without a managed allowlist, which
// is why it needs a screen a reviewer can open.
import { pluginSuggestionTipComponents } from './plugin-suggestion-tip'
// P6.361 — the saved-action launcher, which renders nothing on every install
// that declared no action, so the playground is the only place it can be read.
import { workspaceActionsMenuComponents } from './workspace-actions-menu'
// P6.703 — the per-chat memory scope, whose four states depend on host records
// no reviewer can produce on demand.
import { sessionMemoryScopeComponents } from './session-memory-scope'
// P6.712 — the transcript notice line, the surface every host-answered seam
// command (`/help`, `/config`, `/mcp`, `/diff`) reaches.
import { infoNoticeComponents } from './info-notice'
import { mcpServersPanelComponents } from './mcp-servers-panel'
import { settingsBrowserDownloadComponents } from './settings-browser-download'
import { settingsIsolationComponents } from './settings-isolation'
import { settingsBlockedToolsComponents } from './settings-blocked-tools'
import { settingsProvenanceComponents } from './settings-provenance'
import { settingsCodexAutoReviewComponents } from './settings-codex-auto-review'
import { settingsConfigDoctorComponents } from './settings-config-doctor'
// UB6.5 — the Decision model card (off default, the five presets, the Laya probe, the
// honest test, the advanced toggles with tooltips and usage notes), swept in dark.
import { settingsDecisionModelComponents } from './settings-decision-model'
// P6.725 — the startup dialog no reviewer can reach on purpose: seeing it means
// the app refused its own `config.json` and no renderer exists to open this page.
import { brokenConfigDialogComponents } from './broken-config-dialog'
import { startupDialogComponents } from './startup-dialogs'
import { settingsSafeModeComponents } from './settings-safe-mode'
import { browserOriginTrustComponents } from './browser-origin-trust'
import { settingsPermissionsCrossScopeComponents } from './settings-permissions-cross-scope'
import { settingsJudgeRulesComponents } from './settings-judge-rules'
// P6.209 (A42) — what that judge then refused; four states no reviewer can
// produce without arranging for a safety judge to decline something.
import { settingsJudgeDenialsComponents } from './settings-judge-denials'
// UB15.2 — the settings navigator rows on v0.15.1's EntityRow anatomy (ours: upstream has no entry).
import { settingsNavigatorComponents } from './settings-navigator'
// UB15.4 — the Shortcuts page on v0.15.1's column and shared keycaps (ours: upstream has no entry).
import { settingsShortcutsComponents } from './settings-shortcuts'
// UB15.9 — Settings › Appearance's Mode section, colour theme grid (v0.15.1 ThemeGrid) and Motion row; ours: upstream has no entry.
import { settingsThemeGridComponents } from './settings-theme-grid'
import { runtimeSwitchComponents } from './runtime-switch'
// P2.486 — the SHIPPED confirmation, beside the four drafts above it. The
// drafts render hand-written prose about what a switch costs; not one of them
// reads `runtimeSwitchCosts`, so the rows a user is actually shown had never
// been on a screen a reviewer could open.
import { runtimeSwitchCostsComponents } from './runtime-switch-costs'
// P2.491 — a complete, valid registry entry that was never imported here, and
// so was reachable by nobody, inside the surface whose whole purpose is review.
// It arrived in the squashed import commit and nothing has referenced the file
// since.
import { labelBadgeComponents } from './label-badges'
import { sessionGoalComponents } from './session-goal'
// D1.375 — the `/btw` panel, whose empty state is the one the owner
// photographed with no input in it; the playground is where that box is read
// in dark theme without opening a session and typing a slash command.
import { sideQuestionComponents } from './side-question'
import { backgroundFinishedChipComponents } from './background-finished-chip'
// UA1.19 — the Published pages list (six states) and the artifact chip (three), IPC-free.
import { publishedPagesComponents } from './published-pages'
// UB12.55 — the server folder browser (remote workspaces only) in every state, on the shipped view; v0.15.1 has no entry.
import { serverDirectoryBrowserComponents } from './server-directory-browser'

export * from './types'

export const componentRegistry: ComponentEntry[] = [
  ...marketplaceComponents,
  ...pluginConfigurationComponents,
  ...pluginInstallChecklistComponents,
  ...pendingAuthNoticeComponents,
  ...sourceStatusIndicatorComponents,
  ...deferredSpawnChipComponents,
  ...backgroundFinishedChipComponents,
  ...pluginSuggestionTipComponents,
  ...workspaceActionsMenuComponents,
  ...sessionMemoryScopeComponents,
  ...infoNoticeComponents,
  ...mcpServersPanelComponents,
  ...mobileWebUIComponents,
  ...apiKeyInputComponents,
  ...onboardingComponents,
  ...chatHeaderComponents,
  ...chatComponents,
  ...turnCardComponents,
  ...turnCardModesComponents,
  ...fullscreenOverlayComponents,
  ...messagesComponents,
  ...inputComponents,
  ...primitivesComponents,
  ...dialogComponents,
  ...oursDialogComponents,
  ...toastsComponents,
  ...parityUiComponents,
  ...usageCostComponents,
  ...capabilityDetailComponents,
  ...infoPrimitiveComponents,
  ...infoDataTableComponents,
  ...sourcesManagementComponents,
  ...orchestrationComponents,
  ...slashCommandComponents,
  ...markdownComponents,
  ...iconComponents,
  ...oauthComponents,
  ...sessionListComponents,
  ...leftSidebarComponents,
  ...panelStackComponents,
  ...kanbanComponents,
  ...taskEditorComponents,
  ...projectColorsComponents,
  ...workspaceAvatarComponents,
  ...pagesComponents,
  ...editPopoverComponents,
  ...automationComponents,
  ...entityListComponents,
  ...browserUiComponents,
  ...plannerComponents,
  ...customShadowsComponents,
  ...transportBannerComponents,
  ...containerTransitionsComponents,
  ...imageSupportComponents,
  ...settingsBrowserDownloadComponents,
  ...settingsIsolationComponents,
  ...settingsBlockedToolsComponents,
  ...settingsProvenanceComponents,
  ...settingsCodexAutoReviewComponents,
  ...settingsConfigDoctorComponents,
  ...settingsDecisionModelComponents,
  ...brokenConfigDialogComponents,
  ...startupDialogComponents,
  ...settingsSafeModeComponents,
  ...browserOriginTrustComponents,
  ...settingsPermissionsCrossScopeComponents,
  ...settingsJudgeRulesComponents,
  ...settingsJudgeDenialsComponents,
  ...settingsNavigatorComponents,
  ...settingsShortcutsComponents,
  ...settingsThemeGridComponents,
  ...runtimeSwitchComponents,
  ...runtimeSwitchCostsComponents,
  ...labelBadgeComponents,
  ...sessionGoalComponents,
  ...sideQuestionComponents,
  ...publishedPagesComponents,
  ...serverDirectoryBrowserComponents,
]

export function getCategories(): CategoryGroup[] {
  // 'Sources' joined for the pending-auth notice (T4): the union always had
  // it, but the order list did not, and getCategories() silently DROPS any
  // category missing here — the opposite of "a missing state must be loud".
  const categoryOrder: Category[] = ['Primitives', 'Marketplace', 'Sources', 'Capability Detail', 'Mobile WebUI', 'Automations', 'Onboarding', 'Agent Setup', 'Chat', 'Island', 'Browser', 'Planner', 'Custom Shadows', 'Session List', 'Kanban', 'Pages', 'Entity Lists', 'Edit Popover', 'Turn Cards', 'TurnCard Modes', 'Fullscreen', 'Chat Messages', 'Chat Inputs', 'Toast Messages', 'Markdown', 'Icons', 'Settings', 'OAuth']
  const categoryMap = new Map<Category, ComponentEntry[]>()

  for (const entry of componentRegistry) {
    const existing = categoryMap.get(entry.category) ?? []
    categoryMap.set(entry.category, [...existing, entry])
  }

  return categoryOrder
    .filter(name => categoryMap.has(name))
    .map(name => ({
      name,
      components: categoryMap.get(name)!,
    }))
}

export function getComponentById(id: string): ComponentEntry | undefined {
  return componentRegistry.find(c => c.id === id)
}
