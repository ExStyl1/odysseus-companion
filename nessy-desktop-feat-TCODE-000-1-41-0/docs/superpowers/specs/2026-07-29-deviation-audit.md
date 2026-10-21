# Parity Series — Remediation Report (superseded as a worklist; kept for §1, §3 and §4)

> **SUPERSEDED AS A WORKLIST, 2026-07-30. Do not dispatch anyone from §2.** The
> acted-on version is `docs/superpowers/specs/2026-07-29-deviation-worklist.md`,
> which re-verified these rows against a current HEAD and found 16% of them
> unactionable as written. Every unit that ran, ran from that file.
>
> **Kept because three sections exist nowhere else**, and deleting the file
> would delete them:
>
> - **§1's corpus statistics and evidence-quality table** — 7 measured, 23
>   cited, 115 asserted-only, 14 with no reason at all, and the 81% figure. The
>   tracker does not carry any of it.
> - **§3's eight obligation-2 invention cases.** `unattributedTokens` appears in
>   no plan; the phrase "obligation 2" appears nowhere else under `docs/`.
> - **§4's ten probe designs.**
>
> Known stale within it, beyond the receipt caveat below: the R28 entry's claim
> that the path-scoped-rule hop was left unwired (it is wired), and the six rows
> the worklist proved unactionable.

> **Staleness caveat, added by the planner on receipt.** The report says it was
> verified against HEAD `0a77b5ea` — that is the branch state at the *start* of
> the session that commissioned it, not the state it was delivered into. Between
> the two, R17b, R25a, R25b, R26, R26b, R27a and R30a all landed.
>
> The four spot-checks named below were re-run and are trustworthy: I
> independently confirmed the P6 config-guard finding and fixed it (`f4ae5596`).
> But at least one row is demonstrably stale — the R28 entry claims the
> path-scoped-rule hop into `pi-agent.ts` "was left unwired", and it is wired at
> `pi-agent.ts:3391`/`:3481` (`54f00243`).
>
> **Therefore: every row must be re-verified against current HEAD before anyone
> is dispatched to fix it.** Acting on the list as written would send executors
> at already-closed work, and a second "fix" of a fixed thing is how regressions
> get written. The re-verification pass is tracked as the first item of
> programme phase 1.
>
> Nothing else about the report is diminished by this. Its central findings — 0
> of 159 deviations categorised, 81% carrying no evidence beyond an assertion,
> and a 100% fall rate on the 15% that were adversarially challenged — are
> properties of the plan corpus, which the staleness does not touch.


*Verified against HEAD `0a77b5ea` (branch `fix/renderer`) on 2026-07-29. Spot-checks re-run for the four claims this report's priority order depends on: `pre-tool-use.ts:389`/`:466` still read `input.file_path` only; `hook-command.ts` still `return undefined` on a failed non-2 exit; `format-adapters/claude.ts` has no MCP `timeout` read (its only `timeoutMs` at `:893` is the hook timeout); `claude-agent.ts` has zero occurrences of `enableFileCheckpointing` or `additionalDirectories`.*

---

## 1. The count

