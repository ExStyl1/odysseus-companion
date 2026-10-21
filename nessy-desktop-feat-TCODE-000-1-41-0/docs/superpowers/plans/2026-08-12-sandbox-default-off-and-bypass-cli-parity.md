# Sandbox fully off by default (every seatbelt contour) + bypassPermissions CLI parity

**Owner decision 2026-08-12** (chat): «мы можем полностью выключить песочницу,
хотя бы до стабилизации работы с агентами? а позже включим», затем «проверь план
так что б seatbelt и сендбокс вообще были выключены». Process isolation ships
**disabled by default** across EVERY wrap contour this codebase has (the
inventory in T1 is the point of this revision), the code stays, and one resolved
boolean turns it back on (user config or managed floor). The trigger was a
measured production failure: Playwright's `chrome-headless-shell` SIGSEGVs at
launch under the pi-harness seatbelt (§0), which reads as "agents are unstable"
to every affected user. The same plan closes the bypassPermissions gaps found by
the 2026-08-12 re-audit of `permission-modes.md` against HEAD.

This file supersedes and absorbs the uncommitted draft
`2026-08-12-sandbox-kill-switch-and-bypass-parity.md` (same charter, cut off
mid-T5; its §0 facts, hazard set and file map are folded in here).

**Target: 1.26.0.** Fully autonomous: every judgement call carries a decision
rule; do not stop to ask. Branch per repo rule (`<type>/TCODE-000`), one commit
per task, no MRs/tags, no `Co-Authored-By`. Re-locate every quoted site by
NAME, never by line number.

## Tracker

Update the row IN THE SAME COMMIT that lands the task. Status: ⬜ open ·
🔄 in flight · ✅ done · ⏸ parked.

