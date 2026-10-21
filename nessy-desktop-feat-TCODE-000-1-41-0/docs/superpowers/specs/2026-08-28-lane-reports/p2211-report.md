# P2.211 — one dead capability claim repeated in six places

**Status: DONE.** Commits `ec7e24a51` + `69ca79155` (follow-up correcting my own overstatement — §8). Original commit `ec7e24a51` (7 files, +199/-28), `feat/TCODE-000`. Six sites fixed, plus a seventh found in the same file. One eighth
site found outside my zone and left alone — reported below, not touched.
One small guard built, with a negative control. Verdict on the general guard at the end.

---

## 0. Documentation classification (binding rule)

**(a) our own implementation.** `visibility: 'pi-only'` is a Nessy projection concept
in `packages/session-tools-core/src/tool-defs.ts`; no upstream page governs it, and I
did not go looking for one.

One upstream sentence sits inside the prose I rewrote, so I upgraded rather than
carried it. `SessionManager.ts` cited `scheduled-tasks.md:208`. That line number is
now **202** — the decay the standing rule predicts, measured. Replaced with an anchor
plus the verbatim sentence, both taken from the live page (anchors read off the
rendered page with `curl`, no `.md`, grepping `id="…"`; `#disable-scheduled-tasks` is
a real published id):

> `scheduled-tasks.md#disable-scheduled-tasks` — "The cron tools and `/loop` become
> unavailable, and any already-scheduled tasks stop firing."

---

## 1. The measurement, taken before anything was deleted

The row's claim was checked on the current tree rather than trusted. It holds, in the
direction the row states.

`SESSION_TOOL_DEFS` carries `visibility: 'pi-only'` on **ten** tools, and none of them
is a cron tool:

```
EnterWorktree, ExitWorktree, PushNotification, Task, TaskCreate,
TaskGet, TaskList, TaskUpdate, list_mcp_resources, read_mcp_resource
```

Surfaces, from `getSessionToolNames` at the enforcement site (not read off any doc):

| Surface | Options | Size |
| --- | --- | --- |
| Pi | `projection: 'pi'` | **54** |
| Claude | default | **46** |
| Codex, unbridged | `externalStandaloneOnly` | **18** |
| Codex, shipping | `+ hostCallbackBridge` | **26** |
| Codex, advisor on | `+ advisorConsultBridge` | **27** |

All four cron tools (`CronCreate`/`CronList`/`CronDelete`/`ScheduleWakeup`) are present
on Pi, Claude **and** the bridged Codex surface. The bridge's delta is exactly eight:
the cron four, `Monitor`, `ProcessStop`, `Goal`, `GoalGet`. `cronToolsAbsentFor` keeps
`loop` for every member of `SCHEDULED_DELIVERY_RUNTIMES` (`pi`, `anthropic`,
`codex-runtime`) and drops it only for `nestor-cloud-agent` or under the env flag.

All five counts are independently pinned by
`packages/session-tools-core/src/scheduling-projection.test.ts` (`:388-390`, `:268`,
`:309`), so the numbers I wrote into comments are not a second unguarded copy.

**One brief correction.** The brief gives `packages/shared/src/agent/SessionManager.ts`.
There is no such file; the real path is
`packages/server-core/src/sessions/SessionManager.ts`. Same for `capabilities.ts`,
which is `packages/server-core/src/handlers/rpc/capabilities.ts` at `:161-178`
(brief said `:167-172`).

---

## 2. What was changed

