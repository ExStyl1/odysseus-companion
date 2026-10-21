#!/usr/bin/env python3
"""d14 map: every path of `git diff --name-only v0.13.4 v0.14.0` (upstream craft-agents-oss)
-> Port manifest section (A-J) -> disposition -> row(s) of the 1.43.0 plan.

Run from the repo root or from this directory (moved into the tree by UB1.1, 2026-10-15):
    python3 docs/superpowers/specs/data/2026-10-14-ub-0-14-0/d14-map.py
It exits 1 when a path matches no rule, when a path matches a rule set that is not unique
(first match wins, but a rule that matches NOTHING is reported as dead), or when the read
of the diff is empty. It writes d14-map.json beside itself.

Planted control (UB11.8): delete any one rule in a scratch copy; the script must exit 1.
Multi-row paths carry a `hunks` note naming which hunk goes to which row.
"""
import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Five levels up from docs/superpowers/specs/data/<dir>/ to the repo root.
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..', '..'))
UP = os.path.join(REPO, '.references', 'craft-agents-oss')

paths = subprocess.run(['git', '-C', UP, 'diff', '--name-only', 'v0.13.4', 'v0.14.0'],
                       capture_output=True, text=True, check=True).stdout.split()
if not paths:
    print('empty read of the upstream diff', file=sys.stderr)
    sys.exit(1)

