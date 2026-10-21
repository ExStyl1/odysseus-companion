# 2026-09-18 — measure sitting 5f (WAVE I-7, lane SIT-5f) on the packaged 1.40.0, CLEAN environment

Build under test: `release/mac-arm64/Nessy Desktop.app`, **1.40.0** (`CFBundleShortVersionString` reads
`1.40.0`), built by the controller from **`61cfc4659`**; dmg
`release/NessyDesktop-1.40.0-mac-arm64.dmg`, unsigned, dev update feed. Never rebuilt, never removed.

Rig: ports **9232** (the RS-43 proxied arm's app), **9233** (this lane's refusing proxy) and **9236** (the
measure app) — all inside the reserved 9232–9241, proved free with `lsof` before the first launch.
`NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad, created for the run and never under
`~`. The owner's profile was never launched, `dp auth login`/`logout` never run, and **no token was read,
printed or committed** — the one credential file this lane speaks about is reported through the app's own
config doctor, by reason code and by the relocated file's existence. SIT-5e ran beside this lane on
9252–9261; nothing of its processes, ports or files was touched.

## 0. The clean-environment control, printed once per run

The derivation re-run at HEAD with D1.325's repaired NUMERIC filter and the boundary-aware `-P`:
**THIRTEEN names over a 31-name candidate set**, membership and every count identical to sittings 3, 4, 5a,
5b and 5d — `ANTHROPIC_BASE_URL` 51, `CLAUDE_EFFORT` 19, `CLAUDE_CODE_DISABLE_CRON` 12,
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE` 11, `CLAUDE_CODE_SUBAGENT_MODEL` 10, `DISABLE_AUTOUPDATER` 5,
`CLAUDE_CODE_EXECPATH` 4, `CLAUDECODE` 2, `CLAUDE_CODE_OAUTH_SCOPES` 2, and four at 1.

Every launch used the `env -u` launcher; the app's own read-back through `ps eww`, scoped to this lane's
config dir, answered `{"pids":4,"present":{},"controlSeen":true}` and `appEnvBlockReason` returned nothing.
**`CLAUDE_EFFORT` being absent is load-bearing here and not a formality**: RS-86's whole subject is whether
the HOST puts that name into a hook child, so an app that inherited it from the lane's shell would have
handed the hook a value the product never resolved, and the reading would have been about a shell. The case
scores that as a check of its own rather than leaning on the launcher.

---

## 1. D1.340 — RS-43's proxied re-mint arm now scores the DA2.19 reading (case `RS-43`, **PASS 2/2**, 91 609 ms)

### What was wrong, in SIT-5d's own words

*"`rs-43.ts` `require`s 'the app lists at least one connection' before its timing table. Under
`NESSY_CDP_RS43_REMINT=1` on a proxied arm, that precondition is now unreachable on a correct build: the
one-click card is created by a sign-in the proxy refuses."* SIT-5d's run therefore read **PASS on DA2.19
and FAIL on the case in the same minute**, filing the row's own answer as a broken rig.

### The repair, and the three conditions that keep it from excusing a broken rig

The `require` is now a scored CHECK, reached only when all three hold:

1. the arm is the re-mint one (`NESSY_CDP_RS43_REMINT=1`), so the empty credential store is deliberate;
2. a rig proxy log is configured — and the case's own `curl` control has already proven this process can
   read it;
3. the seeding window itself carries at least one refusal.

Without them the `require` still fires, **because a proxy that is not running, an app that never egressed
and a click that missed the button all produce the same empty card list** and must not share a verdict.

### The re-run, on the same three-arm rig shape SIT-5d used

Two directories created EMPTY seconds before launch (`NESSY_HOME` and `HOME`), the app's own `config.json`
written by the APP first (launch once, quit) and the `networkProxy` block merged into it afterwards —
`enabled: true`, `http(s)Proxy: http://127.0.0.1:9233`, `noProxy: code-completion-nestor.tcsbank.ru` —
with every proxy spelling deleted from the environment by the launcher.

