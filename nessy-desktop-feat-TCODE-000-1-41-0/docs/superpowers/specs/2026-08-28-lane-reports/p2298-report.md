# P2.298 + P2.299 + P2.300 — report

**Status:** DONE, all three rows. Commit `0348ffc5f`.
**Base SHA recorded before starting:** `f8d4d505664253f8ac72e75749b033940519e797`.
**Gate summary:** 32 pass / 0 fail on the two seam files; 109 pass / 0 fail / 1 todo
on six affected contract files; `typecheck:shared` 0 errors; eslint 0/0 over six
files; `git diff --check` clean. Re-break against the absolute base SHA: 6 fail /
5 pass, all six predicted.

---

## 1. What was reproduced, before anything was changed

The sibling lane's residue pin was already the reproduction, and it passed at the
base SHA — which is the defect stated positively:

```
bun scripts/bun-test-lock.ts run --label P2.298-repro -- \
  bun test …/session-command-out-of-band-seam.test.ts
→ 20 pass / 0 fail / 80 expect() calls · Ran 20 tests across 1 file. [107.36s]
```

Those 20 include `still routes /compact and /subtask into chatImpl on <backend>`
for all four backends. So at `f8d4d5056`, `/subtask draft the tests` reached
`chatImpl` **bare** on Claude, Codex and Nestor Cloud, and `/compact keep the
decisions` reached it on Nestor Cloud — each with no arm waiting for it:

- `nestor-cloud-agent.ts` `chatImpl` has no `parseSessionCommand` call at all; the
  message becomes `turn.run(turnMessage)`. Both commands went to the cloud model.
- `claude-agent.ts` claims only `SDK_SLASH_COMMANDS = ['compact']`; everything
  else takes `liveInput.write(this.wrapUserText(this.buildTextPrompt(…)))`.
- `codex-agent.ts` claims only `sessionCommand?.kind === 'compact'`; the rest
  reach `turn/start`.

**P2.299's second half — "declared unavailable and reachable anyway" — confirmed
at the source, in both channels:**

- the declaration: `composer-capabilities.ts` `resolveContextUsageCapability`,
  `nestor-cloud-agent` arm → `compact: { manual: false, structured: false }`.
- the renderer HONOURS it for the menu:
  `apps/electron/src/renderer/components/app-shell/input/slash-command-actions.ts`
  — `if (commandId === 'compact' && handlers.contextUsageCapability?.compact?.manual === false) { return false }`.
- and it cannot see the typed form, by its own comment:
  `typedOutOfBandCommandSubmission`'s docblock says "`/clear`, `/compact` and
  `/subtask` return null here because they ride the normal message path."

So the user is refused in the menu and answered by a model in the composer. That
is the row's framing, measured, not assumed.

---

## 2. The fix, and the three judgements inside it

### 2.1 The shape: a predicate, not a `describeQuota`-style generator

The brief prescribed "the `describeQuota` shape: a base default plus a backend
override", and that is what landed — but the override answers a narrower question
than `describeQuota()` does, for a **measured** reason:

> `pi-agent.ts` `chatImpl` classifies at the top and dispatches at the bottom, and
> its own comment says why: "Dispatched further down, **after the subprocess is
> up** and the session-start hooks have run." `requestSubtaskFork` is
> `this.send({ type: 'subtask_start', … })` — an RPC to that subprocess.

A `describeSubtask()` generator overridden by `PiAgent` would have been answered
**at the seam**, where `chatImpl` has not run and `ensureSubprocess()` has not been
called. Pi's `/subtask` on a fresh session would have failed with "The fork was not
started: …". So the override is:

```ts
protected canForkConversation(): boolean { return false }   // BaseAgent
protected canCompactContext(): boolean  { return false }   // BaseAgent
```

and the seam reads them:

```ts
if (sessionCommand.kind === 'subtask' && !this.canForkConversation()) { …refuse… }
if (sessionCommand.kind === 'compact' && !this.canCompactContext())  { …refuse… }
```

A `true` **lets the command through to `chatImpl` unchanged**. Pi's fork, Pi's
`requestCompact`, Claude's `SDK_SLASH_COMMANDS` branch and codex's
`thread/compact/start` are byte-identical before and after; only the four cells
that had no mechanism change behaviour.

This is not an invention: `BaseAgent.canDispatchWorkflowCommands()` is the same
shape, in the same file, with the same recorded reason, and
`runtime-capability-drift.test.ts` already asserts its claim-iff-mechanism
biconditional. I inherited the sibling lane's refusal to switch on `provider`
inside `base-agent.ts`; the seam still knows nothing about any runtime, and the
new test asserts that (`expect(seam).not.toContain('config.provider')`).