| # | task | status | commit | note |
|---|---|---|---|---|
| T1 | Sandbox off by default — the full contour inventory | ✅ | | key/a/b/c/d/e/f landed: `sandbox.enabled` (default false) + `resolveSandboxEnabled` one composition helper; ProcessSupervisor `sandboxEnabled` first-check + `sandboxDisabled` reason + `unsandboxed:disabled-by-config` marker; `getMacosSeatbeltBashSandboxEnabled` outranked by the master switch; `script_sandbox` pinned unconditional (no change); Claude SDK pinned no `sandbox` key (no change); codex `codexSandboxConfigForMode` gains `sandboxGloballyEnabled` → `danger-full-access` when off, `approval_policy` untouched; doctor report gains a `Sandbox:` line. pi-agent-server bundle rebuilt (`bun run build`) + typechecked clean. Gate: 4 focused suites + typecheck:all + full server-core (1485/1485) + full shared config (807/807), all green |
| T2 | Darwin profile lets Chromium start (probe-proven) | ✅ | `b5d9f934d` | parked 2026-08-12 («вообще выключить»), and **owner decision 2026-08-13: isolation is not being brought back** («изоляцию мы не возвращаем»), so this is no longer a roadmap item. It is NOT deleted, because the switch it serves still exists: a managed policy or a user can set `sandbox.enabled: true`, and on that path the §0 crash returns — the diagnosis, the probe ladder and the measured fix all live in §0 and in this row so whoever flips it does not re-derive them. Unpark only if someone decides to enable isolation again. (controller, backlog wave 1 wf_64beb74b-e8b, 2026-10-09; refute-by-default verifier per row, repairs where listed) (BK-2, 2026-10-09) Closed by its residue sentence (f0891e3f7). The config-file sandbox row (en+ru) now says that on macOS with sandbox.enabled true, a headless Chromium started inside the sandbox crashes at launch (the IOKit segfault §0 measured). It names the two ways out: excludedCommands, or leaving the master switch off. Isolation stays off (owner 2026-08-13); the probe-proven fix stays recorded in §0 and is not built. 🟨 — the residue sentence is right for Pi only but the page applies it to every runtime, and the excludedCommands way out works only on Pi; reword in wave 2. (BK-22,, 2026-10-09; verified 2026-10-10 sound) the config-file sandbox row scopes the macOS headless-Chromium crash to Pi, where it was measured, and names excludedCommands as Pi's way out (en+ru) |
| T3 | CLI stops defaulting to bypassPermissions | ✅ | | Ladder rung 1 chosen (measured): `permission_request` already rides `session:event`, the same channel `sendAndStream` subscribes to, and `sessions:respondToPermission` is the same RPC an interactive client (Electron/iOS) already calls to answer one — no new wire. `cmdRun`'s `sessions:create` default `'bypassPermissions'`→`'default'`; `sendAndStream` gains an auto-deny responder (deny + one stderr line + exit 1; confirmed it does NOT wait for `--send-timeout` — resolves in ~ms via the real event, not the timeout fallback). `--dangerously-skip-permissions` added as a value-less alias. Per-site verdicts on the other 4 `bypassPermissions` literals: `cmdSessionCreate` (`session create` subcommand) never forced a default — unchanged; the 4 `getValidateSteps()` sites (`sessions:create`, `sessions:branch`, 2×`automation:create`) kept bypass with a one-line comment each — unattended `--validate-server` self-test, not user sessions. Sweep: `scripts/test-workflow-local.sh` relied on the implicit default — given `--dangerously-skip-permissions` explicitly. `allow-dangerously-skip-flag-inapplicable` category string added below. TDD: 5 tests RED against unmodified code (exact failure text confirmed: unknown-flag error, stale `bypassPermissions` value, generic timeout stderr instead of the deny line) → implement → GREEN. Gate: `apps/cli` typecheck clean; 144/144 focused `apps/cli` tests green. No real LLM-driven live smoke (needs credentials/network this session doesn't have); the wire-level proof is a real WebSocket server + real `CliRpcClient` + real `sendAndStream` (same harness `run.test.ts` already uses for `typed_error`/`text_complete` etc.) pushing a synthetic `permission_request` frame — full live smoke deferred to T6 per the verification-budget policy (live smokes at close-out) |
| T4 | bypassPermissions refuses root/sudo | ✅ | | New `packages/shared/src/agent/pi-harness/bypass-root-guard.ts`: `assertBypassPermittedForProcess({euid?, platform?, containerMarker?})` throws `BypassPermissionsRootRefusedError` (code `bypass-permissions-root-refused`, Claude-mirrored text) when `platform !== 'win32'`, euid is 0 (default `process.geteuid?.()`), and neither `/.dockerenv` nor `/run/.containerenv` is present (`containerMarker` defaults to a real `existsSync`). Two doors wired in `SessionManager.ts`: `createSession`, right after `defaultPermissionMode` resolves (the session-create acceptance point, before persistence); and `setSessionPermissionMode`, right after its clamp/normalize — the single funnel the RPC `'setPermissionMode'` handler (`handlers/rpc/sessions.ts`), `acceptPlan`'s force-set, and the plan-mode-service's `setMode` callback all call (confirmed by auditing every call site; none is a passive restore, so the guard fires unconditionally whenever the resolved mode is `bypassPermissions`, not only on a state transition). Subagent/child creation runs through `createSession` (door 1) automatically: `clampPermissionModeToParent` never lets a child request `bypassPermissions` unless its parent already holds it, so no third site is needed there. A separate, narrower path — `managed.agent.onPermissionModeChange` (agent-initiated mode sync, not the RPC handler) — sets `permissionMode` directly without funneling through door 2; left unguarded as explicitly out of the brief's 2-door scope and flagged in the T4 report rather than widening scope. TDD: 6 unit tests RED (module did not exist) → GREEN; 1 integration test at the create door (`sessions/__tests__/bypass-root-refusal.test.ts`, spies `process.geteuid` since `createSession` calls the guard with no explicit args in production). Gate: shared + server-core typecheck clean; 58/58 pre-existing focused SessionManager permission/creation tests still green, plus the 7 new tests (6 unit + 1 integration). **Shared-checkout collision (hazard 11):** the `SessionManager.ts` edit is correct and present at HEAD, but a concurrent unrelated commit (`b97c774c0`, "fix(pi): a subagent granted Agent can still start, and a dead child says so") swept it up mid-task before this task's own commit — see the T4 report for the full account; this task's commit could therefore only carry the guard module, its tests, and this tracker row. |
| T5 | Bypass ack durable in user config | ✅ | | Single durable source `bypassPermissionsAcknowledged?: boolean` in config.json: `getBypassPermissionsAcknowledged`/`setBypassPermissionsAcknowledged` added next to `getMemoryEnabled`/`setMemoryEnabled` in storage.ts (defaults false; no config-defaults.json fallback — a one-time ack has no factory default, so it mirrors `getExtendedPromptCache`'s simpler shape instead). `validators.ts` declares the key in both `StoredConfigKnownFields` (the `.strict()` production load envelope — undeclared would throw `UnsupportedStorageLayoutError` on the very next load, per storage.ts's own history of this failure mode) and `StoredConfigSchema` (`z.boolean().optional()`, for `validateConfig()`). IPC: new `permissions.GET_BYPASS_PERMISSIONS_ACKNOWLEDGED`/`SET_BYPASS_PERMISSIONS_ACKNOWLEDGED` channels (`protocol/channels.ts`), classified `LOCAL_ONLY` in `routing.ts` (a per-install config.json flag, not workspace state — mirrors `retention.*`'s reasoning, unlike the neighboring `GET_MCP_CHANNEL_PUSH`'s `REMOTE_ELIGIBLE`), handled in `server-core/handlers/rpc/settings.ts` next to the MCP-channel-push block, exposed via `channel-map.ts` + the `ElectronAPI` interface (`apps/electron/src/shared/types.ts`). Hand-edited the auto-generated `ipc-channels.test.ts` pinned list in sorted order — the header comment names `scripts/ipc-inventory.ts` as the generator but that script no longer exists anywhere in the repo, so no regenerate command was available; noted for whoever next touches this file. Gate call shape: went ASYNC (brief's decision rule applied and confirmed, not assumed) — the renderer receives no bundled "config snapshot" at startup; every sibling boolean (notificationsEnabled, autoCapitalisation, spellCheck, ...) is its own separate async IPC round trip inside a `useEffect`, so there was no existing snapshot field to hydrate a sync read from. `bypass-permissions-gate.ts`'s two functions are now `async`; its two call sites in App.tsx (`handleSessionOptionsChange`, `BypassPermissionsDialog`'s `onConfirm`) now `await` — both are callbacks (`() => void`-typed props, which TS allows an async function to satisfy) so no signature elsewhere needed to change. Migration (one-way, non-destructive) lives entirely in the gate: config `true` → no ask; else legacy localStorage `nessy:bypass-permissions-acknowledged === '1'` → migrate (write the config key, KEEP the localStorage entry) → no ask; else → ask; any IPC/storage failure fails toward asking again, never toward silently skipping. Model-write exclusion verified two ways, per the brief's ask: (1) the key lives in config.json via storage.ts, a wholly separate file+loader from preferences.json/preferences.ts, which is the only thing `update_user_preferences` can touch; (2) that tool's own args schema (`UpdatePreferencesArgs` in `session-tools-core/handlers/update-preferences.ts`) is a closed allowlist (name/timezone/city/region/country/notes/includeCoAuthoredBy) that never mentions this field, and a repo-wide grep confirms `session-tools-core` does not import `storage.ts` at all — no session tool has a path to config.json's setter. TDD: storage suite RED (8/8 failing, functions undefined) → GREEN; gate suite RED (4/6 failing against the new async/migration contract) → GREEN. Verification: `typecheck:shared` + `typecheck:all` (core/shared/server-core/server/session-tools-core/pi-agent-server/electron/ui/build-scripts) clean; focused suites green (storage 8/8, gate 6/6, protocol routing 11/11 incl. exhaustiveness, ipc-channels pinned-list, electron registration + registration-profiles exhaustiveness); affected-package sweep `packages/shared/src/config/__tests__/` 781/781 green (risk-trigger per the wire/schema-change policy). |
| T6 | Close-out: live smoke, audit note, registers, 1.26.0 | ✅ | |  (controller, backlog close-out 2026-10-09) CLOSED by decision (owner rule 2026-10-08, simplest; sandbox stays off by standing decision): S1 plus the 1.25.1 ship replace item 1; no S2 reading is owed while sandbox.enabled defaults off. |

**Ordering:** T1 → T4 in sequence (both edit
`packages/server-core/src/sessions/SessionManager.ts`; the repo's
`git commit <pathspec>` trap makes parallel edits to one file cross). T3 and T5
are file-disjoint and may run in parallel zones. T6 last.

## 0. Measured facts this plan stands on (2026-08-12, Darwin 25.5.0)

**The crash.** `chrome-headless-shell` (Playwright build 1161, Chromium
134.0.6998.35) run bare: prints DOM, exit 0. Same binary under the pi-harness
seatbelt skeleton (`(deny default)` + our allows): **exit 139**, crash report
`EXC_BAD_ACCESS / KERN_INVALID_ADDRESS at 0x0000000000000010`, top frame
`IONotificationPortGetRunLoopSource @ IOKit` — the address matches the
production screenshot (`SEGV_ACCERR 000000000010`) byte for byte. Ladder:

| profile | result |
|---|---|
| skeleton (bare `(allow mach-lookup)`, `(allow network*)`) | SIGSEGV @0x10 (NULL IONotificationPort) |
| + `(allow iokit*)` | SIGTRAP: `FATAL:mach_port_rendezvous.cc(410) bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>: Permission denied (1100)` |
| + `(allow iokit*) (allow mach-register)` | **exit 0, DOM printed** |

Repro recipe (T2 re-runs it against the REAL generated profile when unparked):

```bash
BIN=~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-mac/headless_shell
TMPDIR="$SCRATCH" /usr/bin/sandbox-exec -p "$PROFILE" "$BIN" \
  --headless --no-sandbox --disable-gpu \
  --user-data-dir="$SCRATCH/prof" --dump-dom about:blank
# crash reports: ~/Library/Logs/DiagnosticReports/headless_shell-*.ips
```

Caveat from the same session: `sandbox-exec` rejects `dynamic-code-signing` as
an unbound variable — the valid operation name in system profiles is
`dynamic-code-generation`, and neither turned out to be the fix. Do not repeat
that detour.

**The wrap-contour inventory** (what "sandbox" means in this codebase — each
verified on HEAD 2026-08-12; T1 addresses every row):

| # | contour | wrap site | state today |
|---|---|---|---|
| a | ProcessSupervisor: Pi subprocess, Bash/local-tools commands, MCP servers, hooks, plugin processes | `resolveProcessIsolation` via `ProcessSupervisor` (`packages/server-core/src/pi-harness/`) | always wraps (seatbelt/bwrap/firejail/Windows profile) |
| b | Approved-Bash seatbelt inside the agents | `getMacosSeatbeltBashSandboxEnabled` (`packages/shared/src/config/storage.ts`), consumed by `pi-agent.ts` and `claude-agent.ts` `bashSeatbeltSandboxContext` | **already default-false** — `apps/electron/resources/config-defaults.json` carries `"macosSeatbeltBashSandboxEnabled": false`; a user config key can flip it on |
| c | `script_sandbox` session tool | `packages/session-tools-core/src/handlers/script-sandbox.ts` (own `applyFilesystemIsolation` + `applyNetworkIsolation`, NOT via the supervisor) | always wraps; refuses to run when no backend exists — isolation is the tool's `safeMode: 'allow'` rationale |
| d | Claude SDK runtime's own sandbox | SDK settings; we never pass a `sandbox` key | off — Claude's own default (`settings.md`: `enabled` … "Default: false") |
| e | Codex runtime's own sandbox | `codexSandboxConfigForMode` / config writer (`packages/codex-responses-adapter/src/config-writer.ts`), spawned per session | ON — default `sandbox_mode: workspace-write` (codex's own seatbelt on macOS); blueprint §12 deliberately refused `danger-full-access` |
| f | Reporting surfaces | `isolation-capabilities.ts`, doctor report, execution receipts — all read `resolveHostSandboxSettings` (`packages/server-core/src/bootstrap/host-sandbox-settings.ts`) | must say what is actually enforced |

**The doc contract** (pages are rows in `scripts/claude-doc-pages.tsv`;
quote-checked 2026-08-12 against the fetched `.md`):

- `settings.md` sandbox table: `enabled` — "Enable bash sandboxing (macOS,
  Linux, and WSL2). **Default: false**" — default-off is parity, not a
  deviation; always-on was OUR stricter fork choice.
