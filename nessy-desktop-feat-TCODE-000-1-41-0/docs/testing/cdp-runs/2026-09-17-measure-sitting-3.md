# 2026-09-17 — measure sitting 3 (WAVE I-3, lane WI-u) on the packaged 1.39.0

The third sitting against the `measure:` rows the runtime-parity closure deferred on 2026-09-10 and the
integrations-and-authorization plan carries as `D1.*`, plus the four XS rig rows that wave asked this lane to build
(`D1.229`, `D1.113`, `D1.143`, `D1.158`).

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.39.0**, built by the controller from `b1f4f279c`.
Never rebuilt, never removed.

**Rig.** Port **9230** (9226 was the release sitting's, 9228 and 9229 sittings 1 and 2); `NESSY_CONFIG_DIR` and
`--user-data-dir` under this lane's scratchpad (`rig-a`, then `rig-b`), created for the run and never under `~`. The
owner's profile was never launched; `dp auth login` / `logout` were never run; no token was read, printed or
committed. `NESSY_DEBUG=1` and `NESSY_PROXY_AUTH_DEBUG=1` on every launch.

**The rig precondition.** `RS-32` **PASS 8/8** twice — once on `rig-a` (76 s, load 8.64) and again on the clean
`rig-b` — the one-click Pi card seeding `tgpt/deepseek-v4-flash-0731` (the `coder` alias), its first turn answering
`ready`, and the retired-id control still showing the host substituting the live id before the call.

---

## 0. THE RIG FACT THIS SITTING PAID FOR, and it is worth more than the row that found it

**A sitting lane is a Claude Code agent, and that agent's own shell exports names THIS PRODUCT READS. A bare `exec`
of the packaged binary hands every one of them to the app.** Nothing anywhere said so, and the reading it produces
looks exactly like a product finding.

It was found by D1.27's first drive. On the gateway Pi card, a `scout` dispatch — the `small` tier, the very thing the
row is about — produced a child whose `piChildRestrictions.model` was **`opus`**: not a model this gateway serves, not
a model named anywhere in the profile, and not a model the parent asked for. The parent's own tool call is in the
transcript and carries no model parameter at all: `{"agent":"scout","task":"What is 2+2?"}`. The cause was in the
lane's environment:

```
CLAUDE_CODE_SUBAGENT_MODEL=opus
CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1
```

`CLAUDE_CODE_SUBAGENT_MODEL` is read by the Pi spawner (`spawner.ts`, and its own tests name it), and the FORCE flag
restores the pre-`2.1.251` precedence in which the variable outranks the per-invocation parameter, the frontmatter AND
the tier map. So every child on that rig resolved to `opus`, the tier map never entered the resolution, and D1.27's
answer would have been a reading about a shell.

**And it is invisible in the transcript.** The child's own stored `model` had already been substituted back to the
session model by `resolveModelForProvider`, which clears a model the catalogue does not list. Only
`piChildRestrictions.model` in the child's session record carried the contaminated value. The two fields agree in
every clean arm measured since, and disagreed only under contamination — which is why the case records both.

**It is thirteen names, not one.** The lane's environment was intersected with what the product reads rather than
guessed at by prefix:

```sh
env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
  while read -r n; do c=$(git grep -ac "$n" -- packages apps | wc -l); [ "$c" != 0 ] && echo "$n -> $c file(s)"; done
```

Thirteen of a 31-name candidate set scored non-zero, and the four that move a measurement outright are
`CLAUDE_CODE_SUBAGENT_MODEL` (14 files), `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` (11), `CLAUDE_EFFORT=xhigh` (19 — which is
AGT-5's entire subject) and `ANTHROPIC_BASE_URL` (51). `MCP_CONNECTION_NONBLOCKING=true` (RS-06's subject),
`CLAUDECODE=1` and `DISABLE_AUTOUPDATER=1` were also inherited. **Every sitting run on this rig before tonight
launched the app with all of them**, so any reading any sitting took about a subagent's model, a reasoning effort or
an MCP connect posture carries this confound.

**The instrument is the APP, never this process.** `ps eww -p <pid>` prints a process's own environment on macOS, so
the app is asked about itself; the case process is a proxy at best, since a case can be run from a different shell
minutes later. `scripts/cdp/lib/app-env.ts` is that reader. It reports **names and value LENGTHS, never values** —
two of the thirteen are credentials by construction — and its **positive control is `NESSY_CONFIG_DIR` in the same
read**: "no contaminating name is present" is equally true of a read that returned nothing, so without the control the
clean verdict is unfalsifiable. Every case this sitting wrote BLOCKS on it.

Verified after the relaunch, on all four `Nessy Desktop` processes: none of the six carries any of the names, and
`NESSY_CONFIG_DIR` reads back as `rig-b` on each.

**The launcher, for the next sitting.** `env -u <NAME> … "<app>/Contents/MacOS/Nessy Desktop" --remote-debugging-port=…`
— deleted, not overwritten (AGENTS.md's own Bun-env trap is about the other direction, and the rule that survives is
*delete first*) — and then read `ps eww` before believing it.

---

## 1. D1.27 — the Pi `small` tier is REAL and CONDITIONAL on the `fast` alias (case `RS-52`, **PASS 17/17**)

`SessionManager` defaults the Pi orchestrator's `small` tier to the gateway's cheap model *"when its catalog exposes
the Nessy Gateway `fast` alias"*, resolving through `resolveGatewayFastModelId`; `medium` and `big` stay unset. The
row asks whether that is really covered on Pi, or covered on one tier of one connection family.

**The two arms are the SAME card.** The row's recipe proposed a gateway card and a BYO card, which differ in the
endpoint, the credential, the catalogue AND the alias — four things. This case varies one: it drives the card, then
strips the `fast` `shortName` from its stored catalogue through the app's own `saveLlmConnection`, and restores the
original models array in a verified `finally` that reads the catalogue back.

| arm | agent | tier | catalogue | `piChildRestrictions.model` |
| --- | --- | --- | --- | --- |
| A | `scout` | `small` | alias present | **`tgpt/qwen36-35b-a3b-fp8`** — the `fast` id |
| A control | `planner` | `medium` | alias present | `tgpt/deepseek-v4-flash-0731` — the session model |
| B | `scout` | `small` | alias **stripped** | `tgpt/deepseek-v4-flash-0731` — the session model |
| B control | `planner` | `medium` | alias stripped | the session model |

The discriminator is its own check: the two `small` arms must DIFFER, or the alias changed nothing and the tier map
does nothing on this build. They differ. The `medium` control holds in both arms, which is what separates "the tier
map works" from "everything inherits".

**So the capability is delivered, and it is delivered on a CONDITION the cell has to carry**: a Pi connection whose
catalogue publishes no `fast` alias — which is every BYO Pi card — silently gets the session model for the `small`
tier, with no notice anywhere. `K7-pi` should read `covered ʳ` with that condition named rather than `covered ˢ`
unqualified; the honest demotion is of the CLAIM's scope, not of the capability.

**Two readings beside it.** `piChildRestrictions.model` and the child's own stored `model` AGREE in all four clean
arms — they parted company only under the §0 contamination, which is the evidence that the contamination was real and
that reading only the stored model would have hidden it. And P6.163's rig hazard is cleared and kept: on a freshly
seeded profile the short names are the display names until the startup refresh maps the API `alias` field onto them,
so the case BLOCKS rather than scoring a false negative when no model's `shortName` is `fast`.

---

## 2. D1.235 — RS-51's open question: the worktree approval is **NOT ROUTED** (case `RS-53`, **PASS**)

RS-51 saw `EnterWorktree` create a worktree outside the repository's `.claude/worktrees/` in `auto` mode with
`awaitingApprovalCount` at **0**, against a page that calls that approval non-suppressible outside
`bypassPermissions`. Three readings fitted and RS-51 could not separate them: routed and suppressed by `auto`; routed
and swallowed; or not owed, because the host answers `WorktreeCreate` itself (P2.458).

Driven in `default` — the mode whose whole job is to ask — same session, same mode, at load 9.64:

| turn | what it is | approvals |
| --- | --- | --- |
| CONTROL-1 | a plain `echo`, an ordinary shell command | **0** — and it ran |
| CONTROL-2 | an EDIT inside the workspace | **1** |
| SUBJECT | a worktree created under the host's own root | **0** |

**Reading 1 is dead.** The documented approval is not reaching the host card at all, and the residue is
swallowed-or-not-owed — with the host answering `WorktreeCreate` itself the explanation that needs no defect.

**The control is a LADDER, and its first rung is a finding rather than a failure.** A plain `echo` in `default` mode
on a `claude-gateway` session raises nothing and runs. That is the same shape sitting 2 recorded for codex — *"a codex
session in `default` mode ran a never-granted `Bash` command unasked on this profile"* — now measured on claude. The
rung is kept and reported rather than replaced by the one that works. A third rung, a write OUTSIDE the workspace,
sits below the edit for a measured reason: it raised no card AND wrote no file, which is a DENY rather than an ask, so
it cannot prove a card mechanism alive.

**The first drive reported UNAVAILABLE rather than an answer**, because its only control was the `echo` and the `echo`
had not asked. Scoring the subject's zero against a control that never asked would have been this sitting's wrong
finding, and the case is built so that it cannot.

---

## 3. D1.33 — an Always Allow granted inside a worktree, and where the rule lands (case `RS-54`, **PASS**)

P6.216 recorded the behaviour as delivered and unrowed from the source alone. Driven, at load 8.67, with the grant
issued from inside a worktree the PRODUCT created:

| reading | value |
| --- | --- |
| the main checkout's `.claude/settings.local.json` | `["Bash(touch *)"]` |
| a SECOND worktree, made before the grant | its own git metadata resolves to the MAIN checkout, and reads the same rule |
| after `git worktree remove --force` | the rule is still there |
| **THE CONTROL** — an EDIT approval, 1 card answered | the allow list does not move |

So the propagation clause and BOTH residues the row calls unmeasured — a non-Bash approval staying session-scoped, and
the rule outliving the worktree that produced it — are measured rather than read.

**Two things the first two drives paid for.**

**The obvious "risky enough to raise a card" spellings are exactly the ones this row cannot use.** `curl` raised a
card, Always Allow was offered and pressed, the card cleared, and NOTHING was written. That is correct:
`persistBashAlwaysAllowRule` returns early for a base command in `DANGEROUS_COMMANDS`, which holds `curl`, `chmod`,
`rm`, `mv`, `cp`, `ssh` and `git push`. The ladder needs a command gated by the CARD and not by the persister, and
`touch` is one.

**A worktree does not contain the main checkout's `.claude/`.** Reading the sibling worktree's own directory answers
`undefined` even when propagation works perfectly, and the second drive scored that as a FAIL against a product that
was right. What the claim means is that a session started in the sibling resolves its settings root back to the main
checkout, and that walk is RESTATED with git's own `rev-parse --git-common-dir` rather than imported — this harness
restates what it asserts, and a reader derived from the module under test would agree with it whatever it said. The
arm also refuses to pass on two empties agreeing.

---

## 4. D1.183 — the protected-FILE write on codex: the claim is REFUTED (case `RS-55`, **PASS**)

`protectedFilesUnprojected` (C4.49) says a write to one of the protected FILE names lands on codex with **no card**.
It was DERIVED — P2.197's approval measurement plus a projection reading — and no packaged build had ever been asked.

Driven in `default` mode, in a scratch workspace, twice, minutes apart:

| card | card raised | `.npmrc` on disk afterwards |
| --- | --- | --- |
| `codex-gateway` | **0** | **no** |
| `claude-gateway` (the control) | **0** | no |

**Codex did not write it and did not ask: the FILE rule DENIED it.** Its own account names the rule — *"there's a
permission denial for `.npmrc` globs in the workspace"* — and the first drive quoted the shell: `zsh:1: operation not
permitted: .npmrc`. That is exactly the outcome the claim's own derivation warned about, in so many words: *"a
projected entry is `read`, and `FileSystemAccessMode` is exactly `read | write | deny`, so a projection buys a
REFUSAL where this row's copy promises a prompt."* The projection has landed, and the codex cell no longer reads
*"protected FILE is written here without a card"*.

**The detector is the PAIR**, and both halves are facts the model cannot narrate: the session's own
`awaitingApprovalCount` and whether the file exists. The `refusedBy` classifier that names WHICH rule refused is
prose, and the case's own docblock says so: measured across the two drives, the claude arm classified `directory`
once and `file` once **on the same rig and the same workspace** — the model's wording moved, the outcome did not. So
it is a hint beside the detector and never the finding, and the subject arm is readable on its own, because a DENY
refutes the claim as squarely as a card would.

**The control was VOID on the first drive and the case said so.** Claude met the DIRECTORY rule on the scratch
workspace (*"File is in a directory that is denied by your permission settings"*) before the file name could matter,
so that arm never reached the protected-FILE floor. What is missing from this run is therefore the cross-runtime
DIFFERENCE the claim is about; the codex verdict stands on its own.

---

## 5. The four rig rows

**D1.229 — a case's quoted copy against the live locale.** `cru-4.ts` quotes three user-visible strings verbatim on
purpose; the cost was that a copy edit landing without a table update failed the CASE, on a live rig, against text
that was correct — twice on the same string. The case now exports `QUOTED_COPY` and `harness.test.ts` globs the
directory for that export, so a future case opts in with one line. **The guard is written around the flat-key trap
it exists to prevent:** the locale JSONs hold literal dotted keys, so a dot-path walk resolves every key to
`undefined` and reports drift on six correct strings — the very failure, reproduced inside the guard. The reader is
`live[key]`, and a key NO table quotes is resolved in the same test as the positive control. Driven against a mutant:
dropping the unattended-fallback tail fails with both strings printed, and the file's hash returns to baseline.

**D1.113 — the runner's two arrays, read as arrays.** The membership guard asked `runner.includes("'RS-51'")` over the
whole of `run.ts`, which cannot tell WHICH array an id sits in. **Measured by moving `'RS-51'` out of `SITTING` and
into `CASES` and re-running that very test: it stayed green**, over a runner that would then have swept a sitting case
into every bare `bun run scripts/cdp/run.ts`. `sittingIdsIn` generalises to `idsInArray(source, constName)`, and the
test now asserts three directions per file: a drive is in `SITTING`, a recipe is not, and NEITHER is in `CASES`.

**D1.143 — RS-15's out-of-workspace marker leaves every granted root.** The default sat under `$TMPDIR`, and outside
the WORKSPACE is not the same question as outside every root the runtime already grants: codex's `workspace-write`
sandbox carves out the temp roots, so the marker was a path the session may already write to and the refusal RS-15
exists to photograph would never be raised. The default moves to `~/.cache/nessy-cdp-rs15`, where RS-11 and RS-13 both
put theirs, hoisted into an exported helper the harness pins three ways. The `$TMPDIR` arm stays drivable through
`NESSY_CDP_OUTSIDE_PATH` and is a CHECK that states which arm ran, never a refusal.

**D1.158 — the README's `w19r-c3-4` row.** The case is in neither the wave nor `SITTING`, so the preconditions table
said nothing about it. The row names what it needs (a `pi` card and nothing else), what it creates and destroys, its
five outcomes — and the thing that cost a measurement: **the verdict is read from the JUDGE's own child-session
thread, not from the arm's transcript.** On 2026-09-13 the two gave opposite answers.

---

## 6. The rows this sitting did NOT reach, each with its premise re-taken at HEAD

Recorded as NULLs rather than left implied. Where a re-take moved something it is said so.

| row | premise at HEAD | why NULL |
| --- | --- | --- |
| `D1.234` D1.4's OUTPUT half | holds — the input half closed offline at `2ae851009` | needs a REALISTIC long transcript on the gateway card and a stage-1 reasoning read; the transcript has to be built before the question can be asked, which is a sitting of its own rather than a turn |
| `D1.184` `codexDetachedReview` | not re-taken; `RS-37` already carries the detached-review rig (C5.30) | both legs want the existing case re-driven on 1.39.0, which is a run this sitting did not have time for |
| `D1.207` the identity arm on TRACES | not re-taken | needs a loopback OTLP collector with BOTH exporters on; the logs drive is the positive half and neither was built |
| `D1.95` the index across a restart | not re-taken | needs a relaunch mid-case, which every rig fact in §0 says to do carefully; not reached |
| `D1.181` RS-02's ssh-key control | not re-taken | the row's own difficulty is PHRASING — two prior passes issued no command at all — and a phrasing experiment is a sitting, not a row |
| `D1.39` resume by id from another directory | holds: `resume` occurs 8 times in `claude-agent.ts` | needs a resume driven from a second directory; not reached |
| `D1.40` first-turn latency split | holds: `startup` occurs **26** times in the vendored `sdk.d.ts`, so the warm-start API is in the bundle | needs a per-runtime spawn/answer split with a control run at the same moment (AGENTS.md's timing rule), which this box's I/O confound makes a sitting of its own |
| `D1.41` codex hook exit codes | holds: `preToolUse` is in the generated `HookEventName` | a BINARY-level rig (host-authored `[hooks.PreToolUse]` plus the trust second pass), not a CDP case — the same verdict sitting 2 recorded for `D1.23` |
| `D1.42` PermissionRequest updates | holds: `__PERMISSION_UPDATE__` occurs in **2** files | needs a PermissionRequest hook installed, which is a fixture write plus a relaunch |
| `D1.43` three hook OUTPUT fields | holds, and the row's own anchors resolve by CONTENT: `asyncRewake` is named three times in `hook-command.ts` and `setSanitized(env, 'CLAUDE_EFFORT', input.effort?.level)` is at `:164` (the row says `:96` — a line that moved, not a claim that changed) | needs three hooks installed and a Bash child observed; a fixture sitting |
| `D1.44` SIGTERM on a headless run | holds: `signalExitCode` occurs in **3** files, and WI-n measured the Pi and codex halves this wave | the claude control is NOT reachable from a CLI rig at all (WI-n's own reading: no CLI flag creates a `claude-runtime` connection), so the row needs a different rig than the one it names |
| `D1.45` three `AgentDefinition` fields | holds: `permissionMode`, `maxTurns` and `background` are all declared in `definitions.ts` and named in its own docblock | needs three definitions and a runtime watched consuming each; not reached |
| `D1.47` an agent file added mid-session | not re-taken beyond the watcher's existence | needs a fixture write into a live config dir mid-session — a FIXTURE may, a case may not, and the fixture does not do this yet |
| `D1.48` the two budget counters | holds: `costUsd` occurs 3 times in `claude-agent.ts` | needs a budget-exhausted turn, which costs real money on a real card |
| `D1.49` Windows worktree removal | holds | **not drivable on this rig at all** — it is a Windows question and this sitting is macOS |
| `D1.50` the Linux sandbox helper warning | holds | **not drivable on this rig at all** — it is a Linux question |
| `D1.51` a live edit of the sandbox filesystem lists | holds | the sandbox is OFF by standing owner decision, so the rig would have to turn it on; a posture question before it is a measurement |
| `D1.52` the worktree-isolation refusal string | holds | shares the I7/I18 rig, which was not built |
| `D1.53` Pi's WebSearch budget | **REFINED, not refuted.** The row's `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` is the COMPAT name (`MAX_WEB_SEARCHES_PER_SESSION_COMPAT_ENV`); the primary is `NESSY_MAX_WEB_SEARCHES_PER_SESSION` (`MAX_WEB_SEARCHES_PER_SESSION_ENV`), and the refusal text the row wants to read is in `create-search-tool.ts` verbatim | needs real web searches on a real card, past a cap, counting across a subagent |
| `D1.54` a root-level `anyOf`/`oneOf`/`allOf` | **holds and is SHARPER than the row states.** `jsonSchemaToZodShape` reads `schema.properties` and nothing else, so a schema whose shape lives under a root `anyOf` yields `{}` — the tool reaches claude with NO arguments at all, silently | the comparison the row wants is three runtimes and a switch verdict, which needs an MCP fixture declaring such a tool on each; the claude half's mechanism is settled offline and is recorded here |

---

## What ran

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-32 (rig precondition) | P6.1080 | **PASS 8/8** twice — `rig-a` and the clean `rig-b` | `scripts/cdp/cases/rs-32.ts` |
| RS-52 | D1.27 | **PASS 17/17**, 84 s, load 8.41 | `scripts/cdp/cases/rs-52.ts` |
| RS-53 | D1.235 | **PASS** — NOT ROUTED, with the control ladder | `scripts/cdp/cases/rs-53.ts` |
| RS-54 | D1.33 | **PASS** — propagation and both carve-outs | `scripts/cdp/cases/rs-54.ts` |
| RS-55 | D1.183 | **PASS** — the claim REFUTED on codex, the control VOID on the first drive | `scripts/cdp/cases/rs-55.ts` |

`bun test ./scripts/cdp/harness.test.ts` green after every case file (59 / 1065 at the lane's start, **63 / 1203** at
its last commit). `bun run tsc -p scripts/cdp/tsconfig.json` exit 0 after every edit. `git diff --check` clean.
