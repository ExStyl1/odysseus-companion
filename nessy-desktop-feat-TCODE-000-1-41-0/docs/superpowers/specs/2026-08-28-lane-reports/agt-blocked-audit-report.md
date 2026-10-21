# Recovered from the lane transcript (the lane finished without writing a report file)

These are the lane's own assistant messages in order. Narration and dead ends are
included; the findings are authoritative, the running commentary is not.

---

I'll start by reading the six case files and the harness infrastructure.

---

Now let me read the two model fixtures in full.

---

## Summary of findings

All six rows are gated on **env vars the operator sets by hand**, but the *thing behind* almost every env var is a plain file the app reads out of `CONFIG_DIR` — which `packages/shared/src/config/paths.ts:19-21` resolves from `NESSY_CONFIG_DIR`. The MCP-W/SKL-P1 fixture-config-dir pattern therefore does sidestep the README policy for five of the six. Two rows additionally carry **stale reason strings** (AGT-5 provably, AGT-7 partly), and three cases are **structurally unable to PASS** even with every env var set.

Key shared facts, cited once:

- `packages/shared/src/capabilities/native-sources.ts:1449` — `const configDir = env.configDir ?? CONFIG_DIR`, and lines `:1520-:1530` enumerate the global tier the app reads: `<configDir>/skills`, `<configDir>/agents`, `<configDir>/mcp.json`, `<configDir>/hooks.json`, `<configDir>/MEMORY.md`.
- `scripts/cdp/lib/report.ts:47` `blocked()` throws; `runCase` at `:110-:118` maps it to BLOCKED **unless a check already failed**, in which case FAIL wins.
- `scripts/cdp/lib/connect.ts:47-48` — the harness *attaches* to an already-running app on `NESSY_CDP_PORT`; it never launches it. So "harness-creatable" everywhere below means "a fixture script builds the tree; the operator still starts the app with `NESSY_CONFIG_DIR=<root>/config`" — the identical operator step MCP-W1..3 and SKL-P1 already require.
- Precedent for the policy question is written into the harness itself: `scripts/cdp/fixtures/runtime-switch.ts:191-195` — *"This is a config write, which a CASE may not do (`scripts/cdp/README.md`…). A fixture may — that is what a fixture is — and it happens here… against a scratch config dir."* The README sentence at `scripts/cdp/README.md:329-331` is about **the operator's live config dir**, not about the artifact class.

---

## AGT-4 — `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/scripts/cdp/cases/agt-4.ts`

**1. `blocked()` sites**

- **:77-:81** (gate hit today) — template. Literal prose: `'set NESSY_CDP_OUTPUT_STYLE_ID and NESSY_CDP_OUTPUT_STYLE_MARKER first. The style must carry a distinctive instruction (e.g. "end every reply with the token OSTYLE-7788") and the marker is that token. Available styles: '` + `JSON.stringify(styles.map(s => s.id ?? s.name))` — the interpolation is the live `listOutputStyles(workspaceId)` result read at `:71-:73`.
- **:156-:160** — `'set NESSY_CDP_MEMORY_MARKER to a token already present in this project's memory to drive the memory half. The harness does not append memory on its own: MemoryAppendScope is project|user, so it would write into the operator's own files.'`

Also note **:148-:152**, a hard-coded `run.check(…, false, 'not driven: this case rewinds the transcript but does not yet make a fork and a named subagent each edit a file first')`. Because `run.failed` wins over `BlockedError` (`report.ts:117`), **AGT-4 can never report PASS as written** — with all three env vars set it reports FAIL, not PASS. That is case debt, independent of the fixture question.

**2. Preconditions named** — (a) a custom output style whose body carries a distinctive token; (b) a memory entry carrying a marker; (c) implicitly a live model/session.

**3. Harness-creatable today: YES for both halves.**