- `sandboxing.md`: "To enable the sandbox across all of your projects, set
  `sandbox.enabled` to `true` in your user settings at `~/.claude/settings.json`."
- `sandboxing.md`: "For boolean keys such as `enabled` and `failIfUnavailable`,
  Claude Code uses the managed value and ignores anything a developer sets
  locally. For array keys such as `excludedCommands` and `allowRead`, Claude
  Code merges entries from every scope" — the composition rule T1 implements.
- `permission-modes.md`: "You can't enter `bypassPermissions` from a session
  that was started without it enabled." / "The `--dangerously-skip-permissions`
  flag is equivalent." / "In non-interactive mode no dialog is shown".
- `permission-modes.md`: "On Linux and macOS, Claude Code refuses to start in
  this mode when running as root or under sudo … The check is skipped
  automatically inside a recognized sandbox." — T4.
- `permission-modes.md`: "The first time you start an interactive session with
  this mode enabled, Claude Code shows a warning dialog asking you to accept
  responsibility … Claude Code **saves your acceptance to user settings**" — T5
  (ours lives in renderer localStorage today).
- `headless.md`: "`dontAsk` denies anything not in your `permissions.allow`
  rules or the read-only command set, which is useful for locked-down CI runs."
  — T3's ladder.

  **Citation corrected 2026-08-13 — the page changed under us within one day,
  and this is the AGENTS.md doc-drift rule catching a live case.** T3 was
  written against a sentence fetched 2026-08-12: "Other shell commands and
  network requests still need an `--allowedTools` entry or a `permissions.allow`
  rule, **otherwise the run aborts when one is attempted**." A re-fetch on
  2026-08-13 shows that clause DELETED; the sentence now reads "Apart from the
  read-only command set, other shell commands and network requests still need an
  `--allowedTools` entry or a `permissions.allow` rule." The page no longer
  states the consequence at all. **T3's implementation is unaffected** — deny
  then abort remains a defensible non-interactive behaviour, and it is what the
  doc's own CI mode (`dontAsk`, quoted above, still verbatim) does. Only the
  citation was stale, and it is replaced rather than deleted so the next reader
  knows the abort wording was real on the day it was used.

