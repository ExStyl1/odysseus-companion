import { AGENT_PROVIDERS } from '@nessy-agent/shared/agent/backend/runtime-vocabulary'
import type { ModelProvider } from '@config/models'

/**
 * What a cross-runtime switch costs, per DIRECTION — R11.
 *
 * The plan's target says switch friction is ours to absorb. Ten rows of that
 * plan absorbed it; this module is the remainder — the differences that cannot
 * be absorbed and that a user otherwise meets by being surprised. Pi → Claude
 * loses different things than Claude → Pi, so a cost is not a property of the
 * target runtime: it is a capability the SOURCE has and the TARGET does not.
 * That set difference is the whole model.
 *
 * **Switching BACK onto Pi no longer lists nothing, and that changed on
 * 2026-09-06 (P6.65 / P6.170).** For three waves this paragraph said it did, and
 * P4.6 had already corrected the REASON once: it was never that Pi is a
 * superset — measured over our session surface, `claude \ pi` was exactly
 * `{ TodoWrite }`, which does not pass the admission rule because Pi runs the
 * four documented `Task*` tools in its place (that is what `NESSY_ENABLE_TASKS`
 * selects between, and `Task`/`TodoWrite` are its legacy fallback). **`codex \
 * pi` was the same singleton and since P6.303 (1) it is EMPTY**: the host
 * `TodoWrite` is withheld from codex too, which writes its plan with its own
 * `update_plan` onto the same two host views (P3.295). The conclusion is
 * unchanged and its ground is now one case narrower. The real reason was narrower and is now spent: no capability the
 * other two have and Pi lacks HAD ever passed the rule. Two now do —
 * `credentialShellFloor` (codex enforces the credential exclusion in the OS,
 * where ours is tool-mediated) and `policyKeys` (32 documented Claude policy and
 * security switches the vendored binary honours and nothing of ours reads).
 *
 * That is the shape of claim this file has been wrong about before: a SENTENCE
 * beside a table, true when written, kept by a suite that only checked the
 * table. So the emptiness of a leg is no longer stated here at all — it is read
 * out of `runtimeSwitchCosts` by `__tests__/runtime-switch-costs.test.ts`, which
 * is the only place it can be true by construction.
 *
 * ## What earns a row here
 *
 * Only a difference a real user would hit and be surprised by — one that
 * changes what happens to their files or what the model can do for them. An
 * internal type-level difference is not a switch cost. Everything already said
 * elsewhere at a better moment is deliberately absent: image attachments the
 * target cannot read and plugin peripherals that stop executing are reported
 * by name AFTER the switch (`ChatPage`'s `droppedAttachments` /
 * `capabilityDelta` toasts, which know things the renderer cannot), and an
 * agent whose declared hooks are dropped on Claude announces itself per agent
 * at launch (R12). Repeating those here would be less specific and less timely.
 *
 * ## Retired, with the reason — `webSearch` (P6.896), the FIRST row this table
 * has ever removed for being CLOSED rather than for being wrong
 *
 * P3.342 added `webSearch` when the ability to search really was lost on two of
 * the three legs. P6.148 then BUILT the missing half on both: the host
 * registers its own `web_search` session tool over the key-free DuckDuckGo
 * engine — offered on every codex session, and on a claude session exactly when
 * `resolveClaudeHostedWebSearchWithheld` says this connection cannot reach the
 * vendor's server-side one. With all three runtimes `true` the row could never
 * fire again: `switchCostCertainty` returns null for a target that has the
 * capability, so both shipped locale sentences would have become unreachable
 * text asserting something false. Rewording them would have kept a row that
 * cannot fire; deleting the row is the honest move, and it is recorded here
 * rather than only in the plan because the NEXT reader who meets P3.342's
 * evidence in `runtime-capability-gaps.md` needs to know why no row answers it.
 *
 * What is still absent is named there and is a different thing: the VENDORS'
 * hosted search (claude's server-side `WebSearch`, codex's `web_search =
 * "disabled"`), which a real Anthropic or OpenAI upstream would notice and
 * which no switch between OUR connections can lose. The DDG-reachability
 * measurement this row rested on (2026-09-04, `html.duckduckgo.com` 200 with 21
 * result anchors, `lite.duckduckgo.com` 200 with 10, `example.com` 200 and
 * `api.anthropic.com` 404 as controls) lives on in both gaps rows, so retiring
 * the row loses no evidence. A deployment behind a stricter egress policy loses
 * the ability on ALL three runtimes at once — which is still no set difference,
 * and therefore still no row. (`subagentModelOrder`, F1.588, and `outputStyleTiming`, UB12.63, went the same way — see their notes.)
 *
 * ## Rejected, with the reason — codex's managed requirements (P2.420)
 *
 * `docs/architecture/runtime-capability-gaps.md` gained two Codex rows on
 * 2026-08-30 for administrator requirements this build reads: `models.newThread`
 * (`'client'` in `CODEX_REQUIREMENT_ENFORCEMENT`, reported with the
 * administrator's value rather than applied, on a stated product posture) and
 * `featureRequirements.in_app_browser`, which was *enforced by nobody* when this
 * entry was written and is enforced by US since P2.463 (`'nessy'` in
 * `CODEX_HOST_FACING_FEATURE_KEYS`, gated by `config/managed-in-app-browser.ts`
 * plus `main/browser-pane-manager.ts`). They are recorded there and deliberately
 * absent from the table below, and the entry is written HERE rather than left
 * implicit, because a gap recorded in one document and silent in the other is
 * how a switch cost stays invisible to the surface that exists to price it.
 *
 * The table's own rule decides it. A cost is a capability the SOURCE has and
 * the TARGET does not, and `configRequirements` is codex's OWN wire — Pi and
 * Claude publish no counterpart, so a switch out of either loses nothing and a
 * switch INTO codex acquires a report, not a loss. There is no set difference
 * to state. It also fails the admission rule above twice over: the requirement
 * is an administrator's rather than the switching user's, and its audience is
 * `formatCodexConfigRequirementsDiagnostics`, which names the required value
 * beside the one the session actually ran — a place the person who deployed the
 * policy will look, at a moment they can act on it. A dialog row would warn the
 * wrong person, earlier and vaguer than the report that already exists, which
 * is the same ground every rejection above rests on.
 *
 * This does not generalise to managed policy as such: our own managed policy is
 * host-side and applies on all three runtimes, so it is not a switch cost for a
 * different reason. If codex ever gains a requirement whose subject IS a
 * capability the user operates and Pi or Claude enforce the same thing, that
 * one is a set difference and belongs in the table.
 *
 * `in_app_browser` is the first requirement to reach that description, and it
 * lands in the FIRST half rather than the second — so no row is owed. The
 * ENFORCEMENT is host-side and uniform: one Electron factory gates every entry
 * point on all three runtimes. Only the INPUT is codex's, and a recorded tier is
 * never cleared by a switch (tightest wins, disabling direction only), so a
 * session leaving codex keeps the disable it arrived with. Nothing the source
 * has that the target lacks.
 *
 * ## Rejected, with the reason — messaging a session on ANOTHER MACHINE (P6.526)
 *
 * A session can be addressed only on the machine it runs on, and that is true
 * identically on all three runtimes, so there is no set difference and no row.
 * Written here rather than left implicit for the same reason the paragraph above
 * is: this is a capability a vendor page ADVERTISES, and a reader who meets that
 * page and then this table would otherwise have to guess which of the two
 * describes the product.
 *
 * The reason it is uniform is that the chokepoint is the HOST's.
 * `send_agent_message` takes `{ sessionId, message }` and nothing else — no
 * machine and no account dimension — and `SessionManager.deliverAgentMessage`
 * resolves the id, verbatim, "only inside the sending session's Workspace" on
 * this host. Codex publishes no session-to-session tool at all, and Claude's own
 * route is excluded from this fork by its own page:
 * `cross-session-messaging.md#availability`, whole sentence — *"Claude can't
 * find those sessions with an API key or on Amazon Bedrock, Claude Platform on
 * AWS, Google Cloud's Agent Platform, and Microsoft Foundry."* We authenticate
 * with a gateway token, and there is no Remote Control client anywhere in this
 * tree.
 *
 * Delegated decision Q-den 63 took option (a) — same-machine only, said plainly
 * — over (b), a relay through our own gateway, which would have been a new
 * egress path carrying session TEXT rather than tokens (the page's own transport
 * for that leg is *"Through Anthropic servers"*,
 * `#message-sessions-on-other-machines`) and would have needed an account
 * dimension `sessionId` does not carry.
 *
 * **What is still owed, and it is not a row here:** the sentence belongs where a
 * user or a model MEETS the limit — `send_agent_message`'s own descriptor, and
 * the `Session <id> not found` thrown by `deliverAgentMessage`, which today
 * reads like a typo rather than a boundary. Both files were another lane's when
 * this paragraph landed; the gaps document carries the row.
 *
 * ## Rejected, with the reason — a RUNTIME-INITIATED model switch is invisible
 * to hooks, identically on all three (D1.217)
 *
 * A model switch the USER drives is reported: `SessionManager.updateSessionModel`
 * awaits `runModelSwitchHook` before the write, fail-closed on a block, with no
 * provider gate — so `PreModelSwitch`/`PostModelSwitch` answer alike on all
 * three runtimes and there is nothing to price.
 *
 * A model switch the RUNTIME drives is reported to NOBODY, also on all three, so
 * there is no set difference and no row. It is written here rather than left
 * implicit because the absence is easy to meet and hard to attribute: a user
 * whose hook logged every switch will see a session answer on a different model
 * with no hook line, and nothing anywhere says which of the two kinds happened.
 *
 * Measured at HEAD rather than assumed, and the premise is SHARPER than the row
 * that raised it states — on two of the three runtimes the switcher is OUR OWN
 * CODE:
 *
 * - **pi and codex** walk a host-resolved fallback chain
 *   (`config/fallback-model-chain.ts`'s `resolveFallbackModelChain`, read by
 *   `PiAgent.getRetryFallbackModel` and `CodexAgent.nextFallbackModelHop`) and
 *   retry the turn on the next model. That never reaches `updateSessionModel`,
 *   so the host switches a session's model without telling its own hook seam.
 * - **claude** switches inside the child: the SDK announces it as a
 *   `model_refusal_fallback` system message, which `backend/claude/event-adapter.ts`
 *   turns into a user-facing `info` naming both models. A notice, not an event —
 *   and D1.165 DECLINED handing the vendor's own `PreModelSwitch` matcher to the
 *   child (it is in `claude-agent.ts`'s `CLAUDE_HOST_EMITTED_HOOK_EVENTS`),
 *   because that would give a user's matcher a second set of firings on claude
 *   alone over a transition codex has no event for at all.
 *
 * So the three agree, and the honest fix is not a row here: it is a `source`
 * discriminator on the host's own payload plus a host-side mint at the two
 * fallback sites, so all three report the same set. That changes a hook payload
 * contract on three runtimes and is owner-facing; D1.217 carries it.
 *
 * ## Rejected, with the reason — the `pi-only` tools that earn no row (P4.6)
 *
 * Re-deriving the table from the end state turned up SIX tools that are
 * `visibility: 'pi-only'` today, are therefore absent from both other surfaces,
 * and are named by no row. That looks like two missing rows and is none: the
 * reason each is `pi-only` is that the OTHER TWO RUNTIMES HAVE THEIR OWN, so
 * there is no capability the source has and the target lacks. Written down here
 * because "absent from our surface" and "absent from the session" are different
 * propositions, and every row in this table depends on the difference.
 *
 * - `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` — **DECIDED (P3.338,
 *   owner 2026-09-05 sitting §2.1, option A). The rejection STANDS, and it now
 *   stands for a reason the paragraph below did not originally have.**
 *   `claude-agent.ts` asks for
 *   `preset: 'claude_code'` and `CLAUDE_SESSION_DISALLOWED_TOOLS` subtracts only
 *   `EnterPlanMode`, `ExitPlanMode` and `Monitor` (and `Skill` until F1.862), so nothing OF OURS
 *   removes the preset's four. That was the whole argument, and it was measured
 *   the wrong way: the citation was the vendored
 *   `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`, and **a declaration file
 *   cannot express an `isEnabled` predicate** — it says the tool exists, never
 *   that this session gets it.
 *
 *   Read out of the SHIPPED `claude-agent-sdk-darwin-arm64/claude` — first at
 *   `2.1.233` (the version `d4948e99b` bumped us to; `#task-tool-availability`
 *   named it then, and today says the default set applies from v2.1.268),
 *   re-read at `2.1.247` after the P7.1 lift. **The SHAPE is unchanged and every
 *   minified name in it moved**, which is the rot
 *   `scripts/check-minified-citations.ts` exists to catch, so the transcription
 *   below now spells the names as `<roles>` and keeps only the byte sequences a
 *   minifier cannot touch — the two env vars, the gate literal
 *   `"tengu_rosy_wren"` (2 hits at 2.1.247) and the threshold table's own
 *   `["opus",[4,8]]` (2). Find the predicate again by the
 *   `CLAUDE_CODE_ENABLE_TODO_TOOLS===!0` line inside it (4):
 *
 *   ```js
 *   function <todoGate>(){if(<isBackgroundJob>()||<launchOptIn>())return!0;let e=<currentModelId>();
 *     if(e===void 0||<belowThreshold>(e))return!0;
 *     if(V.CLAUDE_CODE_ENABLE_TODO_TOOLS===!0)return!0;
 *     return <flag>("tengu_rosy_wren",!1)===!0}
 *   function <taskGate>(){return <tasksEnv>()&&<todoGate>()}
 *   <thresholds>=[["opus",[4,8]],["sonnet",[5]],["fable",[5]],["mythos",[5]]],
 *   <taskToolList>=[TodoWrite, TaskCreate, TaskGet, TaskUpdate, TaskList]
 *   ```
 *
 *   All four Task tools carry `isEnabled(){return <taskGate>()}`; `TodoWrite`
 *   carries `isEnabled(){return!<tasksEnv>()&&<todoGate>()}`. The two are
 *   inverses on the `<tasksEnv>()` half (`CLAUDE_CODE_ENABLE_TASKS`) and SHARE
 *   the `<todoGate>()` factor — so on a model `<todoGate>()` refuses, **all five
 *   leave the surface together**, checklist and Task API alike.
 *   That is the gate through 2.1.267. **2.1.274 INVERTED it (F1.1213, F1.1220):**
 *   past the background-job and launch-option opt-ins, `<todoGate>` keeps the
 *   tools when the canonical id is undefined, an inference profile, or on an
 *   allowlist of older models (Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6, Haiku
 *   4.5), else only on `CLAUDE_CODE_ENABLE_TODO_TOOLS === true`; threshold and
 *   `tengu_rosy_wren` are gone (`claude-native-tool-collisions.test.ts`). An
 *   unrecognised gateway id loses all five per the page; the binary's undefined-id arm is unmeasured.
 *
 *   FOUR opt-ins existed through 2.1.267 (three at 2.1.274); the fourth was one nobody had
 *   read: `<isBackgroundJob>()` (a background-job context — not us);
 *   `<launchOptIn>()`, the launch option `todoToolsOptIn`, which the CLI sets
 *   from its own argv — `<set>(<taskToolList>.some(p))`, where `p` tests whether
 *   any of the five is NAMED in `--allowedTools` or in an explicit non-preset
 *   tools list;
 *   `CLAUDE_CODE_ENABLE_TODO_TOOLS === true` (`qe.bool()`); and the remote gate
 *   `tengu_rosy_wren` (≤ 2.1.267 only), default false; unreachable on the gateway path, whose adapter env
 *   (`claude-agent.ts`) writes `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` — the subscription path never set it.
 *
 *   **This paragraph said "we take none of them" and that is now false** — it
 *   was true when the four opt-ins were first read and the owner's decision
 *   below took one of them. The reading is kept because it is what makes the
 *   decision legible; only its conclusion moved.
 *
 *   **The owner took (A): opt in — and the ROUTE moved once, on measurement.**
 *   The 2026-09-05 sitting chose the launch option over
 *   `CLAUDE_CODE_ENABLE_TODO_TOOLS` because the option was said to cost no
 *   deployment change; `4ed0f83a3` then measured that the env variable costs
 *   none either (`buildClaudeSubprocessEnv` writes names into the child
 *   itself), and that it opts in WITHOUT auto-approving. So P6.724
 *   (2026-09-07) switched: `options.ts` sets
 *   `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the child env and returns no
 *   `allowedTools` at all, and `CLAUDE_TODO_TOOLS_OPT_IN_ENV_VAR` there
 *   carries the route, the page sentences and the price. We take the
 *   `qe.bool()` arm, so on a withheld model the withdrawal no longer fires: the
 *   four tools are on the surface on every model, the set difference is empty
 *   again, and NO cost row is owed. The price the owner accepted is context:
 *   the four schemas and their reminders re-enter every claude turn. The
 *   SECOND price is no longer paid — bare `allowedTools` entries made the SDK
 *   emit `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`, which P6.207 surfaces as a
 *   per-session degradation notice, and with no allow list that notice again
 *   means only what it says.
 *
 *   What is NOT in question either way: the sentence above may not go on citing
 *   a `.d.ts` union member. Codex has `update_plan` regardless.
 * - `list_mcp_resources` / `read_mcp_resource` — both other runtimes declare MCP
 *   resource tools natively. Claude: `ListMcpResources` / `ReadMcpResource` in
 *   the same preset. Codex: measured in the shipped `codex-app-server` binary at
 *   the tag we ship — `list_mcp_resources`, `read_mcp_resource` AND
 *   `list_mcp_resource_templates` are declared tools with their own schemas and
 *   descriptions ("Lists resources provided by MCP servers …") and a handler
 *   path, `core/src/tools/handlers/mcp_resource/list_mcp_resources.rs`. Strong
 *   tier for codex (binary at our tag), with `thread/start` as the live control
 *   and a nonsense probe at 0.
 *
 *   CORRECTED, P3.344 (2026-09-04): that paragraph was true about the TOOL and
 *   false about the SUBJECT, and the difference is the whole admission rule.
 *   Both runtimes declared a resource tool that answered EMPTY for every source
 *   the user had connected, because neither reached those sources through a
 *   server advertising resources: a claude-runtime session's `mcpServers` are
 *   built by `createSdkMcpServer`, whose options declare no `resources`
 *   channel, and a codex session's arrive through `McpPoolServer`, which
 *   declared only `tools`. A tool that answers empty is worse than an absent
 *   one — the model cannot tell "none exist" from "I cannot see them".
 *
 *   The CODEX half is closed rather than rowed: `mcp/pool-server.ts` now serves
 *   `resources/list` and `resources/read` off the pool, so codex's own three
 *   tools answer (native-first step 1 — its mechanism was already on; the
 *   server half was missing). Its stated residue is
 *   `resources/templates/list`, which stays method-not-found because the pool
 *   carries no template channel, and a uri two leased sources both advertise,
 *   which codex's (server, uri) argument pair cannot disambiguate.
 *
 *   The CLAUDE half is NOT closed and is NOT a rejection: P6.25's
 *   "cannot at this seam" was derived from `CreateSdkMcpServerOptions`, and the
 *   seam is the CONFIG type `McpSdkServerConfigWithInstance`, which takes an
 *   arbitrary `McpServer` over a message channel with no method allowlist
 *   (`mcp-context-runtime-reach.test.ts` case (c)). Whether the closed binary
 *   issues `resources/list` to an `sdk`-type server is unmeasured and needs a
 *   live packaged run. Until that is measured this row is owed a decision, not
 *   a refusal — recorded here rather than left as the old sentence, which read
 *   as settled.
 *
 * The table's blind spot, stated rather than left implicit: `appActions` is
 * derived from the CLAUDE surface (`__tests__/runtime-capability-drift.test.ts`
 * computes `anthropic \ codex-runtime`), so a `pi-only` tool with no Claude
 * counterpart is invisible to that derivation and needs a row of its own to be
 * seen at all — which is exactly what `worktreeMove` and `scheduledRun` are.
 * Anything else `pi-only` has to be argued about here, by hand, as above.
 *
 * ## Rejected, with the reason — the unswept scheduled-task worktree (P3.288)
 *
 * A row was PRESCRIBED here and is refused by this table's own admission rule,
 * which is the whole reason the refusal is written down instead of being a
 * silence. The defect is real and confirmed twice (W2-m found it, W2-h
 * confirmed the premise): the worktree retention sweep plans over ONE session's
 * lease ledger, while every worktree of a project shares one namespace root, and
 * a scheduled task makes a NEW SESSION PER RUN — so run 2 opens an empty ledger,
 * sweeps nothing, and a run that is never drained (crash, force quit, eviction
 * before `cleanup()`) leaks its worktree permanently.
 *
 * It earns no row because a cost here is "a capability the SOURCE has and the
 * TARGET does not", and this one is IDENTICAL on Pi, claude-runtime and codex:
 * every sweep call site is provider-agnostic, `PiWorktreeLeaseV1` records an
 * `ownerAgentId` and no runtime at all, and `grep -a` over the sweep path for
 * `provider|runtime|codex|claude|pi-` returns two comments and no code (W2-m).
 * There is no set difference to state, and a switch neither creates nor cures
 * it. The parity test agrees structurally: `SUBJECT_MARKERS` is total over this
 * table's row ids and demands a matching row in the TARGET RUNTIME's section of
 * `runtime-capability-gaps.md` — a defect belonging to no runtime has no such
 * section, so a row here would have had to invent one.
 *
 * Recorded instead at the mechanism, in `SessionManager.sweepOrphanedWorktrees`,
 * with the native-first reading a fix must start from: `worktrees.md`
 * §"Clean up subagent and background-session worktrees" documents a MARKER plus
 * a `git worktree lock` held while an agent runs, and we hold neither.
 *
 * ## Rejected, with the reason — PER-MODEL effort memory (D1.203, from I2.5)
 *
 * A row was PRESCRIBED here — *"per-model effort memory does not survive a
 * switch"* — and it is refused by this table's own admission rule, which is why
 * the refusal is written down instead of being a silence. The three natives are
 * real and were re-read at the versions this build ships:
 *
 *  - claude carries `Settings.modelSettings`, *"Per-model settings keyed by
 *    canonical model name"*, each with a *"Persisted effort level for this
 *    model"* (the vendored `sdk.d.ts`; both self-reports say `2.1.251`);
 *  - Pi publishes `Settings.modelThinkingLevels` with the matching
 *    `SettingsManager` get/getAll/set/remove accessors (vendored `0.84.4`,
 *    provenance asserted from `packages/pi-agent-server`);
 *  - codex has no per-model memory at all: its effort is a role-layer
 *    `model_reasoning_effort` the host writes from the session's level.
 *
 * **It earns no row because the host consumes none of them, so there is no set
 * difference to state.** The host's effort is SESSION-level and its resolver has
 * no model dimension: `resolveEffortLevel` takes session, declared, invocation
 * and fallback and no model (`agent/thinking-levels.ts`, pinned by
 * `agent/__tests__/effort-precedence.test.ts`), and
 * `activeEffortLevelForModel(level, modelId)` reads the model only to WITHHOLD
 * (`supportsThinking: false`) or to CLAMP downward — never to look a stored
 * level up. All three runtimes call that one resolver: `pi-agent.ts` and
 * `CodexAgent.codexShellEffortEnvironment` directly, claude through
 * `resolveClaudeThinkingOptions`, which maps the same session level and clamps
 * it against the model's reported `supportedEffortLevels`. A switch therefore
 * neither creates nor cures this, exactly as the worktree rejection above.
 *
 * Each native was checked for a way in, because "the host does not use it" is
 * only half an answer when the runtime might be reached around us:
 *
 *  - **Pi's is unreachable BY CONSTRUCTION.** Every session is built with an
 *    in-memory settings manager whose *"native settings/package/extension
 *    discovery and persistence cannot feed construction"* (the harness-contract
 *    fixture states it and `pi-harness-baseline.test.ts` pins it), and since
 *    I2.29 every host model/thinking mutation passes
 *    `SESSION_ONLY_MODEL_MUTATION`. There is no file for a per-model level to
 *    live in.
 *  - **claude's IS loaded** — the host spells the documented triple
 *    `['user', 'project', 'local']`, so a hand-written `~/.claude/settings.json`
 *    is read — but the host passes an explicit `effort` on every turn where the
 *    model has an effort control at all, and an option the caller sets on the
 *    query is the stronger statement. **Whether `Options.effort` outranks a
 *    persisted `Settings.modelSettings` level is INSIDE the closed binary and is
 *    recorded here as a null rather than guessed**: searched the vendored
 *    `sdk.d.ts` (which documents both fields and no precedence between them) and
 *    `settings-reference.md`. If it ever turns out the settings file wins, the
 *    claude cell becomes `'unmeasured'` rather than `true` — an unmeasured
 *    SOURCE fires only into a target that lacks the capability outright, which
 *    is what both other cells would be.
 *
 * What WOULD earn a row, so the next lane does not re-derive this: I2.5's tier-2
 * half, a host store of effort PER MODEL. If it lands it must project onto all
 * three runtimes; a leg it cannot reach is a genuine set difference and belongs
 * in the table — with, per the parity rule above, a matching row in the TARGET
 * runtime's section of `runtime-capability-gaps.md`.
 *
 * ## Ranked by consequence, not by size
 *
 * `files` first, `abilities` second. A user skimming one dialog reads the top
 * of the list, so what happens to their working tree has to be there. The
 * array below is already in rank order and the order is asserted.
 *
 * Measured 2026-08-16 against `feat/models-fetch`, after R1–R3, R5, R6, R9,
 * R10, R12 and R13 landed. Each row carries the code that proves it; the file
 * coordinates drift, the mechanism names do not.
 *
 * RE-DERIVED 2026-08-31 (P4.6) from the current tool and capability sets rather
 * than from the row's own August description. Outcome, so a reader does not have
 * to re-run it: all six rows STAND with every `on` value unchanged, no seventh
 * row is owed (see the two rejections above), and the five surface counts below
 * were already correct — the row's instruction to "update the three tool counts"
 * was itself the stale part.
 *
 * What HAD gone stale, all under a green test, every one corrected in place and
 * each marked where it sits rather than counted here: the `guardianJudge`
 * control counts; the `scheduledRun` row's quoted reason, which cited a premise
 * T1 had refuted; this section's own "shipping Codex session" parenthetical; two
 * clauses that said the table holds five rows; and the header's reason for the
 * empty return leg, which implied Pi is a superset of the other two.
 *
 * The pattern is one thing: a NUMBER or a QUOTE written beside the value it
 * describes. The counts were pinned and stayed true; the sentences around them
 * were not and did not. So the quotes this module borrows are now pinned too, by
 * `__tests__/runtime-switch-costs-gaps-parity.test.ts`, ATTRIBUTED to the comment
 * block they came from — a quote whose source stopped saying it is the one kind
 * of rot both a count pin and a substring search let through.
 */

