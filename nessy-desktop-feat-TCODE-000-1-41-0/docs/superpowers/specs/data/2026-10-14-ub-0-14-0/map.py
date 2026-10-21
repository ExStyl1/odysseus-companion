import re,json
rows=[l.rstrip('\n').split('\t') for l in open('h-paths.tsv')]
parts=[l.rstrip('\n').split('\t') for l in open('h-partial.tsv')]
M=[
 (r'^(\.dockerignore|\.env\.example|Dockerfile\.server|README\.md|apps/electron/README\.md|apps/electron/resources/docs/craft-cli\.md|apps/electron/src/main/menu\.ts|apps/electron/src/renderer/components/app-shell/TopBar\.tsx|apps/electron/src/renderer/components/ui/EditPopover\.tsx|apps/electron/src/shared/menu-schema\.ts|apps/viewer/.*|packages/shared/src/branding\.ts|packages/shared/src/version/manifest\.ts|scripts/install-app\..*|packages/shared/src/auth/(oauth-relay|slack-oauth|google-oauth|oauth-flow-types)\.ts|packages/shared/src/docs/(doc-links|source-guides)\.ts|packages/server-core/src/webui/__tests__/oauth-callback\.test\.ts|packages/session-mcp-server/src/index\.ts|packages/shared/src/agent/core/prerequisite-manager\.ts|packages/shared/src/agent/core/__tests__/(pre-tool-use-checks|prerequisite-manager)\.isolated\.ts|packages/shared/src/utils/toolNames\.ts)$','H16'),
 (r'^packages/shared/src/(sources/(storage|types|builtin-sources)|resources/resource-bundle)\.ts$','H17'),
 (r'^apps/electron/resources/release-notes/','H39'),
 (r'^packages/messaging-|^packages/server/src/index\.ts$','H18'),
 (r'^packages/shared/src/auth/(__tests__/github-copilot\.test|github-copilot|index)\.ts$|^packages/shared/src/agent/backend/internal/drivers/pi\.ts$','H19'),
 (r'^apps/electron/src/main/auto-update\.ts$','H28'),
 (r'^apps/electron/src/main/handlers/workspace\.ts$|^apps/electron/src/preload/bootstrap\.ts$','H45'),
 (r'workspace-avatar|WorkspaceSwitcher|SendResourceToWorkspaceDialog|WorkspaceCreationScreen','H13'),
 (r'browser-toolbar|ui/dialog\.tsx|AutomationMenu|CompactPermissionModeSelector|packages/ui/src/components/(markdown/(CodeBlock|MarkdownJsonBlock|TiptapCodeBlockView)|overlay/ActivityCardsOverlay|ui/LoadingIndicator)\.tsx|packages/ui/src/index\.ts','H14'),
 (r'locales/(de|es|hu|ja|pl|zh-Hans)\.json','H15'),
 (r'ApiKeyInput|provider-icons|AiSettingsPage|shared/tests/models-pi\.test','H24'),
 (r'ActiveOptionBadges|ChatDisplay\.tsx','H2'),
 (r'CompactModelSelector|context-display|context-usage|session-context-usage|backend/pi/protocol\.ts|core/types/message\.ts|pi-context-usage|pi-compaction|claude-event-adapter\.test','H4'),
 (r'claude-compaction-events','H5'),(r'core/src/types/message\.ts','H4'),(r'pi-agent-server/src/index\.ts$','H6'),
 (r'composer-height|input-viewport|scroll-focused-caret|useInputAvailableHeight|InputContainer|apps/webui/','H12'),
 (r'rich-text-input','H32'),
 (r'retry-lifecycle|event-processor/handlers/text\.ts|event-processor/helpers\.ts|apps/cli/|pi-retry|pi-agent-error-handling|pi-query-llm|pi-event-adapter|backend/pi/event-adapter\.ts|agent/errors\.ts|ephemeral-query-lifecycle|block-network','H6'),
 (r'pi-agent-server/src/session-settings','H7'),
 (r'steering-sdk','H52'),
 (r'pending-steers|claude-steering|claude-agent-handoff|agent/backend/types\.ts','H3'),
 (r'persistent-input|agent/index\.ts$','H1'),
 (r'claude-background-message-routing|backend/claude/event-adapter\.ts','H2'),
 (r'developer-context|prompt-builder','H8'),
 (r'source-manager','H9'),
 (r'config/preferences\.ts|agent/mode-manager\.ts','H9'),
 (r'tools/search/|model-resolution','H25'),
 (r'tools/web-fetch\.ts','H26'),
 (r'adapt-credential|custom-endpoint-models|bundle-smoke|craft-metadata-schema','H27'),
 (r'lock-identity|headless-start','H29'),
 (r'unified-network-interceptor','H30'),
 (r'link-target|linkify|markdown-link-routing','H31'),
 (r'agent/options\.ts','H33'),
 (r'archive-session','H35'),
 (r'send-agent-message','H36'),
 (r'execute-prompt-automation-test-mode|server-core/src/sessions/index\.ts','H37'),
 (r'transform-data\.test','H38'),
 (r'release-notes/index','H39'),
 (r'(^|/)package\.json$|bun\.lock|tsconfig\.base\.json|electron-builder\.yml|packages/core/CLAUDE\.md','H40'),
 (r'turn-utils|turn-lifecycle|TurnCard','H41'),
 (r'handle-user-message','H42'),
 (r'rpc/llm-connections\.ts|rpc/onboarding\.ts','H20'),
 (r'config/llm-connections\.ts|config/__tests__/llm-connections\.test','H21'),
 (r'config/storage\.ts|storage-startup-migration|drivers/anthropic\.test|config/models-pi\.ts|shared/tests/models\.test','H22'),
 (r'config/models\.ts|thinking-levels|backend/pi/constants|claude-thinking-config|default-thinking-level','H23'),
 (r'rpc/settings\.ts','H44'),
]
out={}
for a,d,p in rows:
    hit=None
    for rx,i in M:
        if re.search(rx,p): hit=i;break
    out[p]=hit