**Already at parity (verified on HEAD 2026-08-12, do NOT re-open):** deny rules
evaluated before the bypass branch; ask rules and `requiresUserInteraction`
still prompt in bypass; removal circuit breaker incl. `$()`/backtick/`<()`
forms; protected-path table with bypass=allow; plan-blocks suspended when
bypass available; managed `disabledPermissionModes`; desktop enablement gate
(`cyclablePermissionModes`) + one-time dialog.

## 1. Hazards

1. **`IsolationDowngradeV1.reason` is a port + persisted union** (T1 adds a
   member). The R2 lesson: an unlisted enum value can make a runtime snapshot
   unparseable. Sweep (re-enumerate by grep at execution time; taken
   2026-08-12): `packages/shared/src/agent/pi-harness/process-supervisor-port.ts`,
   `packages/server-core/src/pi-harness/process-store.ts`,
   `packages/server-core/src/pi-harness/process-supervisor.ts`,
   `packages/shared/src/agent/pi-agent.ts`,
   `packages/shared/src/agent/local-tools/types.ts` + `runtime.ts`,
   `packages/shared/src/automations/hook-env-file.ts`,
   `packages/pi-agent-server/src/index.ts`, plus any zod pin of the union.
   `pi-agent-server` in the sweep ⇒ **rebuild subprocess bundles** in the same
   task and say so in the tracker note.
2. **A receipt must never claim a boundary nothing enforces.** T1 adds its OWN
   marker constant; never reuse `no-host-isolation` (the comment above
   `EXCLUDED_BY_POLICY_PROFILE` explains why).
3. **Tests that assert enforced isolation implicitly assume always-on.** T1
   flips the default at the RESOLVED-settings layer, so any test building
   supervisor options through `resolveHostSandboxSettings` must now opt in
   (`sandbox: { enabled: true }`) — sweep by running the isolation suites and
   fixing setups, never by weakening assertions.
4. **T1 and T4 both edit `SessionManager.ts`** — sequence them.
5. **`rm -rf release` before any full `bun test`**; one test wave at a time
   (two concurrent `bun test` processes manufacture failures).
6. **`bun run typecheck:all` does NOT cover `apps/cli`** — T3 runs the CLI
   package typecheck explicitly.
7. **mach-services conventions are load-bearing for T2** (when unparked): every
   allowed name carries a probe-derived justification; the
   pasteboard/LaunchServices/keychain exclusions are the file's reason to
   exist and their negative tests must keep passing.
8. **CLI mode change touches no wire schema** — `default` is already a valid
   `permissionMode` value; if T3 finds itself editing a schema or contract
   hash, the change has left its lane.
9. **Live evidence comes from a real spawn or packaged build**, never from
   `electron:dev` renderer claims (main-process code runs from built bundles
   there).
10. **One composition, never two.** The `enabled` resolution must live in ONE
    exported helper consumed by every reader (supervisor options AND the
    storage-level convenience contour b uses) — a second hand-rolled copy of
    "managed wins, else user, else false" is the drift the
    `host-sandbox-settings.ts` header already warns about.