| reading | this run | SIT-5d, same artefact |
| --- | --- | --- |
| `as.tbank.ru` in the rig proxy's log | **5** | 5 |
| `devplatform.tcsbank.ru` | **2** | 2 |
| the app's own doctor before the turn | `no_credentials` / `absent` | `no_credentials` / `absent` |
| a credential written into the empty `NESSY_HOME` | none | none |
| the one-click card | `[]` | `[]` |
| **the case's own verdict** | **PASS 2/2** | FAIL on the precondition |

Three positive controls, all present: the case's `curl` through the proxy (exit 56, one new log line,
`example.com`); the app's own `updates.invalid` in the proxy log within seconds of launch, which says the
setting binds the MAIN process independently of anything `dp` does; and the app's own config doctor
answering at all.

### The negative control, and what it does and does not prove

The same rig, the same app, the same minute, with `NESSY_CDP_RS43_REMINT` **unset**: the case did **not**
score the DA2.19 check and did not pass — it stopped in the seed block and reported
`BLOCKED (this profile lists no connection and the onboarding screen is not on screen)`, 1 066 ms. So the
new branch is gated on the arm it was written for and cannot fire outside it.

**What that control does not prove, said here rather than left to be assumed:** it does not exercise the
`require` itself, because by then the profile's onboarding button had already been pressed by the passing
run, so the case blocked one step earlier. The clause *"a working seed still passes the require"* is
SIT-5d's control arm on the same artefact — the no-`networkProxy` twin that minted a 452-byte credential,
seeded `pi-api-key` and answered a turn, **PASS 5/5** — and it is cited rather than re-run.

---

## 2. D1.43 — the three hook fields, all three answered (case `RS-86`, **10 of 11**, 111 455 ms)

Three sittings nulled this row for wanting *"three hook OUTPUT fields exercised from a real hook"*, which
is a fixture sitting rather than a blocked question. `scripts/cdp/fixtures/hook-output-fields.ts` is that
fixture: three hooks in one `hooks.json`, one per clause, so one clause failing cannot mask another.

**Re-anchored in words, as measure sitting 3 asked** (the row's line anchor had moved, content unchanged):
the effort clause is `packages/shared/src/automations/hook-command.ts` symbol `buildHookCommandEnv`, whose
last two `setSanitized` calls are `NESSY_EFFORT` and `CLAUDE_EFFORT` from `input.effort?.level`;
`terminalSequence` is the same file's symbol `parseUniversalHookOutput` and its OSC allowlist; `async` is
declared on the action schema in `packages/shared/src/automations/schemas.ts`.

### Clause 1 — the effort input REACHES the hook child

Session put at `high` and read back at `high` before the turn. The `PreToolUse` hook child's own env dump,
verbatim and complete (four names, none of them a credential):

```
--- CDP-D143 PreToolUse
CLAUDE_EFFORT=high
NESSY_TOOL_NAME=Bash
NESSY_EVENT=PreToolUse
NESSY_EFFORT=high
```

**PASS**, and the control is inside the same four lines: `NESSY_EVENT` is set unconditionally at the top of
`buildHookCommandEnv`, so a dump carrying it and no `CLAUDE_EFFORT` would have been an absence, while a
dump carrying neither would have been a hook that never ran. Both spellings arrived, which is the
both-spellings convention the fork uses elsewhere holding.

A fourth control sits above all of it: the app was launched with `CLAUDE_EFFORT` DELETED, and the case
scores that separately (`{"pids":4,"present":{},"controlSeen":true}`). Without it a hook child carrying
`CLAUDE_EFFORT` would be the lane's own shell arriving as a product reading.

### Clause 2 — `terminalSequence` is parsed and goes nowhere

ONE `SessionStart` hook prints ONE JSON document carrying both `systemMessage` and `terminalSequence`, the
escape written as the six characters backslash-u-0-0-1-b rather than as a raw byte. That is deliberate: a
bare ESC inside a JSON string is an unescaped control character, `JSON.parse` rejects the whole document,
and a raw-byte hook would have been read as emitting no fields at all — an absence that was entirely the
rig's. Parsed here the way the host parses it, the field's first four code points are 27, 93, 57, 59 (ESC,
`]`, `9`, `;`), 26 characters in all, and `allowlistedTerminalSequence`'s own rule accepts it — with a CSI
clear-screen rejected by the same function as the negative control.

**The control PASSES and the reading FAILS, which is the row's answer.** The transcript carries
`SessionStart hook: CDP-D143-SYSTEM-SITFIVEF` as an `info` row — so the document was produced, parsed,
merged and consumed — and the OSC marker appears **nowhere** in the session's rows, tool inputs or tool
results. The host parses a documented universal field on the Pi path and drops it, which is exactly what
*"enforced host-side and driven on Pi alone"* asks about.

### Clause 3 — an `async: true` hook does NOT block the turn

| | reading |
| --- | --- |
| the turn's last message (the PRODUCT's clock) | `2026-09-18T11:03:53.961Z` |
| the async hook's own `start` stamp | `2026-09-18T11:03:53Z` |
| the async hook's own `end` stamp, 8 s later | `2026-09-18T11:04:01Z` |