**159 recorded deviations across 32 units** (P3–P10, R1–R30a). Four have since been closed by successor units (P7 lazy resources → R17; P7 `allowed-tools` → R17b; R10 elicitation exclusion → R24; R1 fatal-on-inert managed rules → reversed by R25a's tolerant parser), so **155 are live**.

**How they should now be recorded:**

| Category | Count | Notes |
|---|---:|---|
| **A** — documented, implemented | **2** | Both were *mis*recorded as gaps. P5's "MCP user scope across all workspaces" has shipped since `b0053399` (2026-07-19) at `native-sources.ts:721`, measured working across two workspaces; the real gap is the *precedence* half, which is a separate C row. R1's "unmatched rule forms abort startup" was reversed by R25a — the strict parser has zero production callers; production uses `parseManagedPiPolicyTolerantV1`. Residual C: no startup warning surface. |
| **B** — documented, impossible on Pi, Pi equivalent shipped | **0** | Not one deviation in the series meets the bar. See §3. |
| **C** — documented, not implemented | **153** | Everything else: deferrals, scope decisions, unowned follow-ups, and self-authored posture changes. |

**Never categorised at all: 159 of 159.** Every extracted deviation carries `claimedCategory: "unstated"`. The three-category discipline was applied zero times across the series.

**Evidence quality against obligation 1 ("demonstrate, do not assert"):**

| Evidence | Count | Share |
|---|---:|---:|
| measured (probe / benchmark / reproduced failure) | 7 | 4% |
| cited to an SDK type or doc line | 23 | 14% |
| asserted only | 115 | 72% |
| **no reason given at all** | **14** | **9%** |

**129 of 159 (81%) carry no evidence beyond an assertion — 14 of those carry no stated reason whatsoever.**

**Adversarial coverage: 24 of 159 (15%)**, concentrated in six units (P5, P4, P6, P3, R1, R21); **26 units and 135 deviations were never challenged**. Of the 24 challenged:

- **0 genuinely impossible**
- **8 already-possible** (the mechanism ships today; nobody wired it — in two cases the premise was factually false)
- **16 possible-with-effort**
- Effort: **16 small, 8 medium, 0 large**

The challenge pass has a 100% fall rate. Nothing survived contact with a probe.

---

## 2. Unjustified divergences, ordered by parity distance

**129 items qualify** (possible / already-possible, or asserted-only / no-reason). `†` = adversarially adjudicated, effort from the verdict. `~` = estimated.

### Tier 1 — security and permission-decision behaviour (fix first)

| Unit | Docs say | We do | Close it | Effort |
|---|---|---|---|---|
| **P6** | Guards on agent writes to its own permission/automation config gate every backend | `validateConfigWrite` (`pre-tool-use.ts:389`) and the automations guard (`:466`) read `input.file_path` only. Pi's `write`/`edit` send `path`, so both see `''` and **never fire on the shipped backend**. Measured: `{path}` write of an invalid statuses config → `valid:true`; `{path}` write to `automations.json` → allow | Extract the dual-spelling read already at `:808-810` into `toolTargetPath()`; use at `:389`/`:466`. Also fold Pi's `edits[]` in the Edit branch — measured, `old_string` is `undefined` so a *corrupting* edit currently validates. Pin `CONFIG_WRITE_TOOLS` against `PI_TOOL_BINDINGS` | † small (already-possible) |
| **P3** | A failing hook shows `<hook name> hook error` + first stderr line in the transcript; full stderr to debug log | Any non-zero except 2 → `getHookCommandPreToolDecision` returns `undefined`; both consumers drop it. No log, no warn, no event. **A security hook that crashes permits the call with zero signal** — worse than the contract we copied | Emit at `SessionManager.ts:3833-3839` (already computes redacted stderr and `outcome:'error'`) on the shipped `role:'info'` / `infoLevel:'warning'` transcript channel; `handleSessionMirrorError` (`:3173`) is the working template | † small (already-possible) |
| **P3** | 0/2/other exit contract is Claude's | Applied unconditionally by both hook constructors, so **Codex, legacy-Nessy and native `nessy-plugin-json` hooks stopped blocking on exit 1** — a wider blast radius than the audit records | Add semantic `exitCodeContract?: 'claude-three-way'` to `PluginHookDescriptor`, set by the Claude adapter only; clone the `asyncRewake` plumbing (already traverses this exact chain in 6 files) | † small |
| **R1** | An unparseable Bash command (or >10 000 chars) **prompts** | `'unsafe-shell'` short-circuits to `deny`. Measured inversion: with a benign `Bash(git *)` **allow** rule present, `echo "oops` → `deny` attributed to the allow rule; with no rule → prompt. Adding an allow rule turns prompts into hard blocks for unrelated commands | New `'prompt-anyway'` sentinel at `permission-dsl.ts:617`, fed as an `ask` candidate through existing ACTION_WEIGHT selection (mutation probe: 2 lines + 6-line branch, all four rows conform, 12/12 tests green) | † small (already-possible) |
| **R1** | Command substitution does not void a Bash prefix allow (docs list it only for the `bypassPermissions` circuit breaker, and name `curl $URL` as a fragility they deliberately don't defend) | Line 285 vetoes any glob allow rule against `$()`/backticks. Also over-broad: `$((1000*30))` arithmetic (executes nothing) is vetoed and **no rule string can approve it** | Delete `claude-bash-rule.ts:285`; flip the two self-authored test rows (measured: only assertion in 227 that changes). If wanted, express it where Claude does — a shipped ask/deny rule or a PreToolUse hook | † small |
| **R1** | Project `.claude/settings.json` supplies allow/ask/deny; `deny`/`ask` apply even untrusted | Not read at all. Deferred to R25 — **R25 has since closed without touching it; no unit owns this** | `claude-project-settings.ts` mapping through the existing `parseClaudeRuleString`; register as project-scope records beside `.nessy-agent/permissions.json` (`native-sources.ts:839`). Probe: all 5 rules from a verbatim Claude block compiled, **0 inert**, trust gate already behaves | † medium |
| **R1** | `defaultMode` + managed-only admin locks (`allowManagedPermissionRulesOnly`, `disableBypassPermissionsMode`, `disableAutoMode`, `allowManagedHooksOnly`) | None shipped; deferred to R25, which closed without them. R25a's own executor searched and reported the key "does not exist" | The suppression mechanism already exists at `permission-dsl.ts:436-437` — probe: adding the one-predicate managed-only filter leaves exactly the managed rule, 0 diagnostics. `disableAutoMode`/bypass are functionally shipped as `disabledPermissionModes` (scope-narrowed) — record as such | † small |
| **R1** | Permission rules merge into the sandbox boundary (`allowWrite`←`Edit` allow, `denyWrite`←`Edit` deny, `denyRead`←`Read` deny; `autoAllowBashIfSandboxed`) | No merge. The stated blocker ("no such keys in `ManagedPiPolicyV1`") is false — `sandbox.deniedReadRoots` and `additionalWritableRoots` are fields of the same parsed object, and `resolveSandboxSettingsForHost` already receives both halves | Ran the full conversion end-to-end on shipped code: `Edit(//tmp/build/**)` → `(allow file-write* (subpath "/tmp/build"))`, `Read(//etc/shadow)` → deny read+write. Add `deniedWriteRoots` (all three backends already emit the primitive). **Separately: `additionalWritableRoots` is never passed to `ProcessSupervisor` — the grant half of sandbox settings is inert today** | † medium |
| **R1** | `Cd(pattern)`: whole-path matching, `*` = one segment, any allow rule switches `/cd` to allowlist mode | Inert warning. Reason given ("no `/cd` surface") is false: `SessionManager.mutateWorkingDirectory:12613` is the chokepoint, its own comment says "the same transaction `/cd` uses", reached by a user-driven folder picker with a trust prompt and by an `updateWorkingDirectory` RPC. Managed policy **strips** `Cd` rules today | Measured: 9/10 documented rows already pass with `matchGitignoreGlob`; the one gap is the bare-literal float at `gitignore-glob.ts:53-57`. Add a `cd` matcher, evaluate at the single chokepoint | † medium |
| **R1** | `PowerShell(...)` rules: alias canonicalisation, case-insensitive, AST split | Inert warning. Both stated reasons are false on HEAD: a complete AST matcher ships (`powershell-parser.ps1` + `powershell-validator.ts`, `spawnSync`, bundled to `dist/resources`, already consumed by `mode-manager.ts:1443`), and the Pi harness runs `cmd.exe` on win32, not Git Bash. Deferral target B3 is *isolation hardening* — it does not own this | `claude-powershell-rule.ts` mirroring `claude-bash-rule.ts`'s hand-rolled splitter + static alias table; add a `powershellPattern` matcher kind | † medium |
| **R1** | "Yes, don't ask again" persists as rules in `.claude/settings.local.json` at the git root | Persists nothing. Worse: the stated owner does not exist on Pi — `pi-agent.ts:6058` does `void alwaysAllow;`, and both direct resolvers drop the flag, **while the renderer still shows the "Always allow" button for every ordinary Pi prompt** | Step 1: make `alwaysAllow` reach the session whitelist on Pi, or set `noAlwaysAllow`. Step 2: `PermissionRuleConsentStore` modelled on the shipped `WorkflowLaunchConsentStore`, writing into the already-discovered `.nessy-agent/permissions.json` `permissionDsl` block | † medium |
| **P3 / R15** | PreToolUse `allow` skips the prompt (deny/ask rules still evaluated) | Hooks run after the gate; `applyPreToolUseHookDecision` returns `prompt` unchanged before reaching the `allow` branch. Measured: an unmodified Claude plugin hook returning `allow` produces byte-identical `outcome:"ask"`. Our floor already equals Claude's, so the ordering buys nothing | ~10-line branch at the R15 band site (`pi-agent.ts:3785`), gated by the shipped `promptIsNonNegotiable`. Also fix audit `:1176`, which still claims this as "ahead" with drifted anchors | † small |
| **R21** | `autoMode.classifyAllShell` suspends every Bash/PowerShell allow rule so the classifier sees every command | Rejected by `exact()` and pinned rejected. Reason ("no consumer, band not threaded") is false — R21 itself threaded the identical options bag, and the guardian classifier is default-ON | Probe: 6-line branch in `shouldPromptInAutoMode` flips `npm test`/`git status` from "allowed, classifier never sees it" to `band:bash`, unchanged when off. Mark the resulting prompt non-negotiable so a DSL allow can't clear it | † small |
| **R21 / P10** | Model-facing Bash `dangerouslyDisableSandbox`; documented ask rule `Bash(dangerouslyDisableSandbox:true)` | No producer at all. The stated blocker rules out a *child*-supplied flag — which is the security property, not a limitation. The **host** already sees the full Bash input, mints the `decisionId`, and holds the `executionId` correlation key; enforcement (`resolveIsolationDowngrade`) ships and is tested | Host-side producer at `handleProcessStartRequest:4594` from an `executionId→decisionId` map; child allowlist untouched. Ask rule needs two small fixes: `claude-permission-rules.ts:281-283` routes `Bash(param:…)` to a command pattern that never matches, and `permission-dsl.ts:681` compares `'true'` to boolean `true` | † medium |
| **P10** | Settings merge is concat-and-dedupe, most-specific last | Grant keys (`excludedCommands`, `additionalWritableRoots`) made a managed **maximum**; `allowUnsandboxedCommands` boolean-AND | Defensible security posture, but it is our design, not the documented merge. Record as C with the lock rationale; do not leave it implied | ~ record |
| **P10 / R19** | Per-domain egress: no domains pre-allowed, first connection prompts, session-scoped approval, `deniedDomains` wins | Opposite shipped — `d214cb63` moved shell commands to the `networked` profile: **every command has unrestricted outbound, no proxy, no domain policy, no prompt**. Plan written in full, parked by owner directive | Owner decision, not a parity finding — but it must be recorded as C with the owner attribution, not left as an implicit deferral | ~ owner-gated |
| **R15 / R9** | `updatedPermissions` entries carry a `destination` writing to project/user/local settings; six entry types; `behavior` allow\|deny\|ask | Only `destination:'session'` and only `behavior:'allow'`. `replaceRules`/`removeRules` apply nothing. Routed to R25; **R25a/R25b closed without them** | Reuse R1's compile path for deny/ask session rules; settings-file writes need the same store as R1's don't-ask-again row — do both in one unit | ~ medium |
| **R15** | `addDirectories` grants the session access | Reaches `runPreToolUseChecks` but SessionManager's command-hook and skill-context gates still read only the configured list | Read `sessionAdditionalDirectories` at the two SM gates | ~ small |
| **R17b** | An `allowed-tools` Bash rule makes the skill's script run without prompting | Permission mode overrides the grant (safe/Explore/plan/dontAsk still block) | Deliberate ceiling; record as C. The claim "this matches Claude's plan mode" carries no doc line — verify or drop it | ~ record |
| **R17b** | `Tool(specifier)` rules are not Bash-only | A parameterized non-Bash entry (`Read(/x/*)`) is granted **as if the tool were named bare** — silently widening the author's narrowing | Extend `SKILL_GRANT_SUBJECT_FIELDS` past Bash using the `Tool(pattern)` parser that does exist in-tree (decision 2 wrongly claimed it did not) | ~ small |
| **R17b** | `allowed-tools` is a skill frontmatter contract key | `readPluginSkillFrontmatter` drops it for imported plugin skills; every capability/UI view under-reports the declared grant. The in-code rationale ("nothing enforces it yet") is stale since R17b | One-field read; also fix the same stale claim in `skills/types.ts:32`, `capabilities/types.ts:117`, `capabilities/views.ts:85` | ~ small |
| **R17b** | One entry `Bash(cat a.txt, b.txt)` is one rule | Enforcement splits on commas (`stringList`), display does not (`normalizeToolList`) — two implementations that disagree | Single paren-aware split | ~ small |
| **R17b** | `allowed-tools` is a validated frontmatter key | `SkillMetadataSchema` is `.passthrough()` with no entry: `skill_validate` accepts a misspelling or an unclosed `Bash(`, failing silently at runtime | Add the key to the schema | ~ small |
| **R25a** | Every stripped managed entry surfaces in three places (startup dialog, headless stderr, `/doctor`) | Recorded into a struct nothing reads. **Zero of the three consumers exist** | Give `StorageRuntime.managedPiPolicyDrops` a reader: startup log line + the R30 `/doctor` slice. Also fixes R1's residual warning gap | ~ small |
| **R25a** | Managed keys: `requiredMinimum/MaximumVersion`, `availableModels`, `enforceAvailableModels`, `forceLoginOrgUUID` | No analogue of any of the four; those policies cannot be enforced | Add the version gate (fail-open per `:201`) and a model allowlist; `forceLoginOrgUUID` needs an org concept first | ~ medium |
| **R25a** | A malformed value costs that entry and nothing else | An unreadable `schemaVersion` drops the whole document to built-in defaults | Fall back per-entry, or record explicitly as a deliberate C | ~ small |
| **R25a** | A failing user/project/local settings file is rejected **and reported** | `getUserWorkflowSettings` / `getUserWorktreeSettings` / `getUserSandboxSettings` catch → `{}`, silent | Reuse R25a's drop record | ~ small |
| **R25a** | Every remaining valid managed policy is enforced | `headless-start.ts` wraps `cleanupPeriodDays` in try/catch → `undefined`, silently dropping the managed retention value in exactly the cases that no longer abort; the comment justifying it is now false | Delete the catch; fix the stale comment at `headless-start.ts:347` | ~ small |
| **R25b** | Fetch at startup, **poll hourly** during active sessions | No timer. `MANAGED_DELIVERY_POLL_INTERVAL_MS` is only a rate-limit floor. A long session never sees a policy update. **No reason given** | `setInterval` on the already-idempotent `refreshManagedDelivery` | ~ small |
| **R25b** | `forceRemoteSettingsRefresh` blocks startup and exits | Wired only in `apps/electron`; headless server and CLI start with the policy unenforced. **No reason given** | Wire the host-agnostic decision function into the other two hosts | ~ small |
| **R25b** | Server-managed sits in the highest tier no level can override | `buildNetworkEnvVars` treats a managed `NODE_EXTRA_CA_CERTS` in `process.env` as an operator value; a user `tlsCaPath` wins | Tag managed-origin env and give it precedence in R26's resolver | ~ small |
| **R26** | The client cert/key apply to the client's TLS; no process class is excluded | Proxy and CA cross the plugin boundary, the mTLS identity deliberately does not — a plugin fails where the app succeeds. **No reason given at all** | Either project it or record the carve-out as C with a threat model | ~ small |
| **R28** | `paths:` rules trigger when a matching file is read | Rule context is built and tested; the final **two-line** hop into `pi-agent.ts` (`checkArgs` spread `:3370`, `hookAdditionalContext` `:3471`) was left unwired by a file-ownership constraint. **No path-scoped rule reaches the model** | Land the two lines; live case 2 is already written and blocked on exactly this | ~ small |
| **R28** | `InstructionsLoaded` fires per loaded file with `file_path`, `memory_type`, `load_reason`, `globs`, `trigger_file_path`, `parent_file_path`; the matcher runs against `load_reason` | Once per session, `path`/`source` only. The doc-verification calls it "a compliance contract we currently break". R28 blocked on file ownership; R17 Task 0 declined to re-home it | Re-file per-file emission with the documented fields; needs an owning unit — it currently has none | ~ medium |
| **P5** | Unset `${VAR}` with no default → warn and keep the literal token | Plugin branch substitutes `''` and drops `.missing` entirely — **no warning at all**, which is independent of the gate argument. The "docs are about `.mcp.json` only" scoping is contradicted by the same page | Stop passing `'empty'`; track per-key `missing` into `materializePluginMcpEnvironment`'s gate (~10 lines, probe-verified: gate still withholds, 403/405 tests pass, the 2 failures are golden strings, not security assertions). Also `capabilities/resolver.ts:1103-1113` still uses a stale `${VAR}`-only regex, so precompute and runtime can disagree | † small |
| **P5** | Per-server MCP `timeout` (sub-1000 ignored, also an idle floor) | Honoured for non-plugin servers; the Claude adapter never reads it (confirmed on HEAD). The whole pipeline exists and the **Codex** adapter already does this | 4-line addition using the shipped `mcpToolTimeoutMs`; probe: `600000` round-trips, typecheck clean. Two side effects to handle: trust hash changes, and drop `toolTimeoutMs === undefined` from `canPromoteToOAuth` | † small |
| **P5** | Highest-precedence MCP source wins; the whole entry is used, fields not merged | A duplicate across scopes yields **two connected servers** with qualified wire names. (User scope itself is shipped — category A) | Reuse the `preference()` comparator the non-MCP branch already uses in the same function | † small |

### Tier 2 — model-visible contract

| Unit | Docs say | We do | Close it | Effort |
|---|---|---|---|---|
| P5 | Mid-session MCP reconnect, 5 attempts, 1s doubling, HTTP/SSE | Initial-connect retry only; a dead server answers `Unknown MCP proxy tool` until next reconcile. Measured: nothing self-heals; a ~15-line timer using existing `connectWithRetries`/`desiredConfigForConnection` fixes it | Schedule from `handleUnexpectedConnectionClose`; must `failedConnections.delete` (measured: otherwise `health()` reports connected+failed) | † small |
| P4 | `enableFileCheckpointing` creates the SDK checkpoint store | Never passed (0 occurrences on HEAD), so every Claude-session rewind reports 0 files restored while the UI offers it. The stated harm is wrong: the store goes to `~/.claude/file-history/`, not the working dir; we pass no `sessionStore`, the only real SDK conflict | One line at `claude-agent.ts:1191` | † small (already-possible) |
| P6 | `additionalDirectories` is an SDK option so the executing harness learns the roots | Never passed (0 occurrences). The typings spike verified nine options and never checked this one; probe compiles both the top-level and `settings.permissions` forms | One line + one semantic choice (`--add-dir` also loads skills/subagents/plugins; the *setting* grants file access only). Session-granted roots go via `updatedPermissions:addDirectories` | † small (already-possible) |
| P3 | `outputStyles`, `themes`, `monitors`, `bin/` (PATH), bundle `settings.json` are plugin components | All imported as `plugin.deferred.*` and never executed | Each has a shipped mechanism: `output-styles.ts` already takes roots; R3's monitor runtime ships; `ProcessSupervisor` takes `request.env` and Pi's own `bash.d.ts` exposes `spawnHook`; a JSON theme-preset dir already syncs and watches; `settings.agent` maps to `PluginSettingCapability`. Correct the code comment from "cannot execute" to "not wired" | † medium |
| P3 | `defaultEnabled` (default true) sets initial activation | **Silently destroyed** before any consumer: `normalizeNessyPluginManifest` never copies it. Probe: adapter `false` → persisted `undefined` → resolved `enabled:true`. The Task 3 test asserts an activation outcome it never exercises | Copy the field in `schema.ts:400-428`; one `&&` at `management-service-v2.ts:200`; the resolver's "no record = not enabled" already gives the documented precedence free | † small (already-possible) |
| R9 | `UserPromptSubmit`, `UserPromptExpansion`, `PostToolBatch`, `PreCompact` honour top-level `decision:"block"` | Parsed then discarded on Pi (one-way `automation_event` sink — **our** protocol, not an SDK limit). Claude-SDK path honours all four | Add the `automation_event_request`/`_response` pair the close-out already specifies | ~ medium |
| R9 | A blocking `Stop` continues the turn with the reason injected | Reason queued as next-turn context; no re-prompt loop, so a Stop block never continues work | Self-re-prompt loop bounded by the already-implemented 8-block cap | ~ medium |
| R9 | `MessageDisplay`, `TeammateIdle`, `Elicitation`/`ElicitationResult` decisions | Not emitted / context-only; importing plugins get deferral diagnostics | Owned by R30/R23/R24 — but R22 separately recorded `MessageDisplay` as "undocumented in Claude's type table", which the doc-verification contradicts. Reconcile | ~ medium |
| R9 | `PostToolUse updatedToolOutput` ignored unless it matches the tool's output schema | No schema check; string + same-JSON-kind only. MCP results exempted | Defensible reinterpretation — record as C with the reasoning, and add output schemas if the constraint is wanted | ~ record |
| R9 | `http` hooks return `worktreePath` via `hookSpecificOutput` | Our http runner is fire-and-forget, so it is lumped with `mcp_tool`. **Executor widened the plan's scope without flagging it** | Read the http response body, or record the widening | ~ small |
| R9 | — | Receipts name the event, not the hook that blocked | Add a hook identity to `AgentEventExecutionResult` (also closes R15's `__PERMISSION_UPDATE__` gap) | ~ small |
| R22 | 600s default hook timeout (60s agent, 30s prompt, per-event lowering) | Hard 60s ceiling clamps every plugin hook silently | Honour declared timeouts up to the documented ceiling, or make the clamp visible | ~ small |
| R22 | `asyncRewake` wakes an idle session on exit 2 | Treated as plain `async`; never wakes, even after R3 shipped the mechanism | Re-point the async exit-2 path at R3's idle-wake | ~ small |
| R22 | Skill/subagent frontmatter hooks (all events, `Stop`→`SubagentStop`, `once` in skill frontmatter) | No frontmatter hooks; `once` imported and ignored | Same unit as R30a's `hooks:` row — currently **ownerless** (R22 closed without it, R30a excluded it "to R22") | ~ medium |
| R22 | Per-hook `model` (fast model, Haiku default) | Field inert; runner always uses the session mini-model | Mini-completion seam (also unblocks R21's `auto-mode critique`) | ~ medium |
| P8 | Post-edit diagnostics arrive on the edit's own `tool_result` | Appended to the *next* PreToolUse `additionalContext` — one call late, and never if the model stops after the edit. Reason is our own occupancy of the slot; no probe showed it can't carry a composed payload | Probe whether the lifecycle-bridge transform can compose two payloads; if yes, move it | ~ medium |
| P8 | LSP is a harness capability | Both `LspService` constructions sit inside `provider === 'pi'`: a Claude-backend session gets **no diagnostics at all** | Lift construction above the provider branch | ~ medium |
| P8 | Duplicate extension → first-registered-wins | `extensionToLanguage` keys discarded at import; a hard `lsp-language-ambiguous` throw instead | Keep the map; tie-break | ~ small |
| P8 | `restartOnCrash` / `maxRestarts`; per-server `diagnostics` flag | Neither parsed; a crashed server stays `failed` forever | Parse + restart policy | ~ small |
| P8 | Memory/instructions discovered recursively up the tree | Ancestor walk bounded at `projectRoot`; capped at 8 layers (value not derived from measurement); **memory files not walked at all** — probe-confirmed a root `MEMORY.md` produces no record | Extend the walk to memory (answer "which file does `remember` write" first); justify or measure the cap | ~ medium |
| P7 | Skill invocation is the `Skill` tool | A `[skill:slug]` marker in the model's own prose. The cost argument was never measured, and Pi supports tool definitions | Ship the tool; keep the marker path as fallback | ~ medium |
| P7/R30a | `model`, `context`(fork), `agent`, `background`, `hooks`, `shell` frontmatter | None parsed or honoured; a skill declaring forked execution silently runs inline. `context/agent/background` deferred to **R29, which has no plan file** | Give the fork trio an owner; `model` routing is small | ~ medium |
| R30a | An unavailable skill `model` is not used and the session keeps its current model | We **throw** `Invoked skill model unavailable`. Found by the executor, reported not fixed | One-line degrade, matching the `effort` handling shipped alongside it (`base-agent.ts:2075`) | ~ small |
| R30a | `paths` gates automatic loading | Inert on Codex and Nestor-cloud; and the listing advertises every skill each turn regardless | Wire the other two backends; the listing-filter deferral rests on bare issue `#862` with no measurement | ~ medium |
| R30a | `argument-hint` is the autocomplete hint | Parsed, stored, no consumer (0 hits under renderer/UI) | Consume at `EditPopover.tsx:165` | ~ small |
| R30a | Documented frontmatter field set | Our own skill editor tells the model the fields are `name, description, globs, alwaysAllow, requiredSources, icon` — **none documented** — steering authors off-contract | One string | ~ small |
| R17 | Model gets the skill directory path and reads supporting files with `Read` (`${CLAUDE_SKILL_DIR}`) | Opaque `skill-resource:<hex64>` handles + bespoke `read_skill_resource`; a changed file errors both ways; nothing persists across restart; subagent prompts carry handles the subagent cannot resolve | Digest pinning is a real property worth keeping — but the *shape* is invented (see §3). At minimum, make subagent handles resolvable and decide restart behaviour | ~ medium |
| R7 | An answered restored approval "proceeds exactly as if never interrupted" | Re-drives the whole turn as a fresh goal continuation; the answer itself is memory-only, matched loosely by toolName+type+command; `admin_approval` never survives a restart | The impossibility of resuming across process death is assumed, never probed. Probe it before accepting | ~ medium |
| R6 | Store is the fallback when the local transcript is gone; subagent transcripts via `subpath`/`listSubkeys`; a dropped batch is abandoned | Deleted local dir is never resurrected; **no host producer ever writes subagent entries** (adapters implement `listSubkeys` for nothing); a dropped batch may re-deliver; managed layer unwired | Add the subagent producer; advance the uuid cache on drop or document the superset; wire the managed layer (parser is already layer-agnostic) | ~ medium |
| R18 | One knob `MAX_STRUCTURED_OUTPUT_RETRIES` (default 5) | Split by backend, with a test pinning that no `NESSY_` name bridges — so the documented variable controls neither path fully | Accept both spellings on the Pi loop | ~ small |
| R18 | `success` with no `structured_output` is a failure | Not synthesized on the Claude backend; "the SDK owns it" is unverified | Probe the SDK; add the ending if it doesn't | ~ small |
| R10 | `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` | Neither exists; the model's value is applied **unclamped**; we added an undocumented 1000 ms floor. **No reason given** | Add the ceiling | ~ small |
| R10 | Never background: subagent calls, **IDE servers**, headless without opt-in, blocked elicitations | "IDE servers" declared N/A with no probe or type citation that no such MCP class can exist | Verify or record honestly | ~ small |
| R27a | `ReportFindings` renders as a structured list; `SendUserFile` reaches the device with `render`/`attach` | Both land on `structuredContent` that **no renderer reads** (0 hits under the renderer on HEAD). The user-visible half of both tools does not happen, and no unit owns it | Build the two surfaces, or stop advertising the behaviour in the tool descriptions | ~ medium |
| R27a | No rate limit documented for `PushNotification` | 5 per 5 min, then a tool error — a documented-legal call refused | Record as C; the bound is reasoned but arbitrary | ~ record |
| R27a | Desktop notification **and** phone push via Remote Control | Desktop only | Genuinely inapplicable — but record it as C, not as silence | ~ record |
| R5 | MCP resources are fuzzy-searchable in `@` autocomplete alongside files | Server-side only; the picker never lists them, so a user cannot discover or pick one | Render `FuzzyFileSearchResponse.resources` | ~ small |
| P9 | Children get the parent's workspace/environment context incl. a git-status snapshot | None. Reason ("no other seam") stopped being true inside the same plan, which created `BackendConfig.childSystemPrompt` | Use that seam | ~ small |

### Tier 3 — user-visible surface, defaults, and operator identifiers

| Unit | Divergence | Close it | Effort |
|---|---|---|---|
| R12 | Settings-parse failure pauses the sweep but shows **nothing** (no `/status` equivalent, no IPC, no locale keys) | Same reader as R25a's drops | ~ small |
| R12 | Managed `cleanupPeriodDays` parsed fail-closed though managed settings are documented validation-tolerant | Now inconsistent with R25a's tolerant parser — reconcile | ~ small |
| R12 | `backups/` excluded from the age sweep (count-capped instead) | Record as C | ~ record |
| R4 | `workflowSizeGuideline` default `unrestricted`, docs say `medium` since v2.1.219 | Change the default or record the doc-drift decision with an owner | ~ small |
| R4 | No bundled workflow commands, so `disableWorkflows` was reinterpreted | Record; shipping bundled workflows is a separate decision with no stated reason | ~ record |
| R2 | `bgIsolation` default `none` vs documented `worktree` | Documented value is implemented and one setting away; blocked on migration + a Pi-only `EnterWorktree` release valve | ~ small |
| R2 | Boundary path `.nessy-worktrees/` vs `.claude/worktrees/` — any Claude-authored rule/matcher/agent naming the documented path misses ours | Rebrand equivalent; record explicitly | ~ record |
| R2 | The four worktree settings not admitted to managed policy. **No reason given** | Add to `managed-policy.ts` | ~ small |
| R11 | `/context [all]` is a TUI grid with an `all` arg; ours is the existing overlay, no `all` | Deliberate; record | ~ record |
| R26 | `certStore` shipped as a settings key, not `CLAUDE_CODE_CERT_STORE` (we have no env-block mechanism) | Record; add an env-block if operators need it | ~ small |
| R10 | Three control env vars renamed `NESSY_*` with **no alias**, so an operator following Claude's docs sets an inert variable | Accept both spellings — one line each | ~ small |
| R10 | `bash_background`/`BashOutput`/`ProcessStop` and `shell_id:` instead of task-id/`Read`/`TaskStop`/`/tasks` | Our surface by decision; record as C | ~ record |
| R6 | `SessionMirrorStore`/`MirrorSessionKey`/`SessionMirrorEntry` instead of `SessionStore`/`SessionKey`/`SessionStoreEntry`; composite `projectKey` | Name collision is avoidable (namespace it); the key shape is a real divergence | ~ small |
| R6 | We don't throw on store + file checkpointing (SDKs do) | Deliberate superset; record | ~ record |
| R25b | Own gateway route and cache path; opt-in `setManagedDeliveryEnabled`; `needs-authentication` continues instead of exiting; a fourth withheld env category | All defensible; **none categorised**. Record 25b's four as C/A with reasons | ~ record |
| R25b | `policyHelper`, `wslInheritsWindowsSettings`, `managed-mcp.json` delivery out of scope | Record as C | ~ record |
| R27a | Presence check: only the focus half (a user typing in an unfocused window still gets notified); no `CLAUDE_CLIENT_PRESENCE_FILE`; no `CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK` escape hatch. **All three with no reason given** | Three small additions | ~ small |
| R27a | `paths` instead of the doc's "files"; invented `title`/`message` | The doc publishes no input schema; only `paths` contradicts a word it does use | ~ small |
| P8 | Memory/instructions re-read every turn instead of pinned into the cached prefix (a `remember` write zeroes cache reads) | Parked row; needs a measurement, not an argument | ~ medium |
| P7 | Skill listing capped at 4 000 chars / 180 per entry vs Claude's 1 536 per entry; output styles unscanned; skills-dir plugins undetected (B1, **still not started**) | Give B1 a start date or re-home the three rows | ~ medium |
| P9 | Child permission mode clamped stricter than documented | Genuinely ahead — but "ahead" is not one of the three categories. Record as a deliberate C with the rationale | ~ record |

**Better-evidenced but still open** (cited/measured, so outside the strict work-list definition — listed because they are live defects): R26b `apps/cli --tls-ca` / `NESSY_TLS_CA` assigns `process.env.NODE_EXTRA_CA_CERTS` at runtime, which the same close-out's Bun measurement proves is a **no-op** — the CLI's CA option silently does nothing; R30a's skill-`model` throw; R4's size-guideline default; P4's `sandbox` option (the P4 verdict shows it is one line and its blocker, P9, has closed).

---

## 3. Justified by Pi, with the evidence

**Zero of the 159 deviations qualify as category B.**

- **0 of the 24 adversarially challenged** survived as impossible. Eight were *already possible* — the mechanism ships and nobody wired it; in three of those (P5 user scope, R1 PowerShell, R1 Cd) the stated blocking fact was demonstrably false on HEAD.
- **The Pi exception is essentially never invoked.** In the challenged set, none of the reasons named a Pi SDK type, API, or measurement. Every one traced to internal plumbing cost, scope, ownership, or a self-authored security posture. Grep evidence repeatedly confirmed Pi is not on the path at all: `packages/shared/src/plugins/` and `capabilities/` contain no `earendil` import; `permission-dsl.ts` imports only `node:os`/`node:path` and two local files; the Pi SDK has no permission-mode, permission-rule, or MCP-reconnect concept.

**The only demonstrated impossibilities in the whole series are not Pi impossibilities.** Four exist, all in the network-trust units, and all are Chromium/Bun host-runtime limits — a class the rule as written does not admit:

| Divergence | Evidence | Nearest equivalent taken? |
|---|---|---|
| R26b — headless server does not project `NODE_EXTRA_CA_CERTS` | **Measured** against bun 1.3.14: Bun reads the variable before any JavaScript runs, so setting it in-process is a no-op even as the first statement; undici's global dispatcher receives zero dispatches from Bun's fetch; `configureNodeProxy` cannot move to shared because Bun's undici shim has no `Agent.close()` | **Yes** — per-request `tls.ca`/`tls.cert+key`, the mechanism Bun does honour. This is the only textbook-B entry in the series |
| R26b / R26 — Chromium session presents no client certificate | Cited: `app.on('select-client-certificate')` can only choose from the platform identity store; there is no API to hand a session a PEM cert/key pair | **Yes** — platform keychain flow; recorded honestly as "not implementable as specified" |
| R26b — no custom CA on the Chromium update-feed session | Cited: the only hook is `session.setCertificateVerifyProc`, whose failure mode is accepting a bad certificate; Chromium reads the OS trust store natively | **Yes** — declined deliberately, with the failure mode named |
| R19 — `credentials.envVars` `mask` | Cited: substitution requires TLS termination, and the docs themselves specify the failure mode for `mask` without `tlsTerminate` | Half-shipped, then parked by owner decision — so nothing is live |

**Obligation-2 violations — cases where we invented a shape instead of adopting the nearest equivalent.** These matter even where the impossibility is plausible:

1. **R6 mirror store** — invented `SessionMirrorStore`/`MirrorSessionKey`/`SessionMirrorEntry` names (avoidable: namespace the local `SessionStore`), a composite `projectKey`, content-addressed synthetic uuids, and a **Nessy-invented `session_reset` control marker injected into the mirrored entry stream** that no documented adapter or `load` contract knows about. The documented stream is opaque SDK-owned JSON, not a host protocol with control markers.
2. **R17 skill resources** — invented `skill-resource:<hex64>` handles plus a bespoke `read_skill_resource` tool where the docs use a path plus the ordinary `Read`. The digest-pinning property is real and worth keeping, but the shape is ours, and the consequences (mid-session edits unreadable, nothing survives restart, subagents receive unresolvable handles) all follow from the invented shape rather than from the property.
3. **P7 skill invocation** — a `[skill:slug]` marker the model writes in prose, where the docs specify a `Skill` tool. Pi supports tool definitions; the cost argument was never measured.
4. **P10 settings merge** — grant keys turned into a managed *maximum* where the docs specify concat-and-dedupe. Security-sound, but it is our merge algebra, not Claude's.
5. **R11** — an eighth, undocumented signed `unattributedTokens` row in the `/context` breakdown.
6. **R26** — `certStore` as a settings key rather than the documented env-var carrier.
7. **R27a** — an invented 5-per-5-minutes `PushNotification` bound, and a `paths` input where the doc's noun is "files".
8. **R10** — our own background-task surface names and `NESSY_*` env renames with no compatibility alias.

R25b's fourth withheld env category (PATH / NODE_OPTIONS / LD_PRELOAD / DYLD_INSERT_LIBRARIES) is also an invention, but a well-argued one: `resolveDpBinary` walks PATH, so a cached PATH plants a fake `dp` that mints an attacker token — a mechanism Claude Code does not have. That is the right way to invent, and it should be recorded as such rather than left implicit.

---

## 4. Undetermined

**135 of 159 deviations (85%) were never adversarially tested**, across 26 of 32 units. Everything in R2, R4, R5, R6, R7, R9, R10, R11, R12, R15, R17, R17b, R18, R19, R22, R25a, R25b, R26, R26b, R27a, R28, R30a, P7, P8, P9 and P10 rests on the plan authors' own accounts. Given a 100% fall rate on the 15% that were tested, the prior on the untested 85% is poor.

The specific claims that assert a platform-level obstacle and were never probed — each with what would settle it:

| Claim | What would settle it |
|---|---|
| **R7** — an in-flight tool call cannot be resumed across process death, so an approved restart re-drives the whole turn | Kill the Pi subprocess mid-`pre_tool_use`, restart, and attempt to settle the recorded `toolCallId`. Either the waiter can be re-established or it cannot — currently assumed |
| **R9** — the four block-capable events cannot act because `automation_event` is one-way | Already settled in principle: the close-out names the exact wire (`automation_event_request`/`_response`). This is C, not B. What is undetermined is cost, not feasibility |
| **P8** — the `tool_result` seam is single-slot and occupied | Probe whether the lifecycle-bridge PostToolUse transform can carry a composed payload. If yes, the documented delivery point is reachable |
| **R30a / P7** — filtering the skill listing per turn re-stamps Pi's cached prefix (`#862`) | Measure cache-read tokens with a filtered vs static listing on pinned Pi 0.80.3. `#862` is a bare internal issue number; no measurement or SDK type was produced |
| **P5** — token-budget deferred tool loading may be a net loss because mid-session `registerTool` invalidates the cached prefix | The plan itself named this measurement as the precondition and never ran it. Run it; it also blocks precondition P0U, whose target version is separately unverified |
| **P4** — `Query.rewindFiles` needs a live subprocess and an SDK transcript UUID | Neither half was tested live (no Anthropic connection). The P4 verdict already shows blocker B is false — we persist SDK UUIDs in `meta/claude-turn-anchors.json` and the SDK exposes `uuid` on `SDKUserMessage`. Blocker A needs a short-lived resumed query probe |
| **R17** — a subagent's agent instance cannot resolve a parent's resource handles | Probe passing the resource map into the child's runtime. Recorded as a "known limit" without testing |
| **R2** — the `bgIsolation: "worktree"` default cannot migrate safely | Count existing sessions and try the migration. The documented value is implemented; only the default differs |
| **R19** — the whole row | Parked by owner directive, so it is not adjudicable as a parity question until unparked. It must still be recorded as an owner-gated C, not left as an implicit deferral |
| **R18** — the Claude SDK synthesizes the `success`-without-`structured_output` failure for us | One SDK probe |

Also unresolved as **ownership**, not evidence: five documented behaviours currently have *no* owning unit. `MessageDisplay` and per-hook `model` (R22 closed), skill-frontmatter `hooks:` (R22 closed, R30a excluded it "to R22"), `context`/`agent`/`background` (routed to R29, which has no plan file), `InstructionsLoaded` per-file emission (R28 blocked, R17 declined), the sandbox-boundary rule merge (routed to R15, which never mentions sandbox), and B1's five plugin surfaces (`not started`). These will not close by themselves.

---

## 5. The one-line verdict

**Not defensible as recorded** — 0 of 159 deviations were categorised, 81% carry no evidence, and every one of the 24 challenged fell (8 already possible today), so the series' divergence total is a scheduling backlog wearing an impossibility label; **the single highest-value fix is P6's two config-write guards** (`toolTargetPath()` at `pre-tool-use.ts:389`/`:466` plus the Pi `edits[]` fold — measured fail-open on the only backend we ship, letting the agent rewrite its own permission and automation config, and closable in roughly three lines using a helper already 400 lines up the same file), with P3's silent hook-crash fail-open the immediate second.