11. **The checkout is SHARED with parallel waves** (verified 2026-08-12: two
    live peer sessions, uncommitted third-party edits in
    `packages/shared/src/automations/**` and elsewhere). Stage and commit by
    EXPLICIT pathspec only — never `git commit -a`, never `git add -A`; a
    crossed pathspec commit has already shipped foreign hunks under a foreign
    subject in this repo twice.

## T1 — Sandbox off by default: the full contour inventory

**Goal:** with a fresh install (no config), NOTHING is wrapped in
seatbelt/bwrap/firejail/Windows profiles anywhere in the product, with ONE
documented exception (contour c, below). One resolved boolean
(`sandbox.enabled`) restores today's behavior.

**Files:**
- Modify: `packages/shared/src/config/sandbox-settings.ts` (key, allowlist,
  `ResolvedSandboxSettings`, `resolveSandboxSettings`)
- Modify: `packages/server-core/src/bootstrap/host-sandbox-settings.ts` (thread
  `enabled` through the ONE composition both SessionManager and the doctor
  report read)
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (pass
  `sandboxEnabled` into `ProcessSupervisor` options next to `excludedCommands`)
- Modify: `packages/server-core/src/pi-harness/process-supervisor.ts`
  (downgrade branch + marker) and
  `packages/shared/src/agent/pi-harness/process-supervisor-port.ts`
  (`IsolationDowngradeV1.reason`) + hazard-1 sweep
- Modify: `packages/shared/src/config/storage.ts`
  (`getMacosSeatbeltBashSandboxEnabled` — master switch forces false)
- Modify: `packages/codex-responses-adapter/src/config-writer.ts`
  (`codexSandboxConfigForMode` gains the master-switch input)
- Modify: `packages/shared/src/agent/codex-agent.ts` (pass the resolved switch
  to the config writer at spawn)
- Test: `packages/shared/src/config/__tests__/sandbox-settings.test.ts`,
  `packages/server-core/src/pi-harness/process-supervisor.test.ts`, the codex
  config-writer test suite, one storage.ts test
- Docs: `docs-site/content/reference/config/config-file.md` + `ru/` mirror

**Contract, per contour:**

- **(key)** `SandboxSettingsV1.enabled?: boolean`, in the key allowlist,
  validated like `allowUnsandboxedCommands`. Composition per `sandboxing.md`:
  **the managed value wins outright** when the managed layer sets it (either
  value); otherwise the user value; otherwise the default. This is NOT the
  boolean-AND of `allowUnsandboxedCommands` — quote the doc sentence at the
  definition. **Default: one named constant `SANDBOX_ENABLED_DEFAULT = false`**
  with a comment carrying the owner decision date and the re-enable
  instruction (flip the constant, or set user/managed `sandbox.enabled: true`),
  so re-enabling is a one-line diff. `ResolvedSandboxSettings.enabled: boolean`
  flows through `resolveHostSandboxSettings` unchanged. Per hazard 10 the
  managed-wins-else-user-else-default logic is ONE exported helper
  (`resolveSandboxEnabled(layers, floor)`) that `resolveSandboxSettings` calls;
  contour b's convenience reader delegates to the same helper.
