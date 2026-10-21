# Deviation Unit 5 — sandbox boundary wiring

**Status:** closed
**Source:** `docs/superpowers/specs/2026-07-29-deviation-worklist.md` § 3, Unit 5
**Branch:** `fix/renderer`
**Base:** `1966b7b7`

Five rows. Four are wiring against values the host already computes; the fifth
is a ledger entry. One commit per row.

## Contract source — re-fetched raw, cites re-derived against the fetched files

```
curl -sL https://code.claude.com/docs/en/sandboxing.md      #  505 lines
curl -sL https://code.claude.com/docs/en/settings.md        # 1205 lines
curl -sL https://code.claude.com/docs/en/network-config.md
```

Line numbers were re-derived, not carried over. The sibling plan corpus records
two different drifts on these pages (one uniformly 7 low, one non-uniform), so
every cite below was read out of the fetched file in this session.

`sandboxing.md:372` — the sentence the whole unit turns on:

> Paths from both `sandbox.filesystem` settings and permission rules are merged
> together into the final sandbox configuration.

`sandboxing.md:366`–`:367`, from the table above it: `Edit` allow rules "Grant
write access to specific paths, the same way `sandbox.filesystem.allowWrite`
does"; `Read` and `Edit` deny rules "Block access to specific files or
directories"; `sandbox.filesystem.denyWrite` and `denyRead` (`:363`) "Block
subprocess access to specific paths".

`settings.md:414`–`:416` gives the same mapping per key:

| key | doc sentence |
| --- | --- |
| `filesystem.allowWrite` | "Also merged with paths from `Edit(...)` allow permission rules." |
| `filesystem.denyWrite` | "Also merged with paths from `Edit(...)` deny permission rules." |
| `filesystem.denyRead` | "Also merged with paths from `Read(...)` deny permission rules." |

`settings.md:411` — `autoAllowBashIfSandboxed`, "Auto-approve bash commands when
sandboxed. Default: true". `settings.md:413` — `allowUnsandboxedCommands`, "When
set to `false`, the `dangerouslyDisableSandbox` escape hatch is completely
disabled". `settings.md:695` — "Array settings merge across scopes … concatenated
and deduplicated, not replaced".

`sandboxing.md:149`/`:162` — `allowWrite` grants write access to specific paths,
and "These paths are enforced at the OS level, so all commands running inside the
sandbox, including their child processes, respect them."

`sandboxing.md:135` — the escape hatch and the rule an administrator writes:

> when a command fails because of sandbox restrictions, Claude analyzes the
> failure and may retry the command with the `dangerouslyDisableSandbox`
> parameter. The retried command runs outside the sandbox, so it goes through
> the regular permission flow […] To be prompted on every unsandboxed retry even
> in auto mode, add an ask rule for `Bash(dangerouslyDisableSandbox:true)`.

`sandboxing.md:137` — and what strict mode does to it: "the
`dangerouslyDisableSandbox` parameter is completely ignored and all commands
must run sandboxed or be explicitly listed in `excludedCommands`."

`network-config.md:90`–`:112` — the mTLS variables (`CLAUDE_CODE_CLIENT_CERT`,
`CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`) and the one place
the docs scope them: in Desktop sessions where the app manages the connection
they are read "only from managed settings and `~/.claude/settings.json`: it
ignores them in a repository's own settings files, so a checked-out repository
can't redirect the TLS or proxy path of a session whose credentials come from
the app" (`:118`).

## The five rows, in commit order

| # | Row | Commit |
| - | --- | ------ |
| 1 | `additionalWritableRoots` never reaches `ProcessSupervisor` | `f7861828` * |
| 2 | permission rules never merge into the sandbox boundary | `29399097` |
| 3 | `addDirectories` does not reach every gate | `280c04a1` |
| 4 | `Bash(dangerouslyDisableSandbox:true)` has no producer | `cf65b4e4` |
| 5 | the mTLS plugin-boundary carve-out is a ledger entry | this file |

\* Row 1's diff was absorbed into another agent's commit. Its four files were
staged when a concurrent session ran a whole-index commit; `f7861828`
("docs(plans): close R25c with gate evidence") therefore carries
`process-supervisor.ts`, `process-supervisor.test.ts`, `SessionManager.ts` and
`managed-sandbox-and-channel.test.ts` alongside that session's plan file. The
content landed intact and is verified in `f7861828`'s diff; only the commit
message is not this row's. Every later row was committed with an explicit
pathspec (`git commit -- <paths>`) so the index could not be shared again.