- Output styles: `packages/shared/src/prompts/output-styles.ts:17` — `const USER_OUTPUT_STYLES_DIR = join(CONFIG_DIR, 'output-styles')`; the discovery loop is `discoverCustomOutputStyles` at `:586-:628`, which takes any `*.md` in that directory and mints the id `custom:<slug>` (`:611`, `:621`). Frontmatter contract at `:494-:558`. So a fixture writes `<root>/config/output-styles/cdp-marker.md` and the case sets `NESSY_CDP_OUTPUT_STYLE_ID=custom:cdp-marker`. Nothing is installed, no plugin, no hook.
- Memory: `packages/shared/src/agent/memory/memory-store.ts:17` `MEMORY_FILE_NAME = 'MEMORY.md'`, `:62-:64` `getUserMemoryFilePath(configDir = CONFIG_DIR)`, `:58-:60` project memory = `<workingDirectory>/MEMORY.md`. `native-sources.ts:1526` confirms `<configDir>/MEMORY.md` is scanned. A fixture writes either file in its own tree; `sessionCommand appendMemory` is never needed.
- **Policy assessment:** the reason string's objection is literally *"it would write into the operator's own files"*. Under `NESSY_CONFIG_DIR=<fixture>/config` plus a fixture project dir, they are not the operator's files. The policy is fully sidestepped. Classify **(b) harness-creatable / stale row**, with the caveat that the row would still not go green until the `:148` self-declared-unproven check is either driven or removed.

**4/5. Feature still exists** — `apps/electron/src/shared/types.ts:957-958` (`setOutputStyle`, `listOutputStyles`), `apps/electron/src/transport/channel-map.ts:175-176`; `packages/shared/src/protocol/dto.ts:730` `rewindToMessage` and `:728` `appendMemory`, handled at `packages/server-core/src/handlers/rpc/sessions.ts:832-837`.

---

## AGT-5 — `.../scripts/cdp/cases/agt-5.ts`

**1. `blocked()` sites**

- **:48-:51** (gate hit today) — `'set NESSY_CDP_HIGH_EFFORT_SUBAGENT to the name of a subagent whose frontmatter asks for a high effort level. Without one there is nothing that could out-think the parent, and the case would pass vacuously.'`
- **:90-:94** — **unconditional, at the end of `drive()`** — `'the effort each spawn actually used is not exposed to the renderer — no field of the Pi runtime snapshot carries it. Confirm it in the dev log for the two spawns recorded above (grep the child-start lines for the effort/thinking level): the first must be higher than the parent\'s "low", and the second must reflect the mid-session "high".'`

**2. Preconditions** — a named subagent `.md` whose frontmatter declares a high effort level (and, implicitly, a Pi-runtime session and a live model).

**3. Harness-creatable today: YES.** `packages/shared/src/agents/definitions.ts:838` reads `join(CONFIG_DIR, 'agents')` for markdown definitions (project tier at `:847`, `<projectRoot>/.nessy-agent/agents`), and `effort` is a first-class frontmatter field: declared at `:97`, normalized at `:550` via `normalizeThinkingLevel`, rejected-if-invalid at `:572-:573`, emitted at `:601`. `parseFrontmatter` at `:656-:686` accepts `effort: high` verbatim. Confirmed as a capability source at `native-sources.ts:1521`. A fixture writes `<root>/config/agents/cdp-deep.md`. **Policy sidestepped** the same way as AGT-4; compare `scripts/cdp/cases/cdx-roles.ts:83`, which hardcodes `join(homedir(), '.nessy-agent', 'agents')` — that one *is* operator-owned precisely because it points at the live dir, and it is what the close-out means by "the probe-role agent file is gone from the operator's agents dir".

**5. The second reason string is STALE — this is the strongest finding in the audit.** The Pi runtime child summary now carries `effort` and `model`:

- `packages/shared/src/protocol/pi-harness-runtime.ts:174-175` — the child record's `exact()` key list ends `…, 'error', 'effort', 'model'`, and `effort` is parsed as `enumValue(child.effort, ['off','low','medium','high','xhigh','max'])`.
- `packages/server-core/src/sessions/SessionManager.ts:4669` populates it: `...(child.restrictions?.thinkingLevel ? { effort: child.restrictions.thinkingLevel } : {})`, plus `model`.
- The test that pins the contract is `packages/shared/src/protocol/pi-harness-runtime.test.ts:42-67` ("R53c — the per-subagent `effort`/`model` of `statusline.md`'s `subagentStatusLine` row body").