### 2.2 The default direction is `false`, and for `compact` that costs three overrides

This is the one place I did **more** than the brief's "base default plus **a**
backend override" implies, so it is called out rather than buried. `/compact` has
three mechanisms and one gap, so the cheap reading is "base `true`, Nestor
overrides `false`" — one file. I did the opposite: base `false`, with
`canCompactContext()` overridden in `pi-agent.ts`, `claude-agent.ts` and
`codex-agent.ts`.

The reason is that the default does not describe today's four runtimes, it decides
what a **fifth** one does, and the two failure modes are not symmetric:

- default `true`, override forgotten → a bare `/compact` goes to the new backend's
  model **silently**, and its answer is indistinguishable from a compaction that
  produced no notice. That is precisely the defect P2.298/P2.299 exist to remove.
- default `false`, override forgotten → the runtime refuses a command it could
  have served. Visible the first time anyone runs it, and caught by the
  biconditional test before that.

`base-agent.ts`'s own `canDispatchWorkflowCommands` doc states this rule verbatim:
"the safe default when a new backend arrives is 'cannot', because the failure mode
of the other default is silent". Applying it consistently is what makes the three
extra overrides worth their collision risk. Each override sits **directly above the
mechanism that makes it true**, which is the convention `pi-agent.ts` already uses
for workflow dispatch, so the claim and the mechanism cannot drift apart in a diff.

### 2.3 The two rows got different remedies, as instructed

- **P2.298 — the affordance stays.** Nothing was withdrawn from
  `composer-capabilities.ts`, `slash-command-menu.tsx` or `PREFILL_COMMANDS`. The
  upstream sentence was verified on the rendered page, not taken from the brief
  (see §3). Every runtime still offers `/subtask`; three of them now answer it
  instead of forwarding it.
- **P2.299 — the declaration stays.** `compact: { manual: false, structured: false }`
  is untouched and is still the renderer's menu gate. The seam is a **second**
  enforcement point for the same declaration, not a replacement, and
  `base-agent.ts`'s new docblock says so explicitly so nobody later "deduplicates"
  them into one.

### 2.4 P2.300

- `codex-agent.ts` — "Codex has no command branch of its own yet, so nothing
  observably breaks today" is now corrected in place, naming the branch it
  acquired (`thread/compact/start`) and the consequence the old sentence got
  backwards: composition would not make a branch "born dead", it would break a
  **live** one. Its three code line numbers (`base-agent.ts:3311-3322`,
  `claude-agent.ts:1840`/`:1863`, `pi-agent.ts:7044`) were all stale; they are now
  symbol references, with a parenthetical saying why.
- `codex-agent.ts` — the runtime-handoff fall-through list is corrected. After
  P2.292 + P2.298 **no** session command reaches that line on codex from `chat()`:
  seven kinds are answered at the seam, `subtask` is now the eighth, and `compact`
  returns earlier in that same `chatImpl`. The comment now says that, says
  `sessionCommand` there is reachable only by a **direct** `chatImpl` caller, and
  names the event that makes it reachable again (codex claiming
  `canForkConversation()`).
- **Pi's `btw`/`recap`/`heapdump` arms were NOT deleted.** They are unreachable
  from `chat()` and still load-bearing for `runSessionCommand`'s
  narrowing-by-elimination. Note the improvement: Pi's `subtask` arm — the terminal
  one that the elimination narrows down to — is **still reachable in production**,
  because Pi claims the fork. The narrowing is no longer only a compiler
  relationship there.
- **The latent third item is now MOOT, with one exception.** See F3 below: on
  Claude, `/compact` **with an attachment** still goes through `buildTextPrompt`.

---

## 3. Documentation

Row classification: **(b) an upstream contract** for P2.298; **(a) our own
implementation** for the seam mechanics; **`[remote]`, no corpus** for P2.299.

Verified on the RENDERED page, not derived from a slug rule:

```
curl -sS https://code.claude.com/docs/en/sub-agents | grep -o 'id="[^"]*"'
→ id="fork-the-current-conversation"    (present)
```

`sub-agents.md#fork-the-current-conversation`, verbatim:

> "You can start a fork yourself with `/subtask` followed by a task, whether or
> not fork mode is on."

Two neighbouring sentences on the same page that bear on the row and were **not**
acted on (recorded so they are not rediscovered):

> "Run a forked subagent with `/subtask`, which requires Claude Code v2.1.212 or
> later. When agent view is turned off, `/subtask` isn't available and `/fork`
> starts the forked subagent instead"