## What became permitted, per row

Every row in this unit widens something, so each measured its own differential
against real code and reported the exact count. Full numbers are in the commit
bodies; the summary:

| Row | Configurations compared | Differ | Newly permitted | Lost |
| --- | --- | --- | --- | --- |
| 1 | 36 darwin profiles | 24 | 3 write rules, each a literal configured root | 0 write rules, 0 deny rules |
| 2 | 156 resolved settings | 60 | 2 write roots (`Edit` allow), 2 new denies | 0 grants, 0 denies, 0 other keys |
| 3 | 315 mode-gate verdicts | 8 | 8 `safe`-mode writes inside the granted root | 0 allow→deny |
| 4 | 48 producer combinations + 112 mode-gate verdicts | 1 + 0 | 1 sandbox downgrade, on an allowed Bash call | 0 verdict changes |

## Deviations recorded

| Subject | Category |
| --- | --- |
| `sandbox.filesystem.allowWrite` reaches every sandboxed command (`sandboxing.md:149`, `:162`) | `documented, implemented` |
| `allowWrite` ← `Edit` allow rules (`settings.md:414`, `sandboxing.md:366`) | `documented, implemented` — managed scope |
| `denyWrite` ← `Edit` deny rules (`settings.md:415`) | `documented, implemented` — new `deniedWriteRoots` primitive on all three backends |
| `denyRead` ← `Read` deny rules (`settings.md:416`) | `documented, implemented` — managed scope |
| `allowRead` re-opening a `denyRead` region (`sandboxing.md:176`–`:181`) | `documented, not implemented — no isolation profile is a read allowlist; every backend grants ambient whole-filesystem read and `deniedReadRoots` is a deny carved out of it, so there is no denied region for an `allowRead` to re-open. Flipping the read posture is a separate design change, recorded on `sandbox-settings.ts` since before this unit` |
| Non-managed scopes merging permission rules into the boundary | `documented, not implemented — the boundary is process-lifetime (one `ProcessSupervisor` per host) while workspace, project and plugin rule layers are resolved per session and per turn. Merging a session-scoped rule into a host-scoped OS boundary would leak one session's grant into another. The managed tier is the scope that is genuinely host-owned, and it is the tier the lock keys (`allowManagedReadPathsOnly`, `allowManagedDomainsOnly`) are written for` |
| A partial-glob or cwd/source-anchored `Read`/`Edit` rule | `documented, not implemented — an OS filesystem rule is "this path and everything under it" on every backend, so `Edit(//tmp/*/build/**)` has no exact equivalent and reducing it to `/tmp` would grant or deny far more than the rule says. Skipped with a diagnostic; the permission layer still enforces it in full` |
| `autoAllowBashIfSandboxed` (`settings.md:411`, `sandboxing.md:239`) | `documented, not implemented — the documented default `true` is conditioned on `sandbox.enabled`, an opt-in Nessy has no analogue of: supervised-process isolation here is unconditional, so porting the default verbatim would auto-approve EVERY Bash command. Honouring the key needs the opt-in surface it hangs off plus the four carve-outs at `sandboxing.md:124`–`:127` (deny rules always respected, `rm` of critical paths still prompts, content-scoped ask rules still force a prompt, a bare `Bash` ask rule skipped only outside plan mode). A settable-but-unread key would be the exact "declared on one path, enforced on another" defect this series keeps finding, so no key was added` |
| `dangerouslyDisableSandbox` as a model-facing Bash parameter (`sandboxing.md:135`) | `documented, implemented` — host-produced, keyed by execution id |
| `Bash(dangerouslyDisableSandbox:true)` ask rule (`sandboxing.md:135`) | `documented, implemented` — compiles to a parameter matcher and fires on the boolean, verified on current HEAD |
| Strict sandbox mode ignoring the parameter (`sandboxing.md:137`) | `documented, implemented` — the producer drops it, so the command runs sandboxed; the supervisor's hard refusal stays as the floor |
| mTLS client identity across the plugin boundary (`network-config.md:90`–`:112`) | `documented, not implemented — see below` |

### The mTLS plugin-boundary carve-out

**Category:** `documented, not implemented — deliberate; the app's TLS client
identity is withheld from supervised plugin processes.`

**What the docs say.** `network-config.md:90`–`:104` describes
`CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY` and
`CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` as ordinary exported environment variables.
Nothing in the page scopes them away from a subprocess, so the documented
behaviour is that anything Claude Code spawns inherits them.

**What we do.** `proxy-env.ts:120`–`:129` (`getPluginNetworkEnvVars`) projects
proxy and CA only, via the `excludeClientIdentity` option at `:47`–`:52`. Three
consumers use it: plugin-provided MCP servers (`mcp/client.ts:493`), the plugin
runtime dependency bootstrap
(`server-core/src/bootstrap/plugin-runtime-dependencies.ts:317`) and the plugin
runtime resolver (`agent/backend/internal/runtime-resolver.ts:207`). Trusted
subprocesses — Pi, the Claude Code subprocess, native stdio MCP servers, the
headless server's children — still get the full projection through
`getProxyEnvVars()`.

**Threat statement.** A plugin is third-party code installed from a marketplace
and executed by the app; it is exactly the trust boundary the sandbox and the
plugin permission surface exist to draw. `CLAUDE_CODE_CLIENT_CERT` and its key
are an *authentication credential*, not a trust anchor: a process holding them
can present itself to the organization's mTLS-protected services AS the app,
from any host the plugin can reach, for as long as the certificate is valid.
The CA path and proxy settings carry no such power — they say which authorities
to trust and where to route, so a plugin needs them to traverse the corporate
network at all and gains nothing by having them. That asymmetry is the whole
carve-out: route and trust cross the boundary, identity does not.

The nearest documented precedent points the same way. `network-config.md:118`
scopes these same three variables in Desktop sessions where the app manages the
connection, reading them "only from managed settings and
`~/.claude/settings.json`" and ignoring them in a repository's own settings
files, "so a checked-out repository can't redirect the TLS or proxy path of a
session whose credentials come from the app". Untrusted repository content and
untrusted plugin content are the same threat; the docs draw the line at
configuration, and we draw it one step further out, at the process.

**Live state.** The rationale is present in code and plan — `proxy-env.ts:47`–`:52`
and `:120`–`:126`, and `docs/superpowers/plans/2026-07-28-network-trust-chain.md`
— so the worklist's note stands: the row's "no reason given at all" half is
false, having landed in `c3c484e7`, which is not an ancestor of the report's
baseline `0a77b5ea`. What was missing was the ledger entry with a category
string. This is it. No code changes.

## Gate evidence

Run from the REPO ROOT. Sandbox boundary and permission decisions are two of
the listed immediate risk triggers, so the permission, mode, sandbox and
process-supervisor suites were run once on the final diff rather than after
every edit.

```
$ bun run typecheck:all
exit 0, no output — core, shared, server-core, server, session-tools-core,
pi-agent-server, apps/electron, ui all clean in the working tree. No detached
worktree was needed this time.

$ bun run lint
exit 0 — 4 pre-existing warnings (unused eslint-disable directives in
session-scoped-tools.ts, setupI18n.ts, debug.ts), 0 errors, none in this diff.
```

Permission suite (23 files):

```
$ bun test packages/shared/src/agent/pi-harness/{permission-dsl,claude-permission-rules,claude-bash-rule,permission-receipt,managed-policy,sandbox-permission-rules}.test.ts \
    packages/shared/src/agent/core/__tests__/{permission-manager,permission-context-boundary}.test.ts \
    packages/shared/src/agent/__tests__/{permissions-config-migration,browser-tools-permissions,call-llm-permissions,send-developer-feedback-permissions,session-tool-safe-mode-permissions,spawn-session-permission-mode-schema,permission-mode-clamp}.test.ts \
    packages/shared/src/sessions/__tests__/{jsonl-permission-mode-normalization,previous-permission-mode}.test.ts \
    packages/shared/src/workspaces/__tests__/storage-permission-mode-normalization.test.ts \
    packages/server-core/src/pi-harness/permission-service.test.ts \
    packages/server-core/src/sessions/{SessionManager.permission-authority,permission-remember}.test.ts \
    apps/electron/src/renderer/event-processor/handlers/permission-mode-changed.test.ts \
    apps/electron/src/renderer/lib/__tests__/composer-permission-modes.test.ts
 228 pass, 0 fail, 793 expect() calls, 23 files
```

Mode suite (8 files):

```
 56 pass, 0 fail, 301 expect() calls, 8 files
```

Sandbox suite (10 files — settings, the rule converter, the escape-hatch
producer, filesystem isolation, sandbox env, script sandbox, the orchestrator
sandbox, managed sandbox composition, and both isolation resolvers):

```
 105 pass, 0 fail, 302 expect() calls, 10 files
```

Process-supervisor suite (6 files):

```
 90 pass, 0 fail, 374 expect() calls, 6 files
```

Model-contract guard, after updating the `bash` pin and rebuilding both bundles
(`packages/pi-agent-server && bun run build`, then
`bun run scripts/stage-electron-servers.ts`):

```
$ bun test packages/pi-agent-server/src/harness/live-manifest-contract.test.ts
 3 pass, 0 fail, 79 expect() calls
```

Whole-package sweep of everything touched:

```
$ bun test packages/shared packages/server-core packages/session-tools-core
 7158 pass, 18 skip, 12 fail, 6 snapshots, 21571 expect() calls, 595 files

$ bun test packages/pi-agent-server
 470 pass, 1 fail
```

All 13 failures are the known pre-existing set and nothing else: seven
`ensureStorageLayoutV2` cases, two `paths-default-root` cases, one
`managed paths with NESSY_CONFIG_DIR`, the two `SessionManager.orchestration`
background-authority cases, and
`Pi harness R0 baseline > executes golden foreground and background process
contracts` (whose diff is `isolationProfile: workspace` vs `networked`, from a
default this unit never touched). The load-order-dependent
`AUTO_MEMORY_MARKER_REGEX_SOURCE` TDZ did not surface in any run.

## Worklist claims that were wrong about the code

1. **The four `addDirectories` gates had drifted.** The worklist's correction to
   the original report — four gates, not two — is right, but the anchors moved:
   `:3694`, `:3967`, `:4143`, `:14724` are now `:3696`, `:3969`, `:4145`,
   `:14826`, the last by more than a hundred lines. All four were found by
   symbol, not by line.

2. **Row 1's blocker was overstated in the opposite direction to row 2's.** The
   worklist says the supervisor's "constructor options have no such field — it
   exists per-request only", which is exactly right, but it does not say that
   `SessionManager` also had a *resolved, floor-capped* value sitting unused
   three lines above the constructor call. The fix was two lines plus a merge,
   not a plumbing job.

Everything else the worklist asserted about these five rows reproduced exactly,
including the "false blocker" call on row 2 (`policy.sandbox` and
`policy.claudeRules` really are fields of the same parsed object) and on row 4
(the host really does hold both halves of the correlation).

## Propagation found, not fixed

- **`Bash(dangerouslyDisableSandbox:true)` is the only rule form that reaches
  the escape hatch.** An administrator who instead writes a *deny* rule
  (`Bash(dangerouslyDisableSandbox:true)` with `deny`) gets the call denied
  outright, which is correct, but there is no equivalent of
  `allowUnsandboxedCommands: false` expressible as a rule, and no UI surface for
  either. The lock is settings-only.

- **`credentials.files` / `credentials.envVars` (`sandboxing.md:243`–`:271`)
  have no analogue.** The seeded `credentialDenyRoots` floor covers the same
  files by convention rather than by configuration, and there is no env-var
  scrub or `mask` mode at all. `deniedWriteRoots` gives the block a second key
  to hang off if someone implements it, but nothing in this unit does.

- **`sandbox.filesystem.disabled` (`sandboxing.md:199`–`:239`) is absent**, and
  with it the source-scoping rules at `:227`–`:231` that decide which settings
  tiers may set it. Not a Unit 5 row; worth one.

- **The win32 permission profile could previously emit a duplicate TOML key**
  when a path appeared in both `writableRoots` and `deniedReadRoots`. Row 2's
  one-key-per-path map closes that as a side effect; the pre-existing collision
  was never reachable from a shipped configuration, since nothing produced
  overlapping lists before this unit.
