# 2026-09-17 — measure sitting 2 (WAVE I-2, lane WI-m) on the packaged 1.39.0

The second sitting against the `measure:` rows the runtime-parity closure deferred on 2026-09-10 and the
integrations-and-authorization plan carries as `D1.*`, plus the four dp-auth sitting rows the wave-2 plan deferred
here (`DA2.26`–`DA2.29`) and two XS rig rows (`D1.210`, `D1.192`).

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.39.0**, built by the controller from `b1f4f279c`.
Never rebuilt, never removed.

**Rig.** Port **9229** (9228 was sitting 1's); `NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad
(`rig-a`), created for the run and never under `~`. The owner's profile was never launched; `dp auth login` / `logout`
were never run; no token was read, printed or committed. The app was launched with `NESSY_DEBUG=1` and
`NESSY_PROXY_AUTH_DEBUG=1`. Every BYO card carried a fabricated `sk-cdp-<32 hex>` key. Every process this sitting
started was killed at exit.

**The rig precondition.** `RS-32` **PASS 8/8** in 27 s on the fresh profile: the one-click Pi card is seeded with
`tgpt/deepseek-v4-flash-0731` (the `coder` alias), its first turn answers `ready`, and the retired-id control still
shows the host substituting the live id before the call.

---

## 0. Two rig facts this sitting paid for, and one of sitting 1's is refuted

**The codex one-click card DOES answer to `/Codex agent/i` on this build.** Sitting 1's hand-off said it did not. The
label is *"Nessy · Codex agent Coding agent on the same gateway. One-click sign-in."* and it matches. What failed was
the LOOP: a helper that pressed the Claude card and then looked for the Codex one reported *"no card button"*, because
the first card's own dialog was still up and `Add Connection` was never re-reached. Pressed on its own — Escape first,
then re-enter the settings route — it creates `codex-gateway` on the first try. The label was blamed for the
navigation.

**A stale "Trust this project?" dialog blocks the composer for every later session, and cannot be answered once its
directory is gone.** `RS-51`'s first drive failed at `composer-not-focusable`, leaving the gate up; the case's own
`finally` then removed the repository the gate was asking about. The second drive met that dialog, which by then read
*"Could not update project trust."* under the heading, clicked Trust for a directory that no longer existed, and
reported `trust-dialog-did-not-close`. Both readings look exactly like product defects and neither is one. `rs-51.ts`
now dismisses any stale gate before it binds anything, and a relaunch clears the renderer's own copy.

---

## 1. DA2.26 — RS-39's 1.39.0 FAIL is an INSTRUMENT defect (case `RS-50`, **PASS 12/12**)

RS-39 recorded 6 of 12 on this build: the transcript carried one `user` row with the typed `/quota` and no non-user row
in 45 s. DA1.57 had already proved the agent-layer dispatch works, so the row asks which of three things the packaged
silence is — the preamble before `agent.chat()`, the composer's handling of the typed form, or the anchored pattern.

**The control the row ordered, and it settles the first candidate.** One ordinary turn per card, under RS-39's own
45 s budget, reaches the model on all three:

| card | ms to an assistant row |
| --- | --- |
| `claude-gateway` | 12 751 |
| `codex-gateway` | 6 704 |
| `pi-api-key` | 2 728 |

So the turn path is not the cause, and no reading below is about a session that never reached a runtime.

**The second instrument is what actually answers the row.** Sitting 1 measured that a command the host CONSUMES —
`/help`, `/status` — leaves no row in `getSessionMessages` at all while its answer is on screen. RS-39's detector is
`getSessionMessages`. Adding the screen, as a per-arm common-prefix DELTA (the pane accumulates, so a tail read lets a
later arm pass on an earlier arm's answer — this case's own first drive did exactly that):

| card | form | store | screen | ms to the screen clause |
| --- | --- | --- | --- | --- |
| `claude-gateway` | `/quota` | — | refusal **and** `Nessy Gateway limit` | 4 030 |
| `claude-gateway` | `/quota ` | — | refusal **and** the pointer | 551 |
| `codex-gateway` | `/quota` | — | refusal **and** the pointer | 28 484 |
| `codex-gateway` | `/quota ` | — | refusal **and** the pointer | 1 945 |
| `pi-api-key` | `/quota` | — | `Quota:` (its own content) | 549 |
| `pi-api-key` | `/quota ` | — | `Quota:` | 543 |

`msToStoreRow` is **null** on all six. So **the pointer is reachable and RS-39's FAIL is the detector**: DA1.17
option B's sentence is on screen on both gateway cards, and `getSessionMessages` does not carry it — the same seam
sitting 1 found for `/help`.

**One premise of the row is refuted in passing, and measured rather than read.** DA2.26 says `/quota ` with a trailing
space *"is prose by design"* because `QUOTA_PATTERN` is anchored. `parseSessionCommand` does `const trimmed =
input.trim()` before testing any pattern, so the space is trimmed and `/quota ` IS the command — confirmed live, with
the composer's submitted string recorded as `"/quota "`: no assistant row, answer on screen, identical to `/quota`.
The form that really is prose is a trailing WORD: `/quota now` reached the model on all three cards.

---

## 2. DA2.27 — the codex `COMPANY_LLM_API_KEY` arm, driven at last

DA2.13 recorded *"codex NOT REACHABLE"*, measured over a name list that could not see this name. `RS-16` carries it
now (`PROVIDER_KEY_ENV_NAMES`), and it was driven on a `codex-runtime` BYO card pointed at the credential-free
loopback stub (`scripts/cdp/fixtures/stub-upstream.ts`):

| arm | `namesReportedPresent` | length |
| --- | --- | --- |
| `codex-custom` (BYO at the stub) | `COMPANY_LLM_API_KEY` | **8** |
| `codex-gateway` (one-click), separate run | `COMPANY_LLM_API_KEY` | **8** |
| **the negative control, SAME run as the first** — `pi-api-key` | `[]` | — |

Every control held in both runs: a shell ran in both arms, 9 `NAME=<length>` lines parsed in each, and the
fabricated variable reported absent.

**Eight characters is `loopback`.** `packages/shared/src/agent/codex-agent.ts` spawns the app-server with
`[CODEX_API_KEY_ENV]: 'loopback'`, and the comment above that spawn already says the adapter ignores it either way. So
the NAME is reachable from a codex agent's own shell on every codex card — DA2.13's verdict is refuted — and what is
reachable is the host's own placeholder rather than anyone's credential. A reader who takes `reachable` without the
length has the wrong finding, which is exactly why `lengthsOfNamesPresent` travels beside the verdict.

---

## 3. DA2.28 and DA2.29 — two recipe repairs

**DA2.28.** `rs-40.ts`'s detector reads `<config dir>/logs/runtime/<sessionId>-pi.txt`, and that file takes TWO
levers: `NESSY_PROXY_AUTH_DEBUG=1` writes the `upstream auth:` line, and `NESSY_DEBUG=1` is what creates the directory
at all. Verified at HEAD: `pi-agent.ts` opens it through `openSessionRuntimeDebugLog('pi', sessionId, hostDebug)` and
`hostDebug` is `process.argv.includes('--debug') || process.env.NESSY_DEBUG === '1'`, nothing else. The recipe named
only the first, so the arm failed while its own message told the reader to check the variable that WAS set. Both are
now in the docblock, the credentials note, the manual steps, the detector line, and the empty-schemes failure message,
which lists the three causes in the order to check them. `rs-41.ts` names `NESSY_DEBUG` already, for its own purpose
(the app's captured output), and needed no change.

**DA2.29.** `RS-16`'s single `verdict` object read `{ byo, gateway }` while the run produced a third answer
(`DA2.21 — verdict`). `directAnthropicArm` now RETURNS its verdict and the key is spread in only when the arm ran, so
a reader can tell *did not run* from *ran and found nothing* by the key's absence rather than by its value.

---

## 4. D1.21 — claude's own `EnterWorktree` FIRES, and what it produces is HOST-owned (case `RS-51`, **PASS**)

**First, the row's own quotation is stale, and reading the ledger BEFORE writing the headline is what caught it.**
D1.21 says *"Ledger I2/claude (`absent ᵗ`)"*. At HEAD `I2` reads `covered ᵗ` | `covered ᵗ` | `absent ᵗ` over
Pi | Claude | Codex — the `absent ᵗ` is the CODEX cell, and the claude cell has said `covered ᵗ` since C3.251, whose
own text records that RS-28 arm A already drove `EnterWorktree` on a claude card at the packaged 1.36.0 sitting and
the tool succeeded. So *"the capability is live and I2/claude is refuted"* would have been this sitting's second
over-claim of the evening, and it is corrected here rather than shipped.

What this case adds is therefore three things, none of them the headline the row expected: a re-take on the packaged
**1.39.0** (the ledger's reading is 1.36.0), the containment half the cell does not carry, and one open question the
cell's own verbatim quotation raises.

The premise was re-taken first: `CLAUDE_SESSION_DISALLOWED_TOOLS` holds exactly five names — `EnterPlanMode`,
`ExitPlanMode`, `Skill`, `Monitor`, `ScheduleWakeup` — and neither worktree built-in is among them. (The cell's own
2026-09-11 note says that list held three; it holds five at HEAD, and subtracts neither built-in either way.)

**The artefact.** Occurrences over the packaged `claude` (instrument named: `grep -aoF … | wc -l`, occurrences and not
lines): `EnterWorktree` **39**, `ExitWorktree` **20**, `ExitPlanMode` **29** (the positive control), a fabricated name
**0**.

**The drive, on a `claude-gateway` session bound to a git repository the case mints under the OS temp dir.** The row's
recipe does not say the rig needs a repository; without one `EnterWorktree` fails for want of one and the case would
score the built-in absent against a rig that gave it nothing to work with.

| arm | reading |
| --- | --- |
| **THE CONTROL** — a built-in named in no pi-only list | one `Bash` tool row. Deliberately NOT `TaskCreate`, which sits in the very pi-only list under test |
| the subject | one **`EnterWorktree`** tool row, and the assistant naming the directory it moved into |
| `git worktree list --porcelain` inside the probe repository | two entries: the checkout, and the new worktree |

So the capability is **live on the packaged 1.39.0**, which is a re-take of the ledger's 1.36.0 reading rather than a
refutation of it. The cell's marker is `ᵗ`; a driven re-take supports `ʳ`, and that is the only verdict movement this
arm justifies.

**Arm 3 — and the drive refuted the source reading the arm was written from.** The arm was designed around P6.20's
no-lease/no-sweep fear plus the fact that `worktreeLeaseId` occurs only in `pi-agent-server/src/orchestrator` and
`packages/core/src/types/pi-harness-runtime.ts`, on no claude path. Measured, the worktree landed at

```
<tmp>/.nessy-worktrees/nessy-rs51-repo-<slug>/worktree-<name>
```

— Nessy's OWN worktree root, which `packages/server-core/src/pi-harness/isolation/shared-git.ts` names in those
words. P2.458 installs `withClaudeWorktreeHooks` over the merged SDK hook map and binds `claudeWorktreePort` on every
`anthropic` session, so the SDK's `WorktreeCreate` is answered by the HOST; the comment at that call site records the
other branch verbatim — with the port absent *"the binary keeps creating worktrees with `git worktree`"*.

**The discriminator needs no source reading at all, which is why the case now checks it:** `.nessy-worktrees` occurs
**0** times in the packaged SDK binary, on the same instrument as the counts above, and does occur in our tree. The
root a worktree appears under therefore names which side created it, and the case asserts every created worktree is
under the host's.

**And the open question the cell's own quotation raises.** `I2` quotes `worktrees.md#ask-claude-to-create-a-worktree`
verbatim: *"When Claude enters a path outside the repository's `.claude/worktrees/` directory, Claude Code asks for
your approval first … only `bypassPermissions` mode skips it."* The worktree this run produced is at
`<tmp>/.nessy-worktrees/…`, which is not the repository's `.claude/worktrees/`, the session's resolved permission
mode was `auto`, and `awaitingApprovalCount` stayed **0** across both runs. The likely explanation is structural
rather than a defect — the host's `WorktreeCreate` hook answers the request, so the SDK's own prompt may never be the
one in the path, which is the NOT-ROUTED finding the cell already records one road up — but nothing measured says so,
and *"the documented non-suppressible approval did not appear"* deserves to be written down rather than assumed away.

**The rest of the residue is one thing, not two.** `sdkCwd` did not move while the child reported working inside the
worktree —
and that is by design, not a divergence: `SessionManager`'s own field comment reads *"SDK cwd for session storage -
set once at creation, never changes. Ensures SDK can find session transcripts regardless of workingDirectory
changes."* Calling it a divergence would have been this sitting's own wrong finding. What is open is
`awaitingApprovalCount`, which stayed **0**: nothing asked the person before a worktree and a branch were created on
the model's word, in `auto` mode. Recorded, not asserted — whether a card is owed there is a product posture.

---

## 5. D1.35 — ALREADY MEASURED AND DECIDED at HEAD, by a row that names it

`D1.35` asks for `sandbox_private_desktop`'s effective value read back under our managed `CODEX_HOME` in each of the
seven permission modes, with claude's absence carrying a positive control. That is done:
`packages/codex-responses-adapter/src/__tests__/config-writer-windows-block-decision.test.ts` is C3.16, its docblock
names `D1.35` and ledger `A71` in its first line, and it drives the shipped `codex-app-server` through `config/read`
once per arm — seven permission modes plus the sandbox master switch off, all `null`, against a CONTROL arm that adds
`[windows] sandbox_private_desktop = false` and gets it published back attributed to our layer. The block is
deliberately not written, for four recorded reasons, and the file carries the tripwire that reddens if upstream stops
defaulting it to `true`.

A tree sweep for each of the fifteen batch-2 rows found **only** this one named anywhere under `packages/`, `apps/` or
`scripts/` — the other fourteen are untouched, so D1.35 is the single already-closed row of the batch.

---

## 6. D1.38 — re-taken on 1.39.0 through the case that already exists (`RS-36`)

`D1.38` (source `P6.285`) is denominators F39 and F40 — do session grants survive a fork, and does in-flight
background work report into the branch or the parent. `RS-36` already drives exactly that rig; its checklist row
belongs to `C5.29`, so what follows is a READING handed back for `D1.38` rather than a case of its own. Run on this
profile with `NESSY_CDP_BRANCH_RUNTIMES` at its default (`claude,codex`), 13 of 16 checks:

| runtime | clause | verdict |
| --- | --- | --- |
| claude | **F39, grants** | **the grant does NOT travel.** The branch asks again EVEN THOUGH the repository rule the card promised was already on disk in the branch's own working directory. Both controls stand: `grantTook: true` in the parent, and the branch's gate is alive (a never-granted command still asks) |
| claude | **F40, in-flight** | **BOTH sessions received it** — the marker landed in the parent AND in the branch |
| codex | **F39, grants** | **VOID, and the case says so rather than banking it.** The parent's gate asked for NOTHING (`parentAsked: false`) on a session whose resolved mode is `default`, so there was no grant to take; `branchGateAlive: false` confirms the branch asks for nothing either. Two arms that agree for the wrong reason, caught by the control |
| codex | **F40, in-flight** | **BOTH sessions received it** |

**And the headline of this section has to be qualified, because the ledger got there first.** The `F40` row already
carries the claude arm — *"the parent's Always Allow wrote one `Bash` rule into the project's local settings file …
and the branch ASKED AGAIN"* — and the Pi arm, both from C5.29 on the packaged 1.36.0 (2026-09-12, R7), along with
the codex VOID and its reason. So what this run ADDS is not a new verdict: it is the same reading re-taken on the
packaged **1.39.0**, agreeing on all four cells. That is worth having — the claude arm is the one a lift could move,
and the ledger's cell is dated to a build two releases old — but *"D1.38 is answered by RS-36"* would over-claim it,
and the row's residue is what the F40 cell does not cover: the F39 denominator in its own right, and codex's grant
clause, which is VOID on the rig rather than measured.

The reading that transfers regardless of the date: the durable rule IS on disk in the branch's own working directory
and the branch asks anyway, so the question is not *"is the rule there"* but *"does the branch consult it"*. And the
in-flight clause answers the same way on both runtimes — a completion reported into TWO conversations.

The codex VOID is a rig reading and not a product verdict: a codex session in `default` mode ran a never-granted
`Bash` command unasked on this profile. Whether that is the codex approval policy, the sandbox notice this sitting saw
on every codex turn (`codex-sandbox-egress-denied: sandbox_mode="workspace-write"`), or something else is not settled
here.

---

## 7. D1.26's codex half — answered from the shipped catalogue

`P6.162`'s rule is explicit: scan a codex-servable catalogue for any model whose synced `contextWindow` is
`1_000_000`; NONE makes the `K3-codex` cell `n/a ᵏ` and the residue purely K3-host's copy, ANY makes it a real
`absent`. Read through the app's own `listLlmConnections()` on this profile:

| card | model | `shortName` | `contextWindow` |
| --- | --- | --- | --- |
| `pi-api-key` | `tgpt/deepseek-v4-flash-0731` | `coder` | 524 000 |
| `pi-api-key` | `tgpt/qwen36-35b-a3b-fp8` | `fast` | 262 000 |
| `claude-gateway` | the same two | `coder` / `fast` | 524 000 / 262 000 |
| `codex-gateway` | the same two | `coder` / `fast` | 524 000 / 262 000 |
| `codex-custom` (BYO at the stub) | `stub-model` | — | none published |

**Seven rows, six carrying a window, ZERO at 1 000 000.** The six are the positive control that the probe can read
the field at all; the seventh is a bare string, which is the null case and is reported rather than counted. So on the
shipped cards the answer is NONE, and `K3-codex` is `n/a ᵏ` — with the honest qualification that a BYO card's
catalogue is whatever the operator points at, and this sitting drove one such card whose upstream publishes no window.

Two source facts were re-taken beside it. `enable1MContext` over `packages/codex-responses-adapter` plus
`codex-agent.ts` is still **0**, as the row says. The row's own control, `getEnable1MContext` in
`packages/shared/src/config/storage.ts`, is **1** hit and not the 2 recorded — a number that moved, not a claim that
changed.

**And a precondition for the next sitting, cleared here:** P6.163's RIG HAZARD is that the SEEDED card's short names
are *"Qwen Coder"* / *"Qwen Fast"* until the catalogue refresh maps the API `alias` field onto `shortName`, so a
`D1.27` arm run before that refresh measures a false negative. On this profile the refresh has happened — `fast` and
`coder` are the short names above — so `resolveGatewayFastModelId` has something to match and D1.27 can be driven
here without waiting.

---

## 8. The rows this sitting did NOT reach, each with its premise re-taken at HEAD

Recorded as NULLs rather than left implied. Where a re-take moved something it is said so.

| row | premise at HEAD | why NULL |
| --- | --- | --- |
| `D1.22` `ENABLE_TOOL_SEARCH` | **one clause REFUTED.** The row says `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` — which the page says wins over the override — *"is written nowhere under `packages/` or `apps/`"*. At HEAD it is written: `claude-agent.ts` (2) and `options.ts` (1). The `NESSY_ENABLE_TOOL_SEARCH` surface has also grown its own managed-origin row (`D1.36`) since | forcing `true` into the child is not a rig lever: our own options write the name, so an ambient value does not survive. The arm needs a managed-env block or a code change, which is a build rather than a sitting |
| `D1.23` codex `preToolUse` | holds: `HookEventName` carries twelve events including `preToolUse`; `HookRunStatus` `"blocked"` and `HookOutputEntryKind` `"stop"` are still there | a BINARY-level rig (host-authored `[hooks.PreToolUse]` plus the `[hooks.state."<key>"]` trust second pass — write, boot, `hooks/list`, write), not a CDP case. It is a sitting of its own, and the row cites `rust-v0.148.0` against a shipped `0.154.0` |
| `D1.24` codex→claude MCP resources | holds: `runtime-switch-costs.ts` still says the `resources/list` question *"is unmeasured and needs a live packaged run"* | needs MCP-R1 arm 1 with a leased source advertising resources, registered as `{type:'sdk',…}`. Not built this sitting |
| `D1.26` extended context (the PI half only — the codex half is §7 above) | **one number moved:** the row's control `getEnable1MContext` is **1** hit in `config/storage.ts`, not 2. The decisive command still answers as the row says: `enable1MContext` over `packages/codex-responses-adapter` + `codex-agent.ts` → **0** | the codex half wants a catalogue scan for any servable model at `contextWindow === 1_000_000`; the gateway's two rows are 524 000 and 262 000, so the answer is *none* on the shipped card, but a BYO card's catalogue is whatever the operator points at and this sitting drove none. The Pi half needs an ANTHROPIC-WIRE Pi connection — the gateway card is OpenAI-wire, so `anthropic-beta` is not on that path at all, and the loopback stub is OpenAI-wire too |
| `D1.27` the `small` tier on Pi | holds: `spawner.ts` still reads `cfg.tierModelMap?.[agentDef.tier] ?? cfg.modelId`, and `resolveGatewayFastModelId` still matches `shortName === 'fast'` | needs two Pi sessions (one on a refreshed gateway catalogue, one on a BYO card with no `fast` alias) and a `scout`/`planner` dispatch each, read off the spawner debug line. The most valuable undriven row of the batch: `K7-pi`'s `covered ˢ` is a propagated claim and likely demotes |
| `D1.28` skill-listing keys | holds: both keys are declared once each in `sdk.d.ts` at `claudeCodeVersion` **2.1.251** | needs a user `settings.json` carrying values far from the documented default plus the absent-key control. The expected result is a dead control, which is exactly why it must be measured; not reached |
| `D1.29` claude `PushNotification` | holds: `grep -ac PushNotification claude-agent.ts` → **0**, so the tool is not disallowed | the delivery half needs an OS notification observed, which this headless rig cannot see; the advertisement half is a transcript read and was not driven |
| `D1.30` the judge's fourth tier | holds, at a corrected path: the four-tier sentence is in `packages/shared/src/prompts/guardian.ts` (*"hard deny (unconditional), soft deny (user intent or an allow entry can clear these), allow …"*), and `trustedIntent` is 3 hits there — the row cites `prompts/guardian.ts` without the `shared/src` prefix | needs the guardian driven twice over one `soft_deny`-matching action with a `hard_deny` control in both arms, and a compliance RATE rather than a single pass. A sitting of its own |
| `D1.31` symlink pair + re-check | holds: the rule and its comment are at `permission-dsl.ts` (*"Symlink-pair asymmetry (permissions.md): allow needs the symlink…"*) | needs a link swapped BETWEEN the permission decision and the open, driven once per runtime — a TOCTOU rig, not reached |
| `D1.32` `requiresUserInteraction` | holds: **15** tracked files carry the name | needs an MCP server declaring `_meta['anthropic/requiresUserInteraction']` on one tool and a sibling without it, driven in `dontAsk` and `bypassPermissions` per runtime |
| `D1.33` worktree approval propagation | holds: `persistBashAlwaysAllowRule` is 2 hits in `SessionManager.ts` | needs an approval inside a worktree then read from the main checkout and a second worktree, plus the removal arm. RS-51 has the worktree half of the rig now, which makes this the cheapest of the remaining rows |
| `D1.34` mid-turn `addDirectories` | holds: `addDirectories` is in `sdk.d.ts` and `buildClaudeAdditionalDirectoriesOptions` is 2 hits in `claude-agent.ts` | not drivable as a sitting at all: it needs `canUseTool` to RETURN `{type:'addDirectories',destination:'session'}` mid-turn, which is a code change |
| `D1.38` what a branch inherits | holds: `forkSession` 6 hits in `claude-agent.ts`, `thread/fork` 30 in `codex-agent.ts` | **PARTLY answered — §6 above.** `RS-36` was re-run on 1.39.0 and AGREES with the ledger's existing `F40` cells (taken on 1.36.0), so the claude arm is confirmed on the shipped build rather than newly measured. Still open: the F39 denominator in its own right, and codex's grant clause, which is VOID on this rig for the reason the ledger already records |

---

## What ran

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-32 (rig precondition) | P6.1080 | **PASS 8/8** — 1.39.0, port 9229, 27 s | `scripts/cdp/cases/rs-32.ts` |
| RS-50 | DA2.26 | **PASS 12/12** | `scripts/cdp/cases/rs-50.ts` |
| RS-16 (two runs, existing case) | DA2.27 | **the codex arm driven**, with the Pi negative control in one of them | `scripts/cdp/cases/rs-16.ts` |
| RS-51 | D1.21 | **PASS**, twice with agreeing results (the second on the committed bytes) | `scripts/cdp/cases/rs-51.ts` |
| RS-36 (existing case, row `C5.29`) | read back for D1.38 | **13 of 16** — claude answers both clauses, codex's grant clause is VOID with its cause named | `scripts/cdp/cases/rs-36.ts` |
| a catalogue read through `listLlmConnections()` | D1.26's codex half | **zero models at 1 000 000**, six of seven carrying a window as the control | not a case — §7 |

`bun test ./scripts/cdp/harness.test.ts` green after every case file. `bun run tsc -p scripts/cdp/tsconfig.json`
exit 0 after every edit. `git diff --check` clean. Processes at exit: none, port 9229 free.