The case already fetches this snapshot: `scripts/cdp/lib/state.ts:314-338` `piRuntime()` returns `raw: snap`, so `raw.childState.children[].effort` is readable **today** without any product change — the helper's own projection at `:332-:335` simply drops the field.

**Classification: (b) harness-creatable, and doubly stale** — the fixture is a plain file, and the "not observable from the renderer" justification for the terminal `blocked()` is no longer true.

---

## AGT-6 — `.../scripts/cdp/cases/agt-6.ts`

**1. `blocked()` site** — **:50-:54** (the only one) — `'set NESSY_CDP_PROMPT_HOOK_MARKER and NESSY_CDP_COMPACT_HOOK_MARKER, and install the two hooks they name: a UserPromptSubmit hook that prints the first marker to stdout and exits 0, and a SessionStart hook matching \`compact\` that prints the second. The harness does not write hook config — that is the operator\'s live settings.'`

**2. Preconditions** — two installed command hooks (`UserPromptSubmit`, `SessionStart` matching `compact`) plus their markers; a session large enough to compact (the case seeds that itself at `:73-:80`).

**3. Harness-creatable today: YES.** Hook config is a plain JSON file in the config dir:

- `packages/shared/src/automations/hooks-config.ts:7-8` `HOOKS_CONFIG_FILE = 'hooks.json'`, `:52-:54` `getUserGlobalHooksConfigPath(configDir = CONFIG_DIR)`, `:92-:94` `loadUserGlobalLifecycleHooksConfig`.
- Discovery as a capability source: `packages/shared/src/capabilities/native-sources.ts:1523` — `fileRecord('hook', join(configDir, 'hooks.json'), globalScope, 'hooks.json')`; workspace/project tiers at `:1573` and `:1642`.
- A fixture writes `<root>/config/hooks.json` with two `command` entries whose command is a `node -e` / shell one-liner echoing the marker. Note the case's own doc comment at `:12-:16` states the policy rationale ("hook config is the operator's live settings, and a case that rewrites it is a case that can break the machine it is measuring") — true of `~/.nessy-agent/hooks.json`, false of a throwaway tree. **Policy sidestepped.**

**5. Feature exists** — event names: `packages/shared/src/automations/types.ts:255` (`'UserPromptSubmit'`) and `:89` (the `SessionStart` contract row, "…and again after each completed compaction"); `SessionStart` sources include `compact` per `:1028` (`startup | resume | clear | compact`). The stdout→context rule is implemented in `packages/shared/src/automations/hook-command.ts:315-360` — `SessionStart` and `UserPromptSubmit` are among "the three events whose exit-0 stdout is CONTEXT rather than a debug line". Nothing obsolete.

**Classification: (b) harness-creatable / stale row.** AGT-6 is the cleanest win of the six: it has exactly one gate, no terminal `blocked()`, and no hard-coded false check — it can actually reach PASS once the fixture exists.

---

## AGT-7 — `.../scripts/cdp/cases/agt-7.ts`

**1. `blocked()` sites**

- **:80-:84** (gate hit today) — `'set NESSY_CDP_PLUGIN_SENSITIVE_VALUE (and NESSY_CDP_PLUGIN_OPTION_KEY) after installing a plugin that declares a userConfig with one plain and one sensitive option and providing values through the app. The harness does not install plugins or type secrets on its own.'`
- **:99** — `'set NESSY_CDP_PLUGIN_OPTION_KEY to the plugin option key so the expected env var name can be asserted'`
- **:114-:118** — **unconditional** — `'steps 1-2 (the option prompt appearing and accepting values) are a UI drive against a specific plugin install and were not performed by this case. Confirm them by hand at install time; the security scan and the env-export check above stand on their own.'`

**2. Preconditions** — an installed plugin declaring `userConfig` with one plain + one sensitive option; values supplied through the app; the option key; the plugin data root (`NESSY_CDP_PLUGIN_DATA_ROOT`, default `~/.nessy-agent/plugins/data` at `:38`).

**3. Harness-creatable today: MOSTLY YES, and the "types secrets" objection is stale.**

