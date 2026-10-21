#!/usr/bin/env python3
"""d15 map: every path of `git diff --name-only v0.14.0 v0.15.1` (upstream craft-agents-oss)
-> Port manifest section (A-N; K=v0.14.1, L=v0.15.0 non-UI, M=v0.15.0 redesign/settings,
N=v0.15.1) -> disposition -> row(s) of the 1.43.0 plan
(docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md).

Run from the repo root or from this directory (landed in the tree by UB1.17, 2026-10-15):
    python3 docs/superpowers/specs/data/2026-10-14-ub-delta-0-15-1/d15-map.py
The path list is re-derived from the tag diff at run time (all-paths.txt is never trusted).
It exits 1 when a path matches no rule, when a rule matches NOTHING (dead), or when a row id
it names is absent from the plan's Tracker. It writes d15-map.json beside itself.

Planted controls (UB1.17, re-run by UB11.8): delete any one rule in a scratch copy -> exit 1
naming the unmapped paths; add a rule matching nothing -> exit 1 naming the dead rule; the
clean run prints `615 of 615` and the per-section counts.
Multi-row paths carry a `hunks` note naming which hunk goes to which row.
"""
import json, os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Five levels up from docs/superpowers/specs/data/<dir>/ to the repo root.
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..', '..'))
UP = os.path.join(REPO, '.references', 'craft-agents-oss')
PLAN = os.path.join(REPO, 'docs', 'superpowers', 'plans', '2026-10-14-upstream-adoption-0-15-1.md')

BROWSER_SET = ['UB4.15', 'UB4.16', 'UB4.17', 'UB4.18', 'UB4.19', 'UB4.20', 'UB4.21']

paths = subprocess.run(['git', '-C', UP, 'diff', '--name-only', 'v0.14.0', 'v0.15.1'],
                       capture_output=True, text=True, check=True).stdout.split()
if not paths:
    print('empty read of the upstream diff', file=sys.stderr)
    sys.exit(1)