— i.e. upstream itself has a state in which `/subtask` "isn't available", which is
further support for an honest refusal over silent forwarding; and

> "An in-session fork you start with `/subtask` takes a slot while it runs and is
> never blocked by the limit."

No page governs P2.299: the remote agent has no external corpus, and the fact that
decides the row (the cloud runtime exposes no manual compaction) is ours.

---

## 4. Gates — with proof of work

| Gate | Command | Proof quoted from the output |
| --- | --- | --- |
| Reproduction at base SHA | `… -- bun test …/session-command-out-of-band-seam.test.ts` | `20 pass / 0 fail / 80 expect() calls · Ran 20 tests across 1 file. [107.36s]` |
| New + amended seam tests, WHOLE | `… --label P2.298 -- bun test …/session-command-runtime-capability-seam.test.ts …/session-command-out-of-band-seam.test.ts` | `32 pass / 0 fail / 122 expect() calls · Ran 32 tests across 2 files. [114.57s]` |
| New tests, **filtered by name** (the i18next rig hazard) | same file, `-t P2.298` / `-t P2.299` / `-t swallowers` / `-t "same set"` | `10 pass / 0 fail · Ran 10`, `7 pass / 0 fail · Ran 7`, `3 pass / 0 fail · Ran 3`, `2 pass / 0 fail · Ran 2` — **filtered agrees with whole**, and no filter matched zero |
| Directly affected contract tests | `… -- bun test session-command-seam claude-slash-command-seam codex-context-parts codex-turn-steer runtime-capability-drift session-command-host-path` | `109 pass / 0 fail / 1 todo · Ran 110 tests across 6 files. [1.57s]` |
| Package typecheck | `bun run typecheck:shared` | exit 0; `grep -c "error TS"` = **0**. (`packages/shared/tsconfig.json` includes `src/**/*`, so the new test file was typechecked too.) |
| eslint **from the package dir** | `cd packages/shared && bunx eslint --format json <6 files>` | `files linted = 6`; `errors=0 warnings=0` on every one |
| `git diff --check` | `git diff --check f8d4d5056 0348ffc5f -- <6 paths>` | exit 0, no output |
| i18n parity / sorted | — | **NOT-RUN.** No i18n key was added or touched: both new arms are plain literals, deliberately, for the P2.278 reason (`t()` on an uninitialised i18next yields `undefined`, and an empty info line is indistinguishable from a command that did nothing). Nothing this row changed can move `lint:i18n:parity` or `lint:i18n:sorted`. |
| Full repo suite / builds / packaging / live | — | **NOT-RUN** — verification-wave work, and no trigger was hit (no wire/schema, auth, isolation, migration, lock or build-infra change). |

### The filtered/whole agreement, stated plainly

`base-agent.ts`'s seam initialises i18next process-wide from the `/approve` and
`/advisor` arms, so a per-command assertion can pass because a neighbour ran first.
**I ran this file whole and filtered by name, and both are reported above.** The
`-t P2.299` run exercises the `/compact` refusal with neither the `/approve` nor
the `/advisor` arm having executed, and it passes — so the arm's message is not a
neighbour's side effect. (It cannot be: both arms emit plain literals.)

### Re-break, against the absolute recorded SHA

`git show f8d4d505664253f8ac72e75749b033940519e797:packages/shared/src/agent/base-agent.ts`
was written over the working file (`git show > file`, which does **not** rewrite
the index — `git checkout <sha> -- <path>` does, and that is the trap the standing
rules name), the new test file was run unchanged, and the file was restored from
`HEAD` in the same command. `HEAD~1` was never used; HEAD had already moved twice
under other lanes while I worked (`5a58014bf`, then `e3f0a485c` landed after my
commit).

```
6 fail / 5 pass · Ran 11 tests across 1 file. [796.00ms]
```

The six are exactly the predicted set, and nothing else:

- `answers /subtask at the seam on Claude` / `on Codex` / `on Nestor Cloud`
- `a bare /subtask with no task is refused the same way…`
- `answers /compact at the seam on Nestor Cloud`
- `the base answers are fail-closed and the seam reads them before chatImpl`

The five behavioural failures all raise `error: chatImpl must not run: /subtask
draft the tests` (and the `/compact` equivalent) from the harness — i.e. the
command reached the backend, which is the defect. The five that still PASS are the
three prose-boundary cases and the two biconditional rows, which is correct: I
reverted only `base-agent.ts`, so the backend overrides and their mechanisms were
still in agreement.

Afterwards: `git diff HEAD -- base-agent.ts` empty, `git status --porcelain` shows
nothing for that path — no phantom index entry, no revert left behind.

### Commit isolation