- The bundle: authoring a Claude-format plugin with `userConfig` is exactly what `scripts/cdp/fixtures/mcp-naming.ts:173-214` already does for `.claude-plugin/plugin.json` + `.mcp.json`; add a `userConfig` block (schema validated at `packages/shared/src/plugins/format-adapters/claude.ts:1964-:2070`, `sensitive` recognized via `packages/shared/src/plugins/mcpb-configuration.ts:93-97`) and a `hooks/hooks.json` (default path constant `claude.ts:172`).
- Installation: renderer-reachable RPC the CDP driver can call through `session.call` — `apps/electron/src/transport/channel-map.ts:215-225` (`marketplace.addRegistry`, `marketplace.proposeInstall`, `marketplace.install`).
- **Supplying the values needs no typing at all**: `apps/electron/src/transport/channel-map.ts:212` `'plugin.manage'`, and the renderer's own path is `apps/electron/src/renderer/hooks/usePluginConfigurationPrompt.tsx:70-72` — `window.electronAPI.plugin.manage({ …, action: 'configure' , values })`. Server side: `packages/server-core/src/handlers/rpc/plugins.ts:135-152` (`configuration-status` / `configure` / `clear-configuration`). So "the harness does not … type secrets on its own" is answerable by calling the same RPC the dialog calls.
- The data root moves with the config dir: `packages/shared/src/workspaces/paths.ts:10-12` — `PLUGINS_DIR = join(CONFIG_DIR, 'plugins')`, `PLUGIN_DATA_DIR = join(PLUGINS_DIR, 'data')`. So the byte-scan half automatically scans the fixture tree.
- **Policy:** the plugin install is the one item the README singles out, but MCP-W1..3 and SKL-P1 already resolve it the same way — install into the fixture config dir through the app's own marketplace RPC. **Sidestepped.**
- **What is NOT harness-creatable**: the `:114` step 1-2 claim is about the *dialog rendering and accepting input*. That is a genuine UI drive (it could be driven with CDP clicks, but nothing in the harness does UI-drives of that dialog today). As written the terminal `blocked()` is unconditional, so **AGT-7 can never PASS** regardless of fixtures.

**5. Feature exists** — `CLAUDE_PLUGIN_OPTION_<KEY>` is still emitted: `packages/shared/src/plugins/user-config-substitution.ts:93` and `:97` (`const name = \`CLAUDE_PLUGIN_OPTION_${field.key.toUpperCase()}\``), `packages/shared/src/plugins/mcpb-configuration.ts:234` (`environment[\`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}\`] = …`), assembled by `readPluginOptionEnvironment` at `packages/shared/src/plugins/plugin-settings.ts:199-227`, and attached **to hooks only** at `packages/shared/src/capabilities/resolver.ts:1000` (`pluginOptionEnvironmentFor`) and `:2167`. The case's own doc comment names `pluginRuntimeEnv`/`claudeCompatPluginEnv` in `packages/shared/src/plugins/data-paths.ts` — those exist (`:108`, `:138`, profile dispatch at `:187-:197`) but they carry the plugin *root/data* variables, **not** the option variables; the option env comes from `plugin-settings.ts`. That part of the header comment is inaccurate.

**Classification: (b) for the fixture and the value-supply half (stale objection), (a) operator/UI-owned for the step 1-2 dialog claim as currently written.**

---

## AGT-8 — `.../scripts/cdp/cases/agt-8.ts`

**1. `blocked()` sites**

- **:40-:43** (gate hit today) — `'set NESSY_CDP_BLOCKED_MODEL to a model id the deployed managed policy does NOT list in \`availableModels\`, and deploy that policy first. Without a policy in force the refusal cannot be distinguished from an ordinary error.'`
- **:88-:96** — **unconditional**, conditional prefix only. When no toast was seen: `'the VISIBLE refusal was not observed: this case calls setSessionModel directly, which bypasses the renderer handler that raises the toast. Repeat the selection by hand through the model picker and confirm the text reads "This model is restricted by your organization\'s managed policy". '` — then always: `'Then withdraw the managed policy and confirm the full model list returns — the harness does not write managed configuration, and this is the data-loss guard (enforcement deliberately never writes a narrowed list back).'`