**PASS.** The turn ended 8 seconds before the hook did, and the control — the hook's own two stamps on
disk — says it ran. The subject and the control are separate artefacts, so *"the hook did not block"* and
*"the hook never ran"* can never be confused.

### What this case deliberately does not answer

`asyncRewake`'s exit-2 wake. A wake is only distinguishable from a slow answer by the ABSENCE of a `user`
row before it, which is a second rig shape; putting it on this turn would have put two questions on one
measurement. Recorded as the case's own residue.

---

## 2.5 A rig fact the first three drives paid for — and half of it is a NEW finding

**The first cause is already a named and repaired row.** The first drive wedged: the Bash tool sat at
`executing` and the turn never ended (185 436 ms, `processing: true`, four messages). That is **D1.333**,
whose repair `5ba002ae6` is **NOT an ancestor of `61cfc4659`** — checked with
`git merge-base --is-ancestor`, which is the instrument the harness's own `requireArtifactCarries` section
prescribes for exactly this. `SessionManager` symbol `pluginCommandHookRunner` puts every command hook
through the permission gate; two of this fixture's three hooks carry a `>>`, the gate scores that `ask`,
and before the repair the wait settled only on a click.

**The second cause is new, and it is why the obvious remedy did not work.** `lib/ask-user.ts`'s
`approvePermissionsWhile` — the harness's standard approver, whose docblock says it is *"driven from
`Session.awaitingApprovalCount` — derived at read time from the live pending map, so it cannot go
stale"* — gates every click on that count being at least 1. **A command hook's card is not counted
there.** Measured twice on this artefact, with the card ON SCREEN and its `Allow once` button clickable
and visible:

```
[{"name":"CDP RS-86 10:59:12","awaiting":0}, {"name":"CDP RS-86 10:51:32","awaiting":0},
 {"name":"CDP RS-32 control 10:51:05","awaiting":0}, {"name":"CDP RS-32 10:50:57","awaiting":0}]
visible buttons: [... "CDP RS-86 10:59:12 Allow once Deny", "Allow once", "Deny", ...]
```

