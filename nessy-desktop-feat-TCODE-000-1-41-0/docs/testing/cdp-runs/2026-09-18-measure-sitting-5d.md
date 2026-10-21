# 2026-09-18 — measure sitting 5d (WAVE I-7, lane SIT-5d) on the packaged 1.40.0, CLEAN environment

The measure half of lane SIT-5d, which took the release verification's owed drives first
(`2026-09-18-release-verification-1.40.0-part-2.md`). **This lane's list starts where SIT-5b stopped —
`D1.40` — and runs in id order through `D1.54`**; SIT-5b's §6 already carries those rows' source premises,
so nothing here re-takes one without saying that it did.

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.40.0** (`CFBundleShortVersionString` reads
`1.40.0`), built by the controller from `61cfc4659`. Never rebuilt, never removed.

**Rig.** Ports 9232 and 9236 (two apps, two config dirs), 9233 (the refusing proxy, for RS-43) and 9237
(the OTLP collector, for RS-59), all under this lane's reserved 9232–9241. `NESSY_CONFIG_DIR` and
`--user-data-dir` under this lane's scratchpad, created for the run and never under `~`; the owner's
profile was never launched and `dp auth login`/`logout` were never run. Every launch used the `env -u`
launcher and every case process got the same treatment. The clean-environment control, its numbers and the
app's own read-back are in §0 of the part-2 narrative and are not repeated here.

---

## 1. D1.40 — the first turn's spawn share, on all three runtimes (case `RS-62`, **PASS 15/15**, 76 277 ms)

P6.288's `done_means`: *"a per-runtime split of first-turn latency into spawn and answer; if the spawn
dominates on claude, `startup()` is a small follow-up row, and if it does not, the cell closes as a stated
non-issue rather than an unbuilt feature."* The other half was settled by C3.76 on 2026-09-11: `startup()`
and the `WarmQuery` interface ARE declared in the vendored `sdk.d.ts`, with zero importers across
`packages` and `apps` — a wiring question waiting on a number.

### The instrument, and why it is a subtraction

Nothing in a packaged build reports "the runtime took N ms to start": `apps/electron/src/main/logger.ts`
turns both electron-log transports off whenever `isDebugMode` is false, which on a packaged build it always
is, so a case hunting a spawn timestamp would be measuring a dev build. What a session does have is
identical turns — the first pays for the runtime start and later ones do not — so `cold − warm` is the
spawn contribution and needs no instrument the product lacks.

The clock is the PRODUCT's: each turn is the `user` row's own `timestamp` to the last `assistant` row's,
both out of `getSessionMessages`. The harness's wall clock is recorded beside it and is deliberately not the
reading, because `sendPrompt` types the prompt one real key event at a time and that cost is the rig's.

### The reading

| runtime | card | cold | turn 2 | warm | **spawn** | **share of the first turn** |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| pi | `pi-api-key` | 5 504 ms | 3 221 | 532 | **4 972 ms** | **90 %** |
| codex | `codex-gateway` | 4 689 ms | 1 298 | 1 354 | **3 335 ms** | **71 %** |
| claude | `claude-gateway` | 5 714 ms | 5 941 | 2 655 | **3 059 ms** | **54 %** |

One profile, one app, three fresh sessions, four identical one-word turns each, load 8.99 at the start and
6.65 at the end. **On claude the process start is 54 % of the first turn**, so the row's own criterion —
*"if the spawn dominates on claude"* — is met, and `startup()` is worth the follow-up row P6.288 names.

### FOUR turns, and the fourth is what the first drive bought

With three turns the control REFUSED on both runtimes it could reach: pi read **14 507 / 9 168 / 648 ms**
and codex **6 467 / 6 521 / 896 ms**, so the second turn sat 93 % and 86 % away from the third. Read as
noise that is a refusal; read as a reading it is part of D1.40's answer — **the second turn is still paying
something on every runtime**, and a case that called turn 2 "warm" would have subtracted a warm-up from a
warm-up. The stable pair is the LAST TWO and turn 2 is reported in its own right, which is why the table
above has a column for it.

### The controls

- **The two warm turns against each other**, which decides whether a number exists at all. This repo has
  measured a 22x spread on identical bytes minutes apart, so the case reports UNAVAILABLE with both figures
  rather than a difference that is mostly the machine. Its ceiling is 50 %, deliberately loose: the question
  is whether a spawn DOMINATES, and a tighter ceiling on this box would refuse most runs and teach the next
  sitting to widen it. **Pi's spread this run is 47 %, just inside it** — worth knowing when reading its 90 %.
- **Every turn answered the same one word**, so the durations measure one thing.
- **The first turn really is the slowest**, checked per runtime: a negative spawn share would mean the
  subtraction has no subject, and that is D1.40 answered in the other direction rather than a failure.
- The session is MOVED onto each card through `sessions:command switchRuntime` and the binding read back,
  so a family's row cannot be another runtime's turns.

---

## 2. The rows this sitting did NOT drive, each with its premise re-taken

SIT-5b's §6 took the SOURCE premises for `D1.41`–`D1.54` on 2026-09-18 and they are not re-taken here; what
follows is what this sitting adds about whether each is drivable on a rig of this shape.

