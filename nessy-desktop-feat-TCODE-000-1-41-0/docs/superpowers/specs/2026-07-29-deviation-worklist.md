# Parity Remediation — Work List (§2 and §3 CLOSED; §4 and the addenda are live)

> **THE TITLE SAID "LIVE" AND WAS WRONG BY 2026-07-30. Corrected here.** All six
> deviation units closed, plus five they spawned. Spot-verified in code rather
> than trusted from the plans: the `Cd(pattern)` row — "parsed and thrown away
> … no `cd` matcher kind in the DSL" — is closed at
> `claude-permission-rules.ts:350` (`case 'Cd':`), commit `14fc9d0c` per
> `plans/2026-07-29-deviation-unit-6.md:72`; the PowerShell row is closed at
> `claude-permission-rules.ts:317` (`kind: 'powershell'`).
>
> **Kept rather than deleted** because the parity tracker at `:433` names this
> file as the list the units ran from, and because two things in it are still
> live:
>
> - **§4's two premise-false corrections** (`alwaysAllow`, the
>   `headless-start.ts` try/catch) — the record that stops them being re-filed.
> - **Both addenda are STILL UNFIXED IN CODE**, re-checked 2026-07-30.
>   `nestor-cloud-agent.ts:288` and `codex-agent.ts:617` still emit the bare
>   `{ hook_event_name: 'Stop' }` — and **Nestor Cloud is a shipped provider**,
>   not a flag-off one, so this is the sharper of the two. It has a second home
>   at `plans/2026-07-29-stop-hook-payload.md:263-268` ("Propagation found, not
>   fixed"). The `AUTO_MEMORY_MARKER_REGEX_SOURCE` TDZ is still at
>   `memory-cleanup.ts:41`, with a second home at
>   `plans/2026-07-29-deviation-unit-3.md:368`.

## 1. What the staleness cost

Of **37 re-verified rows, 6 (16%) could not have been acted on as written**: 2 are **already-fixed** (both R17b rows closed by R30a `46140ce3` — plugin skill `allowed-tools` now travels through `format-adapters/shared.ts:212-213`, and both tokenizers now share `parseSkillToolList`), 2 are **premise-false** (the `alwaysAllow` row and the `headless-start.ts` try/catch row), and 2 are **partially-fixed** (the second `SkillMetadataSchema` survives; the mTLS carve-out's "no reason given" half is now false). Acting on the report as written would have burned two units re-implementing shipped code, and two more on false mechanisms — one would have added a Pi-side `alwaysAllow` whitelist duplicating a working SessionManager remember-window (`permission-remember.test.ts` → 1 pass), the other would have "fixed" a try/catch that is correct in the only class of failure that still reaches it. On top of that, **at least 5 of the 31 still-open rows had wrong scope or anchors**: R1-unparseable is not allow-specific (any Bash rule, including a deny, flips prompt→deny); R15 `addDirectories` misses **four** SessionManager gates, not two; `InstructionsLoaded` carries no `path`/`file_path` field at all, so the gap is worse than stated; `mutateWorkingDirectory` drifted `:12613`→`:12685`; and the P3/R15 overlay helper is at `pi-agent.ts:2610`, not the implied site. Net: **33 rows are live**, and the report's severity/effort estimates hold for all but those five.

## 2. The live work list

### security-or-permission — 26 rows

**Small (18)**

- **P3 — failing hook produces no signal.** Non-zero exit ≠ 2 under Claude semantics returns `undefined`; nothing logged, warned or surfaced, so a crashed security hook permits silently. *Live:* `hook-command.ts:345` bare `return undefined`; both consumers drop it without a `log.*` (`automation-system.ts:664-672`, `hooks-automation.ts:911-941` → zero log calls); `rg 'hook error|hookError'` → 0 hits. — **small**
- **P3 — 0/2/other exit contract applied unconditionally.** Codex, native `nessy-plugin-json` and mcpb hooks no longer block on exit 1 because both constructors opt every imported hook into Claude semantics. *Live:* two unconditional writers, `hooks-automation.ts:1056` and `runtime-automations.ts:198`; `rg 'exitCodeContract'` → 0 hits; no format identity on `PluginHookDescriptor` (`types.ts:163-245`). — **small**
- **R1 — unparseable / >10k-char Bash hard-denied.** Docs make these prompt-anyway carve-outs; any Bash pattern rule in the program turns them into terminal denies. *Live:* `permission-dsl.ts:617,701-707`; `claude-bash-rule.ts:23,111`; probe reproduces (no rules → prompt; one `Bash(git *)` allow **or** one `Bash(rm *)` deny → `action:'deny'`); `git log` on both files since `0a77b5ea` is empty. — **small**
- **R1 — glob+`$()` allow veto over-catches arithmetic.** `hasGlob && hasCommandSubstitution` vetoes any glob-bearing allow rule; `$((1000*30))` executes nothing yet is caught. *Live:* `claude-bash-rule.ts:285` verbatim; `scanCommand:78-88` counts `$((` as a substitution; probe: `Bash(sleep *)` vs `sleep $((60*5))` → no-match, and even the exact rule fails because the `*` sets `hasGlob` at `compileBashPattern:266`. — **small**
- **R1 — `defaultMode` + four managed-only admin locks absent.** `allowManagedPermissionRulesOnly` / `disableBypassPermissionsMode` / `disableAutoMode` / `allowManagedHooksOnly` and `defaultMode` are not keys we read. *Live:* `managed-policy.ts:234-255` — 20-key allowlist, none present; the four names appear only in build artifacts and the vendored SDK `.d.ts`. Partial Nessy-native cover: `disabledPermissionModes` (managed scope only) and the `.nessy-agent/config.toml` precedence chain (`SessionManager.ts:7703-7767`). — **small**
- **R21/P10 — `Bash(param:value)` compiles to a dead command glob.** `Bash(dangerouslyDisableSandbox:true)` becomes a shell-command pattern that only fires on a command literally spelled that way. *Live:* `claude-permission-rules.ts:281-283` runs before the computed `param` at `:277`; probe → `{kind:'bash',pattern:'dangerouslyDisableSandbox:true'}`, evaluates to `{}`; the same string on a non-Bash tool correctly takes the parameter path. — **small**
- **R21/P10 — parameter matcher compares string to boolean.** `Tool(param:true)` stores `equals:'true'` and the evaluator uses strict `===`, so it never fires on the boolean the input carries. *Live:* `claude-permission-rules.ts:112-119` + `permission-dsl.ts:682` (no coercion; only the wildcard branch at `:675-680` does `String(value)`); probe: boolean → `{}`, string → match. — **small**
- **R21 — `autoMode.classifyAllShell` rejected, and the whole block is lost.** Strict parser throws; the shipped tolerant parser strips the entire `autoMode` block, discarding the admin's valid `allow` prose. *Live:* `managed-policy.ts:211,347-353,684-686`; rejection pinned at `managed-policy.test.ts:602-610`; probe → `autoMode = undefined`, one drop `{field:'autoMode', disposition:'stripped'}`. — **small**
- **R17b — non-Bash parameterized `allowed-tools` loses its specifier.** `Read(/x/*)` admits `Read` bare to the turn ceiling and grants no no-prompt run. *Live:* `prerequisite-manager.ts:76` subject fields = `{bash, bash_background}`; `:296-297` → `'unsupported'`, `:268-274` treats that as pass; probe: `Read` with `/etc/passwd` → `allowed:true`. A general parser already exists (`claude-permission-rules.ts:261,291-332`). — **small**
- **R25a — `schemaVersion !== 1` drops the whole document.** Docs: a malformed value costs that entry only. *Live:* `managed-policy.ts:607-621` returns `DEFAULT_MANAGED_PI_POLICY`; probe: `{schemaVersion:2, cleanupPeriodDays:45}` → `undefined`, vs a bad entry under v1 → `45`. Pinned at `managed-policy.test.ts:163-182`. — **small**
- **R25b — no hourly poll timer.** A long session never picks up a policy update. *Live:* zero `setInterval|setTimeout` in `managed-delivery.ts`/`managed-refresh-gate.ts`; `MANAGED_DELIVERY_POLL_INTERVAL_MS` used once, at `managed-delivery.ts:646`, as a rate-limit floor; only producer is the sign-in hook `:730-735`. — **small**
- **R25b — `forceRemoteSettingsRefresh` is Electron-only.** Headless `nessy-server` and the CLI start unenforced. *Live:* single import at `apps/electron/src/main/index.ts:61`; `rg` over `apps/cli packages/server packages/server-core` → nothing. Worse than stated: delivery is off by default (`managed-delivery.ts:522`) and the only opt-in is `index.ts:1091`, so those hosts have no cache to satisfy the gate with. — **small**
- **R25b — managed `NODE_EXTRA_CA_CERTS` loses to user `tlsCaPath`.** The top tier is overridable. *Live:* `proxy-env.ts:69-79`; `tls-ca-path.ts:53-56` tags user config `source:'custom'`; measured `buildNetworkEnvVars(...)` → `/tmp/user-ca.pem` over `/managed/org-ca.pem`. No managed-origin tag exists to consult (`rg 'managedOrigin'` → 0). — **small**
- **P5 — unset `${VAR}` expands to `''` silently (plugin branch).** *Live:* `runtime-pool-servers.ts:745-749` discards the `.missing` half; the non-plugin reader `project-config.ts:52,57,111-113` does warn; the two plugin debug lines (`:249`, `:265`) cover *declared* requirements only. Untouched since baseline. — **small**
- **P5 — `resolver.ts` stale `${VAR}`-only regex.** Availability precompute decides over a different string than reaches the subprocess. *Live:* `resolver.ts:1104-1114` vs the default-aware `CONFIG_VARIABLE` at `server-config-values.ts:27`; probe: `${TOKEN:-}` → precompute AVAILABLE, runtime withholds. — **small**
- **P5 — per-server MCP `timeout` dropped by the Claude adapter.** A plugin-imported server loses its configured tool timeout. *Live:* measured — a real bundle with `"timeout":600000` emits a capability with no `toolTimeoutMs` and `deferred: []` (silent drop); `claude.ts:615-638` copies 7 fields, not this one; Codex adapter fills it (`codex.ts:1024`). Side effect: `canPromoteToOAuth` still keys off `toolTimeoutMs === undefined` (`management-service-v2.ts:737-745`). — **small**
- **P5 — duplicate MCP source across scopes connects twice.** Docs: highest precedence wins. *Live:* `resolver.ts:1597-1614` qualifies **every** entry instead of picking a winner; pinned by `resolver.test.ts:245-249` (`toHaveLength(2)`); both then connect via `runtime-pool-servers.ts:190-215`. — **small**
- **R26 — mTLS identity does not cross the plugin boundary** *(partially-fixed).* Remaining gap is the behaviour, not the rationale: the carve-out is deliberate and documented. *Live:* `proxy-env.ts:82-88,110-112`; consumers `mcp/client.ts:493`, `plugin-runtime-dependencies.ts:317`. The row's "no reason given" half is **false** — rationale at `proxy-env.ts:38-45,103-109`, plan `2026-07-28-network-trust-chain.md:271,346`. Live work is to record it as an accepted deviation, not to change code. — **small**

**Medium (8)**

- **R1 — `Cd(pattern)` rules parsed and thrown away.** No Cd rule of any action has effect. *Live:* `claude-permission-rules.ts:323-330` returns `inert(...)` with no `rule` field (`:73-75`); no `cd` matcher kind in the DSL. The blocking reason is false: `mutateWorkingDirectory` exists at `SessionManager.ts:12685` with four call sites. — **medium**
- **R1 — `PowerShell(...)` rules parsed and thrown away.** *Live:* `claude-permission-rules.ts:284-290`. **Both** stated reasons are false: the AST matcher ships with a live consumer (`powershell-validator.ts:382` ← `mode-manager.ts:1443`), and the Pi harness spawns `cmd.exe` on win32 (`pi-agent-server/src/index.ts:3550-3552`), not Git Bash. — **medium**
- **R1 — project `.claude/settings.json` is never parsed.** deny/ask that docs say apply even untrusted never load. *Live:* `project-contribution-detect.ts:182-188` is `existsSync` only; `permissions-config.ts:824-886` has no project-settings layer; `parseClaudeRuleString` has exactly 2 production callers, neither a settings reader. — **medium**
- **R15/R9 — `updatedPermissions` destinations/types/behaviors.** Only `destination:'session'` + `behavior:'allow'` apply; `replaceRules`/`removeRules` hit the default and apply nothing. *Live:* `pi-agent.ts:2759-2766,2769-2775,2860-2865`; pinned green at `pi-agent-pretool-hook-decision.test.ts:812-835` (38 pass). — **medium**
- **R1 — permission rules never merge into the sandbox boundary.** *Live:* `rg "autoAllowBashIfSandboxed|denyWrite|allowWrite|denyRead|deniedWriteRoots"` → **zero** `.ts` hits repo-wide; the only sandbox-root producers are config-derived (`SessionManager.ts:2427-2436,3146`). — **medium**
- **R1 — `additionalWritableRoots` never reaches ProcessSupervisor.** A validated, floor-capped key grants nothing. *Live:* `rg "sandboxSettings\.additionalWritableRoots"` → 0; construction at `SessionManager.ts:3144-3156` passes 3 other fields; the supervisor's constructor options (`process-supervisor.ts:35-59`) have no such field — it exists per-request only (`:93-101,148`). — **medium**
- **R25a — no analogue of `requiredMinimumVersion`/`requiredMaximumVersion`/`availableModels`+`enforceAvailableModels`/`forceLoginOrgUUID`.** Those admin policies cannot be enforced at all. *Live:* `managed-policy.ts:234-254` (22 keys); each is refused as unknown, pinned at `managed-policy.test.ts:137-145`; absence is stated as deliberate at `managed-policy.ts:616-620`. — **medium**
- **R28 — `InstructionsLoaded` fires once per session, content-free.** *Live:* single emit at `lifecycle-bridge.ts:93` with `{source, lifecycle_version}`; `rg 'memory_type|load_reason|trigger_file_path|parent_file_path'` → **0 hits**; contract row still `terminalDelivery:'once-per-session'` (`automations/types.ts:38`); pinned at `lifecycle-bridge.test.ts:40`. Worse than the row states — there is no `path`/`file_path` field either. — **medium**

### model-visible — 2 rows

- **R17b — second `SkillMetadataSchema` accepts anything** *(partially-fixed).* `session-tools-core` was fixed; the write-time PreToolUse check was not. *Live:* `config/validators.ts:774-779` is still `z.object({name, description, globs, alwaysAllow})` with no passthrough, reached via `:900,942` → `:2191` → `pre-tool-use.ts:500`; probe: a misspelt `allowed-tool` + unclosed `Bash(` → `valid=true, 0 errors, 0 warnings`, while `session-tools-core` correctly errors. R30a's commit message records it as found-but-unchanged. — **small**
- **R21/P10 — model-facing Bash `dangerouslyDisableSandbox` has no producer.** *Live:* 4 source files total; the port type's own comment (`process-supervisor-port.ts:82`) reads "DELIBERATELY HAS NO PRODUCER YET"; `:100-108` strips it from the child-visible request and `handleProcessStartRequest` (`pi-agent.ts:4562-4620`) sets neither field; `rg` over `packages/pi-agent-server/src` → 0, so the tool schema carries no such parameter. — **medium**

### user-visible — 5 rows

- **P3/R15 — PreToolUse `allow` does not skip the prompt.** *Live:* ordering `pi-agent.ts:3407 → 3415-3421 → 3468-3473`; in `applyPreToolUseHookDecision` (`:2610-2686`) the `prompt` return at `:2669` precedes the `decision === 'allow'` branch at `:2681`, making it unreachable; `hookDecisionValue` is never consulted for allow downstream (`:3466`, `:3529` deny-only); pinned at `pi-agent-lifecycle-hooks.test.ts:349-353`. The close site is live — the R15 band at `:3785,3805-3806` already honours a *PermissionRequest* allow. — **small**
- **R15 — `addDirectories` grant is agent-only.** Four SessionManager gates still read the configured list alone (row said two): `:3694`, `:3967`, `:4143`, `:14724`. `sessionAdditionalDirectories` is a private field (`pi-agent.ts:778`) with no accessor. — **small**
- **R25a — `managedPiPolicyDrops` has no reader.** No startup dialog, no headless stderr, no `doctor`. *Live:* exactly 3 hits, all in `storage-runtime.ts` (`:125,:185,:429`); the code says so at `:120-123`; no `/doctor` command exists; `managed-approval-dialog.ts` never mentions drops; `packages/server/src/index.ts:237` passes only the policy. — **small**
- **R25a — user-tier settings getters swallow parse failure.** *Live:* `config/storage.ts:1102-1113` and `:1123-1132` are `catch { return {} }` with no log. Correction to the row: `getUserSandboxSettings` (`:1087-1092`) has **no** try/catch and no validation at all. Contrast `getUserSessionMirrorSettings` (`:1139-1152`), which `console.error`s. — **small**
- **R1 — "Yes, don't ask again" persists nothing.** *Live:* no writer of `.claude/settings.local.json` anywhere (only the presence constant at `project-contribution-detect.ts:54`); the sole consent store is workflow-launch-scoped (`workflow-launch-consent.ts`, gated at `SessionManager.ts:15551-15556`); the real effect is an in-memory 10-min (max 60) hash-keyed window, while the card's tip in `PermissionRequest.tsx` (`'"Always Allow" remembers this command for the session'`, replaced since by `permissionRememberScope`'s sentence) promises "for the session". — **medium**

### cosmetic — 0 live rows

## 3. Suggested units

**Unit 1 — Hook signal, exit-code contract, event payload fidelity** (rows: P3 no-signal, P3 unconditional exit contract, P3/R15 PreToolUse allow, R28 InstructionsLoaded). Scope: make hook failures observable, make the 0/2/other contract per-format via an `exitCodeContract` discriminator carried on the descriptor, honour a PreToolUse `allow` at the existing R15 band, and split `InstructionsLoaded` into a per-file event with the documented fields. — 3 small + 1 medium.

**Unit 2 — Rule and grant specifier parsing** (rows: R1 unparseable/10k, R1 glob+`$()` veto, R21 `Bash(param:…)`, R21 parameter type coercion, R17b non-Bash `allowed-tools`, R17b second `SkillMetadataSchema`). Scope: fix how a specifier string is compiled and matched — a `prompt-anyway` sentinel instead of `unsafe-shell`, arithmetic excluded from the substitution veto, `Bash(param:value)` routed to the parameter matcher, coerced comparison, general subject fields for skill grants, and the write-time skill schema. All six live in 5 files, no new persistence surface. — 6 small.

**Unit 3 — MCP config fidelity (P5)** (rows: unset `${VAR}` plugin branch, `resolver.ts` stale regex, Claude adapter `timeout`, duplicate-source double-connect). Scope: one expander shared by precompute and runtime, `missing` surfaced as a warning, `toolTimeoutMs` carried from `.mcp.json`, and a precedence winner for cross-scope MCP duplicates. — 4 small; `resolver.ts` is touched twice, so keep them together.

**Unit 4 — Managed policy diagnostics and delivery lifecycle** (rows: drops have no reader, per-entry vs whole-document `schemaVersion`, user-tier getters swallow failures, `classifyAllShell` block-strip, four admin locks + `defaultMode`, four missing managed keys, hourly poll, `forceRemoteSettingsRefresh` host coverage, managed CA precedence). Scope: everything under managed/remote settings — parse-time granularity, drop reporting, host coverage, refresh scheduling, and managed-origin precedence. Largest unit (7 small + 2 medium); splittable at the diagnostics/delivery seam if needed.

**Unit 5 — Sandbox boundary wiring** (rows: rules→sandbox merge, `additionalWritableRoots`→supervisor, `addDirectories` cross-tier, `dangerouslyDisableSandbox` producer, mTLS deviation record). Scope: make the sandbox boundary read every input that already exists — compiled rules, resolved settings, session grants — plus a producer for the escape hatch. Four of the five are pure wiring against values already computed; the mTLS row is a ledger entry, not code. — 1 small + 4 medium.

**Unit 6 — Rule sources and destinations** (rows: `Cd`, `PowerShell`, project `.claude/settings.json`, don't-ask-again persistence, `updatedPermissions` destinations). Scope: the five rows that each need a new surface — a `/cd` and a PowerShell matcher kind in the DSL, a project-settings layer in `permissions-config.ts`, a settings-writer for remembered answers, and a session DSL layer for non-allow behaviours. Largest design risk; the settings reader/writer is shared by three of the five. — 5 medium.

**Go first: Unit 1.** It holds the only rows where a failure is *silently permissive* — a crashed hook returns `undefined`, both consumers merge nothing, nothing is logged, and the call proceeds — and the fix is bounded to `hook-command.ts` plus two action constructors. It also requires rewriting three currently-green pinning tests (`hook-command.test.ts:198-205`, `pi-agent-lifecycle-hooks.test.ts:349-353`, `lifecycle-bridge.test.ts:40`), so doing it early stops the corpus adding more tests that pin the wrong contract. Unit 2 is the natural second — same size, same "no new surface" property, and it unblocks Unit 5 and Unit 6, both of which consume compiled rules.

## 4. Rows that were wrong

- **R1 — "on Pi `alwaysAllow` is discarded while the renderer still shows the button" — premise-false.** `alwaysAllow` *is* honoured, one tier up in SessionManager, for every prompt carrying a command hash: `SessionManager.ts:15542-15546` computes `rememberForMinutes`, `:15558` calls `storeAdminRememberApproval` (`:5316-5335`), `:5407-5420` consumes it for every non-`admin_approval`, non-`ask_user` prompt, and ordinary `bash`/`file_write` prompts do carry the hash (`pre-tool-use.ts:1534-1560`, threaded at `pi-agent.ts:3043,4133`). Measured: `permission-remember.test.ts` → 1 pass, identical next command auto-approved with no second `permission_request`. The row's two cited facts (`pi-agent.ts:6058 void alwaysAllow`, the resolver signature at `:2084-2087`) are true but only mean nothing reaches the *agent's* whitelist. **The real, much smaller divergence is the label**: an in-memory, hash-keyed, 10-minute (cap 60) window described in the UI as "remembers this command for the session" (the card's tip in `PermissionRequest.tsx`, replaced since by `permissionRememberScope`'s sentence).
- **R25a — "headless-start.ts's try/catch silently drops the managed retention value in exactly the cases that no longer abort" — premise-false, both halves.** The catch no longer fires in the tolerant cases at all (probe: an entry typo alongside `cleanupPeriodDays: 45` returns 45, no throw). The only class that still throws is a file-level defect — broken JSON → `managed-pi-policy-invalid` from `managed-policy-loader.ts:229-263` — and that class is documented as still fail-closed (`:319-325`), where the justifying comment at `headless-start.ts:338-344` **holds**: `createStorageRuntime` re-loads and throws un-caught in both hosts (`apps/electron/src/main/index.ts:561`, `packages/server/src/index.ts:228`), so startup fails. The one case where a valid retention value is lost without an abort is `schemaVersion !== 1`, which is the separate whole-document row and does not involve this catch.

Two further corrections worth recording in the plan corpus, on rows that remain live: **R1-unparseable is not allow-specific** — a `Bash(rm *)` deny rule flips an unrelated unparseable command from prompt to terminal deny just as an allow rule does, so the blast radius is any Bash rule at all; and **R26's "no reason given at all" is false** — the mTLS carve-out's rationale and threat statement landed in `proxy-env.ts:38-45,103-109` in `c3c484e7`, which is *not* an ancestor of the report's baseline `0a77b5ea`.
---

## Addenda from units closed after this list was written

**R27c's "`additionalContext` can loop unbounded" — narrowed by the planner.**
The executor reported that `additionalContext` escapes both loop protections
because `recordHookBlockFeedback` counts only `block`/`deny`
(`base-agent.ts:524`, and `:526` *deletes* the streak for anything else), so such
a hook reports `stop_hook_active: false` forever and never reaches the 8-block
cap. Both halves of that are true and I confirmed them.

The "unbounded loop" conclusion does not follow **for us**: there is no path where
a Stop hook's `additionalContext` drives a continuation at all — `rg` finds no
such producer in `pi-agent.ts` or `base-agent.ts`. So the live defect is narrower
and differently shaped: a documented continuation mechanism we do not implement,
plus two fields that would report wrongly once we do. Fix the continuation and
the counting together, in that order; fixing the counting alone changes nothing
observable.

**Two Stop-payload rows carried out of R27c, both small now that the payload
builds from one shared helper:** `codex-agent.ts:578` and
`nestor-cloud-agent.ts:284` still emit the bare `{ hook_event_name: 'Stop' }`,
i.e. the identical four-field gap R27c just closed on the Pi path. And
`StopFailure` matchers can never match — the docs make `error` the matcher field
while we emit `error_code`, and `getMatchValueForSdkInput` has no `StopFailure`
case at all, falling through to `default: return ''`.

**A latent circular-import defect, found by Unit 3 and re-checked by the
planner.** `packages/shared/src/agent/memory/memory-cleanup.ts:41` evaluates
`const MARKER_RE_SOURCE = AUTO_MEMORY_MARKER_REGEX_SOURCE` at module scope, where
that binding is imported from `memory-store.ts`. Under some module load orders it
throws an unhandled `ReferenceError: Cannot access … before initialization` — a
temporal-dead-zone hit from the import cycle.

It is **load-order dependent, not a stable failure**: Unit 3 reproduced it
identically at its own baseline, and a full `bun test packages/shared/src`
(5103 pass / 10 fail, 415 files) does not surface it at all. So it will not show
up in a targeted suite and may or may not show up in CI depending on collection
order — which is the worst shape a defect can have.

Not a parity row and not owned by any unit. Worth its own small fix: move the
constant, or compute the regex lazily inside the function that needs it.