`git commit <pathspec>` with all six files named. `git show --stat --oneline
0348ffc5f` reports exactly those six, `633 insertions(+), 42 deletions(-)`,
nothing else. Before committing I listed **every** `^-` line in the diff (42) and
confirmed each was one of my own removals — no other lane's work rode along. Seven
lanes were live; `packages/shared/src/agent/pi-harness/*` was modified by another
lane throughout and was never staged.

---

## 5. The tests, and what makes them falsifiable

**`__tests__/session-command-runtime-capability-seam.test.ts` (new, 11 tests).**
Four REAL backend classes, real `BaseAgent.chat`, real `parseSessionCommand`; only
`chatImpl` is replaced — with a **thrower** for the refusal cases, so a regression
that routes the command back into a backend fails loudly instead of hanging on an
absent transport. A `TestAgent` double would have passed by construction and proved
nothing about the runtimes the defect was measured on.

- 3 + 1 positives for `/subtask` (Claude, Codex, Nestor, plus the bare no-task
  form), 1 for `/compact` (Nestor). Each asserts `chatImpl` was **not** entered,
  the event shape is exactly `['info','complete']`, the message is a non-empty
  string naming the command, and — for both — that it does **not** start with
  `Compacted`, because `SessionManager` keys `compaction_complete` off that prefix
  and a refusal wearing the success wording would report a compaction that never
  happened.
- 3 boundaries: prose that merely mentions either command still reaches the
  backend, so neither arm is a swallower.
- 3 drift rows, in `runtime-capability-drift.test.ts`'s P2.212 shape: the set of
  backends whose source holds a **mechanism** must equal the set that spells the
  **override**, for compaction and for forks, with positive controls in both
  directions (non-empty, and a proper subset so the row keeps a negative side);
  plus source pins that the base answers are fail-closed, that the seam reads them,
  and that no `provider` switch crept into the seam.

One deliberate difference from the drift file's helper is documented in the file:
mine strips comments but **keeps string literals**, because two of the three
compaction mechanisms are reached through a string (`'thread/compact/start'`,
`'subtask_start'`) and `codeOccurrences` would have made them invisible — the
biconditional would then have passed by vacuum. The comment strip is still
required, because every needle is also *named in a comment* in a file that does not
implement it (I verified: `SDK_SLASH_COMMANDS` occurs once in `codex-agent.ts`, in
a comment I wrote).

**`__tests__/session-command-out-of-band-seam.test.ts` (amended).** Its residue
block asserted that `/compact` and `/subtask` reach `chatImpl` on *every* backend —
which was the defect stated as an invariant. It is now the matrix itself:

```
Pi:           ['/compact keep the decisions', '/subtask draft the tests']
Claude:       ['/compact keep the decisions']
Codex:        ['/compact keep the decisions']
Nestor Cloud: []
```

with a guard that the four rows are the four backends and that the table is not
vacuous in either direction. It is transcribed on purpose — it **is** the
acceptance criterion of P2.292/P2.298/P2.299, so it must fail when the behaviour
moves, including when the move is an improvement: a backend that gains a fork adds
`/subtask` to its row in the same commit as the `canForkConversation()` override.

---

## 6. FINDINGS — each tagged, each with its kind

### F1 · `/subtask` reached the model on three of four runtimes — **FIXED in `0348ffc5f`**
`[doc:claude]` · **bug**
`sub-agents.md#fork-the-current-conversation`: *"You can start a fork yourself with
`/subtask` followed by a task, whether or not fork mode is on."* The composer never
excludes it and only `PiAgent.requestSubtaskFork` exists. Claude, Codex and Nestor
Cloud now answer it at the seam; the affordance is untouched.

### F2 · A typed `/compact` reached the cloud model although the capability is declared unavailable — **FIXED in `0348ffc5f`**
`[remote]` · **bug**
Not "offered without an implementation" but "declared unavailable and reachable
anyway": the gate existed on the presentation layer and the seam had none. The
declaration is unchanged and is now enforced in both channels.

### F3 · On Claude, `/compact` **with an attachment** still goes through `buildTextPrompt`
`[doc:none]` · **bug (latent)** — reported, NOT fixed, out of zone by intent
The sibling lane's F5 said Claude re-composes the context the seam deliberately
withheld, and that it would become moot the moment P2.298 landed. **It is now moot
for every kind except one.** `claude-agent.ts`:

```ts
const isSlashCommand = commandName &&
  SDK_SLASH_COMMANDS.includes(commandName as typeof SDK_SLASH_COMMANDS[number]) &&
  !attachments?.length;
```

