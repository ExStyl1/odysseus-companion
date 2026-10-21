# P2.212 — three surfaces offered where their implementation is not

Branch `feat/TCODE-000`, one shared working tree, committed by explicit pathspec.

---

## 0. Premise corrections — read these first

The row's three gaps are all REAL. Three of its stated facts are not.

**(a) The cited consumer site is wrong, and the file it names is the wrong file.**
The row says the sole `[workflow:<name>]` consumer is `pi-agent.ts:8626`. Measured:

- The literal `[workflow:<name>]` is MINTED in
  `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/slash-commands/custom-commands.ts`
  (`workflowSlashCommandBody`), and its only *reader* is a model-facing prompt
  string in
  `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/pi-agent-server/src/orchestrator/workflow-tool.ts`
  (`promptSnippet`: "A `[workflow:<name>]` user command means call this tool with
  that name and pass trailing text as args.input"). That is Pi-subprocess code —
  the marker is consumed by the MODEL reading the Pi `workflow` tool's guidance,
  not by host code at all.
- The host-side dispatcher is the STRUCTURED sibling, not the marker:
  `ChatOptions.workflowInvocation`, read at
  `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/agent/pi-agent.ts`
  in `chatImpl` (`if (piOptions?.workflowInvocation)` → `requestWorkflowExecution`
  → `workflow_execute`). Nothing at all lives at `:8626`.

  This matters for the fix: gating the MARKER would have been the wrong gate.
  Both halves are emitted together by
  `packages/server-core/src/handlers/rpc/sessions.ts` (`command.source === 'workflow'`),
  and it is the marker that reaches the model when the option is ignored.

**(b) The zone names a file that does not exist.** `packages/shared/src/agent/tool-defs.ts`
is not in the tree. The tool-definition projection is
`/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/session-tools-core/src/tool-defs.ts`.
I read it (it is the source of every derived premise in the new tests) but did
not need to change it.

**(c) Gap 3 is not latent. It is reachable, by a documented non-fatal path.**
See §3.

---

## 1. Gap 1 — `/workflow-name` on claude and codex · FIXED (gate + tests)

### Reproduced first

Before touching anything I drove the real seam
(`packages/shared/src/agent/__tests__/workflow-command-runtime-gate.test.ts`,
a real `ClaudeAgent` with the Agent SDK's `query` faked) and measured the defect:
a `chat()` carrying `workflowInvocation: { name: 'audit' }` produced ONE model
turn whose prompt tail was, verbatim:

```
[workflow:audit]
release readiness
```

The paired positive control (the same agent, same rig, no `workflowInvocation`)
passed, so the model call was real and observable. The defect is exactly as the
row describes.

### Decision: withdraw the offer, do not implement

A workflow recipe is a **script**, not a prompt — the Pi orchestrator's
`workflow` tool runs it with `agent()`, `parallel()`, `pipeline()`, `phase()`.
There is nothing a model on another runtime can do with the recipe's NAME, and
"implementing" it would mean porting the orchestrator to two more runtimes.

Upstream agrees with the withdraw direction, and says so twice (category **(b)**;
anchors verified by `curl`-ing the rendered pages and grepping `id="…"`):

- `workflows.md#turn-workflows-off` — "When workflows are disabled, the bundled
  workflow commands are unavailable, the `ultracode` keyword no longer triggers a
  run, and `ultracode` is removed from the `/effort` menu."
- `workflows.md#let-claude-decide-with-ultracode` — "It's available on models that
  support `xhigh` [effort](/docs/en/model-config#adjust-effort-level); on other
  models the `/effort` menu doesn't offer it."

Both say the same thing: when the mechanism is absent the surface is *removed*,
never offered-and-inert. The `[workflow:<name>]` ENCODING itself is category
**(a)** — ours, no upstream page governs it.

### What landed

`/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/agent/base-agent.ts`

- New concrete `protected canDispatchWorkflowCommands(): boolean { return false }`,
  written in `approveGuardianDenial`'s shape and for its stated reason: a backend
  that overrides nothing still answers, and the safe default for a NEW backend is
  "cannot", because the other default fails silently.
- A claiming arm at the top of `chat()`:

  ```ts
  if (options?.workflowInvocation && !this.canDispatchWorkflowCommands()) {
    if (!i18n.isInitialized) setupI18n();
    yield { type: 'error', message: i18n.t('settings.ai.workflows.dispatchUnavailable') };
    yield { type: 'complete' };
    return;
  }
  ```

`/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/agent/pi-agent.ts`

- `protected override canDispatchWorkflowCommands() { return true }`, placed
  directly above `requestWorkflowExecution` — the mechanism that makes it true.

`packages/shared/src/i18n/locales/{en,ru}.json` — one new key,
`settings.ai.workflows.dispatchUnavailable`. `lint:i18n:sorted` and
`lint:i18n:parity` green (2369 keys each).

### Why the DISPATCH seam and not the composer's menu row

The listing site is `SessionManager.loadSessionCustomSlashCommands` /
`listCustomSlashCommandSummaries`, which is **off-limits to this lane** (the
brief assigns it to the next wave). That constraint turned out to be the better
outcome anyway, and I would argue for this placement even without it:

- The seam gate is **load-bearing**. It also covers a queued mid-stream replay
  (`managed.messageQueue` carries `workflowInvocation` verbatim), a stale
  renderer command catalog, and a typed command id — none of which a listing
  filter can reach.
- A listing filter alone is **cosmetic**: it removes the row and leaves the send
  path intact.

I verified the refusal is actually VISIBLE rather than swallowed: `SessionManager`'s
`case 'error'` has a "no turn in flight" gate that drops the event, and
`setProcessing(managed, true)` runs at `SessionManager.ts:20420`, well before the
`agent.chat(...)` call — so `managed.isProcessing` is true and the message is
appended to the transcript and sent to the renderer. It also does not match
`messageLooksLikePlainAuthError`, so it cannot trigger a message re-send.

### Owed to the next-wave SessionManager lane

The menu row still appears on claude and codex. To withdraw it, mirror the
`/loop` pattern already in that file: a `cronToolsAbsentFor`-shaped predicate
(`workflowCommandsAbsentFor(provider)`) applied at the two sites that build the
list — `loadSessionCustomSlashCommands` (native workflow recipes,
~`SessionManager.ts:21076`) and the plugin-workflow branch of
`listCustomSlashCommandSummaries` (~`:21251`). The seam gate stays regardless; it
is the belt.

### Tests

`packages/shared/src/agent/__tests__/workflow-command-runtime-gate.test.ts` (new)
- refuses the turn and never sends the marker — **exercises the real path**
  (real `ClaudeAgent`, real `BaseAgent.chat`, only the SDK `query` faked). Asserts
  the model saw NOTHING, the turn completed, and the refusal message is the
  resolved i18n string and is neither empty nor the raw key (the measured
  `approveGuardianDenial` trap).
- positive control on the same rig: the same agent without `workflowInvocation`
  DOES reach the model. Without this the absence claim is worthless.
- `mock.module` spreads the real SDK back in and restores it in `afterAll`, per
  the recorded `claude-gateway-adapter.test.ts:79` pattern.

`packages/shared/src/agent/__tests__/runtime-capability-drift.test.ts` (extended)
- **derived** biconditional: a backend overrides `canDispatchWorkflowCommands`
  **iff** it consumes `.workflowInvocation` in CODE. Uses that file's
  `codeOccurrences` (comments and string literals stripped) for P2.122's recorded
  reason — in `pi-agent.ts` the identifier also appears inside the type index
  `ChatOptions['workflowInvocation']`, and a needle satisfied by a type index is
  not a dispatch. Two positive controls: the consuming set is non-empty, and it
  is a proper subset of the runtime vocabulary.
- the base answer is fail-closed and the seam reads it before `chatImpl`.

The pre-existing `pi-agent-slash-workflow-turn.test.ts` pins the other direction:
remove the Pi override and Pi stops dispatching, and it goes red.

---

## 2. Gap 2 — the bundled `code-review` skill · FIXED (skill + tests)

### Measured

`review` is registered at
`/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/pi-agent-server/src/orchestrator/review-tool.ts:368`
and nowhere else; every other occurrence in the tree is a Pi-harness manifest or
descriptor entry. It is in NO session-tool surface — not Claude's in-process one,
not Codex's with a bridge. The skill's opening line was an UNCONDITIONAL
"Run the `review` tool —".

The skill is offered on every runtime: `selectSkillSlashCommands` filters only on
`userInvocable` and override state, and the sole runtime filter applied upstream
is the `/loop` one. `/review` is additionally an alias for it
(`SKILL_SLASH_COMMAND_ALIASES`: `{ alias: 'review', skill: 'code-review' }`).

### Decision: implement, do not gate

This is the gap where withdrawing would be the WRONG answer. A user typing
`/code-review` on Claude expects a code review, and a code review is entirely
achievable there: compute the diff with git, read it, and report through
`ReportFindings` — which I verified IS present on every runtime including the
thinnest (codex, `externalStandaloneOnly` with no bridge). Only the *mechanism*
(a spawned reviewer agent over a host-computed diff) is Pi's; the deliverable is
not. Gating it off would remove a working capability.

Upstream models exactly this shape for a bundled command with a tool
prerequisite — `workflows.md#bundled-workflows`, the `/deep-research` row:
"Requires the [WebSearch tool](/docs/en/tools-reference#websearch-tool-behavior)
to be available". And `skills.md#skill-content-lifecycle` is why the condition
belongs in the skill BODY: "Claude Code does not re-read the skill file on later
turns, so write guidance that should apply throughout a task as standing
instructions rather than one-time steps." Category **(b)**.

### What landed

`/Users/i.i.gavrikov/Desktop/work/nessy-desktop/apps/electron/resources/skills/code-review/SKILL.md`

- The opening instruction is now conditional ("When the `review` tool is in your
  tool list, run it"), followed by an explicit statement that it ships with Pi
  only and three prohibitions: do not call it, do not report the command as
  unavailable, **do not answer as though a review had run**.
- New closing section "Reviewing without the `review` tool": a target→`git diff`
  table covering all six documented targets, the same scope rule (defects the
  change INTRODUCED; cleanups never decisive alone), read-only during review, and
  reporting through `ReportFindings`. Says once, plainly, that the reviewer agent
  is not available here.
- Two in-place notes so the fallback is not orphaned: `effort` and the free-text
  `instructions` note both state their tool-less equivalent.

### Tests

`packages/shared/src/skills/__tests__/bundled-skill-tool-availability.test.ts` (new)

Every "this tool is missing" premise is DERIVED from `getSessionToolNames(...)`
at test time, never transcribed — so the day `review` becomes cross-runtime, the
row asserting its absence fails and the fallback can be retired deliberately
instead of rotting into a lie.

- `review` absent from the default (Claude) surface and from codex-with-bridge;
  positive control that the sets are populated and the membership test does
  answer `true` for something.
- `ReportFindings` present on the default surface AND on codex without a bridge —
  the fallback is a real path, not a second dead end.
- the skill states the conditional, carries the fallback section, and routes it
  through `git diff` + `ReportFindings`.

### Caveat that the fix cannot cover — flagging it explicitly

`packages/shared/src/skills/seed.ts` seeds bundled skills **once, by slug
existence**, with no version-driven re-seed ("If `<skillsRoot>/<slug>/` already
exists we leave it completely untouched"). So this fix reaches NEW profiles only.
Every existing profile keeps the broken `code-review` skill until the user
deletes `~/.nessy-agent/skills/code-review/`. That is a product decision, not a
code one, and it is outside this lane; it should be a release-note line.

---

## 3. Gap 3 — `/loop` on a bridge-less codex session · MEASURED REACHABLE; gate is out of zone

### The row calls this latent. It is not.

The offer is gated — `withoutLoopSkillWhereCronToolsAreAbsent` /
`cronToolsAbsentFor` in `SessionManager.ts` — but on the **runtime**, and
`codex-runtime` is in `SCHEDULED_DELIVERY_RUNTIMES`, so the gate answers "keep the
skill" for every codex session. The tool half is gated on something else
entirely: `hostCallbackBridge = Boolean(config.hostCallbackPort)`
(`packages/session-mcp-server/src/index.ts`), fed by `--host-callback-port`,
which `CodexAgent.buildSessionMcpSpec` emits only when a bridge actually started.

The two can disagree, and the code that makes them disagree says so in its own
words. `packages/shared/src/agent/codex-agent.ts`, `startCallbackBridge`:

> "A failure here is NOT fatal: the session still runs, with the pre-T5 tool
> surface, and the reason goes to the diagnostic channel."

and its catch logs

> `[codex-callback-bridge] failed to start; scheduling tools stay unavailable this session`

So: bridge start throws (a loopback bind failure is the obvious trigger — note
the recorded `ulimit -n` floor of 256 for Electron) → no `--host-callback-port` →
`CronCreate`, `CronList`, `CronDelete` and `ScheduleWakeup` are filtered out of
the surface → **and `/loop` is still offered**. That is the RTS-11 failure verbatim,
one layer down: nothing errors, and the model answers as though it had scheduled
something.

I verified the derived half mechanically (new test): every member of
`CRON_TOOL_NAMES` is absent from `getSessionToolNames({ externalStandaloneOnly: true })`
and present in `getSessionToolNames({ externalStandaloneOnly: true, hostCallbackBridge: true })`.

### What I did NOT do, and why

The correct gate makes the OFFER track the live bridge rather than the runtime.
That requires (i) `CodexAgent` to expose its bridge state and (ii)
`cronToolsAbsentFor` / its three call sites in `SessionManager` to read it. Both
files are off-limits to this lane (`SessionManager.ts` explicitly; `codex-agent.ts`
explicitly). **Per the standing rule I stopped rather than reaching across.**

### What I did do — and its exact status

`/Users/i.i.gavrikov/Desktop/work/nessy-desktop/apps/electron/resources/skills/loop/SKILL.md`
now opens with "First: check that this session can schedule": if the four cron
tools are not in the tool list, say so in one line and stop — do not describe a
schedule you did not create, and do not substitute a sleep, a poll, or a promise
to continue later, because nothing will wake you.

**This is a mitigation, not the gate.** It is the model-facing implementation of
the command (a SKILL.md is the only executable thing a skill has), so it is not
merely "documentation saying so" — but it is advisory, and it inherits the same
seed-once caveat as §2. The hard gate is owed.

Its test half is derived rather than transcribed: the guard must name every
member of `CRON_TOOL_NAMES`, so adding a fifth cron tool fails the row instead of
leaving the guard quietly incomplete.

### Proposed gate for the SessionManager lane

1. `CodexAgent` exposes `hasHostCallbackBridge(): boolean` (it already holds the
   handle `startCallbackBridge` returns).
2. `cronToolsAbsentFor(provider)` gains a second, optional input — the session's
   live scheduling-tool availability — and answers `true` for a codex session
   whose bridge is down.
3. One predicate covers all of it. Enumerated NUL-safe (`rg --text`), it has
   exactly **three** readers, and the third is outside `SessionManager.ts`:
   - `SessionManager.ts:548` — `withoutLoopSkillWhereCronToolsAreAbsent`, serving
     the `/slug` selection and the model-facing turn-runtime view;
   - `packages/server-core/src/handlers/rpc/capabilities.ts:188` — the composer
     catalog, which is the list the palette actually renders, and the one RTS-11
     was measured on.

   `capabilities.ts` is itself a NUL-carrying file, so it is invisible to a
   default `grep` sweep — worth saying out loud to whoever picks this up.

---

## Scope, isolation and gates

Files changed (all committed by explicit pathspec):

| File | Change |
| :--- | :--- |
| `packages/shared/src/agent/base-agent.ts` | predicate + claiming arm at the `chat()` seam |
| `packages/shared/src/agent/pi-agent.ts` | the `true` override |
| `packages/shared/src/i18n/locales/en.json`, `ru.json` | one key each |
| `apps/electron/resources/skills/code-review/SKILL.md` | conditional + fallback section |
| `apps/electron/resources/skills/loop/SKILL.md` | cannot-schedule guard |
| `packages/shared/src/agent/__tests__/workflow-command-runtime-gate.test.ts` | new |
| `packages/shared/src/agent/__tests__/runtime-capability-drift.test.ts` | appended describe |
| `packages/shared/src/skills/__tests__/bundled-skill-tool-availability.test.ts` | new |

**Zone deviation, declared:** the brief's zone lists `pi-agent.ts`, a
`tool-defs.ts` that does not exist, the bundled skills, and tests. I additionally
edited **`base-agent.ts`** and the two locale files. `base-agent.ts` is the only
place a gate for the *other* runtimes can live — `pi-agent.ts` alone cannot gate
Pi's siblings — and it is the file the `/approve` precedent this row points at
put its own arm in. It is not on the off-limits list, and none of the four live
lanes (`permission-dsl.ts`, Pi child-admission, storage plugin-data, Windows path
classifier) is in it. Flagging it rather than assuming it was fine.

Gates run and their contracts:

| Command | Contract it proves | Result |
| :--- | :--- | :--- |
| `bun run typecheck:shared` | the new override matches the base signature; the tests compile | clean |
| `npx eslint` on the 5 changed/added TS files | style/lint on changed files | clean |
| `git diff --check` | no whitespace damage | clean |
| `bun run lint:i18n:sorted` / `lint:i18n:parity` | the new key is sorted and in ALL locales | clean, 2369 keys each |
| `bun test` (mutex, 4 files) | see below | see below |

**No full repo suite** — implementation-first verification budget.

### Test result

`bun scripts/bun-test-lock.ts run --label P2.212-gate -- bun test` over
`workflow-command-runtime-gate.test.ts`, `runtime-capability-drift.test.ts`,
`pi-agent-slash-workflow-turn.test.ts`, `bundled-skill-tool-availability.test.ts`:

```
39 pass · 1 todo · 0 fail · 144 expect() calls · 40 tests across 4 files
```

The `1 todo` is pre-existing in `runtime-capability-drift.test.ts`.

### Proving the fix by breaking it

Both re-breaks ran INSIDE the mutex, via a wrapper that reverts, tests and
restores on every exit path — so the broken state never existed while another
lane could run tests or commit a pathspec. Both restored clean (verified with
`git status --porcelain` scoped to the paths, and again afterwards against the
commit).

**Re-break 1 — revert all four implementation files to the commit's parent,
keep every test at HEAD: 5 fail** (from 0):

| Failing test | Pins |
| :--- | :--- |
| `a workflow command … > refuses the turn and never sends the [workflow:…] marker` | gap 1, behaviourally — the literal reached the model again, 32 prompt lines |
| `a backend claims workflow dispatch iff it consumes the invocation > the claim and the consumption are the same set` | gap 1, derived |
| `… > the base answer is fail-closed and the seam reads it before chatImpl` | gap 1, seam wiring |
| `the code-review skill … > the skill states the fallback rather than instructing an unconditional call` | gap 2 |
| `the loop skill … > the skill refuses instead of describing a schedule it did not create` | gap 3 mitigation |

The positive control passed throughout, so the rig was live for every one.

`pi-agent-slash-workflow-turn.test.ts` was NOT among the five, and that is
correct rather than a hole: a full revert removes the gate entirely, and the
pre-fix Pi path was already right. So I measured the other direction too.

**Re-break 2 — keep the gate, flip ONLY `PiAgent.canDispatchWorkflowCommands`
from `true` to `false`: 1 fail**, `PiAgent slash workflow production turn >
completes the turn after workflow_execute_result` — the pre-existing suite. The
derived biconditional correctly stayed green (it counts occurrences, not the
value), which is exactly the division of labour intended: the drift row pins
*who claims*, the production turn pins *that the claim is true*.

Every fix is therefore pinned, and in both directions.

### Two process failures of my own, recorded

1. **My first re-break silently did nothing and reported a pass.** I used
   `HEAD~1` as the pre-fix ref; four other lanes had committed on top of mine in
   the meantime, so `HEAD~1` was no longer my parent and the "revert" rewrote the
   files with their own content. The run came back `39 pass / 0 fail` — a check
   that never ran, reading as a passed one. It was caught only because the
   wrapper echoed a sanity grep before testing. Both re-breaks now pin the
   explicit SHA (`fecfe1d7c^`). Worth generalising: **on a shared branch under
   concurrent lanes, never use a relative ref.**
2. **My first restore corrupted a file.** I backed the four files up by
   `basename`, and both SKILL.md files collided on `keep-SKILL.md`, so
   `code-review/SKILL.md` was restored with the loop skill's contents. Caught by
   the scoped `git status`, and repaired from the commit. This is the reason I
   committed *before* re-breaking rather than after.

## Concerns

1. **The menu row for `/workflow-name` still stands on claude and codex.** The
   send is now gated and tested, but the composer still lists the command, and
   the withdrawal needs `SessionManager.loadSessionCustomSlashCommands` +
   `listCustomSlashCommandSummaries` — off-limits to this lane. I consider the
   seam gate the load-bearing half and the listing the cosmetic one, but the row
   said "do not leave the offer standing" and half of that is owed. Sites named
   in §1.

2. **Gap 3 has no gate — only a skill-level refusal.** It is reachable, not
   latent, and the honest position is that this lane mitigated it and did not
   close it. Closing it needs `codex-agent.ts` and `SessionManager.ts`, both
   explicitly off-limits, so I stopped rather than reached across. Proposed
   design in §3.

3. **A comment that landed one commit before mine now asserts the optimistic
   version of gap 3.** `ec7e24a51` (P2.211) rewrote `capabilities.ts:165` to say
   "T5 landed, a shipping codex spawn carries `--host-callback-port`, and the four
   cron tools reach it over that bridge." That is true of a spawn whose bridge
   started, and `CodexAgent.startCallbackBridge` is documented as failing
   non-fatally. The corrected comment is not wrong so much as unconditional, and
   whoever takes gap 3 should fix it in the same pass.

4. **Neither skill fix reaches an existing profile.** `ensureBundledSkills` seeds
   once by slug existence with no re-seed, so every current install keeps the old
   `code-review` and `loop` skills. This is the single biggest limit on §2 and
   §3, it is a product decision rather than a code one, and it wants a
   release-note line.

5. **Zone deviation: `base-agent.ts`.** Declared above; not on the off-limits
   list, not held by any of the four live lanes, and the only place a gate for
   Pi's siblings can live. Flagging rather than assuming.

6. **`error` vs `info` for the refusal.** I chose `error` because the turn does
   not happen, and verified it survives `SessionManager`'s three gates and
   reaches the transcript. If the house prefers `/approve`'s `info` for a
   "nothing to do here" answer, it is a one-line change plus the test's event
   filter.

7. **The `bun test` mutex was held for ~28 minutes at one point** by
   `P2.85-attrib2`. I ran four locked runs total and kept each narrow (3-4 files);
   no full repo suite, per the implementation-first budget. The unlocked gates
   (`typecheck:shared`, eslint, both i18n lints, `git diff --check`) were run
   outside it.