The approver never clicked and the turn wedged for 180 s and again for 300 s. **Clicked by hand at the same
moment — two `Allow once` presses — the hook ran and wrote its env dump within seconds**, which is the
positive control that separates "uncounted" from "no card at all". RS-86 therefore carries a
count-independent approver that polls the BUTTON (the surface the user has), never `Always Allow` (which
would write a durable rule into the rig's settings) and never anything inside the ask-user banner. On the
fourth drive it answered **2** cards and every clause got its reading.

The `terminalSequence` hook is the control for the whole diagnosis: it is a bare `printf` with no redirect,
it was never gated, and its `info` row arrived on the wedged drives — so *"hooks do not run on this build"*
was ruled out before the approver was touched.
## 3. The rows this sitting did NOT drive, each with its premise re-taken at HEAD

Every count names its instrument: `files` is `git grep -alIP` piped to `wc -l`, `occ` is `git grep -aohIP`
piped to `wc -l`, both with the boundary-aware `-P` form (`git grep -E` does not honour `\b` on this rig
and the miss is silent). **The positive control on the same instrument, taken in the same command:** a
fabricated symbol (`zzzNotASymbolSITFiveF`) scored `files=0 occ=0`, so a zero below is an absence rather
than a probe that cannot see.

| row | premise at HEAD | why NULL, on a rig of this shape |
| --- | --- | --- |
| `D1.41` codex hook exit codes | holds, and the FOURTH sitting to say so: `HookEventName` `files=27 occ=64`, `CODEX_ONLY_HOOK_EVENTS` `files=4 occ=14` — the twelve members and the one asymmetry are where AGENTS.md says they are | a BINARY-level rig: host-authored `[hooks.PreToolUse]` in `config.toml` plus the trust second pass, which is not a CDP case. The adjacent P6.143 shares that rig; they belong in one rig-day |
| `D1.42` `PermissionRequest` permission updates | holds: `__PERMISSION_UPDATE__` `files=3 occ=7`, `permissionRequest` `files=19 occ=25` | needs a `PermissionRequest` hook on BOTH the Pi and the claude paths issuing an update from inside it. **And RS-86 makes the cost visible:** a command hook that redirects is card-gated on this artefact (D1.333, whose repair the build predates) AND its card is uncounted by `awaitingApprovalCount`, so a hook rig on a claude card needs the count-independent approver RS-86 now carries. Drivable next sitting, on RS-86's rig, not blocked |
| `D1.44` `signalExitCode` | holds: `signalExitCode` `files=3 occ=19`, `signalEndsTurn` `files=2 occ=12`. **And the row's headline clause is already measured** — `apps/cli/src/index.ts`'s own docblock records a real `run` on the PI runtime, credential-free loopback rig: `kill -INT` → exit 130 with `[interrupted]`, `kill -TERM` → exit 143 with the turn left unfinished | the three UNMEASURED clauses are process-tree termination, the SessionEnd receipt and `--resume` on the unfinished turn — a CLI rig with a stub upstream, not a CDP case against the packaged app. The CLAUDE control is unreachable from a CLI rig by the same docblock's reading (no CLI flag creates a `claude-runtime` connection), so the row can never be three-runtime from there |
| `D1.45` agent-definition `permissionMode`/`maxTurns`/`background` | holds: `maxTurns` `files=40 occ=185`, `permissionMode` `files=263 occ=1226` | three sub-clauses with three different rigs and three controls each (a resumed `agentId` against a fabricated one; `maxTurns: 1` against the cap unset; `background: true` against the same definition without it). `fixtures/agent-surfaces.ts` writes the files, so it is a fixture sitting rather than a blocked question — and it is a SITTING, not a row this one could add to RS-86's turn |
| `D1.47` `reloadAgents` | **the premise is the finding and it REPRODUCES:** `reloadAgents` `files=0 occ=0` against `loadAgentDefinitions` `files=15 occ=52` and `WATCHED_PROJECT_DIRS` `files=3 occ=4` — no reload symbol exists, and the watcher constant is project-scope only | so the row cannot be driven as written. Re-read as *"is a mid-session agent file ever seen, per scope"* it is drivable and small (write a definition into the user `agents/` dir mid-session, dispatch it by name, with an agent written BEFORE the session as the control) — this sitting ran out of budget at that point and the shape is recorded here for the next one |
| `D1.48` `costUsd` | holds: `costUsd` `files=107 occ=462`, `total_cost_usd` `files=16 occ=69` | needs a card that PRICES a turn and a `workspaceDefaults.maxBudgetUsd` just above one turn's spend. The discriminator to establish first is whether the gateway cards report a cost at all — until they do, "the two counters disagree on the terminal turn" has no subject on this rig |
| `D1.49`, `D1.50` | — | Windows and Linux. Not drivable on this rig at all |
| `D1.51` `SEATBELT_TESTING_WILDCARD` | holds: `SEATBELT_TESTING_WILDCARD` `files=3 occ=12`, `denyWrite` `files=12 occ=58` | two independent blockers, and the row names one of them itself: the sandbox master switch is OFF by standing owner decision, and P6.330's own *"Confound, named"* clause says the Pi arm is uninterpretable until the wildcard flips, "because nothing is denied today". A source question until that decision changes |
| `D1.52` worktree-isolation refusal | holds: `worktreeGateContext` `files=10 occ=16`, `bgIsolation` `files=17 occ=147` | **drivable and NOT blocked** — a Pi session with `worktree.bgIsolation: "worktree"` written into the rig's `config.json` (a fixture write, before launch: `getUserWorktreeSettings` reads `config.worktree`), an `Edit` outside a worktree, and the refusal read as a TOOL RESULT in the transcript. Not reached: this sitting's budget went to D1.340 and D1.43's rig, and the arm needs its own relaunch because the setting is user-scope |
| `D1.53` `MAX_WEB_SEARCHES_PER_SESSION` | holds at sitting 3's corrected spelling: `MAX_WEB_SEARCHES_PER_SESSION_ENV` `files=4 occ=12` and its `_COMPAT_ENV` sibling `files=2 occ=8` | needs a session that really web-searches. Establish that the tool is reachable on the gateway Pi card before pricing its ceiling — P6.353 records claude and codex as deliberately withheld, so the row has exactly one runtime with a subject and no reading at all if that one cannot search |
| `D1.54` `jsonSchemaToZodShape` | holds, and sharper than the row states: `jsonSchemaToZodShape` `files=1 occ=3` against its sibling `jsonPropToZod` `files=2 occ=30` — one reads `schema.properties` only, the other handles the four keywords one level down | needs an MCP server whose tool schema is a root-level `anyOf`/`oneOf`/`allOf` with no sibling `properties`, on a claude card. `fixtures/mcp-naming.ts` is the tree to extend; a fixture sitting, and the heaviest of the four |

---

## 4. Where this sitting stopped

**The last measure row this lane covered is `D1.43`.** It took the ORDER's step (0) — `D1.340` — and then
one row of the measure list, because D1.43's rig cost four drives rather than one: three of them bought
the two rig facts in §2.5 and only the fourth produced readings.

The remaining list for the next sitting, in id order: **`D1.41`, `D1.42`, `D1.44`, `D1.45`, `D1.47`,
`D1.48`, `D1.51`, `D1.52`, `D1.53`, `D1.54`** — `D1.49` and `D1.50` are Windows and Linux and are not
drivable on this rig at all. §3 says what each needs, and three of them are now CHEAPER than they were
this morning:

- **`D1.42`** runs on RS-86's rig with one more hook and the count-independent approver it now carries;
- **`D1.52`** needs one fixture write (`worktree.bgIsolation: "worktree"` into `config.json` before
  launch) and one `Edit`, with the refusal read as a tool result;
- **`D1.47`** is not drivable AS WRITTEN — `reloadAgents` scores `files=0 occ=0` at HEAD, which is the
  row's own premise being the finding — but re-read as *"is a mid-session agent file ever seen, per
  scope"* it is small and unblocked.

## What ran

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-43 (proxied re-mint arm) | DA2.19 / D1.340 | **PASS 2/2**, 91 609 ms | `scripts/cdp/cases/rs-43.ts` |
| RS-43 (negative control, flag off) | D1.340 | **BLOCKED**, 1 066 ms — the branch did not fire | `scripts/cdp/cases/rs-43.ts` |
| RS-32 (rig precondition) | P6.1080 | PASS — `pi-api-key` seeded and answering | `scripts/cdp/cases/rs-32.ts` |
| RS-86 (drives 1–3) | D1.43 | wedged — the two rig facts of §2.5 | `scripts/cdp/cases/rs-86.ts` |
| RS-86 (drive 4) | D1.43 | **10 of 11**, 111 455 ms — the one FAIL is the row's answer | `scripts/cdp/cases/rs-86.ts` |

`bun scripts/bun-test-lock.ts run --label SIT-5f -- bun test ./scripts/cdp/harness.test.ts` answered
**84 pass / 0 fail across 1 FILE** with `RS-86` added. `bun run tsc -p scripts/cdp/tsconfig.json` exited 0
after every edit to this lane's files. `git diff --check` was clean before every commit.