/**
 * A row's claim about one runtime.
 *
 * `null` is NOT "no", it is NO CLAIM — the tri-state P2.124 adopted from the
 * omnigent reference, whose capability record uses `None` for exactly this and
 * derives every per-runtime set from it. Here it marks a runtime that is not a
 * switch ENDPOINT at all: `nestor-cloud-agent` is neither a source nor a target
 * (`ComposerCapabilities.connection.switchable` is false for it), so a table
 * about what a switch COSTS has nothing to say about it, and saying `false`
 * would be a claim that it lacks the capability.
 *
 * `'unmeasured'` is the fourth value and it is not a second flavour of `null` —
 * the block below it says why (P6.562).
 */
type RuntimeSwitchClaim = boolean | 'conditional' | 'unmeasured' | null

/**
 * P6.562 — a cell we have NOT driven, and why `null` could not carry it.
 *
 * `null` means the runtime is not a switch endpoint at all, and
 * {@link isSwitchableRuntime} enforces exactly that: one `null` anywhere in the
 * table removes the runtime from BOTH ends of every direction, so
 * `runtimeSwitchCosts` returns an empty list and the dialog renders no cost
 * block. That is the right answer for `nestor-cloud-agent`, which is no
 * endpoint. It is the WRONG answer for a capability whose claim about a real
 * endpoint is honestly unknown: writing `null` there silences the runtime's
 * whole column, and the user reads "nothing listed" — the one reading this
 * module exists to prevent. The alternatives were worse in both directions:
 * `true` promises a capability nobody drove, `false` asserts an absence nobody
 * drove, and `'conditional'` names a per-session precondition that a merely
 * unmeasured cell does not have.
 *
 * So an `'unmeasured'` cell keeps the runtime an endpoint (the `!== null` test
 * is unchanged and deliberately so) and fires its row with
 * `certainty: 'unmeasured'`, which the dialog renders as *not measured* beside
 * the sentence rather than as silence.
 *
 * Which directions it fires in follows `'conditional'`'s rule, for the same
 * reason: an unmeasured TARGET fires (we cannot tell the user they keep it), an
 * unmeasured SOURCE fires only into a target that does not have the capability
 * outright — warning about losing something that may never have existed is
 * noise, but warning that we do not know whether they are losing it, when the
 * target definitely lacks it, is the honest half.
 *
 * ## P6.597 — the sweep that asked every `false` cell to show its measurement
 *
 * `'unmeasured'` arriving late means the cells written before it had to spell
 * *we do not know* as `false`, and a value chosen for want of a better one does
 * not announce itself. So every `false` cell in the table was re-read against
 * its own docblock and asked one question: **does this cite a measurement, or
 * does it argue that over-warning is safe?** The second is not evidence of an
 * absence — it is a firing rule wearing a claim's clothes.
 *
 * Twenty-one `false` cells, and **two moved**: `worktreeMove.anthropic` and
 * `scheduledRun.anthropic`, both of which rest on a Claude Code built-in that is
 * ADVERTISED to our session and whose delivery no live run has settled, and both
 * of whose docblocks said so in the same breath as *left at `false`*. Each row
 * records the move at its own site.
 *
 * The other nineteen cite a measurement and stay — a call site that does not
 * exist and is asserted not to, a set difference derived at test time from
 * `getSessionToolNames`, a struct enumerated at `rust-v0.148.0`, a compaction
 * trigger driven on the shipped binary. `policyKeys`' codex cell is the one that
 * had an admitted edge; it was measured for this sweep and stayed `false`.
 *
 * **A `false` that cannot show its measurement is the thing to look for here,
 * and the count of each value is pinned by
 * `__tests__/runtime-switch-costs-gaps-parity.test.ts` so a new cell has to be
 * counted deliberately rather than added quietly.**
 *
 * **Read the two numbers above as a READING WITH A DATE (2026-09-06), not as a
 * standing count — TWO MORE of the nineteen have moved since, and neither move
 * was the sweep finding a bad `false`.** `scheduledRun['codex-runtime']`
 * (P6.184) and `worktreeMove['codex-runtime']` (P6.137) went to
 * `'conditional'` because the HOST built the missing capability onto codex over
 * the callback bridge; both cells were correct measurements of codex when
 * written and are correct measurements of codex still. The live count is the
 * tally the parity suite pins; this paragraph records what the sweep asked, not
 * how many cells hold a value today.
 *
 * **And ONE of the sweep's own two has since been settled by a live run
 * (C3.251, 2026-09-12): `worktreeMove.anthropic` is `true`.** RS-28 drove
 * `EnterWorktree` on a claude card against a real repository at the packaged
 * 1.36.0 sitting and the tool succeeded, which is exactly the evidence
 * `'unmeasured'` was holding the place for. `scheduledRun.anthropic` is
 * untouched — nothing drove a notification — so the pair this paragraph
 * describes is now a pair only in history, and the tripwire in
 * `__tests__/runtime-switch-costs-native-claude-tools.test.ts` asserts the
 * SPLIT rather than the pair.
 */

/**
 * A capability the runtime has ONLY when a per-session precondition holds — and
 * one this table cannot evaluate, because the dialog is drawn before the target
 * session exists (P2.484).
 *
 * The fourth value exists for exactly one measured shape and is not a general
 * "maybe". `CodexAgent.startCallbackBridge` fails NON-FATALLY — on a missing
 * session or workspace id, and on any throw out of
 * `startCodexSessionCallbackBridge`, which ends in a `server.listen(0,
 * '127.0.0.1')` whose error path is real (AGENTS.md records that Electron does
 * not inherit the shell's `ulimit -n`, so an fd-hungry moment fails in the app
 * while every shell probe succeeds). It sets `schedulingBridgeState =
 * 'unavailable'` and the spawn then omits `--host-callback-port`, so the session
 * lives its whole life on the BARE 16-tool surface — 16 and not the 18 this
 * line carried until 2026-09-03, because P3.222 moved `list_sessions` and
 * `get_session_info` onto the bridged side and P6.303 then withheld the host
 * `TodoWrite` from a runtime that ships its own checklist (the header's own
 * paragraph on the counts records both measurements).
 *
 * **The rate is not measurable from here and this file does not pretend
 * otherwise.** What IS measured is that the failure is reachable and
 * deterministic on both arms — `agent/__tests__/codex-scheduling-bridge-state.test.ts`
 * drives `unavailable` from a missing identity and from a throw — and that the
 * two outcomes are indistinguishable to this module.
 *
 * So the claim is neither `true` (which under-warns: the module's one unsafe
 * direction, which is why P4.6 recorded this rather than leaving it) nor `false`
 * (which would say the runtime does not have the capability, and it usually
 * does). It fires as a cost, and the row's copy says *may* rather than *will* —
 * over-warning is the safe error for a notice meant to be trusted, the same rule
 * `guardianJudge` records for permission modes.
 *
 * A `'conditional'` SOURCE claim does not fire: see {@link runtimeSwitchCosts}.
 */

/**
 * The runtimes a session can move between — DERIVED, not hand-listed (P2.124).
 *
 * This was `const SWITCHABLE_RUNTIMES = ['pi', 'anthropic', 'codex-runtime']`,
 * one of the eleven hand-maintained per-runtime sites, and it had the shape that
 * inventory found almost everywhere: a runtime added to `ModelProvider` was
 * silently NOT switchable, and every one of the rows below kept compiling
 * because their `on` maps were total over this narrower list rather than over
 * the vocabulary. Two lists, and the narrower one hid the wider one's growth.
 * (This sentence said *the five rows below* until P4.6; the table has held six
 * since P2.315 added `guardianJudge`. A number written beside a list is the trap
 * AGENTS.md names, and it fired twice inside this one file.)
 *
 * There is now one list — the vocabulary — and each row is total over it. Which
 * runtimes are endpoints falls out of the rows themselves: a runtime is an
 * endpoint when the rows make a concrete claim about it. So the membership is
 * no longer stated anywhere and cannot drift from what the rows say.
 */
export type SwitchableRuntime = ModelProvider

/**
 * How much a missing capability costs, worst first.
 *
 * - `files` — it changes what happens to the user's working tree.
 * - `abilities` — it changes what the model can do for them.
 */
export type RuntimeSwitchCostConsequence = 'files' | 'abilities'

/**
 * How well we know the row we are about to show — P6.562.
 *
 * `'measured'` is every row this table has ever emitted: both endpoints carry a
 * driven claim. `'unmeasured'` says one of the two endpoints does not, and the
 * dialog marks the line so a caution is never read as a measurement.
 */
export type RuntimeSwitchCostCertainty = 'measured' | 'unmeasured'

export interface RuntimeSwitchCost {
  /** Stable id, for tests and for React keys. Never rendered. */
  id: string
  /** i18n key of the one-sentence body. May interpolate `toRuntime`. */
  bodyKey: string
  consequence: RuntimeSwitchCostConsequence
  certainty: RuntimeSwitchCostCertainty
}

/**
 * A row as WRITTEN, which is not a row as EMITTED.
 *
 * `Omit<…, 'certainty'>` and not `extends RuntimeSwitchCost`: P6.562's certainty
 * is a property of the ordered PAIR, computed by {@link switchCostCertainty}
 * from the two endpoints' claims, so a row cannot declare it — the same row is
 * measured on one leg and unmeasured on another. Writing it here would be a
 * second copy of something derivable, and the wrong one on half the legs.
 */
interface RuntimeSwitchCostRow extends Omit<RuntimeSwitchCost, 'certainty'> {
  /**
   * Which runtimes have this capability. A row fires when `from` has it and `to`
   * does not.
   *
   * TOTAL over the runtime vocabulary (P2.124): `Record`, not `Partial<Record>`
   * and not a record over a narrower hand-kept subset, so a runtime added to
   * `ModelProvider` breaks the build on EVERY row at once — which is the whole
   * property. Deliberately not a number: this clause said "all five rows" while
   * the table held six. `null` means no claim; see {@link RuntimeSwitchClaim}.
   */
  on: Readonly<Record<ModelProvider, RuntimeSwitchClaim>>
}

/**
 * The inventory. In rank order: `files` rows, then `abilities` rows.
 *
 * Every `false` below is an absence, and every absence was measured with an
 * unbounded `grep -a` or by enumerating the tool projections themselves —
 * `getSessionToolNames` returns 69 names under `projection: 'pi'`, 61 with no
 * projection (Claude), 16 under `externalStandaloneOnly` (an external
 * standalone subprocess with no host-callback bridge) and 43 with
 * `hostCallbackBridge` (what a shipping Codex session runs WHEN ITS BRIDGE
 * STARTED, since T5 passes the port on the spawn).
 *
 * **P3.278 · the bare figure read 18 in FOUR places in this file until
 * 2026-09-03, and the pin had said 16 since P3.222 (`cfe66e51e`, 2026-09-02).**
 * That is exactly the rot the closing paragraph of this header describes, one
 * cycle later and in the same file that describes it: the counts under a test
 * moved, every prose copy of them did not, and the suite stayed green because no
 * test read the prose. Re-measured 2026-09-03 — 54 / 46 / 16 / 27, and 28 with
 * `advisorConsultBridge`. 18 → 16 is a CORRECTION and not a narrowing: P3.222
 * moved `list_sessions` and `get_session_info` onto the bridged side because
 * bare codex could not honour either, so two offers it could never keep stopped
 * being advertised.
 *
 * The counts in this docblock are therefore no longer only transcribed. They are
 * re-derived from `getSessionToolNames` and matched against this file's own text
 * by `__tests__/runtime-switch-costs-surface-counts.test.ts`, which is the one
 * instrument none of the five previous corrections had — a count pin in another
 * package cannot see a sentence here, and a substring search cannot see a number
 * that is merely WRONG rather than missing.
 *
 * **That condition is real, and P4.6 narrowed this parenthetical for it — it
 * used to read *what a shipping Codex session actually runs*.**
 * `CodexAgent.startCallbackBridge` fails NON-FATALLY: on a missing session or
 * workspace id, and on any throw out of `startCodexSessionCallbackBridge`, it
 * sets `schedulingBridgeState = 'unavailable'`, logs "scheduling tools stay
 * unavailable this session" and returns `undefined`. Such a session lives its
 * whole life on the 16-tool surface. The table is derived from the BRIDGED
 * surface (`__tests__/runtime-capability-drift.test.ts`), which is right for the
 * ordinary case and UNDER-warns that one — the unsafe direction, and the only
 * place in this module where the error goes that way. Recorded rather than
 * fixed, with the reason: the dialog is drawn BEFORE the target session exists,
 * so there is no bridge state to read yet; the failure is named where it happens
 * by the codex agent's own diagnostic, and widening the table on a condition it
 * cannot observe would over-warn every ordinary switch instead.
 *
 * Re-measured 2026-08-23 after T3 projected `Monitor` and the four scheduling
 * tools onto Claude (38 → 43, exactly those five), after T5 carried the same
 * five to Codex over the bridge (18 → 23), and after P3.10 carried `ProcessStop`
 * across too (23 → 24) so a persistent codex watch is model-stoppable. Pi was
 * unchanged throughout — it already advertised them. P2.1 then added
 * `advisor_consult` to Pi and Claude (53 → 54, 43 → 44) and to neither Codex
 * surface: the consult runs on the backend's own `queryLlm`, which an external
 * standalone subprocess does not have. P2.2 made the goal host-side and
 * projected `Goal`/`GoalGet` off `pi-only` onto Claude (44 → 46) and, over the
 * bridge, onto Codex (24 → 26); Pi was again unchanged.
 *
 * **P3.13 then falsified the P2.1 sentence above, on its own axis** (corrected
 * P2.211, re-measured 2026-08-27): the advisor DOES cross to Codex now, not by
 * ceasing to be a backend tool but by riding one of the bridge's own routes
 * under a second flag. `advisorConsultBridge` is ANDed with `hostCallbackBridge`
 * in `getSessionToolDefs`, so a spawn told about the advisor with no bridge
 * lifts nothing, and a spawn with both advertises 44 — the 43 plus exactly
 * `advisor_consult`. The P2.1 sentence is kept rather than deleted because the
 * REASON it gave is still the live one for `call_llm`, `spawn_session` and
 * `browser_tool`, which stay withheld on both Codex surfaces.
 *
 * All five numbers are pinned by
 * `session-tools-core/src/scheduling-projection.test.ts` (69 / 61 / 16 / 43 /
 * 44 — the first two and the fourth and fifth moved by two on 2026-10-15 (UB7.11: `source_list_prompts`, `source_get_prompt`), by one on 2026-10-14 (UB1.12: `project_memory_append`), after the six on 2026-10-02 (UA6.3: the six page tools), by one earlier that day (UA3.5: `create_board_task`) and by two before that (UA1.18: `publish_artifact`, `list_artifacts`); the fourth and fifth by two earlier that day (UA1.3: `set_session_status`, `set_session_labels`) and on 2026-08-30 when `6173c9778` carried
 * `send_agent_message` over the bridge, and the pins moved with it; UB6.11
 * (2026-10-15) added `decide` to the bridged set PORT-GATED (offered only under
 * `decidePort`, which the codex spawn derives from `--decide-port` — emitted only
 * when the decision layer is configured), so NONE of the five numbers moved; the THIRD
 * moved on 2026-09-02 when P3.222 took the bare surface 18 → 16, and that pin
 * moved with it while every prose copy of it in this file did not; the SECOND
 * moved on 2026-09-13 when C3.329 (`b6b8e1be1`) lifted `WorktreeBatch` off
 * pi-only and the claude surface went 48 → 49, which left
 * `runtime-switch-costs-surface-counts.test.ts` red at HEAD until C4.49's
 * commit re-read both prose copies — the third cycle of exactly the rot the
 * closing paragraph below describes, and the first one a test caught), so this
 * comment cannot rot silently the way a prose count usually does — and the
 * counts are the only part of it that enjoys that protection. The
 * SENTENCES around them do not: two of them have now gone stale under a test
 * that stayed green, because a count and a claim about WHY are different
 * propositions.
 */