# (regex, section, disposition, rows, hunks-note or None). First match wins.
R = [
 # ---- A. Permissions and security (paths first mapped in v0.13.4..v0.14.0, changed again)
 (r'^packages/shared/src/agent/core/pre-tool-use\.ts$', 'A', 'CA (hunks)', ['UB1.5', 'UB1.6', 'UB7.6', 'UB3.9', 'UB7.12'], 'domain arm UB1.5; activation re-run UB1.6; allowedWritePaths UB7.6 (retarget); _intent UB3.9; the guides-read arm UB7.12; guarded D(c)'),
 (r'^packages/shared/src/agent/core/__tests__/pre-tool-use-checks\.isolated\.ts$', 'A', 'CA (hunks)', ['UB1.5', 'UB7.6', 'UB3.9'], '_intent cases UB3.9; allowedWritePaths UB7.6; guarded D(c)'),
 (r'^packages/shared/src/agent/pi-agent\.ts$', 'A', 'CA (hunks)', ['UB1.3', 'UB1.6', 'UB2.3', 'UB7.4', 'UB3.9'], 'activation re-run UB1.6; compaction queue UB2.3; rtk exclude UB7.4; routeToolCall _intent UB3.9; guarded D(c)'),
 (r'^packages/core/src/types/message\.ts$', 'E', 'CA, split', ['UB1.2', 'UB6.10', 'UB9.2', 'UB9.8'], 'canRemember UB1.2 and risks UB6.10 retarget-check; task_activity UB9.8'),
 (r'^apps/electron/src/renderer/components/app-shell/input/structured/PermissionRequest\.tsx$', 'M', 'CA', ['UB1.2', 'UB6.10', 'UB14.24'], 'canRemember/risk badges retarget-check UB1.2/UB6.10; the decision-anatomy look UB14.24'),
 # ---- B. Turn and runtime fixes (retargets)
 (r'^packages/shared/src/agent/claude-agent\.ts$', 'B', 'CA (hunks)', ['UB2.1', 'UB2.2', 'UB2.3', 'UB2.10', 'UB2.11', 'UB6.13', 'UB7.4', 'UB7.5', 'UB9.2', 'UB3.9', 'UB1.16'], 'handoff UB2.1; keep-alive Stop UB2.2 + cancelProcessing UB2.10; compaction UB2.3; pdf-inline caller UB2.11; canSteerNow UB6.13; rtk UB7.4; thinking UB7.5; launchedHere UB9.2; SOURCE_TOOL_INTENT UB3.9; keepPasswordEntryLines UB1.16'),
 (r'^packages/shared/src/agent/backend/types\.ts$', 'B', 'CA (hunks)', ['UB2.1', 'UB2.3', 'UB6.13', 'UB2.10'], 'handoff UB2.1; isCompactionInFlight UB2.3; canSteerNow UB6.13; stopTurn UB2.10'),
 (r'^packages/shared/src/agent/base-agent\.ts$', 'B', 'CA (hunks)', ['UB2.1', 'UB2.3', 'UB6.13', 'UB7.10', 'UB7.11'], 'handoff UB2.1; isCompactionInFlight UB2.3; canSteerNow UB6.13; getSourceFeatures UB7.10/UB7.11'),
 (r'^packages/shared/src/agent/backend/claude/event-adapter\.ts$', 'B', 'CA (hunks)', ['UB9.2', 'UB8.1'], 'task creation carried UB9.2 (UA12.18); the detached-tool hunk is CA only at SDK >= 0.3.287 (UB8.1, S-03)'),
 (r'^packages/shared/src/agent/backend/claude/task-notification\.ts$', 'B', 'CA (hunks)', ['UB9.2', 'UB9.8'], 'creation carried UB9.2; the follow-and-stop hunks UB9.8'),
 (r'^packages/shared/src/agent/backend/pi/protocol\.ts$', 'B', 'CA (hunks)', ['UB5.6', 'UB6.16'], 'excerpt field UB6.16; the v0.14.0 gate hunks measured by UB5.6'),
 (r'^packages/shared/src/agent/__tests__/claude-keepalive-stop\.test\.ts$', 'B', 'CA', ['UB2.2', 'UB2.10'], 'Stop arms UB2.2 (amended); the Stop-ends-only-the-reply cases UB2.10'),
 (r'^packages/shared/src/agent/__tests__/claude-thinking-config\.test\.ts$', 'B', 'CA', ['UB7.5', 'UB7.14'], 'live thinking UB7.5 (after UB8.1); the Haiku 5.5 rows UB7.14'),
 (r'^packages/shared/src/agent/__tests__/claude-event-adapter-tasks\.test\.ts$', 'B', 'CA (hunks)', ['UB9.2', 'UB9.8'], None),
 (r'^packages/shared/src/agent/__tests__/claude-event-adapter\.test\.ts$', 'B', 'CA (hunks)', ['UB9.3', 'UB8.1'], 'heartbeat carried UB9.3 (UA12.39); detached-tool cases UB8.1'),
 (r'^packages/shared/src/agent/__tests__/claude-background-message-routing\.test\.ts$', 'B', 'PTR', ['UB9.2'], 'UA12.18'),
 (r'^packages/shared/src/agent/__tests__/prompt-builder-context-split\.test\.ts$', 'L', 'CV', ['UB7.17'], 'clock freeze'),
 (r'^packages/shared/src/agent/__tests__/session-self-management-bindings\.test\.ts$', 'N', 'CA', ['UB7.10', 'UB7.11'], None),
 (r'^packages/shared/src/agent/session-self-management-bindings\.ts$|^packages/shared/src/agent/session-scoped-tool-callback-registry\.ts$', 'N', 'CA', ['UB6.11', 'UB7.10', 'UB7.11'], 'decide binding UB6.11 (retarget); source prompt/template features UB7.10/UB7.11'),
 (r'^packages/shared/src/agent/index\.ts$', 'N', 'CA (hunk)', ['UB1.16'], 'the redaction exports'),
 (r'^packages/shared/src/agent/options\.ts$', 'L', 'HAVE', ['UB8.1'], 'getTextCompletionOptions stronger in ours; the permissionMode pin re-checked with the lift'),
 (r'^packages/shared/src/agent/pdf-inline\.ts$|^packages/shared/src/agent/__tests__/pdf-inline\.test\.ts$', 'N', 'CA', ['UB2.11'], None),
 (r'^packages/shared/src/agent/mode-types\.ts$', 'K', 'D(c)', ['UB7.8'], 'Guarded enum value; OQ-43.4 (a)'),
 (r'^packages/shared/src/agent/core/(guarded-mode\.ts|__tests__/guarded-mode\.test\.ts)$|^packages/server-core/src/decisions/guarded-mode\.ts$', 'K', 'D(c)', ['UB7.8'], 'Guarded dropped (OQ-43.4 (a)); the fail-closed fix is HAVE in our auto (B1-06); never port v0.14.0\'s fail-open'),
 (r'^packages/shared/src/agent/core/prerequisite-manager\.ts$|^packages/shared/src/agent/core/__tests__/prerequisite-manager\.isolated\.ts$', 'N', 'CA', ['UB7.12'], 'guides read with cat'),
 (r'^packages/shared/src/agent/core/source-manager\.ts$|^packages/shared/src/agent/core/__tests__/source-manager\.test\.ts$|^packages/shared/src/agent/core/types\.ts$', 'N', 'CA', ['UB7.10', 'UB7.11'], 'source prompts/templates/pagination features'),
 (r'^packages/shared/src/agent/browser-tool-redaction\.ts$|^packages/shared/src/agent/__tests__/browser-tool-redaction\.test\.ts$', 'N', 'CA', ['UB1.16'], None),
 (r'^packages/shared/src/agent/browser-tool-runtime\.ts$', 'N', 'CA (hunks)', ['UB1.16'] + BROWSER_SET, 'password markers/redaction UB1.16; hidden-window input and quieter output UB4.15-UB4.21'),
 (r'^packages/shared/src/agent/browser-tools\.ts$|^packages/shared/src/agent/__tests__/browser-tools\.test\.ts$', 'N', 'CA/CV', BROWSER_SET, None),
 # ---- C. Sources, auth and connections
 (r'^packages/shared/src/sources/credential-manager\.ts$|^packages/shared/src/sources/__tests__/credential-manager-refresh-dedupe\.test\.ts$', 'N', 'CA', ['UB1.13', 'UB3.1'], 'refresh single flight UB1.13 (CRITICAL); the api-auth hunks UB3.1 (retarget)'),
 (r'^packages/session-tools-core/src/api-auth\.ts$|^packages/session-tools-core/src/api-auth\.test\.ts$', 'N', 'CA', ['UB3.1'], 'API keys sent as entered'),
 (r'^apps/electron/resources/docs/sources\.md$', 'N', 'RW', ['UB3.1', 'UB3.3', 'UB7.10', 'UB7.11'], None),
 (r'^packages/shared/src/auth/oauth-flow-store\.ts$|^packages/shared/src/auth/__tests__/oauth-flow-store\.test\.ts$', 'N', 'CA', ['UB3.3', 'UB3.10'], 'RFC 8707 retarget UB3.3; the single-flight store UB3.10'),
 (r'^packages/server-core/src/handlers/oauth-flow-store-interface\.ts$', 'N', 'CA', ['UB3.10'], None),
 (r'^packages/server-core/src/handlers/rpc/oauth\.ts$|^packages/server-core/src/handlers/rpc/oauth\.test\.ts$', 'N', 'CA', ['UB3.10'], None),
 (r'^packages/server-core/src/domain/connection-setup-logic\.ts$', 'C', 'CA (hunks)', ['UB3.4'], 'the Cloudflare rows D(a) (B2-11); the rest UB3.4 (retarget)'),
 (r'^packages/shared/src/config/llm-connections\.ts$|^packages/shared/src/config/__tests__/llm-connections\.test\.ts$', 'C', 'CA (hunks)', ['UB3.6', 'UB3.7', 'UB7.15', 'UB8.2'], 'preferredRank UB3.6 and deepseek rename UB3.7 (retargets); PI_PREFERRED_* + whole-token keywords UB7.15; the Cloudflare rows D(a) (B2-11); Pi 1.1.0 provider ids UB8.2'),
 (r'^packages/shared/src/config/models\.ts$|^packages/shared/tests/models\.test\.ts$', 'L', 'CA', ['UB7.14'], 'Haiku 5.5'),
 (r'^packages/shared/src/config/models-pi\.ts$|^packages/shared/tests/models-pi\.test\.ts$', 'L', 'CA', ['UB8.2'], 'the Cloudflare rows D(a) (B2-11)'),
 (r'^packages/shared/src/config/pi-provider-ids\.ts$', 'L', 'CA', ['UB8.2'], None),
 (r'^packages/shared/src/config/cloudflare-gateway\.ts$', 'L', 'D(a)', [], 'B2-11: a third-party gateway receiving session content (controller 2026-10-14)'),
 (r'^packages/shared/src/config/llm-validation\.ts$|^packages/shared/src/validation/url-validator\.ts$|^packages/shared/src/agent/__tests__/text-completion-options\.test\.ts$', 'L', 'HAVE', ['UB8.1'], 'stronger in ours'),
 (r'^packages/shared/src/config/theme\.ts$|^packages/shared/src/config/theme-roles\.ts$|^packages/shared/src/config/__tests__/theme-roles\.test\.ts$', 'L', 'CA', ['UB13.3', 'UB13.4'], 'solved themes and theme roles (non-renderer half)'),
 (r'^packages/shared/src/config/validators\.ts$', 'L', 'CA (hunks)', ['UB4.12', 'UB13.3'], 'the label valueType hunk UB4.12; the theme warning hunk UB13.3'),
 (r'^packages/shared/src/mcp/client\.ts$|^packages/shared/src/mcp/mcp-pool\.ts$', 'N', 'CA', ['UB3.9', 'UB7.10', 'UB7.11'], '_intent UB3.9; prompts/templates/pagination UB7.10/UB7.11'),
 (r'^packages/shared/src/mcp/api-source-pool-client\.ts$|^packages/shared/src/mcp/__tests__/api-source-intent\.test\.ts$', 'K', 'CA', ['UB3.9'], None),
 (r'^packages/shared/src/mcp/__tests__/mcp-pool-resources\.test\.ts$|^packages/shared/src/mcp/__tests__/fixtures/mcp-server-resources\.mjs$', 'N', 'CA', ['UB7.10'], 'resources test data'),
 (r'^packages/shared/src/pages/', 'L', 'D(b)', [], 'Claude-artifact publishing sends page content to claude.ai (decided 2026-10-14)'),
 (r'^packages/core/src/types/page\.ts$|^packages/core/src/types/index\.ts$', 'L', 'D(b)', [], 'PageClaudeArtifactInfo export; the pages D(b) decision'),
 # ---- D. Prompt, projects, protocol, labels, tasks
 (r'^packages/shared/src/prompts/system\.ts$|^packages/shared/src/prompts/__tests__/system\.test\.ts$', 'N', 'CA (hunks)', ['UB4.1', 'UB1.12', 'UB7.10', 'UB7.11'], 'date line UB4.1 (retarget); the memory lines UB1.12; the MCP paragraph UB7.10/UB7.11'),
 (r'^packages/shared/src/projects/', 'N', 'CA', ['UB1.12'], 'appendProjectMemoryEntry, 30/70 load'),
 (r'^packages/shared/src/protocol/channels\.ts$|^packages/shared/src/protocol/routing\.ts$', 'K', 'CA', ['UB6.3', 'UB6.4'], 'decisions:getUsage'),
 (r'^packages/shared/src/protocol/dto\.ts$', 'N', 'CA, split', ['UB3.4', 'UB6.6', 'UB9.2', 'UB9.8', 'UB1.16'], 'connectionSlug UB3.4; TaskVerdictDto UB6.6; background DTOs UB9.8; tool_result.toolInput UB1.16'),
 (r'^packages/shared/src/protocol/events\.ts$', 'L', 'CA', ['UB13.3', 'UB13.4', 'UB9.8'], 'motion UB13.3/UB13.4; task_activity UB9.8'),
 (r'^packages/shared/src/protocol/message-limits\.ts$|^packages/shared/src/protocol/__tests__/message-limits\.test\.ts$|^packages/shared/src/protocol/types\.ts$|^packages/shared/src/protocol/index\.ts$', 'N', 'CA', ['UB4.14'], 'attachment size checks'),
 (r'^packages/shared/src/labels/chips\.ts$|^packages/shared/src/labels/__tests__/chips\.test\.ts$', 'L', 'CV', ['UB4.13'], None),
 (r'^packages/shared/src/labels/', 'L', 'CA', ['UB4.12', 'UB6.8'], 'canonical values/types/index and auto evaluator/validation UB4.12; the semantic-rules config test and the evaluator retarget-check UB6.8'),
 (r'^packages/shared/src/tasks/generator-prompt\.ts$|^packages/shared/src/tasks/schema\.test\.ts$', 'N', 'CA', ['UB1.14', 'UB2.9'], 'the depends_on promise UB1.14; the Generate reliability lines UB2.9'),
 (r'^packages/shared/src/tasks/storage\.ts$', 'N', 'CA (hunks)', ['UB6.6', 'UB1.14'], 'verdict via/confidence UB6.6; nodeOutputPath UB1.14'),
 (r'^packages/shared/src/utils/large-response\.ts$|^packages/shared/src/utils/__tests__/large-result-(filter|summary-gate)\.test\.ts$', 'K', 'CA', ['UB5.6', 'UB6.16'], 'the relevance filter UB6.16; UB5.6 measures whether it pays'),
 (r'^packages/shared/src/i18n/locales/en\.json$', 'I', 'CA by owning rows', [], 'keys first, en+ru; the R7-14 ledger in the plan, section I'),
 (r'^packages/shared/src/i18n/locales/(de|es|hu|ja|pl|zh-Hans)\.json$', 'I', 'D(c)', [], 'en+ru only (H15)'),
 # ---- E. Decision layer
 (r'^packages/shared/src/decisions/records\.ts$', 'K', 'CA (hunks)', ['UB6.1', 'UB6.3', 'UB6.4'], 'the record shape UB6.1 (retarget); usage/cold columns UB6.3/UB6.4'),
 (r'^packages/shared/src/decisions/usage\.ts$|^packages/shared/src/decisions/usage\.test\.ts$', 'K', 'CA', ['UB6.3', 'UB6.4'], '7-day usage'),
 (r'^packages/server-core/src/decisions/adaptive-thinking\.ts$|^packages/server-core/src/decisions/adaptive-thinking\.test\.ts$|^packages/server-core/src/decisions/__fixtures__/adaptive-thinking\.cases\.ts$', 'K', 'D(c)', [], 'adaptive thinking dropped (DEC-10); B1-04 records what a reopen ports'),
 (r'^packages/server-core/src/decisions/large-results\.ts$|^packages/server-core/src/decisions/large-results\.test\.ts$|^packages/server-core/src/decisions/relevance\.ts$|^packages/server-core/src/decisions/relevance\.test\.ts$|^packages/server-core/src/decisions/__fixtures__/large-results\.cases\.ts$', 'K', 'CA', ['UB5.6', 'UB6.16'], None),
 (r'^packages/server-core/src/decisions/decision-point\.ts$|^packages/server-core/src/decisions/decision-point\.test\.ts$|^packages/server-core/src/decisions/decision-outcomes\.test\.ts$', 'K', 'CA', ['UB6.3'], 'cold-start deadline 2.8 s after 30 s idle'),
 (r'^packages/server-core/src/decisions/semantic-labels\.ts$|^packages/server-core/src/decisions/semantic-labels\.test\.ts$', 'L', 'CA (hunks)', ['UB6.8', 'UB4.12'], 'the semantic evaluator UB6.8 (retarget); the canonical-label shapes UB4.12'),
 (r'^packages/server-core/src/handlers/rpc/decisions\.ts$', 'K', 'CA', ['UB6.3', 'UB6.4'], 'decisions:getUsage'),
 (r'^packages/server-core/src/handlers/rpc/pages\.ts$', 'L', 'D(b)', [], 'the publish endpoint of the dropped feature'),
 (r'^packages/server-core/src/handlers/rpc/sessions\.ts$', 'N', 'CA (hunks)', ['UB9.8'], 'background channels; the mode-validation KEEP (F1.800) re-checked'),
 (r'^packages/server-core/src/handlers/rpc/tasks\.ts$', 'N', 'CA (hunks)', ['UB6.6', 'UB1.14', 'UB2.9'], None),
 (r'^packages/server-core/src/handlers/rpc/tasks-generate-wait\.test\.ts$', 'N', 'CA', ['UB2.9'], None),
 (r'^packages/server-core/src/handlers/rpc/workspace\.ts$', 'L', 'CA', ['UB13.3', 'UB13.4'], 'motion preference on the wire'),
 (r'^packages/server-core/src/tasks/TaskRunner\.ts$|^packages/server-core/src/tasks/TaskRunner\.test\.ts$', 'N', 'CA (hunks)', ['UB1.14', 'UB2.8', 'UB6.6'], 'upstreamReplies + the 40k cap UB1.14 (CRITICAL); stopped step waits / empty reply fails UB2.8; the verdict cases UB6.6 (retarget)'),
 (r'^packages/server-core/src/transport/client\.ts$|^packages/server-core/src/transport/server\.ts$|^packages/server-core/src/transport/__tests__/server-lifecycle\.test\.ts$', 'N', 'CA', ['UB4.14'], 'maxPayload / handshake maxMessageBytes'),
 (r'^packages/server-core/src/runtime/inherited-app-env\.ts$|^packages/server-core/src/runtime/inherited-app-env\.test\.ts$|^packages/server-core/src/runtime/platform-headless\.ts$', 'L', 'CA', ['UB7.13'], 'foreign app root'),
 # ---- N/B. Sessions (specific files before the SessionManager catch-all)
 (r'^packages/server-core/src/sessions/browser-password-redaction\.test\.ts$', 'N', 'CA', ['UB1.16'], None),
 (r'^packages/server-core/src/sessions/automation-loop-and-retry\.test\.ts$', 'K', 'CA (hunks)', ['UB4.8', 'UB6.3', 'UB6.14', 'UB6.16'], 'auth retry / turnSuggestionHint / large-result follow-ups'),
 (r'^packages/server-core/src/sessions/background-task-output\.ts$|^packages/server-core/src/sessions/background-task-output\.test\.ts$|^packages/server-core/src/sessions/background-task-stop\.test\.ts$', 'L', 'CA', ['UB9.8'], None),
 (r'^packages/server-core/src/sessions/background-task-surface\.test\.ts$', 'N', 'N/A (read)', ['UB9.2'], 'the wake nudge (labelSystemNotice) is not adopted, B4-23; the retarget-check UB9.2'),
 (r'^packages/server-core/src/sessions/pi-retry-streaming\.test\.ts$', 'N', 'CA (harness)', ['UB2.9'], 'sessionActivityListeners in the harness'),
 (r'^packages/server-core/src/sessions/session-completion\.test\.ts$', 'N', 'CA', ['UB1.14', 'UB2.8'], None),
 (r'^packages/server-core/src/sessions/RemoteBrowserPaneManager\.ts$|^packages/server-core/src/runtime/null-browser-pane-manager\.ts$|^packages/server-core/src/handlers/browser-pane-manager-interface\.ts$', 'N', 'CA/CV', BROWSER_SET, 'BPM interface/null/remote managers'),
 (r'^packages/server-core/src/sessions/auth-request-fanout\.test\.ts$', 'N', 'CA', ['UB3.10'], None),
 (r'^packages/server-core/src/handlers/session-manager-interface\.ts$', 'L', 'CA (hunks)', ['UB9.8'], None),
 (r'^packages/server-core/src/sources/mcp-source-tool-callbacks\.ts$|^packages/server-core/src/sources/mcp-source-tool-callbacks\.test\.ts$', 'N', 'CA', ['UB7.10', 'UB7.11'], None),
 (r'^packages/server-core/src/webui/http-server\.ts$', 'N', 'CA (hunks)', ['UB3.10', 'UB14.47'], 'the oauth join UB3.10; the getWindowVibrancy stub UB14.47; the rest of webui N/A (dormant)'),
 (r'^packages/server-core/src/webui/__tests__/oauth-callback\.test\.ts$', 'N', 'CA', ['UB3.10'], None),
 (r'^packages/server-core/src/sessions/SessionManager\.ts$', 'B', 'CA (hunks)', ['UB1.2', 'UB1.3', 'UB1.12', 'UB1.16', 'UB2.3', 'UB2.4', 'UB2.8', 'UB2.9', 'UB3.1', 'UB3.10', 'UB6.3', 'UB6.6', 'UB6.7', 'UB6.8', 'UB6.12', 'UB6.13', 'UB6.14', 'UB6.15', 'UB6.16', 'UB9.5'], 'appendProjectMemoryFn UB1.12; the tool_result redaction hunk UB1.16; stopEpoch/fromUser UB2.8; onSessionActivity UB2.9; serializeHeaderCredential UB3.1; completeAuthRequestsForSource UB3.10; startPreTurnDecisions auth retry UB6.14, one-check-per-message UB6.3, large-result follow-ups UB6.16; the retarget-checks UB1.2, UB1.3, UB2.3, UB2.4, UB6.6-UB6.8, UB6.12-UB6.15, UB9.5'),
 # ---- N. session-tools-core
 (r'^packages/session-tools-core/src/handlers/project-memory\.ts$|^packages/session-tools-core/src/handlers/project-memory\.test\.ts$', 'N', 'CA', ['UB1.12'], None),
 (r'^packages/session-tools-core/src/handlers/mcp-sources\.ts$|^packages/session-tools-core/src/handlers/mcp-sources\.test\.ts$', 'N', 'CA', ['UB7.10', 'UB7.11'], None),
 (r'^packages/session-tools-core/src/handlers/source-oauth\.ts$|^packages/session-tools-core/src/handlers/source-oauth\.test\.ts$', 'N', 'CA', ['UB3.11'], 'Google refresh first (Slack/Microsoft N/A)'),
 (r'^packages/session-tools-core/src/handlers/index\.ts$', 'N', 'CA', ['UB1.12', 'UB3.11', 'UB7.10', 'UB7.11'], 'registers the new handlers'),
 (r'^packages/session-tools-core/src/context\.ts$', 'N', 'CA (hunks)', ['UB6.11', 'UB7.10', 'UB7.11'], 'the decide callback types UB6.11 (retarget); source prompts/templates context UB7.10/UB7.11'),
 (r'^packages/session-tools-core/src/tool-defs\.ts$', 'N', 'CA (hunks)', ['UB6.11', 'UB9.2', 'UB1.12', 'UB7.10', 'UB7.11'], 'DecideSchema UB6.11; list_background_tasks UB9.2; project_memory_append UB1.12; source prompt tools UB7.10/UB7.11'),
 (r'^packages/session-tools-core/src/tool-defs-filtering\.test\.ts$', 'N', 'CA', ['UB6.11', 'UB1.12', 'UB7.11'], None),
 (r'^packages/session-tools-core/src/index\.ts$', 'N', 'CA', ['UB7.10', 'UB7.11'], None),
 # ---- L. pi-agent-server
 (r'^packages/pi-agent-server/src/agent-dir\.ts$|^packages/pi-agent-server/src/agent-dir\.test\.ts$', 'L', 'CA', ['UB1.19'], 'per-process agent dir (isolation guard)'),
 (r'^packages/pi-agent-server/src/session-settings\.ts$|^packages/pi-agent-server/src/session-settings\.test\.ts$', 'L', 'CA', ['UB1.19', 'UB7.16'], 'the isolation knobs UB1.19; the cacheWarming pin UB7.16'),
 (r'^packages/pi-agent-server/src/system-prompt-override\.ts$|^packages/pi-agent-server/src/system-prompt-override\.test\.ts$', 'L', 'CA', ['UB1.19'], 'the real-loader test (trusted-project positive control)'),
 (r'^packages/pi-agent-server/src/index\.ts$', 'B', 'CA (hunks)', ['UB2.3', 'UB4.9', 'UB6.16', 'UB8.2', 'UB3.9'], 'compaction UB2.3; utility-model fallback UB4.9; large-result gate UB6.16; proxyToolResult isError + provider ids UB8.2; toolCallId UB3.9'),
 (r'^packages/pi-agent-server/src/large-result-gate\.ts$|^packages/pi-agent-server/src/large-result-gate\.test\.ts$', 'K', 'CA', ['UB5.6', 'UB6.16'], None),
 (r'^packages/pi-agent-server/src/model-resolution\.ts$|^packages/pi-agent-server/src/model-resolution\.test\.ts$', 'L', 'CA', ['UB8.2'], None),
 (r'^packages/pi-agent-server/src/pick-mini-model\.ts$|^packages/pi-agent-server/src/pick-mini-model\.test\.ts$', 'L', 'CA', ['UB7.15', 'UB8.2'], None),
 (r'^packages/pi-agent-server/src/provider-endpoint-env\.ts$|^packages/pi-agent-server/src/provider-endpoint-env\.test\.ts$', 'L', 'CA', ['UB3.12'], 'Azure arm only'),
 (r'^packages/pi-agent-server/src/tools/search/create-search-tool\.ts$|^packages/pi-agent-server/src/tools/search/create-search-tool\.test\.ts$|^packages/pi-agent-server/src/tools/web-fetch\.ts$', 'L', 'HAVE -> CA', ['UB8.2'], 'the throw coupling HAVE; the rest with the Pi 1.1.0 lift'),
 # ---- F/N. Electron main and transport
 (r'^apps/electron/src/main/browser-cdp\.ts$|^apps/electron/src/main/__tests__/browser-cdp\.test\.ts$', 'N', 'CA/CV', BROWSER_SET, None),
 (r'^apps/electron/src/main/browser-pane-manager\.ts$|^apps/electron/src/main/__tests__/browser-pane-manager\.test\.ts$', 'N', 'CA (hunks)', ['UB4.6'] + BROWSER_SET, 'teardown guard UB4.6 (retarget); the browser set UB4.15-UB4.21'),
 (r'^apps/electron/src/main/security-challenge\.ts$|^apps/electron/src/main/__tests__/security-challenge\.test\.ts$', 'N', 'CV', ['UB4.17'], None),
 (r'^apps/electron/src/main/window-manager\.ts$|^apps/electron/src/preload/bootstrap\.ts$', 'M', 'CV', ['UB14.47'], 'opaque window for old Windows'),
 (r'^apps/electron/src/transport/channel-map\.ts$', 'K', 'CA', ['UB6.3', 'UB6.4'], 'decisions:getUsage'),
 (r'^apps/electron/src/transport/__tests__/channel-map-parity\.test\.ts$', 'M', 'CV', ['UB14.47'], None),
 (r'^apps/electron/src/transport/source-oauth\.ts$|^apps/electron/src/transport/__tests__/source-oauth\.test\.ts$', 'N', 'CA', ['UB3.10'], None),
 (r'^apps/electron/src/shared/types\.ts$|^apps/electron/src/shared/__tests__/ipc-channels\.test\.ts$', 'K', 'CA', ['UB6.3', 'UB6.4'], None),
 # ---- M. Redesign foundations (packages/ui, renderer css)
 (r'^packages/ui/src/styles/(tokens|base)\.css$', 'M', 'CV', ['UB13.2'], 'inert additions'),
 (r'^packages/ui/src/styles/index\.css$', 'M', 'CA', ['UB13.3'], None),
 (r'^packages/ui/src/motion/', 'M', 'CV', ['UB13.5'], None),
 (r'^packages/ui/package\.json$', 'M', 'CA', ['UB13.5'], 'the motion exports'),
 (r'^packages/ui/eslint-rules/|^packages/ui/eslint\.config\.mjs$|^apps/electron/eslint\.config\.mjs$', 'M', 'CA', ['UB13.14'], 'the design guardrails'),
 (r'^packages/ui/src/lib/utils\.ts$|^packages/ui/src/lib/__tests__/utils\.test\.ts$', 'M', 'CV', ['UB13.7'], None),
 (r'^packages/ui/src/lib/layout\.ts$', 'M', 'CA', ['UB13.18'], None),
 (r'^packages/ui/src/index\.ts$', 'M', 'CA', ['UB13.9'], 'the barrel exports'),
 (r'^packages/ui/src/components/annotations/annotation-style-tokens\.ts$', 'M', 'CV', ['UB13.3'], None),
 (r'^packages/ui/src/components/tooltip\.tsx$|^packages/ui/src/components/ui/(drawer|StyledDropdown|SimpleDropdown|AnimatedCollapsibleContent|BrowserControls|BrowserShader|index)\.tsx?$', 'M', 'CV/CA', ['UB13.9'], None),
 (r'^packages/ui/src/components/chat/turn-utils\.ts$|^packages/ui/src/components/chat/__tests__/turn-utils-grouping\.test\.ts$', 'L', 'CA', ['UB7.19'], 'subagent grouping (functional)'),
 (r'^packages/ui/src/components/chat/turn/tool-display\.ts$', 'N', 'CA', ['UB1.12', 'UB7.11'], 'display names for the tools that land'),
 (r'^packages/ui/src/components/chat/TurnCard\.tsx$', 'M', 'CA (hunks)', ['UB6.11', 'UB14.8', 'UB14.12'], 'the decide overlay UB6.11 (retarget); the TurnCard shell UB14.12'),
 (r'^packages/ui/src/components/chat/(turn/|TurnCardActionsMenu|AcceptPlanDropdown|CompactAcceptPlanDrawer|InlineExecution|UserMessageBubble|SystemMessage|SessionViewer)', 'M', 'CV/CA', ['UB14.8', 'UB14.11', 'UB14.12', 'UB14.13'], 'transcript primitives UB14.8; work log UB14.11; TurnCard shell UB14.12; user bubble/system/session viewer UB14.13'),
 (r'^packages/ui/src/components/markdown/', 'M', 'CV/CA', ['UB14.9', 'UB14.10'], 'wells and markdown typography UB14.9; PreviewBlockChrome UB14.10'),
 (r'^packages/ui/src/components/overlay/', 'M', 'CV/CA', ['UB14.45'], None),
 (r'^apps/viewer/src/(main|App)\.tsx$', 'M', 'CV', ['UB13.5'], 'the motion provider wiring'),
 (r'^apps/viewer/src/index\.css$', 'M', 'CA', ['UB13.3'], None),
 # ---- M. Renderer shell, header, lists
 (r'^apps/electron/src/renderer/index\.css$|^apps/electron/src/renderer/index\.html$|^apps/electron/src/renderer/playground\.html$', 'M', 'CA', ['UB13.3'], 'the pre-paint script and the --*-rgb sweep'),
 (r'^apps/electron/src/renderer/App\.tsx$', 'M', 'CA (hunks)', ['UB9.2', 'UB14.4'], 'background-task chip fan-out carried UB9.2 (UA12.18); the shell wiring UB14.4 (theme.json overrides UB14.50 read the same file)'),
 (r'^apps/electron/src/renderer/context/AppShellContext\.tsx$', 'M', 'CA', ['UB14.4'], None),
 (r'^apps/electron/src/renderer/context/ThemeContext\.tsx$|^apps/electron/src/renderer/hooks/useTheme\.ts$', 'M', 'CA', ['UB13.3', 'UB13.4', 'UB15.9', 'UB14.50'], 'solved themes UB13.3; the ThemeContext + motion preference UB13.4; the Appearance page UB15.9; theme.json overrides UB14.50'),
 (r'^apps/electron/src/renderer/contexts/NavigationContext\.tsx$', 'M', 'KEEP', [], 'HAVE (UA12.179); R1 amendment'),
 (r'^apps/electron/src/renderer/atoms/label-value-edit\.ts$', 'M', 'CA', ['UB14.6'], None),
 (r'^apps/electron/src/renderer/atoms/sessions\.ts$', 'M', 'CA', ['UB14.46'], None),
 (r'^apps/electron/src/renderer/event-processor/handlers/tool\.ts$|^apps/electron/src/renderer/event-processor/handlers/__tests__/tool-result-input\.test\.ts$|^apps/electron/src/renderer/event-processor/types\.ts$', 'N', 'CA', ['UB1.16'], 'the placeholder rendering of toolInput'),
 (r'^apps/electron/src/renderer/event-processor/processor\.ts$', 'N', 'CA (hunk)', ['UB9.8', 'UB14.7'], 'task_activity passes through'),
 (r'^apps/electron/src/renderer/hooks/useBackgroundTasks\.ts$', 'M', 'CA', ['UB14.7'], None),
 (r'^apps/electron/src/renderer/hooks/useContainerWidth\.ts$', 'M', 'CA', ['UB4.23'], None),
 (r'^apps/electron/src/renderer/hooks/(useDelayedLoading|useDynamicStack|useListReorderFlip|useResizeGradient)\.ts$', 'M', 'CV/CA', ['UB14.46'], None),
 # useAutomations.ts did NOT change after v0.14.0 (not in the tag diff); UB4.27's webhook
 # fields and UB4.8/UB6.9's skipped history read it at execution without a map rule.
 (r'^apps/electron/src/renderer/lib/run-command-message\.ts$|^apps/electron/src/renderer/lib/__tests__/run-command-message\.test\.ts$', 'M', 'CA', ['UB14.16'], None),
 (r'^apps/electron/src/renderer/lib/utils\.ts$', 'M', 'CV', ['UB13.7'], None),
 (r'^apps/electron/src/renderer/lib/provider-icons\.ts$', 'M', 'CA', ['UB14.46'], None),
 (r'^apps/electron/src/renderer/playground/', 'M', 'CA', ['UB13.15'], 'the shell and registries; registry/{primitives,toasts}.tsx are UB13.19\'s CV half'),
 (r'^apps/electron/src/renderer/components/settings/ThemeGrid\.tsx$', 'M', 'CV', ['UB15.9'], None),
 (r'^apps/electron/src/renderer/components/app-shell/(PanelStackContainer|PanelSlot)\.tsx$|^apps/electron/src/renderer/components/app-shell/panel-constants\.ts$', 'M', 'CV', ['UB14.2'], None),
 (r'^apps/electron/src/renderer/components/app-shell/(SessionItem|SessionBadges|SessionList|SessionMenu|CompactSessionMenu|CompactSessionListFilter|SessionInfoPopover|fit-labels)\.ts$|^apps/electron/src/renderer/components/app-shell/(SessionItem|SessionBadges|SessionList|SessionMenu|CompactSessionMenu|CompactSessionListFilter|SessionInfoPopover)\.tsx$|^apps/electron/src/renderer/components/app-shell/__tests__/fit-labels\.test\.ts$', 'M', 'CA', ['UB14.3'], None),
 (r'^apps/electron/src/renderer/components/app-shell/SessionProjectColorWrapper\.tsx$', 'M', 'CA', ['UB14.3', 'UB4.24'], 'the row restyle UB14.3; the project colour stripe under sticky headers UB4.24'),
 (r'^apps/electron/src/renderer/components/app-shell/PanelHeader\.tsx$', 'M', 'CA', ['UB14.6'], 'the panel header rides the chat-header group'),
 (r'^apps/electron/src/renderer/components/app-shell/(LeftSidebar|TopBar|SidebarPane|ShellResizeHandle|DetailEmptyState|FabNewChat|CompactPanelTransition|SessionMenuParts|SessionSearchHeader|ProjectMultiSelectFilter|SessionStatusIcon)\.tsx$|^apps/electron/src/renderer/components/app-shell/AppShell\.tsx$', 'M', 'CV/CA', ['UB14.4', 'UB4.11', 'UB7.4'], 'the shell split UB14.4; one-line titles UB4.11; the rtk half of AppShell UB7.4 (retarget)'),
 (r'^apps/electron/src/renderer/components/app-shell/SourcesListPanel\.tsx$|^apps/electron/src/renderer/components/app-shell/(SkillsListPanel|ProjectsListPanel)\.tsx$', 'M', 'CA', ['UB14.57'], None),
 (r'^apps/electron/src/renderer/components/ui/entity-panel\.tsx$', 'M', 'CA', ['UB14.57'], None),
 (r'^apps/electron/src/renderer/components/app-shell/ActiveOptionBadges\.tsx$', 'M', 'CA', ['UB14.55'], 'R1 amendment wins over the UB14.6 group line'),
 (r'^apps/electron/src/renderer/components/app-shell/(AttachmentPreview|BackgroundFinishedChip)\.tsx$', 'M', 'CA', ['UB14.27'], None),
 (r'^apps/electron/src/renderer/components/app-shell/MainContentPanel\.tsx$', 'M', 'CA', ['UB4.26', 'UB14.56'], None),
 (r'^apps/electron/src/renderer/components/app-shell/chat-display/(ProcessingIndicator|ScrollOnMount|TurnFrame)\.tsx$', 'M', 'CV/CA', ['UB14.15'], None),
 (r'^apps/electron/src/renderer/components/app-shell/ChatDisplay\.tsx$|^apps/electron/src/renderer/components/app-shell/chat-display/', 'M', 'CA', ['UB14.14', 'UB14.15', 'UB14.16', 'UB7.18'], 'extracted messages UB14.14; the ChatDisplay split UB14.15; run-in-background text UB14.16; new-chat suggestions UB7.18'),
 (r'^apps/electron/src/renderer/components/app-shell/(WorkspaceTargetList|SendToWorkspaceDialog|SendResourceToWorkspaceDialog|WorkspaceSwitcher|CompactWorkspaceSwitcher)\.tsx$', 'M', 'CA', ['UB14.61'], None),
 (r'^apps/electron/src/renderer/components/app-shell/chat-header/', 'M', 'CA', ['UB14.6'], 'ChatShareMenu carries no Craft URL (the rebrand rule; the sharing link is rewritten)'),
 (r'^apps/electron/src/renderer/components/app-shell/SessionFilterMenu\.tsx$', 'M', 'CA', ['UB14.5'], None),
 (r'^apps/electron/src/renderer/components/app-shell/(ActiveTasksBar|BackgroundTaskChip|TaskActionMenu)\.tsx$|^apps/electron/src/renderer/components/app-shell/background-task-chip-state\.ts$', 'M', 'CA', ['UB14.7'], 'TaskActionMenu is deleted upstream'),
 (r'^apps/electron/src/renderer/components/app-shell/kanban/(board-collision\.ts|KanbanBoard\.tsx|KanbanColumn\.tsx|BoardListToggle\.tsx)$|^apps/electron/src/renderer/components/app-shell/kanban/__tests__/board-collision\.test\.ts$', 'M', 'CV/CA', ['UB14.52', 'UB4.22'], None),
 (r'^apps/electron/src/renderer/components/app-shell/kanban/', 'M', 'CA', ['UB14.60', 'UB6.6', 'UB2.9'], 'tiles, chips, editor, container UB14.60; the inferred-verdict line and node pills UB6.6; the Generate timeout display UB2.9; NewTaskComposer rides UB14.52/UB14.60'),
 (r'^apps/electron/src/renderer/components/projects/CreateProjectDialog\.tsx$|^apps/electron/src/renderer/components/ResetConfirmationDialog\.tsx$', 'M', 'CV/CA', ['UB14.36'], None),
 (r'^apps/electron/src/renderer/components/RtkUpdateDialog\.tsx$', 'F', 'CA (hunks)', ['UB7.4'], 'the v0.15.1 dialog classes (R6-14); no installer (OQ-43.8 (b))'),
 (r'^apps/electron/src/renderer/components/KeyboardShortcutsDialog\.tsx$', 'M', 'N/A', [], 'removed upstream (OQ-43.10 (a); P2.441)'),
 (r'^apps/electron/src/renderer/components/ServerDirectoryBrowser\.tsx$', 'M', 'CV/CA', ['UB14.46'], None),
 (r'^apps/electron/src/renderer/components/apisetup/ApiKeyInput\.tsx$', 'M', 'CA', ['UB14.38'], 'the Cloudflare rows D(a) (B2-11)'),
 (r'^apps/electron/src/renderer/components/app-menu/DesktopAppMenu\.tsx$', 'M', 'CV/CA', ['UB13.12'], None),
 (r'^apps/electron/src/renderer/components/chat/AuthRequestCard\.tsx$', 'N', 'CA (hunks)', ['UB1.15', 'UB3.10', 'UB14.26'], 'Cancel type=button UB1.15 (CRITICAL, landed in 1.42.0); the restart-sign-in arm UB3.10; the decision material UB14.26'),
 (r'^apps/electron/src/renderer/components/right-sidebar/SessionFilesSection\.tsx$', 'M', 'CA', ['UB14.59'], None),
 (r'^apps/electron/src/renderer/components/pages/', 'M', 'CA', ['UB14.53'], 'the Claude-artifact button D(b)'),
 (r'^apps/electron/src/renderer/components/automations/(AutomationEventTimeline\.tsx|types\.ts|utils\.ts)$|^apps/electron/src/renderer/components/automations/__tests__/types\.test\.ts$', 'L', 'CV/CA', ['UB14.49', 'UB4.8', 'UB6.9'], 'the timezone UB14.49; skipped history UB4.8/UB6.9 (retargets)'),
 (r'^apps/electron/src/renderer/components/automations/(AutomationInfoPage|BatchAutomationMenu)\.tsx$', 'M', 'CV/CA', ['UB14.43', 'UB13.12'], 'the info page UB14.43; the header menu UB13.12'),
 (r'^apps/electron/src/renderer/components/automations/', 'M', 'CA', ['UB14.44'], None),
 (r'^apps/electron/src/renderer/components/info/Info_HeaderMenu\.tsx$', 'M', 'CV', ['UB13.12'], None),
 (r'^apps/electron/src/renderer/components/info/(AutoRulesDataTable)\.tsx$', 'M', 'CV/CA', ['UB14.58', 'UB6.8'], None),
 (r'^apps/electron/src/renderer/components/info/(Labels|Tools|Permissions)DataTable\.tsx$', 'M', 'CV/CA', ['UB14.58'], None),
 (r'^apps/electron/src/renderer/components/info/', 'M', 'CV/CA', ['UB14.43'], None),
 (r'^apps/electron/src/renderer/components/messaging/|^apps/electron/src/renderer/pages/settings/MessagingSettingsPage\.tsx$', 'M', 'N/A', [], 'messaging removed upstream (OQ-43.10 (a); P2.441)'),
 (r'^apps/electron/src/renderer/components/onboarding/', 'M', 'CA', ['UB14.37'], 'ProviderMark HAVE (not added)'),
 (r'^apps/electron/src/renderer/components/settings/', 'M', 'CV/CA', ['UB15.1'], 'the settings primitives; the SettingsToggle usage-note hunk is UB6.5 (amended) and the rtk hunk UB7.4'),
 (r'^apps/electron/src/renderer/components/ui/(button|input|textarea|select|switch|tabs|kbd|avatar|hotkey-keycaps|skeleton)\.tsx$', 'M', 'CV/CA', ['UB13.10'], None),
 (r'^apps/electron/src/renderer/components/ui/(dialog|popover|dropdown-menu|context-menu|styled-context-menu|command|sonner|scroll-area|collapsible)\.tsx$', 'M', 'CV/CA', ['UB13.11'], None),
 (r'^apps/electron/src/renderer/components/ui/(HeaderIconButton|TopBarButton|HeaderMenu|metadata-badge|mention-badge|PanelHeaderCenterButton)\.tsx$', 'M', 'CV/CA', ['UB13.12'], 'PanelHeaderCenterButton rides the header-menu primitives'),
 (r'^apps/electron/src/renderer/components/ui/(inline-menu-styles|slash-command-menu|mention-menu|skill-mention-menu|rich-text-input)\.tsx?$', 'M', 'CA', ['UB14.21'], None),
 (r'^apps/electron/src/renderer/components/ui/(entity-list-label-badge|label-menu|label-value-popover|session-status-menu|EditPopover)\.tsx$', 'M', 'CA', ['UB14.35', 'UB6.8'], 'the label restyle UB14.35; the EditPopover semantic-rule prompt UB6.8 (retarget); the label-chip behaviour UB4.13'),
 (r'^apps/electron/src/renderer/components/ui/(rename-dialog|color-picker|inline-color-picker-row|CompactWorkingDirectorySelector)\.tsx$', 'M', 'CV/CA', ['UB14.36'], None),
 (r'^apps/electron/src/renderer/components/ui/(entity-row|entity-list|entity-list-empty|empty|source-avatar)\.tsx$', 'M', 'CA', ['UB13.13'], None),
 (r'^apps/electron/src/renderer/components/ui/workspace-avatar-color\.ts$|^apps/electron/src/renderer/components/ui/workspace-avatar\.tsx$|^apps/electron/src/renderer/components/ui/__tests__/workspace-avatar-color\.test\.ts$', 'M', 'CA', ['UB7.2'], 'R6-13/B3-23: the deterministic hue helper and its avatar'),
 (r'^apps/electron/src/renderer/components/ui/(source-connection-status\.ts|__tests__/source-connection-status\.test\.ts|source-status-indicator\.tsx)$', 'M', 'CA', ['UB14.48'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/composer-styles\.ts$|^apps/electron/src/renderer/components/app-shell/input/action-hotkey\.ts$|^apps/electron/src/renderer/components/app-shell/input/structured/(DecisionCard|decision-tone)\.ts', 'M', 'CV/CA', ['UB14.20'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/structured/(CredentialRequest|AdminApprovalRequest)\.tsx$', 'M', 'CA', ['UB14.23'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/(FreeFormInputContextBadge|ToolbarStatusSlot|InputErrorBoundary|ImageSupportWarningBanner)\.tsx$', 'M', 'CV/CA', ['UB14.22'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/InputContainer\.tsx$', 'M', 'CA', ['UB14.27'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/(SendButton|ContextUsageChip|FollowUpChips)\.tsx$', 'M', 'CA', ['UB14.28'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/(ComposerModeChip|CompactPermissionModeSelector)\.tsx$', 'M', 'CA', ['UB14.29'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/(ComposerModelMenu|CompactModelSelector)\.tsx$', 'M', 'CA', ['UB14.30'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/(ComposerSourcesChip|WorkingDirectorySelector)\.tsx$', 'M', 'CA', ['UB14.31'], None),
 (r'^apps/electron/src/renderer/components/app-shell/input/FreeFormInput\.tsx$', 'M', 'CA (hunks)', ['UB14.32', 'UB4.14', 'UB14.34'], 'the assembly UB14.32; the size-check hunk UB4.14; the paste-a-console-snippet offer UB14.34'),
 (r'^apps/electron/src/renderer/components/app-shell/input/(ChatInputZone|ComposerHintLine)\.tsx$', 'M', 'CA', ['UB14.33'], None),
 # ---- M. Renderer pages
 (r'^apps/electron/src/renderer/pages/ChatPage\.tsx$', 'M', 'CA', ['UB14.6'], None),
 (r'^apps/electron/src/renderer/pages/(ProjectInfoPage|SkillInfoPage|SourceInfoPage)\.tsx$', 'M', 'CA', ['UB14.59'], None),
 (r'^apps/electron/src/renderer/pages/ShortcutsPage\.tsx$|^apps/electron/src/renderer/pages/settings/ShortcutsPage\.tsx$', 'M', 'CA', ['UB15.4'], None),
 (r'^apps/electron/src/renderer/pages/settings/SettingsNavigator\.tsx$', 'M', 'CV', ['UB15.2'], None),
 (r'^apps/electron/src/renderer/pages/settings/(Input|Labels|Preferences|Server)SettingsPage\.tsx$|^apps/electron/src/renderer/pages/settings/PreferencesPage\.tsx$', 'M', 'CV/CA', ['UB15.3'], None),
 (r'^apps/electron/src/renderer/pages/settings/AppSettingsPage\.tsx$', 'M', 'CA', ['UB15.5', 'UB15.8'], 'the page merge UB15.5; the Nessy sections ride UB15.8'),
 (r'^apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage\.tsx$', 'M', 'CA', ['UB15.6'], None),
 (r'^apps/electron/src/renderer/pages/settings/PermissionsSettingsPage\.tsx$', 'M', 'CA', ['UB15.7'], None),
 (r'^apps/electron/src/renderer/pages/settings/AppearanceSettingsPage\.tsx$', 'M', 'CA', ['UB15.9'], None),
 (r'^apps/electron/src/renderer/pages/settings/ai-settings-loader\.ts$|^apps/electron/src/renderer/pages/settings/__tests__/ai-settings-loader\.test\.ts$', 'M', 'CA', ['UB15.10'], None),
 (r'^apps/electron/src/renderer/pages/settings/AiSettingsPage\.tsx$', 'M', 'CA (hunks)', ['UB6.5', 'UB7.4', 'UB15.11', 'UB6.16'], 'the decision card UB6.5; the rtk hunk UB7.4; the body restyle UB15.11; the usage note UB6.16 tooltip'),
 # ---- N/L/K. resources
 (r'^apps/electron/resources/docs/browser-tools\.md$', 'N', 'RW', ['UB4.20', 'UB1.16'], 'the quoting rule; the password line in our words'),
 (r'^apps/electron/resources/docs/(automations|labels)\.md$', 'L', 'RW', ['UB4.12', 'UB14.44', 'UB14.49', 'UB4.8', 'UB6.9'], 'the canonical-label paragraphs UB4.12; the automations restyle/timezone UB14.44/UB14.49; the skipped history UB4.8/UB6.9 (retargets)'),
 (r'^apps/electron/resources/docs/pages\.md$', 'L', 'RW', [], 'the publish paragraph D(b)'),
 (r'^apps/electron/resources/themes/paper\.json$', 'M', 'CV', ['UB13.17'], None),
 (r'^apps/electron/resources/themes/craft\.json$', 'M', 'D(a)', [], 'the Craft brand palette (the rebrand rule); our set re-solves with upstream\'s contrast solver (UB13.3)'),
 (r'^apps/electron/resources/themes/(default|solarized)\.json$', 'M', 'N/A', ['UB13.3'], 'retired files; the default values arrive via DEFAULT_THEME + tokens.css'),
 (r'^apps/electron/resources/release-notes/(0\.14\.1|0\.15\.0|0\.15\.1)\.md$', 'N', 'D(a)', [], "Craft's release notes; ours are written in UB11.3"),
 # ---- F. Packaging, versions, churn
 (r'^packages/(messaging-gateway|messaging-whatsapp-worker)/package\.json$', 'F', 'D(b)', [], 'messaging dropped (OQ-43.10 (a))'),
 (r'(^|/)package\.json$|^bun\.lock$', 'F', 'MEAS / N/A', ['UB8.1', 'UB8.2'], 'SDK 0.3.296 and Pi 1.1.0 via the Artifactory mirror only; the version fields N/A; apps/cli version churn'),
 (r'^packages/shared/CLAUDE\.md$', 'N', 'N/A', [], 'we keep AGENTS.md'),
 (r'^apps/webui/src/adapter/web-api\.ts$', 'M', 'CA', ['UB14.47'], 'the getWindowVibrancy stub only; the rest of webui is dormant N/A'),
 (r'^apps/webui/|^apps/viewer/package\.json$', 'F', 'N/A', [], 'dormant surfaces'),
]

# Every row id the rules name must exist in the plan's Tracker.
plan = open(PLAN, encoding='utf-8').read()
tracker_ids = set(re.findall(r'^\| (UB\d+\.\d+) \|', plan, re.M))

out, unmapped, used = {}, [], set()
bad_rows = set()
for p in paths:
    for i, (rx, sec, disp, rows, note) in enumerate(R):
        if re.search(rx, p):
            out[p] = {'section': sec, 'disp': disp, 'rows': rows, **({'hunks': note} if note else {})}
            used.add(i)
            for rid in rows:
                if rid not in tracker_ids:
                    bad_rows.add(rid)
            break
    else:
        unmapped.append(p)
dead = [R[i][0] for i in range(len(R)) if i not in used]
json.dump({'diff': 'v0.14.0..v0.15.1', 'count': len(paths), 'map': out},
          open(os.path.join(HERE, 'd15-map.json'), 'w'), indent=1, ensure_ascii=False)
from collections import Counter
print('paths %d of %d mapped' % (len(out), len(paths)), '— by section',
      dict(sorted(Counter(v['section'] for v in out.values()).items())))
if unmapped or dead or bad_rows:
    if unmapped:
        print('UNMAPPED', unmapped, file=sys.stderr)
    if dead:
        print('DEAD RULES', dead, file=sys.stderr)
    if bad_rows:
        print('ROWS ABSENT FROM THE TRACKER', sorted(bad_rows), file=sys.stderr)
    sys.exit(1)
print('every named row id exists in the Tracker; no dead rules')