# (regex, section, disposition, rows, hunks-note or None). First match wins.
R = [
 # ---- A. Permissions and security
 (r'^packages/shared/src/agent/core/(permission-remember\.ts|__tests__/permission-remember\.test\.ts)$', 'A', 'CA', ['UB1.2', 'UB1.5'], None),
 (r'^packages/shared/src/agent/core/(permission-manager\.ts|__tests__/permission-manager\.test\.ts)$', 'A', 'CA (hunk)', ['UB1.5'], None),
 (r'^packages/shared/src/agent/core/pre-tool-use\.ts$', 'A', 'CA (hunk)', ['UB1.5', 'UB1.6', 'UB7.6'], 'domain arm UB1.5; activation re-run UB1.6; allowedWritePaths UB7.6; guarded arm D(c)'),
 (r'^packages/shared/src/agent/core/__tests__/pre-tool-use-checks\.isolated\.ts$', 'A', 'CA (hunks)', ['UB1.5', 'UB7.6'], 'guarded cases D(c)'),
 (r'^packages/shared/src/agent/bash-validator\.ts$|^packages/shared/tests/mode-manager\.test\.ts$', 'A', 'CA', ['UB1.4'], None),
 (r'^packages/shared/src/agent/(mcp-tool-names\.ts|__tests__/mcp-tool-names\.test\.ts|permissions-config\.ts|source-policy\.ts)$', 'A', 'CA (hunk)', ['UB1.8'], 'permissions-config config-dir half KEEP'),
 (r'^packages/shared/src/agent/mode-manager\.ts$', 'A', 'CA (hunks)', ['UB1.4', 'UB1.9', 'UB7.6'], 'guarded arms D(c)'),
 (r'^packages/shared/src/agent/__tests__/mode-manager-allowed-write-paths\.test\.ts$', 'A', 'CA', ['UB7.6'], None),
 (r'^packages/shared/src/agent/pi-agent\.ts$', 'A', 'CA (hunks)', ['UB1.3', 'UB1.6', 'UB2.3', 'UB7.4'], 'guarded wiring D(c)'),
 (r'^apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest\.tsx$', 'A', 'CA', ['UB1.2', 'UB6.10'], 'canRemember UB1.2; risk badges UB6.10'),
 (r'^packages/shared/src/(interceptor-common|unified-network-interceptor)\.ts$|^packages/shared/src/__tests__/(interceptor-common|unified-network-interceptor\.curl)\.test\.ts$', 'A', 'CA', ['UB1.10'], None),
 (r'^apps/electron/resources/docs/permissions\.md$', 'A', 'RW', ['UB1.2', 'UB7.6'], 'Guarded paragraph D(c)'),
 # ---- B. Turn and runtime fixes
 (r'^packages/shared/src/agent/claude-agent\.ts$', 'B', 'CA (hunks)', ['UB2.1', 'UB2.2', 'UB2.3', 'UB6.13', 'UB7.4', 'UB7.5', 'UB9.2'], 'handoff UB2.1; four keep-alive Stop hunks UB2.2; isCompactionInFlight UB2.3; canSteerNow UB6.13; rtk UB7.4; live thinking UB7.5; launchedHere UB9.2; guardLargeMcpToolOutput D(c); guarded D(c)'),
 (r'^packages/shared/src/agent/__tests__/claude-agent-handoff\.test\.ts$', 'B', 'CA', ['UB2.1'], None),
 (r'^packages/shared/src/agent/__tests__/claude-(live-thinking|thinking-config)\.test\.ts$', 'B', 'CA', ['UB7.5'], None),
 (r'^packages/shared/src/agent/__tests__/claude-keepalive-stop\.test\.ts$', 'B', 'CA', ['UB2.2'], None),
 (r'^packages/shared/src/agent/(base-agent|backend/types)\.ts$', 'B', 'CA (hunks)', ['UB2.1', 'UB2.3', 'UB6.13'], 'handoff UB2.1; isCompactionInFlight UB2.3; canSteerNow UB6.13; guardedModeCheck D(c); bridge fields N/A'),
 (r'^packages/shared/src/agent/__tests__/base-agent\.test\.ts$', 'B', 'D(c)', [], 'guarded mode list'),
 (r'^packages/pi-agent-server/src/compaction-wait(\.test)?\.ts$|^packages/shared/src/agent/__tests__/pi-compaction\.test\.ts$', 'B', 'CV/CA', ['UB2.3'], None),
 (r'^packages/pi-agent-server/src/index\.ts$', 'B', 'CA (hunks)', ['UB2.3', 'UB4.9', 'UB6.16'], None),
 (r'^packages/pi-agent-server/src/mini-model-query(\.test)?\.ts$', 'B', 'CA', ['UB4.9'], 'folded into our queryLlm'),
 (r'^packages/pi-agent-server/src/system-prompt-override(\.test)?\.ts$', 'B', 'D(c)', [], 'before_agent_start already ours'),
 (r'^packages/shared/src/agent/backend/pi/event-adapter\.ts$', 'B', 'RW', ['UB2.5'], None),
 (r'^packages/shared/src/agent/backend/claude/pending-steers\.ts$', 'B', 'CA (retargeted)', ['UB6.13'], 'absent in ours; lands in claude-agent.ts steer FIFO'),
 (r'^packages/server-core/src/sessions/SessionManager\.ts$', 'B', 'CA (hunks)', ['UB1.2', 'UB1.3', 'UB2.3', 'UB2.4', 'UB4.8', 'UB6.3', 'UB6.6', 'UB6.7', 'UB6.8', 'UB6.9', 'UB6.10', 'UB6.12', 'UB6.13', 'UB6.14', 'UB6.15', 'UB9.5'], 'guarded/adaptive hunks D(c)'),
 (r'^packages/server-core/src/sessions/source-activated-auto-retry\.test\.ts$', 'B', 'CA', ['UB2.4'], None),
 (r'^packages/server-core/src/sessions/turn-context\.test\.ts$|^packages/shared/src/agent/__tests__/base-agent-turn-context\.test\.ts$', 'B', 'D(c)', [], 'R14-45'),
 (r'^packages/server-core/src/sessions/midstream-queue\.test\.ts$', 'B', 'CA', ['UB6.13'], None),
 (r'^packages/server-core/src/sessions/attended-session\.test\.ts$', 'B', 'D(c)', [], 'unattended belongs to Guarded'),
 (r'^packages/shared/src/agent/(claude-sdk-error-mapper\.ts|__tests__/claude-sdk-error-mapper\.test\.ts)$', 'B', 'KEEP', [], 'R14-30'),
 (r'^packages/shared/src/agent/(options\.ts|__tests__/claude-subprocess-env\.test\.ts)$', 'B', 'KEEP', [], 'R14-31'),
 (r'^packages/shared/src/agent/__tests__/claude-large-mcp-results\.test\.ts$', 'B', 'D(c)', [], 'R14-25'),
 # ---- C. Sources, auth and connections
 (r'^packages/session-tools-core/src/api-auth(\.test)?\.ts$', 'C', 'CA', ['UB3.1'], None),
 (r'^packages/shared/src/sources/(api-tools|credential-manager|index)\.ts$|^packages/shared/src/sources/__tests__/header-credential-shape\.test\.ts$', 'C', 'CA', ['UB3.1'], None),
 (r'^packages/session-tools-core/src/handlers/source-test(\.test)?\.ts$', 'C', 'CA', ['UB3.1', 'UB3.2'], None),
 (r'^apps/electron/resources/docs/sources\.md$', 'C', 'RW', ['UB3.1', 'UB3.3'], None),
 (r'^packages/shared/src/auth/(oauth|generic-oauth|oauth-flow-store|oauth-flow-types)\.ts$|^packages/shared/src/sources/types\.ts$|^packages/server-core/src/handlers/rpc/oauth\.ts$|^packages/shared/src/auth/__tests__/oauth\.test\.ts$', 'C', 'CA', ['UB3.3'], None),
 (r'^packages/shared/src/auth/slack-oauth\.ts$|^packages/shared/src/sources/__tests__/slack-oauth-relay\.isolated\.ts$', 'C', 'D(a)', [], 'R14-19 relay'),
 (r'^packages/server-core/src/handlers/rpc/llm-connections\.ts$|^packages/server-core/src/domain/connection-setup-logic(\.test)?\.ts$|^apps/electron/src/renderer/hooks/useOnboarding\.ts$', 'C', 'CA', ['UB3.4'], None),
 (r'^packages/shared/src/config/(llm-connections\.ts|__tests__/llm-connections\.test\.ts)$', 'C', 'CA', ['UB3.6', 'UB3.7'], None),
 (r'^packages/shared/src/config/models\.ts$|^apps/electron/src/renderer/components/apisetup/ApiKeyInput\.tsx$|^packages/shared/tests/models(-pi)?\.test\.ts$', 'C', 'KEEP', [], 'R14-29'),
 (r'^packages/shared/src/agent/backend/internal/drivers/anthropic(\.test)?\.ts$', 'C', 'KEEP', [], 'H22/H23'),
 (r'^packages/shared/src/mcp/mcp-pool\.ts$', 'C', 'D(c)', [], 'R14-15'),
 (r'^packages/shared/src/(credentials/backends/secure-storage|workspaces/storage|config/paths|utils/logo|agent/core/prerequisite-manager)\.ts$|^packages/shared/src/config/__tests__/paths\.test\.ts$|^packages/shared/src/agent/core/__tests__/prerequisite-manager\.isolated\.ts$|^packages/server-core/src/services/privileged-execution-broker\.ts$|^packages/server-core/src/handlers/rpc/(auth|workspace)\.ts$|^apps/electron/src/main/(index|logger|window-state)\.ts$|^packages/server/src/index\.ts$|^packages/session-tools-core/src/handlers/config-validate\.ts$|^packages/shared/src/config/index\.ts$', 'C', 'KEEP', [], 'R14-21 config-dir audit, ours'),
 (r'^packages/shared/src/docs/index\.ts$', 'C', 'KEEP + CA (hunk)', ['UB6.1'], 'CONFIG_DIR hunk KEEP; decisions DOC_REFS UB6.1'),
 # ---- D. Prompt, renderer and automations
 (r'^packages/shared/src/prompts/(system\.ts|__tests__/system\.test\.ts)$', 'D', 'CA (hunks)', ['UB4.1'], 'the rest D(c) (H11)'),
 (r'^apps/electron/src/renderer/components/ui/EditPopover\.tsx$', 'D', 'CA', ['UB6.8'], 'semantic-rule prompt wording; not a config-dir fix'),
 (r'^apps/electron/src/main/(browser-pane-manager\.ts|__tests__/browser-pane-manager\.test\.ts)$', 'D', 'CA', ['UB4.6'], None),
 (r'^packages/shared/src/automations/(types|schemas|index|webhook-utils)\.ts$|^packages/shared/src/automations/handlers/prompt-handler(\.test)?\.ts$', 'D', 'CA, split', ['UB4.8', 'UB6.9'], 'event/eventPayload UB4.8; semanticCondition UB6.9'),
 (r'^packages/server-core/src/sessions/automation-(loop-and-retry|prompts)\.test\.ts$', 'D', 'CA', ['UB4.8'], None),
 (r'^packages/shared/src/sessions/types\.ts$', 'D', 'CA (hunk)', ['UB4.8'], 'guarded comment D(c)'),
 (r'^apps/electron/src/renderer/components/automations/(AutomationEventTimeline\.tsx|types\.ts)$|^apps/electron/src/renderer/hooks/useAutomations\.ts$|^packages/server-core/src/handlers/rpc/automations\.ts$', 'D', 'CA', ['UB4.8', 'UB6.9'], None),
 (r'^apps/electron/resources/docs/automations\.md$', 'D', 'RW', ['UB4.8', 'UB6.9'], None),
 (r'^apps/electron/resources/docs/craft-cli\.md$', 'D', 'RW', ['UB6.9'], None),
 (r'^packages/shared/src/sessions/(storage\.ts|__tests__/pending-plan-execution\.test\.ts)$', 'D', 'KEEP', [], 'UA12.35'),
 (r'^packages/shared/src/tasks/storage\.ts$', 'D', 'CA', ['UB6.6'], None),
 (r'^apps/electron/src/renderer/components/app-shell/kanban/(TaskEditor\.tsx|task-spec-form\.ts)$', 'D', 'CA (hunks)', ['UB6.6'], 'guarded mode guard D(c)'),
 # ---- E. Decision layer
 (r'^packages/shared/src/decisions/providers\.ts$', 'E', 'CA', ['UB6.2'], 'laya + custom; SaaS D(b); no gateway preset (UB6.18)'),
 (r'^packages/shared/src/decisions/usage(\.test)?\.ts$|^scripts/decisions-report\.ts$', 'E', 'CA', ['UB6.4'], None),
 (r'^packages/shared/src/decisions/', 'E', 'CA', ['UB6.1'], None),
 (r'^packages/shared/src/credentials/(manager|types)\.ts$', 'E', 'CA (hunk)', ['UB6.1'], None),
 (r'^packages/shared/src/config/(validators|storage)\.ts$', 'E', 'CA (hunks)', ['UB6.1', 'UB7.4'], 'DEFAULT_PERMISSION_MODES hunk D(c)'),
 (r'^packages/server-core/src/decisions/(decision-point\.ts|decision-outcomes\.test\.ts)$|^packages/server-core/src/sessions/decision-lifecycle\.test\.ts$', 'E', 'CA', ['UB6.3'], None),
 (r'^packages/server-core/src/handlers/rpc/(decisions|index)\.ts$|^packages/shared/src/protocol/(channels|routing)\.ts$|^apps/electron/src/transport/channel-map\.ts$|^apps/electron/src/shared/types\.ts$|^apps/electron/src/main/handlers/__tests__/registration(-profiles)?\.test\.ts$|^apps/electron/src/shared/__tests__/ipc-channels\.test\.ts$', 'E', 'CA', ['UB6.3'], None),
 (r'^packages/server-core/src/decisions/task-(verdict|repairs)(\.test)?\.ts$|^packages/server-core/src/tasks/(verdict-decision|TaskRunner)(\.test)?\.ts$|^packages/server-core/src/handlers/rpc/tasks\.ts$', 'E', 'CA', ['UB6.6'], None),
 (r'^packages/shared/src/protocol/dto\.ts$', 'E', 'CA, split', ['UB6.6', 'UB9.2', 'UB3.4'], 'TaskVerdictDto UB6.6; task event fields UB9.2; connectionSlug UB3.4; unattended + guarded D(c)'),
 (r'^packages/server-core/src/decisions/turn-outcome(\.test)?\.ts$', 'E', 'CA', ['UB6.7', 'UB6.15'], None),
 (r'^packages/server-core/src/decisions/semantic-labels(\.test)?\.ts$|^packages/shared/src/labels/|^apps/electron/src/renderer/components/info/AutoRulesDataTable\.tsx$|^apps/electron/resources/docs/labels\.md$', 'E', 'CA', ['UB6.8'], None),
 (r'^packages/server-core/src/decisions/automation-condition(\.test)?\.ts$|^packages/shared/src/automations/semantic-condition\.test\.ts$', 'E', 'CA', ['UB6.9'], None),
 (r'^packages/server-core/src/decisions/permission-risks(\.test)?\.ts$|^packages/core/src/types/index\.ts$', 'E', 'CA', ['UB6.10'], None),
 (r'^packages/core/src/types/message\.ts$', 'E', 'CA, split', ['UB1.2', 'UB6.10', 'UB9.2'], 'canRemember UB1.2; PermissionRisk+risks UB6.10; task event fields UB9.2'),
 (r'^packages/session-tools-core/src/tool-defs\.ts$', 'E', 'CA, split', ['UB6.11', 'UB9.2'], 'decide UB6.11; list_background_tasks description UB9.2; spawn_session never-looser description KEEP (F1.549)'),
 (r'^packages/session-tools-core/src/context\.ts$', 'E', 'CA, split', ['UB6.11', 'UB9.2'], 'decide callback/types UB6.11; BackgroundTaskInfo kind/startTime/untracked UB9.2'),
 (r'^packages/session-tools-core/src/types\.ts$', 'E', 'CA, split', ['UB3.1', 'UB6.11'], 'defaultHeaders UB3.1; decision types UB6.11'),
 (r'^packages/session-tools-core/src/handlers/(decide(\.test)?|index)\.ts$|^packages/session-tools-core/src/(index\.ts|tool-defs-filtering\.test\.ts)$|^packages/server-core/src/decisions/tool-callbacks(\.test)?\.ts$|^packages/shared/src/agent/backend/pi/session-tool-defs\.ts$|^packages/shared/src/agent/(session-scoped-tool-callback-registry|session-scoped-tools|session-self-management-bindings)\.ts$|^packages/ui/src/lib/tool-parsers\.ts$|^packages/ui/src/components/chat/TurnCard\.tsx$', 'E', 'CA', ['UB6.11'], None),
 (r'^packages/server-core/src/decisions/smart-titles(\.test)?\.ts$|^packages/server-core/src/sessions/title-generation\.isolated\.ts$', 'E', 'CA', ['UB6.12'], None),
 (r'^packages/server-core/src/decisions/mid-turn-messages(\.test)?\.ts$', 'E', 'CA', ['UB6.13'], None),
 (r'^packages/server-core/src/decisions/suggestions(\.test)?\.ts$', 'E', 'CA (sources half)', ['UB6.14'], 'skills half D(c)'),
 (r'^packages/server-core/src/decisions/large-results(\.test)?\.ts$|^packages/pi-agent-server/src/large-result-gate(\.test)?\.ts$|^packages/shared/src/utils/(large-response\.ts|__tests__/large-result-summary-gate\.test\.ts)$|^packages/shared/src/agent/backend/pi/protocol\.ts$', 'E', 'MEAS', ['UB5.6', 'UB6.16'], None),
 (r'^apps/electron/src/renderer/pages/settings/AiSettingsPage\.tsx$|^apps/electron/src/renderer/components/settings/SettingsToggle\.tsx$', 'E', 'CA', ['UB6.5', 'UB7.4'], 'rtk hunk UB7.4'),
 (r'^apps/electron/resources/docs/decisions\.md$', 'E', 'RW', ['UB6.1'], None),
 (r'^packages/shared/src/agent/core/(guarded-mode\.ts|__tests__/guarded-mode\.test\.ts)$|^packages/server-core/src/decisions/guarded-mode(\.test)?\.ts$|^packages/shared/src/agent/__tests__/(guarded-permission-mode|pi-agent-guarded-mode|clamp-permission-mode)\.test\.ts$', 'E', 'D(c)', [], 'OQ-43.4'),
 (r'^packages/shared/src/agent/(mode-types|plan-types|spawn-session-tool|index)\.ts$|^packages/shared/src/agent/core/index\.ts$|^packages/shared/src/views/(types|validation)\.ts$|^packages/shared/src/workspaces/types\.ts$|^apps/electron/src/renderer/atoms/(permission-modes|sessions)\.ts$|^apps/electron/src/renderer/hooks/(useAvailablePermissionModes|useSessionOptions)\.ts$|^apps/electron/src/renderer/components/app-shell/(ActiveOptionBadges|ChatDisplay)\.tsx$|^apps/electron/src/renderer/components/app-shell/input/(FreeFormInput|CompactPermissionModeSelector)\.tsx$|^apps/electron/src/renderer/components/ui/slash-command-menu\.tsx$|^apps/electron/src/renderer/contexts/NavigationContext\.tsx$|^apps/electron/src/renderer/pages/(ChatPage|SkillInfoPage)\.tsx$|^apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage\.tsx$|^packages/server-core/src/handlers/rpc/sessions\.ts$|^packages/server-core/src/handlers/session-manager-interface\.ts$', 'E', 'D(c)', [], "Guarded's plumbing; rpc/sessions.ts mode validation KEEP (F1.800)"),
 (r'^packages/server-core/src/decisions/adaptive-thinking(\.test)?\.ts$', 'E', 'D(c)', [], 'native on Claude'),
 # ---- F. Parity polish, rtk, dependencies, churn
 (r'^packages/shared/src/agent/core/(rtk-detector|rtk-rewrite)\.ts$|^packages/shared/src/agent/core/__tests__/rtk-rewrite\.test\.ts$|^apps/electron/src/renderer/components/RtkUpdateDialog\.tsx$', 'F', 'CA', ['UB7.4'], 'OQ-43.8 (b)'),
 (r'^apps/electron/src/renderer/components/app-shell/AppShell\.tsx$', 'F', 'CA (rtk half)', ['UB7.4'], 'guarded half D(c)'),
 (r'(^|/)package\.json$|^bun\.lock$', 'F', 'MEAS / N/A', ['UB8.1', 'UB8.2'], 'SDK 0.3.280, Pi 0.87.1 via Artifactory only; version fields N/A; messaging packages D(b)'),
 (r'^apps/electron/resources/bridge-mcp-server/index\.js$|^apps/electron/electron-builder\.yml$|^apps/electron/resources/AGENTS\.md$|^scripts/(build/common|build-server|electron-build-main|electron-dev)\.ts$|^packages/shared/src/agent/backend/internal/(driver-types|runtime-resolver)\.ts$', 'F', 'D(c)', [], 'R14-34 bridge removed upstream'),
 (r'^apps/cli/src/index\.ts$|^Dockerfile\.server$|^\.gitignore$|^packages/core/README\.md$|^packages/shared/CLAUDE\.md$|^packages/shared/src/release-notes/index\.ts$', 'F', 'N/A', [], 'upstream churn'),
 (r'^apps/electron/resources/release-notes/', 'F', 'D(a)', [], "Craft's release notes"),
 (r'^apps/electron/src/renderer/playground/mock-utils\.ts$', 'F', 'N/A (read)', ['UB3.7'], 'ours carries no deepseek-v4-flash'),
 (r'^packages/shared/src/i18n/locales/en\.json$', 'I', 'CA by owning row', [], 'section I'),
 (r'^packages/shared/src/i18n/locales/(de|es|hu|ja|pl|zh-Hans)\.json$', 'I', 'D(c)', [], 'en+ru only'),
 # ---- G. Carried by pointer
 (r'^packages/shared/src/agent/backend/claude/(event-adapter|task-notification)\.ts$|^packages/shared/src/agent/(tool-matching\.ts|__tests__/tool-matching\.test\.ts)$|^packages/shared/src/agent/__tests__/claude-(background-message-routing|event-adapter-tasks)\.test\.ts$|^packages/session-tools-core/src/handlers/list-background-tasks\.ts$|^packages/server-core/src/sessions/background-task-surface\.test\.ts$|^apps/electron/src/renderer/App\.tsx$', 'G', 'PTR', ['UB9.2'], 'UA12.18; event-adapter heartbeat hunk UB9.3'),
 (r'^packages/shared/src/agent/__tests__/claude-event-adapter\.test\.ts$', 'G', 'PTR', ['UB9.3'], 'UA12.39'),
 (r'^packages/shared/src/utils/(files\.ts|__tests__/path-relativize\.test\.ts)$', 'G', 'PTR', ['UB9.4'], 'UA12.38'),
]

out, unmapped, used = {}, [], set()
for p in paths:
    for i, (rx, sec, disp, rows, note) in enumerate(R):
        if re.search(rx, p):
            out[p] = {'section': sec, 'disp': disp, 'rows': rows, **({'hunks': note} if note else {})}
            used.add(i)
            break
    else:
        unmapped.append(p)
dead = [R[i][0] for i in range(len(R)) if i not in used]
json.dump({'diff': 'v0.13.4..v0.14.0', 'count': len(paths), 'map': out},
          open(os.path.join(HERE, 'd14-map.json'), 'w'), indent=1)
from collections import Counter
print('paths', len(paths), 'mapped', len(out), 'by section', dict(sorted(Counter(v['section'] for v in out.values()).items())))
if unmapped or dead:
    print('UNMAPPED', unmapped, file=sys.stderr)
    print('DEAD RULES', dead, file=sys.stderr)
    sys.exit(1)