const RUNTIME_SWITCH_COSTS: readonly RuntimeSwitchCostRow[] = Object.freeze([
  /**
   * Nessy inspects the call BEFORE the runtime runs it.
   *
   * Pi and Claude both route every tool call through `runPreToolUseChecks`
   * (`pi-agent.ts` at its own gate, `claude-agent.ts` inside the SDK's
   * `PreToolUse` hook), so a read-only mode and a permission rule are decided
   * before anything executes. `codex-agent.ts` has NO such call, and that is
   * what this row claims.
   *
   * ## The reason this row gave was stale for two waves — P6.65 (2026-09-06)
   *
   * It read *"measured with `grep -ac runPreToolUseChecks … codex-agent.ts` →
   * 0"*, and the published command now returns **1**: the single hit is a
   * comment recording that the call sites are zero. A grep count is not the
   * claim — it decays in BOTH directions, reading as a regression when a comment
   * lands and as a pass when a call site does. The claim is written as *no call
   * site* instead, and that is what
   * `packages/shared/src/agent/__tests__/mode-guidance-runtime.test.ts` asserts:
   * every occurrence of the identifier in that file is a comment line.
   *
   * ## What is NOT missing, and why the row still stands
   *
   * Four shared floors DO run on codex, and have since P2.140 (`bd12361a9`)
   * extracted them into `agent/core/pre-tool-use.ts` and P2.197 (`b15c92b1f`)
   * made `untrusted` raise the calls — a routing upstream withdrew at
   * `rust-v0.150.1` (P7.2), so with the sandbox master switch off these four now
   * run only for the calls codex still raises, dangerous commands and
   * sandbox-escalation requests rather than every command: the root/home removal
   * circuit breaker, the
   * `Remove-Item` ladder, the protected-path write and the shell-`eval`
   * construct, scored by `CodexAgent.floorVerdict` through the SAME
   * `findNonNegotiableFloors` / `firstNonNegotiableFloor` pair the other two
   * runtimes use. P6.61 (`45b47c723`) emptied
   * `CODEX_MODES_KEEPING_ON_REQUEST_UNBOUNDED`, so that now holds in ALL SEVEN
   * modes — this paragraph said *six of seven* until then, and
   * `bypassPermissions` was the exception.
   *
   * So what is lost is the rest of the pipeline — the read-only mode decision,
   * the allowlist, the rule DSL's `ask`, everything that runs before a call the
   * runtime would never have raised — and the ORDER: codex decides what to raise
   * and we decide what happens to what it raised. The copy is written about that
   * and not about "no safety on codex", which would now be false.
   *
   * Stated at the strength it is proven: what is measured is who decides FIRST.
   * Whether a given write then reaches a card is Codex's own judgement, and
   * nothing in this repo executes Codex to settle that.
   */
  {
    id: 'preToolCheck',
    bodyKey: 'chat.runtimeSwitch.costPreToolCheck',
    consequence: 'files',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A `PreToolUse` hook can PAUSE a call and resume it later.
   *
   * P6.296. Pi and Claude both deliver the defer/resume vocabulary —
   * `agent/pi-harness/deferred-tool-call.ts` on one side, `deferred_tool_use`
   * read in `agent/backend/claude/event-adapter.ts` on the other. Codex has no
   * such vocabulary at all: `grep -rl 'Defer'` over
   * `packages/codex-protocol/generated/v2/` (562 generated files, 23 of them
   * hook types) returns ZERO files, against 33 for `Approval` as the positive
   * control on the same command and the same tree (re-measured 2026-09-07).
   * Codex's approval is answered in band, so a hook returning `"defer"` has
   * nothing to hold the call open with.
   *
   * Placed beside `preToolCheck` because it is the same axis — what the host may
   * do to a call before it runs — and `files` for the same reason: a hook that
   * stops pausing lets a write through at a moment the user meant to postpone.
   *
   * This row prices the SURFACE only. Holding the call open host-side is a
   * larger question and is deliberately not proposed here: what the switch costs
   * today is that a hook the user already wrote silently stops pausing.
   */
  {
    id: 'preToolDefer',
    bodyKey: 'chat.runtimeSwitch.costPreToolDefer',
    consequence: 'files',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * The operator's fence on reads outside the working directories.
   *
   * P6.928 (owner ruling 2026-09-10), born from P6.880 / W9-r. The fence is
   * `permissions.blockReadsOutsideWorkingDirectories`, a documented Claude Code
   * setting the HOST enforces for all of its own runtimes:
   * `getReadsOutsideWorkingDirectoriesViolation` (`agent/mode-manager.ts`) keys
   * on `READS_OUTSIDE_WORKING_DIRECTORIES_TOOLS` — `Read`/`Grep`/`Glob` from the
   * page's own vocabulary plus Pi's `Find`/`Ls` — and it is reached from the two
   * gates that take an ARBITRARY tool name, `runPreToolUseChecks`
   * (`agent/core/pre-tool-use.ts`) and `PermissionManager.checkPermission`.
   * Pi and claude both route their file tools through those gates; the fence
   * therefore binds on both, and P6.202 clause (3) additionally asks once on the
   * first outside read in `auto`.
   *
   * **ABSENT BY DESIGN on codex, and the design is codex's, not a gap we left.**
   * Codex performs those reads with its OWN built-ins inside the app-server, and
   * `packages/codex-protocol/generated/ServerRequest.ts` — the complete set of
   * requests codex initiates toward this client — has TEN methods, of which the
   * two approval members are the positive control and NONE is a read approval.
   * So there is no call for a host gate to intercept: `codex-agent.ts` carries
   * no `runPreToolUseChecks` call site, and adding one would not put a subject in
   * front of it.
   *
   * **The native mechanism was measured and REFUSED as a projection, by the
   * owner.** Codex's own `[permissions.<profile>.filesystem]` is OS-enforced and
   * carries a real three-value `read`/`write`/`deny` with `deny` beating `write`
   * beating `read` (`config-schema.json`), and `resolveCodexRuntimePathPolicy`
   * already emits a profile for every real session. Projecting the fence into it
   * means denying the WHOLE filesystem and granting `read` back on the working
   * roots — which would also refuse toolchains, caches, `$HOME` and every path
   * outside the project, none of which the fence is about. That is a product
   * posture, and the ruling took the balance rule's answer: codex stays on its
   * native mechanism, nothing is projected, and the difference is made HONEST
   * here instead — which is the second half of the native-first rule (AGENTS.md
   * §"Native-first, and the host is the smooth seam"), the half whose omission is
   * this fork's largest defect class.
   *
   * Why a row of its own rather than a clause of `preToolCheck`: that row is
   * about WHO DECIDES FIRST, and a user who reads it learns that codex decides
   * what to ask about. It does not tell them that a setting they turned on, and
   * which the settings surface still shows as on, stops having a subject. The
   * two are different propositions and only one of them is a setting the user
   * owns.
   *
   * `files`, because the fence is about what gets READ off the user's disk, and
   * a read outside the working directories is the exfiltration half of the same
   * axis the write floors cover. Measured on both endpoints, so no `unmeasured`
   * cell: the two gates are read from source, and codex's absence is read off the
   * generated request union with its own positive control.
   */
  {
    id: 'readFence',
    bodyKey: 'chat.runtimeSwitch.costReadFence',
    consequence: 'files',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * The Guardian safety judge reviews the action after the rules have.
   *
   * P2.315. The row above is the deterministic gate; this is the classifier on
   * top of it, and it is OURS — `agent/core/guardian-judge-core.ts` +
   * `core/guardian-consult.ts` + `prompts/guardian.ts`, consulted from
   * `pi-agent.ts` and nowhere else. Measured with `grep -ac` on the three
   * backends (re-measured 2026-08-31, P4.6): `consultGuardian` → pi 6, claude 0,
   * codex 0, against a file-level positive control on the same command,
   * `export` → pi 13, claude 59, codex 35. The two zeros are the claim and they
   * have not moved; the CONTROL's numbers had, and were written here as 45 and
   * 19 for three days — they are a reading with a date, and the thing that
   * actually holds them is `__tests__/runtime-capability-drift.test.ts`, which
   * asserts `guardianCounts.pi > 0` before believing the other two. Claude's
   * absence is additionally ENFORCED rather than incidental —
   * `__tests__/claude-agent-guardian-free.test.ts` asserts the source does not
   * contain the word.
   *
   * **Direction of the loss, because it inverts by permission mode.** In `auto`
   * and `plan` the judge only converts a would-ask into allow/deny, so a target
   * without it falls back to asking a human — fail-safe. In `bypassPermissions`
   * ("Allow all") nothing else asks, and the judge's deny-net over four
   * categories (secret exfiltration, credential probing, destructive
   * operations, protected-branch git — `settings.ai.guardian.enabledDesc`) is
   * the only thing between the model and them. The copy is therefore written
   * about Allow all, which is the case where the absence changes an outcome.
   * The table has no mode dimension, so the row fires on every switch out of
   * Pi; that over-warns in the other modes, which is the safe direction for a
   * notice meant to be trusted (same rule the `scheduledRun` row records).
   *
   * ## NOT the same thing as Codex's own auto-review guardian — and the note
   * used to imply codex has nothing (P6.65, ledger A1-host)
   *
   * Codex ships a model-backed approval reviewer of its own, we already wire it
   * (P3.2 writes `approvals_reviewer = "auto_review"` and `[auto_review].policy`
   * through `config-writer.ts`), and `codex-agent.ts` relays an OVERRIDE to it
   * (`/approve` → `thread/approveGuardianDeniedAction`). It is **default OFF and
   * opt-in**: `getCodexAutoReviewEnabled()` (`config/storage.ts`) falls through
   * to `config-defaults.json`'s `codexAutoReviewEnabled: false`, and
   * `CodexAgent` passes the key only when that reads true AND the resolved
   * approval policy is interactive.
   *
   * The scope note therefore had to change, because *"Claude Code and Codex
   * sessions are not covered yet"* reads as *neither has a judge* when only one
   * of the two statements is about a missing judge. It now reads:
   *
   *   "Runs on Pi-agent sessions only — Claude Code sessions are not covered.
   *    Codex ships its own auto-review guardian instead, off by default and
   *    switched on under Codex auto-review below."
   *
   * **It said *administrator* until P6.571, and the reason is worth keeping:**
   * when P6.65 wrote the sentence, `codexAutoReviewEnabled` had NO user-reachable
   * control anywhere in the renderer — every reference was `config/storage.ts`,
   * `validators.ts`, `config-defaults-schema.ts` and the two
   * `config-defaults.json` copies. A setting a user cannot reach is not a setting
   * they can be pointed at, so the note named the only person who could reach it
   * and the gap was rowed rather than papered over.
   *
   * **P6.225 closed that gap (`3101b7a92`):** the Codex auto-review section now
   * sits on the SAME settings page, directly below Guardian, with the toggle and
   * the policy textarea bound to those two keys. So the note names the switch's
   * place rather than a person the reader usually is not — *below* is literal,
   * and `AiSettingsPage.tsx` renders the two sections in that order. The default
   * is untouched: `getCodexAutoReviewEnabled()` still falls through to `false`.
   *
   * This row's own claim is unchanged by any of that: OURS does not run on
   * either vendor runtime. What was missing is that a user meets the scope note
   * in Settings and never at the switch, which is the one moment they are
   * choosing to give it up.
   *
   * ## What DOES judge on each runtime (C3.1, owner answer QA1 = C, 2026-09-11)
   *
   * Pi: this row's Guardian, ours, consulted from `pi-agent.ts` and nowhere
   * else. Claude: our own deterministic gate — the PreToolUse rules every
   * runtime shares — because the binary's native classifier is configured and
   * consulted on approximately nothing (`claude-auto-mode-policy.ts`; P3.93, and
   * P3.139 closed as an owner decision whose refusal the owner confirmed on
   * 2026-09-11). Codex: `auto_review`, its own, off by default. Every session is
   * judged by something; what changes across a switch is BY WHAT, which is what
   * this row's `false` on two columns means and does not say.
   */
  {
    id: 'guardianJudge',
    bodyKey: 'chat.runtimeSwitch.costGuardian',
    consequence: 'files',
    on: { pi: true, anthropic: false, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A run of refused actions ends Auto mode by itself.
   *
   * P6.201. Pi counts FRESH classifier denials per session and, at three in a
   * row or twenty in total, calls `setPermissionMode('default')` — the session
   * drops to Manual and starts prompting again (`pi-agent.ts:6238-6248`). That
   * is the capability this row prices, and it is Pi's alone.
   *
   * ## Two refinements to the row's own premise, both from reading
   *
   * The row calls them "three auto-mode denial breakers with three different
   * thresholds". There are TWO threshold sets: `CodexAutoReviewBreaker` IMPORTS
   * `GUARDIAN_CONSECUTIVE_DENY_LIMIT` (3) and `GUARDIAN_WINDOW_DENY_LIMIT` (10
   * of 50) from `core/guardian-consult.ts`, the same pair Pi's per-turn circuit
   * breaker uses; the second set is `autoClassifierBlocks`' own 3/20. And there
   * are TWO mechanisms on Pi: the shared per-turn breaker falls the TURN back to
   * the prompt, and only the session-scoped counter above it changes the MODE.
   * A turn falling back to a prompt is not a switch cost — the other runtimes
   * ask too. A mode changing itself is.
   *
   * ## Why codex is `false` although it counts
   *
   * Codex's breaker is REPORT-ONLY: it opens a turn-scoped circuit and emits one
   * notice, and codex's own reviewer is the authority that hands control back.
   * The user's mode is untouched, which is the thing this row is about. Marking
   * codex `true` would promise a mode change that never comes.
   *
   * ## Why claude is `false`, measured rather than assumed
   *
   * `GuardianConsultState` / `registerConsult` resolve to seven files —
   * `pi-agent.ts`, `core/guardian-consult.ts`, `core/index.ts`,
   * `mode-manager.ts`, codex's breaker and two tests — and NONE of them is
   * claude's, while the binary's own classifier stays off under P3.139. Nothing
   * counts, so nothing can trip.
   *
   * The closure the row asks for is DECLARE, explicitly not lifting Pi's
   * counters onto the other two. The model-facing half landed with
   * `formatAutoDenialBreakerClause` (`mode-manager.ts`); this is the user-facing
   * half, and the copy is deliberately the same claim so the two cannot drift.
   */
  {
    id: 'autoDenialBreaker',
    bodyKey: 'chat.runtimeSwitch.costAutoDenialBreaker',
    consequence: 'files',
    on: { pi: true, anthropic: false, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * The model can move the session into a separate git worktree.
   *
   * `EnterWorktree` / `ExitWorktree` are `visibility: 'pi-only'` in
   * `session-tools-core/src/tool-defs.ts`, and the comment there records why it
   * is not an oversight: "claude already ships both the tool and its own
   * approval floor while codex publishes no worktree surface at all, and
   * `visibility` is `pi-only` or `not-pi` with no third value, so one lift
   * reaches both runtimes at once." So on Codex the model edits the workspace
   * directly.
   *
   * **P6.841 — the sentence above is a REPLACEMENT, and the row's cell did not
   * move.** Until now this paragraph quoted the R2-era reason, which named the
   * Pi permission gate as the home of the floor these tools depend on. P6.799
   * measured that half-false: the floor is `evaluateWorktreeApproval` in the
   * host-side `core/pre-tool-use.ts`, `claude-agent.ts` already routes every
   * call through `runPreToolUseChecks`, and without the Pi-only INPUT
   * (`worktreeGateContext()`, one call site) it fails CLOSED — so a lift could
   * never have shipped an unguarded move, only a permanently-refusing tool.
   * What survived is the codex half plus native-first, which is what the new
   * sentence says. `runtime-switch-costs-gaps-parity.test.ts` swaps the
   * `ATTRIBUTED_QUOTES` entry in the same commit and pins the refuted wording
   * as an absence in BOTH files — the shape P6.52 used for the port premise.
   *
   * **The Claude half was already UNDER CHALLENGE since P6.52, and the
   * challenge is this file's own argument turned on this row.** The
   * `pi-only`-tools rejection section above clears the four `Task*` tools on the
   * ground that "Claude advertises the same four NATIVELY", measured in the
   * vendored `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`. `EnterWorktreeInput`
   * and `ExitWorktreeInput` are declared in that same file, `CLAUDE_SESSION_DISALLOWED_TOOLS`
   * does not subtract them, and the SDK's own settings type describes the
   * mechanism in prose — "'worktree' (default) blocks Edit/Write in the main
   * checkout until EnterWorktree is called". By the evidence this file already
   * accepts, a claude session's model CAN move itself into a worktree; what it
   * cannot use is OURS, with the Pi approval floor the quote above names.
   *
   * **P6.597 — the claude cell is `'unmeasured'`, and `false` was the wrong
   * spelling of the paragraph above.** That paragraph already says the evidence
   * is that the tools are ADVERTISED and that no live run has settled delivery,
   * and {@link RuntimeSwitchClaim}'s own block says `false` "asserts an absence
   * nobody drove" — which is precisely what this cell was doing. The vocabulary
   * could not say *we do not know* when this row was written; P6.562 gave it
   * one, so the cell says it. **The change withholds nothing:** Pi → claude
   * still fires, now carrying the *not measured* marker instead of passing as a
   * measurement, and claude → codex fires too — the honest half of
   * {@link switchCostCertainty}'s rule, because codex lacks the capability
   * outright. The flip to a definite claim, if a live run earns one, is still
   * one `on` value plus a copy re-cut, and
   * `__tests__/runtime-switch-costs-native-claude-tools.test.ts` pins the
   * overlap so the challenge cannot be lost again.
   *
   * NOT the same thing as an AGENT's declared `isolation: 'worktree'`, which
   * R12 made Claude honour. That one is carried; this one is the model asking
   * mid-session.
   *
   * ## P6.137 — the codex cell moved from `false` to `'conditional'`
   *
   * It was `false` on the honest "the runtime cannot", and that half is
   * UNCHANGED about codex itself: the shipped `codex-app-server` publishes no
   * worktree surface at all (`worktree` 0 files in `packages/codex-protocol`,
   * `WorktreeCreate` 0 in the binary, `preToolUse` 3 files as the control —
   * P2.497's readings, re-run 2026-09-08).
   *
   * What changed is that the HOST now carries ours to it. The four
   * `HOST_CALLBACK_BRIDGE_ROUTES.worktree*` routes reach the same
   * `createSessionWorktreePort` object Pi and the Claude in-process path reach,
   * and `SessionToolFilterOptions.worktreePort` — ANDed with the bridge —
   * advertises the three tools to that spawn and to no other surface. The
   * missing FLOOR came with them: `SessionManager.authorizeWorktreeEnter`
   * consults `evaluateWorktreeApproval`, the same function
   * `runPreToolUseChecks` consults, because that pipeline has zero call sites in
   * `codex-agent.ts` (measured 2026-09-08; `claude-agent.ts` 1, `pi-agent.ts`
   * 6). Native-first step 1 found nothing; step 2 supplied it once, in the host.
   *
   * `'conditional'` and not `true`, for `scheduledRun`'s exact reason and by the
   * same mechanism: `CodexAgent.startCallbackBridge` fails NON-FATALLY, and a
   * session whose bridge did not start lives its whole life on the bare surface
   * with no route to enter a worktree over.
   *
   * ## C3.251 — the claude cell is `true`, and a LIVE RUN earned it
   *
   * It was `'unmeasured'` on the honest reading that the tools are ADVERTISED
   * and delivery had never been driven. It has been driven. RS-28 ran at the
   * packaged 1.36.0 release sitting on 2026-09-11 (`152f4035e`, pass 2) and its
   * arm A issued `EnterWorktree` against a real repository on a claude card: the
   * tool SUCCEEDED, the worktree was created, and the control was green. So the
   * runtime's own tool delivers the capability this row is about, and the cell
   * that said *we do not know* is the only one of the two P6.597 moved that can
   * now say more. `scheduledRun` is untouched and stays `'unmeasured'` —
   * nothing drove a notification.
   *
   * `true` and not `'conditional'`: arm B's failure was a directory that is not
   * a repository, which is the same precondition Pi's `true` already carries,
   * not a per-session mechanism that may or may not start (`scheduledRun`'s and
   * the codex cell's reason).
   *
   * **What the same run settled about the FLOOR, recorded here because it is
   * the half a reader of this row will assume wrong:** the SDK does NOT put its
   * native `EnterWorktree` through our `canUseTool` — P6.839's residual,
   * answered NOT ROUTED. The words a user meets are the runtime's own
   * (*"WorktreeCreate hook failed: hook succeeded but returned no worktree
   * path"*). The host is in the path anyway, by a different road: a
   * `WorktreeCreate` hook. So `buildClaudeWorktreeFloorContext` (P6.839,
   * `3b9c7fec5`) is not what makes this cell `true`, and the hook-author wording
   * a user meets in a non-repository is follow-up row `D1.128`.
   *
   * **What the user stops being told, which is the point of the flip:**
   * Pi → claude no longer lists this row at all. Ours is still withheld on
   * claude on purpose — the runtime ships its own with its own documented,
   * non-suppressible prompt — but a switch cost is a capability LOST, and this
   * one is not lost. Claude → codex keeps the row and is now a plain
   * measurement instead of a caution, and codex → claude drops it: we do not
   * warn about gaining something.
   */
  {
    id: 'worktreeMove',
    bodyKey: 'chat.runtimeSwitch.costWorktree',
    consequence: 'files',
    on: { pi: true, anthropic: true, 'codex-runtime': 'conditional', 'nestor-cloud-agent': null },
  },
  /**
   * Credential files are excluded by the OPERATING SYSTEM, not by a tool of ours
   * — and this is the FIRST row whose capability belongs to codex.
   *
   * P6.65, ledger A4-host. Every other row in this table is something Pi has;
   * this one fires only on the way OUT of codex, which is why the header's
   * "switching back onto Pi lists nothing" paragraph had to be amended in the
   * same commit that added it.
   *
   * ## The set difference, and how much of it survived HEAD
   *
   * P3.175 (`204892490`) mirrored the 19 `deniedPaths` entries into codex's own
   * `permissions.filesystem`, which codex expands and enforces at the OS layer
   * for everything the app-server does — its `shell` included. Pi and Claude
   * enforce the same list through OUR gate, on the request
   * (`getDeniedPathViolation` reads `path`/`file_path` and, for a `Bash`
   * subject, the command's own path tokens) and now on the RESULT as well.
   *
   * **The ledger's wording for this row is wider than HEAD, and the row is
   * written to HEAD.** A4's Switch cell says a switch away from codex "silently
   * drops OS-enforced exclusion from search results and directory listings".
   * Two things closed under it: Pi has filtered its own search and listing tools
   * for some time (`filterDeniedResultPaths`, supplied at
   * `pi-agent-server/src/index.ts` and consumed at five sites in
   * `agent/local-tools/runtime.ts`), and P6.63 (`3ab16fcbf`, 2026-09-05) closed
   * the claude half through the PostToolUse hook's `updatedToolOutput`
   * (`claude-search-result-filter.ts`, `CLAUDE_SEARCH_RESULT_TOOLS = ['Grep',
   * 'Glob']`). So the model's own search and listing tools now withhold denied
   * paths on all three.
   *
   * What does NOT survive is the SHELL. Ours is tool-mediated: a `Bash` command
   * that walks a directory ABOVE a denied entry — `grep -r … ~`, `ls -R` — names
   * no denied path in its argv, so nothing matches and the output comes back
   * whole. A4's own cell records the same asymmetry as P3.105, open. Codex's is
   * OS-enforced, so the same command inside a codex session is refused by the
   * kernel. That is the capability this row is about, and the copy says exactly
   * it rather than the wider sentence the ledger still carries.
   *
   * ## Two readings with dates, kept because they bound the claim
   *
   * On Linux a root-anchored deny reports `allowed: true` and then every
   * sandboxed exec dies at `error building bubblewrap command` — the sandbox
   * failing to exist rather than a deny working (P3.308, `850443b69`) — and a
   * denied read there is exit 0 with empty stdout where darwin answers
   * `Operation not permitted`. So the row over-warns on a Linux deployment whose
   * sandbox cannot be built, which is the safe direction and the same rule
   * `guardianJudge` records.
   *
   * The `on` map is a claim about the OS-enforced exclusion and nothing else. It
   * is not a claim that codex is safer overall: the row above says nothing of
   * ours sees a codex call first, and both are true at once.
   */
  {
    id: 'credentialShellFloor',
    bodyKey: 'chat.runtimeSwitch.costCredentialShellFloor',
    consequence: 'files',
    on: { pi: false, anthropic: false, 'codex-runtime': true, 'nestor-cloud-agent': null },
  },
  /**
   * Codex's own model-backed approval reviewer.
   *
   * P6.225, ledger A66. The native mechanism is codex's and it is already
   * adopted whole — `config-writer.ts` writes `approvals_reviewer = "auto_review"`
   * and `[auto_review].policy`, `CodexAutoReviewBreaker` opens a turn-scoped
   * circuit when it refuses too often, and `codex-agent.ts` relays `/approve` as
   * `thread/approveGuardianDeniedAction`. Nothing here was built beside it; what
   * the row prices is that a switch AWAY from codex retires the whole of it.
   *
   * ## Why this is a second row and not the `guardianJudge` one inverted
   *
   * `guardianJudge` prices OUR judge, which is Pi's alone, and fires out of Pi.
   * This one fires out of CODEX, and the two capabilities are not the same
   * mechanism seen from two ends: ours consults a model we choose on a
   * connection the user configures, codex's runs inside the app-server on its
   * own model with a policy string. A single row could not carry both, because
   * `on.pi` and `on['codex-runtime']` would both have to be `true` and the row
   * would then fire on NEITHER of the two legs where something is actually lost.
   *
   * ## Claude is `false`, measured the same way `autoDenialBreaker`'s was
   *
   * The reviewer is a codex CONFIG-FILE key. Nothing in the claude path composes
   * a `config.toml`, `CODEX_*` names are not forwarded to the claude child, and
   * the binary's own classifier stays off under P3.139 — so there is no
   * approval reviewer on that runtime to inherit the policy.
   *
   * ## The user-visible half the row exists for, and what is still owed
   *
   * The copy says two things because both are lost together: the reviewer stops
   * judging, and **the policy text stops being read by anything**. A user who
   * wrote a reviewer policy has authored a rule; a switch silently retiring an
   * authored rule is the exact shape this table exists to price.
   *
   * `guardianJudge`'s docblock records that `codexAutoReviewEnabled` once had NO
   * user-reachable control anywhere in the renderer, which is why the guardian
   * scope note used to say *administrator* rather than naming a switch. **That
   * is no longer true:** P6.225 (`3101b7a92`) shipped the Codex auto-review
   * section — toggle plus policy textarea — on the AI settings page, and P6.571
   * re-cut the scope note to point at it. So a user who authored a reviewer
   * policy authored it at a control they can see, which makes the loss this row
   * prices strictly sharper, not weaker: the switch is still the moment it
   * happens, and now the thing being retired has a visible home.
   *
   * ## `codex-runtime: true` although the reviewer is OPT-IN, and the direction
   *
   * `getCodexAutoReviewEnabled()` falls through to `config-defaults.json`'s
   * `codexAutoReviewEnabled: false`, and `CodexAgent` passes the key only when
   * that reads true AND the resolved approval policy is interactive. So the
   * capability is an install setting, and this table has no setting dimension —
   * exactly the shape `guardianJudge` records for permission mode, and the same
   * resolution: the row fires on every switch out of codex, which over-warns for
   * an install that never turned the reviewer on.
   *
   * That is the safe direction and it is deliberately not `'conditional'`.
   * `'conditional'` on a SOURCE does not fire at all ({@link switchCostCertainty}),
   * so choosing it here would silence the row on both legs where the loss is
   * real — the value exists for a conditional TARGET, and this condition sits on
   * the source. The cost of over-warning is one line a user did not need; the
   * cost of under-warning is an authored approval policy retired in silence.
   *
   * `files` and not `abilities`: what changes is who decides whether an action
   * is allowed to touch the working tree, which is `guardianJudge`'s class.
   */
  {
    id: 'codexReviewer',
    bodyKey: 'chat.runtimeSwitch.costCodexReviewer',
    consequence: 'files',
    on: { pi: false, anthropic: false, 'codex-runtime': true, 'nestor-cloud-agent': null },
  },
  /**
   * A subagent Pi would isolate in its own git worktree runs in the session's
   * own directory on both vendor runtimes.
   *
   * P6.128, ledger H7/host. Not the same row as `worktreeMove` two entries
   * above: that one is the MODEL asking to move the session mid-conversation,
   * through `EnterWorktree`. This one is the HOST deciding, before a subagent
   * ever runs, that its writes must not land in the user's checkout — and it is
   * the case `worktreeMove`'s own docblock disclaims ("NOT the same thing as an
   * AGENT's declared `isolation: 'worktree'`").
   *
   * ## The divergence is wider than the declaration, which is why it is a row
   *
   * `piRuntimeAgentWorktreePolicy`
   * (`packages/shared/src/agent/pi-harness/runtime-agent-definition.ts`)
   * isolates any definition whose declared tools are not a READ-ONLY subset —
   * the tool-LESS shape included, because `isReadOnlySubagentToolGrant` returns
   * false for `undefined`, on the reason its own docblock gives: *"A tool-less
   * definition INHERITS the parent's pool, which is not read-only"*. So the
   * population is "declared `isolation: worktree` OR any non-read-only or
   * tool-less `tools`", which is most agents a user imports.
   *
   * Claude forwards only the DECLARATION and does so deliberately
   * (`claude-runtime-agents.ts`, whose own comment says Pi's tools rule *"is
   * deliberately NOT mirrored here"* because Claude's documented baseline is the
   * parent's working directory), and codex has no worktree wire at all — the
   * gaps document records `packages/codex-protocol` matching **0** files for
   * `worktree` against 46 for `sandbox` as the control on the same command.
   *
   * **So the two targets lose DIFFERENT amounts, and the copy is cut for the
   * smaller one.** On claude an agent that declared `isolation: worktree` still
   * gets its worktree and only the tools-derived default is lost; on codex both
   * halves are. The sentence therefore says a subagent *may* run in the
   * session's folder — `bridgeTools`' precedent for a partial — rather than
   * *will*, which would be false on claude for a declaring agent.
   *
   * ## Why the over-warn is accepted, stated rather than hidden
   *
   * The table is keyed on the ordered pair alone, so this row cannot ask whether
   * THIS session actually imported such an agent — the dialog is drawn before
   * the target session exists, the same structural limit `bridgeTools` records.
   * A session with no isolated subagent is therefore told about a loss it will
   * not take. That is the safe direction for a notice meant to be trusted, the
   * rule `guardianJudge` and `scheduledRun` both record, and it is preferred
   * here to silence because the failure it prevents is edits landing in a
   * working copy the user believed was untouched.
   */
  {
    id: 'subagentWorktree',
    bodyKey: 'chat.runtimeSwitch.costSubagentWorktree',
    consequence: 'files',
    on: { pi: true, anthropic: false, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A delegated agent's report, and the scan that reads it before the parent
   * model does.
   *
   * P6.200's switch half — denominator A24. The codex half landed `c4f76a752`:
   * a codex session says once, on its first admitted child thread, that its
   * subagents' reports reach the parent unscanned. That notice fires INSIDE a
   * codex session. This row fires at the moment a user chooses to go there.
   *
   * ## `files`, following `guardianJudge`, and the reason is the same one
   *
   * What is lost is not a capability the model gains or loses — it is a SAFETY,
   * and the table's consequence vocabulary has two values rather than three.
   * `guardianJudge` set the precedent: a deny-net whose absence changes what can
   * happen to the user's files ranks with `files`, not with `abilities`. The
   * scan is a prompt-injection defence over text that DRIVES the model — a
   * subagent's report is the one place a page or a file a child read gets to
   * address the parent — so its absence lands in the same bucket. Ranked worst
   * first, that puts it where a user meets it.
   *
   * ## The three claims, each at its own site
   *
   * - **pi `true`, host-side and ours.** `pi-agent-server`'s
   *   `orchestrator/subagent-tool.ts` runs `scanSubagentOutput` and prepends
   *   `subagentReportMarkerLine`, both from `packages/shared/src/prompts/untrusted-text.ts`.
   *   The scan defangs forged transcript openers and control characters, and —
   *   the part that makes the marker worth anything — defangs any child line
   *   opening `[harness:`, so a child cannot write the verdict on itself.
   * - **anthropic `true`, the runtime's own.** `sub-agents.md`
   *   § *Subagent output scanning* states *"Subagent output scanning requires
   *   Claude Code v2.1.210 or later"*; the vendored bundle self-reports
   *   `2.1.247` (`claudeCodeVersion` in the SDK manifest and `claude --version`
   *   agree; it read `2.1.233` until the P7.1 lift), so the SDK scans its own
   *   subagents' reports. Native-first tier 1:
   *   nothing to build, and `SUBAGENT_MARKER_PREFIX` is byte-identical to the
   *   page's own string, which is why the two products' markers read alike.
   * - **codex `false`, STRUCTURAL and strong tier.** A subagent thread returns
   *   to the parent INSIDE the app-server, so no host code sits on that path and
   *   there is no artifact to scan. Measured on the shipped binary (W7-f):
   *   `subagent` 172 hits while `output_scan`, `scan_output`, `subagent_output`,
   *   `instruction-shaped` and `harness:` score **0 each**, with `enabled_tools`
   *   17 as the positive control and `zzz_not_real` 0 as the negative one.
   *   `config-schema.json`'s single `injection`-shaped hit is a websocket
   *   startup-context key, not a scan.
   *
   * So the row fires on both forward legs into codex and on neither leg between
   * Pi and claude, which both hold it — the shape the row's own verdicts imply.
   */
  {
    id: 'subagentReportScan',
    bodyKey: 'chat.runtimeSwitch.costSubagentReportScan',
    consequence: 'files',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * C3.256 — the auto-memory LOCATION setting stops covering everything.
   *
   * The host's `autoMemoryDirectory` moves this app's own user-scope memory
   * index (`packages/shared/src/agent/memory/memory-store.ts` symbol
   * `getUserMemoryRoot`). The claude child keeps a SECOND auto-memory store of
   * its own, and this fork deliberately does not project the setting into it —
   * the reading is on `applyAutoMemoryOffSwitch`
   * (`packages/shared/src/agent/options.ts`): the vendor key replaces the whole
   * default path, project leaf included, so a projection would point the
   * runtime's own writer at the `MEMORY.md` this app maintains, and it would
   * outrank a value the user set in their own Claude settings. Pi and codex have
   * no second store, so the setting really does cover everything there.
   *
   * Written by W17-m, landed here because this file and both locales are one
   * lane's this wave; `applyAutoMemoryOffSwitch`'s own docblock names this row
   * and this body key as the user-visible half of its non-projection, so the two
   * sides carry a pointer each rather than one asserting the other's behaviour.
   *
   * `files` and not `abilities`: what changes is WHERE bytes land, and the user
   * chose that folder on purpose.
   */
  {
    id: 'autoMemoryDirectoryScope',
    bodyKey: 'chat.runtimeSwitch.costAutoMemoryDirectory',
    consequence: 'files',
    on: { pi: true, anthropic: false, 'codex-runtime': true, 'nestor-cloud-agent': null },
  },
  /**
   * A protected directory BELOW the top of the workspace — a submodule's
   * `.git`, a vendored checkout's `.claude` — stops being confirmed with you.
   *
   * C3.377, born 2026-09-12 from F1 (PR-F1-3) and measured in both arms on the
   * shipped binary: `<ws>/sub/.git/x` LANDS on codex with and without the
   * projection, where Pi and claude raise the protected-path card.
   *
   * ## The two halves of the asymmetry, each read at its own module
   *
   * The host floor matches on SEGMENTS: `findProtectedPathWrite`
   * (`packages/shared/src/agent/pi-harness/protected-paths.ts`) scans every
   * segment window of the target, so `.git` fires wherever it appears in the
   * path. What travels to codex does not: `codexProtectedWorkspaceSubpaths`
   * (`packages/shared/src/agent/codex-agent.ts`) emits the BARE
   * `PROTECTED_DIRECTORIES` entries — it resolves them against the workspace
   * root only to drop one an added writable directory collides with — and
   * codex's `":workspace_roots"` vocabulary then resolves each subpath against
   * a ROOT, so the projection covers the top of each root and nothing deeper.
   *
   * ## Why it is a row rather than a fix, and the reason is codex's own grammar
   *
   * The any-depth spelling is a GLOB, and codex accepts a glob only under
   * `deny` — which takes the READS as well. On codex `read` is a refusal where
   * the host floor prompts, so closing the gap that way would refuse a model
   * the right to READ a submodule's `.git` in order to stop it writing one:
   * strictly worse than the prompt it replaces, and a product posture besides.
   * C3.343's own docblock already declines the sibling widening
   * (`PROTECTED_FILES`) for the same reason and records it as the owner's.
   *
   * ## The bound this row must not exceed
   *
   * It is NOT "codex does not protect `.git`" — the workspace-root one is
   * projected and C3.343 is what projected it. The loss is the DEPTH, and the
   * copy says exactly that, because a user who reads the wider sentence and
   * then watches the top-level card appear learns to distrust the dialog.
   *
   * `files`: what changes is what happens to the user's repository.
   */
  {
    id: 'nestedProtectedPaths',
    bodyKey: 'chat.runtimeSwitch.costNestedProtectedPaths',
    consequence: 'files',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A write to one of the 37 protected FILES stops being confirmed with you.
   *
   * C4.49, the owner's option A on 2026-09-13: the files stay UNPROJECTED on
   * codex and the loss is disclosed here instead. The row is the disclosure —
   * without it the posture is a measured hole nobody is told about, which is
   * this fork's largest defect class.
   *
   * ## Why projecting them would overshoot rather than close the gap
   *
   * `FileSystemAccessMode` (`packages/codex-protocol/generated/v2/`) is exactly
   * `read | write | deny`: codex has no value that expresses a PROMPT. Parity
   * here IS a prompt — `protectedPathOutcome` returns `'prompt'` for `default`
   * and `acceptEdits`, and `permission-modes.md#protected-paths` says it in the
   * table row *"`default`, `acceptEdits` | Prompted"* — so projecting the list
   * as `read` would convert a confirmable write into a refusal with no approval
   * route, and "add a registry to `.npmrc`" would fail with an OS error naming
   * neither the path nor the floor. It could not even be faithful: the host
   * floor matches by BASENAME at any depth, a `":workspace_roots"` subpath
   * resolves against the root only, and the any-depth spelling is a glob codex
   * accepts ONLY with `deny` — which takes the READS with it. And the
   * highest-value half of the list, the shell rcs, lives in `$HOME`, outside
   * every workspace root, where no projection reaches at all.
   *
   * ## Both paths, because C4.50 closed one of them on the OTHER two runtimes
   *
   * The file-tool path: the host floor carries all 37 through
   * `codexApprovalFloorSubjects` → `findNonNegotiableFloors('Write', …)`
   * (`packages/shared/src/agent/codex-agent.ts`), and is simply never handed a
   * subject for one. The shell path: C4.50 taught `findAgentConfigShellWrite`
   * (`packages/shared/src/agent/core/pre-tool-use.ts`) to gate the protected
   * FILES, and that seam serves all three runtimes — but on codex it fires only
   * when codex raises a command approval, and with the sandbox master switch
   * off this product emits `danger-full-access` + `on-request`, under which
   * P2.197 measured ZERO approval requests for an ordinary command. Since
   * P7.2 (2026-09-11) there is no emittable policy that would change that:
   * upstream retired `untrusted` at `rust-v0.150.1` and
   * `UNBOUNDED_ON_REQUEST_DEGRADES_TO`
   * (`packages/codex-responses-adapter/src/config-writer.ts`) records that no
   * public value routes an ordinary command to us once the sandbox is gone. So
   * the copy says the write lands with no card, which is true on both paths.
   *
   * ## RS-55 DROVE IT, and its one exception is why the copy changed (D1.261)
   *
   * The live case ran on the packaged build: the write was DRIVEN, no card was
   * raised, and nothing was written — which reads at first like the row being
   * refuted, and is not. `PROTECTED_FILES` is 37 names; the credential deny
   * floor (`SAFE_MODE_CONFIG.deniedPaths`, 24 names, byte-identical to the
   * shipped `apps/electron/resources/permissions/default.json`) intersects it
   * in EXACTLY ONE — `.npmrc` — and that floor is mirrored into codex's
   * `deniedReadPatterns` and enforced by the OS. So the denial the model
   * narrated was the CREDENTIAL floor doing its job, on the one protected file
   * that could not refute this row, and the sitting chose the single name the
   * sentence was false about.
   *
   * The other 36 have no such cover — `bunfig.toml`, `pyrightconfig.json`,
   * `.mcp.json`, `.envrc` and every shell rc are verified uncovered — so the
   * verdict `'codex-runtime': false` and the derivation behind it are unchanged
   * and correct, and the number is a derived guard of its own since `537926924`
   * (`packages/shared/src/agent/pi-harness/protected-paths.test.ts`). What
   * changed is the COPY: `.npmrc` led its examples and is gone from them, so
   * every name the sentence gives is one it is true about. Do not retire this
   * row on a re-run of RS-55 that names `.npmrc`; drive one of the other 36.
   *
   * ## What would retire this row
   *
   * A fourth `FileSystemAccessMode` that prompts, or a measurement showing
   * codex raising a `fileChange` approval for an in-root write under this
   * product's config — either one hands the host floor a subject, and all 37
   * files reach codex as a prompt with no projection at all.
   *
   * `files`: the subject is what happens to the user's own files.
   */
  {
    id: 'protectedFilesUnprojected',
    bodyKey: 'chat.runtimeSwitch.costProtectedFilesUnprojected',
    consequence: 'files',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A project's `.claude/commands/` stop being commands at all.
   *
   * C3.276, born 2026-09-11 from W16-f (PR-4) off C3.183's live measurement: a
   * flat `<project>/.claude/commands/<name>.md` with no frontmatter is named in
   * the claude child's own `system/init` `slash_commands` and its BODY reaches
   * the upstream turn, against a control with no file that has neither. Pi and
   * codex have no reader of their own, and the HOST's loader —
   * `packages/shared/src/slash-commands/custom-commands.ts` constant
   * `COMMAND_DIRS` — reads `<root>/.nessy-agent/commands` and
   * `<root>/.agents/commands` and not that directory, on any runtime. So the
   * capability is claude's alone and the loss is total on both legs out of it.
   *
   * ## The row says TWO things, because one of them is not a switch cost
   *
   * The second is the finding W16-f actually reported: **the rosters disagree
   * inside a claude session.** The runtime dispatches a list this app's own
   * composer never showed, so a user who has such a file has been using a
   * command the product never advertised — and a switch-cost line that only
   * said "you are losing X" would leave them wondering what X was. The copy
   * names the directory and says the list never held it, which is the whole
   * disclosure and costs one clause.
   *
   * ## Why the gap is SURFACED rather than closed
   *
   * Closing it is a `COMMAND_DIRS` entry away and that is the trap. On claude it
   * would register the same NAME twice — expanded by this host and dispatched by
   * the child, with no rule saying which body wins — and it would bypass
   * `packages/shared/src/capabilities/claude-setup-import.ts`, which exists to
   * copy those files in under the user's own eye. Importing is this product's
   * posture; reading in place would be a different product, and that is the
   * owner's call rather than this row's. The constant carries the reciprocal
   * pointer, so a future third entry cannot move without this row.
   *
   * `abilities`: what is lost is a thing the user can invoke.
   */
  {
    id: 'claudeProjectCommands',
    bodyKey: 'chat.runtimeSwitch.costClaudeProjectCommands',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * Plan mode ends with a plan the user accepts.
   *
   * `SubmitPlan` is in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, and CodexAgent
   * spawns the session MCP server with `--external-standalone-only`, so the
   * tool is never advertised there and a call would be refused server-side too.
   * Pi and Claude both wire `onPlanSubmitted` (`pi-agent.ts`,
   * `claude-agent.ts`). Codex has a todo list instead, and no plan card.
   */
  {
    id: 'planApproval',
    bodyKey: 'chat.runtimeSwitch.costPlanApproval',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * The model can act on the app itself.
   *
   * Seventeen tools are on Claude and absent on Codex (measured 2026-10-02, UA1.3), all for one structural
   * reason — they need a Nessy-side host callback (or, `advisor_consult`, a backend) the external app-server
   * process cannot reach: source management and its three OAuth/credential
   * triggers, the four plugin tools, `browser_tool`, `advisor_consult`, `WorktreeBatch` (codex has it only beside
   * the worktree port), `update_user_preferences`, `read_skill_resource`,
   * `spawn_session`, `call_llm`, `SlashCommand` and `BashOutput`. Not counted: `SubmitPlan` (its own row above)
   * and `TodoWrite` (withheld from codex for its native `update_plan`, `SESSION_TOOLS_WITHHELD_FOR_NATIVE_EQUIVALENT`).
   *
   * The count is against the BRIDGED codex surface, and it has moved three
   * times with the bridge: T3 put five more tools on Claude and none on Codex,
   * so the difference was 25 while this sentence still said twenty; T5 carried
   * those five across (back to twenty); P3.10 carried `ProcessStop` across too,
   * leaving nineteen; and `6173c9778` carried `send_agent_message` across,
   * leaving EIGHTEEN — re-measured 2026-08-30 (P2.420) by running
   * `getSessionToolNames`, because the twin sentence in
   * `runtime-capability-gaps.md` had gone stale on exactly this name and its own
   * doc test caught it. The names above are the measured set, not an assumed one.
   * Re-measured again 2026-08-31 (P4.6) and unchanged: `anthropic \ codex` is
   * exactly those eighteen names, and `codex \ anthropic` is EMPTY — so nothing
   * is owed in the other direction either. UA1.3 (2026-10-02) carried `set_session_labels` and `set_session_status` across: the derived set went from 19 names to the 17 above.
   *
   * `BashOutput`, ProcessStop's sibling on the background-shell half, stays here
   * because it has no bridge route and no codex producer. The set difference
   * itself is derived in `__tests__/runtime-capability-drift.test.ts`; this
   * prose is the reader's copy of it.
   */
  {
    id: 'appActions',
    bodyKey: 'chat.runtimeSwitch.costAppActions',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * Scheduling, watching, goals, messages to other sessions, the session's own status and labels, page publishing, board
   * tasks and Pages — the tools codex gets ONLY over a bridge that may not come up (P2.484; status/labels UA1.3, publishing UA1.18, tasks UA3.5, Pages UA6.3).
   *
   * ## What the row rests on — the DERIVATION, not the list
   *
   * The membership is `getSessionToolNames({ externalStandaloneOnly: true,
   * hostCallbackBridge: true })` MINUS `getSessionToolNames({
   * externalStandaloneOnly: true })`, computed at test time by
   * `__tests__/runtime-capability-drift.test.ts`. Naming the set that way rather
   * than transcribing it is not tidiness: this file's header records five
   * separate prose counts that went stale under a green suite, and the set moves
   * whenever a tool is put behind the bridge — which happened WHILE this row was
   * being written (a sibling lane moved `get_session_info` and `list_sessions`
   * onto the bridged side, taking the bare surface from 18 to 16). A row derived
   * from the difference follows that; a row listing names does not.
   *
   * The reading on 2026-10-15 (UB7.11), dated because it is a reading: bare 16, bridged
   * 43, difference `source_list_prompts`, `source_get_prompt`, `project_memory_append`, `CronControl`, `CronCreate`, `CronDelete`, `CronList`,
   * `ScheduleWakeup`, `Monitor`, `ProcessStop`, `Goal`, `GoalGet`,
   * `send_agent_message`, `get_session_info`, `list_sessions`, `archive_session`,
   * `set_session_labels`, `set_session_status`, `publish_artifact`, `list_artifacts`, `create_board_task`, `project_memory_append`, `list_pages`, `get_page`, `create_page`, `update_page`, `write_page_data`, `delete_page` — TWENTY-SEVEN, the newest UB7.11's two (TWENTY-FIVE after UB1.12's one on 2026-10-14, TWENTY-FOUR after UA6.3's six on 2026-10-02, EIGHTEEN after UA3.5, SEVENTEEN after UA1.18, FIFTEEN after UA1.3, THIRTEEN on 2026-09-08), and the two
   * the 2026-09-02 reading was missing are exactly the pair the paragraph above
   * it names. That
   * paragraph recorded the move and the reading beneath it did not follow, which
   * is why every count in this file is now re-derived from `getSessionToolNames`
   * by `__tests__/runtime-switch-costs-surface-counts.test.ts` rather than
   * transcribed and trusted. Pi and
   * Claude carry every one of them unconditionally — probed name by name on the
   * same rig, so the two `true`s below are measured rather than inferred from
   * the counts, and the drift test re-derives all three claims per run.
   *
   * **`advisor_consult` is deliberately NOT here, and the near-miss is worth
   * recording.** It also needs the bridge — plus a second flag,
   * `advisorConsultBridge`, which takes the surface to 44 — so it reads like a
   * tenth member. It is not, because `appActions` already claims it: that row is
   * derived as `anthropic \ codex-bridged`, the bridged surface excludes the
   * advisor, and the difference is 19 names with `advisor_consult` among them
   * (18 until P3.222; the bridged side grew by two, so this difference shrank by
   * two and the count written here had been stale in the other direction).
   * Adding it here would warn about the same tool twice, and would assert
   * `'conditional'` for a name the sibling row asserts `false` for.
   *
   * ## Why this row exists at all, when the table already derived its `on` maps
   *
   * Every other row's codex column is derived from the BRIDGED surface, which is
   * right for the ordinary session and is precisely what made these ten
   * invisible: they are present there, so no set difference appears and no row
   * fires. A session whose bridge failed loses all ten and the dialog said
   * nothing — **the one place in this module where the error went the unsafe
   * way**, recorded by P4.6 and closed here.
   *
   * P4.6's reason for recording rather than fixing was structural and still
   * holds: the dialog is drawn BEFORE the target session exists, so there is no
   * bridge state to read at the moment the copy is chosen. What changes is the
   * answer to it. A table whose vocabulary is only `true`/`false` had to choose
   * between under-warning every switch and over-warning every switch;
   * `'conditional'` lets it say the true thing, which is that the capability
   * depends on something neither the user nor this module can see yet. See
   * {@link RuntimeSwitchClaim} for the failure conditions and for why the RATE
   * is not claimed here.
   *
   * ## What this row does NOT do
   *
   * It does not withhold anything, re-rank anything, or make the session behave
   * differently — the bridge either starts or it does not, exactly as before.
   * And it is not a second copy of `scheduledRun`: that row is `pi`-only and
   * rests on `PushNotification`, which crosses to NEITHER vendor surface bridged
   * or not; this one rests on fifteen names (eleven at P3.222) that cross to both when the bridge is
   * up (ten before P3.222).
   * The overlap in the two English strings is real and deliberate — a user who
   * reads both is told once that notifications are gone for good and once that
   * scheduling may not arrive, which are different facts.
   *
   * The state itself is not invisible after the fact: `CodexAgent` records it
   * (`getSchedulingBridgeState`) and `SessionManager.schedulingBridgeKnownAbsent`
   * already withholds the `/loop` skill on a known failure. Reporting the failed
   * bridge on the session surface AFTER the switch is the strictly better answer
   * and needs a file this lane does not hold; it is reported, not attempted here.
   */
  {
    id: 'bridgeTools',
    bodyKey: 'chat.runtimeSwitch.costBridgeTools',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': 'conditional', 'nestor-cloud-agent': null },
  },
  /**
   * The model can raise an OS notification on the user's desktop.
   *
   * RE-CUT 2026-08-31 (P4.6). The row's id and body key still say
   * `scheduledRun`, and that name is now wider than the row: **the only ground
   * left is `PushNotification`.** Both are kept rather than renamed, because the
   * id is a React key and a test vocabulary and the body key is a shipped locale
   * string; renaming either buys nothing a reader of this comment does not get.
   *
   * ## What it used to be, and what is left
   *
   * One sentence: `CronCreate` / `CronList` / `CronDelete`, `ScheduleWakeup`,
   * `Monitor` and `PushNotification` were ALL `visibility: 'pi-only'`, so only
   * the Pi projection advertised any of them. T3 projected the first five onto
   * Claude (the scheduler was never Pi-shaped — T1 — and Monitor's `command`
   * gate is now host-side — T2), and T5 carried the same five to a codex session
   * over the per-session host-callback bridge. So SIX grounds became ONE, on both
   * targets, and the `on` map is unchanged only by arithmetic: the drift test
   * derives it as `deferredTools.every(...)` over a list that still contains
   * `PushNotification`, so both vendor columns stay `false` for that one reason.
   *
   * `PushNotification`'s own recorded reason for staying `pi-only`, quoted from
   * the comment directly above its definition in
   * `session-tools-core/src/tool-defs.ts`: "Claude Code ships its own
   * `PushNotification`, so projecting ours would put a second notification tool
   * in front of the model and the ungated one would win".
   *
   * **P4.6 fixed the ATTRIBUTION here and P6.52 had to fix the CLAIM, which is
   * the same rot one layer down.** Two sentences have now been retired from this
   * spot. The first, "the store, the once-a-second check and the between-turns
   * delivery gate are bound on the Pi path", is still in `tool-defs.ts` — which
   * is why every grep for it succeeded — but sits beside the CRON FOUR as the
   * premise T1 FALSIFIED, so this row cited a refuted reason that read as a live
   * citation. P4.6 replaced it with `PushNotification`'s own line, "the host port
   * is bound on the Pi path …", correctly attributed and green. P6.52 then
   * MEASURED that line and it was false in its turn: `ctx.notificationPort` closes
   * over `deliverDesktopNotification`, which takes a workspace id and a session
   * id, reads the user's notification setting and asks whether that workspace's
   * window has focus. Nothing in it is Pi's; only `SessionManager`'s binding site
   * is gated, which is exactly the shape T1 and P2.2 removed. Attribution is a
   * weaker property than truth, and a green attribution pin is what let the
   * second one stand.
   *
   * The quote above is pinned by
   * `__tests__/runtime-switch-costs-gaps-parity.test.ts`, sliced to the comment
   * block that precedes `PushNotification`'s own definition, so a quote that
   * drifts to another tool fails rather than passes.
   *
   * ## What this row's `anthropic: false` actually rests on (P6.52)
   *
   * **It rests on OUR surface, and our surface is not the model's.** The `on` map
   * is derived by `__tests__/runtime-capability-drift.test.ts` from
   * `getSessionToolNames`, which enumerates the SESSION tools this repo ships. A
   * capability Claude Code supplies from its own built-in set is invisible to that
   * derivation — and `PushNotification` is one: `PushNotificationInput` is
   * declared in the vendored `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`, the
   * regular-agent spawn asks for `tools: { type: 'preset', preset: 'claude_code' }`
   * (`claude-agent.ts`), and `CLAUDE_SESSION_DISALLOWED_TOOLS` subtracts only
   * `EnterPlanMode`, `ExitPlanMode` and `Monitor` (`Skill` until F1.862). This is the SAME
   * argument the `pi-only` rejection section above already accepts for the four
   * `Task*` tools, applied to the name it had not been applied to.
   *
   * What is measured is that the tool is ADVERTISED to a claude session, not
   * that it DELIVERS from one. Claude Code's desktop half is
   * `preferredNotifChannel` (`terminal_bell`, iTerm2, kitty …) and our SDK child
   * is spawned headless inside Electron with no terminal to ring, while the
   * phone half is Anthropic-hosted and unreachable from the gateway card. So
   * "the model can raise an OS notification" is unproven in BOTH directions on
   * claude. Settling it needs a live run.
   *
   * **P6.597 — so the cell is `'unmeasured'`, and the sentence that used to end
   * this section was the giveaway.** It read *"the row is left at `false` rather
   * than flipped … a row that over-warns is the safe error"*, which argues for
   * FIRING and not for the value `false`: `false` is a claim that claude does
   * not have the capability, and the paragraph above says nobody drove that
   * either way. `'unmeasured'` fires on exactly the leg the over-warn argument
   * wanted (Pi → claude), marks it *not measured* so a caution is never read as
   * a measurement, and adds the leg the over-warn argument never reached —
   * claude → codex, where the target lacks it outright. Same evidence, same
   * safety direction, an honest label instead of a borrowed one.
   *
   * The overlap itself is no longer prose: `__tests__/runtime-switch-costs-native-claude-tools.test.ts`
   * pins which of our `pi-only` names Claude Code also ships, and which of the
   * names we DO project onto claude collide with a built-in that is not
   * disallowed. Six such duplicates ship today; `Monitor` is the one T3 subtracted.
   *
   * ## The copy over-warned for two waves, and the re-cut has LANDED (P2.485)
   *
   * `chat.runtimeSwitch.costScheduledRun` read "The model can no longer schedule
   * a later run, watch for an event, or send you a notification." Two of its
   * three clauses were false on both targets since T3/T5 — scheduling and
   * watching both cross — leaving only the notification. P4.6 could not fix it
   * (the string lives in `packages/shared/src/i18n/locales/{en,ru}.json`, held by
   * sibling lanes both times it was found), so the replacement was written out
   * HERE, verbatim, to make it one edit rather than a re-derivation. W3-d made
   * that edit; the strings now read:
   *
   *   en: "The model can no longer send you a desktop notification when a long
   *        task finishes."
   *   ru: "Модель больше не сможет прислать уведомление на рабочий стол, когда
   *        длинная задача закончится."
   *
   * They are kept in this docblock because they are the thing this section is
   * FOR: the row's `on` map and the sentence a user reads have to agree, and the
   * only reason the disagreement lasted two waves is that nobody reading the
   * locale file could tell the sentence had outlived its subject.
   *
   * ONE CONSUMER OUTSIDE THE APP READS THESE TWO SENTENCES BY VALUE:
   * `scripts/cdp/cases/cru-3.ts` compares the rendered dialog against this
   * table's sentences in both locales. **CORRECTED 2026-09-06 (P6.65): its
   * `COST_SENTENCE` is no longer "its own table".** It is built by READING the
   * locale files at run time, so a re-cut STRING no longer strands it — the
   * sentence above described a coupling that had already been removed, and a
   * lane reading it would have gone looking for a copy that is not there.
   *
   * What DOES strand it is a re-keyed or ADDED row: its `COST_BODY_KEY` map is
   * hand-written and held SIX ids when the table held fourteen, and its
   * per-direction expectations are hand-written beside it. The case is owned by
   * the live lane and was not edited here; a packaged build made before a change
   * still renders the old list, so the case is correct against that artefact and
   * stale against the next one. That is the shape in which it comes back as an
   * unexplained red.
   *
   * Until this landed the toast over-warned, which is the safe direction for a
   * notice meant to be trusted — the same rule `guardianJudge` records for
   * permission modes. Safe is not the same as true, which is why it was written
   * out in full rather than left as a known imprecision.
   *
   * ## P6.184 — the codex cell moved from `false` to `'conditional'`
   *
   * It was `false` on the honest "the runtime cannot": the shipped
   * `codex-app-server` has no model-invocable notification at all
   * (`push_notification` 0, `user_notification` 0, "desktop notification" 0 on
   * both mac binaries, against `notification` 101/147 and `thread/start` 5/5 as
   * the controls), and the only thing it has is the operator-set `notify` /
   * `agent-turn-complete` program hook the model cannot invoke.
   *
   * That is still true of CODEX. What changed is that the HOST now carries ours
   * to it: `HOST_CALLBACK_BRIDGE_ROUTES.notificationPush` reaches the same
   * `deliverDesktopNotification` closure Pi and Claude reach in process, and
   * `SessionToolFilterOptions.notificationPort` — ANDed with the bridge —
   * advertises the tool to that spawn and to no other surface. Native-first
   * step 1 found nothing; step 2 supplied it once, in the host.
   *
   * `'conditional'` and not `true`, for `bridgeTools`' exact reason and by the
   * same mechanism: `CodexAgent.startCallbackBridge` fails NON-FATALLY, and a
   * session whose bridge did not start lives its whole life on the bare surface
   * with no route to notify over. So the capability depends on a per-session
   * precondition this table is drawn too early to evaluate, the copy says *may*
   * rather than *will*, and the row keeps firing INTO codex while staying silent
   * on the legs out of it.
   *
   * The claude cell is untouched and stays `'unmeasured'`: nothing here settles
   * whether a headless SDK child's own `PushNotification` delivers.
   *
   * ## Why `Monitor` is no longer named by this row
   *
   * It was, and correctly: its own description is "Watch an event source and get
   * interrupted when something happens, instead of polling for it" — arm now, be
   * told later, the same shape as the rest. T3/T5 projected it onto both vendor
   * surfaces, so it is no longer a cost in any direction. The reason the old copy
   * mentioned watching at all is recorded here so the dispatched re-cut does not
   * read as a loss of information: the post-switch capability toast covers only
   * plugin-declared monitors which STOPPED, and never covered the model's ability
   * to start one — that ability is simply not lost any more.
   */
  {
    id: 'scheduledRun',
    bodyKey: 'chat.runtimeSwitch.costScheduledRun',
    consequence: 'abilities',
    on: { pi: true, anthropic: 'unmeasured', 'codex-runtime': 'conditional', 'nestor-cloud-agent': null },
  },
  // RETIRED — `outputStyleTiming` (P3.227's switch-cost row), UB12.63 (2026-10-17).
  //
  // Its codex cell said a style picked mid-session reaches a codex session only
  // in a new one: `CodexAgent.activeOutputStyle()` put the prose into the
  // thread's `developerInstructions` at `thread/start` and on the `thread/fork`
  // walk, and `chatImpl` used only the LABEL, for the per-turn reminder. Pi and
  // claude resolve the style inside the turn, so the same pick shaped their very
  // next reply. P3.227 recorded that as a DECISION rather than a fix, on a quoted
  // `output-styles.md#change-your-output-style` sentence that made codex the
  // runtime conforming to the page.
  //
  // The page moved. Re-read 2026-10-17 (HTTP 200), the section now says "When
  // you switch styles mid-session, Claude uses the new style starting with your
  // next message", and `prompt-caching.md#changing-output-style` says how Claude
  // Code does it: it "delivers the new style's instructions as a message in the
  // conversation". The sentence P3.227 quoted is gone, and the page names the
  // version that replaced it. So the convergence this row priced as an owner
  // call now points the other way: codex was the divergent runtime.
  //
  // UB12.63 closed it on codex the way UB12.21 closed it on claude, whose
  // recorded system prompt has the same shape: `chatImpl` plans the switch with
  // `core/output-style-switch.ts` and puts the new style's block on the next
  // turn once, ahead of the user's text. The thread's `developerInstructions`
  // stay as they were, because nothing on `turn/start` can replace them
  // (`TurnStartParams` at `rust-v0.162.0` has no such field, and the per-turn
  // collaboration-mode instructions are codex's own preset slot, F1.788).
  //
  // With all three runtimes `true` the row can never fire: `switchCostCertainty`
  // returns null for a target that has the capability, so both shipped locale
  // sentences would be unreachable text asserting something false. A row that
  // can never fire is not a row (P6.896's rule, `webSearch`; F1.588's
  // `subagentModelOrder` went the same way). Its locale key is deleted in the
  // same commit, its derivation in `runtime-capability-drift.test.ts` is
  // retired, its marker in `runtime-switch-costs-gaps-parity.test.ts` is
  // replaced by a note, and the gaps document's row is CLOSED with
  // `[switch: none — …]`.
  //
  // The residue is not a timing difference between runtimes, so it is not a
  // switch cost: a codex session resumed by a NEW agent instance (an app
  // restart, a branch) cannot know which block its history was rendered with.
  // A style with prose is then restated once on its first turn, and a switch to
  // Default made before such a resume is not announced until the thread is
  // rebuilt. Claude carries the same residue for the same reason; both are
  // written down in `core/output-style-switch.ts`.
  //
  // This note is as long as the row it replaces, so the lines after it do not
  // move: dated specs and plans cite this file by line further down, and the
  // ledger guard (`scripts/check-ledger-citations.ts`) reads some of them. A
  // shorter note would have moved each of those citations onto another line.
  //
  // The evidence is the two arms in `codex-output-style.test.ts`, driven through
  // `chatImpl` on a thread the real `thread/start` path opened: a switch from
  // Default to Concise puts the Concise block on the next turn's text once (red
  // before UB12.63, where the reminder named Concise while the thread held no
  // style), and a thread opened under Concise owes no notice while the style is
  // unchanged (red when the `thread/start` seed is removed). The page reading is
  // dated above, and `scripts/claude-doc-pages.tsv` lists both pages in the
  // corpus snapshot this repository reads its Claude documentation from.
  /**
   * Auto-compaction can be turned OFF — and on codex it cannot.
   *
   * ## The set difference, both ends measured
   *
   * Pi has a real toggle: `PiAgent.requestSetAutoCompaction` sends
   * `set_auto_compaction` to the subprocess and reads the answer back. Claude
   * has one too: `claude-agent.ts` sets `DISABLE_AUTO_COMPACT: '1'` into
   * `envOverrides` when `autoCompaction.enabled === false` (P6.53, on both the
   * gateway and the direct-Anthropic paths). Codex has NOTHING to send.
   *
   * `ConfigToml` at `rust-v0.150.1` (`codex-rs/config/src/config_toml.rs` — the
   * struct the whole `~/.codex/config.toml` deserializes into) carries exactly
   * three window/compaction keys: `model_context_window`,
   * `model_auto_compact_token_limit` and `model_auto_compact_token_limit_scope`.
   * Two more choose the compaction PROMPT and one pair configures a fallback
   * buffer. None disables anything, and there is no `Feature` for it. The whole
   * surface was enumerated from the struct rather than grepped, because a grep
   * is how the previous answer to this question went wrong.
   *
   * ## Why the row says "cannot" rather than "is not wired"
   *
   * `ModelInfo::auto_compact_token_limit()` (`protocol/src/openai_models.rs:482`)
   * is `min(config_limit, resolved_context_window * 9 / 10)` and falls back to
   * the 90% term when the config key is absent. So the key can only ever LOWER
   * the trigger. Withholding it buys the highest trigger codex will accept;
   * writing a huge value buys the same thing, because the `min` clamps it. There
   * is no value and no combination of keys that reaches "never".
   *
   * Withholding the WINDOW as well does not help either, and that is the shape
   * this row exists because of: codex then uses `model_info_from_slug`'s
   * unknown-slug fallback, `context_window: Some(272_000)`
   * (`models-manager/src/model_info.rs:139`), and compacts at 244 800 off a
   * number nobody chose. Driven on the shipped `codex-app-server` with both keys
   * withheld: no compaction at 240 000 tokens of reported usage, COMPACTION at
   * 250 000, reported window 258 400 in both — so the arm that was supposed to be
   * "off" had a window and a trigger the whole time. The negative arm is the
   * control. Strong tier: the binary we ship, at the tag we ship.
   *
   * ## What the user actually loses, and why the copy names 90%
   *
   * On Pi and Claude, off means off — the conversation grows until the window
   * ends. On codex, off means the trigger moves from our 85% to codex's 90%, and
   * the summary still replaces the history. A user who turned compaction off
   * because they need the verbatim transcript loses it either way, later. The
   * copy therefore states what still happens rather than that a setting is
   * ignored, which is the more useful of the two true sentences.
   *
   * ## Not the same row as anything above it
   *
   * `outputStyleTiming` (retired, UB12.63) priced a DELAYED effect; this is a control
   * that does not exist on the target at all. And it is not a compaction QUALITY
   * claim: what the summary says is steered identically on all three
   * (`compact_prompt` here, `autoCompactionInstructions` on Pi), which is why
   * this row is about the switch and not about the summary.
   */
  {
    id: 'autoCompactionOff',
    bodyKey: 'chat.runtimeSwitch.costAutoCompaction',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * An operator's auto-compaction WINDOW and THRESHOLD are honoured.
   *
   * P6.96, and it is a different question from the row above: that one is about
   * whether compaction can be turned OFF, this one about WHEN it fires. No row
   * in this table was about when — measured, not assumed, and it is the reason
   * an operator could set `NESSY_AUTO_COMPACT_WINDOW` and be told nothing on
   * two of the three runtimes.
   *
   * - **Pi — `true`, to any value.** `resolveAutoCompactionSettings` accepts
   *   `contextWindow` from 1 upward and Pi narrows to what it is given.
   * - **Claude — `true`, with a floor stated rather than hidden.** The SDK's
   *   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is documented "from `100000` to
   *   `1000000`", so a smaller value narrows a Pi session as written and a
   *   claude session only to 100 000. `true` is the honest cell — the knob IS
   *   read and does change behaviour — and the floor is reported where it
   *   applies, by `claudeAutoCompactionKnobDiagnostics` on that session's own
   *   transcript. Spelling the floor as `'conditional'` here would be worse in
   *   both directions: a conditional SOURCE does not fire, so claude → codex
   *   would go silent on a runtime that reads neither knob at all.
   * - **Codex — `false`.** `codex-agent.ts` reads `autoCompaction.enabled` and
   *   nothing else; the trigger is the HOST's own constant
   *   `AUTO_COMPACT_WINDOW_FRACTION` over the catalogue window
   *   (`config-writer.ts`), a constant and not a setting. Both knobs are inert,
   *   and that session now says so on its own transcript too.
   *
   * The body names all three behaviours in one sentence, which is what the row
   * asked the report to say: a user switching does not learn what they are
   * losing from a line that describes only the target.
   */
  {
    id: 'autoCompactionKnobs',
    bodyKey: 'chat.runtimeSwitch.costAutoCompactionKnobs',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A tool call fills in on screen while the model writes it.
   *
   * P6.157 — the ROW ITSELF is what is left of that plan row, and saying so is
   * half the value of this comment. It asked for "one new `AgentEvent` variant
   * carrying partial tool input, its DTO on the wire, a renderer that fills the
   * tool card as bytes arrive, and a switch-report line naming codex as
   * block-only". Four of those five shipped through a DIFFERENT and smaller
   * mechanism while the row waited: P6.158 taught both adapters to re-emit
   * `tool_start` for the same `toolUseId` with a growing `input`
   * (`agent/backend/partial-tool-input.ts`), which needed no new variant and no
   * DTO change because `tool_start` already carried `input`, and P6.581 fixed
   * the forwarding gate that stopped the live card at the first frame. Adding
   * the variant now would be a second spelling of a capability that already
   * ships. The switch line is the one piece nobody built, and it is here.
   *
   * - **Pi — `true`.** `toolcall_delta` carries `delta` fragments beside the
   *   accumulating assistant message; `pi/event-adapter.ts` reads them.
   * - **Claude — `true`.** `input_json_delta.partial_json`, which the SDK sends
   *   because we ask for partial messages; `claude/event-adapter.ts` reads them.
   * - **Codex — `false`, and measured rather than assumed.** Two independent
   *   blocks, either of which alone would be enough, both recorded by
   *   `d7b3177e5`: the app-server protocol declares ten delta families and none
   *   of them is a tool-call-argument delta (corroborated by the ten generated
   *   v2 delta notification files), and one layer nearer, OUR responses adapter
   *   accumulates a call's arguments and emits a single delta at flush — so
   *   even an upstream that streamed them is re-buffered before codex sees
   *   anything. `false`, not `'unmeasured'`: the absence is read off the
   *   protocol, not left unexamined.
   *
   * Consequence `abilities` rather than `files`: nothing the model may DO
   * changes, and no file is touched differently. What changes is what the user
   * can see while it happens — a long edit or command appears whole instead of
   * building up — which is why the sentence describes the screen rather than a
   * capability being withdrawn.
   */
  {
    id: 'liveToolInput',
    bodyKey: 'chat.runtimeSwitch.costLiveToolInput',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A subagent can start subagents of its own — three layers deep on Pi and
   * Claude, one on codex.
   *
   * P6.124, ledger H4 host + H4 claude. The UNSET case is the whole subject:
   * every one of the three honours an operator's explicit ceiling, so this row
   * is about the default a user who set nothing actually gets.
   *
   * ## The three numbers, each from its own source
   *
   * - **Claude — 20 concurrent, depth 3**, published rather than inferred.
   *   `sub-agents.md#concurrent-subagent-limit`: *"By default, when 20 subagents
   *   are running in a session, spawning another with the Agent tool fails with
   *   `Concurrent subagent limit reached`… To change the limit, set
   *   `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` to any positive whole number"*, and
   *   `#let-subagents-spawn-their-own-subagents`: *"By default, a subagent can
   *   spawn subagents of its own, up to three layers below the main
   *   conversation"*. Both knobs bind on claude either way through `options.ts`'s
   *   `applySubagentSpawnDepth` and `applyConcurrentSubagentCeiling`.
   * - **Pi — RAM-narrowed concurrency, depth 3.** `subagent-limits.ts` narrows
   *   by available memory because a Pi subagent is a whole SUBPROCESS while a
   *   claude subagent is a context window. That is a difference in kind, not a
   *   smaller number, which is why the copy names the depth and not the count.
   * - **Codex — 6 concurrent, depth 1**, recorded at `config-writer.ts` against
   *   `rust-v0.148.0`.
   *
   * ## Depth is what the copy states, and the reason is the row's own rule
   *
   * The row fires from Pi AND from claude, and the two sources disagree about
   * concurrency, so a sentence naming a number would be true on one leg and
   * false on the other. Depth 3 → depth 1 is common to both legs and is the
   * difference a user perceives: a subagent that used to delegate stops being
   * able to. The concurrency difference rides as "fewer of them run at the same
   * time", which is true from either source.
   *
   * The operator half is not a switch cost and is not claimed here: an operator
   * who sets the ceilings gets them honoured on all three, and where that is
   * legible is the gaps document's own ceilings row, added with this one. The
   * codex forwarding line already exists and goes to `this.debug` — a sink no
   * packaged build writes, the P3.120/P3.267 shape — which is why the DOCUMENT
   * is the surface for the operator and this row is the surface for the user.
   */
  {
    id: 'subagentNesting',
    bodyKey: 'chat.runtimeSwitch.costSubagentNesting',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * 32 documented Claude policy and security switches are honoured on claude and
   * read by nothing anywhere else — the FIRST row that fires TOWARDS Pi.
   *
   * P6.170, ledger L1, whose Switch cell reads *"`SILENT`, and still the largest
   * asymmetry in the sweep — but a counted one, not an absolute. Set a key, have
   * it honoured on claude, lose it on Pi, with no diagnostic."*
   *
   * ## What the number is, and why it is not retyped
   *
   * It is rank 2 of the tiered table in `docs/architecture/runtime-capability-gaps.md`
   * §*The rest, ranked by what its absence costs* — the policy-and-security
   * slice of the 272 documented environment variables that appear nowhere under
   * `packages/`/`apps/`, listed there by name (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`,
   * `CLAUDE_CODE_MCP_ALLOWLIST_ENV`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`,
   * `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`, the two `CLAUDE_CODE_GLOB_*`, the
   * `CLAUDE_CODE_SHELL` pair, `DISABLE_TELEMETRY`, `DO_NOT_TRACK` and the rest).
   *
   * **Two of those names are no longer examples of the SILENT case, and the
   * enumeration keeps them only as members of the tier (W8-c's P6.587 hand-off,
   * `238a4ef25`).** `CLAUDE_CODE_SHELL_PREFIX` has been scrubbed from the claude
   * child env and announced since P3.300, and `CLAUDE_CODE_SHELL` since P6.587,
   * so an operator who sets either meets a diagnostic rather than a one-runtime
   * behaviour. The COUNT is untouched — tier membership is not the same
   * proposition as "honoured on claude and lost here in silence", and this row's
   * claim is the count.
   * `__tests__/runtime-switch-costs-gaps-parity.test.ts` reads that count OUT OF
   * THE TABLE and compares it with the number in the shipped sentence, so the
   * two are one claim rather than two copies — the treatment this file's header
   * records for five prose counts that went stale under a green suite.
   *
   * ## The direction, and the assumption it retires
   *
   * `on.pi` is `false`, which no row had ever carried. Every one of the ten rows
   * that preceded it was `pi: true`, and `runtimeSwitchCosts` fires only when
   * `row.on[from] === true`, so *"every return leg onto Pi lists nothing"* was
   * a property of the row set and not of the mechanism. The parity suite had
   * frozen it as an assertion that Pi → Codex fires EVERY row; that assertion is
   * amended in the same commit, with this reason, rather than left to fail as an
   * unexplained red.
   *
   * ## Codex is `false` too, and that is measured rather than assumed
   *
   * These are names the vendored `claude` binary reads. Codex is a different
   * binary built from `github.com/openai/codex`, reached through a `config.toml`
   * we compose; nothing in that path forwards a `CLAUDE_CODE_*` name, so a
   * claude → codex switch loses them exactly as a claude → Pi switch does.
   *
   * **The honest edge this paragraph recorded is now CLOSED, and it closed as
   * `false` rather than as `'unmeasured'` (P6.597).** It read: two of the 32 are
   * vendor-neutral spellings (`DISABLE_TELEMETRY`, `DO_NOT_TRACK`), and whether
   * the codex binary reads those on its own had not been measured. It has been
   * now, on the binaries we actually ship rather than on the page — AGENTS.md's
   * strong tier for codex. Every executable under
   * `apps/electron/resources/bin/codex`, all six across the three platform
   * directories, scores **0** for `DISABLE_TELEMETRY` and **0** for
   * `DO_NOT_TRACK`, against `CODEX_HOME` at 27–44 on the four that carry a
   * config path at all as the positive control that proves the probe reads the
   * file (an absence finding needs a control on the same rig). So all 32 names
   * are lost on a switch into codex, the cell is a measurement, and the
   * standing over-warn tie-break is not being leaned on here.
   *
   * ## Why the count and not the keys
   *
   * A dialog cannot list 32 names, and the row's job is to make an asymmetry
   * COUNTED rather than absolute — the same argument `autoCompactionOff`'s gaps
   * row records: *"A limit the user cannot turn off is a product posture, so it
   * is stated rather than implied"*. The names live in the document; the switch
   * says how many and that nothing will tell you.
   */
  {
    id: 'policyKeys',
    bodyKey: 'chat.runtimeSwitch.costPolicyKeys',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A project's own `.mcp.json` servers are approved by three documented keys on
   * claude alone — P6.340, denominator J18.
   *
   * `settings-reference.md` names them and the vendored binary reads all three:
   * `enabledMcpjsonServers` (25 occurrences), `disabledMcpjsonServers` (30) and
   * `enableAllProjectMcpServers` (17), against `ZZNOTAREALKEY` → 0 as the
   * control that proves the probe reads the binary. They resolve from the
   * project and local settings tiers, which we pass for a TRUSTED project only
   * since F1.768 (`projectTrustSettingSources` in `claude-agent.ts`; any other
   * gets `['user']`), so a trusted claude session honours the recorded choice.
   *
   * ## Pi and codex read none of them, and the divergence was SILENT
   *
   * All three score **0 files** over `:(glob)packages/**` `:(glob)apps/**`,
   * against `allowedMcpServers` → 25 as the positive control on the same rig:
   * our MCP pool has a consent model of its own and it has never heard of these
   * keys. So the same project, opened on Pi or on codex, decides which of its
   * own MCP servers may run by a different rule — and nothing said so, which is
   * this file's whole subject.
   *
   * ## Native-first was already answered, in the direction that leaves a cost
   *
   * Claude HAS the mechanism natively and we enable it by passing
   * `settingSources`; there is nothing to build there. The pool is ours on the
   * other two, so closing the gap would mean teaching it three claude-spelled
   * keys — the row's other arm, a larger decision than a dialog line. A native
   * mechanism adopted without a switch verdict is a NEW silent divergence (owner
   * rule); this row is that verdict. It stays `true`, not `'conditional'`, for
   * the untrusted case too (F1.1042): over-warning is the safe error here.
   *
   * ## Adjacent and NOT the same
   *
   * P6.72 measures whether a MANAGED MCP denial stops the spawn; that is the
   * managed tier and an operator's instrument. This one is the PROJECT tier and
   * the user's own.
   */
  {
    id: 'projectMcpApproval',
    bodyKey: 'chat.runtimeSwitch.costProjectMcpApproval',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A `cd` inside a Bash call persists on claude and on neither of the other two
   * — P6.690, the Bash half of P6.348 (J38).
   *
   * ## Three runtimes, three different things, and only one of them documented
   *
   * **claude — persists by default, and the off switch is a documented env var.**
   * `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR` occurs 6 times in the vendored
   * binary and `Shell cwd was reset to` — the notice it prints when the reset
   * happens — 4 times, against `ZZNOTAREAL` → 0 as the control that proves the
   * probe reads the file. So the default is KEEP and the flag is how an operator
   * turns it off.
   *
   * **codex — does not persist, and the model has an explicit substitute.** Read
   * from the source, which outranks the page on this runtime:
   * `codex-rs/core/src/exec.rs` at `rust-v0.150.1` declares
   * `ExecParams { command, cwd, … }` — a per-call working directory on a spawned
   * process, with nothing reading a changed directory back — and
   * `codex-rs/protocol/src/models.rs` declares
   * `ShellCommandToolCallParams { command: String, workdir: Option<String>, … }`,
   * so the MODEL names the directory per call instead of walking into it.
   *
   * **Pi — does not persist and has no substitute at all.** The cwd is bound once
   * at `createBashToolDefinition(cwd, options)` construction and every exec
   * passes it, so a `cd` cannot carry over and there is no per-call parameter to
   * name a different directory with. That asymmetry is why the row's copy talks
   * about the SEQUENCE rather than about a setting: on Pi the model has to write
   * `cd x && cmd` in one call, and nothing tells it so.
   *
   * ## Why it is one row and not two
   *
   * The claim is *"a `cd` persists across Bash calls"* and only claude has it, so
   * both forward legs out of claude fire and nothing fires INTO it. Codex's
   * `workdir` is a different mechanism rather than the same capability, and
   * splitting the row to say so would put a second line in a dialog that already
   * says the thing the user loses.
   *
   * ## What is NOT taken, per the row's controller decision
   *
   * The per-call cwd build — teaching our side to carry a working directory
   * between Bash calls — is three runtimes' worth of shell state inside an
   * SDK-owned tool, and the owner's rule is less code. The honest surface is this
   * row plus the reset notice where a reset happens.
   */
  {
    id: 'bashWorkingDir',
    bodyKey: 'chat.runtimeSwitch.costBashWorkingDir',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * The operator's tool memory cap — the FIRST `'unmeasured'` cell, and the row
   * P6.562 was built to make expressible (P6.346(a)).
   *
   * `CLAUDE_CODE_TOOL_MEMORY_LIMIT` caps the memory Bash, PowerShell and Monitor
   * commands may use. `tools-reference.md#memory-limit-on-linux-and-wsl`: *"On
   * Linux and WSL, set `CLAUDE_CODE_TOOL_MEMORY_LIMIT` to a size such as `4G` to
   * cap the memory that Bash, PowerShell, and Monitor tool commands can use"*,
   * *"Requires Claude Code v2.1.233 or later"* — at or past the vendored
   * `claudeCodeVersion`, which is `2.1.247` (it was exactly `2.1.233` when this
   * paragraph was written, before the P7.1 lift; the page's floor is what
   * matters and the bundle is still above it). It reaches the child because
   * `buildClaudeSubprocessEnv`
   * spreads `process.env` wholesale, pinned by `OTHER_CEILINGS` in
   * `agent/__tests__/claude-operator-ceiling-env.test.ts`.
   *
   * ## Why `'unmeasured'` on claude and not `true`
   *
   * The functional site in the shipped binary tests the PLATFORM before it reads
   * the variable — `let e=Kt(); if(e!=="linux"&&e!=="wsl"){CZt=null;return}` —
   * and every rig this fork has run on is darwin, so the honouring half is READ
   * and never exercised. `true` would promise a cap we have not seen bind;
   * `false` would deny a mechanism the binary demonstrably has;
   * `'conditional'` is reserved for one measured per-session shape and this is
   * not one. `'unmeasured'` is the only claim that is true, and the dialog
   * carries it as *not measured* beside the sentence.
   *
   * ## The NAME's membership comes from the bundle, not from the page (P6.744)
   *
   * AGENTS.md's membership rule: for any question of the form *what is the
   * complete set of X*, the vendored bundle is the denominator and the page is a
   * subset of it. Probed 2026-09-08 over
   * `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` with
   * `grep -ao … | wc -l`, both controls on the same rig:
   * `CLAUDE_CODE_TOOL_MEMORY_LIMIT` → 3, `CLAUDE_CODE_MAX_OUTPUT_TOKENS` → 12
   * (positive), `NESSY_NOT_A_REAL_ENV_NAME` → 0 (negative). So the name is the
   * shipped binary's own, and this row does not rest on a page sentence for
   * WHETHER it exists — only for what it does and where it binds.
   *
   * ## Pi and codex are `false`, and that is a measurement
   *
   * Nothing of ours READS the value on either runtime. That claim used to be
   * carried by a grep COUNT — "three files, all prose" — and a count is the one
   * form it cannot take: the grep matches prose ABOUT the name, so writing the
   * count down was itself a fourth and fifth hit, and the sentence was false the
   * moment it landed (P6.598; the same grep answers five at HEAD, and the two
   * additions are this docblock and the drift test's note about it).
   *
   * Stated by PATH instead, which no future mention can move: exactly one site
   * under `packages/`/`apps/` is load-bearing, `OTHER_CEILINGS` in
   * `agent/__tests__/claude-operator-ceiling-env.test.ts`, and it is a
   * PASS-THROUGH list — it asserts the name survives into the child's env, not
   * that anything here interprets it. Every other occurrence is a page quote in
   * a docblock. Codex has no counterpart of its own (`memory` scores 0 files
   * against a `timeout` control at 3+, `runtime-capability-gaps.md`) and Pi caps
   * wall time and output bytes only. Both are absences, not silences.
   *
   * ## The written refusal this row overturns, and which half of it survives
   *
   * `runtime-capability-gaps.md` recorded a REFUSAL to surface this (P3.343,
   * 2026-09-04) on three reasons. The second is spent by P6.562 — it said
   * `RuntimeSwitchClaim` had no way to say something true on Linux without
   * claiming something false on macOS, and `'unmeasured'` is that way. The first
   * said a ceiling an operator sets is not a capability a user loses; `policyKeys`
   * landed two days later saying exactly the opposite about 32 operator-set
   * names, so it does not survive its own sibling. The third — that our `isLinux`
   * cannot see WSL, which the binary's `Kt()` distinguishes — survives intact and
   * is why this row is NOT scoped by platform at all: the copy names Linux and
   * WSL in words and the claim stays unmeasured, rather than being gated on a
   * predicate coarser than the thing it describes.
   *
   * `abilities` rather than `files`, on `policyKeys`'s precedent: an operator
   * setting that stops being read changes what the session may do to the
   * machine, not what lands in the working tree.
   */
  /**
   * C3.148 (QJ10 = A, owner 2026-09-11) adds the COMPANION to this row's copy,
   * and refuses the two rows the same answer asked for. Both halves are readings.
   *
   * ## The companion, which arrived after the row did
   *
   * `tools-reference.md#memory-limit-on-linux-and-wsl`: *"Claude Code can also
   * count other kinds of processes it starts against the same limit. Set
   * `CLAUDE_CODE_TOOL_MEMORY_CGROUP_EXCLUDE` to a comma-separated list of the
   * kinds to exempt from the cap; Claude Code applies the cap to every kind not
   * on your list … Requires Claude Code v2.1.246 or later."* The vendored bundle
   * self-reports `2.1.247` — its `package.json` `claudeCodeVersion` and the
   * binary's own `--version` agree — so it is past that floor, and the name
   * scores 3 in the shipped binary against 6 for `CLAUDE_CODE_TOOL_MEMORY_LIMIT`
   * and 0 for a name that does not exist. It is pinned as a pass-through by
   * `OTHER_CEILINGS` (`agent/__tests__/claude-operator-ceiling-env.test.ts`)
   * beside the limit it companions, and the copy names it in words rather than
   * by key, because the sentence is read by a user and not by an operator.
   *
   * ## The two rows C3.148 also asked for, REFUTED at HEAD rather than built
   *
   * QJ10 = A asked for a `respectGitignore` row (J37) and a `defaultShell` row
   * (J39) on this same template. Neither can be written truthfully, because
   * P6.349 had already measured both keys at `packages/shared/src/agent/options.ts`
   * and the measurements remove the subject:
   *
   * - **`respectGitignore` governs the `@` file picker**
   *   (`settings-reference.md#respectgitignore`, *"Control whether the `@` file
   *   picker leaves out files that match `.gitignore` patterns"*, default
   *   `true`). `SessionManager.fuzzyFileSearch` returns files only when the agent
   *   implements `fuzzyFileSearch`, and **only `codex-agent.ts` does** — a claude
   *   session's `@` menu is populated from MCP resources alone. So a user leaving
   *   claude loses a knob over a file list claude never produced here, and codex,
   *   the one runtime that does produce it, respects `.gitignore` by default
   *   (`respect_gitignore`, `codex-rs/file-search/src/lib.rs` at `rust-v0.150.1`).
   * - **`defaultShell` has exactly two values and only one is reachable.** The
   *   vendored `sdk.d.ts` types it `'bash' | 'powershell'`; the host pins the
   *   PowerShell tool off (`applyPowerShellToolRefusal`), and
   *   `settings-reference.md#defaultshell` says what then happens —
   *   *"`\"powershell\"` falls back to Bash when the PowerShell tool is off"*. A
   *   row would tell a switcher they lose a choice that has one option on every
   *   runtime.
   *
   * A cost row that names a loss the user does not take is the `sessionAgent`
   * failure this table already paid for once — the cell said `false` for a day
   * after the capability landed and the dialog named a loss nobody had taken. Two
   * rows are therefore NOT added, and the reason is recorded here rather than in
   * a report nobody re-reads.
   */
  {
    id: 'toolMemoryCap',
    bodyKey: 'chat.runtimeSwitch.costToolMemoryCap',
    consequence: 'abilities',
    on: { pi: false, anthropic: 'unmeasured', 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * C3.98 — the disclosure owner decision D5 promised and nobody shipped.
   *
   * D5 (2026-09-05, part 3, Option A) is *"the six-name whitelist stays, and the
   * divergence is disclosed"*, re-affirmed by the owner's QG8 = A of 2026-09-11.
   * The whitelist stayed; the disclosure is this row, and it never landed.
   *
   * ## The FIVE names, and why the number is the whole point
   *
   * Read off `security-guidance.md#disable-or-uninstall`'s own table rather than
   * off prose: `ENABLE_PATTERN_RULES=0`, `ENABLE_STOP_REVIEW=0`,
   * `ENABLE_COMMIT_REVIEW=0`, `ENABLE_CODE_SECURITY_REVIEW=0` — *"Disable all
   * model-backed reviews at once"* — and `SECURITY_GUIDANCE_DISABLE=1` —
   * *"Disable the plugin entirely without uninstalling"*. The first draft of this
   * answer listed THREE, missing the master switch and the plugin-wide one, which
   * is the enumeration trap AGENTS.md records: name the source the list came from
   * so the next reader can re-derive it instead of re-counting a sentence.
   *
   * ## The mechanism, measured on both sides
   *
   * On claude the plugin's hooks run inside the SDK child (`claude-agent.ts`
   * builds the options and calls `query`), which inherits the whole ambient
   * environment — so all five govern there, by accident of where the hook runs
   * rather than by any mechanism of ours. Here and on codex the same hooks are
   * host-run command hooks, and `SAFE_INHERITED_ENV_KEYS`
   * (`packages/shared/src/automations/hook-command.ts`) inherits exactly `HOME`,
   * `PATH`, `SHELL`, `TMPDIR`, `TEMP` and `TMP` — six names, verified at HEAD.
   *
   * ## What the user actually loses, which is NOT the plugin
   *
   * The layers are not lost; the OFF SWITCHES are. That is why the ledger keeps
   * `absent`/`partial` rather than `n/a`, and why the copy names the escape that
   * still works: a hook's own `actionEnv` block sets whatever it likes for that
   * hook. A row that said "the security plugin stops working" would be the
   * `sessionAgent` failure with the sign flipped — telling a switcher they lose
   * something they keep.
   *
   * `abilities` rather than `files`: what changes is what runs on the machine
   * during a turn, not what lands in the working tree.
   */
  {
    id: 'securityPluginEnv',
    bodyKey: 'chat.runtimeSwitch.costSecurityPluginEnv',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * C3.219 — a gateway request from a subagent stops naming which subagent.
   *
   * P6.462's own done_means allowed either outcome — *"on Pi/codex by host
   * minting — or the two-runtime state is declared HONEST with the difference
   * named"* — and only the claude arm landed. This row takes the second, and the
   * reason is a reading rather than a preference.
   *
   * `packages/shared/src/telemetry/gateway-headers.ts` declares
   * `x-nessy-agent-id` and a `scope.agentId` field, and `gatewaySessionFetch` is
   * its ONLY writer: it lifts the value out of an inbound
   * `x-claude-code-agent-id` that the claude runtime's own child sends, renames
   * it, and strips the vendor spelling. Nothing mints one.
   *
   * Minting host-side was the alternative and it has no site: a Pi subagent runs
   * in-process in the harness (`packages/pi-agent-server/src/orchestrator/spawner.ts`)
   * and a codex agent inside the app-server, and neither request passes through
   * that fetch wrapper at all — so the mint would have to be invented somewhere
   * the request does not visit. Native-first condition (1) fails on both (no
   * runtime emits such a header) and condition (2) fails too (the host is not on
   * the path), which is exactly when the rule says to name the residue.
   *
   * The SESSION id is unaffected and still stamped on every leg; what an operator
   * reading gateway logs loses is the agent inside the session.
   *
   * `abilities`, not `files`, on `policyKeys`'s precedent: an attribution an
   * operator relies on is part of what the session may be held to, and nothing
   * about the working tree changes.
   */
  {
    id: 'subagentAgentIdHeader',
    bodyKey: 'chat.runtimeSwitch.costSubagentAgentIdHeader',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * The claude GATEWAY connection runs its binary off the vendor's network.
   *
   * P6.262, ledger D5. `startLocalAdapter`'s `envOverrides` writes
   * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'` (`claude-agent.ts`), and the
   * page's own effect list is quoted verbatim at that site. Re-curled
   * 2026-09-11 (C3.63), `env-vars.md#variables`: *"auto-updates, telemetry,
   * error reporting, the `/feedback` command, Claude-drafted feedback, release
   * notes, the PR and MR status badge checks, and availability checks such as
   * the fast mode check. It also stops the background runs of plugin `command`
   * sources"*, and *"Also disables feature-flag fetching"*. It is OUR choice,
   * taken deliberately: the child's only reachable upstream is a loopback port
   * answering `/v1/messages`, so every one of those requests is one this fork
   * cannot route.
   *
   * **Gateway model discovery is NO LONGER on that list, and the page now says
   * the opposite outright** — *"Doesn't affect gateway model discovery, which
   * has its own opt-in"*. The clause this docblock used to carry (*"gateway
   * model discovery refreshes"*, inside the effect list) is struck rather than
   * moved: the discovery gate is the separate opt-in
   * `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, already measured and recorded
   * at `packages/shared/src/config/claude-provider-routing-env.ts` symbol
   * `CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS`, which this fork never sets. The
   * same re-curl added a second carve-out we do not rely on and record anyway:
   * *"Official plugin marketplace auto-install isn't covered; disable it with
   * `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`"*.
   *
   * ## The shape hazard the row measured, and why the COPY carries the condition
   *
   * `on` is keyed by PROVIDER, and `anthropic` covers BOTH the gateway
   * connection and the subscription one, while the loss is the gateway path's
   * alone — `claude-agent.ts` says so verbatim: the variable is "set on the
   * GATEWAY path only … and is NOT set on the subscription path". A cell cannot
   * express that, and a row keyed `anthropic: false` would be false for a
   * subscription session. So the SENTENCE names the connection, opens on the
   * condition, and closes by saying the subscription path keeps all of it. The
   * alternative — no row at all — is what shipped for three waves, and the cost
   * is invisible to the user in exactly the moment they choose it.
   *
   * Pi and codex are `true` because nothing of ours switches their own runtime's
   * network features off; the flag has no counterpart on either, and neither has
   * a path where we impose one.
   *
   * `abilities` and not `files`: nothing lands differently in the working tree.
   */
  {
    id: 'gatewayFeatureFlags',
    bodyKey: 'chat.runtimeSwitch.costGatewayFeatureFlags',
    consequence: 'abilities',
    on: { pi: true, anthropic: false, 'codex-runtime': true, 'nestor-cloud-agent': null },
  },
  /**
   * The two agents codex ships of its own.
   *
   * P6.262, ledger D6. MEASURED on the shipped binary rather than read off the
   * page — `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
   * carries `explorer.toml` (1) and `awaiter.toml` (1) beside "Default
   * agent.Use `explorer` for specific codebase questions." and the awaiter's own
   * `developer_instructions` opening "You are an awaiter.", while `worker.toml`
   * and "You are a worker" score **0**. Control on the same rig: "agent type is
   * currently not available" → 3. **The page's trio names `worker`; the
   * artifact refutes it**, which is why this row names explorer and awaiter and
   * not the page's set.
   *
   * Nothing to enable — codex ships them. The gap is the sentence, and the host
   * frame that carries it is this table.
   *
   * ## Carried residue, deliberately NOT built here
   *
   * Our own builtins are planner/reviewer/scout/worker, so an imported agent
   * named `explorer` or `awaiter` is an untested collision against codex's
   * shipped roles. `CODEX_AGENTS_RESERVED_KEYS` (`config-writer.ts`) holds only
   * the six `[agents]` settings keys and no role names, verified at HEAD.
   * Recorded at the row rather than widened, because widening a reserved-keys
   * set on an unmeasured collision is the kind of guess this table exists to
   * avoid.
   */
  {
    id: 'codexBuiltinAgents',
    bodyKey: 'chat.runtimeSwitch.costCodexBuiltinAgents',
    consequence: 'abilities',
    on: { pi: false, anthropic: false, 'codex-runtime': true, 'nestor-cloud-agent': null },
  },
  /**
   * The two agents the CLAUDE runtime ships of its own — the mirror of the row
   * above, and the reason this table stopped being one-directional.
   *
   * C3.64, owner answer QD5 = A (2026-09-11), ledger D6. `codexBuiltinAgents`
   * prices the leg OUT OF codex and nothing priced the leg out of claude, so a
   * user leaving claude was never told which builtin roles they lose. Measured
   * before this row was written: `packages/shared/src/agent/claude-runtime-builtin-agent-env.ts`
   * symbol `CLAUDE_DISABLE_EXPLORE_PLAN_AGENTS_ENV` gates exactly that pair and
   * nothing else, and the words Explore and Plan appeared in no row of this file
   * and in no `chat.runtimeSwitch.cost*` locale key.
   *
   * ## WHICH TURN SHAPE the claim is about, stated rather than assumed
   *
   * A turn that supplies agent definitions of OUR own already returns the
   * runtime's builtin list as `[]` — Explore and Plan are gone with the rest,
   * lost to the session rather than to the switch — so there is only something
   * to lose on the OTHER shape: a session that dispatches no definitions (a
   * `mini` completion, or a runtime carrying none), where the builtins are
   * deliberately kept. That is the distinction
   * {@link buildClaudeRuntimeBuiltinAgentEnv} already draws between its two
   * independent switches, restated here because a cost row that ignored it would
   * over-warn on every ordinary turn.
   *
   * `pi: false` and `'codex-runtime': false` are MEASURED absences rather than
   * silences: neither ships an Explore/Plan pair, and codex has no per-agent deny
   * at all — a role is declared in `[agents]` or it is not — which is why the
   * sibling module records denominator H31's codex verdict as `absent` by
   * construction.
   *
   * `abilities` rather than `files`, on `codexBuiltinAgents`'s own precedent:
   * losing a role changes who can be delegated to, not what lands in the tree.
   */
  {
    id: 'claudeBuiltinAgents',
    bodyKey: 'chat.runtimeSwitch.costClaudeBuiltinAgents',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * Skills that live in a folder the user ADDED to this session.
   *
   * C3.290, the switch-report half of C4.24 (owner answer QL3 = C, 2026-09-11,
   * ledger L4/L39). The capability itself landed in `5f3dc0e33`'s lane:
   * `CodexAgent.syncCodexSkillExtraRoots` hands codex the skills directories of
   * every accepted added root through codex's own `skills/extraRoots/set`, and
   * claude has always reached them through the SDK's `additionalDirectories`
   * option (`buildClaudeAdditionalDirectoriesOptions(getConfiguredAdditionalDirectories())`).
   * The owner's letter required the residual difference to be NAMED rather than
   * left as a capability on two runtimes out of three that vanishes silently on
   * the third — the host rule that a residue is made uniform or HONEST.
   *
   * ## Why `pi: false` is a measurement and not an omission
   *
   * For Pi an added folder is the `additionalDirectories` SETTING, which
   * `large-codebases.md` scores "Never" for skills, and the host's own scan
   * walks nested roots under the PROJECT — `packages/shared/src/capabilities/native-sources.ts`
   * never reads `getConfiguredAdditionalDirectories()`. So the skills are not
   * loaded there by either path, which is why this row fires only INTO Pi and is
   * silent on every leg between claude and codex, both of which have it.
   *
   * The same sentence already reaches a codex session in-band, once, when the
   * roots are actually handed over (`backend/codex/skill-extra-roots.ts` symbol
   * `CODEX_SKILL_EXTRA_ROOTS_SWITCH_NOTE`); this row is the half that reaches
   * the user at the moment they take the switch, which is the only moment the
   * choice is still theirs.
   *
   * `abilities` rather than `files`: a skill that does not load changes what the
   * model can do, not what lands in the tree.
   */
  {
    id: 'addedFolderSkills',
    bodyKey: 'chat.runtimeSwitch.costAddedFolderSkills',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': true, 'nestor-cloud-agent': null },
  },
  /**
   * Which SUBJECTS a permission rule may be written against and still be
   * consulted.
   *
   * C3.285, the build C3.12 asked for; ledger A51/A52, where P6.214 measured the
   * switch verdict as SILENT-LOOSER. On Pi and claude every tool call reaches the
   * host gate, so a rule may name any tool, any parameter or an agent and it is
   * evaluated. On codex the host gate never runs (see `preToolCheck` below) and
   * the only rule consultation left is the ANSWER path R6 built, whose projection
   * — `packages/shared/src/agent/codex-agent.ts` symbol
   * `codexApprovalRuleRequests` — is deliberately faithful and therefore narrow:
   * three tool names (`Bash`, `Write`, `Edit`) carrying two input fields
   * (`command`, `file_path`), with every other approval kind returning `[]` for a
   * stated reason.
   *
   * ## Why this is not `preToolCheck` again
   *
   * `preToolCheck` says nothing of OURS inspects a tool call before codex runs
   * it — a statement about the gate. This one is about the rules the user WROTE:
   * codex does consult them on its own approvals, and a rule whose subject that
   * path cannot express is skipped there while still applying to the tools the
   * host runs itself. Two different losses, and a user who reads only the first
   * would conclude their rules are inert on codex, which is false.
   *
   * ## The honesty half that is NOT in this table
   *
   * The rules with no subject are named per session on the facts channel
   * (`packages/shared/src/agent/codex-permission-rule-support.ts` symbol
   * `describeCodexUnboundPermissionRules`), which is what makes the narrowing
   * legible after the switch. This row is what makes it legible BEFORE it, which
   * is the only moment the choice is still the user's.
   *
   * `abilities` rather than `files`: a rule that stops answering changes what the
   * model is allowed to attempt, and the row is about the RULE, not about any
   * particular write.
   */
  {
    id: 'ruleSubjects',
    bodyKey: 'chat.runtimeSwitch.costRuleSubjects',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A rule written about a network HOST binds nothing here, and a rule about an
   * MCP tool binds only the calls codex asks about.
   *
   * C3.310, born 2026-09-11 from C3.298 (W17-f); SPLIT by F1.368 (2026-09-24)
   * after F1.272. The row above prices the SUBJECTS codex's own approval
   * projection cannot express; this one prices the two matcher kinds whose loss
   * that row's own closing sentence denied.
   *
   * ## It exists because the sibling row's premise was refuted, not to repeat it
   *
   * `ruleSubjects` ended *"a rule still applies to the tools this host runs
   * itself on a codex session, which is why `mcp`, `host`, `powershell` and
   * `cdPath` matchers are deliberately not claimed"*. C3.298 measured that and it
   * is false: on a codex session NO host-run tool reaches the rule gate at all.
   * `runPreToolUseChecks` has zero CALL SITES in
   * `packages/shared/src/agent/codex-agent.ts` (its occurrences there are the
   * comments recording that zero — the bare-identifier counting trap, so the
   * instrument is call sites); the bridged session tools arrive through the
   * session MCP server and through hand-bound approval closures
   * (`directPermissionResolvers`, `authorizeMonitor` in
   * `packages/session-tools-core/src/host-callback-bridge.ts`), and neither
   * evaluates a permission rule.
   *
   * ## Two of the four matchers, lost for two different reasons since F1.272
   *
   * `host` is UNBOUND: `hostFromInput` reads `host`/`domain`/`url`/`baseUrl`,
   * and codex's command and file-change approvals carry `command` and
   * `file_path`. `mcp` is BOUND WHEN CODEX ASKS: C3.310 wrote that codex raises
   * no MCP tool-call approval of its own (P6.700), and F1.218 refuted it — the
   * approval arrives as `mcpServer/elicitation/request` with
   * `_meta.codex_approval_kind = "mcp_tool_call"` — so F1.272's
   * `codexMcpToolCallRuleRequests` projects it under the host's name and an
   * `mcp__` rule answers codex's card. What stays lost is the RESIDUE: codex
   * asks nothing for a tool its server marks `readOnlyHint`
   * (`requires_mcp_tool_approval`); F1.378 and F1.482 (2) project the rules into
   * codex's own per-tool levers over the tools listed at runtime build, so only a
   * source still connecting then escapes them (the drift test's derivation carries
   * the tripwire that makes a narrowing commit amend this copy). `powershell` is BOUND —
   * the projection emits `toolName: 'Bash'` and `carriesBashCommand` accepts
   * exactly that — and `cdPath` is neither, because `case 'cdPath': return
   * false` for every tool call on every runtime (its evaluator is for the `/cd`
   * a USER types). A row claiming all four would over-warn in two different ways.
   *
   * The claim stays `false` on codex because BOTH halves are still lost there;
   * the copy (`chat.runtimeSwitch.costHostMcpRules`) says each half separately,
   * which is the whole of F1.368: its old sentence — MCP and host rules "stop
   * binding anything" — became false for every MCP tool codex asks about.
   *
   * ## Why it is a second row rather than a clause
   *
   * `ruleSubjects` is about a rule codex DOES consult and cannot express the
   * subject of; this is about a rule nothing on the session consults (a host
   * rule) or that is consulted only when codex asks (an MCP rule). They are lost
   * together on the same leg, but a user who reads the first and concludes "my
   * `Host(...)` rule still binds the tools the app runs" has read it correctly
   * and been told something untrue — which is exactly what the sentence this row
   * replaced did.
   *
   * The per-session half is the same seam:
   * `packages/shared/src/agent/codex-permission-rule-support.ts` symbol
   * `classifyCodexUnboundPermissionRules` names the HOST rules AFTER the switch
   * (it stopped claiming `mcp` with F1.272); this row is the only thing that
   * names both halves BEFORE it.
   */
  {
    id: 'hostMcpRules',
    bodyKey: 'chat.runtimeSwitch.costHostMcpRules',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * Instructions that depend on WHICH FILE is being touched.
   *
   * P6.391, ledger L31 and L32 — both `absent` on codex and both STRUCTURAL with
   * `honest_surface: missing`, which is why this is the buildable SURFACE row
   * rather than the (impossible) capability.
   *
   * Two mechanics, one gate. `nestedInstructionProbe` fetches a subdirectory
   * `CLAUDE.md` on demand when the model works there, and
   * `pathGatedSkillIsInScope` decides whether a `paths:`-scoped rule or skill
   * activates for the file in hand. Both hang off
   * `BaseAgent.deliversPathScopedActivations`, which is `false` by default
   * (`base-agent.ts:2214`) and overridden to `true` in exactly two places:
   * `claude-agent.ts:4746` and `pi-agent.ts:10024`. The gate itself rides
   * `runPreToolUseChecks`, and codex never calls it — `codex-agent.ts` records
   * that the identifier's call sites in that file are zero.
   *
   * ## The field is left INERT on codex rather than refusing
   *
   * `pathGatedSkillIsInScope` returns `true` when the gate does not run, so a
   * `paths:`-scoped skill stays INVOKABLE on codex instead of being permanently
   * refused. That is deliberate and it is also exactly why the loss is silent:
   * nothing fails, the activation simply never happens by itself.
   *
   * ## Codex was asked, by NAME rather than by prose
   *
   * The schema's whole instruction-key surface is `project_doc_fallback_filenames`,
   * `project_doc_max_bytes`, `model_instructions_file`, `developer_instructions`,
   * `instructions` and their `include_*` siblings
   * (`packages/codex-protocol/schema/config-schema.json`). None of them is
   * per-directory or on-demand, so there is no native mechanism to enable and
   * nothing for the host to supply uniformly: step (3), with the reason written.
   *
   * ## Why this is not `preToolCheck` again
   *
   * `preToolCheck` (a `files` row) states who decides a tool CALL. This one is
   * about instruction DELIVERY, which is why it is `abilities` and why it needed
   * its own row: the nearest existing sentence names neither `CLAUDE.md` nor a
   * path-scoped rule, and `grep -ain 'pathScoped|path-scoped|nested'` over this
   * file scored 0 before it landed.
   */
  {
    id: 'pathScopedInstructions',
    bodyKey: 'chat.runtimeSwitch.costPathScopedInstructions',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A subagent that inherits this conversation, and its prompt cache with it.
   *
   * P6.506, ledger H28 — `partial` on all three, and the recorded reason for the
   * one shared constant had expired. Delegated decision Q-den 28 = **option A**:
   * Pi takes the documented interactive default, claude keeps the SDK's, and
   * codex is stated as having no subject. This row is the third of those three,
   * and it lands in the same commit as the default it declares.
   *
   * ## The three runtimes, and they differ for three different reasons
   *
   * - **Pi — `true` since this commit.** `forkSubagentModeEnabled` defaults ON
   *   (`config/background-task-settings.ts`), matching
   *   `sub-agents.md#turn-fork-mode-on-or-off` verbatim: *"Claude Code turns fork
   *   mode on by default in interactive sessions and leaves it off by default in
   *   non-interactive mode with `-p` and in the Agent SDK."* A Nessy Pi session
   *   is the interactive shape.
   * - **Claude — `false`, and doc-correct.** The same sentence says the Agent SDK
   *   default is OFF, and nothing of ours turns it on there: this function has no
   *   claude reader at all. So the claim is not "the SDK cannot fork", it is "a
   *   claude-runtime session does not fork by default", which is what a user
   *   switching actually meets.
   * - **Codex — `false`, and it has no subject rather than a missing switch.**
   *   `thread/fork` (`packages/codex-protocol/generated/ClientRequest.ts`) forks a
   *   THREAD. It is not a subagent inheriting the parent's context and prompt
   *   cache, which is the capability this row prices.
   *
   * ## What the row is about, stated narrowly on purpose
   *
   * Not "forks exist" — `/subtask` starts one by hand on any runtime that has
   * one, whatever the mode. What is lost is the DEFAULT: on the target, each
   * child starts from an empty context and pays for its own tokens, where
   * `sub-agents.md` says a fork's *"first request reuses the parent's prompt
   * cache"*. That is a per-child cost the user pays and nothing else tells them
   * about.
   *
   * `abilities` and not `files`: the child does the same work, more expensively
   * and with less context.
   */
  {
    id: 'forkSubagent',
    bodyKey: 'chat.runtimeSwitch.costForkSubagent',
    consequence: 'abilities',
    on: { pi: true, anthropic: false, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  // RETIRED — `subagentModelOrder` (P6.364's switch-cost row), F1.588 (2026-09-24).
  // Its claude cell said a session-wide subagent model override is ignored there
  // unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, because the bundle then
  // implemented the pre-v2.1.251 order. The 0.3.267 lift (claude 2.1.267) brought
  // the documented order, measured by driving the vendored binary: a definition's
  // `model` beats `CLAUDE_CODE_SUBAGENT_MODEL`, FORCE beats both. So
  // `applySubagentModelOverride` (`agent/options.ts`) now projects the Nessy
  // value as a DEFAULT, all three runtimes agree a subagent's own `model` wins,
  // and a row that can never fire is not a row (P6.896's rule, `webSearch`).
  /**
   * A subagent's own memory — the STORE, not the field.
   *
   * P6.309 arm (3), ledger H23, handed to this file by W8-g (whose own zone
   * closed the other three arms). The row's `done_means` asks for exactly this:
   * "a claude subagent's memory STORE divergence — an agent that learned on Pi
   * starts empty after a switch — carries a `RuntimeSwitchCostRow`".
   *
   * - **Pi — `true`.** Ours, and host-provisioned: `prepareAgentMemoryDirectory`
   *   (`agent/memory/agent-memory.ts`) creates the directory under
   *   `.nessy-agent` (project) or `CONFIG_DIR` (user), appends its `MEMORY.md`
   *   excerpt to the child's prompt and grants `read`/`write`/`edit` — or does
   *   none of the three, so an agent is never told it has a memory it cannot
   *   reach.
   * - **Claude — `false`, and this is the subtle one.** `AgentDefinition.memory`
   *   is a real SDK field and we DO forward it (`claude-runtime-agents.ts`
   *   symbol `buildClaudeRuntimeAgents`), so the child gets a memory — the SDK's
   *   own, at `.claude/agent-memory/<name>/` (`sub-agents.md:518`). A different
   *   store from the one the same agent filled on Pi. The capability this row
   *   prices is not "has memory", it is "reads the memory it wrote here", and
   *   that is what the user meets: an agent that learned something starts empty.
   * - **Codex — `false`, outright.** `[agents.<role>]` declares name,
   *   description and role file only; `CodexAgent.reportUnexpressibleCodexAgentFields`
   *   already names `memory` among the fields it drops per definition (P6.309
   *   arm 2, `dac56191d`). `MemoriesToml` is a session-wide native subsystem our
   *   writer does not use and has no per-role counterpart.
   *
   * Why a row on top of arm 2's notice: that notice fires on an IMPORTED agent
   * that declares `memory`, at spawn, on codex. This fires at the SWITCH, on
   * both vendor legs, before anything spawns — and the claude leg has no notice
   * at all, because nothing there is dropped.
   */
  {
    id: 'subagentMemory',
    bodyKey: 'chat.runtimeSwitch.costSubagentMemory',
    consequence: 'abilities',
    on: { pi: true, anthropic: false, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A subagent's own words, while it is still working.
   *
   * P6.382, ledger K35 — W8-e measured it and handed this row over, because the
   * locale keys are its file and the table is this one. **The row was born
   * saying claude could not do this and that clause is REFUTED:**
   * `forwardSubagentText` is the SDK's own option and P6.561 (`a8377a7fb`) set
   * it, so claude forwards the whole subagent conversation as `assistant` /
   * `user` messages carrying `parent_tool_use_id` and the renderer nests them
   * under the Task row. The sentence therefore points the OTHER WAY from the one
   * the row predicted: Pi is the runtime that only counts.
   *
   * - **pi `false`, MEASURED.**
   *   `packages/pi-agent-server/src/orchestrator/subagent-tool.ts` `onEvent`
   *   raises `toolCalls` on `tool_execution_start` and writes `event.type` into
   *   `lastActivity`, then `emit(notify)`. That is a heartbeat and a counter; the
   *   child's text is forwarded on no branch. The orchestrator owns its children
   *   in-process, so this is a GAP and not an impossibility — which is why the
   *   sentence says "stops being delivered" rather than "cannot be delivered".
   * - **anthropic `true`** since `a8377a7fb`.
   * - **codex `'unmeasured'` — no claim, deliberately.** K5's codex arm was
   *   refuted twice (P3.294 / P3.295 found codex delivering
   *   `item/started` / `item/completed` reasoning the adapter was dropping, after
   *   two docblocks had said it delivered nothing), so an unmeasured `false` here
   *   would be the third instance of the same error. What would settle it:
   *   whether `codex-agent-server`'s notification families carry a nested
   *   `item/*` frame attributed to a spawning tool call
   *   (`codex-notification-families.ts` plus the generated client-notification
   *   table in `packages/codex-protocol/generated/`).
   *
   * **ONE CORRECTION to the hand-off, and it is the most damaging edit this
   * table admits.** The hunk handed over wrote `'codex-runtime': null` with the
   * gloss *"`null` makes the pair `unmeasured` and the dialog marks it"*. It does
   * not. `null` means NOT A SWITCH ENDPOINT: {@link isSwitchableRuntime} requires
   * every row to make a concrete claim about a runtime, so a single stray `null`
   * removes codex from BOTH ends of every direction and silently empties six
   * legs. `'unmeasured'` is the value with the meaning intended, and the
   * gaps-parity suite's per-value tally pin exists for exactly this — it would
   * have caught the `null` at `tally.null` one greater than the row count.
   */
  {
    id: 'subagentOutputText',
    bodyKey: 'chat.runtimeSwitch.costSubagentOutputText',
    consequence: 'abilities',
    on: { pi: false, anthropic: true, 'codex-runtime': 'unmeasured', 'nestor-cloud-agent': null },
  },
  /**
   * An operator's background-task off switch, and the one runtime with nothing
   * to project it onto.
   *
   * P6.696's codex half. The claude half landed in `6981d9950` as native-first
   * tier 1 — the child already reads `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` and
   * only had to be told our name for it — and the row's own instruction for
   * codex was *"project or state the divergence"*. This is the statement, and it
   * is a statement because there is nothing to project.
   *
   * ## Measured against codex's own surfaces, not a page (2026-09-07)
   *
   * Codex HAS background work: `thread/backgroundTerminals/list|clean|terminate`
   * are live methods this fork already drives (`codex-agent.ts`). What it has no
   * switch for is whether they start.
   *
   * - `packages/codex-protocol/schema/config-schema.json`, walked for every key
   *   whose name contains `background`, yields exactly two:
   *   `background_terminal_max_timeout` — *"Maximum poll window for background
   *   terminal output (`write_stdin`), in milliseconds. Default: `300000`"*,
   *   which is a duration and not an off switch — and
   *   `background_paginated_rollout_migration`, an internal rollout-file feature
   *   flag with no relation to the subject.
   * - `[tools]` is the table that could hold one and does not:
   *   `ToolsToml` has exactly three properties — `web_search`,
   *   `experimental_request_user_input`, `update_plan`.
   * - `enabled_tools` / `disabled_tools` are NOT a way round it: every
   *   occurrence in the schema is under `RawMcpServerConfig`,
   *   `PluginMcpServerConfig` or `ToolSuggestConfig`, i.e. per-MCP-server or
   *   per-suggestion, never over codex's own shell.
   * - The shipped binary agrees, which is the evidence that outranks the schema:
   *   `CODEX_DISABLE_BACKGROUND` → 0, `disable_background` → 0, `enable_background`
   *   → 0 over `resources/bin/codex/darwin-arm64/codex-app-server`, with
   *   `background_terminals` → 3 and `unified_exec` → 142 as the positive
   *   controls proving the probe reads the file.
   *
   * ## Why this is not "build it host-side" (native-first step 2, asked)
   *
   * A background terminal is created inside codex's own tool loop by its own
   * shell tool; the host does not mediate the call. The only host lever is
   * `thread/backgroundTerminals/terminate` AFTER the fact — a race that kills
   * work the model is doing rather than preventing it from starting, which is
   * construction beside a runtime rather than a mechanism. So the residual
   * difference is stated instead, which is the half native-first does not supply
   * on its own.
   *
   * `abilities` and not `files`: nothing the operator forbade gets WRITTEN that
   * would not have been; what changes is that a long command can be left running
   * unattended on a runtime where the operator said it could not.
   */
  {
    id: 'backgroundTaskOffSwitch',
    bodyKey: 'chat.runtimeSwitch.costBackgroundTaskOffSwitch',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * Whether the model's own reasoning survives a handoff at all — the row
   * P6.481 earns, and the table could not express it before P2.484's
   * `'conditional'` existed.
   *
   * ## What this row does NOT price, said first because it is the confusing part
   *
   * Reasoning does not cross BETWEEN runtimes, on any leg, including this one.
   * `buildRuntimeHandoffHistory` emits a `reasoning` entry only when the row's
   * own origin equals the runtime taking over (owner Q10/Q16 = (b)); a
   * foreign-origin block is dropped there rather than re-spoken, and P6.87's
   * honest sentence covers that loss. **That is uniform across all six legs, so
   * by this table's own admission rule it is not a switch cost** — the same
   * ground the `configRequirements` rejection at the top of this file rests on.
   * The copy says it in a second sentence anyway, because a user reading the
   * first one would otherwise conclude the opposite.
   *
   * ## What it DOES price: whether the target can carry reasoning at all
   *
   * - **pi `true`** — `@earendil-works/pi-ai` declares `ThinkingContent` =
   *   `{ type: 'thinking'; thinking: string; thinkingSignature?: string;
   *   redacted?: boolean }` beside `TextContent`, and its own docblock says the
   *   payload exists so it can be passed back for multi-turn continuity.
   *   `pi-session-rebuild.ts` writes it. A native slot, not an adapter.
   * - **anthropic `true`** — `ThinkingBlockParam` is
   *   `{ signature: string; thinking: string; type }` with `signature`
   *   REQUIRED, so `claude-transcript-rebuild.ts` replays a signed block and
   *   STRIPS an unsigned one: not a policy choice, an unsigned block is not
   *   expressible.
   * - **codex `'conditional'`, and this is the cell the row exists for.**
   *   `thread/inject_items` takes
   *   `{type:'reasoning', summary:[…], encrypted_content:null}` with nothing to
   *   enable, so a Responses-API connection carries it. The GATEWAY leg has no
   *   slot — reasoning has nowhere to go on chat-completions
   *   (`anthropic/to-chat.ts`) — so one codex connection carries it and another
   *   does not. That is a property of the model's WIRE rather than of the
   *   runtime, which is why a boolean would be wrong on half of codex's
   *   connections either way, and it is the shape P3.280 already had to adopt
   *   for images.
   *
   * A `'conditional'` TARGET fires and a `'conditional'` SOURCE does not, so
   * this lands on both forward legs into codex and on neither leg out of it —
   * the rule stated at {@link switchCostCertainty}, applied unchanged.
   */
  {
    id: 'reasoningCarry',
    bodyKey: 'chat.runtimeSwitch.costReasoningCarry',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': 'conditional', 'nestor-cloud-agent': null },
  },
  /**
   * Whether a model REFUSING TOOLS moves the fallback chain forward — P6.743,
   * and the one trigger in that chain no page settles on either runtime.
   *
   * ## The row exists because the code FIRES, which is what the plan asked
   *
   * `model_no_tool_support` sits in Pi's `FALLBACK_MODEL_RETRY_ERROR_CODES`
   * (`pi-agent.ts`) and its own comment there says the page names it in neither
   * direction. The open question was whether anything can ever emit it, and it
   * can — measured at HEAD along the whole path rather than inferred from the
   * set: the Pi SDK reports a provider failure as `stopReason: 'error'` +
   * `errorMessage`, `backend/pi/event-adapter.ts` classifies that string with
   * the host's `parseError`, which mints this code from seven published refusal
   * phrasings (`errors.ts` — OpenRouter's *"No endpoints found that support tool
   * use"* among them), and a classified error is yielded as `typed_error`,
   * which is exactly what `getRetryFallbackModel` reads. So a Pi user whose
   * gateway model will not take tools has their turn handed to the next model in
   * the chain.
   *
   * ## codex `false` — MEASURED, and not by an absent grep
   *
   * `CODEX_FALLBACK_RETRY_ERROR_CODES` holds three members — `serverOverloaded`,
   * `internalServerError` and `flexUnavailable` (F1.1224) — translated from the
   * page's own trigger sentence into `CodexErrorInfo`'s twenty. A provider's tool-use
   * refusal arrives there as `badRequest`, which that same docblock rules out by
   * name — *"none is a server verdict on the MODEL"*. The chain exists on codex
   * and does not move for this failure.
   *
   * ## claude `'unmeasured'` — the honest cell, and why not `false`
   *
   * The claude ladder is not ours: `buildClaudeFallbackModelOptions` hands the
   * whole chain to the child as ONE `--fallback-model` string
   * (`claude-agent.ts`) and the binary decides which failures walk it.
   * `model-config.md#fallback-model-chains` names what switches (*"overloaded,
   * unavailable, or … another non-retryable server error"*) and what never does
   * (*"Authentication, billing, rate-limit, request-size, and transport errors,
   * and a denial by your organization's policy check"*) — a tool-support refusal
   * is in NEITHER list, and the binary is closed. `false` would assert an absence
   * nobody drove, `true` a capability nobody drove; `'unmeasured'` is the only
   * claim that is true, exactly as P6.562 built it for.
   *
   * That makes this row fire on three legs and no more: Pi → Claude and
   * Claude → Codex under the marker, Pi → Codex measured. It does NOT fire
   * Claude → Pi, because an unmeasured source into a target that has the
   * capability outright returns null — we do not warn about gaining something.
   *
   * `abilities` rather than `files`: a chain that stops moving changes whether
   * the turn runs at all, not what lands in the working tree.
   */
  {
    id: 'toolSupportFallback',
    bodyKey: 'chat.runtimeSwitch.costToolSupportFallback',
    consequence: 'abilities',
    on: { pi: true, anthropic: 'unmeasured', 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A session-level restriction on the BUILT-IN tool set — P6.596, and its Pi
   * half is P6.852.
   *
   * P6.217 landed the input (`sessionAllowedTools` / `sessionDisallowedTools`,
   * one resolver `getSessionToolUniverse()`), and this row was deliberately
   * withheld until it did: a cost row about a capability nobody could set yet
   * would have fired on every switch into codex and said something untrue.
   *
   * That reasoning was RIGHT and the premise under it was wrong for a day. The
   * input landed in `config-defaults.json`'s `workspaceDefaults`, which
   * `syncConfigDefaults` rewrites from the bundled asset on every launch, so
   * nobody could set it after all — P6.912 moved both keys into `config.json`
   * and the sentence above became true retroactively.
   *
   * ## The three arms, all measured
   *
   * - **Claude `true`.** Both halves are the SDK's own: `Options.tools` narrows to
   *   the whitelist (F1.638) and `Options.disallowedTools` takes the blacklist,
   *   ADDED to `CLAUDE_SESSION_DISALLOWED_TOOLS` rather than replacing it — a
   *   list that could unban one of those entries would be a permission widening
   *   dressed as a preference. The whitelist narrows BUILT-IN tools only:
   *   `--tools` "doesn't affect MCP tools" (`cli-reference.md#cli-flags`;
   *   measured 47 MCP tools before and after), while Pi's allow list is the
   *   whole universe and removes an MCP tool it does not name. So the same
   *   list means different things on the two, and F1.662 put that in the copy
   *   rather than projecting the MCP half onto claude deny rules — that would
   *   be a product decision (our own `mcp__session__*` tools carry host
   *   features), not a transcription. The operator's MCP lever on claude is
   *   `sessionDisallowedTools` with an `mcp__<server>__*` entry.
   * - **Codex `false`, and structurally so.** `enabled_tools` / `disabled_tools`
   *   in the codex config reach MCP SERVERS, not built-in tools (ledger A10,
   *   `config-writer.ts`). There is no key to write and nothing to project one
   *   onto, so this is an absence that is measured rather than merely observed.
   * - **Pi `'conditional'`, and the condition is WHICH HALF the setting uses.**
   *   The whitelist arrives: `piAllowedTools` is "the turn's tool universe when
   *   the host pins one" and `base-agent.ts` enforces it. The blacklist does
   *   NOT, and is deliberately not faked — `piAllowedTools` is a positive NAME
   *   list, and `piSkillDisallowedTools`, the one field that removes without
   *   naming a universe, is skill-scoped by contract. So a user who narrows by
   *   allow-list keeps everything crossing into Pi and a user who narrows by
   *   deny-list silently loses it.
   *
   * ## Why `'conditional'` and not `false`
   *
   * `false` would assert Pi lacks the capability, and Pi has half of it —
   * exactly the claim {@link RuntimeSwitchClaim} says `false` must not make.
   * `'conditional'` is the value for a capability the runtime has only when a
   * precondition holds that this table cannot evaluate, and it cannot evaluate
   * this one either: the dialog is drawn before the target session exists, and
   * the setting is a workspace default the renderer does not hold. The
   * precondition here is a CONFIGURATION rather than a runtime accident, which
   * is a wider reading than `bridgeTools` gave the value — recorded rather than
   * assumed, because the block above reserves it for "one measured shape" and
   * `webSearch` — retired by P6.896, see the module header — had already widened
   * it once to a target model's wire.
   *
   * ## The leg this row does NOT fire on, stated rather than left to be found
   *
   * A `'conditional'` SOURCE never fires, so **Pi → Codex is silent** even
   * though a Pi session narrowed by allow-list loses that narrowing outright on
   * codex. That is the module's known under-warn direction and it is the price
   * of not lying about Pi in the other three. The alternative — `pi: false` —
   * buys the Pi → Codex line by telling every claude → Pi switcher that their
   * allow-list stops working, which is false for the half of the setting that
   * does work.
   *
   * **Pi → Claude is silent too, for the same reason**, and it has a leg of its
   * own since F1.638: an allow list that hid MCP tools on Pi leaves them
   * available on claude. The copy names that difference for the legs that DO
   * fire (claude → Pi, claude → Codex), so a user who reads it once knows it.
   *
   * `abilities` rather than `files`: the restriction changes what the model may
   * call, not what lands in the working tree.
   */
  {
    id: 'toolRestriction',
    bodyKey: 'chat.runtimeSwitch.costToolRestriction',
    consequence: 'abilities',
    on: { pi: 'conditional', anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A session that RUNS AS an agent, rather than one that delegates to it.
   *
   * P6.312 (`c3eb37ba5`), denominator H30. The row was `absent` on all three
   * until the claude arm landed, and this is the verdict that arm owes: a native
   * mechanism adopted on one runtime without a switch verdict is a new silent
   * divergence, not a closed gap.
   *
   * - **Claude — `true`.** `Options.agent` is the SDK's own member — *"Agent
   *   name for the main thread. When specified, the agent's system prompt, tool
   *   restrictions, and model will be applied to the main conversation"* — and
   *   `AgentDefinition.initialPrompt` is auto-submitted by the child. The host
   *   supplies the name from its `sessionAgent` key and withholds only the model
   *   half, out loud (owner option (b), so the session keeps one upstream).
   * - **Pi — `true` since P6.940 clause (2) (`fb011ffcb`, 2026-09-09), and this
   *   cell said `false` for a day after that (P6.1018).** The harness manifest
   *   still carries agent definitions for DISPATCH only and `spawner.ts`'s every
   *   entry point still composes a CHILD — Pi has no main-session-agent option
   *   of its own — so the capability is the HOST's, composed once in
   *   `SessionManager.ts` (`resolvePiSessionAgentPin`) out of the roster it has
   *   just materialized and delivered through three fields that already existed.
   *   It reads the same `sessionAgent` key the claude arm reads, so the two
   *   runtimes cannot disagree about which agent is pinned. Native-first step 2:
   *   the host supplies uniformly what the runtime lacks, and the cell follows
   *   the CAPABILITY the user gets, never the mechanism that provides it — a
   *   dialog that priced host-composed and runtime-native differently would be
   *   telling the user about our implementation instead of about their session.
   * - **Codex — `false`.** Role config layers exist for spawned agents only; the
   *   main thread takes `developer_instructions` and nothing selects a role for
   *   it, and P6.940 deliberately did not project there: the instructions could
   *   ride the developer block, but the tool restriction and the auto-submitted
   *   opening prompt have no counterpart, and a half-applied pin is worse than
   *   an absent one because only the half that failed is invisible.
   *
   * So it fires on the two legs INTO codex and on no other, which is the honest
   * shape today: claude and Pi both have it, codex does not, and telling someone
   * switching INTO a runtime that they gain something is not this dialog's job.
   * Until P6.1018 it also fired on `anthropic → pi`, naming a loss the switcher
   * had not taken since `fb011ffcb`.
   *
   * `abilities`: it changes the instructions and the tool set the model works
   * under, not what lands in the working tree.
   */
  {
    id: 'sessionAgent',
    bodyKey: 'chat.runtimeSwitch.costSessionAgent',
    consequence: 'abilities',
    on: { pi: true, anthropic: true, 'codex-runtime': false, 'nestor-cloud-agent': null },
  },
  /**
   * A code review codex is running in the background is abandoned by the switch.
   *
   * C4.42's residue, owed by the flip that made it ordinary. Until 2026-09-13 a
   * codex `/code-review` detached only when the MODEL set `background`, so the
   * abandonment below was something a user reached deliberately; option B made
   * detaching the DEFAULT on every runtime (`code-review.md#run-in-the-foreground`:
   * *"The review runs in the background by default"*), which promotes this
   * residue from an exception to the ordinary case. `CODEX_DETACHED_REVIEW_SWITCH_NOTE`
   * (`packages/shared/src/agent/backend/codex/detached-review.ts`) has stated it
   * since the mechanism was built and had NO product reader — a constant nothing
   * surfaces is not a disclosure.
   *
   * ## Why it is a set difference and not "background reviews are lost anywhere"
   *
   * On Pi and claude a backgrounded review is a SUBAGENT of this session: it
   * lives in the host's own process tree and its findings arrive on the session
   * that asked for them. On codex it is a codex THREAD — `review/start` with
   * `delivery: "detached"` returns a `reviewThreadId`, and the findings come
   * back through `admitDetachedReviewNotification` on that thread. The thread
   * belongs to the app-server, so it does not survive the session moving to a
   * runtime that has no app-server: the capability being lost is *a review that
   * keeps running on a thread of its own*, which only codex has.
   *
   * ## The bound this row must not exceed
   *
   * It is NOT "your review is wrong on codex". The review itself matches — the
   * host computes ONE diff (`packages/shared/src/prompts/review-diff.ts`) and
   * hands codex its own rubric through a `custom` ReviewTarget, which is the
   * whole reason `buildCodexDetachedReviewParams` declines the three native
   * targets. What is lost is the RUN in flight, and the copy says to start it
   * again after the switch rather than implying the finding would differ.
   *
   * `abilities`: nothing in the working tree changes — what is lost is work the
   * user delegated and the findings it would have returned.
   */
  {
    id: 'codexDetachedReview',
    bodyKey: 'chat.runtimeSwitch.costCodexDetachedReview',
    consequence: 'abilities',
    on: { pi: false, anthropic: false, 'codex-runtime': true, 'nestor-cloud-agent': null },
  },
  // ==========================================================================
  // TWO ROWS THAT ARE DELIBERATELY NOT HERE, and the measurement for each.
  //
  // Both were asked for by name in their own plan rows, and both would fire on
  // NO ordered pair. `switchCostCertainty` fires only on
  // `from === true && (to === false || to === 'conditional')` — a capability
  // LOST — so a claim that is uniform across the three runtimes, in EITHER
  // direction, cannot produce a cost. No row above is uniform, and
  // that is the rule rather than an accident: a row that can never fire is a
  // sentence nobody will ever read, sitting where a reader assumes everything
  // fires somewhere.
  //
  // 1. P6.515 — the operator's system-prompt APPEND. It arrives on all three:
  //    Pi's own base prompt and claude's `{ type: 'preset', append }` share one
  //    site (`prompts/system.ts`), codex takes the same block through
  //    `developerInstructions`. Every cell is `true`. What DOES differ is the
  //    SLOT the text lands in, and the table has no vocabulary for "arrives, in
  //    a different place" — `'conditional'` names a per-session precondition,
  //    which a slot is not, so marking two runtimes conditional to make the row
  //    fire would be a lie that fires. The per-runtime precedence is recorded
  //    where it is true instead: the slot table in
  //    `packages/shared/src/prompts/system-prompt-append.ts`, beside the four
  //    `cli-reference.md` flag names and the refusal of the replacing pair.
  //
  // 2. P6.346 (b)/(c)/(d) — a LIFETIME output ceiling and an OS memory-pressure
  //    reaper for a background shell. W8-lo2 measured this from the other side:
  //    `memoryPressure` scores 0 over `packages` + `apps`, and Pi's own cap is a
  //    64 KiB RING (`process-store.ts`) that drops older output while the
  //    process keeps running, so no runtime has the capability and every cell
  //    would be `false`. Clause (a) of that row — the claude-only, Linux-only
  //    `CLAUDE_CODE_TOOL_MEMORY_LIMIT` — DID produce a row, and it is
  //    `toolMemoryCap` above, which is exactly why the rest of the row does not
  //    get a second one.
  // ==========================================================================
])

/** Rank order, worst consequence first. Asserted, not assumed. */
export const RUNTIME_SWITCH_COST_CONSEQUENCE_ORDER: readonly RuntimeSwitchCostConsequence[] =
  Object.freeze(['files', 'abilities'])

/**
 * Is this runtime a switch endpoint at all?
 *
 * Derived from the rows rather than declared beside them: an endpoint is a
 * runtime every row makes a CONCRETE claim about. A runtime the table declines
 * to describe (`null` everywhere) is not an endpoint, and a provider string that
 * is not in the vocabulary at all — a session persisted by a newer build — is
 * refused before it can index a row.
 */
function isSwitchableRuntime(runtime: ModelProvider): runtime is SwitchableRuntime {
  if (!(AGENT_PROVIDERS as readonly string[]).includes(runtime)) return false
  return RUNTIME_SWITCH_COSTS.every(row => row.on[runtime] !== null)
}

/**
 * What moving from `from` to `to` costs, ranked, worst first.
 *
 * Empty when nothing is lost — which today is a switch that does not change
 * runtime, and nothing else. **That sentence used to begin "which is every
 * switch back onto Pi", and P6.65/P6.170 spent it**: `credentialShellFloor` and
 * `policyKeys` are the first two rows a runtime OTHER than Pi holds, so both
 * return legs now carry one line each. Which legs are empty is asserted in
 * `__tests__/runtime-switch-costs.test.ts` by RUNNING this function, never
 * restated here, because a leg's emptiness is a property of the row set and the
 * row set grows.
 *
 * An unknown runtime on either end (`nestor-cloud-agent` is the only one today,
 * and it is neither a switch source nor a target) yields nothing rather than a
 * guess: a wrong list here is worse than no list, because this one is meant to
 * be trusted.
 */
export function runtimeSwitchCosts(from: ModelProvider, to: ModelProvider): RuntimeSwitchCost[] {
  if (!isSwitchableRuntime(from) || !isSwitchableRuntime(to)) return []
  if (from === to) return []
  return RUNTIME_SWITCH_COSTS
    .flatMap(row => {
      const certainty = switchCostCertainty(row.on[from], row.on[to])
      return certainty ? [{ id: row.id, bodyKey: row.bodyKey, consequence: row.consequence, certainty }] : []
    })
}

/**
 * Does this row fire for this ordered pair, and how sure are we?
 *
 * `null` — it does not fire. Every arm is an EXPLICIT value, never truthiness: a
 * `null` claim must not read as "does not have it" and manufacture a cost out of
 * a silence. (`isSwitchableRuntime` already excludes any runtime a row is silent
 * about, so a `null` cannot reach here — the explicitness is what keeps that
 * true if the endpoint rule ever loosens.)
 *
 * P2.484 — the SOURCE must be a definite `true` and the TARGET must be anything
 * but. `'conditional'` on the target fires, because a capability that depends on
 * a per-session precondition this module cannot evaluate is not one the user can
 * be told they keep; `'conditional'` on the source does not, because warning
 * about the loss of something that may never have existed is noise rather than
 * safety.
 *
 * ## The reason that rule used to give is FALSE at HEAD (C3.60, 2026-09-11)
 *
 * It read *"the only conditional runtime today (codex, on its host-callback
 * bridge) can only lose to a target that has the capability outright"*. Measured
 * over this module's own rows on the day this was written: **five** carry
 * `'conditional'` — `worktreeMove`, `bridgeTools`, `scheduledRun` and
 * `reasoningCarry` on `'codex-runtime'`, and `toolRestriction` on **`pi`**. So
 * codex is not the only conditional runtime, and the one claim that sits on a
 * SOURCE is Pi's. Re-derive rather than trust the number: every `'conditional'`
 * a row declares is visible in {@link RUNTIME_SWITCH_COST_CLAIMS}, which is
 * built from the rows and cannot drift from them.
 *
 * ## So the silent-source arm has a known under-warn direction, named here too
 *
 * **Pi → Codex is silent** even though a Pi session narrowed by allow-list loses
 * that narrowing outright on codex — the `toolRestriction` row's own docblock
 * prices that leg (§"The leg this row does NOT fire on") and this rule is where
 * the suppression actually happens, so both places say it. The alternative —
 * spelling that cell `false` — would buy the Pi → Codex line by telling every
 * claude → Pi switcher that their allow-list stops working, which is false for
 * the half of the setting that does work. The rule is kept and its cost is
 * stated; it is not traded away.
 *
 * P6.562 — `'unmeasured'` on either end yields the same verdict the measured
 * arms would have given, carried out under a marker instead of being dropped.
 * The two `null` returns in that branch are the ones to read: a source that
 * CANNOT have the capability loses nothing whatever we know about the target,
 * and a target that has it outright keeps it whatever we know about the source.
 * Everything else on that branch is a real "we do not know", which is what the
 * dialog then says.
 */
function switchCostCertainty(
  from: RuntimeSwitchClaim,
  to: RuntimeSwitchClaim,
): RuntimeSwitchCostCertainty | null {
  if (from === 'unmeasured' || to === 'unmeasured') {
    if (from === false || from === null) return null
    if (to === true) return null
    return 'unmeasured'
  }
  return from === true && (to === false || to === 'conditional') ? 'measured' : null
}

/** Every body key the table can emit — the set the locale files must cover. */
export const RUNTIME_SWITCH_COST_BODY_KEYS: readonly string[] =
  Object.freeze(RUNTIME_SWITCH_COSTS.map(row => row.bodyKey))

/**
 * The rows' claims, by row id — DERIVED from the rows, not a second copy.
 *
 * Exported so P2.124's totality property can be swept over this site from a
 * test without exporting the rows themselves (whose bodies and ordering are
 * production detail). It restates nothing: a row added, removed or re-keyed
 * moves this map with it.
 */
export const RUNTIME_SWITCH_COST_CLAIMS: Readonly<
  Record<string, Readonly<Record<ModelProvider, RuntimeSwitchClaim>>>
> = Object.freeze(Object.fromEntries(RUNTIME_SWITCH_COSTS.map(row => [row.id, row.on])))