| row | why NULL, on this rig, today |
| --- | --- |
| `D1.41` codex hook exit codes | a BINARY-level rig: host-authored `[hooks.PreToolUse]` in `config.toml` plus the trust second pass, which is not a CDP case. Third sitting to record that verdict; the adjacent P6.143 shares the rig and they belong in one rig-day |
| `D1.42` `PermissionRequest` hook permission updates | needs a `PermissionRequest` hook installed on BOTH the Pi and the claude paths and a permission update issued from inside it — a fixture sitting with a relaunch, not a turn |
| `D1.43` `terminalSequence` / `asyncRewake` / the effort input | needs three hook OUTPUT fields exercised from a real hook; the row's line anchor moved (content unchanged) and wants re-anchoring in WORDS when it is taken — `setSanitized(env, 'CLAUDE_EFFORT', …)` lives in `packages/shared/src/automations/hook-command.ts`, which is the path correction SIT-5b already recorded |
| `D1.44` `signalExitCode` | same family: a hook rig, and the signal half needs a child killed by a signal rather than an exit code |
| `D1.45` agent-definition `permissionMode`/`maxTurns`/`background` | needs agent definitions carrying all three fields and a spawn per runtime; `fixtures/agent-surfaces.ts` writes the files, so it is a fixture sitting rather than a blocked question |
| `D1.47` `reloadAgents` | the premise is the finding: `reloadAgents` scores **0** against a `watchAgents` family at 4, so there is nothing to drive until the row is re-read as "is a reload reachable at all" |
| `D1.48` `costUsd` | needs a card that reports a cost; the gateway cards do not price a turn, which is the discriminator to establish before driving |
| `D1.49`, `D1.50` | Windows and Linux. Not drivable on this rig at all — one line each, as the brief asks |
| `D1.51` `SEATBELT_TESTING_WILDCARD` | the sandbox master switch is OFF by standing owner decision, so the arm cannot be reached from a rig; it is a source question until that decision changes |
| `D1.52` | not reached: the sitting's budget went to the release verification's owed drives and D1.40 |
| `D1.53` `MAX_WEB_SEARCHES_PER_SESSION_ENV` | needs a session that really web-searches, which on this rig means an egress the gateway cards do not have for that tool; establish the tool is reachable before pricing its ceiling |
| `D1.54` `jsonSchemaToZodShape` | needs an MCP server whose tool schema exercises the shapes the converter handles; the MCP fixture tree exists (`fixtures/mcp-naming.ts`) so this is a fixture sitting rather than a blocked question |

### And one row from the ORDER above it, recorded here because its subject does not exist on this rig

**`D1.184`'s switch legs (the `rs-60` case).** RS-37 was re-run on this artefact and reads **FAIL 4 of 7**,
323 792 ms — the same verdict measure sitting 4 recorded on 1.39.0, with the same shape: the CONTROL passes
(`ReviewDiff` runs on the probe diff and answers with the inline delegation template, so the review path is
alive) and `the notice arrived on: never`. So `startDetachedReview` returns `null` on the gateway codex card
on 1.40.0 too, and sitting 4's named discriminator — *a codex card on a model codex knows* — is still the
thing to rule out first. **A switch-legs case has no subject on this rig**: there is no detached review
thread to abandon by switching mid-review. Building one here would produce a case that can only block, so
the reason is recorded instead and `RS-60` is left unclaimed for the rig day that has such a card.

---

## 3. Where this sitting stopped

**The last measure row this lane covered is `D1.40`.** The remaining list is `D1.41`, `D1.42`, `D1.43`,
`D1.44`, `D1.45`, `D1.47`, `D1.48`, `D1.51`, `D1.52`, `D1.53`, `D1.54`, and the next sitting starts at
`D1.41`; `D1.49` and `D1.50` are Windows and Linux questions and are not drivable on this rig at all.
Four of the remaining eleven — `D1.42`, `D1.43`, `D1.44`, `D1.45` — are ONE hook/agent fixture sitting
between them, which is the cheapest way to take them and the reason they are grouped in the table above.

## What ran

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-32 (rig precondition, twice) | P6.1080 | **PASS 8/8**, 60 053 ms and 31 501 ms | `scripts/cdp/cases/rs-32.ts` |
| RS-46 | D1.14 / D1.326 | **PASS 10/10**, 196 744 ms — inverted first | `scripts/cdp/cases/rs-46.ts` |
| RS-43 (two arms) | DA2.11 / DA2.19 | **the DA2.19 reading is PASS**; the proxied arm's own status is FAIL on its card precondition | `scripts/cdp/cases/rs-43.ts` |
| RS-61 | D1.95 | plant **PASS 2/2**, read **FAIL 3 of 5** — the row's own answer | `scripts/cdp/cases/rs-61.ts` |
| RS-59 | D1.207 | **7 of 10**, 42 533 ms — the three FAILs are one finding | `scripts/cdp/cases/rs-59.ts` |
| RS-56 | D1.260 / D1.264 / D1.323 | **PASS 10/10**, 34 190 ms — was 3 of 9, then 7 of 9 | `scripts/cdp/cases/rs-56.ts` |
| RS-37 | D1.184 | **FAIL 4 of 7**, 323 792 ms — sitting 4's verdict re-confirmed on 1.40.0 | `scripts/cdp/cases/rs-37.ts` |
| RS-53 | D1.235 | **PASS 6/6**, 126 780 ms | `scripts/cdp/cases/rs-53.ts` |
| RS-54 | D1.33 | **PASS 8/8**, 124 730 ms | `scripts/cdp/cases/rs-54.ts` |
| RS-62 | D1.40 | **PASS 15/15**, 76 277 ms | `scripts/cdp/cases/rs-62.ts` |

`bun scripts/bun-test-lock.ts run --label SIT-5d -- bun test ./scripts/cdp/harness.test.ts` was run after
every case file this lane added or edited, **84 pass / 0 fail across 1 FILE** for every one of this lane's
runs; the single red seen twice named `RS-77` and then `RS-78`, both lane SIT-5c's files.
`bun run tsc -p scripts/cdp/tsconfig.json` exited 0 after every edit. `git diff --check` was clean before
every commit.