**2. Preconditions** — a deployed managed policy with a non-empty `availableModels`; a model id outside it; (for the visible half) a UI drive of the model picker; (for the withdrawal half) removing the policy.

**3. Harness-creatable today: YES for the enforcement half — and this is the least obvious of the six, so here is the whole chain.**

There are **two** managed sources, and only one of them needs root:

- **File source (needs root, not harness-creatable):** `packages/server-core/src/pi-harness/managed-policy-loader.ts:52-58` `managedPiPolicyPathForPlatform` → `managedSystemDirForPlatform` (`packages/shared/src/config/managed-system-paths.ts:38-40`: `/Library/Application Support/Nessy`, `/etc/nessy`, `%ProgramData%\Nessy`) + `managed-policy.json`. No env override anywhere in that file. The read enforces `stat.uid !== 0 → invalid()` at `:85-:88` and `realpath(path) !== path → invalid()` at `:255`. Deploying that **is** operator/root work.
- **Delivered source (no root, lives in `CONFIG_DIR`):** `packages/shared/src/config/managed-delivery.ts:78-83` — `MANAGED_DELIVERY_CACHE_FILENAME = 'managed-delivery.json'`, `getManagedDeliveryCachePath(configDir = CONFIG_DIR)`. `loadCachedManagedDelivery` at `:358-:380` re-parses the file (its own comment: *"The cache is a user-writable file on an unmanaged device"*), and holds a payload back **only** if `classifyManagedApproval` returns a request whose digest does not match. `classifyManagedApproval` (`packages/shared/src/config/managed-approval.ts:111-168`) raises items **only** for `sandbox.allowUnsandboxedCommands`, `sandbox.excludedCommands`, `allow` permission rules (category `shell`) and non-allowlisted `env` keys (category `env`). **`availableModels` is in neither category**, so an `availableModels`-only payload needs no approval and applies straight from the cache.
- Bootstrap wiring: `packages/server-core/src/bootstrap/storage-runtime.ts:254` `setManagedModelPolicy(managedPiPolicy)` from `resolveEnforcedManagedPolicy` (`packages/server-core/src/bootstrap/managed-policy-resolution.ts:381-395`), and `setManagedModelPolicy` (`packages/shared/src/config/managed-models.ts:78-81`) is the single writer of the process registry `setManagedModelAllowlist` (`packages/shared/src/config/managed-model-allowlist.ts:112-114`). `getDeliveredManagedPolicy` re-reads the cache on every call (`managed-delivery.ts:604-609`), so ordering vs. `initializeManagedDeliveryFromCache()` (`apps/electron/src/main/index.ts:1230`) does not matter. Grant validation for the field: `packages/shared/src/agent/pi-harness/managed-policy.ts:1756`.

So a fixture can write `<root>/config/managed-delivery.json` = `{ schemaVersion: 1, fetchedAt: <ms>, payload: { availableModels: [<one allowed id>] } }` and the app launched against that tree enforces the allowlist without root and without touching `/Library/Application Support/Nessy`. **Policy sidestepped** — the README's "never writes managed policy" is about machine-wide operator config; this is a scratch tree.

**Caveats, stated rather than glossed:**
- The allowlist is fixed for the process lifetime — `managed-model-allowlist.ts:105-108`: *"Nothing recomposes the policy after bootstrap."* So the **withdrawal half needs an app relaunch**, and the harness attaches rather than launches (`connect.ts:47`). That half stays a two-sitting operator procedure unless the runner learns to relaunch.
- The **visible/toast half** is a real UI drive, correctly described at `:73-:76`. Not harness-blocked, just not driven.
- The terminal `blocked()` at `:88` is unconditional ⇒ **AGT-8 can never PASS** as written.