`BaseAgent.chat` forwards `attachments` into `chatImpl` on the session-command
path, so a user who attaches a file and types `/compact` gets the composed prompt
— date, `<session_state>`, sources, workspace capabilities — with the slash pushed
off the front, which is the original P2.292 defect shape surviving in one corner.
Everything else on Claude is now claimed: seven kinds at the seam, `subtask` as the
eighth, `compact` (attachment-free) through the SDK branch. Not fixed here because
the right answer is a judgement I should not make inside this row — either the arm
drops the attachments and compacts, or it refuses with a reason — and it is a
behaviour change to a working path, not a gap.

### F4 · The codex "a session command goes out BARE" test no longer covers a reachable path
`[doc:none]` · **never looked at** (consequence of this row) — reported, not acted on
`__tests__/codex-context-parts.test.ts` — *"sends a session command bare, ahead of
the context that would disguise it"* — drives `chatImpl` **directly** (`drain()`
calls `(agent as any).chatImpl(prompt)`), so it still passes and was not touched.
But its subject is `/subtask`, chosen by an earlier row because a codex `/compact`
"is not a turn at all… so it can no longer carry the invariant this test exists
for". After this row, `/subtask` cannot reach codex's `chatImpl` from `chat()`
either — so **no reachable session command carries that invariant on codex any
more**. The test is now a forward guard for the day codex claims
`canForkConversation()`. That is a real, if small, loss of coverage on a
contract this plan has broken twice, and it should be recorded rather than
discovered later; I did not rewrite it because the invariant it pins is still the
right one and there is nothing better to point it at today.

### F5 · `PREFILL_COMMANDS.subtask` still prefills the composer on runtimes that refuse the command
`[doc:claude]` · **never looked at** — reported, deliberately not changed
`slash-command-actions.ts` prefills `/subtask ` into the composer on every runtime.
Post-fix the user types a task, sends, and gets an honest one-line refusal instead
of a model's guess — which is the row's intent, and the upstream sentence says the
affordance should exist. But there is a middle option nobody has costed: the menu
row could carry the same "unavailable on this runtime" affordance `/compact`
already has, driven by the capability the agent now declares. That is a renderer
decision on a surface outside my zone, and it is a UX improvement rather than a
correctness gap — recorded so it is a decision rather than an oversight.

### F6 · Two stale comments in `codex-agent.ts` — **FIXED in `0348ffc5f`**
`[doc:none]` · **bug (documentation-in-code)**
Both corrected in place, as described in §2.4. Worth naming the pattern rather than
just the instances: **both went stale because the code they described moved and the
comment did not, and both carried line numbers that decayed** — the repo's own
recorded trap. The replacements reference symbols, and the second one names the
condition under which it will need revisiting.

---

## 7. Concerns

1. **The `compact` default cost three overrides instead of one** (§2.2). If the
   controller or owner prefers the one-file version (base `true`, Nestor overrides
   `false`), it is a three-line revert plus a needle-list change in the
   biconditional — but I believe the asymmetry argument, and `base-agent.ts`'s own
   docblock already states the rule I applied. Flagging it because it is the one
   place I went beyond the brief's letter.
2. **F3 is a genuine remaining hole**, small and cornered but real, and it is the
   same defect family. It wants an owner decision (drop the attachments, or refuse
   with a reason), not a lane's guess.
3. **F4 is a coverage loss this row caused.** Nothing is broken; a guard simply
   stopped guarding a reachable path. It will matter the moment anyone wires a
   codex fork, which is also exactly when it starts working again.
4. **The behavioural matrix is transcribed, by design.** `REACHES_CHAT_IMPL` is a
   hand-written table, which the drift file's "one rule" forbids for counts. It is
   deliberate here — the table is the acceptance criterion rather than a derived
   fact — but it is the one thing in this commit that a future refactor can make
   wrong by editing the test instead of the code. The claim-iff-mechanism
   biconditional is the derived backstop under it.
5. **Mutex contention was heavy.** Single-file runs took 41 s and 107-114 s where
   an uncontended run of the same file took 0.8-1.6 s; five other labels
   (`P2.296-zone`, `P2.301`, `P2.309`, …) were queued against the lock while I ran.
   Nothing failed and nothing was attributed to my code, but any timing-based
   judgement on this branch today should be treated with suspicion.
6. **No live evidence.** Everything here is unit-level against the real backend
   classes; no packaged build, no CDP case. The four cells are reachable from the
   composer on a live session (`SessionManager.sendMessage` passes `/compact` and
   `/subtask` straight through — it throws only on `btw`/`recap`/`heapdump`), so a
   live confirmation on a Nestor Cloud session and a Claude session is cheap and
   would be worth one checklist row at the next close-out.
