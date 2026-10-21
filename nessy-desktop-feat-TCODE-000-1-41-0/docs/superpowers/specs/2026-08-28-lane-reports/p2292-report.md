# P2.292 — report

**Status:** DONE, with a prominent premise correction. Commit `e797a0ff7`.
**Base SHA recorded before starting:** `f58f66a36`.

---

## 1. THE MATRIX — the deliverable

Nine `ParsedSessionCommand` kinds. Four are answered at the `BaseAgent.chat`
seam (`clear`, `quota`, `advisor`, `approve`) — the row is right about that.
The remaining five fall through to `chatImpl`. Measured against all four
backends, **as they stood at `f58f66a36`:**

| kind | Pi | Claude | Codex | Nestor Cloud | genuinely per-backend? |
| --- | --- | --- | --- | --- | --- |
| `compact` | ✅ real | ✅ real | ✅ real | ❌ **model** | **YES** |
| `subtask` | ✅ real | ❌ **model** | ❌ **model** | ❌ **model** | **YES** |
| `btw` | ✅ backstop | ❌ **model** | ❌ **model** | ❌ **model** | **NO** |
| `recap` | ✅ backstop | ❌ **model** | ❌ **model** | ❌ **model** | **NO** |
| `heapdump` | ✅ backstop | ❌ **model** | ❌ **model** | ❌ **model** | **NO** |

❌ **model** = the command reaches `chatImpl`, finds no arm, and is sent to the
model. **11 of the 20 cells were empty.**

### Per-cell evidence (all absolute paths, all read at `f58f66a36`)

- **Pi** — `packages/shared/src/agent/pi-agent.ts:8794` dispatches into
  `runSessionCommand` (`:8461`), which has an arm for all nine kinds:
  `compact` → real `requestCompact` (`:8462`), `subtask` → real
  `requestSubtaskFork` (`:8546`), and `btw`/`recap` (`:8484`),
  `heapdump` (`:8506`) as info-only backstops whose own comments say
  "SessionManager.sendMessage rejects them before a turn exists, so this arm is
  a backstop for direct callers" and "the same defensive backstop as `/clear`
  above".
- **Claude** — `packages/shared/src/agent/claude-agent.ts:3459`
  `const SDK_SLASH_COMMANDS = ['compact'] as const;` is the whole command
  branch. Everything else takes the `else` at `:3576`:
  `liveInput.write(this.wrapUserText(this.buildTextPrompt(effectiveUserMessage, attachments)))`.
- **Codex** — `packages/shared/src/agent/codex-agent.ts:2855`
  (`sessionCommand?.kind === 'compact'` → `thread/compact/start`) is the only
  arm. The file says so itself at `:2876`: *"`/compact` and `/clear` return
  earlier; `/subtask`, `/btw`, `/recap`, `/heapdump` do not"* — i.e. those four
  fall through to `turn/start` at `:2892`.
- **Nestor Cloud** — `packages/shared/src/agent/nestor-cloud-agent.ts:106`
  `chatImpl` contains **no** `parseSessionCommand` call and no command branch at
  all (`git grep parseSessionCommand` returns zero hits in that file). All five
  become `turn.run(turnMessage)` at `:218`.
- **Population** — `git grep "extends BaseAgent"` returns exactly these four
  plus the `TestAgent` double. The matrix is 4 columns, not 5 or 3.

---

## 2. THE SHAPE IS WRONG — the row's premise, corrected

**The row's "the other five are answered inside `chatImpl`, per backend, and
that is legitimate" is true for TWO of the five, not five.**