**5. Feature still exists — managed-model-allowlist enforcement is alive.** `packages/server-core/src/handlers/rpc/settings.ts:201-206` throws `CodedError('MODEL_RESTRICTED_BY_POLICY', \`Model is restricted by managed policy: ${model}\`)` when `!isManagedModelSelectable(model)`. The code is registered at `packages/shared/src/protocol/types.ts:100` and `:145`. The renderer toast the case quotes is at `apps/electron/src/renderer/pages/ChatPage.tsx:297` (`if (code === 'MODEL_RESTRICTED_BY_POLICY')`). Matcher and registry: `packages/shared/src/config/managed-model-allowlist.ts:67-71` (`matchesManagedModelEntry`), `:84-:90` (`isModelInManagedAllowlist`), `:121-:123` (`isManagedModelSelectable`). Other enforcement points: `packages/shared/src/agent/pi-agent.ts:4727`/`:4764`, `packages/shared/src/agent/backend/factory.ts:968`, `packages/shared/src/agent/pi-harness/harness-manifest.ts:481`.

**Classification: (b) harness-creatable for enforcement; (a) operator-owned for the toast drive and the relaunch-dependent withdrawal half.**

---

## STR-2 — `.../scripts/cdp/cases/str-2.ts`

**1. `blocked()` sites** (three in the file, plus two reachable from libraries)

- **:131-:135** — **the one being hit** — template: `` `the prose turn had already finished ${CORRECTION_DELAY_MS} ms after it started, so there was nothing ` `` + `'to steer into and this arm measured nothing. Re-run, or raise CORRECTION_DELAY_MS / lengthen longProsePrompt so the window is wider.'` — `CORRECTION_DELAY_MS` is the module const `6_000` at **:86**.
- **:161-:166** — template: `` `the seed turn called ${JSON.stringify(shape.toolUses.length > 0 ? shape.toolUses : ourTools.names)} despite being ` `` + `'asked for invented prose with no file reads and no commands. A PreToolUse boundary therefore existed, the steer was deliverable, and \`steer_undelivered\` — the whole subject of this case — is unreachable on this run. STR-1 is the case for the delivered path. Re-run; this is the model\'s choice, not a defect.'` — interpolation is the CLI transcript's tool list or our transcript's tool names.
- **:150** → `requireTurnStarted` → `scripts/cdp/lib/mid-stream.ts:790-794`: `` `${stage} did not run: the runtime answered with ${JSON.stringify(errors.join(' | ').slice(0, 600))}. ` `` + `'The card completed its probe turn moments earlier, so this is the upstream rather than the mid-stream route this case measures.'` (`stage` = `'the arm'`).
- **:92** → `resolveClaudeCard` → `scripts/cdp/lib/claude-child.ts:387-391` (no `claude-runtime` connection on this host) and `:394-:397` (`NESSY_CDP_CLAUDE_CARD` names a non-claude-runtime card).

**2. Preconditions** — a live `claude-runtime` card that completes a probe turn (live upstream, operator credential); the connection temporarily moved to `midStreamBehavior: 'steer'` (the case does this itself at `:98` and restores at `:242`, via `mid-stream.ts:130-149` `saveLlmConnection`); a turn still in flight 6 s after start; and a turn that makes **no** tool call.

**3/4. What makes it unrunnable, precisely.** The seed prompt is `longProsePrompt` (`mid-stream.ts:774-778`): *"Write release notes for an imaginary internal tool called Lantern <id>: an intro paragraph, then eight bullet points of invented features, then a short closing paragraph…"*. That is a few hundred tokens of output. The case then sleeps a **hard-coded 6 000 ms** (`str-2.ts:86`, `:122`) and gates on `isProcessing` at `:123-:136`. When the gateway answers that prompt in under ~6 s, the sleep outlives the turn and the arm blocks. `waitUntilProcessing` (`mid-stream.ts:602-611`) only proves the turn *started*; nothing adapts the delay to the turn's expected length.

**Can anything in the case make the window reliably wide?** Yes — three levers, all inside the harness, none requiring product change:

