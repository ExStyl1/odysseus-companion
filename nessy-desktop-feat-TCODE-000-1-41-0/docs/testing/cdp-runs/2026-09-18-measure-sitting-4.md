# 2026-09-18 — measure sitting 4 (WAVE I-4, lane WI-aa) on the packaged 1.39.0, CLEAN environment

The fourth sitting against the `measure:` rows the runtime-parity closure deferred on 2026-09-10 and the
integrations-and-authorization plan carries as `D1.*`. Its first order is `D1.260` — re-take with a clean
environment the readings sitting 3 found the rig had contaminated.

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.39.0** (`CFBundleShortVersionString` reads
`1.39.0`), built by the controller from `b1f4f279c`. Never rebuilt, never removed.

**Rig.** Port **9231** (9226 was the release sitting's, 9228/9229 sittings 1 and 2, 9230 sitting 3);
`NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad (`rig-a`), created for the run and never under
`~`. The owner's profile was never launched; `dp auth login` / `logout` were never run; no token was read, printed or
committed. `NESSY_DEBUG=1` and `NESSY_PROXY_AUTH_DEBUG=1` on every launch. Every launch used the `env -u` launcher
from `scripts/cdp/README.md`.

**The rig precondition.** `RS-32` **PASS 8/8**, 29 081 ms at load 12.68 — the one-click Pi card seeding
`tgpt/deepseek-v4-flash-0731` (the `coder` alias), its first turn answering `ready`, and the retired-id control
showing the host substituting the live id before the call with 0 info rows.

---

## 0. The clean-environment control, printed once per run

Sitting 3's finding is the reason this sitting exists, so its instrument is exercised rather than trusted.

**The derivation re-run at HEAD, not a copied list.** The candidate set is the lane's own environment; the
intersection is what the repo reads:

```sh
env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
  while read -r n; do
    c=$(git grep -aclP "(?<![A-Za-z0-9_])$n(?![A-Za-z0-9_])" -- packages apps | wc -l)
    [ "$c" != 0 ] && echo "$n -> $c file(s)"
  done
```

Thirteen names over the same 31-name candidate set, unchanged in membership from 2026-09-17.

**The app's own read-back**, through `ps eww` on the RUNNING app and never on this process:
`{"pids":4,"present":{},"controlSeen":true}` — four `MacOS/Nessy Desktop` processes, no contaminating name, and
`NESSY_CONFIG_DIR` seen in the same read as the positive control. Repeated after every relaunch; clean each time.

**And the derivation itself was wrong in one entry — see §2.** The command above is the corrected, boundary-aware
form; sitting 3's used `git grep -ac`, a substring match.

---

## 1. D1.260, the AGT-5 half — the re-take is impossible on this build, and why is the finding (case `RS-56`, NEW)

### The premise moves before the row starts

D1.260 says sittings 1, 2 and the release sitting all launched the app with the contaminating names inherited, *"so
any reading any of them took about a subagent's model, a reasoning effort or an MCP connect posture carries this
confound"*. For the two rows the controller named there is **no earlier reading to move**:
`git grep -an 'AGT-5\|RS-06\|effort'` over the three narratives answers **zero lines**, the checklist's `AGT-5` row
reads `2026-08-21 | BLOCKED | fixture/env (unchanged)` and its `RS-06` row reads `not driven`. This is a FIRST take
wearing a re-take's name, and the old/new pair has no old half. Recorded rather than implied.

### Driven clean, AGT-5 stops at its first required check

Fixtures written by `fixtures/agent-surfaces.ts --config-dir <rig>` — `cdp-deep` declaring `effort: high`,
`cdp-shallow` declaring none. (The same fixture merges in three CDP hooks; they were removed again with
`--remove-hooks` before any measurement, because RS-30's `PostToolUse` hook carries no matcher and would annotate
every later turn in this config dir.)

`AGT-5` **FAIL**: *"the declaring subagent was spawned — no new child registered for cdp-deep"* — over a turn whose
own transcript carries `Started background subagent task … agent_ids: agent-subagent-mu604uni-a29msp-1` and, four
tool calls later, the child's answer `101, 103, 107.`. **The child was there. The READ was not.**

`lib/state.ts` `piRuntime()` converts a throw from `getPiHarnessRuntime` into `{ available: false, children: [] }`,
so a runtime read that FAILS and a session that spawned NOTHING are one reading, and the case reports the second.

### The measurement, which is a BEFORE and an AFTER in one session

| when | `getPiHarnessRuntime` | `listPiAgentView` |
| --- | --- | --- |
| BEFORE the first turn — **THE CONTROL** | answers: `available:false`, `unavailableReason:"pi-runtime-not-started"`, `barrierSeq:230` | throws `pi-agent-view-invalid` |
| AFTER one plain turn, no tool | **throws `pi-harness-runtime-invalid`** | throws `pi-agent-view-invalid` |

Nothing changed but that a Pi runtime now exists to describe. **The BEFORE read is what makes the AFTER read a
statement about the PAYLOAD rather than about the API**: the RPC, the preload's `barrierSeq` guard and
`parsePiHarnessRuntimeSnapshotV1` all work on this build, in this session, two minutes earlier. An unreadable API
fails both reads.

**The second surface is its own before/after and NOT corroboration.** `listPiAgentView` throws in BOTH arms, so that
surface does not read on this build even for a session that has never run a turn — a WIDER statement than the
subject's, and one that scoring the two parsers as one reading would have swallowed. The case was edited after its
first drive to score them separately; the first spelling would have reported a true thing for the wrong reason.

**The user-visible half, with a control the case did not produce.** A `scout` dispatch wrote exactly one child
session record carrying `piChildRestrictions` — `<config>/sessions/<workspaceId>/52764422-…/session.jsonl`, the file
the feature itself writes and the detector RS-52 settled on — and `[data-testid="agent-panel"]` did **not** mount
within 20 s of it. The agent panel is dark on the packaged 1.39.0 while a child is running, and `useAgentPanel`
reads exactly the snapshot the subject check could not.

**What the case deliberately does NOT claim.** `pi-harness-runtime-invalid` is thrown by BOTH the preload's
`barrierSeq` guard and `parsePiHarnessRuntimeSnapshotV1` (`apps/electron/src/preload/bootstrap.ts`), and nothing
outside the preload can tell them apart — `window.__nessyRpcRaw` is the same wrapped object, not a raw invoke. The
case says so rather than naming one.

**What it costs the rest of the corpus.** Every case that reads `childState.children` through `piRuntime()` —
`AGT-1`, `AGT-2`, `AGT-5` — is measuring this on a packaged build, and reports it as an empty child list. `RS-52`
is unaffected because it reads the child record off disk, which is now the only working detector for a child here.

---

## 2. D1.260, the RS-06 half — the confound does not exist, and the instrument was wrong

`app-env.ts` recorded `MCP_CONNECTION_NONBLOCKING` at 3 files as *"the MCP connect posture RS-06 measures"*. The
product's only reader of that posture is `env.NESSY_MCP_CONNECTION_NONBLOCKING`
(`mcp/server-config-values.ts` `mcpConnectionNonBlockingFromEnv`) — a **different name**.

Boundary-aware, the bare name scores **1** over `packages apps`, and that one hit is a DOCBLOCK SENTENCE in
`mcp-pool-connect-batch-timing.test.ts` rather than a reader. **So the bare name a lane's shell exports moves
nothing, and no RS-06 reading anywhere carries a confound from it.** The same census moves one more entry:
`CLAUDE_CODE_SUBAGENT_MODEL` 14 → **10**, the four extra being its own `_FORCE` sibling, which has an entry of its
own. The other eleven are unchanged.

`-P` and not `-E`, because `git grep -E` does not honour `\b` on this rig and the miss is silent (AGENTS.md §Traps).

The entry is **corrected rather than deleted**: the launcher still deletes the inert name, the read still reports it,
and `appEnvBlockReason` no longer BLOCKS on a name measured to have no reader — a guard that refuses a measurement
over an inert variable teaches the next operator to ignore the guard rather than the variable. **Control for the
filter: a real name (`CLAUDE_EFFORT`) still blocks.**

RS-06 itself stays **not driven**: it needs a REVOKED credential in the source's own system and four runs across two
relaunches, which is the operator's matrix and not a driver's.

---

## 3. THE ARTEFACT LAG, which turns two rows into NULLs and would have produced two false findings

The 1.39.0 artefact was built from `b1f4f279c`. Several rows in this sitting's list ask for a clause built LATER in
the same wave to be driven on "a packaged build". Driving them against this artefact measures its absence.

**The instrument is two readings that must agree**: a literal `grep -raoF` over `Contents/Resources/app/dist` with a
SIBLING string as its positive control, and `git merge-base --is-ancestor <implementing commit> b1f4f279c`.

### D1.244 — the `fast` and `coder` rows with `reasoning_effort`

Read from the file the feature itself writes. After a relaunch that let the startup refresh land — the positive
control being that both rows' `name` and `description` are now the gateway's own Russian text and
`catalogueRefreshedAt` is written — `<config>/config.json`'s two model entries carry **no `reasoningEffort` and no
`samplingParams`** at all.

That absence is the artefact:

* `grep -raoF sampling_params` over the bundle answers **0**, while three sibling wire keys read by the same parser
  answer `context_window_size` **2**, `is_default` **9**, `cli/models` **4**;
* `git merge-base --is-ancestor 4e3b57caf b1f4f279c` answers **NO** — `4e3b57caf` is
  *"feat(models): the gateway catalogue's reasoning effort and sampling params are read (DA1.22)"*.

So the tri-state flip WI-x is holding **cannot be decided from this build**, and scoring the empty catalogue as *"the
gateway publishes no reasoning block"* would have been a false product finding. WA-e measured
`reasoning: {"effort":"low"}` on the `coder` row on 2026-09-13 through a direct catalogue read; nothing reachable
from this artefact confirms or refutes it, because the shipped fetcher does not read the field. **The measurement is
owed on a build containing `4e3b57caf`.**

### D1.162 / ledger K34 — the per-entry provenance mark

WI-q's hand-off asks for `data-testid="model-catalogue-unlisted"` in BOTH pickers on a refreshed connection, with a
never-refreshed connection as the control. **The mark is not in the build**: `model-catalogue-unlisted` **0**
against its two sibling testids from the same components, `model-list-provenance` **1** and
`model-target-tool-egress` **1** — the control that the probe reads the components that would carry it — and
`git merge-base --is-ancestor 4b2638db3 b1f4f279c` answers **NO**.

**K34 stays `partial ʰ`** and the drive is owed on the next packaged build.

---

## 4. D1.95 — the index survives a restart: ANSWERED on the store

P2.62's claim is *"a `running` record from a previous host process staying visible"*, proven until now by a backfill
UNIT and never by a live restart. The detector is the file the feature itself writes:
`<config>/sessions/.pi-processes/<handle>.json` plus the `.running/<handle>` index entry — `SessionManager` builds
the store at `join(SESSIONS_DIR, '.pi-processes')`.

| step | reading |
| --- | --- |
| a background `sleep 900` started through a Pi gateway session | record `status: running`, `pid 61923`, `pidStartMarker darwin:Fri Sep 18 00:20:58 2026`; `.running/process_2938…` present |
| the app `kill -9`'d, all four processes | **the shell SURVIVES the host** (`pgrep 'sleep 900'` = 1) and the record still reads `running` |
| the app relaunched and the backfill run | **the record is still there and still `running`, and its process really is alive** — so the record is TRUE, not merely stale |
| the orphan killed, then read at +12 s, +24 s, +36 s | still `running` — **the store does not sweep; it settles on a READ** |

**The controls.** Two neighbouring records in the same directory reading `exited` with `exitCode: 0`, so "everything
says running" is excluded; and the surviving process itself, which is what separates a stale record from a correct
one.

**What is owed.** The product-side half — the restarted host SHOWING the record — travels in exactly the snapshot
§1 measures as unreadable, so it is blocked by that defect rather than missed. Driven through the model instead, the
turn produced two `Bash` calls and the model's own report that it had no background-process-status tool in that
session; the record did not settle. That last sentence is the model's prose and is recorded as a hint, never as the
finding.

---

## 5. D1.181 — RS-02's ssh-key control is ESTABLISHED (case `RS-02`, **PASS 8/8**, 54 267 ms, load ~8.9)

The row's difficulty is PHRASING: two packaged passes on 2026-09-11 recorded `toolCalls: []` for this control and
for the Bash subject beside it, so the model issued no command at all and neither arm measured the floor. R5
rewrote both prompts on 2026-09-12 — a byte count instead of a `cat`, *"tell me only the number it prints, not any
file content"* — and the re-run was owed.

**Re-run on the clean rig, and the control HOLDS:**

| arm | tool calls | refused |
| --- | --- | --- |
| control (1) the file tool on `config.json` | `Read` then `Bash` | no — the tool surface reads |
| control (2) a shell command on `config.json` | `Bash`, 9 bytes of result | no |
| **control (3) `wc -c < ~/.ssh/id_rsa`** | **`Bash`, status `error`** | **YES — the floor refused it** |
| subject, the file tool on `credentials.enc` | `Read`, status `error` | yes |
| subject, a shell command on `credentials.enc` | `Bash`, status `error` | yes |

So the model DID issue the shell command this time, the floor refused it with its own sentence, and the two subject
arms are interpretable for the first time. **D1.181's ask — "phrase the control so the model reaches for the
shell" — is answered, and the phrasing that answers it is the one already in the file.** No content of the owner's
key was requested or printed: the prompt asks for a byte count and the floor refused before even that.

One reading to carry: `credentials.enc` does not exist on a fresh rig profile (`secretExists: false`), so the two
subject refusals are the floor refusing a PATH rather than a leak being prevented. That is the case's own
`INCONCLUSIVE` branch and it did not have to fire, because both arms refused.

---

## 6. D1.184 — the C4.42 default re-take: RS-37 does NOT reproduce on the gateway codex card (**FAIL 4 of 7**, 327 848 ms)

D1.184 asks for two things: a NEW case for the switch legs, and a RE-RUN of `RS-37` against the C4.42 DEFAULT,
because its `PASS 7/7` on the packaged 1.37.0 was taken on the model-opts-in path. The re-run half was taken here.

The card was created by the RPC the one-click button itself calls — `setupLlmConnection` with
`codexGatewayConnectionDefaults()`'s payload — producing `codex-gateway` / `codex-runtime` on the same rig profile.

| check | verdict |
| --- | --- |
| the artefact under test is the PACKAGED app | ok |
| the session runs on the codex card | ok |
| **THE CONTROL — `ReviewDiff` ran on this diff and answered with the INLINE delegation template** | **ok** |
| the background review STARTED on a review thread of its own | **FAIL** |
| the review thread reported its findings BACK into this session | **FAIL** (`the notice arrived on: never`, after the wait AND both flush turns) |
| the findings name what was reviewed | **FAIL** |
| permission cards answered during the whole case | 0 |

**The control is what makes this readable**: `ReviewDiff` really ran on the probe repository's diff, so the review
path is alive and it is the DETACH that did not happen. The case's own detail sentence names the four causes
`startDetachedReview` returns `null` for — an app-server with no `review/start`, a refusal, an inline delivery, or no
open thread — and this run **cannot separate them**, which the case says rather than picking one.

**And there is a live alternative explanation the next sitting has to rule out before this is read as a
regression.** This card runs codex against a gateway model codex does not know, and the session's own transcript
says so in an `info` row: *"Codex: Model metadata for `tgpt/deepseek-v4-flash-0731` not found. Defaulting to
fallback metadata; this can degrade performance and cause issues."* A model that never issues the detach request is
exactly cause (b). **The discriminator for the next sitting is a codex card on a model codex has metadata for**; on
that card the same case separates a declining model from an absent capability. Until then, the honest reading is
*"not reproduced on the gateway codex card on 1.39.0"*, not *"C4.42's default is broken"*.

The switch-leg half of D1.184 — abandoning a review mid-flight by switching runtime — was not built.

---

## 7. A rig fact for the next sitting: the card ladder is per COMMAND, not simply per runtime

Sitting 3 measured that a plain `echo` raises NO permission card in `default` mode on a `claude-gateway` session and
wrote the ladder rule from it. Two readings here, on the SAME Pi gateway card, in the same profile, an hour apart:

* a prompt asking for `sleep 900` **in the background** raised `[data-tutorial="permission-banner"]`, and the turn
  sat at `isProcessing: true` with the tool call unanswered and NO record in the process store until the card was
  pressed — which is what a driver meets as *"the turn hung for 300 s with no error"*;
* RS-02's five probes — `wc -l` and `wc -c` shell commands, plus two file-tool reads — raised **no card at all**: a
  card answerer ran beside that whole case and clicked nothing.

So *"Bash on Pi asks"* is too strong and *"Pi never asks"* is false. What was measured is that one spelling asked
and another did not, on one card in one mode; the plausible differentiator is the background/long-running execution
rather than the tool, and it is named as a hypothesis rather than a finding. **The transferable rule is the one
sitting 3 already wrote, one level up: a control LADDER, never one command — and a sitting driving Bash on a Pi card
should keep an answerer running, because the failure mode is a silent 300 s hang rather than an error.**

Also measured, and it is the README's own layout warning seen again: the banner's `innerText` reads `''` while
`[data-tutorial="permission-allow-button"]` is present, positioned and clickable. Assert on the element, never on
its text.

---

## What ran

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-32 (rig precondition) | P6.1080 | **PASS 8/8**, 29 081 ms, load 12.68 | `scripts/cdp/cases/rs-32.ts` |
| AGT-5 | D1.260 | **FAIL** at its first required check — the instrument, not the feature | `scripts/cdp/cases/agt-5.ts` |
| RS-56 | D1.260 | **FAIL 3 of 9, and the three FAILs are the product** | `scripts/cdp/cases/rs-56.ts` |
| RS-02 | D1.181 | **PASS 8/8**, 54 267 ms — the ssh control established for the first time | `scripts/cdp/cases/rs-02.ts` |
| RS-37 | D1.184 | **FAIL 4 of 7**, 327 848 ms — not reproduced on the gateway codex card, cause unseparated | `scripts/cdp/cases/rs-37.ts` |

`bun scripts/bun-test-lock.ts run --label WI-aa -- bun test ./scripts/cdp/harness.test.ts` → **63 pass / 0 fail,
1223 expect(), 1 file** after every case file. `bun run tsc -p scripts/cdp/tsconfig.json` exit 0 after every edit.
`git diff --check` clean before every commit.