- `compact` and `subtask` **are** genuinely per-backend. Three distinct
  compaction mechanisms exist (`PiAgent.requestCompact`, Claude's
  `SDK_SLASH_COMMANDS` → resumed one-shot, codex's `thread/compact/start`) and
  exactly one fork mechanism (Pi's `subtask_start` subprocess RPC). A seam arm
  for either would disable all of them.
- `btw`, `recap` and `heapdump` are **not per-backend and never were**. They are
  answered HOST-side, out of band:
  - the renderer routes the typed forms away from `sendMessage`
    (`apps/electron/src/renderer/components/app-shell/input/slash-command-actions.ts:203`
    `typedOutOfBandCommandSubmission`),
  - `packages/server-core/src/sessions/SessionManager.ts:20170` and `:20180`
    **throw** on all three before a turn exists,
  - and the real answers are `SessionManager.askSideQuestion` (`:21810`),
    `generateSessionRecap` (`:21849`) and `heapdump` (`:21918`), none of which
    goes through `agent.chat()` — `BaseAgent.askSideQuestion` (`:4783`) rides
    `queryLlm` and its own doc says it "does not touch `parseSessionCommand`".

  So no runtime should ever see them, Pi's three arms say exactly that, and the
  other three backends simply did not have the backstop.

**So the guard is not 4×5, and building one to that shape would have been the
second wrong invariant on this row.** The correct shape is: three kinds belong
at the seam (one arm, four backends, zero cells to fill), and the fall-through
should carry exactly the two that have real per-runtime implementations.

---

## 3. WHAT I CHANGED (in zone: `base-agent.ts` + a new test file)

`packages/shared/src/agent/base-agent.ts:4363-4416` — one new seam arm claiming
`btw | recap | heapdump`, placed after `/approve` and before the `chatImpl`
fall-through. Details that are deliberate:

- **Pi's own strings, verbatim.** Pi's answers are byte-identical before and
  after; only Claude/Codex/Nestor change behaviour. Pi's arms stay where they
  are as a second-line backstop for a direct `chatImpl` caller and because
  `runSessionCommand`'s narrowing-by-elimination needs them for the compiler.
- **Plain literals, not `t()`.** `describeAdvisor`/`approveGuardianDenial` need
  an `i18n.isInitialized` guard because the headless `nessy-server` entry never
  calls `setupI18n()` and an uninitialised `t()` yields `undefined` — an empty
  info line, indistinguishable from a command that did nothing. A literal cannot
  have that failure mode, and `/clear`'s arm is the precedent. **No new i18n
  keys, so `lint:i18n:parity`/`sorted` are untouched by this change.**
- The fall-through comment now names what is left: `compact` and `subtask`.

`packages/shared/src/agent/__tests__/session-command-out-of-band-seam.test.ts`
(new, 248 lines) — 20 tests over the four REAL backend classes:

1. 12 positives — `/btw`, `/recap`, `/heapdump` answer at the seam on each of
   Pi / Claude / Codex / Nestor Cloud, `chatImpl` never entered, exactly
   `['info','complete']`, message a non-empty string that names the command and
   does not start with `Compacted` (the `compaction_complete` sniffer prefix).
2. 4 negatives/boundaries — prose that merely mentions the commands,
   `/recap the meeting` (argument on an argument-less command) and
   `/heapdump now` all still reach `chatImpl`, so the arm is not a swallower.
3. 4 residue pins — `/compact` and `/subtask` must **still** reach `chatImpl`,
   BARE, on every backend. This is what makes the matrix falsifiable: a sixth
   kind claimed by nobody lands here and this assertion is what has to change.

The real path is exercised: real backend classes, real `BaseAgent.chat`, real
`parseSessionCommand`; only `chatImpl` is replaced (with a thrower for the seam
cases, a recorder for the rest) — the same discriminator
`session-command-seam.test.ts` already uses for `/clear`, `/quota`, `/advisor`
and `/approve`. A `TestAgent` double would have passed by construction and
proved nothing about the runtimes the defect was measured on.

---

## 4. GATES — with proof of work, not exit statuses

| Gate | Command | Proof |
| --- | --- | --- |
| New tests, whole file | `bun scripts/bun-test-lock.ts run --label P2.292 -- bun test …/session-command-out-of-band-seam.test.ts` | `20 pass / 0 fail / 80 expect() calls · Ran 20 tests across 1 file.` |
| New tests, **filtered by name** (the P2.278 rig hazard) | same, `-t "/btw at the seam"`, `-t "/recap at the seam"`, `-t "/heapdump at the seam"`, `-t swallower`, `-t "per-backend kinds"` | `4 pass / 0 fail` each, five filters, 20 total — identical to the whole-file result. **Filtered and whole agree.** |
| Directly affected contract tests | `… -- bun test session-command-seam pi-agent-slash-command claude-slash-command-seam nestor-cloud-agent-clear nestor-cloud-agent-quota advisor-consult-wiring` | `69 pass / 0 fail / 241 expect() calls · Ran 69 tests across 6 files.` |
| Host guard (server-core) | `… -- bun test session-command-host-path.test.ts` | `14 pass / 0 fail / 65 expect() calls · Ran 14 tests across 1 file.` |
| Final combined | `… -- bun test session-command-out-of-band-seam session-command-seam` | `38 pass / 0 fail / 155 expect() calls · Ran 38 tests across 2 files.` |
| Package typecheck | `bun run typecheck:shared` | exit 0; `grep -c "error TS"` = **0** (one real error was caught and fixed first: `rootPath` is not on `Partial<ResolvedWorkspace>`). |
| eslint **from the package dir** | `cd packages/shared && bunx eslint --format json base-agent.ts …out-of-band-seam.test.ts` | JSON: both files present, `errors=0 warnings=0` each, `files linted = 2`. |
| `git diff --check` | on both files | exit 0, no output. |
| Full repo suite / build / packaging | — | **NOT-RUN** — verification-wave work, and no trigger was hit (no wire/schema, auth, migration, lock or build-infra change). |

**Re-break against the absolute recorded SHA.** `git show f58f66a36:base-agent.ts`
was written over the working file (verified byte-identical to the blob), the
final test file was run unchanged, and the result was
`8 pass / 12 fail · Ran 20 tests`. The 12 named failures are exactly the four
backends × three kinds, all with `chatImpl must not run: /btw|/recap|/heapdump`
raised from `base-agent.ts:4363` (the fall-through line at that SHA). The file
was then restored and `git diff --stat f58f66a36` again reports exactly
`53 insertions(+)`. `HEAD~1` was never used — HEAD had already moved to
`8a1c6d310` under other lanes while I worked.

**Commit isolation.** `git commit <pathspec>` with both files named;
`git show --stat --oneline e797a0ff7` reports exactly those two files,
`301 insertions(+)`, nothing else; `git diff --stat f58f66a36 e797a0ff7 --
base-agent.ts` is `53 insertions(+)`, i.e. the committed blob carries my hunk
and no other lane's work.

---

## 5. FINDINGS — tagged and classified

### F1 · The row's 4×5 premise is wrong — only 2 of the 5 kinds are per-backend
`[doc:none]` · **never looked at**
Nobody had checked all four backends, and the check the row proposed
("do all four answer all five?") would have demanded three columns of arms that
should not exist anywhere. Corrected shape is in §2. This is the row's own
requested outcome: the measurement wins over the framing.
**Recorded, and executed in `e797a0ff7`.**

### F2 · `/btw`, `/recap`, `/heapdump` reached the model on 3 of 4 runtimes
`[doc:claude]` · **bug** — **FIXED in `e797a0ff7`**
- `interactive-mode.md#side-questions-with-/btw`: *"The question and answer
  never enter the conversation history."*
- `interactive-mode.md#session-recap`: *"Run `/recap` to generate a summary on
  demand."* (a background generation, not a conversation turn)
- `troubleshooting.md#high-cpu-or-memory-usage`: *"If memory usage stays high
  after these steps, run `/heapdump` to write two files to `~/Desktop`: a
  JavaScript heap snapshot named `<session-id>.heapsnapshot` and a memory
  breakdown named `<session-id>-diagnostics.json`."* — plus *"Claude Code hides
  the command from the command menu; type it in full."*, which is why the typed
  form is the only entry point and the typed form is what leaked.

  (All three anchors taken from the RENDERED pages via `curl … | grep 'id="…"'`,
  per the anchor rule; note `#side-questions-with-/btw` keeps its slash.)

Doubly guarded in the app path, so the exposure was direct callers — a relayed,
headless or legacy sender, a spawned child, a test. Pi's own comments predicted
this exposure and only Pi was protected against it.

### F3 · `/subtask` is offered on all four runtimes and forks only on Pi
`[doc:claude]` · **bug** — **NOT FIXED, needs a file outside my zone**
`sub-agents.md#fork-the-current-conversation`: *"You can start a fork yourself
with `/subtask` followed by a task, whether or not fork mode is on."*
The composer offers it unconditionally —
`slash-command-menu.tsx:146` defines the entry, `composer-capabilities.ts:255`
never excludes `subtask` (the only exclusion lists are `['btw','recap']` for
nestor and `['quota']` otherwise), and `slash-command-actions.ts:48`
`PREFILL_COMMANDS.subtask` prefills the composer on every runtime. Only
`PiAgent.requestSubtaskFork` exists. On Claude, Codex and Nestor Cloud the
command is sent to the model.
**Recommended shape** (the pattern this codebase already uses for exactly this
situation, `/quota`): a base `describeSubtask()` on `BaseAgent` that reports
"conversation forks are not available on this runtime", claimed at the seam,
with `PiAgent` overriding it to fork. That needs `base-agent.ts` **and**
`pi-agent.ts` in one commit, so it is one row, not two. I deliberately did NOT
switch on `this.config.provider` inside `base-agent.ts` to fake it — that would
duplicate `composer-capabilities.ts`'s knowledge in the wrong place and would
silently keep refusing once codex grows a fork (`thread/fork` already exists in
its client).

### F4 · `/compact` has no arm on Nestor Cloud and reaches the cloud model
`[remote]` · **bug** — **NOT FIXED, needs `nestor-cloud-agent.ts`**
`composer-capabilities.ts:128` already declares the truth —
`compact: { manual: false, structured: false }` for `nestor-cloud-agent` — and
the renderer honours it (`slash-command-actions.ts:177` refuses a MENU
dispatch). But a **typed** `/compact` is not menu-dispatched: it goes
composer → `sendMessage` → `chat` → `chatImpl` → `turn.run('/compact')`. The
honest answer already exists as a declared capability; it just is not wired to
an arm. Same one-row shape as F3.

### F5 · Claude re-composes the context the seam deliberately withheld
`[doc:none]` · **bug (latent)** — reported, not fixed
`base-agent.ts` passes a session command to `chatImpl` **bare** precisely so the
leading slash survives ("it must reach the backend as the bare command"). On
Claude only `compact` takes the `SDK_SLASH_COMMANDS` path; every other session
command falls to `claude-agent.ts:3576` and is run through `buildTextPrompt`,
which prepends the date, `<session_state>`, sources and workspace capabilities.
So the seam's stated contract is defeated for exactly the kinds that have no
arm. After `e797a0ff7` this affects only `/subtask` — it becomes moot the
moment F3 lands, which is why I am reporting it attached to F3 rather than
opening it separately.

### F6 · Two stale comments, both in code that is now correct
`[doc:none]` · **bug (documentation-in-code)** — reported, not fixed (outside zone)
- `codex-agent.ts:2701-2703`: *"Codex has no command branch of its own yet, so
  nothing observably breaks today"* — codex grew one at `:2855`.
- `codex-agent.ts:2876`'s list is now wrong in my favour: after `e797a0ff7`,
  `/btw`, `/recap` and `/heapdump` no longer reach that line (only `/subtask`
  does). Worth a one-line correction whenever codex-agent.ts is next opened.

---

## 6. Documentation classification for this row

The row was pre-classified **(a) our own implementation**, and that is right for
the *seam mechanics* — no upstream page decides where in our class hierarchy a
command is answered. But it is **not** right for the commands themselves:
`/btw`, `/recap`, `/heapdump` and `/subtask` are all Claude-documented, and the
"never enters conversation history" property F2 restores is an upstream
contract, not our invention. I have cited the pages in §5 accordingly. F4 is
`[remote]` and has no corpus at all.

---

## 7. Concerns

1. **The row is only 9/11 closed.** F3 (`/subtask` × 3 backends) and F4
   (`/compact` × Nestor) are 4 genuinely empty cells I could not fill without
   `pi-agent.ts` / `nestor-cloud-agent.ts`. Both have a clean, already-precedented
   shape (`describeQuota`'s base-default-plus-override) and both are one commit
   each. Please open them; the matrix in §1 is the acceptance criterion.
2. **Pi's three arms are now unreachable from `chat()`.** They remain correct
   and load-bearing for the compiler (`runSessionCommand` narrows by
   elimination), and I did not touch `pi-agent.ts`. But a future reader may see
   them as dead. The seam comment names them explicitly so the relationship is
   discoverable from either end.
3. **The five filters × 4 tests do not prove i18next independence for the
   file's *neighbours*.** My three arms never call `t()`, so they cannot have
   that failure mode; but `session-command-seam.test.ts`'s `/advisor` case still
   depends on the `/approve` case initialising i18next in a whole-file run, and
   that pre-existing coupling is untouched by this row.
4. **`bun test` mutex contention was visible.** Two of my runs took 18-27 s for
   20 tests where an uncontended run took 2.8 s. Nothing failed and nothing was
   attributed to my code, but timing-based judgements on this branch today
   should be treated with suspicion.