1. **Shorten the wait, not lengthen the turn.** Nothing about the claim needs 6 s; it needs "a turn in flight when Enter is pressed". `submitWithoutWaiting` (`mid-stream.ts:570-593`) itself costs clear+type+read+submit round-trips, so sending the correction immediately after `waitUntilProcessing` returns already lands inside the turn far more often. The doc comment at `:78-:86` explicitly says it is "NOT a timing assertion".
2. **Lengthen the output.** `longProsePrompt` is a harness-owned string at `mid-stream.ts:774-778`; asking for, say, forty bullets or 2 000 words widens the window proportionally. The competing constraint is real and must be respected: the prompt must not induce a tool call, or the `:161` gate fires instead. Prose-length requests do not.
3. **Make the delay a knob.** There is no env knob today — the only `process.env` reads in `mid-stream.ts` are `NESSY_CDP_APP_LOG` (`:189`), and in `claude-child.ts` `NESSY_CDP_CLAUDE_CARD` (`:382`). `CORRECTION_DELAY_MS` is a bare const.

A "slower model" is possible in principle (`window.electronAPI.setSessionModel(...)`, the same call AGT-8 uses at `agt-8.ts:47-:54`) but it is the weakest lever: model latency is what varied by an order of magnitude between runs in the first place (the case records 9 s and 81 s on 2026-08-17 at `:126-:129`).

**5. Not obsolete — the feature under test is fully alive.** `steer_undelivered` is emitted by the Claude backend at `packages/shared/src/agent/claude-agent.ts:4218-4219` (`Steer message was not delivered (no tool call fired) — emitting steer_undelivered`), handled at `packages/server-core/src/sessions/SessionManager.ts:24589-24608`, and the exact log line the case greps for is `SessionManager.ts:24608` — `Steer message undelivered, re-queuing for session ${sessionId}` (matched by `mid-stream.ts:308-313`). The id-reuse machinery the case's core check is about is `pendingSteeredMessageIds` at `SessionManager.ts:1963`, `:7844`, `:20224`, `:24603`, with the `replay queued` / `replay failed` lines at `:22577` and `:22616`. `midStreamBehavior` and `resolveMidStreamBehavior` are documented in `packages/shared/CLAUDE.md`/`AGENTS.md` as current.

**Classification: (b) harness-fixable, with one operator-owned residue.** The BLOCKED reason names its own fix in its own text ("raise CORRECTION_DELAY_MS / lengthen longProsePrompt"), and both dials are harness-owned source. The residue is that the live `claude-runtime` card and its credential remain operator-supplied, and the "no tool call" precondition remains the model's choice — that second one is correctly modelled as a re-run condition, not a defect.

---

## Cross-cutting notes worth carrying into the audit

1. **Three cases cannot report PASS by construction**, so their rows would stay non-green even after every fixture exists: AGT-5 (`:90`), AGT-7 (`:114`), AGT-8 (`:88`) end in an unconditional `blocked()`; AGT-4 carries a hard-coded failing check at `:148` which, per `report.ts:117`, converts the run to FAIL rather than BLOCKED. AGT-6 is the only one of the five AGT rows that is a clean single-gate case.
2. **One reason string is demonstrably false today** — AGT-5's "no field of the Pi runtime snapshot carries [the effort]" is contradicted by `packages/shared/src/protocol/pi-harness-runtime.ts:174-175` and `packages/server-core/src/sessions/SessionManager.ts:4669`.
3. **The README's policy sentence and the fixture pattern are not in conflict.** `scripts/cdp/README.md:329-331` scopes itself to "the operator's live configuration"; `scripts/cdp/fixtures/runtime-switch.ts:191-195` already states the resolution in the harness's own words. Every artifact these six cases need — output style `.md`, agent `.md`, `hooks.json`, `MEMORY.md`, plugin bundle + `configure` RPC, `managed-delivery.json` — lands under `CONFIG_DIR`, which `packages/shared/src/config/paths.ts:19-21` redirects with `NESSY_CONFIG_DIR`.
4. **What I could not determine:** whether the delivered-policy route (AGT-8) has ever been exercised live against a fixture config dir — I found no case or fixture that writes `managed-delivery.json`, so the chain above is read from source, not from a recorded run. Likewise I did not verify empirically that a `hooks.json` written into a scratch config dir produces a running hook process; I traced the read path (`native-sources.ts:1523` → `hook-command.ts:315-360`) but no CDP artifact exercises it today.