| # | Site | What was dead | What it says now |
| --- | --- | --- | --- |
| 1 | `packages/server-core/src/sessions/SessionManager.ts` `:526-531` | "All four cron tools are `visibility: 'pi-only'` … a non-Pi projection strips them" | The second route to "cron tools absent" is a runtime outside `SCHEDULED_DELIVERY_RUNTIMES`, not a visibility flag. Names the dead claim as dead. Upstream cite upgraded to an anchor + verbatim sentence. |
| 2 | `packages/server-core/src/sessions/__tests__/loop-skill-runtime.test.ts` `:24-29` | Comment denied what the assertions below it do | Comment now matches the assertions. **The assertions were right; the prose was wrong** — the positive control asserts `loop` is KEPT on `anthropic` and `codex-runtime`, the two runtimes the comment claimed lost it. |
| 3 | `packages/server-core/src/handlers/rpc/capabilities.ts` `:161-178` | Already self-corrected once, then went stale again on the Codex half: "Codex … still lacks them … until T5's callback bridge" | T5 landed; the runtime this filter withholds for is `nestor-cloud-agent`. |
| 4 | `apps/electron/…/input/runtime-switch-costs.ts` `:113` | **Distinct staleness, different axis** — the advisor, not the cron tools | P3.13 bridged `advisor_consult` to Codex under a second flag ANDed with the bridge (26 → 27). The P2.1 sentence is kept, not deleted: its reason is still live for `call_llm` / `spawn_session` / `browser_tool`. |
| 5 | `docs/architecture/runtime-capability-gaps.md` `:99` | "**26** session tools are absent" on Codex, enumerating `ProcessStop`, `Monitor`, `Goal`/`GoalGet` — all four now bridged | "**22** session tools are absent", with the eight the bridge carries named on their own side, and the class-name explained: "requires a host callback" is still true of all eight; what changed is that the callback now has a channel to an external process. |
| 6 | `docs/superpowers/specs/2026-07-31-claude-coverage-map.md` row 56 | Cell contradicted its own three 🟩ʰˢ columns | Rewritten (in Russian, matching the file) to state the measurement and to say explicitly that the columns and the cell now agree. |
| 7 | `docs/architecture/runtime-capability-gaps.md` `:153` | **Found by me, same file, same dead claim** — the R11 rejection list still labels the `Goal` pair `pi-only` | Marked as history; P2.2 projected the pair onto Claude and Codex. The rejection itself still stands on its own ground. |

New file: `packages/server-core/src/sessions/__tests__/runtime-capability-gaps-doc.test.ts` — see §4.

---

## 3. The coordinator's grep finding — validated, and sharper than expected

Re-swept with `/usr/bin/grep -a` and `rg -a` per the mid-task correction. Two results.

**The negative sweep came back clean.** No seventh code site. The other `pi-only`
mentions the NUL-safe sweep surfaced were checked one by one and are all accurate:
`scheduling-projection.test.ts:132-135` names `TaskCreate`/`TaskGet`/`PushNotification`
(genuinely still pi-only — verified against the measured ten);
`scheduled-delivery-runtimes.test.ts:2` says "no longer Pi-only", which is right; the
advisor-axis sweep found exactly one stale site, the one already in the row. The three
NUL-list files named in the correction (`base-agent.ts`, `permissions-config.ts`,
`project-capability-watcher.ts`) carry **zero** cron/loop/pi-only lines.

**But the finding lands directly on this row, and it is worth recording.** Of the six
sites, exactly one carries a NUL byte:

```
packages/server-core/src/handlers/rpc/capabilities.ts   HAS-NUL
```

Every other file in the cluster is clean. So a site list produced by the wrapped
`grep` alone would have been **five, not six** — and the missing one is the surface a
user actually sees (the composer catalog). The row's own "six places" survived only
because the P5.0 lane reached it by reading, not by searching. That is not a near
miss; it is the failure mode the brief warns about, arriving one file away.

---

## 4. The guard — the question the row actually asks

### 4a. The precedent, read rather than assumed

`e0a64da64` (P2.124) does something narrower than the row's framing suggests. It does
**not** make "a prose claim beside a contradicting value" impossible. What it does is:

1. give the runtime union a single **runtime value** (`AGENT_PROVIDERS` in
   `agent/backend/runtime-vocabulary.ts`) so no site invents its own list;
2. make per-runtime sites **total** over it — `Record`, not `Partial`, so adding a
   runtime breaks the build rather than inheriting a default;