- **(a — supervisor)** `ProcessSupervisorOptions.sandboxEnabled?: boolean`.
  FIRST check in `resolveIsolationDowngrade`: `sandboxEnabled === false` →
  `{ reason: 'sandboxDisabled' }`, **unconditionally** — no egress exception
  («вообще выключены»). Consequence, documented at the `enabled` key AND in
  docs-site: with the sandbox off, `denyNetworkEgress` /
  `allowManagedDomainsOnly` and every deny-root are NOT enforced — a managed
  policy that needs them must also set the managed `sandbox.enabled: true`
  floor (which wins outright, per the composition rule). New receipt marker
  `SANDBOX_DISABLED_BY_CONFIG_PROFILE = 'unsandboxed:disabled-by-config'`
  (copy the existing markers' shape). The supervisor's own default (option
  absent) stays "isolate" — fail-closed for direct constructors and tests; the
  DEFAULT-OFF lives in the settings resolver only. `dangerouslyDisableSandbox`
  and `excludedCommands` branches stay untouched after the new first check.
- **(b — agents' approved-Bash seatbelt)** `getMacosSeatbeltBashSandboxEnabled()`
  returns `false` whenever the resolved master switch is off — the master
  switch OUTRANKS the legacy `macosSeatbeltBashSandboxEnabled` key, which keeps
  its meaning only while the master switch is on. Implemented via the hazard-10
  helper (storage.ts composes the same user layer + managed floor it already
  loads; no second copy of the rule). Bundled default is already `false`
  (§0 contour b) — pin BOTH facts with tests: legacy key `true` + master off →
  `false`; legacy key `true` + master on → `true`.
- **(c — `script_sandbox`) THE ONE EXCEPTION: keeps its own isolation.**
  Reasons, recorded here and as a category string: its wrap covers only its own
  inline diagnostic scripts (never user Bash, never browsers), so it is not the
  instability source this plan exists to remove; isolation is the tool's
  `safeMode: 'allow'` rationale — auto-allowed BECAUSE wrapped — so unwrapping
  it silently would be a security inversion; and it already fails closed
  (refuses to run) where no backend exists. A test pins that the handler still
  wraps when the master switch is off.
- **(d — Claude SDK)** Verification, not change: we never pass a `sandbox` key
  to the SDK, and the SDK's own default is off. Add the cheapest durable pin —
  an assertion in the existing Claude agent options test that the composed
  options/settings carry NO `sandbox` key; if no test seam exists, record the
  grep evidence in the tracker note instead of building one.
- **(e — Codex)** `codexSandboxConfigForMode` (or a thin wrapper the config
  writer calls) gains `sandboxGloballyEnabled: boolean`. When `false`, emit
  `sandbox_mode: 'danger-full-access'` for EVERY mode while keeping each mode's
  `approval_policy` exactly as today. This deliberately supersedes blueprint
  §12's "never map to danger-full-access" FOR THE SANDBOX KNOB ONLY — §12's
  actual concern was the approval loop staying Nessy-gated, and it stays: only
  the OS wrap goes. Comment at the switch references both decisions
  (blueprint §12; owner 2026-08-12). Tests: master off → `danger-full-access`
  + unchanged approval policies for every mode; master on → today's mapping
  byte-identical (pin).
- **(f — reporting)** Receipts are covered by (a)'s marker. The doctor/
  capabilities surface that reads `resolveHostSandboxSettings` must surface
  `enabled: false` (one field/line, e.g. "sandbox: disabled (config default)")
  so an operator reading the report learns the layer is off — locate the
  doctor consumer of `resolveHostSandboxSettings` and add the boolean to its
  output; no new wire surface beyond that reader.

**Category strings** (regenerated register must pick all three up):
- sandbox-default-off-until-agent-stabilization — documented, not implemented — the OS wrap layer ships disabled by owner decision 2026-08-12; parity, not a gap, since settings.md's own default is false; a managed policy wins in either direction over `sandbox.enabled`
- codex-danger-full-access-when-sandbox-off — documented, not implemented — the codex runtime's own sandbox mode follows the master switch while its approval policy is left untouched, so blueprint section 12's gate stays Nessy-side, in `codexSandboxConfigForMode`
- script-sandbox-keeps-isolation — documented, inapplicable — it runs untrusted snippets, its network isolation is why it needs no prompt, it fails closed, and it was never the instability the switch removes; see `script-sandbox.ts`
- auto-mode-risk-band-still-assumes-a-sandbox — documented, not implemented — auto's risky band treats only the administrator's excluded patterns as escapes, false while the switch is off; DOWNGRADED after checking the contract 2026-08-13: permissions.md says the built-in read-only set runs without a prompt in EVERY mode, sandbox or not, so the auto-approval this band leaves in place is the documented behaviour and not a divergence; not re-calibrated on purpose, named in the 1.25.1 notes; revisit on re-enable — see `unsandboxedCommandPatterns`

**Steps:**
1. Failing settings tests: parser accepts `enabled: false`, rejects
   `enabled: "no"`; managed `true` + user `false` → `true`; managed `false` +
   user `true` → `false`; nothing set → `false`; user `true` alone → `true`.
2. Failing supervisor tests (mirror the `excludedCommands` spawn tests):
   `sandboxEnabled: false` → argv contains no `sandbox-exec`/launcher, receipt
   `unsandboxed:disabled-by-config`, `isolationDowngrade.reason ===
   'sandboxDisabled'`; ALSO with `denyNetworkEgress: true` → still bare (no
   egress exception); option absent → wrapped exactly as today (pin).
3. Failing storage test for contour b (both directions).
4. Failing codex config-writer tests for contour e (both directions).
5. Implement all contours; hazard-1 union sweep; rebuild subprocess bundles.
6. Hazard-3 sweep: run the isolation suites; give setups that assumed
   always-on an explicit `enabled: true`; never weaken an assertion.
7. Contour f reader + docs-site EN/RU page.

**Gate:** the four focused suites; `bun run typecheck:all`; isolation/process
lifecycle is a verification-budget risk trigger ⇒ run the full
`packages/server-core` suite plus `packages/shared` config suites once on the
final task diff. Outputs into the tracker note.

**Commit:** `feat(sandbox): sandbox.enabled kill switch — default off across every wrap contour`

## T2 — Darwin profile lets Chromium start inside the sandbox — ⏸ PARKED

Parked 2026-08-12 by owner direction («вообще выключить»). **Unpark condition:
before ANY re-enable of `sandbox.enabled`** (default flip, user doc telling
people to set it, or a managed floor) — without this task the §0 crash returns
the moment the sandbox comes back. §0's ladder is the specification.

**Files:**
- Modify: `packages/session-tools-core/src/runtime/filesystem-isolation.ts`
  (`buildProfile`)
- Modify: `packages/session-tools-core/src/runtime/mach-services.ts`
- Test: `packages/session-tools-core/src/runtime/filesystem-isolation.test.ts`
- Docs: `docs/testing/cdp-live-checklist.md` (new live row: "playwright
  chromium launches inside sandboxed shell")

**Contract:**
- Skeleton gains, for every profile flavor (the crash is not network-specific):
  - `(allow iokit-open)` — start narrow; the probe is the arbiter. If it still
    SIGSEGVs, widen stepwise (`iokit-get-properties`, then `iokit*`), recording
    in mach-services style WHICH step was required and what symptom it cleared.
  - Filtered mach-register: `(allow mach-register (global-name-prefix
    "org.chromium."))` plus `(global-name-prefix "com.google.Chrome.")` (Chrome
    for Testing brands its rendezvous name). Bare `(allow mach-register)` only
    if the filtered form measurably fails, failure pasted into the tracker.
  - The same two prefixes appended to the mach-lookup rule — children
    `bootstrap_look_up` the name the parent registered; §0's ladder passed with
    a BARE lookup, so the filtered lookup is unproven and the probe must cover
    it.
- Exclusions preserved: pasteboard, LaunchServices, keychain names stay out;
  their negative tests keep passing.
- Headed (non-headless) browsers OUT of scope (WindowServer) — category string.
- Linux backends OUT of scope; darwin only.

**Steps:** red profile-content tests (new rules present per flavor; pasteboard
still absent; no bare mach-register) → implement in mach-services conventions →
live probe against the REAL generated profile (print via a scratch bun script
calling `applyFilesystemIsolation('true', [], dir, {...})` and extracting the
`-p` argument, then §0's recipe; required outcome exit 0 + DOM) → transcript
into tracker → cdp-live-checklist row.

**Gate:** focused suite + probe transcript; `session-tools-core` package suite
once on the final diff.

**Commit:** `fix(sandbox): darwin profile lets Chromium start — iokit and filtered mach-register, probe-proven`

## T3 — CLI stops defaulting to bypassPermissions

**Files:**
- Modify: `apps/cli/src/index.ts` (the `sessions:create` default
  `permissionMode: … || 'bypassPermissions'`, the arg parser, the help text)
- Test: the CLI's existing test surface (`apps/cli/src/*.test.ts`; create
  `permission-mode-default.test.ts` if none fits)
- Docs: `docs/cli.md`

**Contract:**
- No `--permission-mode` given → the session must not be silently bypass AND
  must not hang a non-interactive run. Decision ladder, measured not assumed:
  1. Trace what a permission prompt does to `run` today: create a
     `default`-mode session via the CLI against a local server and force a
     prompt (a Bash mutation outside allow rules). If approval-request frames
     are observable in the CLI stream and answerable over the existing RPC
     surface → default to `default` and add an auto-deny responder: every
     approval request is answered deny, one stderr line
     `permission denied (non-interactive run): pass --permission-mode
     bypassPermissions or pre-approve with allow rules`, run exits non-zero —
     `headless.md`'s "the run aborts when one is attempted", made explicit.
  2. If the wire gives the CLI no way to see or answer approvals without new
     surface → default to `dontAsk` (the doc's own "Locked-down CI and
     scripts" mode) with one printed stderr notice naming the substitution.
     Category string: `deviation: cli-headless-dontask-fallback — the CLI
     transport has no prompt channel; dontAsk yields the same observable
     outcome (would-prompt actions are denied)`. Do NOT invent new wire
     surface in this task.
- `--dangerously-skip-permissions` accepted as an alias for
  `--permission-mode bypassPermissions` (cli-reference parity). No ack gate in
  the CLI: non-interactive shows no dialog per the contract, and the CLI has
  no `--bg` analog to refuse.
- `--allow-dangerously-skip-permissions` NOT implemented: a single-shot run has
  no mode cycle to pre-arm. Category string:
  `deviation: allow-dangerously-skip-flag-inapplicable — no mode cycle in the
  CLI; the desktop enablement toggle is the availability surface`.
- The other `bypassPermissions` literals in `apps/cli/src/index.ts` (three-four
  internal subcommand sites on 2026-08-12 HEAD) are inspected one by one: only
  user-session-creating paths flip; an unattended automation-internal path may
  keep bypass with a one-line comment naming this plan. Per-site verdicts in
  the tracker note.
- Sweep internal callers (`rg -n 'nessy-general-agent' scripts/ docs/`): any
  invocation relying on the implicit bypass default gets the explicit flag in
  this same commit.
- Help text updated; release notes (T6) call out the behavior change with the
  one-line migration.

**Category strings:**
- `deviation: allow-dangerously-skip-flag-inapplicable — no mode cycle in the
  CLI; the desktop enablement toggle is the availability surface`

**Steps:** measure (ladder step 1) → failing test for the chosen default →
failing test for the alias flag → implement default + alias + responder (if
ladder 1) → help/docs → green.

**Gate:** CLI-focused tests; **`apps/cli` typecheck explicitly** (hazard 6);
one live `run` against a local server proving a mutating command no longer
executes silently without the flag (transcript into tracker note).

**Commit:** `fix(cli): headless runs stop defaulting to bypassPermissions; explicit skip flags`

## T4 — bypassPermissions refuses root/sudo

**Files:**
- Create: `packages/shared/src/agent/pi-harness/bypass-root-guard.ts`
- Modify: `packages/server-core/src/sessions/SessionManager.ts` — BOTH doors
  where a resolved `permissionMode` first becomes `bypassPermissions`: session
  create AND the mid-session mode-switch RPC handler (find by grepping the
  handler that accepts mode updates)
- Test: `packages/shared/src/agent/pi-harness/__tests__/bypass-root-guard.test.ts`
  (mirror the sibling tests' directory convention if it differs)

**Contract:**
- `assertBypassPermittedForProcess(opts: { euid?: number; platform?:
  NodeJS.Platform; containerMarker?: (path: string) => boolean })` — throws a
  coded error (`bypass-permissions-root-refused`) when `platform !== 'win32'`,
  effective uid is 0 (default `process.geteuid?.()`), and no container marker
  is present. Container markers: exactly `/.dockerenv` and
  `/run/.containerenv` (the doc's "recognized sandbox" analog; YAGNI beyond
  these two).
- Error text mirrors Claude's: "bypassPermissions cannot be used with
  root/sudo privileges for security reasons".
- Both doors refuse with that user-visible error; non-root desktop UX
  unchanged.

**Steps:** failing unit tests (euid 0 refused; euid 0 + `/.dockerenv` via
injected marker allowed; non-zero euid allowed; win32 skipped; `geteuid`
absent → allowed) → implement → wire both doors → one integration test at the
create door if the existing harness makes it cheap, else record why not.

**Gate:** focused tests; shared + server-core typechecks. Runs AFTER T1 (same
`SessionManager.ts`).

**Commit:** `fix(modes): bypassPermissions refuses root/sudo outside containers`

## T5 — Bypass responsibility ack durable in user config

**Files:**
- Modify: `packages/shared/src/config/storage.ts` (getter/setter pair next to
  `getMemoryEnabled`/`setMemoryEnabled`, same shape:
  `getBypassPermissionsAcknowledged()` / `setBypassPermissionsAcknowledged()`
  over a `bypassPermissionsAcknowledged?: boolean` key in `config.json`)
- Modify: `packages/shared/src/config/validators.ts` (schema accepts the key)
- Modify: `apps/electron/src/renderer/lib/bypass-permissions-gate.ts` + the IPC
  surface the renderer already uses for config reads/writes (reuse an existing
  channel; do not add one if an existing config/preferences channel fits)
- Test: storage round-trip + migration test; gate unit tests updated

**Contract:**
- Single durable source: `bypassPermissionsAcknowledged: true` in the user
  config tier, written when the user accepts the dialog ("saves your
  acceptance to user settings").
- Migration: first read finds localStorage
  `nessy:bypass-permissions-acknowledged === '1'` → write the config key; keep
  the localStorage entry as a dead legacy key (do not delete — a downgrade
  must not re-prompt endlessly).
- NOT writable through any model-invocable surface — a model must never
  pre-accept a responsibility dialog. Only the renderer dialog-accept path
  writes it.
- Renderer gate keeps a sync call shape by hydrating the value once at startup
  through the config snapshot the renderer already receives; decision rule: if
  no such snapshot field exists, the gate goes async — its call sites are
  pickers and can await.
- Decline still leaves the session in its current mode (desktop analog,
  unchanged; Claude-CLI's exit-on-decline is terminal behavior with no desktop
  equivalent — already recorded by V1's surface mapping).

**Steps:** failing storage test (round-trip + migration) → implement storage →
failing gate test (reads config, migrates localStorage once, decline keeps
mode) → implement gate + IPC hydration → green.

**Gate:** shared config suite + gate tests; `bun run typecheck:all`.

**Commit:** `fix(modes): bypass responsibility ack durable in user config`

## T6 — Close-out

Per AGENTS.md the plan is not closed until:

1. **Live smoke — the original failure scenario, now green by default:** on a
   default-config build (no sandbox keys anywhere), a real session runs a
   Playwright chromium headless launch (the §0 recipe through the session's
   own Bash tool) and it succeeds; the execution receipt reads
   `unsandboxed:disabled-by-config`. Transcript into the audit note. This is
   packaged/real-spawn evidence per hazard 9.
2. **Version bump** to **1.26.0** in BOTH root `package.json` and
   `apps/electron/package.json`, FROM whatever the lockstep version is at
   execution time — 1.25.1 as of this plan's merge (a parallel wave bumped it
   mid-day); verify with `rg '"version"' package.json apps/electron/package.json`
   before writing the release-notes filename.
3. **New** `apps/electron/resources/release-notes/1.26.0.md` (append-only,
   house style: `# Nessy Desktop 1.26.0`, date line, then):
   - `## NEW` — `sandbox.enabled` setting; process isolation is now opt-in
     until agent workflows stabilize (re-enable per docs); CLI
     `--dangerously-skip-permissions`.
   - `## IMPROVED` — CLI headless runs default to `default` mode (breaking:
     `--permission-mode bypassPermissions` restores the old behavior);
     bypassPermissions refuses root/sudo; the bypass acknowledgment survives
     profile resets.
   - `## FIXED` — Playwright/Chromium crash at launch inside sandboxed
     sessions (the sandbox no longer wraps commands by default).
4. **docs-site**: `docs-site/content/reference/config/config-file.md` AND the
   `ru/` mirror — `sandbox.enabled` (default false, managed-wins rule, the
   egress consequence from T1(a)), `excludedCommands`, the re-enable path.
   `docs/cli.md` updated in T3.
5. **Parity artifacts**: add the 2026-08-12 audit note (bypass re-audit verdict
   + these closures) to
   `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0;
   regenerate BOTH generated files:
   `python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md`
   and
   `python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md`
   — the five category strings from T1/T3 must appear; count the row diff.
6. **Full regression** (final-acceptance wave, sequenced): `rm -rf release`,
   `bun run typecheck:all`, `apps/cli` typecheck, `bun run lint`,
   `bun run lint:i18n:parity`, `bun run lint:i18n:sorted`, `bun test`,
   `bun run validate:ci`. Compare failures against
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md` AND against
   master's last green pipeline, not only against the branch base.

**Commit:** `chore(release): 1.26.0 — sandbox off by default across contours, bypass CLI parity`

---

*Merge record 2026-08-12: this revision absorbs the committed 470-line plan
(`0fe51e750`) and the uncommitted `2026-08-12-sandbox-kill-switch-and-bypass-parity.md`
draft (deleted after absorption — it was never committed, so no recorded
decision is lost; its unique content — §0 facts, hazard set, file map, T5
config-tier choice — lives above).*