miss=[p for p,i in out.items() if not i]
print('unmapped',miss)
P={
 'apps/electron/src/main/index.ts':'H28',
 'apps/electron/src/renderer/App.tsx':'H2',
 'apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx':'H12',
 'apps/electron/src/renderer/event-processor/handlers/session.ts':'H4',
 'apps/electron/src/renderer/event-processor/processor.ts':'H6',
 'apps/electron/src/renderer/event-processor/types.ts':'H4',
 'apps/electron/src/renderer/pages/ChatPage.tsx':'H33',
 'packages/core/src/types/index.ts':'H4',
 'packages/server-core/src/handlers/rpc/sessions.ts':'H3',
 'packages/server-core/src/sessions/SessionManager.ts':'H1',
 'packages/server-core/src/sessions/midstream-queue.test.ts':'H42',
 'packages/session-tools-core/src/context.ts':'H35',
 'packages/session-tools-core/src/handlers/index.ts':'H35',
 'packages/session-tools-core/src/index.ts':'H35',
 'packages/session-tools-core/src/tool-defs.ts':'H35',
 'packages/shared/src/agent/claude-agent.ts':'H1',
 'packages/shared/src/agent/pi-agent.ts':'H6',
 'packages/shared/src/agent/session-scoped-tool-callback-registry.ts':'H35',
 'packages/shared/src/agent/session-self-management-bindings.ts':'H35',
 'packages/shared/src/i18n/locales/en.json':'H14',
 'packages/shared/src/prompts/__tests__/system.test.ts':'H8',
 'packages/shared/src/prompts/print-system-prompt.ts':'H8',
 'packages/shared/src/prompts/system.ts':'H9',
 'packages/shared/src/protocol/dto.ts':'H4',
}
for a,d,p in parts: assert p in P,p
json.dump({'full':out,'partial':P},open('h-map.json','w'),indent=1)
from collections import Counter
print(Counter(list(out.values())+list(P.values())))