3. **derive** each declared value at test time from its enforcement site
   (`runtime-capability-drift.test.ts` recomputes every `runtime-switch-costs` row's
   `on` map from `getSessionToolNames`, `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, and
   occurrence counts over the backend sources).

All three compare **value against value**. None of them reads a sentence.

The proof is in this row's own evidence: `runtime-switch-costs.ts`'s `scheduledRun`
row has a long prose docblock sitting directly beside its `on` map, guarded by that
very drift test — and the docblock at `:113` **still went stale**, under a green test,
because a count and a claim about *why* are different propositions. The guard the row
points at was live the whole time this cluster formed.

### 4b. Can it be extended to prose? Measured: no.

I prototyped the obvious extension — scan the tree for `pi-only` mentions, and where a
real tool name appears near one, assert that tool actually is `pi-only`. Run over every
`.ts`/`.tsx` in `packages` and `apps` (NUL-safe file list):

| | |
| --- | --- |
| `pi-only` mentions with a tool name within ±6 lines | **31** |
| Would be flagged | **23** |
| Genuinely stale among those 23 | **0** |
| Sites from THIS row that it catches | **0 of 6** |

Every one of the 23 is deliberate historical or contrastive prose — "these four **WERE**
`pi-only`", "the goal pair **left** `pi-only`", "`TodoWrite` is handed over instead
*because* the four task tools are `pi-only`". A guard that cries wolf 23 times is a
guard someone deletes in a week.

And it fails in the other direction too, which is the decisive half. The two worst
sites in this cluster — `SessionManager.ts:526` and `loop-skill-runtime.test.ts:26` —
say *"all four cron tools are `visibility: 'pi-only'`"* without naming a single tool.
The nearest identifier is `CRON_TOOL_NAMES`, a constant. The scanner cannot see them.
Neither can it see `capabilities.ts`, whose stale sentence names no tool either.

**Verdict: not worth building. Definitive no, not a hedge.** 74% false positives and
0% recall on the very cluster it would be built for. Tense is what separates a live
claim from a historical one, and tense is not mechanically decidable here. Any
opt-out marker an author writes by hand will be written into the next stale comment
too, because the author believes the comment is true when they write it.

### 4c. What IS achievable, and I built it (small)

One of the six is not prose: `runtime-capability-gaps.md`'s Codex row **enumerates
tool names**. A list of names is a value, and P2.124's property reaches it directly.

`packages/server-core/src/sessions/__tests__/runtime-capability-gaps-doc.test.ts`
(~130 lines, mostly the docblock) finds that row **by its claim** — not a line number,
not a count — splits it on the `**No longer absent:**` sentinel, extracts backticked
identifiers, keeps those that are real `SESSION_TOOL_DEFS` names, and asserts both
directions against a shipping Codex surface: absent-side names must be missing,
crossed-side names must be present, and no name may appear on both sides.

Both directions are asserted deliberately. The row went stale by keeping four names on
the absent side after the bridge carried them across; a one-directional test would
have stayed green through exactly that.

**Negative control run, because an absence claim needs one.** I moved `Monitor` (really
present on the bridged surface) onto the absent side and re-ran: **2 of 5 tests fail**,
naming `Monitor`. Doc restored and verified byte-identical to my intended state. There
is also an in-test positive control — the extractor must find more than five names, so
a doc rewrite that stripped every backtick fails instead of passing vacuously.

**Stated limitation, so no reader over-trusts it:** it does not check the row's leading
count, nor the groups written in prose rather than backticks ("source management and
OAuth triggers", "the four plugin tools"). It narrows the rot surface; it does not
close it.

### 4d. The recommendation I would actually make

The real lesson is not "add a guard". It is that **four of the six sites should never
have existed**: they restated a `visibility` value that is computable from
`SESSION_TOOL_DEFS`. A comment that restates a value is a second copy with nothing
keeping it in step — the identical two-lists-must-agree failure `runtime-vocabulary.ts`
was written to end, reappearing as prose instead of as an array. I wrote that rule into
each of the four sites I touched, in the imperative, next to the wreckage.

If you want a row out of this, the shape I would open is **not** a prose scanner. It is:
*give the enumerating docs the same treatment §4c gives one row* — the Claude and Pi
tables in `runtime-capability-gaps.md` also name tools, and the same parser covers them
for maybe an hour's work. Everything else in that file is genuine prose about
mechanisms, and should stay unguarded and hand-maintained.

---

## 5. Out of zone — reported, not touched

`docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md:653` (RTS-11) carries
the same dead claim: *"its four scheduling tools are `visibility: 'pi-only'`
(`tool-defs.ts:1161-1169` …)"*.

I did not edit it, for two reasons: it is outside my zone, and it is a **dated run
narrative** whose purpose under the 2026-08-20 owner rule is to record what was measured
at the time. Rewriting it would be rewriting history. My recommendation is a bracketed
"[stale as of 2026-08-27 — see P2.211]" annotation rather than a rewrite, but that is
the checklist owner's call, not mine.

---

## 6. Gate — real output

| Check | Result |
| --- | --- |
| `bun test` (mutex, label `P2.211`) on `runtime-capability-gaps-doc.test.ts` + `loop-skill-runtime.test.ts` | **12 pass, 0 fail, 21 expect() calls, 2 files, 1005 ms** |
| Negative control (mutex, label `P2.211-negctl`), `Monitor` moved to the absent side | **3 pass, 2 fail** — guard is not vacuous. Doc restored and verified. |
| `cd packages/server-core && bun run tsc --noEmit` | **exit 0** (tsconfig `include` is `src/**/*`, so the new test file was typechecked) |
| eslint, `packages/server-core` — 4 changed files | **exit 0** |
| eslint, `apps/electron` — `runtime-switch-costs.ts` | **exit 0** |
| `git diff --check` | **exit 0** |
| `bun test` (mutex, label `P2.211-pins2`) on `scheduling-projection.test.ts` — confirms the 54/46/18/26/27 pins I cite | **60 pass, 0 fail, 139 expect() calls, 446 ms** (second attempt; the first ran nothing — see below) |

**Skipped, and why:** `bun run typecheck:electron` — the only electron change is a
comment inside a docblock, no code touched, and the file's consumer (the drift test)
cannot see comments. `bun run typecheck:all` / full `bun test` — verification-wave
work under the implementation-first budget, not this row's.

**Deferred, named rather than claimed — and a trap worth passing to every lane.**
A confirmatory re-run of `scheduling-projection.test.ts` (the file pinning the
54/46/18/26/27 I now cite) was queued behind another lane on the test mutex. It came
back as **"completed (exit code 0)"**, and that exit code is a lie about what happened:

```
bun-test-lock: not acquired - held by P2.85-attrib2 ... - NOT reaping
[exited with code 0]
```

**`bun scripts/bun-test-lock.ts run` exits 0 when it fails to acquire the lock and runs
nothing at all.** A lane that reads the exit code — or a task notification saying
"completed (exit code 0)" — will record a green gate for a test that never executed.
This is the skipped-gate-reading-as-a-passed-one failure, handed to us by the tooling
rather than by carelessness, and under seven concurrent lanes it is likely to fire
again. The only safe check is to grep the output for a `Ran N tests` line; exit status
is not evidence here.

I retried it explicitly rather than accept the false green, and **the retry acquired the
mutex and ran for real**:

```
60 pass / 0 fail / 139 expect() calls
Ran 60 tests across 1 file. [446.00ms]
```

**So this gate is GREEN — and green on evidence rather than on an exit code.** The five
counts I cite in the comments (54 / 46 / 18 / 26 / 27) are confirmed live by their own
pins. Two independent routes had already established them — I read the assertions
verbatim at `:268`, `:309` and `:388-390`, and reproduced all five numbers by calling
`getSessionToolNames` directly — and this run makes three.

**The trap stands regardless, and it is the finding worth keeping:** the FIRST attempt
reported "completed (exit code 0)" having run nothing at all. Had I trusted that
notification I would have recorded this same green gate for a test that never
executed — right by accident, which is the worst way to be right.

---

## 7. Concerns

1. **The count "six" was produced by a tool that could not see one of the six.**
   `capabilities.ts` carries a NUL byte. It was found by reading, not searching. Any
   other row on this plan whose site list came from a wrapped `grep` deserves the same
   re-sweep — this is a plan-wide risk, not a P2.211 one.
2. **The precedent guard was live while this cluster formed.** The `scheduledRun` row's
   docblock sits inside the file `e0a64da64` hardened, beside a value that drift test
   recomputes every run, and it still went stale. Any future claim that "the drift test
   covers this" should be read as covering the *values only*.
3. **§4c narrows one line of one doc.** Five of the six sites remain hand-maintained
   prose and can rot again on the next edit. I judged that acceptable and wrote the
   don't-restate-a-value rule into each of them, but it is a discipline, not a
   mechanism, and it should be recorded as such.
4. **`bun-test-lock.ts run` exits 0 without running anything when it cannot acquire the
   mutex** (§6). Under seven concurrent lanes this silently converts a skipped gate into
   a green one, and the task-completion notification reinforces the misreading by
   reporting "exit code 0". My own retry then passed 60/0, so the outcome here was
   harmless — but only because I re-ran instead of believing the exit code, and any lane
   that believes it will record a green for a test that never executed. Every lane on
   this plan should verify a `Ran N tests` line rather than the exit status. Plan-wide.
5. **The RTS-11 narrative (§5) is a live eighth instance** of the dead claim that a
   reader could take as current. Needs an owner call on whether dated narratives get
   corrections.


---

## 8. POST-COMMIT: my own fix was overstated, and a concurrent lane caught it

Recorded because it changes one of my conclusions and because it is the most
useful thing that happened in this row.

**What happened.** Within the hour, lane **P2.280** rewrote part of my
`capabilities.ts` correction. It was not a clobber — it was a correction OF me,
and it is right. I wrote that "a shipping codex spawn carries
`--host-callback-port`, and the four cron tools reach it over that bridge",
unconditionally. Measured at `codex-agent.ts:1109-1114`,
`CodexAgent.startCallbackBridge` catches, sets
`schedulingBridgeState = 'unavailable'`, logs *"scheduling tools stay unavailable
this session"* and returns `undefined`. **The failure is non-fatal**, so a codex
session whose bridge never started runs its whole life on the 18-tool surface with
none of the cron four. Codex's membership in `SCHEDULED_DELIVERY_RUNTIMES` is
conditional at RUNTIME.

**It had propagated.** The same flat claim was in BOTH docs I rewrote —
`runtime-capability-gaps.md`'s Codex row and coverage-map row 56. Both files were
still clean and untouched since my commit, so I corrected them myself in
`69ca79155`. No tool name moved between the two halves, so the enumerated
membership is unchanged.

**The irony is the finding.** My defect is the *same shape* as the one this row
existed to fix: a flat per-runtime capability claim sitting beside a conditional
reality. Documentation rot is not mainly a maintenance failure — it is that
per-runtime capability is conditional more often than prose admits, and prose
defaults to the flat form.

**The guard earned its keep immediately, and in the way that matters.** My first
attempt at this correction reworded the `**No longer absent:**` sentinel the test
splits on. It failed 4 of 5, and the first assertion named the cause exactly —
*"row lost its `**No longer absent:**` sentinel"* — instead of parsing the row
into one half and passing vacuously. That is the failure mode a doc-parsing test
is most likely to have, and it was caught by the assertion written for it.
Sentinel restored verbatim; 5 pass / 0 fail.

**This sharpens §4d rather than reversing it.** The prose scanner is still a no.
But the value of the enumerating-doc guard is now measured rather than argued: it
caught a real break in its own subject, one commit after being written. I would
raise my recommendation on extending it to the Claude and Pi tables from
"maybe an hour's work" to "worth doing".
