# Cross-runtime history carry — a switch hands over the conversation, not a summary of it

## Why this plan exists

Session runtime switching shipped in 1.27.0
(`docs/superpowers/plans/2026-08-14-session-runtime-switching.md`, closed — its
Tracker holds 20 rows, 19 `✅` and T19 `➡️ MOVED` to
`2026-08-15-base-context-diet.md`). What crosses a switch today is **text only**:
`getRuntimeHandoffMessages` (`packages/server-core/src/sessions/SessionManager.ts:14054-14096`)
keeps only `role === 'user' | 'assistant'` rows and then filters `!m.isIntermediate`,
so **every `role: 'tool'` row is dropped**, and
`buildRuntimeHandoffContext` (`packages/shared/src/agent/base-agent.ts:329`)
takes `messages.slice(-24)` and truncates each entry at 1200 characters.

Measured on the real corpus (677 sessions on the owner's machine, re-derived
independently three times): the text handoff is **1.7–5.1 KB** where the same
conversation's tool-bearing history is **37–117 KB**. The model arriving on the new
runtime cannot answer about a file it read, a command it ran, or an edit it made
before the switch.

`base-agent.ts:322-324` states why the handoff is capped:

> "This is the ONLY thing that crosses: Pi resumes by DIRECTORY, Claude by SDK
> session id and codex keeps no durable thread at all — none of them accepts an
> injected history, so a text handoff is the ceiling, not a shortcut."

**True for API-level injection into a turn, false for the two paths this plan
uses.** Both were verified on this disk, and each was re-verified by an
independent pass:

- **Codex accepts injected history over its own RPC, outside a turn.**
  `thread/inject_items` is typed in our own pinned bindings
  (`packages/codex-protocol/generated/ClientRequest.ts:99`;
  `v2/ThreadInjectItemsParams.ts` = `{threadId: string, items: Array<JsonValue>}`,
  docstring: *"Raw Responses API items to append to the thread's model-visible
  history"*; `ThreadInjectItemsResponse = Record<string, never>`) and is served by
  the bundled `apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`
  (`--version` → 0.147.0). It returns `{}`, needs no turn and no network, under the
  `experimentalApi: true` capability our client already sends at `initialize`
  (whether it is *gated* on that capability was not tested and does not matter for
  us). Positive control: `no/such_method` returns the unknown-variant error listing
  the whole method table. Injected items land in the rollout as ordinary
  `response_item` records and survive `thread/fork` byte-identically.
  **Model-visibility was confirmed OFFLINE**: pointing the app-server at a loopback
  Responses provider (`config.toml` `wire_api = "responses"`,
  `base_url = http://127.0.0.1:<port>/v1`), injecting, then `turn/start`, and
  reading the captured request body shows the injected items in the model's request.
- **Claude resumes from an on-disk transcript we already write ourselves.**
  `buildClaudeSubprocessEnv` sets `CLAUDE_CONFIG_DIR` to
  `workspaceClaudeConfigDir(...)` = `<workspaceRoot>/claude-config`
  (`options.ts:226-231, :260`), so our own transcripts sit at
  `~/.nessy-agent/workspaces/<wsId>/claude-config/projects/<sanitized-cwd>/<sdkSessionId>.jsonl`
  — 217 such files exist, carrying real `tool_use` / `tool_result` records written by
  our own gateway runtime. The path derivation was read verbatim from the shipped
  bundle (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`: `lE` = djb2-style
  `t = (t << 5) - t + charCodeAt | 0`; `lEe = Math.abs(lE(e)).toString(36)`;
  `us(e)` = replace `[^a-zA-Z0-9]` with `-`, and if longer than `dc = 200`,
  `slice(0,200) + '-' + lEe(originalPath)`; `fn() = join(Yt(), "projects")` where
  `Yt` reads `CLAUDE_CONFIG_DIR` and `.normalize("NFC")`s it) and cross-checked
  against the `SessionKey.projectKey` docstring in `sdk.d.ts`.

The reference implementation for both shapes is **omnigent**
(`https://github.com/omnigent-ai/omnigent` at `b08eb50`, Databricks,
**Apache-2.0** — adoptable with attribution), where this is a declared capability
axis `ForkHistory ∈ {NONE, REBUILD, PREAMBLE}`
(`omnigent/harness_capabilities.py:79-84`, field at `:137`) and the writer is
`omnigent/claude_native.py:4125-4530` / `omnigent/pi_native_resume.py`. See
`[[omnigent-meta-harness]]` in the session memory for the full read, including
what must **not** be copied. Note for anyone comparing: omnigent's own Codex path
is `fork_history=REBUILD` — a rollout writer — and `grep -arn inject_items` over
that whole checkout returns **0 hits**. They hand-synthesize what our pinned
binary will do for us.

## P.1 What this plan does NOT do

- **It does not touch the SDK's `toolAliases` lookup.** Row R4 of
  `docs/superpowers/plans/2026-08-16-clean-runtime-usage.md` was **REFUTED by owner
  decision 2026-08-17** and must not be revived. A transcript converter and the
  SDK's model-emitted-name lookup are different subsystems: the converter writes
  *historical labels into a file*, it never resolves a tool the model is calling.
  Name the subsystem in any commit that touches tool names here.
- **It does not persist `CODEX_HOME`.** Killed by measurement:
  `thread/fork` writes a NEW rollout containing a full copy of the parent's history,
  and Codex fixes config and model at `thread/start`, so the existing config-drift
  re-fork (`codex-agent.ts:1073-1100`) makes a persistent home worse, not better.
  `ANCHORED_PROVIDERS` stays `['pi','anthropic']`
  (`packages/shared/src/sessions/runtime-anchors.ts:38`).
- **It does not consolidate `ComposerCapabilities` into a new frozen record.** That
  DTO is versioned wire and must stay a projection; a naive consolidation **adds** a
  fifth list instead of removing four. Only the drift *test* is in scope (T5).
- ~~**It does not add a Pi rebuild yet.** T7 is real and mostly already built, and
  it is parked behind **G2**.~~ **NO LONGER TRUE — G2 was answered 2026-08-21 and
  T7 landed the same day.** The line is struck rather than deleted because it is
  what the scope was when the plan was written: the Pi rebuild was outside it
  until the owner said otherwise.

**Two STRUCTURAL rows are reversed by this plan, and both need an owner gate**
(G5 for Codex, G2 for Pi). T2 additionally needs G3. The rule is uniform: an
executor does not reclassify a STRUCTURAL row in
`docs/architecture/runtime-capability-gaps.md`.

## P.2 Two facts that reshape every converter below

Both were found by challenge, after the first costing pass had called the source
data sufficient.

**(a) `toolInput` and `toolResult` are display projections, not what the runtime
saw.** `SessionManager.ts:21284` persists `formatToolInputPaths(event.input)` and
`:21417` persists `formatPathsToRelative(event.result)`, **both with no cwd
argument**, so the rewrite base is `process.cwd()` of the host process rather than
the session's own directory; the result is then truncated at 200 000 characters.
A converter fed these fields is not replaying real history. **P1 fixes this and
must land before T2 (and before T1b, if G5 opens).**

**(b) The rebuild projection is NOT the handoff projection.**
`getRuntimeHandoffMessages` filters `!m.isIntermediate` because it feeds a text
*summary*. In a rebuilt native history those intermediate assistant rows are the
model's own commentary between tool calls — the connective tissue a native
transcript exists to carry. Measured: **1 835 of 2 969 assistant rows (61.8%)**
carry `isIntermediate`. Reusing the handoff projection would silently discard most
of the transcript.

**The projection, written as the complement of what is kept** (the earlier draft
named two roles that never occur and missed one that does):

> **Keep** `user`, `assistant` (including `isIntermediate`), `tool`.
> **Drop** `error`, `info`, `warning`, `status`, `plan`, `auth-request`.

Real type census over the corpus: `assistant` 2 969, `user` 1 460, `tool` 733,
`info` 87, **`error` 80**, `auth-request` 3, and **zero** `status` / `warning` /
`plan` rows. The 80 `error` rows are the ones a drop-list must name explicitly.

**Four integrity guards, each measured, each owed its own test row:**

| Shape | Predicate | Count | Guard |
| --- | --- | --- | --- |
| Dangling tool call | `toolStatus ∈ {executing, pending}` and no `toolResult` | 32 / 733 (4.4%) | synthesize an `(interrupted)` result — an unpaired `tool_use` is a hard provider error |
| Tool row with no input | `toolInput` absent or `{}` | 34 / 733 (4.6%) | drop the pair rather than emit a malformed call |
| Empty assistant row | **`content.trim() === ''`** — a literal `content === ''` matches **0 rows** and the test would pass vacuously | 317 / 2 969 (10.7%) | drop the record; never emit an empty content block |
| Nessy `error` row | `type === 'error'` | 80 | drop — it is scaffolding, not conversation |

Corpus totals, reproduced identically by three independent passes: 677 sessions,
5 332 stored rows, 733 tool rows, 799 rows carrying `runtime` provenance
(`message.ts` requires a reader to treat absent as "the session's current
runtime", so **no converter may filter on it**), 60 `compaction_complete` markers,
**0** thinking/reasoning rows, `parentToolUseId` on **5** rows.

## P.3 How this plan is executed

### The rule that governs every task: verify, correct, then execute

**No task is taken on faith, including this plan's own text.** Before starting any
row below, and before moving to the next one, the executor runs this loop. It is
not ceremony — this plan has already had **three** load-bearing premises falsified
after they were written down and reviewed:

| Premise, written and reviewed | What it actually was |
| --- | --- |
| "Pi 0.83 gives compaction a self-contained `retainedTail` checkpoint" | `retainedTail` has **zero** occurrences in `pi-coding-agent`'s `dist/` — it belongs to a sibling package we never import. A doc was read without the code. |
| "Use the SDK's `sessionStore` seam — it deletes half of T2" | `sdk.mjs` shows a store-backed resume **redirects the child's whole config dir to a temp dir and `rm -rf`s it**, making us the sole durable store. The typings alone were misleading. |
| "The transcript notice reaches both clients, so put the model change there" | iOS does not decode `message_added` at all and renders the raw marker `runtime_switched:pi:anthropic` **verbatim**. |

Each was caught by a reader who went to the code. Each would have shipped
otherwise. So:

**Before taking a task**

1. **Re-read every anchor the task cites**, in the tree as it is now — not as it was
   when the row was written. Earlier tasks in this same plan move `SessionManager.ts`,
   `base-agent.ts`, the protocol and the locales; U1/U2/U4 move the runtimes
   underneath all of them. A line number that no longer holds its identifier is a
   signal to re-derive, not to guess.
2. **Go to the source of truth for the mechanism**, not to a summary of it: the
   shipped SDK/binary on disk over its typings, the vendor's own docs over our
   restatement, `omnigent` (Apache-2.0, at `b08eb50`) over this plan's description
   of it. Where the two disagree, the code wins and the plan is corrected.
3. **Re-check the version ground.** If a U-task landed since this row was written,
   re-verify the row's claims against the version now installed.
4. **Correct the task in the plan, in the same commit that lands it**, and say in
   the Tracker note *what* was corrected and *why*. A silent correction is how the
   next reader inherits the wrong premise — which is the failure this whole plan
   exists because of.

**Before moving on**

5. **Check the goal, not just the gate.** The yardstick is this plan's own first
   sentence: *a switch hands over the conversation, not a summary of it.* A task
   whose gates are green but which quietly narrows that — carries less than it
   promised, or promises in copy what it does not deliver — is not done. Say so and
   fix it before the next row.
6. **Re-check the NEXT task's premises**, cheaply, against what this one just
   changed. Three of the corrections above were only visible from the neighbouring
   task's work.

**The bound on correcting.** Correcting a task means fixing a wrong fact, a moved
anchor, a broken mechanism or a false promise. It does **not** mean redesigning the
approach, widening scope, or reversing a recorded decision (§P.5). If the right fix
is one of those, stop and put it to the owner as a gate — do not absorb it into the
task. Equally: do not narrow a task to make it pass.

**Branch:** `feat/TCODE-000` (or the assigned task number). The current checkout
is `update/runtime-switch`, which does **not** match AGENTS.md's
`<type>/TCODE-000` with `<type> ∈ {feat, bugfix, chore, docs}` — rename or branch
before the first commit.

**Parallel execution requires one git worktree per lane.** Parallel agents on a
single checkout share one git index, and `git commit <pathspec>` then takes the
other agent's working-tree state — the trap AGENTS.md names, which no amount of
file zoning fixes. So: `git worktree add` per lane off the same branch, each lane
rebases before it commits, and one integrator serialises the merges. Never
`git stash`.

**Verification is a single lane, regardless of how many agents author.** Two
concurrent `bun test` processes manufacture failures (several session suites mutate
`process.env.NESSY_CONFIG_DIR` at module scope). `packages/shared` honours a
pre-set `NESSY_CONFIG_DIR` (`tests/setup/isolate-shared-config-dir.ts` only
mkdtemps when it is unset), but not every suite is proven to, so treat test runs as
mutually exclusive rather than assuming per-worktree isolation.

**The Tracker is the most contended file in this package** — every task edits it in
its own commit. Take the tracker edit last, rebase onto the current row, and never
hold it across a long build.

**One commit per task**, subjects fixed here:

| Task | Commit subject |
| --- | --- |
| P1 | `feat(sessions): persist raw tool input and result alongside the display projections` |
| P2 | `refactor(agent): one handoff-delivery seam, declared per runtime` |
| P3 | `feat(sessions): decide the history-carry plan before the switch and promise it in the modal` |
| T1a | `feat(codex): deliver the runtime handoff through thread/inject_items` |
| T1b | `feat(codex): carry tool calls and results across a switch into Codex` |
| T2 | `feat(claude): rebuild the SDK session transcript on a switch into Claude` |
| T3 | `fix(sessions): a switch keeps the model when the target can serve it` |
| T3b | `fix(i18n): the switch dialog says the reasoning level clamps, not resets` |
| T4 | `fix(sessions): refuse a runtime switch whose target cannot start` |
| T5 | `test(runtime): assert every declared per-runtime fact against its enforcement site` |
| T7 | `feat(pi): rebuild a Pi session file on a first switch into Pi` (**ADDED at execution 2026-08-21** — this table shipped without a T7 row because T7 was parked behind G2 when it was written; the subject follows T2's form) |
| T6 | `feat(ui): the collapsed turn header names what the turn did` |
| R1 | `fix(sessions): a crash mid-switch leaves either the rebuild or the text handoff, never both` |
| T8 | `fix(sessions): sweep the vendor transcript tree under the existing retention policy` |
| U1 | `chore(deps): claude-agent-sdk 0.3.218 → 0.3.223` |
| U2 | `chore(deps): pi-coding-agent 0.80.3 → 0.84.0` |
| U3 | `chore(deps): decide the @anthropic-ai/sdk pin` |
| U4 | `chore(deps): codex app-server rust-v0.147.0 → rust-v0.148.0` |

**File→task matrix. `SessionManager.ts` is claimed by five tasks — it is a serial
lane.** AGENTS.md: *"`git commit <pathspec>` takes the file's WORKING-TREE state,
not your hunks. Two agents editing one file at overlapping times WILL cross… Zone
parallel work by file, not by subsystem."*

| File | Claimed by | Rule |
| --- | --- | --- |
| `packages/server-core/src/sessions/SessionManager.ts` | P1, P2, T4, P3, T3, T2 | **Serial, in that order.** Single-threaded. |
| `packages/server-core/src/sessions/runtime-switch.ts` | T4, P3, T3 | Serial. P3's call site sits beside T4's. |
| `packages/shared/src/agent/base-agent.ts` | P2, T1a | P2 first, then T1a. |
| `packages/shared/src/i18n/locales/{en,ru}.json` | **P3, T3, T1a, T3b, T1b, T6** | Serial in that order — six claimants. **P3 and T3b rewrite the same VALUE** (`chat.runtimeSwitch.crossRuntimeBody`) with different meanings, and both i18n lints are blind to a changed value: parity checks key PRESENCE only. So P3 lands the clamps-not-resets correction together with its own overflow wording, and T3b collapses to "verify it says clamps". T1b rewrites `carryNativeCodex`'s VALUE for the same blind-spot reason, and adds no key. |
| `packages/shared/src/protocol/runtime-switch.ts` | P2, P3, T3 | Serial. P2 widens `contextCarried`, P3 adds the pre-switch plan field, T3 adds `previousModel`. |
| `.../input/runtime-switch-copy.ts` + `RuntimeSwitchDialog.tsx` + their `__tests__` | P3, T1a, T1b | Serial, **P3 first** — P3 lands the `runtimeSwitchCopyKey` signature change once, T1a adds its `toRuntime` branch, and T1b needs no new parameter at all: it re-routes T1a's branch onto the TIER, which P3's third parameter already carries. |
| `apps/electron/src/renderer/pages/ChatPage.tsx` | T3, R1 | Serial. |
| **this plan file** (the Tracker) | ALL 13 tasks | Serial by convention: take the tracker edit last, rebase onto the current row. |
| `packages/shared/src/agent/codex-agent.ts` | T1a, T1b | Serial. |
| `packages/server-core/src/sessions/runtime-handoff.ts` | T1a (created it), T1b | Serial. **This is why T1b is not on the `SessionManager.ts` lane** — A7's seam moved here when T1a extracted the projection, and it already receives the whole transcript. |
| `docs/architecture/runtime-capability-gaps.md` | T1a, T1b, T2, T7 | Serial. T1b rewrites T1a's own DECISION row rather than adding one — the "bounded to text" clause is what T1b removes. |
| everything else | one task each | may run alongside the serial lane |

So the waves are, and **nothing in lane A may start before P3 lands**:

| Wave | Runs | Notes |
| --- | --- | --- |
| W1 | **P1** ∥ **P2** ∥ **T4** ∥ **T5** | P1/P2/T4 all touch `SessionManager.ts` in three disjoint windows (14054–14364 / 15533–15686 / 21284–21465) — parallel only in separate worktrees, see below. T5 touches no production file. |
| W2 | **P3** → **T3** → **T3b** → **T6**, and **R1** item 2 | one chain, because P3 → T3 share `SessionManager.ts` and P3/T3/T3b/T6 share the locales. |
| W3 | **T2** (after G3) ; **T1a** → **T1b** (after G5) | the plan's motivation lives here. T2 is the critical path: 4–6 days + a live gateway day. |
| W4 | close-out | one commit. |

Critical path: **P2 → P3 → T2 → R1 item 1**. Maximum useful concurrency is **4
agents**; beyond that they queue on `SessionManager.ts` and on the verification
lane below.

**Dependency:** *P2* must precede T1a, T2 and T7. *P3* must precede T1a, T1b and
T2 — all three of them obey its plan instead of deciding their own bounds. *P1*
must precede T2, T1b and T7 — **not** T1a, which reads no tool rows and gains
nothing from P1. P3 depends on T4 only for code locality (they share a call site),
not logically.

**Gate hygiene, per AGENTS.md, applies to every gate below:**

- **Never run two `bun test` processes at once** — several session suites mutate
  `process.env.NESSY_CONFIG_DIR` at module scope and a concurrent run manufactures
  failures. The lane structure above invites exactly this.
- `rm -rf release` before any repo-root `bun test`: a packaged build leaves the
  renderer sources under `release/**/Resources/app/src/` and the root run collects
  them.
- Before recording any failure, check
  `docs/superpowers/specs/2026-07-29-known-failing-tests.md`. (Checked
  2026-08-20: it names none of the files this plan touches.)
- Any `mock.module` gets a spread **and** an `afterAll` restore — the pattern of
  `claude-gateway-adapter.test.ts:79`.
- `bun run typecheck:all` does **not** typecheck `packages/pi-agent-server`'s tests
  (`tsconfig.typecheck.json` excludes `**/*.test.ts`). A test added there needs a
  separate `tsc -p` against a config without that exclusion, and the Tracker row
  records **that** run's output.

---

## P.4 Tasks

### P1 — persist the raw tool input and result alongside the displayed ones

**What is wrong.** See P.2(a).

**D4 ANSWERED 2026-08-20 — fix the display too, do not only add a raw copy.**
Measured: both formatters rebase against the HOST PROCESS's `process.cwd()` and
nothing chdirs, so the base is whatever launched the app (`/` from Finder). In the
corpus **4 of 190** stored path values carry the actively-wrong `./Users/…` form and
**39** are absolute paths inside the session cwd that should have been relativized.
Cosmetic today — the string is only rendered, never resolved — but a converter fed
those 4 rows injects a path that resolves to the **wrong place**. Storage cost of
persisting both fields: **+11.75%** of the corpus (mean +2.0 KB/tool row, p99
+30 KB, worst session +112 KB); the 200 000-char cap is never reached today (max
observed result 32 184 chars).

**Change, all three decisions made here so an executor need not ask:**

0. **Pass the resolved session cwd** to `formatToolInputPaths` and
   `formatPathsToRelative` at all four assignment sites. This is the user-visible
   half: `./Users/…` stops appearing in Read/Write cards, and 39 rows start showing
   `./README.md` where they should.

1. Add `rawToolInput?: Record<string, unknown>` and `rawToolResult?: string` to
   **both** `Message` and `StoredMessage` in `packages/core/src/types/message.ts`
   (`PersistedMessage extends Omit<Message, …>` inherits from the first; the
   converter needs it on the persisted shape).
2. The raw result keeps the **same 200 000-char cap** — the converter's gain is the
   correct cwd, not unbounded length. Record it as a deviation (category string
   below).
3. A row lacking the raw field falls back to the display field, so old transcripts
   still convert (degraded, and the converter says so in its log line).

**Four assignment sites, not two** — the two formatter *invocations* are not the
primary paths:

| Site | Why it matters |
| --- | --- |
| `tool_start` create (`:21284` formatter call) | first event; on the SDK dual-event path its input is empty |
| `existingStartMsg.toolInput = …` (`:21327`) | the second pass that actually fills input — **this is what the 34 no-input rows are** |
| `existingToolMsg.toolResult = …` (`:21441`) | the normal result path |
| result-without-start create (`:21465`) | orphan result |

**Deviation category string** (harvested by `regenerate-deviation-register.py`,
which matches only this form): *"Raw tool result length: **documented, not
implemented** — the raw field keeps the display field's 200 000-char cap, because
the converter's gain is the correct cwd, not unbounded length."*

Files: `packages/core/src/types/message.ts`,
`packages/server-core/src/sessions/SessionManager.ts`.

**Gate.** `bun test packages/server-core`, `bun run typecheck:all`. One test where
the tool row gets its input from the **second** event and its result from the
update path, asserting the raw field on that row — a single-event synthetic fixture
keeps a broken implementation green.

---

### P2 — one handoff-delivery seam, declared per runtime

**Change.**

1. `BaseAgent` gains a **per-turn query, not a class constant** —
   `protected shouldSuppressTextHandoff(): boolean` defaulting `false`. **A6:** a
   class-level flag makes the text fallback *unreachable* on any agent that sets it,
   because it suppresses the build on every turn — and T2 promises the opposite
   ("if the rebuild did not take, the armed handoff delivers the text fallback on
   the next turn"). A query lets `ClaudeAgent` answer `true` only while a *verified*
   rebuild is in force. When it returns true,
   `chat` (`base-agent.ts:3721-3726`) does not build the text context and does not
   call `markRuntimeHandoffApplied`; it stashes the payload on the instance and
   leaves `runtimeHandoffContext` null so it drops out of the `messageParts` filter
   at `:3757`.
2. Widen `contextCarried` (`packages/shared/src/protocol/runtime-switch.ts:63`,
   today `'runtime-anchor' | 'handoff' | 'anchor-and-handoff' | 'none'`) **once,
   here**, to add `'native-inject'` (T1a's `thread/inject_items` succeeded) and
   `'native-transcript'` (T2 wrote and verified a transcript). The existing four
   keep their meanings; a native path that fails reports `'handoff'`, because that
   is what actually happened. Eight assertions in `runtime-switch-session.test.ts`
   (`:267, :275, :290, :312, :328, :445, :457, :491`) reference the union and must
   still pass unchanged.
3. **Rewrite the `buildRuntimeHandoffContext` docstring at `base-agent.ts:322-324`**:
   the text handoff is the *fallback* ceiling, not the only channel — Codex accepts
   `thread/inject_items` and Claude resumes from a transcript we write. Cite T1a and
   T2. Leaving it is how the next executor inherits a wrong premise, and this
   plan's existence is the evidence of what that costs.

Note: P2 ships no override, so both runtimes keep the default `false`.
**T2 overrides `shouldSuppressTextHandoff()` on `ClaudeAgent`** as part of its
own change, answering true only while a verified rebuild is in force — see T2's
fail-safe. (Corrected 2026-08-20 with P2: there is no
`handlesRuntimeHandoffNatively` class flag; A6 replaced it with the per-turn
query, and the two remaining mentions of the flag in T1a and T2 mean the same
override.)

Files: `packages/shared/src/agent/base-agent.ts`,
`packages/shared/src/protocol/runtime-switch.ts`,
`packages/server-core/src/sessions/SessionManager.ts`.

**Gate.** `bun test packages/server-core/src/sessions/__tests__/runtime-switch-session.test.ts`,
`bun run typecheck:all`.

---

### P3 — decide the carry plan BEFORE the switch, and let the modal promise it

**Owner decision, 2026-08-20:** *"если не помещается — делать хендоф как мы сейчас
делаем и говорить это в модалке подтверждения переключения."* Size is **never** a
reason to refuse a switch; the only refusal is T4's "the target cannot start".

**What is measured, so the tiers are sized against reality and not against zero.**
Convertible payload per session (user + assistant `content`, plus tool
`content` + `toolInput` + `toolResult`), over all 677 sessions, at ~4 chars/token:

| | payload | ≈ tokens |
| --- | --- | --- |
| median | 0.7 KB | ~180 |
| p95 | 41 KB | ~10 000 |
| p99 | 484 KB | ~124 000 |
| max | 528 KB | ~135 000 |

Available after a session's resting context (~46 000 tokens): **154 000** on a
200 000-window model, **216 000** on the gateway's 262 144. **0 of 677 sessions
overflow either.** So this is a seatbelt — but the p99 margin is 124 000 of
154 000 (80%), and the shape of the risk is not conversation length: the largest
session is **528 KB across 25 rows**. One huge tool result, not a hundred
messages. A single stored `toolResult` is capped at 200 000 chars ≈ 50 000 tokens,
so three of them plus a normal conversation crosses a 200 000-token model.

**Mechanism.** A pure `planHistoryCarry({rows, targetConnection, targetModel})` in
`packages/server-core/src/sessions/runtime-switch.ts`.

**A1 — the call site is NOT beside T4's.** `canHostSession` runs at
`SessionManager.ts:15533`, but `await this.ensureMessagesLoaded(managed)` is at
`:15542`, **after** it. A plan computed at T4's site reads `managed.messages === []`
on any session the user has not opened in this process, estimates a payload of 0 and
returns `native` unconditionally. **Compute it after `:15542` and before the boundary
acquire at `:15559`** — between T4's precondition and the teardown. Gate row: drive a
switch on a session with `messagesLoaded: false` and assert the plan is not `native`
by default.

> **Corrected at execution (2026-08-20).** All three anchors moved by ~10 lines
> when T4 landed: `assertSwitchTargetHostable` is now at `:15543`,
> `ensureMessagesLoaded` at `:15552`, the boundary acquire at `:15569`. The
> ordering the row describes is unchanged and the plan is computed between them.
> **And the gate row as written cannot fail today**: with A5's capability
> predicate `false` for every runtime, BOTH orderings produce `text`, so no
> black-box outcome discriminates a plan computed too early. It is therefore
> asserted two ways — behaviourally, through the new `previewRuntimeSwitch`
> command on a `messagesLoaded: false` session (it loads the cold transcript and
> comes back `text`, not `native`), and structurally, by asserting the ORDER of
> the three anchors in `switchSessionRuntime`'s own source, bounded to that
> method and with positive controls on all three. The structural row is the one
> that will catch a re-ordering on the day T1a or T2 flips a line — which is the
> only day it can do damage.

**A2 — resolve the window for the TARGET's effective model, not `managed.model`.**
At this call site the session still carries the SOURCE model (`managed.model` is not
reassigned until `:15686`), and T3 changes what the target's effective model becomes.
Compute it the way T3 computes it. Gate row: a case where the source window is larger
than the target's.

> **Corrected at execution (2026-08-20).** "Compute it the way T3 computes it"
> cannot mean *compute T3's future answer*: between P3 and T3 the session lands
> on `target.defaultModel`, so resolving a window for a model the session will
> not be on until T3 sizes the check against a runtime state that does not exist
> yet. The goal the row states — *the two cannot disagree* — is met structurally
> instead: `switchSessionRuntime` now hoists **one** `const targetModel`
> (today `target.defaultModel`) above the boundary, the planner resolves the
> window from it, and **T3 changes that one initializer and points the
> `managed.model` assignment at the same const.** The assignment site (now
> `:15696`) carries the note saying so. Gate row landed as a case where the same
> p99 conversation is `native` against a 262 144 target window and `text`
> against a 180 000 one.

**A3 — `native` depends entirely on one tier of `resolveContextWindow`, and the
fixtures do not satisfy it.** `getDefaultModelsForConnection` returns `[]` for
`pi_compat` / `claude-runtime` / `codex-runtime`, and `MODEL_REGISTRY` holds no
`tgpt/` ids — so for a gateway connection **only** an object-shaped
`connection.models` carrying `contextWindow` can produce a window. Real one-click
cards do carry it; the `runtime-switch-session.test.ts` fixtures are bare id strings
and must be upgraded to `ModelDefinition` objects, or the `native` arm ships
untested. It resolves the window through the existing
`resolveContextWindow` (`packages/shared/src/config/context-window-resolver.ts:41`)
and returns one of three plans:

> **Corrected at execution (2026-08-20).** The fixture upgrade landed
> (`modelDef(...)` objects with `contextWindow`, ids unchanged so `pi-source` and
> `codex-gateway` stay DISJOINT and T3's negative control — now at
> `runtime-switch-session.test.ts:439`, not `:343`; T4's rows moved it — is
> undisturbed). But upgrading fixtures is **not sufficient** to test the `native`
> arm, because A5's answer makes that arm unreachable from the product on
> purpose. The window resolution and the fit arithmetic are therefore reached in
> the unit suite through one explicitly-named, doc-commented test seam
> (`nativeCarrySupportedOverride`) that production never passes; the capability
> map stays the single source of truth and the seam is what stops the arm from
> shipping as an untested branch.

| Plan | Condition | What crosses |
| --- | --- | --- |
| `native` | estimated payload + resting context fits the resolved window, **and the target holds no anchor**, **and the target's native carry is implemented** | full history, tool calls and results included |
| `anchor` | **D7:** the target already holds its own anchor | the SDK resumes its own real transcript; the trimmed text tail carries what it missed. **No rebuild** — see D7. The modal must not promise "full history" here |
| `text` | no native carry is implemented for the target runtime — **true of every runtime today**, see A5 | today's handoff: 24 messages × 1200 chars, no tool rows |
| `text` | it does not fit | same |
| `text` | the window is **unknown** — `resolveContextWindow` returns `{contextWindow: null, source: 'unavailable'}`, or there is no target model id at all | same |
| `text` | the target model is a `claude-*` id, so a window resolves but is **not the one we set** (`resolveSpawnModelContextWindow` returns `undefined` for exactly these ids) | same |

The decision order is `anchor` → capability → window → fit, and `anchor` is first
deliberately: it is true whatever the size, and it is the tier the modal is most
likely to over-promise on.

**Three tiers, not two — D7 makes the anchored case its own.** For a *returning*
Claude leg this plan delivers nothing new, and the copy has to say so rather than
promise a carry it will not perform.

**D9 — the overflow answer is the text tail, and the reserved escalation is retired.**
The closed plan reserved `transferredSessionSummary` for exactly this trigger. The
arithmetic declines it: that escalation's budget is 500 chars per message and 12 000
total against the tail's 24 × 1200 = **28 800**, so escalating on overflow would
**reduce** fidelity while adding a metered gateway call to the switch path. Record the
decline, with this arithmetic, in the closed plan's decision log so the reservation
stops reading as pending work.

**The unknown-window tier is not optional.** Sending blind is worse than
degrading: the gateway's over-limit 400 does **not** present as `prompt_too_long`
(`claude-agent.ts:1005-1010`), so an overflow reads to the user as a silent
conversation reset rather than as an error. `'unavailable'` is treated as "does not
fit". Same rule for `resolveSpawnModelContextWindow`'s deliberate `undefined` on
`claude-*` ids.

**A4 — the pre-confirmation half has no transport, and this is a mechanism
decision, not a field addition.** Measured: the modal is computed **entirely in the
renderer**; `ConnectionRow.pick` is a synchronous callback and the only wire surface
is `sessions:command {type:'switchRuntime', connectionSlug}`, sent *after* the user
says yes. ChatPage's own comment records the consequence: the dialog "structurally
cannot show anything the server only learns while switching". So pick one and write
it into the task:

- **(a)** add a read-only `previewRuntimeSwitch` command that runs
  `ensureMessagesLoaded` + `planHistoryCarry` and returns the plan, awaited in
  `ConnectionRow.pick` before `setPending` — which makes `pick` async and needs a
  pending state; or
- **(b)** keep the modal copy plan-agnostic and surface the plan only afterwards.

> **DECIDED: (a), landed 2026-08-20.** `SessionCommand` gains
> `previewRuntimeSwitch`; `SessionManager.previewRuntimeSwitch` runs the same
> `ensureMessagesLoaded` + `planHistoryCarry` the switch runs and then stops — no
> boundary, no drain, no mutation — and deliberately does **not** run T4's
> `assertSwitchTargetHostable`, because a preview must not refuse. `pick` is
> async and awaits only on the cross-runtime tier: a model change, a
> same-runtime switch and an empty session take exactly the path they took
> before, with no round trip and no spinner. The pending state is one
> `previewing: string | null` that labels the integration row that was clicked
> and blocks a second pick; a rejected preview opens the dialog with no carry
> line rather than blocking the switch. Wire cost: one optional
> `onPreviewSwitch` prop mirroring the existing `onConnectionChange` through
> `ChatPage → ChatDisplay → FreeFormInput → CompactModelSelector →
> ConnectionRow`.

**A5 — P3 lands before any native carry exists**, so between P3 and T1a/T2 a
`native` promise would be false by construction. Decide: P3 keeps today's copy behind
a capability check until a native path lands, **or** P3 lands last and T1a/T2 hold
their own bounds in the interim.

> **DECIDED: the capability check, landed 2026-08-20.**
> `NATIVE_HISTORY_CARRY_IMPLEMENTED` in
> `packages/server-core/src/sessions/runtime-switch.ts` is a per-`AgentProvider`
> constant, `false` for all four members, read through one predicate
> `supportsNativeHistoryCarry(provider)`. **That map is the ONE line T1a and T2
> flip** — `'codex-runtime'` for T1a, `'anthropic'` for T2 (one entry covers both
> Claude cards, because `claude-runtime` and plain `anthropic` collapse onto one
> `AgentProvider` and D8 already records that T2's rebuild fires on
> providerType), `'pi'` for T7. Its doc comment names each of them. So the
> modal's promise is true at every commit, which is the entire point.

**Afterwards** the plan is surfaced as the `contextCarried` value P2 widened, so the
transcript notice matches whatever was promised.

**Deliberately NOT trimming to fit**, recorded so it is not "finished" later by
someone who reads the omission as an oversight:

> *Trim-to-fit instead of the text fallback: **documented, not implemented** — a
> trimmed native history reads to the model as complete. It sees a file's read
> result with none of the turns that explain why, and nothing marks the gap. The
> text handoff is honest by construction: `buildRuntimeHandoffContext` already
> frames itself as a prior transcript and tells the model to re-check anything it
> depends on. If trim is ever added, that same framing has to lead it.*

That paragraph is **mirrored verbatim in the code**, on `planHistoryCarry`'s own
doc comment (2026-08-20), together with D9's declined escalation and its
arithmetic — because the person who would "finish" the omission is reading the
function, not this file.

**Estimation contract.** Either count with a real tokenizer, or declare the
chars-per-token ratio and a safety margin **in the code**, with the measured p99
above as the fixture. A silent ratio is how a seatbelt becomes a false promise.

> **Landed as: the repo's own estimator plus a declared margin (2026-08-20).**
> Counting is `estimateTokensDensityAware` (`packages/shared/src/utils/large-response.ts`)
> — 4 chars/token, correcting to 1.5 for base64-dense text — run **once over the
> whole concatenated payload**, not summed per row, because its density
> correction has a 20 000-char floor and a whole-text ratio, and the corpus's
> worst case is 528 KB across 25 rows. On top of it,
> `SESSION_RESTING_CONTEXT_TOKENS = 46_000` and
> `HISTORY_CARRY_TOKEN_MARGIN = 1.25`, both exported and both asserted in
> `runtime-switch.test.ts` against the measured p99/max. The margin's reason is
> written where it is declared: this repo has already paid for trusting the bare
> heuristic once (`large-response.ts` records a session poisoned by a result that
> "estimated to ~14k tokens … but cost far more in the real tokenizer"), and
> Cyrillic tokenizes at roughly half the chars-per-token of English prose. The
> estimate prefers P1's `rawToolInput`/`rawToolResult` over the display
> projections, because the raw pair is what a converter would actually send.

Files: `packages/server-core/src/sessions/runtime-switch.ts`,
`packages/server-core/src/sessions/SessionManager.ts` (the call site, beside T4's),
`packages/shared/src/protocol/runtime-switch.ts` (the pre-switch field),
`apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts` +
`RuntimeSwitchDialog.tsx`, `packages/shared/src/i18n/locales/{en,ru}.json`.

> **The Files list was short by six, corrected 2026-08-20** — A4's transport is a
> wire change, and a wire change is never one file. Also touched:
> `packages/shared/src/protocol/dto.ts` (the `SessionCommand` member),
> `packages/server-core/src/handlers/rpc/sessions.ts` (the case),
> `packages/server-core/src/handlers/session-manager-interface.ts`
> (`ISessionManager` — a method the RPC layer calls must be declared here or
> server-core does not typecheck), `apps/electron/src/shared/types.ts` (the
> hand-written `sessionCommand` result union, which its own comment warns is not
> covered by the package `export *`), and the three renderer files the prop
> passes through (`ChatPage.tsx`, `ChatDisplay.tsx`, `FreeFormInput.tsx`,
> `CompactModelSelector.tsx`).
>
> **P3 also owns the "clamps, not resets" correction** to
> `chat.runtimeSwitch.crossRuntimeBody`, landed here rather than in T3b: both
> i18n lints check key PRESENCE and ordering and are blind to a changed VALUE, so
> the two tasks would otherwise overwrite each other silently. T3b collapses to
> "verify it says clamps". The same string's "the recent transcript is handed to
> {{toRuntime}} as text" clause is **removed**, because that is now the `text`
> tier's own sentence and stating it unconditionally contradicts the `native` and
> `anchor` lines sitting directly beneath it.

**Gate.** Unit rows for all three plans, using the measured p99 and max payloads as
fixtures plus one synthetic overflow; the `'unavailable'` arm as its own row;
`bun run typecheck:all`; `lint:i18n:parity`; `lint:i18n:sorted`. No packaged build
— the decision is pure and the copy is a locale change.

> **Recorded 2026-08-20 — the worktree typecheck trap, and how to get past it.**
> An agent worktree has no `node_modules`, so `@nessy-agent/*` resolves by
> walking up to the MAIN checkout: `apps/electron`'s typecheck then compiles the
> **main tree's** `server-core` against the **worktree's** `shared` and reports
> errors that exist in neither. Here that surfaced as
> `sessions.ts(826,15): Type '{ type: "previewRuntimeSwitch"; … }' is not
> assignable to type 'never'` — an exhaustiveness failure in a file that does not
> have the new case because it is a different checkout. P1's and T5's tracker
> rows each hit the same thing and handed the typecheck to the integrator.
> **It is fixable locally in one step**: create `<worktree>/node_modules/@nessy-agent/*`
> symlinks pointing at the worktree's own packages. Only that scope is shadowed —
> every other specifier still walks up — and `typecheck:all` then runs honestly
> and exits 0. Remove the directory afterwards (it is gitignored either way).

---

### T1a — Codex: deliver the handoff as native history instead of a prompt prefix

**Scope, stated plainly because the earlier draft overstated it.** T1a's source is
the payload P2 stashes, i.e. `getRuntimeHandoffMessages`' output — user/assistant
text only. **No tool call, command or edit crosses in T1a.** Its entire delta over
shipped behaviour is: the 24-message / 1200-char cap is gone, and the span arrives
as native model-visible history rather than as a text block inside the first user
message. That is worth having and it is **not** the motivation in "Why this plan
exists" — T1b is.

**Mechanism.** In `CodexAgent.chatImpl`, after `await this.ensureRuntime()`
(`codex-agent.ts:1114`) and after `applySelectedPluginSkillRuntimePolicy`
(`:1221`, so the thread id is post-fork), before the `turn/start` at `:1270`: map
the stashed rows to Responses items — user →
`{type:'message', role:'user', content:[{type:'input_text', text}]}`, assistant →
`{type:'message', role:'assistant', content:[{type:'output_text', text}]}` — and
`await this.client!.request('thread/inject_items', {threadId, items})`. On success
call `markRuntimeHandoffApplied` and report `native-inject`.
**On rejection**, prefix `buildRuntimeHandoffContext(...)` onto the message, mark
applied, report `'handoff'`, and log. `CodexAgent` overrides
`shouldSuppressTextHandoff`.

**Corrected 2026-08-20, at execution (§P.3 step 4).** Five premises in the
paragraph above did not survive contact with the merged tree.

1. **`handlesRuntimeHandoffNatively` does not exist.** A6 replaced it with the
   per-turn query and P2 landed that; the sentence above is updated to name the
   override.
2. **`contextCarried: 'native-inject'` cannot be reported where the row implies.**
   `RuntimeSwitchResult` is returned by `switchSessionRuntime` **before a single
   turn has run**, and Codex's carry needs a live thread — so the switch
   structurally cannot know how the handoff crossed. (T2's rebuild happens
   during the switch, so `native-transcript` has no such problem; the asymmetry
   is T1a's alone.) The value is reported from the turn that delivered it:
   `markRuntimeHandoffApplied` now takes a `RuntimeHandoffDelivery`
   (`'text' | 'native-inject' | 'native-transcript'`, defaulting to `'text'`)
   and the session log records `Runtime handoff context applied for <id>
   (context=native-inject)`. The switch keeps reporting `handoff` — the armed
   state, which is the honest thing it knows.
3. **P3's plan did not reach the agent at all, so T1a wired it.** `historyCarry`
   was computed, logged, and used for `targetAnchor`/`contextCarried`, then
   dropped. The channel is the smallest one that survives the gap between the
   switch and the first turn: `runtimeHandoffPlan` on the managed session,
   armed and cleared with `runtimeHandoffFrom`/`runtimeHandoffApplied` and
   persisted alongside them (without persistence the ARM survives a quit and
   the PLAN does not, so the modal promises native history and the next launch
   quietly delivers the text tail). It travels to the backend inside the handoff
   payload, and `shouldSuppressTextHandoff` was widened from zero-arg to take
   that payload — an additive change, so P2's own override still compiles, and
   it avoids a second `getRuntimeHandoffMessages` call per turn.
4. **The `runtimeSwitchCopyKey` widening is a FOURTH parameter, not a third.**
   P3 already spent the third on `historyCarry`.
5. **Two new keys, and the row's own count was right where its reasoning was
   not.** `crossRuntimeBodyCodex` is one. The second is `carryNativeCodex`,
   because the shared `carryNative` promises "tool calls and their results
   included" — true of T2 and of T1b, **false of T1a** — so reusing it would
   have made the modal lie about the very carry this task builds. The body is
   chosen on the target runtime alone (it is true on both Codex tiers, since no
   tool traffic crosses into Codex at all yet); only the carry line is also
   chosen on the plan. One VALUE also changed: `chat.runtimeSwitch.notice` said
   "Context was handed over as text", which T1a makes false.

**Deliberately excluded from the payload**, each with its category string:

- *Reasoning items in the inject payload: **documented, not implemented** — the
  app-server accepts them but writes `encrypted_content: null`, and replaying that
  through our loopback adapter to the gateway is a request class we have no reason
  to invent.*
- `function_call` / `function_call_output` were excluded **in T1a only**, because
  an unpaired `function_call` in history is a hard provider error and the pairing
  guards lived in T1b behind P1. **CLOSED by T1b on 2026-08-21** — the pair now
  crosses, guarded. Deliberately no longer written as a category string: the
  deviation register harvests those, and a closed deviation left in that form is
  exactly the downward drift AGENTS.md warns is invisible.

**Bounds — P3 owns the decision, T1a only obeys it.** Uncap when P3's plan is
`native`; when it is `text`, T1a takes the fallback branch and never injects.
Do **not** re-derive the window here: `buildCodexConfigToml` emits
`model_context_window` / `model_auto_compact_token_limit` only inside
`contextWindow !== undefined`, and `model-fetchers/nestor.ts` spreads it only when
truthy, so codex's own auto-compaction is not a backstop we can rely on for a
seeded gateway model that arrives without a window. That is exactly why the
`'unavailable'` tier in P3 resolves to `text`.

**Copy — this is a code change, not a locale edit.**
`runtimeSwitchCopyKey(kind, hasHistory)`
(`apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts:90`)
returns a fixed `bodyKey: 'chat.runtimeSwitch.crossRuntimeBody'` and has no
target-provider parameter. Widen it to
`runtimeSwitchCopyKey(kind, hasHistory, toRuntime: ModelProvider)`, return
`chat.runtimeSwitch.crossRuntimeBodyCodex` when `toRuntime === 'codex-runtime'`,
update both callers (`RuntimeSwitchDialog.tsx:51-52`, `ConnectionRow.tsx`), and
amend `__tests__/runtime-switch-copy.test.ts` (two assertions pin the cross-runtime
bodyKey). Then add the two new keys to `en.json` and `ru.json`.

**Owner gate G5.** This reverses a STRUCTURAL row: `runtime-capability-gaps.md`,
Codex section — *"Our context blocks ride the user message | STRUCTURAL | There is
no other channel into a turn."* `thread/inject_items` **is** another channel.
Rewrite that row in this commit with the probe as its evidence.

**Known limits — record, do not fix here:**

1. `thread/read` reports `turns: []` after an inject (Codex reconstructs its visible
   turn list from `event_msg` records the inject does not write; omnigent flags the
   same at `codex_native.py:2133`). Harmless for us — we render from our own
   transcript.
2. **Corrected by the 2026-08-20 audit, and now in scope.** The `lastOwn` trim is
   keyed on message PROVENANCE, not on the anchor, so it DOES fire for a returning
   Codex leg — and its premise ("a runtime that has been here before resumes its own
   conversation from its anchor") is false for the one provider deliberately absent
   from `ANCHORED_PROVIDERS`. So a pi → codex → pi → codex user loses the leg-1 span
   on the second Codex leg. Gate the trim on the target actually having an anchor
   (`readRuntimeAnchor(managed.sdkSessionAnchors, target)`); test that four-leg
   sequence and assert leg 2's payload still contains the leg-1 fact.
   **Landed with an extraction the row did not ask for and the fix needed.** The
   projection lived in a closure inside `getOrCreateAgentUnchecked`, and its only
   test (`runtime-switch-session.test.ts`, "hands the transcript over exactly
   once") **re-implemented the closure's body by hand** rather than calling it —
   so no possible edit to the shipped trim could have failed it, which is why
   the anchor-vs-provenance divergence sat there through a live wave. It is now
   `buildRuntimeHandoffPayload` in
   `packages/server-core/src/sessions/runtime-handoff.ts`; both that test and
   the new four-leg one CALL it.
3. **Measured side effect with a false statement in it:** `thread/inject_items`
   stamps its records with
   `internal_chat_message_metadata_passthrough: {"turn_id":"auto-compact-0"}` and
   never closes that turn; a subsequent `thread/fork` then appends a model-visible
   `developer` message `<turn_aborted> The previous turn was interrupted on
   purpose…`. **Guard, in scope:** the inject must be the last RPC before
   `turn/start`, with no re-fork window in between. Do **not** "re-inject after a
   re-fork" — injected items survive `thread/fork` byte-identically (verified), so a
   re-inject appends a second copy. Offline test: after inject → fork → turn, each
   injected item appears exactly once in the captured request body.
   Test: zero `turn_aborted` records in the rollout after switch → model change →
   turn.
   **Both measured 2026-08-20 on the shipped binary, and the pair is now the
   test's shape.** inject → fork → turn puts each item on the wire exactly once
   **and one `turn_aborted`** — so that ordering is the POSITIVE CONTROL, per
   AGENTS.md's rule that an absence claim needs one. fork → inject → turn, the
   product's own ordering, carries both items and **zero** `turn_aborted`.
   A third fact fell out of the same run and belongs here: **`thread/fork` on a
   thread that has never taken a turn answers `no rollout found for thread id …`**,
   so a fork and an inject can only meet on a thread that already has history —
   which is exactly the switch → model change → turn case. (That refusal is a
   pre-existing property of `applySelectedPluginSkillRuntimePolicy`, not
   something T1a introduces; if the fork throws, `chatImpl` throws before the
   inject and the handoff stays armed for the next turn's text fallback.)

Files (as landed — the row's list was short by six, all of them the plan
channel the row assumed already existed): `packages/shared/src/agent/codex-agent.ts`,
`packages/shared/src/agent/base-agent.ts` (the stash read + the widened query),
`packages/shared/src/agent/backend/types.ts` (`RuntimeHandoffPayload`,
`RuntimeHandoffDelivery`) and the two index re-exports,
`packages/shared/src/sessions/types.ts` (`runtimeHandoffPlan`, persisted),
`packages/server-core/src/sessions/runtime-switch.ts` (the map flip),
`packages/server-core/src/sessions/runtime-handoff.ts` (**new** — the extracted
projection), `packages/server-core/src/sessions/SessionManager.ts` (arm/clear/
hydrate the plan; the closure becomes a call — all inside the handoff region,
away from T3's model-carry lines),
`packages/codex-responses-adapter/src/stub-server.ts` (two additive test options),
`apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts`,
`.../RuntimeSwitchDialog.tsx` (`ConnectionRow.tsx` needed no edit — its call
only asks whether the tier has copy at all, and the new parameter is optional),
`packages/shared/src/i18n/locales/{en,ru}.json`,
`docs/architecture/runtime-capability-gaps.md`,
`scripts/cdp/cases/rts-13.ts` (new), plus four test files:
`codex-runtime-handoff.test.ts` (new), `codex-inject-items-e2e.test.ts` (new,
`NESSY_CODEX_E2E`-gated), `runtime-handoff-payload.test.ts` (new), and edits to
`runtime-switch.test.ts`, `runtime-switch-session.test.ts` and
`runtime-switch-copy.test.ts`.

**Gate — the earlier draft's gate could not fail.** "Plant a fact, ask for it
after" passes on **today's** build for any fact inside the cap. Replace with a
discriminating pair:

1. **Committed offline test** (this is the primary gate, and it settles the
   load-bearing claim): spawn the bundled app-server pointed at a loopback
   Responses provider, inject, `turn/start`, assert the injected items appear in the
   captured request body. Lives beside the adapter's own tests.
   **A8 — guard it, or it is red everywhere but this machine.** The bundled
   `codex-app-server` is 183 MB, untracked and gitignored (fetched by
   `scripts/fetch-codex.mjs`), so a committed test that spawns it cannot run on a
   fresh clone or in CI. Follow the existing precedent
   `describe.if(process.env.NESSY_CODEX_E2E === '1')` from
   `packages/shared/src/agent/__tests__/codex-e2e.test.ts`, and state that this gate
   is satisfied by a **recorded local run** with that variable set — the command and
   its output go in the Tracker row, not into CI.
2. **CDP case `rts-13.ts`**, reusing `lib/runtime-switch.ts`'s
   `listConnections`/`switchRuntime`/`runtimeOf` the way `rts-4.ts` does: plant the
   fact **beyond message 24** (and/or only inside a tool result once T1b lands),
   switch Pi → `codex-gateway`, ask for it. **Run the same case on the pre-change
   build and record that it FAILS there** — without that negative control the case
   certifies nothing.
3. `bun run typecheck:all` (T1a crosses shared + protocol + renderer),
   `lint:i18n:parity`, `lint:i18n:sorted`.

The packaged build is needed only for leg 2 — the adapter → real gateway path.

Effort: ~40–60 LOC production plus the copy plumbing, ~120 LOC test, 1 CDP case.

---

### T1b — Codex: carry tool calls and results (✅, depends on P1 and G5)

Sized like T2, not like T1a. Applies **P.2(b)**'s keep/drop list and the four
integrity guards to the session's stored rows, and maps tool rows to paired
`function_call` / `function_call_output` items. Written as its own row so T1a is not
silently credited with it.

**The mechanism is already proven.** On a real 0.148.0 binary against a loopback
Responses provider, `thread/inject_items` accepted a paired `function_call` +
`function_call_output` and **both reached the model**, in order, before the new user
message. So T1b's blocker is not the binary — it is P1 (the raw fields) and the
pairing guards.

**A7 — Files, Gate and DONE, which this row was missing.**

> **Corrected at execution (2026-08-21), §P.3 step 4. Five of the six anchors in
> the Files list below no longer describe the tree, because T1a reshaped this
> exact area the day the row was written.**
>
> 1. **There is no `getRuntimeHandoffRows()`, and there must not be.** T1a
>    extracted the projection out of `SessionManager` into
>    `packages/server-core/src/sessions/runtime-handoff.ts`, and it already
>    receives the WHOLE transcript — `rows: managed.messages`, at the call site
>    that was `:14054` and is now `:14068`. So the row projection is a second
>    exported function in that file, `buildRuntimeHandoffHistory`, beside the
>    message one. **A7's either/or is therefore answered by an extraction that
>    already happened**: T1b stays off the serial lane, and `SessionManager.ts`
>    takes exactly one added argument (`log:`) inside the closure T1a owns.
> 2. **`backend/types.ts:578` is `:605` now, and it is the wrong field anyway.**
>    `getRuntimeHandoffMessages`' signature is unchanged; what widened is
>    `RuntimeHandoffPayload` (`:73`), which gained an optional
>    `history?: RuntimeHandoffHistoryItem[]`.
> 3. **`base-agent.ts`'s "stash shape" needed no edit at all.**
>    `pendingRuntimeHandoff` (`:2696`) is typed `RuntimeHandoffPayload | null`,
>    so widening the payload widens the stash; P2's doc comment there describes
>    the obligation, not the field list, and stays true.
> 4. **The offline e2e did NOT already assert a paired round-trip**, contrary to
>    T1a's report — and it structurally could not have: its `flatten()` reads
>    `content[].text`, and a `function_call` item has no `content` array at all.
>    A fourth test was added that reads the raw `input` items.
> 5. **The copy change is a ROUTING change, and T1a's own note about it was
>    wrong in both halves.** That note said T1b "deletes this override for the
>    carry line". It does not: the carry line must STAY Codex-specific, because
>    the shared `carryNative` promises image attachments cross as file paths
>    (D6) and Codex's inject crosses no attachment at all. What went false is
>    the BODY — `crossRuntimeBodyCodex`'s *"receives what was said, not what was
>    done"* — and it went false on exactly ONE tier. So the body is now chosen
>    on the TIER, not on the target runtime alone: `native` into Codex takes the
>    shared `crossRuntimeBody`, whose every word stays true of a native carry,
>    while `text`/`anchor` keep the Codex body **unchanged, word for word**.

**The shape, as landed.** `buildRuntimeHandoffHistory(rows, {target,
targetHasAnchor, log?})` keeps `user`, `assistant` (**including
`isIntermediate`**) and `tool`, drops the other six `MessageRole` members, and
applies the four guards — each carrying its measured count in a comment beside
it. It prefers P1's `rawToolInput`/`rawToolResult` and falls back to the display
projections, counting the fallbacks and announcing them through `log` (wired to
`sessionLog.info`), because a converter that silently fed the model a path
rebased against the host process's cwd is the failure P.2(a) exists to name.
`call_id`s are minted from the stored row id, sanitized and deduplicated.

`buildRuntimeHandoffPayload` attaches the result as `history` **only when the
plan is `native`**, and only when it is non-empty. `messages` is untouched in
both tiers — it is still built on `native` because it is the in-turn fallback
when `thread/inject_items` is refused — so the `text` and `anchor` tiers are
byte-identical objects to what T1a produced, which is asserted as such.

`buildCodexInjectItems` (**new**, `packages/shared/src/agent/codex-handoff-items.ts`)
is the payload → Responses mapping, extracted from `CodexAgent` for one reason:
the DONE criterion below has to be driven through the SHIPPED mapping, and a
test that restated it by hand would certify nothing.

Two guard decisions, both recorded rather than absorbed:

- **Guard 1 is implemented as the safe SUPERSET of its measured predicate.** The
  plan names `toolStatus ∈ {executing, pending}`; the code closes ANY resultless
  tool row. A status field is a claim about the row, the missing result is the
  fact, and it is the fact that makes the provider reject an unpaired call. An
  empty-string result is a real result and passes through, with its own row.
- **Guard 3 is applied to user rows as well as assistant ones.** The measured
  count (317/2 969) is the assistant one, but the guard's own stated reason —
  *never emit an empty content block* — is role-independent, and
  `{type:'input_text', text:''}` is exactly that. It can only make the payload
  more conservative.

Files (as landed): `packages/server-core/src/sessions/runtime-handoff.ts` (the
row projection, the guards, the `call_id` mint),
`packages/server-core/src/sessions/SessionManager.ts` (**one line** — the `log`
argument, inside T1a's closure),
`packages/shared/src/agent/backend/types.ts` (`history` +
`RuntimeHandoffHistoryItem`) and the two index re-exports,
`packages/shared/src/agent/codex-handoff-items.ts` (**new**),
`packages/shared/src/agent/codex-agent.ts` (calls the mapper; the excluded-items
note loses its `function_call` clause and keeps the reasoning one),
`packages/shared/package.json` (the new subpath export),
`.../input/runtime-switch-copy.ts` (the tier routing),
`packages/shared/src/i18n/locales/{en,ru}.json` (`carryNativeCodex`'s value),
`docs/architecture/runtime-capability-gaps.md`, plus four test files:
`runtime-handoff-payload.test.ts`, `codex-runtime-handoff.test.ts`,
`codex-inject-items-e2e.test.ts`, `runtime-switch-session.test.ts` and
`runtime-switch-copy.test.ts`.

Gate: the four integrity guards from §P.2 each as a table row; the offline
loopback test extended to assert a paired call/output round-trips in order;
`bun run typecheck:all`.

DONE: a Pi session with real tool traffic, switched to `codex-gateway`, can answer a
question whose only source is a **tool result** — not prose — from before the switch.
**Encoded as a test rather than argued**: `runtime-switch-session.test.ts` drives a
real `switchSessionRuntime` onto `codex-gateway` and asserts the armed plan is
`native`; `runtime-handoff-payload.test.ts` takes a transcript whose only mention of
a fact lives in a `rawToolResult` through the shipped projection and the shipped
mapper and finds it in the items, with the `text` plan as the negative control; and
the offline e2e proves the same pair reaches the provider's request body on the
bundled binary. **The LIVE half is owed at the wave boundary** — a packaged build
against the real gateway, which is the only leg none of these four cover.

Depends on **P1** (raw fields) and **P3** (it obeys the carry plan). Not gated on G5,
which concerns only the doc row T1a rewrites.

---

### T2 — Claude: rebuild the SDK's own session transcript

**Mechanism.** New `packages/shared/src/agent/claude-transcript-rebuild.ts`.
Output: JSON-lines records.

**CORRECTED at execution — the input is the PROJECTION's output, not
`StoredMessage[]`.** The row says "reuse `buildRuntimeHandoffHistory`" and
"input `StoredMessage[]`", and on this tree those two cannot both hold: the
projection lives in `packages/server-core/src/sessions/runtime-handoff.ts` and
`packages/shared` cannot import server-core. Taking `StoredMessage[]` here would
therefore have meant a second copy of §P.2(b)'s keep/drop list and of the four
measured guards — the exact duplication T1b's own extraction removed. So the
converter takes `RuntimeHandoffHistoryItem[]` (a type `shared` already owns) and
`SessionManager` calls the projection first. Two additive optional fields ride on
that item for T2's sake — `timestamp` and `runtime` — plus one optional
`attachmentBlock` hook on the projection for D6; a caller that passes none gets
byte-identical output to what T1b shipped, so Codex is untouched.

**CORRECTED — `sessionId` in that triple is the NESSY session id, not the SDK
one.** The cwd resolver's third candidate is
`getSessionDirPath(workspaceId, sessionId)`, our own session directory, and
`chatImpl` passes `this.config.session?.id`. Handing it the minted SDK id names a
directory that does not exist, falls through to `workspaceRootPath` in silence,
and derives a project key for the wrong place. The first draft of this task did
exactly that. The record's `sessionId` FIELD is the SDK id; the resolver's
argument is ours.

**The cwd is the single most likely way this ships broken, and the field named
`sdkCwd` is a trap.** `session.sdkCwd` is **tilde-abbreviated on disk**: **618 of the
676** session headers that carry it (91%), and 6 of its 8 distinct path prefixes,
begin with `~`. Sanitizing it produces a project directory the SDK never reads —
exactly the silent empty resume this task's fail-safe exists to prevent. Measured
against the 166 real directories under `claude-config/projects`:
`us(expanduser(sdkCwd))` matches **169** sessions, `us(sdkCwd)` matches **0**. `resolveSpawnCwd` (`claude-agent.ts:5465`) survives this
only by accident — its first candidate *is* `session.sdkCwd`, and it falls through
because `isExistingDirectory` is `lstatSync` with no tilde expansion.

**So: extract, do not re-derive.** Export a pure
`resolveClaudeTranscriptCwd({branchFromSdkSessionId, branchFromSdkCwd, sdkCwd,
workspaceId, sessionId, workspaceRootPath})` that **is** the body of the private
`resolveSpawnCwd`, change `resolveSpawnCwd` to delegate to it so there is one
implementation, and call it from both the SessionManager wiring and the spawn path.
Test that the two agree. A tilde-form cwd must be expanded or rejected, never
sanitized as-is.

**LANDED as REJECT, and the choice is recorded rather than implied.** Expanding
would move the spawn cwd of 618 of 676 sessions — a behaviour change this task
has no mandate for and no evidence is wanted — while rejecting leaves the
candidate list and therefore the answer identical to what shipped, and simply
gives the skip a reason a reader can find. The next candidate down
(`getSessionDirPath`) is what the 200 real transcripts record as their own
`cwd`, so the fall-through is not a consolation prize: it is the right answer,
and it is why `resolveSpawnCwd` "survives by accident" today. The two-agree
check is behavioural over a candidate table **plus** a source assertion that
`resolveSpawnCwd`'s body contains the delegation and no candidate list of its
own — a behavioural comparison alone cannot see a copy that happens to agree.

**Record envelope — full field list from the golden files, each marked:**

| Field | KEEP / OMIT | Reason |
| --- | --- | --- |
| `type`, `uuid`, `parentUuid`, `isSidechain: false`, `userType: 'external'`, `cwd`, `sessionId`, `timestamp`, `message` | KEEP | the envelope the loader reads |
| `sourceToolAssistantUUID` (on a tool_result, = the tool_use record's uuid) | **KEEP** | a *second* pairing link our own native writer always sets; it costs nothing |
| `toolUseResult` | KEEP, **and JSON-parseable** | **A9:** the row kept the field with no constraint on its VALUE, but our stored result is a plain display string for most rows — bash output, file contents, error text. Write it through: pass the stored value through when it already parses as JSON, otherwise wrap it as a JSON string literal (omnigent's shape). Golden cases for both. |
| `version` (`2.1.218`), `entrypoint` (`claude-desktop`), `gitBranch` | KEEP | the native writer always emits them; omitting a field the writer always emits is a guess |
| `promptId` | KEEP on user records | present in the golden files |
| `message.model` | **TEST BOTH ARMS** | omnigent's converter omits it, on a docstring about *its* path; **our own runtime already writes non-Claude gateway ids into these transcripts and resumes off them today**. Do not import omnigent's conclusion — decide on the packaged run and record which. |
| `compactMetadata`, `type: 'system'`, `isCompactSummary` | **OMIT — all of them** | the loader's compaction handler destructures `compactMetadata.preservedMessages` / `preservedSegment` and **deletes** every pre-boundary record not in the preserved set. Every one of the 60 `compaction_complete` markers is dropped. Test: the produced file contains zero `compactMetadata` and zero `type: 'system'` records. |

An assistant tool call carries
`message.content = [{type:'tool_use', id, name, input}]`; its result is a `user`
record with `message.content = [{tool_use_id, type:'tool_result', content,
is_error}]`.

**Chaining is required, and the fail-safe must not lean on re-walking it.** The
bundled binary carries, verbatim: *"Conversation reconstruction walks parentUuid
from the last record, so unlinked records are dropped — the file's producer must
chain records (parentUuid null on the first, the previous record's uuid on each
subsequent one)"*, telemetry `tengu_resume_unchained_transcript` at
`level: "error"`. So chain: `parentUuid: null` on record 0, the previous record's
`uuid` thereafter, and a tool_result's `parentUuid` is its tool_use record's `uuid`
(omnigent's `tool_parent_by_call_id` map, `claude_native.py:4404-4409`).

But the loader is **not** a strict walk: on a missing or already-seen parent it
falls back to timestamp order (`tengu_chain_timestamp_fallback`) and it carries a
cycle guard (`tengu_chain_parent_cycle`, "Returning partial transcript"), and the
unchained diagnostic fires only when **no** record is chained. Porting three arms
to verify our own output is not worth it. **Use the read-back arm instead:**

> **Fail-safe.** `ClaudeAgent` sets `handlesRuntimeHandoffNatively = true` in this
> task (amending P2's "Pi and Claude are untouched"), so the text prefix cannot
> double the rebuilt history. Keep `runtimeHandoffFrom` armed across the write and
> disarm it only after the target's **first turn** shows the rebuilt history took;
> if it did not, the armed handoff delivers the text fallback on the next turn.
> Never both.

**CORRECTED twice, and the second correction is the important one.**

*(a)* There is no `handlesRuntimeHandoffNatively` flag — audit row A6 replaced it
with the per-turn query `shouldSuppressTextHandoff(handoff)`, and P2's own note
already says so. `ClaudeAgent` overrides that, answering true only while the plan
is `native` AND a loadable transcript really sits at the path its own spawn cwd
resolves to. The second condition is what catches R1's crash-mid-switch state.

*(b)* **"the first turn shows the rebuilt history took" has an obvious detector,
and it is WRONG.** The natural reading — and the one this file's own
resume-recovery comment invites (*"SDK silently fails resume if session is
invalid. In this case, we got a new session ID but no assistant content"*) — is
to compare the reported `session_id` against the minted anchor. Measured against
the shipped 0.3.223 binary: resuming an id whose transcript **does not exist**
reports back **that same id**, so the comparison passes on precisely the failure
it exists to catch. It was caught by its own negative control, which is the only
reason it is not in the product. What actually differs:
>
> | | transcript present | transcript absent |
> | --- | --- | --- |
> | `system`/`init` | emitted | **never emitted** |
> | `result.subtype` | `success` | `error_during_execution` |
> | reported `session_id` | ours | **ours — useless as a signal** |
>
> A resume the SDK cannot satisfy fails the child's START, before `init`. So the
> arm confirms on `system`/`init` carrying the anchor, and nothing else. The
> failure is also not silent, which is better than the row assumed: our existing
> `wasResuming && !receivedAssistantContent` recovery clears `sessionId` and
> re-enters `chat()` in the SAME user turn, where `shouldSuppressTextHandoff` now
> answers false and the text handoff is composed into the retry.

**Path derivation.** Realpath, then NFC-normalize **on darwin only** (the SDK's own
normalizer is `process.platform === "darwin" ? e.normalize("NFC") : e` — normalizing
unconditionally diverges on Windows for a non-ASCII cwd), then sanitize
non-alphanumerics to `-`, and if longer than 200 chars append `-` + the djb2 hash
**of the original path**. Golden set must include a >200-char case and a non-ASCII
case, or those branches ship untested.

**D7 ANSWERED — do not rebuild when the target already holds an anchor.** Read
`readRuntimeAnchor(managed.sdkSessionAnchors, 'anthropic')` first; if it is set,
take today's `anchor-and-handoff` path and stop — the SDK resumes its own real
transcript and the trimmed text tail carries what it missed. Rejected alternative
("always rebuild", omnigent's answer): it makes our store the single source of truth,
but what it destroys is **not recoverable** — the vendor's own native records for
that session — and it strands one file per switch. Consequence, already folded into
P3's tiers: for a returning Claude leg this task delivers nothing new, and the modal
must not promise otherwise.

**Wiring.** In the `kind === 'connection-cross-runtime'` branch
(`SessionManager.ts:15646-15671`), trigger on
`target.providerType === 'claude-runtime' || target.providerType === 'anthropic'`
— **not** on `toProvider === 'anthropic'`, which collapses the two and is the exact
conflation T5 records as a trap. The config dir is workspace-keyed, so the
derivation is identical for both. Mint a lowercase UUIDv4 (the SDK's validator is
`/^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i`), convert, write
atomically (tmp + rename), set the anchor.

**Token budget — P3 owns the decision, T2 only obeys it.** T2 rebuilds when P3's
plan is `native` and does nothing at all when it is `text`. It declares no ceiling
of its own and does **not** trim: P3 already records trim-to-fit as *documented,
not implemented*, with its reason. The hazard this defers to P3 is real and worth
restating so nobody re-invents a local ceiling: `session.jsonl` is the uncompacted
transcript, and the gateway's over-limit 400 does **not** present as
`prompt_too_long` (`claude-agent.ts:1005-1010`), so an unbudgeted replay lands in
the known silent-conversation-reset path rather than in a recoverable error.

**Out of scope, stated so it is not discovered late**, with category strings:

- *Reasoning in a rebuilt transcript: **impossible on this data** — nothing in
  Nessy has ever persisted thinking content (0 rows in 5 332) and `StoredMessage`
  has no field for it.* **Owner decision 2026-08-20 (G4 answered): reasoning is not
  carried, and this plan does not open the persistence work that would be needed.*
  **PREMISE NO LONGER HOLDS AT HEAD — dated note 2026-09-06 (P6.94), no decision
  reopened.** The second half of the impossibility — *"`StoredMessage` has no field
  for it"* — is false: P4.4 (`a6d56aabc`) added `isThinking?: boolean` to
  `StoredMessage` at `packages/core/src/types/message.ts:465`, commented *"P4.4 ·
  persisted so a reloaded transcript keeps reasoning rows distinct from
  commentary."* So the data model now HAS the field, and *"impossible on this
  data"* has become a claim about the CORPUS (the 0-of-5 332 census, taken before
  that field existed) rather than about the schema. The census half is being
  re-measured on its own row (P6.91), which is what would settle whether anything
  has since been persisted. **This note corrects the footing, it does not answer
  G4**: the owner's *"цепочку пока не переносим"* stands until the owner says
  otherwise, and nothing here carries reasoning across a switch.
- *Sidechains and sub-agent transcripts: **documented, not implemented** —
  `parentToolUseId` appears on 5 of 5 332 rows and the SDK keeps sub-agent
  transcripts in separate subpath files.*
- **D6 ANSWERED — attachments cross as a text reference, not an image block.**
  Emit `[Attached file: <name>]` + `[Stored at: <resolved path>]`, with a visible
  could-not-load marker when the file is gone — the exact block our own agent
  already sends every turn, reusing the existing realpath + containment +
  stale-handle resolver. Evidence for declining rehydration: **217 vendor
  transcripts contain zero image blocks and zero base64**, so we have no evidence
  the SDK round-trips an image block written by us; and only 2 attachment rows exist
  across 677 sessions. *Category string:* **Image rehydration across a switch:
  documented, not implemented** — no evidence the vendor round-trips a synthesized
  image block, and our own code records that the Read tool cannot open an image.
  **The loss is real and P3's `native` copy must say it**: the model receives a path
  it cannot look at.
- **D10 ANSWERED — stamp `runtime` on every row the rebuild synthesizes**, so a
  later reader can tell a carried turn from a native one and an incident like "the
  model quoted a file it never read" stays diagnosable. Two limits to write down
  rather than discover: `Message.runtime` is absent on **4 533 of 5 332** existing
  rows, so the marker works forward only and never retroactively; and it has exactly
  **one** production reader today, so nothing renders it.
  **CLARIFIED at execution — "the rows the rebuild synthesizes" are the VENDOR
  records**, since the rebuild adds nothing to our own store, so the marker rides
  each written JSONL record carrying the provenance of the stored row it was built
  from. That makes the vendor file self-describing about which of our runtimes
  produced each carried turn, which is what the incident above needs. It is a
  field the SDK's own writer never emits, so it was proven harmless rather than
  assumed to be: the offline resume e2e writes these records with `runtime` set
  and the binary loads them and puts the whole history on the wire.
- **A9 refined — `null` is carved out of the pass-through arm.** "Pass through
  when the stored value parses as JSON" would turn a tool that printed the four
  characters `null` into `toolUseResult: null`, which is indistinguishable from
  "no result" to any reader. Every other parseable shape passes through; both
  arms carry a golden case, and the corpus's own census (65 objects, 3 arrays, 2
  strings) is what the arms are sized against.

Files: `packages/shared/src/agent/claude-transcript-rebuild.ts` (new),
its `__tests__` file (new), `packages/shared/src/agent/claude-agent.ts` (the
extracted cwd resolver + `handlesRuntimeHandoffNatively`),
`packages/server-core/src/sessions/SessionManager.ts` (wiring + anchor),
`docs/architecture/runtime-capability-gaps.md` (a new Claude row recording that we
now write this format), and the golden fixtures.

**CORRECTED — the Files list was short by six, and a wire-adjacent change is
never one file.** Also touched, each for a stated reason:
`packages/shared/src/agent/backend/types.ts` (the two additive provenance fields
on `RuntimeHandoffHistoryItem`), `packages/shared/src/agent/index.ts` (the new
module's exports), `packages/server-core/src/sessions/runtime-handoff.ts` (the
provenance spread and D6's `attachmentBlock` hook on the REUSED projection),
`packages/server-core/src/sessions/runtime-switch.ts` (the one-line
`NATIVE_HISTORY_CARRY_IMPLEMENTED` flip P3 reserved for this task, plus the doc
comments that named it as pending), `runtime-switch.test.ts` and
`__tests__/runtime-switch-session.test.ts` (the map's own assertions, which are
the rows T2 is defined to turn), and a second new test file for the fail-safe
arm plus the offline SDK e2e.

**CORRECTED — the SDK's minified names remangled under U1 and the plan's are now
misleading.** At 0.3.223: `dc` → `Jo` (the 200 ceiling), `lE` → `hE` (the djb2
hash), `lEe` → `ewe` (its base-36 wrapper), `us` → `Yo` (the sanitizer), `fn` →
`Gr` (the projects root). **`us` is now a DIFFERENT function** — a buffer helper
— so following the plan's name would have read the wrong body. The module quotes
each helper by BODY rather than by name for exactly that reason. `version` is
`claudeCodeVersion` in the SDK's own `package.json` and reads **2.1.223** after
U1, not the `2.1.218` stamped on the records already on disk — which is the
concrete reason the golden diff excludes the field.

**The golden diff must not assert the `version` field.** Real records carry the
CLI's own stamp (`2.1.218` on our pinned SDK 0.3.218), so asserting it turns every
SDK bump into a test failure. Read it from the installed package at write time and
exclude it from the comparison — same for `entrypoint` and `gitBranch`, which are
environmental.

**D8 — the live gateway day answers PRV-N25 for free; make sure it is asked.**
`classifyRuntimeSwitch` is deliberately **not** changed: Claude Pro/Max ↔ Claude
Code (Nessy Gateway) stays `connection-same-runtime`, and this task's rebuild fires
on `providerType`, so it covers both cards without touching the classifier. That
leaves PRV-N25 open exactly as the closed plan states it — one anchor slot serves
both cards, so a transcript recorded against `api.anthropic.com` can be handed to
the gateway adapter. The live run already switches a Pi session onto
`claude-gateway`, so add the second leg and **write the answer back into the closed
plan's open-questions list**.

**CORRECTED — G3-D was taken, and it went further than the gate asked.** The
gate scoped a mirror-only `sessionStore` as a test harness, to capture the SDK's
own `projectKey` and entry stream. That landed
(`claude-transcript-resume-e2e.test.ts`, first case) and the captured key equals
our derivation exactly. But the same rig answers a bigger question **offline**:
the Claude SDK talks Anthropic Messages to whatever `ANTHROPIC_BASE_URL` names,
so a ~60-line loopback stub lets a transcript this repo authored be resumed by
the shipped native binary while the request body it sends the model is read back
— no network, no credentials, no gateway. Measured: the resume takes, the paired
`tool_use`/`tool_result` and a fact that exists ONLY in a tool result arrive in
the model's request, in order, ahead of the new user message, and the
intermediate assistant row §P.2(b) is about arrives with them. Gated on
`NESSY_CLAUDE_SDK_E2E=1` per A8, because the native binary is a 272 MB optional
dependency. The `projectKey` claim additionally rests on 166 REAL project
directories rather than on one capture — a fixture harvested from the
transcripts the SDK itself wrote.

**CORRECTED — P3's `claude-*` arm narrows what T2 can reach, and the narrowing
is P3's rather than T2's to change.** `planHistoryCarry` answers
`context-window-unenforced` → `text` for any target model id beginning
`claude-`, because we do not set the spawn-time window override for those ids.
So a switch onto Claude Pro/Max, or onto a BYO key pinned to `claude-sonnet-…`,
still crosses as text; only a gateway id whose window resolves reaches the
rebuild. That arm's own comment says it is conservative "until T2 measures the
real bound on a live run" — so the live gateway day owes this answer too. Pinned
in `runtime-switch.test.ts` with a positive control so it is not mistaken for a
defect in the rebuild.

**Gate.** Field-level golden-file diff (shape-level would hide the envelope
decisions above); the four integrity guards each as a table row; the two-agree test
for the extracted cwd resolver; the `undefined`-contextWindow arm; zero
`compactMetadata` / `type:'system'` records; `bun run typecheck:all`.
**One packaged build + one live gateway day**: switch a Pi session with real tool
traffic to `claude-gateway` and confirm the model can answer about a file it never
saw a tool call for in the text handoff — and decide the `message.model` arm on
that run.

**Effort: 4–6 focused days plus one live gateway day.** ~450–550 LOC production
(this repo's comment density realistically doubles that) + 250–300 LOC test.

---

### T3 — carry the model when the target can serve it

**What is wrong.** `SessionManager.ts:15686` does
`managed.model = target.defaultModel` **unconditionally**. All three gateway cards
are seeded from the identical `NESSY_GATEWAY_MODELS` catalog against the identical
base URL (`apps/electron/src/renderer/components/apisetup/nessy-gateway.ts` —
`codexGatewayConnectionDefaults()` and `claudeGatewayConnectionDefaults()` both read
it), so a user who picked "Qwen Fast" on Pi is silently returned to the default on
Claude Code and Codex.

**Change.** Feed the carried id through the existing resolver instead of
overwriting it:

```
const carried = resolveModelForProvider(toProvider, managed.model, target)
managed.model = carried || undefined
```

plus the import (`SessionManager` does not import it today).

**CORRECTED at execution — there are TWO copies of the hoisted const, not one.**
P3 left a second one in `previewRuntimeSwitch` (`SessionManager.ts:15550`), and
its own comment says "the same one expression the switch hoists; T3 changes both
together". Changing only the switch's would leave the preview sizing its context
window against the TARGET'S DEFAULT while the switch carries the user's model —
the promise-versus-act drift P3 exists to prevent, reintroduced by the task that
was supposed to be a one-line change. Both call the same pure helper.

**It is NOT a strict superset — the earlier draft was wrong.** Three inputs produce
something the old line never did, and each needs a guard and a test row:

| Input | What the new line does | Required guard |
| --- | --- | --- |
| Target whose `models` is empty or unfetched | the catalog filter lives inside `if (connection?.models?.length)`, so a foreign id **carries through** | add an explicit `!target.models?.length` guard returning **`target.defaultModel`** — **CORRECTED at execution: not literal `undefined`.** Returning `undefined` would DROP the declared default of every catalogue-less connection (a BYO Anthropic key before its first fetch is the ordinary case), which is a NEW regression and contradicts A10's own governing rule. `target.defaultModel` *is* `undefined` exactly when the connection declares none, so the narrow case the row was worried about is still covered — and both arms now have a row |
| `pi` target whose `defaultModel` is off-catalogue | substitutes `connectionModelIds[0]` | **A10 — assert the substitution; do NOT refuse.** A refusal is a second refusal path, and it contradicts the answered decision that size never refuses a switch. Preserve today's user-visible outcome — **and at execution that clause acquired a reason it did not have**: `resolveBackendContext` runs this same resolver at agent construction (`factory.ts:426`), so `connectionModelIds[0]` was ALREADY the model that ran. Letting the substitution stand makes the record agree with the runtime; it does not change the runtime |
| `codex-runtime` / plain `anthropic` target with **no** `defaultModel` | reaches `default: return managedModel \|\| connectionDefault \|\| DEFAULT_MODEL`, and `DEFAULT_MODEL` is an **Opus** id — so a Codex session gets a Claude model where today the field goes `undefined` | **A10 — clamp: guard the assignment on `target.defaultModel` so the field stays `undefined`.** Again the rule is "preserve today's outcome", not "invent a new one" |

**Do not amend the model-reset row.** Its fixtures have **disjoint** catalogs
(`pi-source` = `['tgpt/qwen35-397b-a17b-fp8']`, `codex-gateway` =
`['gpt-5.3-codex','gpt-5.3-codex-mini']`), so the carried id is cleared and the
assertions still pass. It is the **negative control** T3 must not disturb. The
actual test work is: one **overlapping**-catalog fixture pair plus the carry
assertion, and the three guard rows above.

**Its line number has now drifted twice — stop citing one.** The row text said
`:343`, P3's tracker note corrected that to `:439`, and in the merged tree
(after T4) it is at **`:470`**. Find it by its name,
`'cross-runtime switch resets the model to the target default'`. It is left
byte-identical and now carries a comment saying what it is, so the next reader
does not have to consult this plan to know not to touch it.

**Named decision this task sits next to.** `docs/superpowers/specs/2026-07-29-inert-worklist.md`
§3, item 2 records: *"filtering there would round-trip through
`updateLlmConnection` … and permanently destroy a user's model list. Cost: … filter
at the read boundary … **NOT** at the persistence boundary."* `resolveModelForProvider`
cites that decision in its own body. **T3 persists `managed.model` only; it never
touches `connection.models` or `connection.defaultModel`.** Add a test asserting
both are byte-identical after a switch.

**Required, same commit — owner decision 2026-08-20 («да + тост»).** Add
`previousModel?: string` to `RuntimeSwitchResult`
(`packages/shared/src/protocol/runtime-switch.ts`, beside the existing `model`),
fill it at the return block, and raise a toast in `ChatPage.tsx` alongside the
existing `droppedAttachments` / `stoppedChildren` ones **whenever it differs from
the model the session ends up on**.

This is not decoration and it is not optional: carrying the model makes a switch
quieter, and the toast is what keeps quieter from becoming opaque. Concretely, the
two user-visible outcomes after this task:

- picked **Qwen Fast** (`tgpt/qwen36-35b-a3b-fp8`), switch Pi → Claude Code →
  **stays Qwen Fast**, no toast (nothing changed);
- picked **Claude Opus** on a BYO key, switch to a gateway Codex card → resets to
  the card's default (`NESSY_GATEWAY_DEFAULT_MODEL` = Qwen Coder) → **toast names
  both ends**.

Copy lives with the other switch strings; 1 key × 2 locales, so
`lint:i18n:parity` / `lint:i18n:sorted` apply. Test row: a reset raises the toast
payload, a carry does not.

**U4 is a quiet prerequisite of this task, not only of T1a.** `base_instructions`
gains `provenance` in codex `rust-v0.148.0`, and its whole purpose is that a model
change stops carrying the previous model's instruction template — which is exactly
what our `thread/fork`-with-a-new-model switch did wrong on 0.147. T3 is only
*instruction-correct* from 0.148 onward.

**Gate.** `runtime-switch-session.test.ts` (new fixture pair + three guard rows +
the byte-identical-connection assertion), `context-usage-after-switch.test.ts`,
`bun run typecheck:all`.

---

### T3b — the switch dialog says the reasoning level clamps, not resets

`renormalizeForRuntime` (`packages/server-core/src/sessions/runtime-switch.ts:55-77`)
clamps `thinkingLevel` to the target's highest offered level (Pi at `max` → Codex
lands on `high`) and clamps `permissionMode` through the repo's single graded chain.
`chat.runtimeSwitch.crossRuntimeBody` (`en.json:450`) tells the user it **resets**.
One key × 2 locales. Sequenced after T1a, which edits the same two files.

**Gate.** `lint:i18n:parity`, `lint:i18n:sorted`.

---

### T4 — refuse a switch whose target cannot start

**What is wrong.** Our teardown is **irreversible**:
`exitWorktreeBeforeRuntimeSwitch` (called `:15600`, defined `:15821`) leaves the
worktree and the strict drain releases every lease — and nothing checks the target
first. The failure surfaces later: for Claude at `getOrCreateAgent` as
`CLAUDE_RUNTIME_DISABLED_ERROR` (`factory.ts:83`, returned `:106`); for Codex only
at the first turn's `ensureRuntime` → `resolveBinaryPath`, which throws
*"codex-app-server binary path not …"* (`codex-agent.ts:324`). omnigent is strictly
better here — it loads the target bundle **before any mutation**
(`omnigent/server/routes/sessions/routes_core.py:2308-2310`: *"Load the target
bundle BEFORE committing so an unloadable spec fails the request with zero mutation
— the irreversible part of the switch … must not run for a target that can't
start."*).

**Change.** In `packages/server-core/src/sessions/runtime-switch.ts`:

```
canHostSession(target: LlmConnection, hostRuntime: BackendHostRuntimeContext):
  { ok: true } | { ok: false; code: string }
```

called from `switchSessionRuntime` at `:15533` — **before** the boundary acquire and
before any teardown — with `buildBackendHostRuntimeContext()`. Arms:

1. **Flag** — the target runtime is compiled in.
2. **Binary** — `resolveCodexBinaryPath(hostRuntime)` (exported,
   `runtime-resolver.ts:405`) for `codex-runtime`; for `claude-runtime` /
   `anthropic` read `resolveBackendRuntimePaths(hostRuntime).claudeCliPath` (declared
   `runtime-resolver.ts:460`, field assigned `:464`), because
   `resolveClaudeBinaryPath` (`:332`) carries no `export`.
3. **Credential** — precisely: *a credential record EXISTS for the target
   connection and, when it carries `expiresAt`, is not expired.* **Residual, named:**
   a present, unexpired-but-malformed JWT still passes (there is no shape
   validation — recorded 2026-08-18), and the switch will still tear down. The dp
   credentials file is **read-only** outside `packages/shared/src/auth/dp`; this
   check never writes it.

**Deterministic and local only — no network, no spawn.**
`validateStoredBackendConnection` (`factory.ts:519`) looks like the ready-made check
and is a trap: its anthropic arm does `getValidClaudeOAuthToken(slug)` over the
network (`drivers/anthropic.ts:303-311`). `drivers/codex.ts:114` records *"A real
turn is the true test; do not spawn app-server just to validate"* — this proposal
does not spawn, it checks for the binary on disk; say so in the commit.

**Gate.** Four unit cases (flag off, credential missing, binary missing, **healthy
— the negative control**) **plus a fifth in the suite that owns the seam**:
`runtime-switch-session.test.ts` — a switch onto an unhostable target rejects with
the coded error **and leaves the session intact**: the worktree lease still held,
`managed.llmConnection` unchanged, `managed.agent` not disposed, `contextCarried`
never computed. Without that case, a correct helper wired *after* the teardown
passes everything and ships the bug the task exists to prevent. Plus
`bun run typecheck:all`.

---

### T5 — a drift test: every declared per-runtime fact asserted against the code that enforces it

**What is wrong.** Eleven sites hold per-runtime capability truth. Five are derived
from one another (`ComposerCapabilities` → `resolveComposerCapabilities` →
`resolveManagedComposerCapabilities` → `runtime-config.ts:141` →
`renormalizeForRuntime`). **Six are independent hand-maintained lists**, and two
carry an explicit "must be kept in step by hand" note:
`runtimeForProviderType` (`runtime-switch-copy.ts:37`) and `MessageRuntimeProvider`
(`packages/core/src/types/message.ts:269`). `scripts/cdp/lib/runtime-switch.ts`'s
`runtimeOf` is a third hand restatement **without** such a note — and it has already
drifted (it returns `'remote'` for an unknown providerType). Four of the five
`runtime-switch-costs` rows and both `runtime-agent-support` sets are derivable
today and nothing checks them.

**Two files, because two enforcement sites are unreachable from `packages/shared`:**

| File | Covers | Gate |
| --- | --- | --- |
| `packages/shared/src/agent/__tests__/runtime-capability-drift.test.ts` | the shared / session-tools axes | `bun test packages/shared` |
| `apps/electron/src/renderer/components/app-shell/input/__tests__/runtime-capability-drift.test.ts` | `runtimeForProviderType` vs `providerTypeToAgentProvider`, and the `runtime-switch-costs` rows | the renderer's own test run |

**One rule, non-negotiable, and it comes from a real error in this review's own
first pass.** Every count must be **derived at test time** from the enforcement site
(`getSessionToolNames({projection:'pi'})`, membership in
`SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, …) and never transcribed. The first pass
reported 27 `visibility: 'pi-only'` hits where the file has **19** — `grep -ac`
counts lines, `grep -ao` counts occurrences, and 28 is the repo-wide figure. A
drift test seeded from a hand-counted number is a drift test with its own drift.

**Two traps for a later, larger consolidation** (out of scope, recorded so it is not
rediscovered): the record must be keyed by `LlmProviderType`, **not**
`AgentProvider` — `claude-runtime` and `anthropic` collapse onto one `AgentProvider`
and have deliberately different capabilities, which is exactly the bug
`CLAUDE_RUNTIME_DEFAULTS` exists to fix. And the tri-state's UI rule cannot be "no
claim hides the control": both of Nessy's existing no-claim readers deliberately
fail **open**, with recorded reasons.

---

### T6 — the collapsed turn header says what happened

**What is wrong.** `getPreviewText` (`packages/ui/src/components/chat/TurnCard.tsx:733`)
returns `turnCard.stepsCompleted` → "Steps Completed" once a turn settles with no
intent and no Task description.

**Change.** Replace **that branch only** (`:788-794`) — every earlier branch
(explicit intent, activity intent, running-tool names, Task description) is more
specific and stays. **Keep the `errorSuffix` concatenation from `:790-792`**: the
new category phrase replaces the key, not the suffix, or every collapsed turn
silently loses its error count. Copy `RunCategory` / `RUN_CATEGORIES` /
`RUN_CATEGORY_ORDER` / `runPhrase` / `categorizeCall` / `formatToolRunLabel` from
omnigent `web/src/lib/toolTitle.ts:236-349`; ignore `FORMATTERS`, because Nessy's
`toolDisplayMeta` + model-authored `displayName`/`_intent` already do that better.

**Why it is cheap here.** omnigent's `RUN_CATEGORIES` has **25** entries because it
must recognise four vendor spellings per operation. Ours needs ~14 and **no
per-runtime work**: the three adapters already converged on Claude's vocabulary
before the renderer (Pi's `PI_TOOL_BINDINGS` maps `read→Read`, `bash→Bash`,
`edit→Edit` at `harness-tool-descriptor.ts:286-289`; Codex's adapter maps
`commandExecution→Bash`, `fileChange→Edit` at `codex/event-adapter.ts:286,289`).
The whole runtime-specific surface is three rows: `Glob` (Claude) and `Find` (Pi)
are the same operation, and `Ls` is Pi-only.

**`categorizeCall`'s shell re-categorisation matters more here than upstream:**
Codex has no read tool, so its file reads arrive as `Bash` with `cat …` and its
listings as `Bash` with `ls …`. Without that rule a Codex turn reads "Ran 5 shell
commands" where the identical Claude turn reads correctly.

**Do not categorise MCP rows** — `mcp__sources__<wire>__<tool>` (Codex) vs
`mcp__<wire>__<tool>` (Pi/Claude) is a deliberate, documented divergence.

**Delete `turnCard.stepsCompleted`** (`en.json:2207`, `ru.json:2243`) in the same
commit — leaving it passes both i18n lints while a dead key sits in two locales.

**Gate — the two i18n lints provably cannot catch this task's own most likely
defect.** `scripts/check-i18n-parity.ts` accepts a ru `X_few` whenever en has
`X_one`/`X_other`, and only reports en keys **absent** from ru, so a *missing* ru
`_few`/`_many` is invisible; `sort-locales.ts --check` only checks ordering. A
missing plural form falls back to the key name at runtime. So add: one table-driven
test resolving every new `turnCard.run*` key through the **ru** bundle at counts
1, 2, 5, 21, 101 and asserting the result is not the key name. Plus
`bun test packages/ui`, `bun run typecheck:all`, both i18n lints.

**A11 — the visual check needs assertions, or this task cannot self-certify.**
"Looks right at three widths" is a human judgement inside a gate. Name the objective
checks and put them in the `packages/ui` test: the phrase is present in the DOM at
all three widths, it does not wrap, and the `errorSuffix` is not truncated. The
*look* then demotes to an optional owner glance in the dark theme via the
playground — not a packaged run, and not a blocker.

Effort: ~180 LOC, half of it Russian plural forms.

> **Corrected at execution (2026-08-21), §P.3 step 4. The two anchors that
> matter most in this row — the defect the gate is written against, and the way
> A11's checks can be made — were both wrong.**
>
> 1. **A missing ru `_few`/`_many` does NOT "fall back to the key name at
>    runtime". It falls back to ENGLISH, and the detector this row specifies
>    would have passed the defect it was written for.** Measured 2026-08-21:
>    `setupI18n` sets `fallbackLng: 'en'` (`packages/shared/src/i18n/setupI18n.ts:35`),
>    so with a key's ru `_few`/`_many` deleted, `i18n.t(key, { count: 2, lng: 'ru' })`
>    returns `"2 files"` and `count: 5` returns `"5 files"` — English prose inside
>    a Russian UI — while counts 1, 21 and 101 keep resolving in Russian, so it
>    survives a spot check. "Assert the result is not the key name" is therefore
>    green on the broken tree. The landed test asserts the resolution **is
>    Cyrillic and differs from the English resolution**, and the probe (a key pair
>    carrying ru `_one`/`_other` only) is recorded in its header. The rest of the
>    row's reading of the two lints is exactly right: `check-i18n-parity.ts:64-69`
>    treats `X_few` as an *allowed extra*, never a requirement.
> 2. **A11's DOM arm cannot be a render, and the reason is measured, not a
>    preference.** `TurnCard.tsx` is unloadable under `bun test`: importing it
>    fails with `Missing 'default' export in module '…/pdf.worker.min.mjs?url'`
>    (via `Markdown` → `MarkdownPdfBlock`), and stubbing that module moves the
>    failure to `ReferenceError: DOMMatrix is not defined` inside `react-pdf`'s
>    nested `pdfjs-dist`. `inline-execution-tool-name.test.ts:21-25` already
>    records the first half. So A11 lands as a **containment arm read from
>    source**, the trade `SessionStatusIcon.test.tsx:22-25` records — and it is
>    *stronger* than three widths, not a substitute: the label's span wears
>    Tailwind `truncate` (`white-space: nowrap`), so it cannot wrap at ANY width,
>    and the span carries no responsive or container-query variant, so its
>    presence does not depend on width at all. Every assertion has a recorded
>    mutation probe (remove `truncate` → red; drop `${errorSuffix}` → red; delete
>    a ru `_few`/`_many` → red at counts 2 and 5).
> 3. **"the `errorSuffix` is not truncated" is unsatisfiable unless the label is
>    BOUNDED, which this row did not ask for.** `truncate` clips at the END and
>    the suffix is the end, so an unbounded join of five categories drops the
>    error count exactly as this row warns. The landed module caps the join at
>    `TURN_PREVIEW_MAX_PHRASES = 3` — the cap the sibling running-tools branch
>    already uses (`.slice(0, 3) // Max 3 names`) — and folds the surplus into the
>    "other" phrase so no call is lost. `TURN_PREVIEW_BUDGET_CHARS = 95` is
>    derived from the layout constants (840px reading column − `px-5` − ~100px of
>    header chrome ÷ a conservative 7.3px advance at 13px) and fixed **before**
>    measuring; the worst case over every combination is en 84 / ru 94.
> 4. **The table is 11 rows, not ~14, and the runtime-specific surface is FOUR
>    rows, not three.** `MultiEdit` is Claude-only alongside `Glob`
>    (`core/pre-tool-use.ts:148` records the same split), so the four are `Glob`
>    + `MultiEdit` (Claude) and `Find` + `Ls` (Pi). `WebFetch` is deliberately
>    left uncategorised — none of omnigent's five categories is true of fetching
>    a URL, and "ran 3 searches" would be worse than "called 3 other tools". No
>    legacy lowercase rows are needed either: a scan of the 674 stored
>    `session.jsonl` transcripts found `Bash` 181, `Read` 77, `Write` 65, `Ls` 40,
>    `WebSearch` 18, `WebFetch` 8, `Find` 8, `Edit` 4 and **zero** lowercase
>    `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls` — the same scan is its own
>    positive control for that absence.
> 5. **The task needs EIGHT key pairs, not five.** A settled turn can carry
>    activities with no tool call at all (assistant commentary), and
>    `formatToolRunLabel` would answer "Called 0 tools" there. That case gets
>    `turnCard.runSteps`; `runFallback` and `runOther` are the other two beyond
>    the five categories, matching omnigent's own split.
> 6. **Moved anchors, re-derived in the tree on 2026-08-21.** `en.json:2207` is
>    `:2214`; `ru.json:2243` is `:2250`. The three `TurnCard.tsx` anchors all
>    held exactly (`:733`, `:788-794`, `:790-792`). The two adapter paths are
>    abbreviated in this row: they are `pi-harness/harness-tool-descriptor.ts`
>    and `backend/codex/event-adapter.ts` — both line numbers held, and the Pi
>    adapter emits `tool.binding.permissionName` as the row's `toolName`
>    (`backend/pi/event-adapter.ts:1149`), which is what makes the convergence
>    claim true rather than merely plausible. omnigent's symbols span
>    `web/src/lib/toolTitle.ts:237-349` at `b08eb50` (`:236` is the closing `*/`
>    of the doc comment); its table is 25 rows, as stated. **There is no local
>    omnigent checkout** — `.references/` holds `craft-agents-oss`,
>    `craft-ios-pr966` and `deepseek-harness` only — so the file was fetched from
>    `raw.githubusercontent.com/omnigent-ai/omnigent/b08eb50/…`, and the
>    Apache-2.0 attribution is recorded in `run-summary.ts`'s header per the
>    repo's adoption rule.

---

### U0 — the runtime-update lane, as one picture

**Owner intent 2026-08-20: bring every runtime to its latest available version.**
All four checks were run against the real sources on 2026-08-20 — Artifactory
(`artifactory.tcsbank.ru/.../npm-all`, the registry `bunfig.toml` configures) for
the npm packages, upstream GitHub Releases for Codex.

| Runtime dependency | Pinned | Latest available | Distance | Why it is not just a version string |
| --- | --- | --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` (+ its `-darwin-arm64` binary) | **0.3.218** (CLI 2.1.218) | **0.3.223** (CLI 2.1.223) | 5 patches | Typings are safe (236 → 238 exports, **zero** removals or renames, `Options` +1 field). **The risk is in the CLI the typings do not show** — see U1. **U1** |
| `@earendil-works/pi-coding-agent` | **0.80.3** (2026-06-30) | **0.84.0** (2026-08-06) | 4 minors, 13 releases | **Not a session-format bump — an auth/model-runtime bump, and the breaking change landed in a PATCH (0.80.8).** Session format is untouched. **U2** |
| `@anthropic-ai/sdk` | `^0.100.0` → **0.100.1** | **0.115.0** | 15 minors | A caret on `0.x` pins the MINOR, so this gap can never close itself. May be a deliberate floor — nothing records it. **U3** |
| codex app-server (`openai/codex`) | **rust-v0.147.0** | **rust-v0.148.0** stable | 1 minor | Not a version string: regenerates the protocol bindings and re-records the sha256 the spawn verifier checks. Gates T1a. **U4** |

**Read these as four separate risks, not one chore.** U1 is nearly free and unblocks
nothing; U2 and U4 each change machinery a later task is written against (T7 and
T1a respectively), so their ORDER relative to those tasks is the decision, not
whether to do them; U3 is not a bump at all until someone establishes whether the
pin was chosen.

**Sequencing rule for the whole lane:** a bump that a later task is written against
lands FIRST, or that task pays to be re-verified. Concretely:

- **U1 before T2** — the CLI version stamp moves (2.1.218 → 2.1.223), so T2's golden
  fixtures and its `message.model` arm are otherwise re-pinned the moment U1 lands.
- **U4 before T1a *and* before T3** — T1a's channel is verified on both binaries so
  the ordering there is convenience, but T3 is only *instruction-correct* from
  0.148: `base_instructions.provenance` is what stops a model-change fork from
  carrying the previous model's instruction template, which is precisely what our
  fork did wrong on 0.147.
- **U2 before T7** — for the API rewrite, not for a session-format change.

U3 is independent of every task here.

---

### U1 — bump `@anthropic-ai/claude-agent-sdk` 0.3.218 → 0.3.223 and record what moved

**Owner request 2026-08-20.** Artifactory `latest` is **0.3.223** (published
2026-08-05); we pin **0.3.218** exactly (2026-07-22) in root `package.json:136` and
`packages/shared/package.json:174`, and the platform binary
`@anthropic-ai/claude-agent-sdk-darwin-arm64` tracks the same version.

**What is already measured**, so the bump is not a blind one — verified
2026-08-20 by diffing the two published tarballs:

| Surface | 0.3.218 → 0.3.223 |
| --- | --- |
| `Options.sessionStore` | present in every release, 7 references, unchanged |
| `SessionStore.load` docstring | **byte-identical** |
| `SessionStoreEntry` | still `@alpha`, still "CLI-internal" |
| transcript path derivation | behaviourally identical — same djb2 body, same `/[^a-zA-Z0-9]/g` sanitizer, same 200-char threshold |
| the minified identifiers behind it | **remangled**: `dc`→`Jo`, `lEe`→`ewe` |
| `sdk.d.ts` size | **301 108 → 319 781 bytes (+18 673)** — the earlier "306 906" baseline was wrong; that is 0.3.219/0.3.220, not the installed 0.3.218 |
| exported symbols | 236 → 238, **zero removals, zero renames** (`+DirectoryAddedHookInput`, `+FastModeDisabledReason`) |
| `Options` | +1 field only: `resumeDropsTurn?: string` (63 → 64 keys) |
| everything T2 and R1 rest on | byte-identical: `HookPermissionDecision`, `PermissionMode`, `PreToolUse*`, `MessageDisplay*`, `SyncHookJSONOutput`, `SessionStore`, `SessionStoreEntry`, `SDKCompactBoundaryMessage`, the whole `SDKMessage` union — and in the binary all four strings T2 quotes survive at identical counts |
| the CLI version stamp | 2.1.218 → 2.1.223, so **U1-before-T2 stands** |

**The typings are not where the risk is — the five CLI releases are.** Three
findings, each landing on us:

1. **2.1.223 clamps sessions on an UNRECOGNIZED model id to an assumed context
   window** (new env `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`, 0 → 8
   occurrences in the binary). **Every gateway model we ship is unrecognized**
   (`tgpt/qwen35-397b-a17b-fp8`). We already emit `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
   from the catalogue, and the binary's own warning names it as the remedy — but it
   does **not** name `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which is what our
   compaction gate relies on. **Whether our pair wins is the one thing static
   reading cannot settle**, and the assumed window's value could not be resolved
   out of the stripped binary. This is the live arm of U1.
2. **2.1.222 stopped `PreToolUse` auto-allow hooks from bypassing tool restrictions
   in background agent tasks** — that is exactly the `permissionDecision: 'allow'`
   mechanism row R1 of `2026-08-16-clean-runtime-usage.md` installed. Re-verify
   that boundary; do not assume it is unaffected.
3. **2.1.221 and 2.1.223 closed two Bash permission-check bypasses** (hidden command
   parts in zsh `[[ ]]` conditionals; tab / invisible-Unicode padding). Their fix is
   not ours — our AST validator and our approval card are separate code. Check
   whether we share the holes; if we do, that is its own row.

**Three fixes land free**, and one of them is a class we have chased: the
custom-`ANTHROPIC_BASE_URL` stream-idle-timeout fix (the CLR-12 stall class), the
print-mode `--mcp-config` "MCP not connected before the first turn" fix, and
"resume after a mid-session `/cd` comes back empty".

**Four opportunities worth their own rows later, not in this bump:**

- **`resumeSessionAt` now documents that it accepts ANY chain-entry UUID**, and that
  the right fork point is the kept turn's LAST chain entry. That legitimises a
  **cheaper shape for T2**: append our rebuilt entries and fork at our own last
  append, instead of minting a fresh session id and writing a whole file. Weigh it
  against (A) before T2 starts.
- **`SDKUserMessage.shouldQuery: false`** now documents that such appends "persist
  as bare user entries" — an in-band, non-`@alpha` way to put the **text** half of a
  handoff into Claude's own transcript with **no file write at all**. It cannot
  carry tool calls, so it does not replace T2, but it is a real alternative for
  P3's `text` tier.
- **`Options.resumeDropsTurn`** is a *validated* fork: the CLI refuses
  deterministically when the discarded range holds anything not attributable to the
  dropped turn. Our branch fork truncates unvalidated today. Converts a silent
  wrong-fork into a caught one.
- **`interrupt` gains `cancel_queued: true`** (capability
  `interrupt_cancel_queued_v1`), cancelling every queued and pending-dispatch
  command in the same round trip. **Our Stop path leaves a queued message alive
  today** — it reads only `still_queued` and has no cancel follow-up. One flag
  closes it.

**Ordering.** Land this **before T2**, not after: T2's golden fixtures and its
`message.model` decision are taken against whatever the installed CLI writes, and
doing it in the other order re-pins them immediately.

**One 0.3.223 change is directly relevant and was found while resolving G3.** On
0.3.218 a store-backed resume's temporary config dir carries only the transcript,
`.credentials.json` and `.claude.json` — **no `settings.json` at all**. 0.3.223
additionally copies `settings.json` and `cowork_settings.json` (stripping
`enabledPlugins`, `extraKnownMarketplaces` and `env.CLAUDE_CONFIG_DIR`) and creates
the projects dir mode 0700. Irrelevant under the chosen (A), but it is the reason
this bump would have been a **prerequisite**, not a nicety, had (B)/(C) been
chosen — record it so the ordering rationale survives a later re-opening.

**Files — the pin lives in THREE `package.json` files, not two:** root `:136`,
`packages/shared/:174`, **`packages/core/:15`**, plus ~10 `bun.lock` lines and 8
platform sha512s regenerated by `bun install`. Nothing in `build-dmg.sh` /
`build-win.ps1` / `build-linux.sh` / `ensure-claude-sdk-binary-dir.cjs` carries a
version — they resolve the platform package by name.

**Gate.** `bun install --frozen-lockfile` after the pin change,
`bun run typecheck:all`, `bun test packages/shared`, plus the Claude-runtime live
smoke — a dependency/lock change is a named risk trigger, so prove the boundary
once on the final diff. Record the full `sdk.d.ts` diff summary in the Tracker row.

---

### U2 — bump `@earendil-works/pi-coding-agent` 0.80.3 → 0.84.0 (an API rewrite, not a pin edit)

**Owner request 2026-08-20.** Artifactory `latest` is **0.84.0** (2026-08-06); we
pin **0.80.3** (2026-06-30) — four minors, thirteen releases. The pin lives in
four `package.json` files **plus** `apps/electron/resources/pi-agent-server/package.json:3`,
and
`SUPPORTED_PI_RUNTIME_VERSION = '0.80.3'` is compared with `!==`
(`packages/pi-agent-server/src/compat/pi-runtime-adapter.ts`), so the bump is a
deliberate, gated change — three minors and twelve releases.

> **CORRECTION, 2026-08-20.** An earlier draft of this row said the bump's
> headline was compaction gaining `retainedTail`, read out of the doc diff. **That
> was wrong, and it was wrong in the way this repo's own traps warn about — a doc
> read without the code.** `retainedTail` appears **five times in
> `docs/session-format.md` and zero times in `dist/`** of `pi-coding-agent` 0.83.0
> *or* 0.84.0. It is real, but it belongs to `pi-agent-core@0.83`'s `AgentHarness`
> session layer — a **different** JSONL subsystem that `pi-coding-agent` never
> imports. The file Nessy writes still walks `firstKeptEntryId` only. Also: the
> latest is **0.84.0** (2026-08-06), not 0.83.0.

**The session format is NOT the risk. The public API is.** Everything T7 needs
survives untouched: header still `version: 3`, all four `SessionManager` statics
byte-identical in signature, the fork/branch preflight unaffected,
`NESSY_SESSION_DIR` untouched.

**The load-bearing change landed in 0.80.8 — a PATCH — and it is an auth/model
rewrite:**

- `CreateAgentSessionOptions.authStorage` and `.modelRegistry` were replaced by a
  single async `modelRuntime`.
- `AuthStorage` and **every credential type** were removed from the package's only
  public export path.
- `ModelRegistry` lost both static factories (`create` / `inMemory`) in favour of
  `new ModelRegistry(runtime)`.

`PiRuntimeAdapter` is built entirely out of those five symbols, so all three of its
contract interfaces, `createRegistry`, `validatePublicSurface`, `validateBindings`
and the `createAgentSession` call are rewritten — **plus `handleTokenUpdate`, the
path that rotates the Nestor JWT into a live Pi session**, because `AuthStorage.set()`
is gone and its replacement `CredentialStore.modify()` is **async inside a sync
function**.

**Two more that break independently:**

- `Agent.streamFn` was renamed `streamFunction`; our auto-compaction-instruction
  extension reads it twice.
- **0.83 adds five new `AgentSessionEvent` variants** (`agent_settled`,
  `entry_appended`, `bash_execution_update`, two `summarization_retry_*`), the
  subprocess forwards every event unfiltered, and our host adapter's `default` arm
  yields `{type:'error'}` — so on 0.83 **the user gets an error banner on every
  settled turn** until that switch is extended.

**Two new egress / self-discovery surfaces that need an explicit opt-out**, and
they are exactly what our isolation posture exists to prevent:
`ModelRuntime.create()` defaults `modelsPath` to the **global**
`~/.pi/agent/models.json`, and every built-in provider is now wrapped in a
`pi.dev` catalog fetcher.

**Consequence for ordering:** T7 still lands after U2 — but for the API rewrite,
not for a compaction feature that does not exist in this package.

**Opportunities this bump does unlock** (rows of their own, not this task):
`sessionEntryToContextMessages` and `buildContextEntries` are now **public
exports**, so T7 can assert its rebuilt file round-trips through upstream's own
projection instead of re-deriving the entry→message mapping — a correctness oracle
the plan does not currently have. `agent_settled` + `isIdle`/`waitForIdle()` give a
first-class settlement signal where we derive our own from a seven-value pending
list. `before_provider_headers` could own the bearer→`Nestor-Token` rewrite that
lives in our loopback proxy today. And pi-ai's new per-request `fetch?: FetchFunction`
is a supported, provider-scoped alternative to our `globalThis.fetch` monkey-patch.

**Files, from the measured file list — this is the shape of the work:**

- `packages/pi-agent-server/src/compat/pi-runtime-adapter.ts` — three contract
  interfaces, `createRegistry`, both `!==` gates and the `createAgentSession` call:
  roughly **half of its 428 lines**.
- `packages/pi-agent-server/src/index.ts` — 2 type imports, 13
  `PiAuthStorage`/`PiModelRegistry` annotations, 3 sync `authStorage.set` → async,
  2 `agent.streamFn` → `streamFunction`, the cwd-transaction record's `authStorage`
  field at four sites, plus `modelsPath: null` and `PI_OFFLINE` for the two new
  self-discovery surfaces.
- `packages/shared/src/agent/backend/pi/event-adapter.ts` — **five new event cases
  before the error-yielding `default`**, or every settled turn shows an error
  banner.
- Four `package.json` pins + `apps/electron/resources/pi-agent-server/package.json:3`
  + the lockfile, and the lockstep siblings (`pi-ai`, `pi-agent-core`) move with it.
- `docs/architecture/runtime-capability-gaps.md` — its Pi section names the pinned
  version.

**Gate.** `bun install --frozen-lockfile`, `bun run typecheck:all`,
`bun test packages/pi-agent-server` — **and note the trap**: `typecheck:all` does
not typecheck that package's tests, so run `tsc -p` against a config without the
`**/*.test.ts` exclusion and record that output. Then the Pi live smoke, because a
dependency change plus an agent-loop change is a risk trigger. Re-read
`pi-session-lineage-real-server.test.ts` — it drives the real subprocess and is the
cheapest place to catch a session-format regression.

---

### U3 — decide `@anthropic-ai/sdk`: deliberate pin or 15 unnoticed minors

**Owner request 2026-08-20.** Root `package.json:137` declares
`"@anthropic-ai/sdk": "^0.100.0"`; installed is **0.100.1**; Artifactory `latest`
is **0.115.0**. A caret on a `0.x` version pins the MINOR, so `^0.100.0` will never
resolve 0.115 — the gap is invisible to `bun install` and will not close itself.

**Establish first, decide second.** This is the one runtime dependency where the
task is not "bump it": nothing in this repo has recorded whether 0.100 is a
deliberate floor. Find out — search the plans, the architecture records and the
commit that introduced the range — and only then choose:

| Option | Consequence |
| --- | --- |
| Bump to `^0.115.0` | 15 minors of a 0.x library, so breaking changes are expected by semver convention. Needs the full Claude-runtime boundary proven, not a typecheck. |
| Widen to `^0.100.0 \|\| ^0.115.0` | Not meaningful for a direct dependency; skip. |
| Keep the pin and record WHY | Cheapest, and legitimate — but the reason must be written down, or the next reader re-opens this. |

**What it is actually used for matters more than the version distance.** Find every
import of `@anthropic-ai/sdk` in the repo and report the surface: if it is only
types, the bump is nearly free; if it is the client used by the gateway path, the
bump is a risk trigger.

Files: `package.json`, the lockfile, and whichever record captures the decision.

**Gate.** Depends on the option chosen. For a bump:
`bun install --frozen-lockfile`, `bun run typecheck:all`, the Claude-runtime live
smoke. For "keep": a one-line record and nothing else.

---

### U4 — bump the Codex app-server `rust-v0.147.0` → `rust-v0.148.0`

**Owner request 2026-08-20.** `packages/codex-protocol/manifest.json` pins
`{repo: "openai/codex", tag: "rust-v0.147.0"}`; upstream's latest **stable** is
**`rust-v0.148.0`** (a `rust-v0.149.0-alpha.*` line is in progress and is not a
candidate). Verified 2026-08-20: `rust-v0.148.0` carries
`codex-package_SHA256SUMS`, the trust anchor `scripts/fetch-codex.mjs` requires
(HTTP 200); the bare `0.148.0` form does **not** (404) — upstream's release
*titles* drop the `rust-v` prefix for stable releases while the *tags* keep it, so
the manifest value stays `rust-v`-prefixed.

**This is the heaviest of the four bumps, because it is not a version string.**
The bump regenerates `packages/codex-protocol/generated/` and `schema/` from the
upstream protocol, re-fetches three platform binaries, and re-records their sha256
into `manifest.json` — which is the anchor `manifest-verifier.ts` checks **before
every spawn**. Precedent: `scripts/cdp/cases/cdx-147.ts` exists because the
previous bump (0.142.5 → 0.147.0) broke a wire shape.

**T1a's dependency is SETTLED, affirmatively and by measurement.** On a real
0.148.0 binary driven over stdio against a loopback Responses provider,
`thread/inject_items` accepts user / assistant / `function_call` /
`function_call_output` / **developer** items, and all five reach the provider
request body **in order, before the new user message** — the same 8-item body
0.147.0 produces, `store: false`, no harness metadata. So **T1b's mechanism is
provable offline today**; its blocker is P1 (the raw fields) and the pairing guards,
not the binary.

Scale, for calibration: 1473 files and 380 merged PRs moved upstream, and **the
surface we touch did not**. Every type behind the eight methods we send plus
`thread/inject_items` is byte-identical between the two tags; `ServerRequest` is
byte-identical; all 41 v2 approval / permission / sandbox types are unchanged. The
live method table grew 136 → 144 with nothing removed, and all eight additions are
`#[experimental]`, so the regenerated `generated/ClientRequest.ts` still lists
exactly 98 methods.

**Regeneration is cheaper than the row assumed, for a reason nobody had written
down:** our `generated/` is byte-identical to upstream's checked-in
`codex-rs/app-server-protocol/schema/typescript` at v147, and **no production file
imports a generated type** — only `manifest.json` and `schema/config-schema.json`
are imported. So the 13 added / 22 changed binding files **cannot** fail
`typecheck:all`, and regeneration needs a `git fetch` of the tag plus two directory
copies plus the `config-schema.json` asset, not the full binary.

**Three behaviour changes DO land, and two are default-ON:**

1. **`UnboundedConnectionRetries` — new, Stable, default ON.** A sampling request
   that fails to connect now retries **forever** with 5s→60s backoff instead of
   honouring `max_retries`. **Our loopback adapter is that connection.** Off switch:
   `[features] unbounded_connection_retries = false`.
2. **`unified_exec` default flips** from `!cfg!(windows)` to `true`, so the Windows
   build's model gets a different shell tool. Off switch:
   `[features] unified_exec = false`.
3. **`base_instructions` gains `provenance`** (measured on disk: 0.148 writes
   `{"type":"model","model":"…"}`, 0.147 writes nothing), and its whole purpose is
   that a model change stops carrying the previous model's instruction template —
   **which is exactly what our `thread/fork`-with-a-new-model switch did wrong on
   0.147.** So T3 is only instruction-correct from 0.148 onward. That makes U4 a
   quiet prerequisite of T3, not just of T1a.

Both risky defaults have a one-line off switch in the `config.toml` that
`config-writer.ts` already writes, so a bad smoke does not force a revert.

**And the bump unlocks something the plan currently calls unsolvable:**
`[features] retain_client_developer_messages = true` makes injected `developer`-role
items **survive Codex's own compaction** (up to 64 000 tokens of them) — and 0.147
ignores the key **silently**, so it is safe to write before the bump lands.

**REFUTED 2026-08-20 at integration — there is no such second channel, and the
way it was "proven" is the lesson.** An earlier pass recorded
`turn/start.additionalContext` as a per-turn, trust-labelled channel writing no
permanent rollout record, "proven live on both binaries". Three checks kill it:

- `TurnStartParams` carries **13 properties** and `additionalContext` is not one of
  them — in the TypeScript bindings **and** in the JSON Schema, at **both**
  `rust-v0.147.0` and `rust-v0.148.0`. `AdditionalContextEntry` /
  `AdditionalContextKind` exist, but they belong to the **hooks** subsystem
  (`additionalContextLimit`, the spill threshold in `HooksListResponse` and
  `ConfigRequirementsReadResponse`); ts-rs emits the whole `definitions` set into
  every schema file, which is the only reason the name appears in
  `TurnStartParams.json` at all.
- The live "acceptance" proves nothing: the app-server **silently accepts unknown
  fields** on `turn/start`. Measured with a positive control on the shipped 0.148
  binary — a `turn/start` carrying `no_such_field_at_all: 1` returned the same
  `{turn: {...status: inProgress}}` as one carrying `additionalContext`. A detector
  that cannot fail is not a detector (AGENTS.md).
- The hook-supplied `additionalContext` is real and **we already consume it**:
  `codex-agent.ts:1215` folds `promptResult?.decision?.additionalContext` into the
  same concatenated `effectiveMessage` as everything else.

**Consequence for G5, and it makes the recommendation stronger rather than weaker:**
the only proven alternative channel is `thread/inject_items`, and it writes
PERMANENT rollout records, so it is the wrong channel for the volatile blocks
(date/time, `session_state`). For those, riding the user message is forced —
`prompt-builder.ts:211-215` records why folding them into the cached system prefix
is not an option — so `:109`'s GAP is real and its corrected REASON is
"no other channel that is right for volatile per-turn context", not "no other
channel at all".

**Ordering.** Either land U4 **before T1a** (so T1a is written against the version
we will ship) or hold U4 until after T1a and accept re-verifying the inject path.
The first is cheaper; the second is only right if U4 turns out to break something
unrelated.

Files: `packages/codex-protocol/manifest.json` (tag + the three binary sums),
`packages/codex-protocol/generated/**` + `schema/**` (regenerated, never
hand-edited), and whatever the regeneration moves in
`packages/shared/src/agent/codex-agent.ts` / `packages/codex-agent-server/`.

**Gate.** `node scripts/fetch-codex.mjs --all` then the protocol regeneration;
`bun run typecheck:all`; `bun test packages/codex-agent-server`; the `cdx-147`
live case re-pointed at the new version (rename or add `cdx-148`), because a wire
shape is exactly what the previous bump broke. Binary + spawn-verifier change is a
risk trigger under the verification budget — prove the boundary once on the final
diff.

**2026-09-11 — the case this gate names has moved again, and this gate's own
reasoning is why it had to.** U4 did what the line above asks. The pin then moved
a second time, to `rust-v0.150.1` (P7.2, `f042e5674`), and the live case was
re-pointed the same way it was here: RE-POINTED, never renamed —
`scripts/cdp/cases/cdx-150.ts` is the current file and the 0.148-era one is no
longer in the tree (`d014ab97d`). The lift found exactly the class this gate was
written against: `approval_policy = "untrusted"` is FATAL at 0.150.1 — the process
exits 1 before answering `initialize` — and this product emitted it for every mode
whenever the sandbox master switch is off, which is the shipped default, so every
codex session would have failed to start (`9375093b4`).

---

### T8 — sweep `claude-config/projects` (D5), and close 37 orphans that already exist

**D5 ANSWERED 2026-08-20.** Nothing in this repo sweeps `claude-config`:
`retention-sweep.ts` is an explicit allowlist that does not name it, and
`deleteSession` removes only `sessions/<ws>/<id>`. **The leak is not hypothetical
and not created by this plan** — measured 2026-08-20: **37 of 165** vendor project
dirs are orphaned right now (1 236 KiB), and the tree grew to 217 files /
8 552 KiB in five days. T2 makes it worse in a specific way: it mints a **new**
sdkSessionId per switch, so each switch strands the previous transcript instead of
overwriting it.

**Change.** Add `claude-config/projects` as a new path class in the existing
age-based `retention-sweep` allowlist, swept under the same `cleanupPeriodDays`
cutoff. Use the one mechanism in this repo already designed to delete user data —
it is dry-runnable, it logs the removal set, and it is allowlist-shaped.

**Rejected alternative:** unlinking the previous transcript at the switch. It means
deleting inside a **vendor-owned** directory, which contradicts the recorded mirror
precedent ("the host never deletes from a mirror on its sweep"), and it would not
touch the 37 orphans that exist independently of this plan.

**Independent of T2.** This task stands on its own — the leak predates the plan —
so it can land in any wave. It is listed here because T2 is what makes the growth
rate matter.

Files: `packages/shared/src/sessions/retention-sweep.ts` and its test.

**Gate.** A dry-run over the real tree recorded in the Tracker row (the sweep
supports it), plus a unit row asserting a fresh transcript is **not** swept and an
aged one is. `bun run typecheck:all`.

---

### T9 — Reconnect a gateway connection from its row menu (owner request 2026-08-21)

**Owner request, verbatim intent:** when a gateway card shows «Not authenticated»,
the user today is routed through a settings redirect and re-creates the
connection by hand; the row's own menu should instead carry a **Reconnect**
action that runs the same one-click re-auth the cards already use.

**Today's three surfaces, measured 2026-08-21:**

| Surface | Where | What it does |
| --- | --- | --- |
| `GatewayAuthBanner` | top strip above the chat (`components/app-shell/MainContentPanel.tsx:249` — re-verified 2026-08-21, the line holds; the row originally gave the bare filename and the file is not at the repo root) | arms on the launch check's `login-required` (`nessy:gatewayAuthStatus` events → `useNessyGatewayAuth`), its button runs `ensureGatewayAuth` DIRECTLY — the one-click dp flow, no redirect. Dismissible. |
| `CredentialHealthBanner` | inside Settings → AI (`AiSettingsPage.tsx:126-158` — corrected 2026-08-21 from `:128-150`; the props interface opens at `:126` and the component closes at `:158`) | lists credential issues; its button (`handleReauthenticate`, `:793` — held exactly) calls `openApiSetup(defaultConn.slug)` — **this is the redirect the owner describes**: the user lands in the API-setup flow and reconnects by hand. |
| Row menu «Re-authenticate» | `ConnectionRow` (`AiSettingsPage.tsx:341-345` — held exactly) | EXISTS but only for `authType === 'oauth'` (`handleReauthenticateConnection` → openApiSetup + OAuth restart). The gateway cards are `api_key_with_endpoint` and `canEditLlmConnection` is false for managed cards, so their menu shows only Rename / Set as default / Validate / Mid-stream / Delete — exactly the owner's screenshot. |

**Change.**

1. In `ConnectionRow`'s menu, add a **Reconnect** item for gateway-backed managed
   cards — the membership rule is the one the dp flow itself serves:
   `isNessyGatewayBaseUrl(connection.baseUrl)` (the same verified-URL rule that
   scopes Nestor request rewriting and T4's dp credential leg). Wire it to the
   SAME `ensureGatewayAuth` path the banner and the setup cards run
   (`useNessyGatewayAuth().ensure()`), not to `openApiSetup` — the point is that
   the user never re-creates anything. On success, refresh connection statuses so
   «Not authenticated» clears in place.

   **Corrected 2026-08-21 — take the rule from the RENDERER twin, not from
   `@nessy-agent/shared/agent/backend`.** Both export `isNessyGatewayBaseUrl` and
   both are the same whole-URL match against the same literal, so the RULE in
   this row is right. The import source was not: the shared barrel also
   re-exports `createAgent` / `ClaudeAgent` / `PiAgent` — subprocess and fs code —
   and **no production renderer module imports it today** (`grep -a` over
   `apps/electron/src/renderer`: two hits, both in one test file). The twin at
   `components/apisetup/nessy-gateway.ts:77` exists for exactly this, carries the
   sync note in its own doc comment, and is already reached the same way by
   `byo-runtime.ts:27`. Not routed through the `@/components/apisetup` barrel,
   which does not re-export it — and widening the barrel was outside this task's
   file scope.
2. Reflect the flow's phases on the row (checking / waiting-browser /
   exchanging), reusing the shared hook's state the way the banner does — a
   disabled item with the in-progress label is enough; do not invent a second
   status surface.

   **The hook must be the PAGE's, not the row's** (settled 2026-08-21 by reading
   `hooks/useNessyGatewayAuth.ts:70-75`): it subscribes to the GLOBAL
   `nessy:gatewayAuthStatus` stream, so one instance per `ConnectionRow` would
   put every gateway row into the in-progress state at once — and would light
   them up for a flow the chat banner started, too. The page holds the single
   hook plus a `reconnectingSlug`, and passes each row `reconnectPhase =
   reconnectingSlug === conn.slug ? phase : null`. This is the page's existing
   per-row idiom: `validationStates[conn.slug]` and the `onValidate={() => …}`
   closures beside it.
3. The `oauth` Re-authenticate branch stays byte-identical.
4. `CredentialHealthBanner`'s button, for gateway connections only, takes the
   same one-click path instead of `openApiSetup` — the redirect stays only for
   connections that genuinely need the form.
5. i18n: `settings.ai.reconnect` (+ an in-progress variant if the label changes)
   × 2 locales, sorted; parity/sorted lints. **One key was enough** — the
   in-progress labels reuse the banner's own
   `onboarding.gatewayConnect.connecting` / `.waitingBrowser`, so the two
   surfaces cannot word the same flow differently.

**Gate.** Renderer unit rows: the item renders for a gateway card and NOT for a
BYO api-key card nor an oauth card (which keeps its own item); click invokes
`ensureGatewayAuth` and a success refreshes statuses; the oauth branch
unchanged. `bun test` on the settings-page suites, `typecheck:all`, both i18n
lints.

**How those rows are written, since `bun test` has no DOM here** (no
happy-dom/jsdom/testing-library — stated in three existing renderer suites): the
RULE is extracted to an exported pure `computeGatewayReconnectItem(connection,
reconnectPhase)`, the `computeGatewayBannerView` pattern the sibling banner
already uses, and the WIRING is pinned by source match — the instrument
`submit-control.test.ts` and `composer-permission-modes.test.ts` use. The page is
loaded by DYNAMIC import after two `mock.module` stubs and a `DOMMatrix` shim: it
reaches the `@nessy-agent/ui` barrel → the markdown/PDF chain →
`pdfjs-dist/build/pdf.worker.min.mjs?url`, which bun cannot load, and a static
import hoists above the stubs. All three lines are the repo's established fix
(`plugin-info-diagnostics.test.tsx`, three playground registry suites, and the
note at the top of `components/ui/styled-dropdown.tsx`).

Files: `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`,
`packages/shared/src/i18n/locales/{en,ru}.json`, and the page's new test file
`apps/electron/src/renderer/pages/settings/__tests__/ai-settings-reconnect.test.ts`
(the page had none).

---

## P.9 The debt lane (owner decision 2026-08-21: everything lands inside THIS plan)

The close-out wave's findings and the plan's owed halves become plan rows
rather than external chips. Order: T11 → T10 → T12/T13 → T14 → T7 → W-pkg.
Owner grants recorded here: **the COMPACT-LIFE window grant is GIVEN** (W-pkg
may temporarily narrow one model's `contextWindow` in the operator's real
`config.json` through the product's own write path, restoring it after the
run). **PRV-N25 stays OUTSIDE this plan** (needs the un-hidden Pro/Max card and
an owner sign-in; owner: «позже»).

### T10 — boot fails loudly when the storage layout cannot be used, and a fresh dir boots packaged

Measured 2026-08-21 (run file `docs/testing/cdp-runs/2026-08-21-1.31.0-close-out.md`):
the dev app logs `Unhandled rejection … UnsupportedStorageLayoutError` against a
pre-v2 config tree and never creates a window; the PACKAGED app is fully silent
on the same trees AND on a completely fresh empty config dir — no window, no
log line, Chromium bootstrapped, the app script's context empty. Fix: (1) the
boot path catches the layout rejection, shows a dialog naming the config dir
and the problem, exits non-zero; (2) diagnose why a FRESH dir rejects on
packaged at all (first-init must create v2 cleanly — suspect list in the run
file); (3) a boot test per arm. Commit subject:
`fix(boot): a storage layout the app cannot use fails loudly instead of hanging`.

**Corrected 2026-08-21, at execution.** The row's evidence was three separate
DETECTOR failures stacked on one real defect. Every claim below was measured
first-hand on the packaged arm64 build.

1. **"The PACKAGED app is fully silent … no log line" is evidence of nothing.**
   `apps/electron/src/main/logger.ts` sets `log.transports.file.level = false`
   **and** `log.transports.console.level = false` whenever `isDebugMode` is
   false, so a packaged build writes to `~/Library/Logs/Nessy Desktop/main.log`
   on **no** launch, successful ones included. The repo already names the lever
   that restores it (`DEBUG_LEVER = 'NESSY_IS_PACKAGED=false'`,
   `scripts/cdp/lib/runtime-session-log.ts`) and already ships one always-on log
   for precisely this reason (`autoUpdateLog`, added for #891). Packaged and dev
   were doing the same thing; only the reporting differed. The new
   `<config dir>/logs/boot.log` follows `autoUpdateLog`'s precedent.

2. **The pre-v2 tree is not rejected by readiness at all — the two validators
   disagree, and that gap is the defect.** `~/nessy-cdp-elc/config.old-layout-2026-08-21/config.json`
   carries `storageLayoutVersion: 2` and `workspaceRefs: []`, and the tree has
   `workspaces/`, `sessions/`, `plugins/` — so `inspectRoot` returns `v2` and
   `ensureStorageLayoutV2` returns **`ready`**. It has no `activeWorkspaceId`
   key, and `loadStoredConfig`'s `config.activeWorkspaceId !== null` is TRUE for
   `undefined`, so the FIRST read after "ready" throws
   `UnsupportedStorageLayoutError` (`storage.ts:956`). It throws at
   `index.ts`'s `ensureBundledSkills({ storedConfig: loadStoredConfig() })`,
   which sits BEFORE the big `try`, so the rejection escaped the whole callback.
   `loadStoredConfig` is deliberately NOT loosened: `activeWorkspaceId:
   string | null` is required in `StoredConfig`, and this validator is the
   fail-closed guard that stops a legacy config being overwritten.

3. **The hang is `app.whenReady().then(async …)` being unawaited.** The
   rejection reached `process.on('unhandledRejection')`, which logged (nowhere)
   and returned; with no `BrowserWindow` ever created, `window-all-closed` never
   fires and nothing quits. One `.catch` on that promise is the fix.

4. **Item (2) of the row — "fix fresh-init on packaged" — had nothing to fix.**
   A fresh dir initializes correctly: measured on an absent root, an existing
   empty root, and live on the packaged build (new test file
   `packages/shared/src/workspaces/__tests__/storage-readiness-config-gap.test.ts`).
   What the row was actually looking at is a different, real hole: a config dir
   whose **parent** does not exist yields blocked `unsafe-root` (`assertSafeParent`
   requires every ancestor to be an existing non-symlink directory), and the
   readiness-BLOCKED path had no log line whatsoever — its modal dialog was its
   only surface. That path now logs before it opens the dialog.

5. **`app.exit()` does not end this process, and it also stops the timers that
   would notice. This cost three failed designs and is the row's real finding.**
   With the message loop running and no window ever created, `app.exit(1)`
   returns and the app keeps idling in `[NSApplication run]` (sampled, twice).
   Controls on the SAME packaged binary: a minimal main exits 1 every time —
   with or without the single-instance lock, a privileged scheme, a protocol
   client registration or `--remote-debugging-port`; the same call at the very
   top of `whenReady` exits (before the loop runs Electron takes its direct
   `exit(code)` path); and once a window exists it exits again (Electron
   destroys windows instead of running the windowless `Browser::Shutdown()`).
   `process.exit()` behaves identically — Electron routes it. Three designs
   failed on the rig while passing their unit tests:
   - a 60 s `setTimeout` watchdog — **never delivered**. A 5 s timeout was
     delivered in the same position, so the app is throttled, not stopped: a
     windowless app with nothing on screen is what macOS naps. Waits are now
     counted in 1 s steps.
   - `app.exit()` called from inside the dialog's nested run loop — it dismisses
     the alert AND consumes Electron's one-shot shutdown, after which every
     later `app.exit()` is a permanent no-op.
   - a 2 s hard-exit grace timer armed immediately AFTER `app.exit()` — never
     delivered either, because `app.exit()` stops Node timer delivery on this
     process. The app then idled on precisely the hang this task removes.

   So the ending is two calls in ONE tick: `app.exit(code)` for the clean case,
   immediately followed by `process.kill(process.pid, 'SIGKILL')`. Nothing may be
   scheduled between them. On the windowless boot-fatal path the observed exit
   status is therefore 137, not 1 — non-zero and bounded, which is the contract
   the row asked for. **The packaged live check, not the unit gate, is this
   row's acceptance**: every one of the three failures was green in `bun test`.

   Also measured: the parentless `dialog.showMessageBox` blocks the main thread
   in a nested loop AND **renders nothing** on a windowless startup here
   (`System Events` reports zero windows for the process). The dialog is
   genuinely best-effort, exactly as the row's gate anticipated; the log line and
   the exit are the contract.

6. **The global `unhandledRejection` backstop was deliberately NOT made to
   exit.** The boot promise's own `.catch` is the exact signal for "startup
   failed"; escalating every stray boot-phase rejection would kill launches that
   were about to succeed. The global handlers now write the always-on diagnostic
   while boot is incomplete, and change no behaviour.

### T11 — deny/ask Bash rules descend into substitution spans

From the U1 CLI-fix audit (2026-08-20): `matchClaudeBashRule` matches deny/ask
against top-level subcommands only, so `deny Bash(rm:*)` misses `echo $(rm -rf ./x)`;
`splitWithSubstitutions` already exists and the removal circuit breaker uses it.
Allow rules are unaffected (glob-allow already refuses substitution). Match
deny/ask against `splitWithSubstitutions(command)`; table-driven tests (deny in
`$()`, in backticks, nested budget, unparseable). Commit subject:
`fix(permissions): deny and ask Bash rules see into substitution spans`.

**Corrected 2026-08-21, at execution.** The row said to "check Claude's
permissions.md compound-command section first and cite it" — that section
**does not answer the question**. § *Compound commands* names the separator set
only (`&&`, `||`, `;`, `|`, `|&`, `&`, newlines) and says a rule "must match each
subcommand independently"; the whole page never states what a Bash rule sees
inside `$(…)`, in either direction. So the reach is our choice, and the citation
has to come from where the page states the deny/allow asymmetry itself:
§ *Wrappers* — "A deny or ask rule matches past any leading assignment, so
`Bash(rm *)` in deny still matches `FOO=bar rm -rf tmp/`" — reinforced by
§ *File permission rules* ("**Deny and ask rules**: `Read(secrets/**)` matches a
directory named `secrets` at any depth") and by the reason the page gives for
allow's narrower parameter matching ("An allow rule for one parameter value
wouldn't establish that the call is safe overall"). Nothing on the page
contradicts the change, so there is no divergence to report — only a documented
asymmetry to extend. Two facts the row did not have: the reach also covers
**subshells `(…)` and process substitution `<(…)`**, because `scanCommand` opens
a span for a top-level `(`; and single-quoted text stays inert, so
`echo '$(rm -rf ./x)'` is correctly still `no-match`.

### T12 — MCP-AUTH's dp half learns deferred MCP

The case asserts `mcp__dpGitlab__dp_gitlab_whoami` directly on the session
surface; since deferred MCP, builtin dp tools sit behind
`PI_DEFERRED_MCP_TOOL_THRESHOLD` (48) and the operator profile is always past
it. Make the dp arm tool_load-aware (search → load → call through the app's own
path), keeping the figma half untouched. Commit subject:
`fix(cdp): MCP-AUTH's dp arm loads deferred tools before calling them`.

**Corrected 2026-08-21, at execution.** Three of the row's premises needed
measurement, and two were wrong in ways that would each have produced a false
product defect.

1. **`mcp__tool_load` does NOT make the tool callable in the same request, so
   the arm takes TWO turns.** The load tool answers *"MCP tools available on the
   next model turn of this request"*, and the first implementation believed it:
   the model searched, loaded (that exact success text, naming the tool), then
   called it **nine seconds later in a separate model turn** and got
   `Tool mcp__dpGitlab__dp_gitlab_whoami not found` — twice, in one measured
   session. The positive control settles which half is wrong: the SAME tool, in
   the SAME session, called on the next USER request, ran and returned the corp
   identity (`i.i.gavrikov`). `pi-agent-server/src/index.ts`'s `onLoadToolNames`
   sets `toolsChanged` beside its `registerTool` call, and the host's own
   comment at the registration seam (`server-core/src/sessions/SessionManager.ts`)
   records the reason — *"Pi only picks up new proxy tool defs on the next
   handlePrompt"*. (AUDIT CORRECTION 2026-08-21: this was originally cited to
   `packages/shared/AGENTS.md`, which never carried the sentence in any commit.) So the probe loads in turn one
   (forbidden to call) and calls in turn two. **The over-promising message is a
   real product finding and is NOT fixed here** — out of this row's scope; it
   belongs to whoever owns the deferred surface.
2. **`NO-DP-TOOL` cannot carry the BLOCK any more, and the obvious host-side
   detector reads false at exactly the wrong moment.** Absence is now decided by
   `mcpHealth.connected` off the session's own harness snapshot — but keyed off
   `mcpHealth` itself, NOT off `snapshot.available`. That flag is
   `!!managed.agent?.getHarnessDiagnostics?.()`: it means *a Pi turn is live*,
   and it reads `false` with `unavailableReason: 'pi-runtime-not-started'`
   between turns, which is when a case looks. Measured 2026-08-21:
   `available:false` alongside a perfectly good
   `connected:["dpGitlab","plugin_figma_figma"]`. Gating on the flag threw that
   answer away and blocked the case on "no Pi harness snapshot to ask".
3. **A multi-line prompt cannot be sent.** The composer's contenteditable
   swallows a newline outright instead of collapsing it to a space, so
   `sendPrompt`'s normalised read-back refuses it with `composer-mismatch`
   (measured on this very prompt). Every probe prompt is one line.

Out of scope and left as it was: the **figma** half fails on the same deferral
mechanism (`Tool mcp__plugin_figma_figma__get_metadata not found` while
`mcpHealth.connected` names `plugin_figma_figma`). The row says the figma half
stays byte-identical, so it does — its FAIL is pre-existing and unchanged, and
it is the same one-line fix if an owner wants it.

### T13 — Q6-LIVE's claim-4 control stops switching onto a remote connection

`sessionOn` uses `setConnection`, which `switchSessionRuntime` refuses for
`nestor-cloud-agent` (`CONNECTION_NOT_SWITCHABLE`) since the 1.27 plan — after
Q6's last green run. Give the control a create-on-connection path (or read the
catalog through a session that never switches); the claim itself (the gate
refuses a runtime that dispatches no definitions) is unchanged. Commit subject:
`fix(cdp): Q6-LIVE's refusal control no longer switches onto a remote connection`.

**Corrected 2026-08-21, at execution.** The row's premise held exactly, and the
create-on-connection door it hoped for exists and is SHIPPED — nothing had to be
invented, so the row's fallback ("or read the catalog through a session that
never switches") was not needed and the control keeps its full strength.

1. **Where the refusal lives, verified.** `SessionManager.switchSessionRuntime`
   throws `CodedError('CONNECTION_NOT_SWITCHABLE', 'Remote connections cannot be
   switched into an existing session')` on `target.providerType ===
   'nestor-cloud-agent'`, and `ConnectionRow` filters the provider out of the
   picker for the same reason. It guards SWITCHING only.
2. **Creation is a different, unguarded and shipped door.**
   `CreateSessionOptions.llmConnection` rides the `sessions:create` RPC the
   renderer's own New Chat uses; `SessionManager.createSession` passes it
   straight into `createManagedSession(..., { llmConnection: options?.llmConnection })`
   with no provider gate anywhere on the path, and the `spawn_session` session
   tool offers the same field to the model. So `sessionCreatedOn` drives a real
   product path, not a harness back door.
3. **Still no turn, for the same mechanical reason as before.**
   `resolveManagedProvider` returns `resolveConfiguredProvider` for every non-Pi
   session, which reads `managed.llmConnection` — set at creation here instead of
   at switch. The control therefore never touches a live remote backend, which is
   what the original comment was protecting.

`sessionOn` is deliberately UNCHANGED and still serves the three local runtimes:
only the cloud arm moved, because only the cloud arm is refused.

### T14 — iOS renders the runtime-switch notice instead of the raw marker

D3's recorded iOS half: mobile does not decode `message_added` (live row
dropped) and renders `runtime_switched:pi:anthropic` verbatim on reload. R1
extended the marker with a JSON tail (`{"carry":…}`), parsed by position — the
iOS parser must do the same: decode `message_added`, parse prefix + optional
JSON tail, render localized copy (the three carry tiers), tolerate the bare
two-segment form. `apps/ios/NessyMobile`. Commit subject:
`feat(ios): the runtime-switch notice renders as copy, not as the raw marker`.

**Landed 2026-08-21. Both measured gaps were real and both are closed; three
things the row assumed are corrected here.**

1. **Decoding was NOT the big half — it is nine lines.** The row is written as
   if (a) might be a pipeline job, and §P.9's bound was quoted at it in case it
   was. It is not: `SessionEvent` is a flat enum with a `default: .unknown` arm
   and `ChatViewModel.apply` is a flat switch over it, so `message_added`
   (`dto.ts:505`, `{ type, sessionId, message }`) is one case, one decode arm
   reusing the `ChatMessage` decoder `user_message` already uses, and one
   `apply` arm that appends deduped by id. **No part of the iOS event pipeline
   was redesigned and none needed to be.**
2. **The parser lives in `NessyAgentKit`, not in the app, and that is what made
   it testable.** `RuntimeSwitchNotice` is a pure `Sendable` struct with a
   failable `init?(markerContent:)` in the same file that already mirrors
   `runtime-switch-copy.ts` (`Models/RuntimeSwitch.swift`), so its table runs
   under `swift test` on macOS with **no simulator at all** — the package
   declares `.macOS(.v15)` for exactly this. The desktop suite's cases are
   ported one for one, because the two parsers read one durable string written
   by one server.
3. **The render half needed one seam the row does not mention.** Which rows the
   divider claims is a *decision* (`.info` AND parses as a marker), and a
   decision inside a `@ViewBuilder` is proven by nothing but the compiler. It is
   extracted as `MessageBubble.switchNotice(for:)` and pinned both ways: an
   `.info` marker row becomes the notice, and an ordinary `info` row, a
   `.status` row carrying the same text, and an assistant row all keep what they
   had. Without that seam this task would have shipped its visible half unproven.

Two facts worth carrying forward. The notice is composed at **render** time from
the stored marker, so the offline path gets it for free — `CachedMessage`
persists `role` + `content` verbatim, so a cached transcript renders the same
sentence in the reader's current language. And iOS localisation is
**English-literal-as-key** (`String(localized:)` + `ru.lproj/Localizable.strings`,
en is the development language and its table is deliberately empty), which means
a key typo does not fail — it silently serves English. The four RU rows were
therefore checked against the **compiler's own** emitted key list
(`swift build -Xswiftc -emit-localized-strings`) rather than by eye, and again
in the built `.app`.

**Found, not fixed (out of this row's scope):** `RuntimeSwitch.confirmation`'s
three strings — the switch-confirmation dialog iOS already shipped — have **no**
`ru.lproj` rows, so that dialog is English-only on a Russian phone today. It
predates this plan and is not part of D3's iOS half.


### T15 — `mcp__tool_load`'s message stops promising a turn it cannot deliver

Found live by T12 (2026-08-21): three strings promise the loaded tool "on the
next model turn of this request" (`deferred-mcp-tools.ts:140/141/174`,
`index.ts:1848`), but `onLoadToolNames` only arms `toolsChanged` and the Pi
session is recreated with the new tool **on the next user request** — the
deliberate design recorded beside the registration seam in server-core's
`SessionManager.ts` (audit correction 2026-08-21: previously miscited to
`packages/shared/AGENTS.md`, which never carried it). The model believes the
message, calls in the same request, gets "not found" twice and tells the user
the tool is broken. Fix the strings and the prompt snippet to the truth (finish
this reply; the tool serves from the user's next message), and pin the wording
in a test. Making the promise TRUE is a recorded non-goal: registering into a
live loop mid-request would lose the loop's state. Commit subject:
`fix(pi): the tool_load message stops promising a turn it cannot deliver`.

### T16 — MCP-AUTH's figma arm loads deferred tools too

T12's finding, mirrored: the figma arm fails `Tool
mcp__plugin_figma_figma__get_metadata not found` while `mcpHealth.connected`
names the server — the same deferral mechanism, scoped out of T12 by
instruction. Apply T12's exact pattern (search → load → call on the next
request); the OAuth precondition stays an honest BLOCKED when the owner is not
signed in. Commit subject:
`fix(cdp): MCP-AUTH's figma arm loads deferred tools before calling them`.

**Corrected 2026-08-21, at execution.** The deferral fix worked on the first
live run and immediately falsified the row's central assumption.

1. **Deferral was not the only thing wrong with this arm, and fixing it is what
   made the second fault visible.** With the tool finally reachable
   (`figma-reached-by: mcp__tool_search → mcp__tool_load → the tool on the next
   request`), the call died at Pi's OWN argument validation:
   `Validation failed for tool "mcp__plugin_figma_figma__get_metadata": -
   fileKey: must have required properties fileKey`, thrown by `validateToolCall`
   (`@earendil-works/pi-ai`) **before anything left the client**. The remote
   OAuth figma server is not the desktop one this case's default was written
   against: 31 of its 32 tools require a `fileKey` or a node id — a real Figma
   file the harness cannot invent — so `get_metadata` could never have produced
   the "the server ANSWERS" positive this arm exists for, deferral or no
   deferral. Reporting that as a FAIL is the same false product defect T12
   found. **The default probe is now `whoami`** (no arguments; only an
   authenticated server can answer it), which is the exact probe shape the dp
   half already uses. `NESSY_CDP_FIGMA_TOOL`/`_ARGS` still override.
2. **T12's header quoted the pre-T15 load message twice as if it were current.**
   Nothing in code matched on it, so it was stale prose rather than a pin — but
   it would have taught the next reader a string the product no longer emits.
   Corrected, and the case now states explicitly that it pins NO wording of that
   message: both arms assert the MECHANISM (load in turn one, call in turn two)
   and only ever OBSERVE the load result. The live run recorded T15's new text
   verbatim: *"MCP tools loaded and available from the user's next message (not
   callable in this request): mcp__plugin_figma_figma__whoami"*.
3. **"Honest BLOCKED" needed two more branches than the row named.** The OAuth
   one is unchanged. Added: a call that never reached figma (local schema
   refusal) blocks naming the arguments knob, and a session where the figma
   server is in neither the tool surface nor the deferred catalogue blocks on
   the plugin precondition instead of asserting the server is broken. A
   `figma-reachable` observation also records how STRONG the pre-sign-in
   negative control is — "the call did not succeed" says nothing about auth if
   the server was never there.

**Not measured by this run:** figma is signed in on the operator profile, so the
run took the post-auth branch. The pre-sign-in negative control and its OAuth
block were not exercised live; that logic is unchanged apart from the added
strength note.

### T17 — the iOS switch-confirmation dialog speaks Russian

Found by T14: `RuntimeSwitch.confirmation` on iOS has **no** `ru.lproj` rows at
all — English-only on a Russian phone. Pre-existing (predates this plan), taken
in per the owner's findings-become-rows rule. Add the RU rows and verify them
the way T14 did — against the compiler's emitted key list
(`swift build -Xswiftc -emit-localized-strings`), never by eye: iOS's
English-literal-as-key scheme serves English silently on a typo. Commit
subject: `fix(ios): the switch-confirmation dialog is localized in Russian`.

**T17 corrections (2026-08-21):** the row's verification recipe does not work —
`-emit-localized-strings` emits nothing in driver or `-frontend -typecheck`
mode (probed on a one-line file: exit 0, empty dir), and
`SWIFT_EMIT_LOC_STRINGS=YES` on the `xcodebuild` command line is ignored for
SwiftPM package targets. The compiler-emitted list that DOES exist is the APP
target's `xcodebuild -exportLocalizations … SWIFT_EMIT_LOC_STRINGS=YES`
(127 units), and it caught what reading the package alone missed: the dialog's
**"Switch" button** is a SwiftUI literal in `ModelPickerView.swift` (app
target), not in the package — so the dialog needed four rows, not three. The
package's own keys cannot be exported (no `defaultLocalization` in
`Package.swift`); they were enumerated from source — 8 `String(localized:)`
calls, 4 already translated by T14, 3 added here. At runtime a package
`String(localized:)` resolves against `Bundle.main`, so the app's `ru.lproj`
serves package strings — the mechanism T14's live run already proved.

### T18 — the rest of the iOS app's user-visible strings speak Russian

Found by T17's export, taken in per the findings-become-rows rule: **18 units
still have no RU target.** Four are InfoPlist — `CFBundleDisplayName` /
`CFBundleName` stay the brand (identity rows), but `NSCameraUsageDescription`
and `NSLocalNetworkUsageDescription` are real sentences iOS shows in permission
prompts. Fourteen are Localizable: Appearance, Theme, Dark, Light, Integration,
Permission mode, Send message, Stop response, Start a conversation, Select a
session, No files, No models available, `%lld.`, `·` — the last two get
identity rows so the export stays clean by inspection. Verify the same way:
re-export, missing count 18 → 0. Commit subject:
`fix(ios): the remaining user-visible strings are localized in Russian`.

**T18 corrections (2026-08-21):** two of the 18 were not what the row said.
(1) There is no `InfoPlist.strings` on EITHER side — the export synthesizes
those four units from `Info.plist` itself, so the fix creates the en base child
too, mirroring the Localizable convention. (2) A clean export was NOT
sufficient evidence: the xcodegen-generated `project.pbxproj` referenced no
`InfoPlist.strings`, so `-exportLocalizations` read the new files from disk
while a real build would have shipped neither — `xcodegen generate` re-run
(diff: +14 lines, purely the new variant group and its Resources entry) and the
export re-proven on the regenerated project. The `·` / `%lld.` identity rows
are annotated in the file (list numbering and the session-row separator).

### T19 — the desktop Russian locale stops echoing English

Found by T18's vocabulary check, taken in per the findings-become-rows rule:
**77 keys in `packages/shared/src/i18n/locales/ru.json` carry a value
byte-identical to `en.json`** (measured 2026-08-21 by a script comparing the
two files, alphabetic values only). Some are deliberate (brand and product
terms: Claude, Webhook, Slug, API Key), but the list includes plain UI
sentences — `chat.permissionMode` ("Permission mode"), the `chat.submit.*`
send/stop/queue labels, `chat.queue.*` tooltips. Triage all 77: translate the
genuine gaps, keep deliberate terms and list them in the tracker note so the
next sweep does not re-file them. iOS T18 already translated its
"Permission mode" as «Режим прав» — align the desktop key with it. Gates:
`bun run lint:i18n:parity` + `bun run lint:i18n:sorted` green. Commit subject:
`fix(i18n): the desktop Russian locale stops echoing English for translatable strings`.

### T20 — MCP-W2's Pi and Claude arms learn the two-turn deferred shape

W-pkg's finding, taken in per the findings-become-rows rule: MCP-W2 is FAIL
14/25 **on its own shape** — its Pi/Claude arms predate deferred MCP and call
in the turn that loaded, the same drift T16 fixed for MCP-AUTH. The invariant
itself was proven by control on all three runtimes (the minted wire name
dispatches and the fixture server logs the nonce). Transplant the T16 pattern
(turn one searches and loads and is forbidden to call; turn two calls), pin no
wording of the load message, and re-sit the case live. Commit subject:
`fix(cdp): MCP-W2's deferred arms call in the turn after the load`.

**EXECUTED 2026-08-21. Five things this row assumed, corrected per §P.3 step 4.**
Live tails in `docs/testing/cdp-runs/2026-08-21-t20-22-case-debt.md`.

1. **"Its Pi AND Claude arms predate deferred MCP" is half right: deferral is
   Pi-only.** `mcp__tool_search`/`mcp__tool_load` live in the Pi harness
   (`packages/pi-agent-server/src/deferred-mcp-tools.ts`,
   `PI_DEFERRED_MCP_TOOL_THRESHOLD` in
   `packages/shared/src/agent/pi-harness/harness-manifest.ts`) and nowhere else,
   so the Claude runtime's selection turn takes the "already in your tool list"
   branch and loads nothing. **The packaged wave's Claude `-32601` did not
   reproduce on the dev build** — the arm was 7/7 green BEFORE the change and
   7/7 after. The turn is kept on that arm anyway, per this row, because it can
   only observe.
2. **The single-turn call was only HALF the Pi drift, and the other half is
   three more checks.** The inventory turn reads the model's OWN tool list, and
   a deferred tool is deliberately absent from it — so
   `mcp__plugin_cdp-echo-probe_echo__whoami` and both F3 names were red on Pi
   about tools the product was hiding on purpose. Measured before the change:
   Pi's TOOLS line was `…, mcp__tool_load, mcp__tool_search` and nothing else,
   **six** Pi reds, of which three were the call. Loading in a turn of its own
   fixes all six, because the inventory that follows it is a new request.
3. **A prompt that names the tool under test and forbids calling it in the same
   sentence that asks for it to be loaded is read as an injection — and it cost
   a full sitting.** Verbatim from the Pi load row: `Guardian denied this action
   [prompt_injection]: The planned action loads four MCP tool names, including
   one explicitly forbidden by the embedded instruction, which attempts to
   masquerade as authorized`. The model retried without that name, so the one
   tool the case exists to call was the one the selection turn left out, and the
   call turn's `Tool … not found` read exactly like a deferral bug. The
   restriction is now positive ("use only these two tools"), and the case
   records whether the load result named the probe tool so the next occurrence
   names its own cause instead of blaming dispatch.
4. **The observation that IS the evidence was truncated before the evidence.**
   `<arm>-model-reported-surface` was sliced at 2 000 characters; on this fixture
   profile the `t-tracker` built-in alone contributes ~60 names, so every
   recorded observation ended mid-`t-tracker` and a red and a green looked
   identical in the report. Recorded whole now.
5. **The three model-self-report checks are unreliable on every arm, and that is
   measured, not asserted.** Three consecutive Claude sittings on one build and
   one profile: all three minted names once, none of them twice — and the
   under-reporting run was not truncated, it enumerated `mcp__session__*` and
   `mcp__t-tracker__*` in full and stopped before the fixture's servers, closing
   with a well-formed `SKILL=YES`. **The control is the PRE-T20 shape**: with the
   selection turn removed the same three checks went red again, so the added turn
   is not the cause. Same class as the Codex reds the checklist has carried since
   0.147. The checks stay (this is the only live surface where a wire name
   appears at all, G5), but the run's verdict on the MINT is the tool-call trio.

**Result: MCP-W2 22/25, Pi 8/8 and Claude 7/7** — every former Pi/Claude red is
green. The three remaining reds are Codex's model-self-report rows, the
pre-existing detector limitation on the arm this row says not to touch.

### T21 — COMPACT-LIFE deletes its session before its connection

W-pkg's finding: the case's cleanup is unpassable since `764ee8662`
(2026-08-17) — `deleteLlmConnection` now refuses while a session still uses
the connection, and the case never deletes the session it made. Delete the
session first (the product behaving exactly as designed is not a FAIL). The
lifecycle half is already proven 12/13 on the packaged build; re-proving
compaction is NOT required — prove the cleanup arm alone (create → delete in
the fixed order) if a full sitting is disproportionate, and say which was run.
Commit subject: `fix(cdp): COMPACT-LIFE tears down in an order the product allows`.

**EXECUTED 2026-08-21. The cleanup arm alone was run, with a negative control**,
on the `~/nessy-cdp-g6` FIXTURE profile — the operator's `config.json` was not
touched, and the compaction half (12/13, packaged) was not re-sat. Tail in
`docs/testing/cdp-runs/2026-08-21-t20-22-case-debt.md`.

Two things the row did not say, corrected per §P.3 step 4:

1. **The case could not be IMPORTED, so the arm could only have been proven by a
   copy of itself.** Its `runCase` call sat at module top level, unguarded — the
   only case in `scripts/cdp/cases/` without `if (import.meta.main)`, so any
   import ran the whole 20-minute sitting. The guard is added and the two
   teardown helpers are exported, which is what let the proof drive **the case's
   own code** rather than a replica of it. A replica proves the replica.
2. **A cleanup proof without the wrong order is not a proof.** The probe deletes
   the connection FIRST as its negative control, and the product's refusal is
   the evidence that the order is load-bearing: `1 session(s) and 0
   automation(s) still use "claude-gateway-77"`, with the connection still
   listed afterwards. Then, in the T21 order: session gone, connection gone,
   both verified by re-listing, and the fixture profile back to its three
   connections. `T21-CLEANUP-PROOF: PASS`.

The case also gained the check the order deserves ("the run-owned session is
gone, which is what lets the connection go", 13 checks → 14 on the claude arm),
the refusal MESSAGE is now carried into the failure detail — the difference
between "cleanup failed" and "cleanup failed because six sessions from a
previous sitting still hold this slug" — and the header records why
`NESSY_F5_SLUG_SUFFIX` is mandatory rather than convenient on the operator
profile.

### T22 — RTS-14 asserts its own plant, and the HANDLER_ERROR gets a look

W-pkg's finding: `workLeg` plants a fact by asking the model to `cat` a file
and asserts nothing about the tool row — so a leg where the model answers
`DONE` without running the command scores three carry reds about a fact that
never entered the conversation (packaged: 33/36 twice, tag absent from the
Claude SDK's own transcript). Add a plant assertion: a leg whose required tool
row is missing must fail AT THE PLANT with its own message (or retry the leg
prompt once, emphatically, the way RTS-15 did), never reach the carry checks.
Re-sit RTS-14 live. While it runs, watch the anchored codex → pi leg for
W-pkg's single unexplained `HANDLER_ERROR` (one occurrence in two packaged
runs, none on the wire): if it reproduces, capture the wire and STOP —
that is a product finding for the owner; if it does not, record the
non-reproduction with the run as its control. Commit subject:
`fix(cdp): RTS-14 fails at a missing plant, not at the carry`.

**EXECUTED 2026-08-21, four live sittings on `~/nessy-cdp-rts/config` (dev app).**
Tails in `docs/testing/cdp-runs/2026-08-21-t20-22-case-debt.md`.

| run | result | what it shows |
| --- | --- | --- |
| A | FAIL 31/32, 184 s | **the `HANDLER_ERROR` REPRODUCED** — see below |
| B | FAIL 16/17, 97 s | **the plant assertion fired for real**: leg 3 (codex) produced no tool row after BOTH asks, and the case stopped AT THE PLANT — it never reached a carry check |
| C | PASS 42/42, 199 s | the whole circuit, every plant verified, every carry green |
| D | PASS 42/42, 189 s | the same, on the shipped code |

**⚠️ THE `HANDLER_ERROR` IS A PRODUCT FINDING, AND THE WIDER CAPTURE NAMED IT.**
Run A's leg 6 (codex → claude, an anchored return):

```
leg 6 switch → claude: {"ok":false,"error":"HANDLER_ERROR","errorDetail":{
  "name":"CodedError","code":"HANDLER_ERROR","message":"pi-session-disposal-failed",
  "keys":["stack","message","code","name"]}}
```

and the app's own log for the same second:

```
16:00:59.026 INFO  IPC: switchRuntime received for session c9bd6212-… connection: claude-gateway
16:01:00.450 WARN  [session] Failed to dispose agent for c9bd6212-… during runtime switch
                   (connection-cross-runtime): codex-runtime-cleanup-failed
```

So the chain is: the DEPARTING runtime's teardown throws
(`cleanupRuntimeResources` → `AggregateError(failures, 'codex-runtime-cleanup-failed')`,
`packages/shared/src/agent/codex-agent.ts:1941`), the strict drain collects it and
rethrows it as **`AggregateError(failures, 'pi-session-disposal-failed')`**
(`packages/server-core/src/sessions/SessionManager.ts:11032`), and the RPC layer
flattens that to `HANDLER_ERROR`. Three separate observability defects for the
owner to weigh, none of them fixed here (this is a `packages/**` change and the
row's instruction is to STOP and report):

1. **The message names the wrong runtime.** `pi-session-disposal-failed` is what
   a CODEX cleanup failure reports, because the strict-drain wrapper is
   Pi-named. W-pkg's occurrence was read as a Pi-side fault for exactly that
   reason, on a leg where the departing runtime was codex too.
2. **The leaf cause never leaves the process.** `cleanupRuntimeResources`
   collects four candidate failures (`client.close`, `manager.kill`,
   `adapter.close`, `rmSync` of the managed `CODEX_HOME`) and logs only the
   AggregateError's own message, so WHICH one failed is unknown even with the
   full main log.
3. **The user gets `HANDLER_ERROR` and no more.** The switch is atomic in the
   end — the session stayed on `codex-gateway`, its transcript carries the four
   earlier `runtime_switched:` markers and none for the failed leg — so nothing
   is corrupted; what is missing is any way to know why the switch refused.

Frequency: **once in four sittings today** (run A), once in two packaged
sittings on 2026-08-21. Runs C and D are the non-reproduction control on the
same rig and the same leg family, minutes apart. The case now captures the
wrapper message, `data` and the `cause` chain on every switch failure
(`lib/runtime-switch.ts`, failure path only), which is the change that turned a
bare code into a named cause.

**Two smaller corrections.** (a) The row said a missing plant should fail "or
retry once" — it does both, in order, and run B proves the sequence end to end.
(b) The failure sentence must not print beside an `ok`: the first shipped
version passed its detail unconditionally, so a GREEN plant line read "ok … the
model did not run `cat …`" — the same self-contradicting line COMPACT-LIFE's
cleanup check already documents. Fixed, and run D is the re-sit on the corrected
code.

### T23 — the lane-G BYO set re-sits on the carry tree, operator profile

Owner request 2026-08-21: run the llm-proxy BYO set on the REAL operator
profile ("так он и существует для этой разработки"), using the saved
connections (`pi-api-key-2..5`, `codex-custom`, `claude-custom`,
`claude-custom-2`) — the key never crosses the chat. Legs: BYO-CATALOG
(the catalogue the operator's key is actually entitled to — record whether any
deepseek model is in it), BYO-QWEN (Pi), CODEX-TURN (Codex), G3-WIRE
(anthropic-wire through the Claude runtime), plus the NEW user-shaped arm the
owner asked for: a Qwen model added to a `claude-runtime` connection the same
way the interface does it, then a live turn through the local translator
(default `openai-compatible` upstream — `buildClaudeRuntimeUpstream`). If the
catalogue serves a deepseek id, one extra turn on Pi or Codex. A 401 from the
stored key is a BLOCK naming the fix (owner updates the key in the app), never
a case FAIL. Known server-side caveat to record honestly if hit: the llm-proxy
guardrail sometimes refuses tool-carrying requests on anthropic models.
No commit subject — results land as docs (checklist rows + run file).

**EXECUTED 2026-08-21. Five things this row assumed, corrected per §P.3 step 4.**
Narrative, verbatim tails and the before/after connection listings in
`docs/testing/cdp-runs/2026-08-21-t23-lane-g.md`.

1. **BYO-CATALOG cannot answer "the catalogue the key is entitled to", and was
   never meant to.** It asserts on the models already SAVED on a connection. The
   catalogue is the Add/Edit form's own Fetch RPC —
   `testLlmConnectionSetup({ slug, baseUrl, fetchModels: true })`, whose handler
   resolves the stored credential server-side by slug — and it answered **388
   rows, byte-identical for all seven llm-proxy connections**. A fetch is what
   the endpoint ADVERTISES; entitlement is the per-model probe
   (`validateModels` → `probeOpenAiCompatModel`), and the two differ sharply.
2. **DeepSeek: YES.** 21 of the 388 carry a deepseek id; probed, the two `tgpt/*`
   ones answer `ok` and the `openrouter/*` / `cloud/*` families answer
   `no-quota`. The conditional arm therefore ran — `tgpt/deepseek-v4-flash-fp8`
   on `pi-api-key-4`, `DEEPSEEK-OK`, restored.
3. **This row's own example model manufactures its own failure.**
   `tgpt/qwen3-235b-a22b`'s window is 40 960 and a session's resting context is
   ~46 000 (AGENTS.md's own figure), so the first Qwen-on-Claude turn came back
   `400 … maximum context length is 40960 tokens. However, your request has 56666
   input tokens`. Re-run on `tgpt/qwen35-397b-a17b-fp8` (262 144) →
   `TRANSLATE-OK`. The row's example should not be copied.
4. **There is no `upstream: openai-compatible` debug line.** The observable is
   `[codex-adapter] upstream auth: <scheme>`, written by **`postChat` only**
   (`nestor-client.ts:126`) — the chat-completions path; the G3 passthrough
   (`postAnthropicMessages`) never calls it. So the line's PRESENCE is the
   translated-path proof and its `bearer` value is the `openai-compatible`
   upstream (gateway mode prints `nestor-token`). It lands in the app's own log,
   not a subprocess buffer, because `ClaudeAgent.postInit` starts the adapter
   in-process.
5. **G3-WIRE fails for two reasons, neither ours.** The llm-proxy guardrail
   refused the turn — `403 … Security Guardrail Triggered: Malicious MCP
   detected. Invalid tools: …`, listing our own `mcp__session__*` tools as well
   as plugin ones, i.e. any tool-carrying turn on the anthropic wire — while the
   tool-free probe in the same run answered `ok wire=anthropic-messages`, so the
   wire is proven and the turn is blocked by the endpoint. The mixed half had no
   chat-completions model on `claude-custom-2` (substrate).

**Three product findings, none fixed here (all outside a docs-only row), each
suggested as its own tracker row.** (a) `window-manager.ts:350` maps a restore
onto the dev server by keeping the SAVED PATHNAME, so after a packaged run the
dev app loads `http://localhost:5173/Users/…/release/…/index.html` — Vite answers
200, `did-fail-load` never fires, and the window has no `window.electronAPI`;
this contradicts the contract written on the field itself
(`window-state.ts:19-23`, "rebuilds the URL from `__dirname` (prod) or the
current dev server (dev)" — true of the prod branch only). (b) The BYO 403 above
is ALSO reported to the user as *"Your Nessy Gateway sign-in is missing or
expired. Open Settings → AI and click Sign in on the gateway card"* on a
connection that has no gateway sign-in. (c) Q6-LIVE sitting B caught a Pi
subagent dispatch by the fully-qualified capability KEY answering
`Unknown agent "agent:plugin://…#agent.scan-inventory@workspace:…"` while listing
`scan-inventory` in its own "Available agents".

### T24 — Q6-LIVE claim-4 gets a lawful control

Standing FAIL recorded at the close-out wave, taken in per the
findings-become-rows rule: the case's claim-4 control switches an existing
session ONTO a remote connection, which the product deliberately refuses since
the 1.27 runtime-switching plan. Rebuild the control on create-on-connection
(create the session already on the remote connection, the path the product
does allow), then re-sit the case live. Commit subject:
`fix(cdp): Q6-LIVE proves claim 4 on a switch the product allows`.

**EXECUTED 2026-08-21. THIS ROW IS A DUPLICATE OF T13 AND ITS CODE FIX HAD
ALREADY LANDED** — recorded rather than absorbed, per §P.3 step 4. T13 is the
same finding, and it landed as `ab3fbe1a3` (`fix(cdp): Q6-LIVE's refusal control
no longer switches onto a remote connection`) hours before T23–T25 were written:
`sessionCreatedOn` (`q6-live.ts:266`, used at `:504`) is exactly the
create-on-connection rebuild this row asks for, `sessionOn` is untouched and
still serves the three local runtimes. Verified against the tree as it is now
before anything was run, so this row collapses to **the re-sit** — which is the
half T13 could not carry, since its own live evidence predates the corrected
tree. Nothing about the claim moved and no further case change was needed; the
commit under the subject above carries this correction, the tracker rows and the
run file.

Re-sat twice on the operator profile. **Sitting A (the mandated one): 8 checks,
8 ok** — `catalog-cloud: the session runs on nessy-cloud-agent` then
`claim 4 control: the gate still REFUSES a runtime that dispatches no
definitions — 14/14 rows refused on nestor-cloud-agent`, against `0/14` on
Codex, `0/14` on the Pi control and `0/14` on the session-less read. The
deterministic `CONNECTION_NOT_SWITCHABLE` the 1.31.0 close-out measured is gone.
The case ends BLOCKED on the three arms that need operator-arranged agents, which
is the honest result.

**Sitting B armed two of those three** (`NESSY_CDP_PLUGIN_AGENT=cru-plain`,
`NESSY_CDP_FOREIGN_MODEL_AGENT=scan-inventory`; `NESSY_CDP_DEAD_CHILD_AGENT`
deliberately NOT set — both recipes the case offers damage the profile, and this
is the owner's real machine). 15/17, claim 4 green again, and **both armed
claims' SUBJECTS passed**: `[model] scan-inventory asked for "sonnet", which this
session cannot serve; it ran on "tgpt/qwen35-397b-a17b-fp8"` with the ceiling not
refusing, and `claim 3: cru-plain is IN the SDK's agent registry`. Its two reds
are ONE case defect and are taken in as T26 below.

### T25 — a failed runtime-switch disposal reports its true cause

T22 reproduced W-pkg's open HANDLER_ERROR (leg codex → claude, intermittent —
2 of 6 sittings): `codex-agent.ts:1941` throws
`AggregateError('codex-runtime-cleanup-failed')`, the strict drain rethrows it
as `pi-session-disposal-failed` (`SessionManager.ts:11032`), and RPC flattens
that to a bare `HANDLER_ERROR`. Nothing is corrupted — the switch is refused
and the session stays whole on the source connection, which is the fail-safe
working as designed. Three reporting defects to fix: (1) the rethrow names Pi
for every runtime — name the runtime that actually failed; (2) the
AggregateError's LEAF errors never reach any log — log them, they are the only
way the next reproduction diagnoses the underlying intermittent codex cleanup
failure; (3) the renderer shows the bare code — surface the existing
`chat.runtimeSwitch.failed` copy with the runtime name (i18n parity/sorted
green). The underlying intermittent cleanup failure itself stays OPEN and
recorded — diagnosing it needs the leaf log this row adds. Tests: unit rows
for the renamed error and leaf logging; no live gate (intermittent). Commit
subject: `fix(sessions): a failed switch disposal names its runtime and its cause`.

### T26 — Q6-LIVE claims 2 and 3 stop reading a launch receipt as an answer

Found at T24's sitting B (2026-08-21), taken in per the findings-become-rows
rule. Both arms score a red on a child that is still running: the agent tool
result they read is the background LAUNCH RECEIPT — *"Async agent launched
successfully … The agent is working in the background. You will be notified
automatically when it completes"* — not the child's reply. **The case's own
header already documents this trap**, for claim 1: *"A top-level dispatch goes to
the background by default, so the parent's turn returns a launch receipt and ends
before the child can die — and that receipt sailed through the check that was
meant to read the reason."* Claim 1 was rebuilt around it
(`claimOneDeadChildSaysWhy` uses the receipt as a handle on the SECOND turn);
claims 2 and 3 were left on the old shape. Give them the same treatment: detect
the receipt, wait for the completion turn the host starts, and read the answer
there — or fail with "the child never settled", which is a different claim from
"the child returned nothing". Both claims' SUBJECTS already pass, so this row
changes what the last check of each arm reads, nothing else. Gate: a re-sit with
`NESSY_CDP_PLUGIN_AGENT` and `NESSY_CDP_FOREIGN_MODEL_AGENT` armed, 17/17.
Commit subject: `fix(cdp): Q6-LIVE claims 2 and 3 wait for the child, not the receipt`.

**EXECUTED 2026-08-21. The row's premise held. Four things it could not know,
corrected here per §P.3 step 4 — three were measured on the rig before a line
was written, and the fourth by the first sitting of the fix.**

1. **The two runtimes emit DIFFERENT receipts, so claim 3 could not simply
   reuse claim 1's guard.** `BACKGROUND_RECEIPT` matches Pi's
   `Started background subagent task / task_id: …`. The Claude SDK returns
   `Async agent launched successfully … agentId: <id>` — no `task_id:`, no
   "Started background" — verbatim from the shipped
   `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` binary's `async_launched`
   arm. Hence a second expression (`SDK_ASYNC_RECEIPT`) and one
   `backgroundDispatch` reader that returns whichever handle it found.
2. **The answer does not only arrive on a LATER turn**, which is what the row's
   "wait for the completion turn the host starts" assumes. Claim 3 already had a
   wait of that shape and it is why sitting B burned five minutes before
   reporting the answer missing: on the Claude runtime the settlement lands
   INSIDE the launch turn — either a blocking `TaskOutput` on the receipt's own
   id, or the SDK's `<task-notification>` block addressed by `<task-id>`, both
   measured. The scan therefore starts at the launch turn, not after it.
3. **Binding on the handle is necessary and NOT sufficient.** Sitting C (the fix
   as the row scoped it) turned both arms green — and one of the two greens was
   false: the Pi arm's carrier was the parent's own prose,
   `ACDC7-… / The scan-inventory agent has been started as a background task
   (task ID: task-subagent-mt37v0b0-v5p17h)`, i.e. the launch announcement with
   the token pasted above it, scored while the child was still running. The
   parent composes the child's prompt, so it knows the token; an earlier turn in
   the same run also caught the model hand-writing its own `<task-notification>`
   block. Only two carriers count now — a tool RESULT bound to the handle, or a
   settlement report addressed to it — and model prose counts for nothing.
   Without this correction the row would have replaced a false red with a false
   green, which is the worse of the two.
4. **"Only each arm's last check moves" is one check short, on claim 2.** The
   `[model] …` announcement is written by `subagent-tool.ts` into the CHILD's
   report, never into the receipt, so a backgrounded dispatch cannot carry it in
   the agent tool result: sitting C measured
   `claim 2: the substitution announces itself — no [model] line in the agent
   result` FAIL, the same defect one check higher up. The announcement and the
   ceiling check now read the same child report the answer check does. This is a
   correction of the row's scope sentence, not a widening of it: same arm, same
   defect, same evidence.
5. **The follow must not be skipped when the token turns up early**, which
   sitting D added on top of (4). Its model pulled the answer out of the
   backgrounded child with four `subagent(resume: …)` calls; those results carry
   the child's text and NOT the spawn's `[model]` line, so a wait that stops at
   the first sight of the token banks an answer and misses an announcement that
   is already on its way — the host's notice for that same task id arrived at
   message 24 of the session carrying `[model] scan-inventory asked for "sonnet",
   which this session cannot serve; it ran on "tgpt/qwen35-397b-a17b-fp8".`
   verbatim. The wait is therefore for the SETTLEMENT, not for the token, and it
   runs whenever a receipt exists.
6. **One rig repair, in the case's own `sessionOn`.** Sitting D died before
   claim 3 on `SESSION_BUSY` — `Cannot switch connection while another session
   mutation is in flight` (`SessionManager.ts:15704`) — raised against a session
   three seconds old, after four green switches in the same run: the switch
   arrived while the session was still inside its own creation mutation, which
   the boundary refuses rather than queues. `setConnectionWhenIdle` retries that
   ONE message for 30 s; every other error, `CONNECTION_NOT_SWITCHABLE`
   included, still escapes on the first attempt.

Claim 1, claim 4 and the case's BLOCKED honesty are untouched, and no
`packages/**` file was changed.

**The gate is NOT 17/17, and the surviving red is a PRODUCT miss the fixed case
is now able to see.** Best sitting (H, fresh app): **15/17** — claim 4 green
8/8, **claim 3 green end to end** through the carrier this row exists to read
(`claude-plugin-agent-report: {"via":"tool-result:TaskOutput", …
<task_id>a590e8b7fc7fd8e6e</task_id> … <status>completed</status> … <output>
086E2-D212A-356A5-EE359`), BLOCKED on claim 1 as always. Claim 2's two reds are
one fact, measured three times (sittings E, H, I): a Pi background child reached
`status: completed` in the runtime's own snapshot and **no completion
notification ever reached the parent**, within 5 minutes. The host's own log is
the second witness — it records every `task_completed` it receives and recorded
none for those three task ids, while recording them for sitting D's task, for
sitting H's first (failed) dispatch and for both Claude-SDK tasks. Sitting I
shows the SDK-side face of the same miss: `task_completed` DID reach the host and
still nothing reached the parent, because the delivery gate is
`managed.piBackgroundTaskKinds`, written only by `task_backgrounded`, which
`tool-matching.ts:407` emits only when the tool input carried
`run_in_background: true` — and the SDK backgrounds an agent of its own accord.
Taken in as **T30**, and not fixed here: it is `packages/**`, and this row is a
case fix. Two rig failures are recorded in the run file — `EMFILE` on the
never-swept 1 557-record `.pi-processes` directory (killed sittings F and G at
the first switch, and **surfaced through T25's new leaf log**), and the
`SESSION_BUSY` race repaired in the case.

### T30 — a settled background child that never reports to its parent

Found at T26's gate (2026-08-21), taken in per the findings-become-rows rule.
`packages/**`, not a case defect, and the case now measures it: a Pi background
subagent whose PARENT TURN HAS ALREADY ENDED settles — `status: completed` in
`getPiHarnessRuntime`'s own child snapshot — and the host never receives
`task_completed` for its task id, so `deliverMonitorEvent` never runs and the
parent is never told. Three reproductions (`task-subagent-mt389ecd-cof32w`,
`…-mt38u5ec-x9zwy0`, `…-mt39496i-uimuxi`) against four positive controls in the
same log, all on the operator profile. Every miss is a run whose parent stopped
on the receipt; every control is a run whose parent kept working (a `resume`, a
foreground re-dispatch). The suspect is `registerBackgroundChildTask`'s `settled`
promise — `runAllAndSeal` for a detached run — never resolving once the
parent's turn is over, but that is a hypothesis and the first step is to
instrument it. **A second face, on the Claude runtime**: there `task_completed`
DOES reach the host and the delivery is dropped instead, because
`SessionManager.ts:22372` gates on `managed.piBackgroundTaskKinds`, which
`task_backgrounded` writes only when `tool-matching.ts:407` saw
`run_in_background: true` in the tool input — an SDK that backgrounds an agent
by itself never sets it. Both halves break the same promise `sub-agents.md`
makes ("A background subagent's results reach Claude as a completion
notification in a later turn"), and R86 built the Pi half for exactly that
sentence. Gate when it is taken: Q6-LIVE claim 2 green on a re-sit whose parent
turn ends on the receipt, plus unit rows for whichever half the diagnosis lands
on. Commit subject (when fixed):
`fix(sessions): a settled background child always reports to its parent`.

**EXECUTED 2026-08-21. Four things this row assumed, corrected per §P.3 step 4 —
and the first one names a different file than the row does.**

1. **The Pi suspect was wrong, and the real drop is one unconditional line in the
   HOST.** The row suspected `registerBackgroundChildTask`'s `settled` promise
   never resolving once the parent's turn is over, and said the first step is to
   instrument it. It does not need instrumenting: the subprocess emits the event
   correctly — `settled` is `runAllAndSeal`'s own promise and `emitEvent` is
   `send({ type: 'event', event })`, neither of which knows a turn exists. The
   host throws it away. `PiAgent.handleSubprocessEvent` opened with
   `if (this.rawEventAttemptTerminal) return`, and that latch is armed at the
   turn's terminal boundary (`shouldCompleteQueue` → `eventQueue.complete()`,
   and on both abort paths) and cleared only by the NEXT `chatImpl`. A detached
   run publishes on the far side of that line by design, so its `task_completed`
   was dropped before it was ever adapted. **That single line also explains all
   four of this row's positive controls in one sentence**: in every control the
   parent kept working, so a later turn had already cleared the latch.
2. **Getting past the latch is only half — the event then needs a sink that is
   not the turn.** `eventQueue` is per-turn and `reset()` discards whatever the
   last turn left in it, so an enqueue after the boundary would be a second,
   quieter drop. Hence `BackendConfig.onPiDetachedTaskEvent`, wired by
   `SessionManager` into the SAME `processEvent` the turn loop feeds. The set it
   carries is exactly `task_completed` and `task_notification` (R10's detached
   MCP result, the identical miss); `task_backgrounded` is always the turn's, and
   `task_progress` is not a raw subprocess event at all.
3. **The Claude anchors moved and the receipt is longer than the run file's
   capture.** The gate is `tool-matching.ts:406` (`:407` is the `if` it feeds),
   and the SDK sentence, verbatim from the shipped
   `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 2.1.223 — one occurrence
   in the whole binary — is `Async agent launched successfully. (This tool
   result is internal metadata — never quote or paste any part of it, including
   the agentId below, into a user-facing reply.)`. Matching the SENTENCE and
   never `agentId:` alone is what keeps the guard the gate was written for: a
   foreground answer can mention an agent id, and never carries the launch line.
4. **`adaptBackgroundTasksChanged`'s recorded refusal is NOT reversed, and it
   is a different question.** `claude/event-adapter.ts:1244` rejects mapping the
   `background_tasks_changed` LEVEL feed onto `task_backgrounded`, partly because
   it would make the matching completion deliver a monitor event. That decision
   stands and this row does not touch it: the fix is on the tool-RESULT path,
   which already emitted `task_backgrounded` whenever the model asked for
   `run_in_background` — so no new class of delivery is introduced, only the
   same one for children the SDK backgrounded itself.

**A second finding from the same sitting is NOT in this row** and needs an owner
call on where it belongs: the first Pi `subagent` dispatch answered
`Unknown agent "agent:plugin://registry-…#agent.scan-inventory@workspace:…"` and
then listed `scan-inventory` among its own "Available agents" — the dispatch used
the fully-qualified capability KEY where the runtime registers the LOGICAL name.
The model recovered by retrying under the plain name (rows 2–4 `completed`), so
it is degraded rather than broken, and it is `packages/**` rather than a case.

### T27 — a restored dev window rebuilds its URL from the dev server

T23's rig finding, a real product defect: `window-manager.ts:350` restores a
saved window by keeping the saved PATHNAME on the dev-server origin, so a dev
launch after a packaged run loads `http://localhost:5173/<packaged path>/index.html`
— Vite answers 200, `did-fail-load` never fires, and the window silently has no
`window.electronAPI`. The contract on the field itself (`window-state.ts:19-23`)
says the URL is REBUILT from `__dirname` (prod) or the current dev server (dev)
— only the prod branch does. Make the dev branch rebuild too (origin + the dev
entry path, ignore the saved pathname). One unit row for each branch. Commit
subject: `fix(shell): a restored window rebuilds its dev URL instead of replaying the saved path`.

### T28 — a BYO 403 stops wearing the gateway sign-in banner

T23's finding: llm-proxy's guardrail 403 on an anthropic-wire turn surfaces as
"Your Nessy Gateway sign-in is missing or expired…" on a BYO connection that
HAS no gateway sign-in. Find the classifier that maps 401/403 to the gateway
re-auth banner and scope it to connections whose base URL is the verified
gateway (`isNessyGatewayBaseUrl` — the same scoping rule the auth header
already follows); a BYO 4xx surfaces the provider's own error text instead.
Unit rows: gateway 401 → banner (unchanged), BYO 403 → provider error, BYO 401
→ provider error. Commit subject:
`fix(sessions): a BYO endpoint's 403 is not a gateway sign-in prompt`.

### T29 — subagent dispatch by fully-qualified capability key ⏸ scoping

T23 sitting-B finding, `packages/**`: a Pi subagent dispatched by its
fully-qualified capability key answers `Unknown agent "agent:plugin://…#agent.scan-inventory@workspace:…"`
while the SAME reply lists `scan-inventory` in its own Available agents — the
registry indexes short names, the dispatcher accepted a qualified key. First
step is a scoping look: find where the key form diverges (dispatch parsing vs
registry indexing) and either fix the obviously-right side with tests, or —
if both sides are defensible — park with a crisp owner question in the final
report. Commit subject (if fixed):
`fix(agents): a subagent dispatches by its qualified key as well as its short name`.

### T31 — `.pi-processes` records fall under retention

Found at T26's sittings F/G, taken in per the findings-become-rows rule: the
operator profile holds **1 557 never-swept `.pi-processes` records**, and the
accumulation surfaced as `EMFILE: too many open files, scandir '…/.pi-processes'`
killing a runtime switch at its first step (visible through T25's new leaf
log, which is that row working). The tree already has the precedent to follow:
the 1.31.0 close-out put `claude-config/projects` under the same age-based
retention as the rest of the session data — do the same for the
`.pi-processes` records (find the sweeper that owns session-data retention and
add this directory to it; do NOT invent a second sweeper). One unit row: an
old record is swept, a fresh one survives. Commit subject:
`fix(sessions): .pi-processes records fall under session retention`.

**EXECUTED 2026-08-21. The row's fix is landed as written, and its PREMISE —
that retention is what stops the EMFILE — is measured false. Both facts belong
in the same note.**

1. **What landed.** `retention-sweep.ts` grew a `pi-process-record` tier: the
   unit is one HANDLE (`process_<32hex>.json` plus its `.log`), aged from the
   NEWER of the two, allowlist-shaped so `scratch/` and anything the store grows
   next survive by construction, and the directory itself is kept exactly like
   `logs` and `feedback`. `NEVER_SWEPT_SESSION_ROOT_ENTRIES` stays — it means
   "never enumerated as a workspace", which is still true and still
   load-bearing. The module header's claim that the store is "lifecycle-managed,
   never age-swept" was the recorded reason this class was excluded, and it is
   the thing this row corrects: nothing clears the leftovers here.
2. **The profile's real numbers, and why the before/after is unchanged.** The
   store held **807 records / 1 615 files**, every one terminal (`exited` ×803,
   `stopped` ×4). But the OLDEST is **8.0 days** and none is older than 14, while
   `retentionDays` defaults to **30** — so the startup sweep on the launch that
   carried this fix reported, verbatim,
   `[retention] sweep found nothing older than 2026-07-22T18:37:15.647Z`, and the
   count is **807 → 807**. The absence has a positive control: the same shipped
   `runRetentionSweep`, dry-run at a 7-day cutoff with every other tier disarmed,
   plans **310 removals (155 records × 2 files) and 0 from any other class**. The
   tier is wired; this profile simply has nothing old enough.
3. **So retention does not prevent the EMFILE, and the row's motivation needs a
   second fix that is NOT this one.** At the measured rate (~100 records/day) a
   30-day window settles near 3 000 records — more than the ~800 that broke it.
   The proximate defect was measured on the first switch of this row's own
   launch: `ProcessStore.list()` (`packages/server-core/src/pi-harness/process-store.ts:150`)
   does `Promise.all(names.map(get))` over EVERY record in the directory, and the
   fd storm that follows takes down unrelated reads first — the log's first
   `EMFILE` is on `automations.json` and `plugins/installed.json`, and the
   `scandir '…/.pi-processes'` line the run file recorded is its TAIL, 600 ms
   later. The main process holds ~127 fds at rest; `launchctl limit maxfiles`
   reports a soft limit of **256**, which the launcher's `ulimit -n 8192` does
   not raise (Electron does not inherit it the way a Node child does), so an
   807-way fan-out cannot fit however the shell is configured. **Bounding that
   fan-out is a different file and a different mechanism from this row, so it is
   NOT absorbed here** (§P.3's scope bound) — it needs its own row, and until it
   exists a live sitting on this profile keeps dying at its first runtime switch
   roughly half the time.

### T32 — `ProcessStore.list()` stops opening every record at once

T31's measured refutation of its own premise, taken in as the real fix: the
EMFILE that killed runtime switches is not record AGE (oldest 8 days vs the
30-day policy) but FAN-OUT — `ProcessStore.list()`
(`packages/server-core/src/pi-harness/process-store.ts:150`) opens every
record in one `Promise.all`, 807 records = 1 615 files against an Electron
fd budget of 256 (`launchctl limit maxfiles`; the launcher's `ulimit -n`
does not reach Electron — a Node child raises its own limit, Electron does
not). At the measured accrual (~29 records/10 min of sittings) a 30-day
window settles near 3 000. Bound the fan-out (batched or limited-concurrency
reads — follow whatever bounded-concurrency helper the repo already has
before inventing one); the EMFILE tail T26 recorded must become impossible by
construction. Unit row: a list over more records than the concurrency bound
completes with the bound respected (spy on simultaneous opens). Live gate:
one runtime switch on the operator profile with the 800-record store —
no EMFILE anywhere in the log. Commit subject:
`fix(sessions): listing pi process records bounds its file fan-out`.

### T33 — Q6-LIVE's claim-2 red tells the truth about what arrived

Two case debts recorded at T30's gate, owned by the case (T26's scope bound):
(1) the claim-2 failure message says "nothing naming that dispatch carried
&lt;token&gt; / never reached the parent" even when a child report WAS found and
the miss is the token — a reader trusting it would reopen T30; split the
message: report-never-arrived vs report-arrived-without-the-token. (2)
`scan-inventory` is a poor codeword carrier — its turn is spent explaining it
cannot scan (`rg` absent from its tool environment), so the token depends on
prose it may not emit; carry the codeword through an instruction the agent
can always follow regardless of its tools. Gate: a re-sit where claim 2 is
green end to end (17/17), or red with the NEW honest message naming what
actually arrived. Commit subject:
`fix(cdp): Q6-LIVE claim 2 names what arrived, and its codeword needs no tools`.

### W-pkg — the packaged wave, after T10

On a packaged build that boots fixture trees: CDX-148's packaged leg; MCP-W1..3
and SKL-P1 sittings (rebuild their fixture trees on the current layout first);
COMPACT-LIFE claude + the U1 live arm (unknown-model window clamp vs our env
pair) **under the granted window narrowing, restored after the run**; refresh
`docs/testing/cdp-live-checklist.md` rows and add the run file. No commit
subject — results land as docs.

**EXECUTED 2026-08-21. Four things this row assumed, corrected per §P.3 step 4.**
Narrative and verbatim tails in
`docs/testing/cdp-runs/2026-08-21-w-pkg-packaged-wave.md`.

1. **"Rebuild their fixture trees" is half the recipe.** A tree also needs its
   plugins installed through the app's own marketplace RPC **and its gateway
   connections created**, and the second half is not optional: without a
   connection the onboarding wizard covers the app, and MCP-W1's two DOM checks
   then read the wizard's text instead of the page they name — 9/11, both reds
   the wizard, on a build where the mint was perfect. The order also matters and
   is the archive's Q13 rule: the app opens an EMPTY config dir first and lays
   down its own v2 layout, and only then do the fixture files go in.
   `fixtures/mcp-naming.ts` merges into the app's `config.json`, so building the
   tree first leaves a file with no `activeWorkspaceId` — which post-T10 is a
   loud exit rather than the silent hang the close-out chased.
2. **SKL-P1's CASE PROCESS needs `NESSY_CONFIG_DIR`, not just the app.**
   `configDir()` reads the case's own environment and otherwise answers
   `~/.nessy-agent`; the first attempt reported `0 registry entries carry
   pluginId cdp-paths-probe` about a plugin that had installed cleanly.
3. **MCP-W2 cannot pass in its current shape, and that is not a mint
   regression.** It asks for the tool call in ONE turn; since deferred MCP became
   the default (T12/T15) a `tool_load` only lands "from the user's next message",
   which the Pi arm reports verbatim. Under the T16 two-turn shape — the same fix
   MCP-AUTH needed — Pi and the Claude runtime both dispatch the minted wire name
   on this build and the fixture server answers with fresh nonces. Recorded FAIL
   (case debt), the shape Q6-LIVE's row already uses.
4. **COMPACT-LIFE's cleanup check is now structurally unpassable**, so
   `NESSY_F5_SLUG_SUFFIX` is mandatory rather than a convenience.
   `deleteLlmConnection` gained a `N session(s) … still use "<slug>"` referential
   guard on 2026-08-17 (`764ee8662`), two days after the case's last green run,
   and the case never deletes the session it created on its own connection. On
   this profile it also fires a second time: six sessions from the 2026-08-13/15
   sittings still hold `claude-gateway-91`. The `config.json` restore is what
   removes the run-owned connections.

**What the row promised and got.** CDX-148 **PASS 8/8** packaged; MCP-W1 **PASS
11/11**; MCP-W3 **PASS 6/6**; SKL-P1 **PASS 12/12** (metadata half; the `paths`
activation half stays operator-run); MCP-W2 **FAIL 14/25** with the invariant
proven by control on all three runtimes; COMPACT-LIFE claude **12/13** with the
whole lifecycle green. **U1's owed live arm is answered and the answer is that
our env pair wins**: on CLI 2.1.223 an unrecognized `tgpt/…` model id still
reports our catalogue's 240 000 and auto-compaction fires at the threshold
derived from it (`preTokens` 208 836 against 207 000), so
`CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` is not needed.

**2026-09-11 — the CDX-148 leg above is a dated reading at `rust-v0.148.0`, and
the binary it was measured against is no longer the one we ship.** The pin moved
to `rust-v0.150.1` on 2026-09-11 (P7.2, `f042e5674`: app-server self-report
`0.150.1`, darwin-arm64 binary sha256
`99ed12a1db8f479388178bd308e3411ed9c6b38b0ce2fafaee5a9390f5f9a1e9`), and the live
case moved with it — RE-POINTED, never renamed: `scripts/cdp/cases/cdx-150.ts`
supersedes the 0.148-era case the way that one superseded the 0.147-era one
(`d014ab97d`). The case's own rule is the reason this note exists rather than an
edit to the numbers: **a foreign runtime's version bump invalidates every row
measured against the previous one** — it is a different program speaking the same
protocol, and the app-server protocol is exactly where our adapter lives. So the
8/8 stands as what was true on 2026-08-21 against that day's binary, and it is not
evidence about the runtime we ship; the re-measurement is the new case's to
produce. The lift also retired a setting this run's app wrote:
`approval_policy = "untrusted"` is fatal at 0.150.1 and can no longer be written
at all (`9375093b4`), so the codex configuration under which this leg ran is not
reproducible on the shipped binary either.

---
### T7 — Pi rebuild ✅ LANDED 2026-08-21

> ~~⛔ STOP — G2 must be answered before this task's first commit~~
> **G2 WAS ANSWERED 2026-08-21: do it.** The marker below is kept for the
> record of what the gate was. The gate is not
> paperwork: G2 is in substance the question *"do we do T7 at all"*, and its
> inputs are all in this row — T7 helps only a **first** switch into Pi, the
> return leg already works, it costs 3–5 days, and **U2 must land first** (about
> half of `pi-runtime-adapter.ts` is rewritten).
>
> Recommendation already prepared, so the answer is cheap when it is asked: the
> Pi row's structural proof survives T7 (`forkFrom` is one of the five sanctioned
> entry points, and we never touch the private constructor); only its
> *"never its shape"* clause breaks. So narrow the reason and **add** a DECISION
> row rather than flipping the class — the same shape recommended for G5, and the
> shape the register's only precedent (R11) used.

**Feasible and cheaper than it looks.** The pin is
`@earendil-works/pi-coding-agent` **0.80.3** (three `package.json` files;
`SUPPORTED_PI_RUNTIME_VERSION = '0.80.3'` compared with `!==` at
`pi-runtime-adapter.ts`), and its bundled `docs/session-format.md` documents the v3
tree format omnigent emits. Entry bodies get **no** schema validation (malformed
lines are silently skipped) — but the **header is validated**: `loadEntriesFromFile`
checks `entries[0].type === 'session' && typeof entries[0].id === 'string'` and
returns `[]` otherwise, which `forkFrom` reports as "empty or invalid". That is a
fail-loud arm worth keeping.

The entire downstream half already exists as the Pi **branch** path: it takes a
parent JSONL path, validates it, and calls `forkFrom(parent, cwd, sessionDir)`,
which rewrites the header cwd and writes a fresh `.pi-sessions` sidecar. So a
cross-runtime rebuild needs no new resume path — a translator, one init field, and
one branch in `ensureSession`.

**On duplicate suppression, stated honestly.** omnigent's
`pi_native_resume.py:22-29` says: *"Pi only fires `message_start` / `message_end` /
`tool_call` events for messages produced **inside a live agent loop** (after
`agent_start`) — NOT for entries loaded from a session file on `session_start`."*
On our side the `_emit` pair we located (`agent-session.js:1027-1028`) is inside the
live loop, and our own branch forks rely on the same property — but that is not a
proof that no load path emits. **When G2 opens, require a positive control**: a
synthesized session file whose loaded entries provably produce zero events.

**Why it is parked.** `docs/architecture/runtime-capability-gaps.md`, Pi section,
classifies "Session storage format is the SDK's" as **STRUCTURAL**: *"We choose
where the JSONL lives and which file to open, never its shape."* A rebuild makes us
a second writer of that shape. That is a reclassification STRUCTURAL → DECISION, the
row must be rewritten in the same commit, and the existing byte-identical test must
be located and re-scoped.

**Also note, because it changes the row's value:** the Pi *return* leg already works
— Pi re-finds its own pre-switch `.pi-sessions` through `RuntimeAnchorMap`. T7 only
helps a **first** switch into Pi.

After the gate: ~10 files, 350–450 LOC production + 250–350 LOC test, 3–5 focused
days, plus two existing contract tests that **must** be edited
(`pi-harness-baseline`'s ordered source markers and the init-field contract) — both
fail loudly, neither is discoverable from the diff alone.

---

**EXECUTED 2026-08-21. What this section got right, and the six things it got
wrong or did not anticipate.** Per §P.3, the corrections live here rather than
only in the Tracker note.

1. **Every 0.80.3-era claim above was re-verified against the CURRENT pin and
   all of them survived.** `SUPPORTED_PI_RUNTIME_VERSION` is `'0.84.0'` since U2
   — the section's "the pin is 0.80.3 (three `package.json` files)" is stale
   prose, not a stale mechanism. On the installed 0.84.0:
   `CURRENT_SESSION_VERSION = 3`; `loadEntriesFromFile` still validates exactly
   `entries[0].type === "session" && typeof entries[0].id === "string"` and
   returns `[]` otherwise, which `forkFrom` still reports as *"Cannot fork:
   source session file is empty or invalid"*; body lines are still skipped
   silently; `forkFrom` still copies every non-header entry verbatim under a new
   header carrying `parentSession`. The design is unchanged.
2. **The oracle the section did not have now exists, and it was used.** U2 made
   `sessionEntryToContextMessages` and `buildContextEntries` public exports, so
   the translator is checked by running upstream's OWN projection over the file
   we wrote (`packages/shared/src/agent/__tests__/pi-session-rebuild.test.ts`)
   instead of by restating the format. That is what proves the tool pair
   round-trips as `assistant(toolCall)` + `toolResult` keyed by one `toolCallId`.
3. **"A translator, one init field, and one branch in `ensureSession`" was
   nearly right — it needs one RETURN channel too.** Nothing in that list tells
   the host whether the fork actually happened, and without that the handoff
   would have to be marked applied on hope. `session_id_update` gained an
   optional `carriedHistory: true`, set only after `forkFrom` returned; until it
   arrives the handoff stays armed and the next turn delivers the same span as
   text. The subprocess also retries ONCE as a plain `continue` if the carry
   fork throws — a carry that cannot be taken has a complete fallback waiting,
   unlike a BRANCH fork, which keeps failing loudly.
4. **No anchor is written at rebuild time, and the section does not say which
   way to go.** Claude's rebuild anchors because the SDK resumes by id; Pi
   resumes by DIRECTORY and `forkFrom` mints the id of the session it will
   actually run, so the subprocess reports that id back through the ordinary
   `session_id_update` path and the normal anchor write records it. Writing one
   here would make the NEXT switch into Pi plan `anchor` against a session that
   never existed.
5. **"Two existing contract tests" was THREE, plus two more the section does not
   mention at all.** The two named (`pi-harness-baseline`'s ordered markers — in
   TWO separate marker blocks in that one file — and the init-field contract)
   plus `pi-runtime-h1-real-server.test.ts`, whose adapter-routing regex pins the
   literal `runtimeHandle = await runtimeAdapter.createSession` that item 3's
   retry turned into a closure. And two rows of
   `packages/server-core/src/sessions/runtime-switch.test.ts` fail on the map
   flip itself, because `pi` was their negative control — the surviving control
   is now `nestor-cloud-agent`. All five were updated with dated notes, none
   papered over.
6. **The modal's generic `carryNative` line is NOT honest for Pi, which the
   section and G2 both assume it is.** It ends *"Image attachments cross as file
   paths, which the model cannot open."* That clause is about the TARGET's Read
   tool and was written for Claude; Pi's own `read` tool returns
   `{type:"image"}` content for an image file
   (`pi-coding-agent/dist/core/tools/read.js`), so on a switch into Pi the
   sentence understates what the target can do. `chat.runtimeSwitch.carryNativePi`
   was added to both locales and routed the way `carryNativeCodex` is.

**The positive control the section demanded was run and it passed**
(`packages/pi-agent-server/src/compat/pi-carry-session.test.ts`): a real
`AgentSession`, forked from a synthesized carry file through the production
adapter, loads five carried messages and emits **zero**
`message_start`/`message_end`/`tool_call` events — and the same listener DOES
see `message_start` + `message_end` when `sendCustomMessage` provokes them with
no model and no network, so the empty list is a property of loading rather than
of the wiring.

**Where the file lives, and why not in `.pi-sessions`.** `<session
dir>/.pi-carry/handoff.jsonl`, a FIXED name. `continueRecent` scans
`.pi-sessions` and `findMostRecentSessionFile` takes the newest `.jsonl` in it,
so a synthesized file dropped there would become the session Pi resumes and
appends to — making us the writer of a live Pi session for its whole life
instead of the author of one file read once. The fixed name is what saves a
persisted field: `PiAgent` re-derives the path from the workspace and session
ids, so the arm survives a quit between the switch and the first turn.

**Live gate.** RTS-15 (new) PASS 11/11 and RTS-14 (regression) PASS 35/35 —
`docs/testing/cdp-runs/2026-08-21-t7-pi-carry.md`. **RTS-14's `EXPECTED_TIER`
map needed no edit**: its circuit starts on Pi, so every later entry into Pi is
a RETURN and is answered `anchor` by the tier above the capability map. That is
exactly why RTS-15 had to exist — the first-entry-into-Pi shape is the one the
six-pair matrix structurally cannot cover.

---

### R1 — what the user sees, and what a crash leaves behind

Three things no other row covers, each small, each the kind of gap a reviewer of
the finished work finds:

1. **Crash mid-switch.** The teardown is irreversible and T2 deliberately leaves
   `runtimeHandoffFrom` armed across the write. Define what the next start sees
   (armed handoff + a possibly half-written transcript + possibly a set anchor) and
   assert the invariant: **the next start either completes the rebuild or falls back
   to the armed text handoff — never both.** One test.

   **CORRECTED at execution — the three dials above are not independent, and the
   window the row worries about persists nothing.** Measured on this tree:
   `switchSessionRuntime` has exactly ONE persistence point (`persistSession` +
   `flushSession`, immediately before it builds its result), and it sits after the
   arm, after the rebuild and after the notice. A process that dies anywhere inside
   the switch therefore leaves the on-disk record entirely pre-switch: nothing
   armed, no anchor, still on the source connection — the invariant holds
   vacuously and the only residue is an orphan transcript, which is exactly what
   T8's `vendor-transcript` class sweeps. The states a next start CAN see are the
   post-persist ones, and they vary along **two** dials, not three: *is the anchor
   set* and *is a loadable transcript at the path the spawn resolves to*. Those
   give four shapes — write never happened; died between `writeFileSync` and
   `renameSync`; died after the write, before the disarm; anchor outlived its file
   — and all four are driven, each ending in exactly one delivery.

   **CORRECTED — "assert the real path never holds a partial file" has an obvious
   test and it cannot fail.** Occupying the destination with a directory makes the
   rename fail, and the natural assertions (throws, nothing loadable at the real
   path, no `.tmp` left behind) *all pass with the tmp+rename pair replaced by a
   plain `writeFileSync`* — measured, by making that replacement. Atomicity is not
   observable single-threaded, so the test asserts the one behaviour that
   separates the two implementations: `rename(2)` needs write permission on the
   DIRECTORY and `open(2)` needs it on the FILE, so a read-only destination is
   replaced by a rename-based writer and refused with `EACCES` by a direct one.
2. **The renderer names what crossed.** P2 widens `contextCarried`; nothing renders
   it. A native carry, a text fallback and a runtime-anchor resume look identical to
   the user today. Render it in the post-switch notice.

   **LANDED as a JSON tail on the marker, per D3**:
   `runtime_switched:<from>:<to>:{"carry":"native"}`, with three new copy keys
   (`noticeNative` / `noticeAnchor` / `noticeText`) and the pre-R1 key kept as the
   no-tail arm, so every switch notice already in a transcript renders exactly the
   sentence it rendered before. The parser splits by POSITION rather than
   `split(':')`, because the tail is JSON and D3's own growth path for it (the
   model delta) carries ids that may contain `:`.

   **One correction the row does not anticipate: the notice is written at switch
   time, so it can only record the PLAN — and the plan is not always what
   delivers.** The Claude leg's outcome IS known synchronously
   (`rebuildClaudeTranscriptForSwitch` now reports whether it landed), so a
   `native` plan whose rebuild failed writes `text`, which is what the armed
   handoff will actually deliver. Codex's is not: `thread/inject_items` runs on
   the first turn after the switch and can still fall back to text there, which
   the notice cannot see. That residual is stated in the code and in the Tracker
   note rather than hidden behind a promise.
3. **Provenance of a rebuilt history.** `Message.runtime` is persisted and typed but
   read **nowhere** in the renderer. A rebuilt transcript is indistinguishable later
   from a natively produced one, in our store and in the vendor's. Decide whether
   that matters and record the decision.

   **CLOSED AS DECIDED (D10) — and T2 had already left the record.** The stamp
   site (`claude-transcript-rebuild.ts`, `ClaudeTranscriptRecord.runtime`) carries
   the decision, the reason and both limits. R1 adds one sentence there naming
   this row as closed on that comment, so a reader arriving from the plan lands on
   the answer instead of re-opening it. No code.

## P.5 Owner gates

| Gate | Blocks | Question |
| --- | --- | --- |
| ~~G1~~ | — | **ANSWERED 2026-08-20: «да + тост».** Carry the model when the target's catalog contains it, **and** surface the change when it is reset anyway. Both halves are mandatory in T3 — the toast is what keeps a quieter switch from becoming an opaque one. This narrows the intent at `SessionManager.ts:15684-15685` from "a model id from the previous integration is meaningless here" to "meaningless *when the target cannot serve it*"; rewrite that comment in T3's commit. `runtime-switch-session.test.ts:343` stays verbatim — it is the negative control. |
| ~~G2~~ | — | **ANSWERED 2026-08-21 by the owner: DO T7.** The matrix's last hole — a session STARTED on Claude/Codex and switched to Pi receives only the 24×1200 text tail with no tool traffic (returns already work through the anchor; RTS-14 proved them live). U2's prerequisite rewrite has landed, `forkFrom` is a sanctioned entry point, and the register edit follows the G5 shape exactly: the Pi row's reason NARROWS (only its "never its shape" clause breaks) and a separate DECISION row is ADDED — "we author a v3 session file to seed a first switch into Pi" — in T7's own commit. T7 unparked ⏸→⬜. |
| G3 | T2 | **RESOLVED 2026-08-20 by measurement — and the earlier recommendation of (B) was WRONG.** Reading `sdk.mjs`, not just `sdk.d.ts`, reverses both premises. (i) `sessionStore` is a **dual-write mirror**, not a resume source — but when `resume` is also set the SDK takes a different path entirely: the parent calls `load()`, materializes a **temporary** `$TMPDIR/claude-resume-<uuid>/projects/<projectKey>/<sid>.jsonl`, repoints the child's `CLAUDE_CONFIG_DIR` at it, and registers `rm -rf` on query close. So a store-backed resume makes us the **sole durable store** for that session's whole life. (ii) Retention is **inverted**: the type says "Retention is the adapter's responsibility", while local-disk transcripts are swept by the CLI's own `cleanupPeriodDays` (default 30). (A) inherits sweeping free; (B) acquires retention. (iii) The path derivation (B) was supposed to delete is **~12 LOC**, and `InMemorySessionStore` needs it anyway — `load` is called with `projectKey` and `keyToString` is private. (iv) (A) **is the supported path's own last step**: the SDK's materializer writes exactly one file, mode 0600, one `JSON.stringify` per line, then resumes from it. **Decision: (A)**, plus **(D)** below. |
| G3-D | T2 | **Take this with (A) — it is the cheapest risk reduction in the plan.** Attach a mirror-only `sessionStore` with **no** `resume` (so no temp-dir redirect fires) purely as a TEST harness: it captures the SDK's own `projectKey` and its exact entry stream for a real session. T2's golden fixtures then stop being "what we believe the format is" and become "what the SDK's own mirror emitted", and the `projectKey` assertion becomes exact instead of a re-derivation we hope matches. The store need not ship. **~0.5 day.** |
| G3-C | T2 | Reasonable alternative to (A) if the owner prefers not to own the key derivation at all: a **write-through** store whose `append(key, entries)` writes the same JSONL lines to the REAL `<CLAUDE_CONFIG_DIR>/projects/<key.projectKey>/<key.sessionId>.jsonl` and whose `load(key)` serves the rebuilt entries on the first call. The SDK hands us `projectKey`, so no derivation is ours, and local disk stays canonical so retention stays the CLI's. Costs the `@alpha` seam plus an append-only writer whose failure must stop being a silent `mirror_error` (our adapter routes that to debug today). Roughly the same total as (A). |
| ~~G6~~ | — | **ANSWERED 2026-08-20: option A — keep accept/decline.** The modal stays two-button; P3 adds the one thing it is missing, a line saying **what will cross** (full history / text summary). No "start clean" and no "text only" choice for now. The owner's framing: *"оставляем пока так, но если что подумаем уже в самом конце плана"* — so this is revisited at close-out, not re-opened mid-flight. Recorded consequences of the choice: a cross-runtime switch keeps deciding for the user, and after T1b/T2 that means the full tool-bearing history is injected on a metered gateway with no way to decline. Two facts that make A cheaper than it looked: there is **no pre-switch server round trip at all** today (the modal is computed entirely in the renderer; `sessions:command {type:'switchRuntime'}` is the whole wire surface and it is sent only after "yes"), so B/C would have to invent that transport — and iOS uses a two-button `SwiftUI.Alert` that **structurally cannot host a third choice**, so B/C are a mobile change too, not just a desktop one. |
| ~~G4~~ | — | **ANSWERED 2026-08-20: reasoning is NOT carried.** Owner: *"да, цепочку пока не переносим."* T2 and T1b are scoped without it; nothing on the persistence side is opened by this plan. Recorded in T2's out-of-scope list. **RE-ASK PUT ON A CORRECTED FOOTING 2026-09-06 (P6.94) — the answer stands, its stated premise does not.** The out-of-scope entry this row points at rested on *"nothing in Nessy has ever persisted thinking content (0 rows in 5 332) and `StoredMessage` has no field for it"*, and the schema half is false at HEAD: P4.4 (`a6d56aabc`) added `isThinking?: boolean` to `StoredMessage` (`packages/core/src/types/message.ts:465`). The owner's decision is untouched — reasoning is still not carried — but if it is ever re-asked, it must be re-asked as *"the field exists and the corpus may still be empty"* and not as *"this is impossible on this data"*, which is the sentence a reader would otherwise carry into the question. The corpus half is P6.91's measurement. |
| ~~G5~~ | — | **ANSWERED 2026-08-20 by the owner: narrow the reason and ADD a DECISION row — do not flip the class.** Two edits, both landing in **T1a's commit**, in `docs/architecture/runtime-capability-gaps.md`. (1) `:109` STAYS **STRUCTURAL**, with its reason narrowed from "There is no other channel into a turn" to the accurate one: there is no other channel that is RIGHT for volatile per-turn context — the only proven alternative, `thread/inject_items`, writes PERMANENT rollout records, and folding those blocks into the cached system prefix is refused by `prompt-builder.ts:211-215` because it re-stamps the cache prefix every turn and kills prompt-cache reuse for all downstream history. The GAP is untouched and stays true after T1a: `codex-agent.ts:1213-1218` still concatenates every context block into one `effectiveMessage` sent as `input[0].text` (:1272), and `codex-context-parts.test.ts` still pins it. (2) A NEW Codex row, **DECISION**: "a runtime handoff crosses as native model-visible history", with the live probe as its evidence — on the shipped `rust-v0.148.0` binary, `initialize` (experimentalApi) → `thread/start` → `thread/inject_items` carrying a user message, an assistant message and a PAIRED `function_call` + `function_call_output` → `{}`, no network and no turn; positive control `no/such_method` → -32600. Precedent followed: no STRUCTURAL row in this register has ever been reclassified, and R11 (`30214a9b6`) met a refuted premise by ADDING a row rather than editing a neighbour. **Note the argument that did NOT survive**: an earlier framing of this gate also cited `turn/start.additionalContext` as a second channel; that is refuted (§U4) — the field does not exist on `TurnStartParams` at either tag, and the probe that "proved" it cannot fail, because the app-server silently accepts unknown fields. Side finding left for the owner, independent of this plan: rows `:108` and `:109` contradict each other — Codex's `instructions` / `developer_instructions` / `model_instructions_file` all exist in the pinned schema and we write NONE of them, which `:108` already calls DECISION. **BOTH EDITS LANDED in T1a's commit**, with one path correction: the `prompt-builder.ts:211-215` citation is `packages/shared/src/agent/core/prompt-builder.ts` (the `core/` segment was missing) — the quoted sentence holds there verbatim. Row `:108` untouched, as directed. |

## P.6 Close-out

**ANSWERED 2026-08-21 — the modal stays as it is, G6 is closed for good.** The
observed inputs were on the table: the `text` tier effectively never fires on
real sessions (0 of 677 overflow even a 200 000 window), the modal now names
what will cross before the user agrees (P3), and the post-switch notice names
what actually crossed (R1). "Start clean" would need a new pre-switch transport
AND an iOS surface that is not a two-button alert — declined on that cost
against no observed demand. Recorded here; do not re-open without new evidence.

**The original review item, kept for the record — owner-requested 2026-08-20.**
Re-open exactly one question, now that the cost of a switch is visible in the
product rather than estimated: **is it worth changing the switch modal at all?**
By close-out, P3 has landed the "what will cross" line, and T1a/T1b/T2 have made a
cross-runtime switch actually carry the tool-bearing history — so the question can
be answered on observed behaviour instead of on a guess. The three inputs to have
in hand: how often the `text` tier fires in practice (P3 logs it), whether anyone
asked to decline a carry, and whether the injected history showed up as a cost
anybody noticed. If the answer is "no change", record that and close G6 for good;
if it is "add start-clean", note that it needs a new pre-switch transport **and**
an iOS surface that is not a two-button alert.

**Owner mandate 2026-08-20, added mid-flight — the close-out owns two more things:**

- **Replenish the CDP cases for what this plan changed, and RUN them** on the
  packaged build at the wave boundary: `cdx-148` (re-pointed by U4, run owed),
  `rts-13` (T1a's new case), plus cases for T3's model carry (carry vs reset +
  toast), P3's modal promise line, and T2's rebuild (the fact-beyond-the-text-cap
  probe). New features after this plan keep adding rows the same way.
  **2026-09-11:** the case named here was U4's re-point; the pin moved again to
  `rust-v0.150.1` and the case was re-pointed a second time, to `cdx-150` (P7.2,
  `d014ab97d`), so the run this mandate still owes is that case's, on the binary
  we now ship.
- **Restructure `docs/testing/cdp-live-checklist.md` into ONE unified case×runs
  table** — the file is 3 351 lines of run narratives today and the owner wants
  the index to BE the table: one row per case, one column-set per run (date,
  build, verdict, evidence pointer), replenished with every feature. Move the
  run narratives to `docs/testing/cdp-runs/<date>-<tag>.md` (they are the
  evidence the table points at — do not delete them), and update
  `docs/README.md` if it names the checklist's shape. The standing rule now
  lives in AGENTS.md close-out step 4: every plan's close-out adds its rows and
  records its runs.

One close-out per plan, ~0.5 day, per AGENTS.md:

1. Bump the version in **both** `package.json` and `apps/electron/package.json` in
   lockstep (currently 1.30.1).
2. Add a **new** `apps/electron/resources/release-notes/<version>.md` — never edit
   an existing one.
3. Update the affected `docs-site/` pages.
4. Regenerate both generated documents:
   `python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md`
   and
   `python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md`.
   **The register harvests only strings of the form `documented, (not implemented |
   impossible on … | inapplicable) — <reason>`** — the category strings written into
   P1, T1a and T2 above are what make this plan's exclusions reach it. A plan with
   none records nothing.
5. Before the merge gate, compare against **`master`**, not against this branch's
   base — a per-base check cannot see an accumulation.

## Tracker

Updated **in the same commit that lands the task**. Statuses: `⬜` not started ·
`🔄` in flight · `✅` landed · `⏸` parked.

**Every row is subject to §P.3's verify → correct → execute rule.** Do not start a
row without re-reading its anchors in the current tree and its mechanism at the
source; correct the row in the same commit and record *what* was corrected and
*why* in its Note. Three of this plan's premises were already falsified that way —
the cost of skipping it is written into §P.3.

| Task | Lane | Status | Commit | Note |
| --- | --- | --- | --- | --- |
| P1 raw tool input/result alongside the display projections | serial | ✅ | `5696204d3` | Landed 2026-08-20. All four anchors held exactly (`:21284/:21327/:21441/:21465`) and both formatter signatures confirmed at `packages/shared/src/utils/files.ts:881/:902` (optional `cwd`, defaulting to `process.cwd()` — D4's premise verified, not assumed). Session cwd = `managed.workingDirectory ?? managed.workspace.rootPath`, the file's own established idiom (15 existing uses, including the cwd handed to the agent config), so stored paths now relativize against the directory the runtime actually executes tools in. Raw pair persisted at all four sites; the raw result goes through the same `capPersistedResult` 200 000-char cap as the display copy (deviation category string as written in the row); the mappers spread, so both fields round-trip with no mapper change. **Row wording corrected**: there are only TWO formatter *invocations* — passing the cwd there satisfies all four assignment sites, which the row's own table already hinted at. New `raw-tool-io-persistence.test.ts` drives the shipped `processEvent` on the SDK dual-event shape (input from the SECOND event, result via the update path) plus the orphan-create and cap boundary. **Integrator note**: agent worktrees symlink the main checkout's `node_modules`, so workspace-internal packages resolve to the MAIN tree there and in-worktree typechecks report phantom errors — package typechecks and `bun test packages/server-core` are integrator-run after the cherry-pick. |
| P2 one handoff-delivery seam + `contextCarried` widened once | serial | ✅ | `da2a33a7c` | Landed 2026-08-20. Seam is the per-turn query `shouldSuppressTextHandoff()` (A6) plus a per-turn stash `pendingRuntimeHandoff: { from, messages } \| null` on `BaseAgent`, assigned on EVERY `chat()` turn (payload when suppressed, `null` otherwise), so T1a/T2 always read this turn's obligation and never a stale one. A suppressed turn neither builds the text context nor marks applied — the payload stays armed so a native delivery that does not take falls back to text on the next turn. Union widened with `native-inject`/`native-transcript`; the eight existing assertions verified at their exact recorded lines (`:267, :275, :290, :312, :328, :445, :457, :491` — no drift) and untouched. **SessionManager needed no edit**, contrary to the row's Files list: its only union contact is `RuntimeSwitchResult['contextCarried']`-typed at `:15629`, so the widening flows through. **Corrected in the row text**: the closing note still named the pre-A6 class flag `handlesRuntimeHandoffNatively` — there is no such flag; T2 and T1a override the query instead. Gates: `tsc --noEmit` exit 0 in `packages/shared` and `packages/server-core`, `lint:shared` clean. **Integration finding (2026-08-20): the three seam tests' first real execution threw before reaching their subject** — `chat()` refuses to run without a pinned capability view (`capability-turn-runtime-required` at `base-agent.ts:3045`), which a typecheck cannot catch and the no-`bun test` executor constraint deferred. Fixed in this commit: the harness installs the same empty `CapabilityTurnRuntime` fixture `base-agent.test.ts` uses, and the byte-identity assertion became a strict TAIL assertion (the composed message leads with the capability block on every turn; the invariant is the handoff block + blank line + user message at the end, and exactly one handoff element). Suite now 9 pass / 0 fail. |
| P3 carry plan decided before the switch, promised in the modal | serial | ✅ | `242a58380` | Landed 2026-08-20. `planHistoryCarry` returns FOUR outcomes (`native` / `anchor` / `text` / `text`-on-unknown), decided in the order anchor → capability → window → fit. **The two open choices in the row were closed as directed.** A4 → **(a)**: a read-only `previewRuntimeSwitch` session command runs the same `ensureMessagesLoaded` + planner the switch runs and then stops — no boundary, no drain, no mutation, and deliberately no T4 hostability check, because a preview must not refuse. A5 → **the capability check**: `NATIVE_HISTORY_CARRY_IMPLEMENTED` is a per-`AgentProvider` constant, `false` for all four, read through `supportsNativeHistoryCarry()`; **that map is the one line T1a (`codex-runtime`) and T2 (`anthropic`, covering both Claude cards via D8) flip**, and its doc comment names them. **Four corrections, all recorded in the row above.** (1) All three A1 anchors moved ~10 lines under T4 (`:15543/:15552/:15569`), and A1's gate row **cannot fail today** — with the capability map false everywhere both orderings yield `text` — so the seam is asserted twice: behaviourally through `previewRuntimeSwitch` on a `messagesLoaded: false` session, and structurally as an ORDER over `switchSessionRuntime`'s own source, bounded to that method with positive controls on all three anchors. (2) A2's "compute it the way T3 computes it" cannot mean *compute T3's future answer* — the session lands on `target.defaultModel` until T3 lands — so the guarantee is structural instead: one hoisted `const targetModel` that the planner reads and that **T3 changes in one place**, with the `managed.model` assignment noted to point at it. (3) The A3 fixture upgrade landed (object-shaped `models` with `contextWindow`; ids unchanged so T3's negative control, now at `:439` and not `:343`, keeps its disjoint catalogs) but is **not sufficient** — A5 makes the `native` arm unreachable from the product on purpose, so it is reached in the unit suite through one named, doc-commented `nativeCarrySupportedOverride` seam that production never passes. (4) The Files list was short by six: a wire change is never one file (`dto.ts`, the RPC case, **`ISessionManager`**, the hand-written `sessionCommand` result union in `apps/electron/src/shared/types.ts`, and the four renderer files the prop passes through). Estimation is the repo's own `estimateTokensDensityAware` run ONCE over the whole payload (its density correction has a 20 000-char floor, and the worst corpus case is 528 KB across 25 rows), plus exported `SESSION_RESTING_CONTEXT_TOKENS = 46_000` and `HISTORY_CARRY_TOKEN_MARGIN = 1.25`, both asserted against the measured p99/max. `contextCarried` is now derived FROM the plan rather than re-derived, so promise and report cannot drift, and the switch log carries `carry=<plan>/<reason>` for P.6's G6 review. The clamps-not-resets correction to `crossRuntimeBody` rides here (both i18n lints are blind to a changed value); its "handed over as text" clause is removed, because that is now the `text` tier's own line. Gates: `bun test packages/server-core` **1763 pass / 0 fail** (1746 + the 17 rows added here), `typecheck:all` exit 0, `lint` exit 0, both i18n lints green, renderer input suite 163 pass / 0 fail. **A worktree note worth keeping**: `apps/electron`'s typecheck compiles the MAIN checkout's `server-core` against the worktree's `shared` (no `node_modules` in a worktree), which reported a phantom exhaustiveness error; shadowing `<worktree>/node_modules/@nessy-agent/*` with links to the worktree's own packages makes it honest, and it then exits 0. |
| T1a Codex handoff via `thread/inject_items` | A | ✅ | `2a92b34dd` | Landed 2026-08-20 on the merged tree (P2+P3+U4+G5). **Five of the row's premises were wrong and are corrected in §P.4 above** — the biggest: **P3's plan did not reach the agent at all** (`historyCarry` was computed, logged, and dropped), so T1a built the channel: `runtimeHandoffPlan` on the managed session, armed/cleared/persisted with `runtimeHandoffFrom`, travelling to the backend inside the handoff payload, read by a `shouldSuppressTextHandoff(handoff)` widened from zero-arg (additive — P2's own override still compiles). Also: there is no `handlesRuntimeHandoffNatively` flag; the copy widening is a FOURTH parameter (P3 spent the third); and **`contextCarried: 'native-inject'` is structurally unreportable on `RuntimeSwitchResult`**, which returns before any turn runs while Codex's carry needs a live thread — so `markRuntimeHandoffApplied` now takes a `RuntimeHandoffDelivery` and the session log records `context=native-inject`. **Known limit 2 forced an extraction**: the trim lived in a closure and its only test *restated the closure's body*, so no edit to the shipped trim could have failed it — hence `buildRuntimeHandoffPayload` (`runtime-handoff.ts`), now called by both tests, with the four-leg pi→codex→pi→codex row and an RTS-3 positive control. **Two new keys, not one**: the shared `carryNative` promises "tool calls and their results included", false of T1a, so Codex gets `carryNativeCodex` beside `crossRuntimeBodyCodex`; `chat.runtimeSwitch.notice`'s "handed over as text" also became false and was reworded. **Primary gate, run locally**: `NESSY_CODEX_E2E=1 bun test packages/shared/src/agent/__tests__/codex-inject-items-e2e.test.ts` → **3 pass / 0 fail / 20 expect()**, driving the bundled rust-v0.148.0 binary against a loopback Responses provider — both injected items appear in the captured request body, in order, roles preserved (`input_text`/`output_text`), **before** the new user message and outside it. Known limit 3 came back as a PAIR: inject→fork→turn yields each item exactly once **and one `turn_aborted`** (the positive control AGENTS.md requires), while the product's fork→inject→turn yields both items and **zero**. New measured fact: **`thread/fork` on a thread with no turns answers `no rollout found for thread id …`**, so fork and inject can only meet on a thread with history. **Three `runtime-handoff-context.test.ts` rows were RED on the merge base** (P2 recorded them as integrator-run; they were not) — reproduced at HEAD in a scratch worktree, then fixed here since T1a is the seam's first consumer: `chat()` throws `capability-turn-runtime-required` without a pinned turn view, and its byte-equal message assertions described a send that cannot happen (the pinned block always leads). `createMockCapabilityTurnRuntime` added to `test-utils.ts` so the next test does not repeat it. Two planner rows also had to change, because the flip made the `native` arm reachable for the first time: `plan({rows: []})` on a codex target now answers `native`, which is exactly A1's claim — so `previewRuntimeSwitch`'s cold-load row was rewritten with a transcript no window can hold, and **now fails if the load moves after the plan**, which it could not before. Gates: `typecheck:all` exit 0; `bun test packages/server-core` **1770 pass / 0 fail** (1763 + 7); `bun test packages/shared` **8649 pass / 0 fail / 23 skip / 1 todo**; renderer input suite 169 pass / 0 fail; `lint` exit 0 (4 pre-existing warnings, none in touched files); both i18n lints green; `tsc -p scripts/cdp` exit 0; `git diff --check` clean. **Owed at the wave boundary**: the packaged `rts-13` run, with the pre-T1a negative control the case header specifies. |
| T1b Codex carries tool calls and results | A | ✅ | `ad46c462f` | Landed 2026-08-21. **Five of the row's six anchors were stale and are corrected in §P.4 above — T1a reshaped this area the day before.** The largest: there is no `getRuntimeHandoffRows()` to write, because T1a's extraction already hands `runtime-handoff.ts` the WHOLE transcript (`rows: managed.messages`), so the row projection is a second exported function beside the message one — which answers A7's either/or by an extraction that already happened and keeps T1b off the serial lane (`SessionManager.ts` takes **one** added argument, the `log` sink, inside T1a's own closure). Also: `backend/types.ts:578` is `:605` and was the wrong field anyway (`RuntimeHandoffPayload` at `:73` is what widened, with `history?: RuntimeHandoffHistoryItem[]`); `base-agent.ts`'s stash needed no edit at all, being typed by the payload; and **T1a's report that the offline e2e already asserts a paired round-trip is false** — its `flatten()` reads `content[].text` and a `function_call` item has no `content` array, so it structurally could not have, and a fourth test that reads the raw items was added. **The copy correction is a ROUTING change and T1a's note about it was wrong in both halves**: the carry line must STAY Codex-specific (the shared `carryNative` promises image attachments cross as file paths per D6, and Codex's inject crosses no attachment at all), while the BODY's *"receives what was said, not what was done"* went false on exactly ONE tier — so the body is now chosen on the tier, `native` into Codex taking the shared `crossRuntimeBody` (true of it word for word) and `text`/`anchor` keeping the Codex body unchanged. Two guard decisions recorded rather than absorbed: guard 1 closes ANY resultless tool row, not only `executing`/`pending`, because a status is a claim and the missing result is the fact the provider rejects (an empty-string result is a real result and has its own row); guard 3 is applied to user rows too, since "never emit an empty content block" is role-independent. The `text`/`anchor` tiers are asserted BYTE-IDENTICAL to T1a's payload object, field for field — `history` is attached only on `native`, and `messages` is still built there because it is the in-turn fallback. **Gates:** `bun test packages/server-core` **1793 pass / 0 fail** (+13); `bun test packages/shared` **8655 pass / 0 fail / 24 skip / 1 todo** (+3 tests, +1 gated skip — note the row's stated 8674 baseline does not reproduce on this tree, which measures 8652 before the change); **`NESSY_CODEX_E2E=1 bun test .../codex-inject-items-e2e.test.ts` → 4 pass / 0 fail / 33 expect()** on the bundled rust-v0.148.0 binary, the new row asserting the pair adjacent, in order, `call_id`-joined, ahead of the user message, with the tool fact present in the raw items and absent from every prose item; `typecheck:all` exit 0; `lint` exit 0 (123 pre-existing warnings, none in touched files); both i18n lints green; renderer input suite 166 pass / 0 fail; `git diff --check` clean. **Owed at the wave boundary: the LIVE half** — a packaged build switching a real Pi session with real tool traffic onto `codex-gateway` against the real gateway, and asking for a fact that exists only in a tool result. It is the one leg the four committed tests cannot cover. |
| T2 Claude transcript rebuild | serial | ✅ | `8424c635a` | Landed 2026-08-21. **Six of the row's premises were wrong and all six are corrected in §P.4 above.** The largest is the FAIL-SAFE's detector: "the first turn shows the rebuilt history took" invites a `session_id` comparison, and measurement against the shipped 0.3.223 binary shows a resume whose transcript **does not exist reports back that same id** — so the obvious detector passes on exactly the failure it exists to catch. It was caught by its own negative control and replaced with the thing that actually differs: `system`/`init` is emitted when the file loads and **never** when it does not (`result.subtype` is then `error_during_execution`), so the arm confirms on init-carrying-the-anchor and nothing else. Next largest: the row's "input `StoredMessage[]`" and its "reuse `buildRuntimeHandoffHistory`" cannot both hold — the projection lives in `server-core` and `shared` cannot import it — so the converter takes `RuntimeHandoffHistoryItem[]` and `SessionManager` calls the ONE projection first, with two additive optional fields (`timestamp`, `runtime`) and one `attachmentBlock` hook riding it; a caller that passes none gets output byte-identical to T1b's, so Codex is untouched. Also: the `sessionId` handed to the cwd resolver is the NESSY id, not the SDK one (the third candidate is `getSessionDirPath`, and the first draft got this wrong — it derives the wrong project key **in silence**); U1 remangled every minified helper the plan names and **`us` is now a different function entirely**, so the module quotes each by BODY; the Files list was short by six; and `version` is `claudeCodeVersion` = **2.1.223**, not the `2.1.218` on the records already on disk. The tilde candidate is **rejected**, not expanded — expanding would move the spawn cwd of 618 of 676 sessions — and the two-agree check is behavioural over a candidate table PLUS a source assertion that `resolveSpawnCwd` holds the delegation and no candidate list, because a behavioural comparison alone cannot see a copy that happens to agree. **G3-D was taken and overshot the gate**: the mirror-only `sessionStore` captured the SDK's own `projectKey` (equal to ours), and the same loopback rig then proved the whole task OFFLINE — a transcript this repo authored is resumed by the shipped native binary and its paired `tool_use`/`tool_result`, a fact existing only in a tool result, and the intermediate assistant row all arrive in the model's request body ahead of the new user message. The `projectKey` claim additionally rests on **166 of 166** real project directories, a fixture harvested from the SDK's own transcripts, rather than on one capture. `message.model` **ships ON** (the session's real model id): our own runtime already writes `tgpt/…` gateway ids into 678 assistant records and resumes off them; both arms are implemented and table-driven, and the live day owns the final call. **One narrowing to know about and it is P3's, not T2's**: `planHistoryCarry`'s `claude-*` arm still answers `text`, so a switch onto Claude Pro/Max or a BYO `claude-sonnet-…` key does not rebuild — pinned with a positive control so it is not read as a defect here, and owed the same live run. **Gates:** `bun test packages/shared` **8698 pass / 0 fail / 29 skip / 1 todo** (baseline 8655/0/24/1; +43 pass and +5 skip are exactly the three new files, measured alone); `bun test packages/server-core` **1801 pass / 0 fail** (baseline 1793, +8); `NESSY_CLAUDE_SDK_E2E=1 bun test .../claude-transcript-resume-e2e.test.ts` → **4 pass / 0 fail / 23 expect()** on the shipped binary against a loopback Anthropic-Messages provider; `typecheck:all` exit 0; `lint` exit 0 (4 pre-existing warnings, count identical on the merge base, none in touched files); `git diff --check` clean; i18n lints not run — no locale moved. Mutation probes run rather than assumed: disabling the trigger reddens 2 wiring rows, disabling the D7 guard reddens 3, disabling the transcript-presence gate reddens 3 arm rows. **Owed at the wave boundary:** the packaged build + live gateway day, which also answers PRV-N25/D8, the `message.model` arm, and whether the `claude-*` window arm can be opened. |
| T3 carry the model when the target can serve it, **and toast when it resets** | serial | ✅ | `0ae46d400` | Landed 2026-08-20. The carry is one exported pure helper, `resolveCarriedModel` in `sessions/runtime-switch.ts`, feeding P3's hoisted `targetModel`; the assignment reads that same const, so the window the plan sized and the model the session lands on are one value. **All three resolver claims re-verified against `factory.ts`'s real body and all three held**: the catalogue filter is inside `if (connection?.models?.length)` (`:759`), the pi-only `connectionModelIds[0]` substitution is at `:778-780`, and the `default:` arm's `DEFAULT_MODEL` (`:798`) is `getModelByShortName('Opus')`. One refinement worth recording: `claude-runtime` is NOT an `AgentProvider` (`ModelProvider` is the four-member union), so its early return at `:788-790` answers `''` and a Claude-gateway target can never reach the Opus arm — guard 3 is `codex-runtime` and plain `anthropic` only, exactly as the row said. **Four corrections, each written into the row above.** (1) **Guard 1 returns `target.defaultModel`, not literal `undefined`** — the row's shorthand would have dropped the declared default of every catalogue-less connection (a BYO key before its first fetch), a NEW regression contradicting A10's own rule; `target.defaultModel` is `undefined` precisely when none is declared, and both arms now have a row. (2) **There are TWO copies of the hoisted const** — P3 left one in `previewRuntimeSwitch` (`:15550`) whose own comment says "T3 changes both together"; leaving it would have had the preview size its window against the target's default while the switch carried the user's model, i.e. the promise/act drift P3 exists to prevent. (3) The negative control has drifted twice (`:343` → P3's `:439` → **`:470`** after T4) and is now cited by test NAME, with a comment on the row itself so the next reader needs no plan lookup. (4) Guard 2's "preserve today's outcome" acquired the reason it lacked: `resolveBackendContext` runs the same resolver at agent construction (`factory.ts:426`), so the substitution was ALREADY the model that RAN — letting it stand makes the record agree with the runtime rather than changing it. **Positive control run, per AGENTS.md** — the guards were stripped to the bare resolver and exactly the three guard rows went red (`64 pass / 3 fail`) while both carry rows stayed green, so none of the three passes by accident and the carry does not pass because of a guard. 10 new rows: the overlapping pair (real `NESSY_GATEWAY_MODEL_IDS`), the three guards plus guard 1's second arm and guard 3's positive control, the byte-identical-connection assertion (inert-worklist §3.2 — `managed.model` is persisted, the catalogue never is), and three `previousModel` rows. `previousModel` is reported whenever there WAS one, not only when it changed; `ChatPage` owns the comparison and raises `chat.runtimeSwitch.modelReset` (1 key × 2 locales) naming both ends, requiring both because the copy has two slots. Gates: the two switch suites **72 pass / 0 fail**, `bun test packages/server-core` **1773 pass / 0 fail** (1763 + these 10), `typecheck:all` exit 0, both i18n lints green. **U4 is the quiet prerequisite and it has landed** — codex `rust-v0.148.0`'s `base_instructions.provenance` is what stops a model-change fork carrying the previous model's instruction template, so T3 is instruction-correct on the version we now ship. |
| T3b the switch copy says "clamps", not "resets" | locales | ✅ | — | **Collapsed to verification, exactly as P3's locale-lane rule predicted** — P3 landed the value correction together with its own copy (both i18n lints are blind to a changed VALUE, which is why the two edits had to ride one commit). Verified 2026-08-21 on the integrated branch: `chat.runtimeSwitch.crossRuntimeBody` in BOTH locales now reads "The reasoning level is not reset — it is lowered to the highest level {{toRuntime}} offers" / «не сбросится, а снизится до максимального», and `runtime-switch-copy.test.ts` pins the key on both the generic and Codex branches. No commit of its own — the change lives in P3's `242a58380`. |
| T4 `canHostSession` precondition | serial | ✅ | `7ef67359f` | Landed 2026-08-20. **Signature corrected to async** — the credential arm reuses `CredentialManager.hasLlmCredentials`, the same local existence+expiry test `validateStoredBackendConnection` runs before its network arm, and that path is async; re-implementing it synchronously would fork the credential pathway. Wired after the busy guards and **before** both `ensureMessagesLoaded` and the boundary acquire. New wire code `RUNTIME_UNHOSTABLE` (union + `KNOWN_ERROR_CODES` in `packages/shared/src/protocol/types.ts`, **not** `packages/core` as the row implied), kept distinct from `CONNECTION_NOT_SWITCHABLE` because that refusal is categorical and this one is environmental and actionable. **Pi arm answered**: no flag (the Pi backend has none — provider flags gate cards), but `piServerPath` is Pi's exact binary analogue since `pi-agent.ts` refuses to spawn without it, plus the credential arm. Row name corrected: `resolveBackendRuntimePaths`, not `resolveBackendRuntime`; it and `resolveCodexBinaryPath` were module-internal and are now re-exported from `backend/index.ts`. **Verified at integration, because it is the one way this task ships as theatre**: the harness stub is an instance-method override inside the test file only — production calls the real `canHostSession` — and `hasLlmCredentials` returns `true` for `authType: 'none' \| 'environment'`, so a keyless local/custom endpoint is not refused. The load-bearing fifth case runs the real path via `realHostability` and asserts lease, cwd, drain, agent and connection all untouched. **Three defects found and fixed at integration, none visible without running the suites** (the row was authored with tests written but not run): (a) `canHostSession` called `getCredentialManager()` unguarded, which THROWS until storage layout v2 is bound — the credential arm now fails OPEN on an unbound singleton, because a precondition whose own dependency turns a legitimate switch into an uncoded crash is worse than the late failure it prevents, and skipping the arm only restores the pre-T4 outcome; (b) `assertSwitchTargetHostable` called `buildBackendHostRuntimeContext()` unguarded, which throws until `setSessionPlatform` has run — same fail-open treatment, with the note that production always has the platform bound because session creation itself refuses without it; (c) the two fail-opens then made two test premises silently vacuous, so both suites now bind what they assert against: the unit file and the load-bearing fifth case call `initializeCredentialManagerV2` (without it the fifth case reported `undefined` instead of `RUNTIME_UNHOSTABLE` on any machine carrying the codex binary), and `context-usage-after-switch.test.ts` stubs the precondition outright — its five rows passed alone and failed in the full run, because another file in the same process had bound the credential singleton and the arm then refused for real. Gate: `bun test packages/server-core` **1746 pass / 0 fail**. **Live-wave catch, fixed 2026-08-21 (rides the wave commit):** the credential arm was store-only, and the dp sign-in flow writes ONLY `~/.nessy/dp_auth_creds.json` — so on a signed-in machine every switch onto a one-click gateway card refused `credentials-missing`; the healthy-arm unit case had seeded the store directly and masked it (the first CDP run after T4 landed caught it: `switchSessionRuntime: target … refused (credentials-missing)` in the app log). Fix: `gatewayDpCredentialsPresent` — scoped to the VERIFIED gateway base URL (`isNessyGatewayBaseUrl`, the same rule that scopes Nestor request rewriting), reading `getValidCreds` (read-only, JWT-shape-validated, expiry-checked, no network), OR-ed into the arm; five deterministic unit rows drive the helper with its own creds path. The dp leg is STRICTER than the store leg (shape-validated), and the non-gateway scoping control is its own row. |
| T5 declared-vs-enforced drift test | independent | ✅ | `007829794` | Landed 2026-08-20, two files, **no production change**. Every membership and count is derived at test time from the enforcement site (`getSessionToolNames(...)`, `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`, the exported runtime sets, and occurrence counts over the backend sources); the only restatements are the two type-union vocabularies, and those are compiler-exhaustiveness-checked both ways via `satisfies`. **Row corrected: all FIVE `runtime-switch-costs` rows are derivable, not four** — `preToolCheck` derives from `runPreToolUseChecks` occurrence counts with a positive control, so the test derives all five and an undeclared new row id fails the set comparison. **One real drift found and deliberately left in place**: `scripts/cdp/lib/runtime-switch.ts`'s `runtimeOf('nestor-cloud-agent')` answers `'remote'` where `providerTypeToAgentProvider` answers `'nestor-cloud-agent'`; nothing records `'remote'` as intended and the harness never switches onto nestor, so it is recorded as an `it.todo` whose body holds the failing assertion rather than papered over. Nothing else had drifted: both agent-support sets, `runtimeForProviderType`, and the three comment counts in `runtime-switch-costs.ts` all matched. Both consolidation traps are recorded in the shared file's header, with the fail-open behaviour asserted against a defined-provider negative control. Gates: the two files **22 pass / 1 todo / 0 fail**; `typecheck:all` exit 0 in the integration tree (the agent's own electron typecheck was contaminated by the nested worktree resolving into the main checkout — noted so the next executor does not chase it). |
| T6 semantic collapsed-turn label | locales | ✅ | `e5389b1c7` | Landed 2026-08-21. **The row's own gate was the thing that was wrong, and it is corrected in §P.4 above.** A missing ru `_few`/`_many` does **not** fall back to the key name — `setupI18n` sets `fallbackLng: 'en'`, so it falls through to the **English** string (`"2 files"`, `"5 files"`) while counts 1/21/101 keep resolving in Russian, which means the row's own detector ("assert the result is not the key name") is green on the broken tree. Measured with a probe key pair carrying ru `_one`/`_other` only; the landed table asserts the resolution is **Cyrillic and differs from the English resolution**, and deleting a real `_few`/`_many` turns it red at counts 2 and 5. **A11 could not be a render**: `TurnCard.tsx` is unloadable under `bun test` (`Missing 'default' export in …/pdf.worker.min.mjs?url`, and stubbing it only reaches `DOMMatrix is not defined` in `react-pdf`'s nested `pdfjs-dist`) — so it lands as the containment arm `SessionStatusIcon.test.tsx:22-25` records, which is *stronger* than three widths: the label's span wears `truncate` (`white-space: nowrap`) so it cannot wrap at any width, and carries no responsive/container variant so its presence is width-independent. **A11's third check forced a design the row did not ask for**: `truncate` clips the END, which is where `errorSuffix` is concatenated, so the label had to be **bounded** — `TURN_PREVIEW_MAX_PHRASES = 3` (the cap the sibling running-tools branch already uses) with the surplus folded into the "other" phrase so no call is lost, and `TURN_PREVIEW_BUDGET_CHARS = 95` derived from the layout constants *before* measuring (worst case en 84 / ru 94). Two counts also moved: the table is **11 rows, not ~14** (`WebFetch` deliberately uncategorised, and a scan of 674 stored `session.jsonl` files found zero lowercase legacy spellings, with the same scan as its own positive control), and the runtime-specific surface is **four rows, not three** — `MultiEdit` is Claude-only beside `Glob`. **Eight key pairs, not five**: a commentary-only settled turn has no tool call at all and "Called 0 tools" would be a lie, so it gets `turnCard.runSteps`. omnigent has no local checkout (`.references/` holds three unrelated trees), so `web/src/lib/toolTitle.ts` was fetched at `b08eb50` and the Apache-2.0 attribution — plus the two symbols deliberately NOT taken, `FORMATTERS` and `stripOmnigentPrefix` — is recorded in `run-summary.ts`'s header. Every assertion carries a mutation probe. **Gates:** `bun test packages/ui` **424 pass / 0 fail / 1111 expect()** (from 328 — the two new files are 86 + 10); `typecheck:all` exit 0; `lint:ui` exit 0 with no warnings; `lint:i18n:parity` exit 0 (`2319 keys each`); `lint:i18n:sorted` exit 0 (it prints only on failure — read from `sort-locales.ts:58-62`, not assumed); `bun test packages/shared` **8655 pass / 0 fail / 24 skip / 1 todo** and `bun test packages/server-core` **1793 pass / 0 fail**, both exactly the branch baseline; `git diff --check` clean. |
| U0 the runtime-update lane (the four bumps as one picture) | — | ✅ | | Owner intent 2026-08-20: every runtime to its latest available version. Lane complete 2026-08-20 (U1–U4 all ✅). Not a task — the sequencing rule for U1–U4: a bump a later task is written against lands FIRST (U1→T2, U4→T1a, U2→T7), or that task pays to be re-verified. |
| U1 bump claude-agent-sdk 0.3.218 → 0.3.223 | serial-ish | ✅ | `8c7a810a5` | Landed 2026-08-20. Pins moved in all three `package.json` (root:136, shared:174, core:15) + `bun.lock`; `bun install --frozen-lockfile` green. **Every measured claim re-verified on the installed package**: CLI stamp 2.1.223, `sdk.d.ts` 319 781 bytes, 238 `export declare` (0 removals), NFC-normalize + djb2 derivation present in `sdk.mjs`, all three `tengu_*` strings T2 quotes survive in the binary (2 each), `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` at 8 occurrences. Gates: `typecheck:all` exit 0; `bun test packages/shared` 8620 pass / 0 fail / 18 skip. **Item 2 (2.1.222 auto-allow in background tasks)**: boundary re-verified — SDK got stricter, not wider; our hook-allow only passes what `runPreToolUseChecks` already approved, and SDK-side agent tool restrictions build from the same descriptors, so nothing relied on the closed bypass. **Item 3 (Bash bypasses 2.1.221/223)**: we do NOT share them on the allow path — allow rules need every subcommand to match, glob-allow refuses command substitution (`claude-bash-rule.ts:413`), unparseable denies, and `tokenize` collapses tab padding via `\s`. One residual found and filed as its own row (task chip 2026-08-20): deny/ask rules do not descend into `$(…)`/backtick spans, while the removal circuit breaker's `splitWithSubstitutions` does. ~~**Owed: the live arm (item 1, unknown-model window clamp vs our env pair) rides the Claude-runtime live smoke at the wave boundary**~~ **ANSWERED 2026-08-21 by W-pkg, on the packaged 1.31.0 build: our env pair wins.** For model id `tgpt/qwen35-397b-a17b-fp8` — unrecognized by 2.1.223, whose own records stamp `"version":"2.1.223"` — the session reported `contextWindow: 240000`, the catalogue value the product wrote, not an assumed one; the derived threshold 207 000 held and auto-compaction fired at `preTokens 208836`, i.e. at the threshold and not early. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW` therefore still beat the new enforcement and `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` is not needed. The one thing static reading could not settle (the assumed window's value is not resolvable out of the stripped binary) is settled by measurement — `docs/testing/cdp-runs/2026-08-21-w-pkg-packaged-wave.md`. |
| U2 bump pi-coding-agent 0.80.3 → **0.84.0** | serial-ish | ✅ | `367f73414` | Landed 2026-08-20. The row's shape held but its file list was materially short, and two premises were false — all corrected here: (1) the pin lives in **five** `package.json` files, not four — `packages/server-core/package.json:36` (`pi-ai`) was missed; (2) `apps/electron/resources/pi-agent-server/package.json` **does not exist** — that "stub" is `packages/pi-agent-server/dist/package.json`, GENERATED at build time by `scripts/write-dist-package.ts`; (3) `handleTokenUpdate` was **already async and already awaited**, so nothing had to be floated — `AuthStorage.set()` became a shared `storePiCredential` over `credentials.modify()`, awaited, with the reason recorded (a dropped promise leaves a live session on a stale JWT while reporting success); (4) there are **six** new `AgentSessionEvent` variants, not five (`summarization_retry_*` is a trio) — all six handled silently before the error-yielding `default`, each with its reason, plus a test deriving the list from the installed types; (5) the family grew to **seven** packages (`pi-client`, `pi-protocol`, `pi-telemetry`), resolving transitively. Five unnamed surfaces broke and were fixed: Copilot OAuth helpers removed from `pi-ai/oauth` (re-routed via `githubCopilotProvider().auth.oauth` in new `backend/pi/copilot-oauth.ts`, three call sites), six e2e preloads patching the deleted `ModelRegistry` statics → `ModelRuntime.create`, `ProviderHeaders` gaining `\| null`, `getModels` narrowing to `BuiltinProvider`, and `AgentSession.modelRegistry` gone outright. `createRegistry` is now async; the cwd-PREPARE guards run on BOTH sides of the new await so the guard→barrier window stays yield-free — the first attempt (await above the guards) was caught by the transaction test. Offline posture enforced: `modelsPath: null`, process-local `CredentialStore`, `allowModelNetwork: false`, `PI_OFFLINE` (verified to exist in 0.84). Gates: frozen-lockfile clean, `typecheck:all` 0, pi-agent-server **713/0** (+ the tests-included `tsc -p` trap run: 43 errors in touched test files, all pre-existing backlog), shared 8621/0, server-core 1739/0 at its base. Two observations for the record: `pi-session-lineage-real-server.test.ts` fails ALONE with a Bun.build resolve artefact but passes in package runs (not the bump; not a register row yet), and bun's manifest cache needed a fresh `BUN_INSTALL_CACHE_DIR` to see 0.84.0 (may bite a warm CI cache). **Owed: the Pi live smoke and a packaged-build check at the wave boundary.** (The ⛔ G2 marker was retired 2026-08-21 — G2 is answered, T7 is unparked.) |
| U3 decide `@anthropic-ai/sdk` (^0.100.0 → 0.115.0?) | independent | ✅ | `8fa9118ef` | **Decided 2026-08-20: bump to `^0.115.0`.** Established first, as required: (i) the import surface is **types only** — AUDIT CORRECTION 2026-08-21: in fact ZERO import statements — the audit found the repo never imported from `@anthropic-ai/sdk` in any commit (only two comments name it, in exactly the two files this note listed as importers; the direct dep satisfies the agent-sdk's >=0.93.0 peer and nothing else), so the bump was even safer than argued and the "four type imports resolve against 0.115" gate claim proved nothing, zero client construction anywhere; (ii) the agent-sdk bundle `sdk.mjs` contains **0** references to `@anthropic-ai/sdk` — its `>=0.93.0` peer is a typings-only relation, so our copy never executes on the Claude path; (iii) **pi-ai carries its own exact pin `@anthropic-ai/sdk@0.91.1`** as a regular dependency, so the Pi transport is unaffected by ours; (iv) `^0.100.0` arrived in the craft-pivot baseline commit (`845cf0a41`) — a bulk import, no recorded reason, so it was NOT a deliberate floor. Gates for a types-only bump: `bun install` + `--frozen-lockfile` green, installed 0.115.0, `typecheck:all` exit 0 (the four type imports resolve against 0.115). The Claude live smoke owed at the wave boundary (U1) covers this bump for free — no runtime code path changed. |
| U4 bump codex app-server `rust-v0.147.0` → `rust-v0.148.0` | independent | ✅ | `19442298b` | Landed 2026-08-20. Binaries for all three targets fetched and verified against the release `codex-package_SHA256SUMS`; `--version` → 0.148.0. **Corrected mechanism note:** `fetch-codex.mjs --windows-sandbox` is a verify-only mode with no self-update path, so the windowsSandbox pin (archive + three file sha256s) was computed from the same release SHA256SUMS trust anchor + extracted files, then the script re-run as installer/verifier — the manifest header's "never hand-edited" holds for `binaries`, not for `windowsSandbox`. Regeneration took the plan's cheap path after verifying its premise: our `generated/` == upstream `schema/typescript` and `schema/` == upstream `schema/json` **byte-identical at v147**, so v148 was two directory copies + the `config-schema.json` release asset (94 top-level props, was 93). **`thread/inject_items` confirmed on the landed artifacts, statically AND live**: present in regenerated `ClientRequest.ts` (98 methods exactly, as measured), `ThreadInjectItemsParams.ts` byte-identical to v147, string present in the shipped darwin-arm64 binary — and then driven over stdio against the INSTALLED 0.148.0 binary (temp `CODEX_HOME`, loopback provider never contacted): `initialize` under `capabilities.experimentalApi: true` → `thread/start` (no network) → `thread/inject_items` with a user message, an assistant message and a **paired `function_call` + `function_call_output`** → `{}`. Positive control: `no/such_method` → `-32600` unknown-variant listing the method table. So T1a's channel and T1b's pairing both hold on the version we now ship. "No production file imports a generated type" re-verified (all matches are doc comments; only `manifest.json` + `config-schema.json` are imported). `cdx-147.ts` → `cdx-148.ts`, ID/TITLE/EXPECTED_CODEX_TAG re-pointed. Gates: `typecheck:all` exit 0; `bun test packages/codex-agent-server` 31 pass / 0 fail (incl. the manifest-tag pin test, updated). **Owed at the wave boundary:** the packaged `cdx-148` live run (wire shape is what the previous bump broke) and the Codex live smoke — watching the two default-ON behavior changes (`UnboundedConnectionRetries` against our loopback adapter; `unified_exec` flip is Windows-only), off-switches are one line in `config.toml` if the smoke turns bad. **SUPERSEDED 2026-09-11, and one thing this row landed did not move with the pin.** P7.2 (`f042e5674`) took the pin to `rust-v0.150.1`; the live case was re-pointed a second time (`cdx-150`, `d014ab97d`), which overtakes the packaged run owed above — that run is now owed against the case and the binary we ship, not against this one. The **"manifest-tag pin test, updated"** named above is `getCodexRuntimeInfo`'s tag assertion in `packages/codex-agent-server/src/__tests__/runtime-info.test.ts`, and the 2026-09-11 lift did NOT update it a second time: at HEAD it expects the 0.148-era tag and reads `rust-v0.150.1`, one failing case in that file (measured 2026-09-11 by W11-v2 — `bun test` on that one path, 2 tests across 1 file, 1 pass / 1 fail, 0.55 s at load 8.8). A pin test that spells a version is exactly the test a version bump owes, and it is not in the known-failing register. |
| T9 reconnect a gateway connection from its row menu | independent | ✅ | `3a0746138` | Landed 2026-08-21. All three measured surfaces re-verified per §P.3: the row menu's oauth-only branch (`:341-345`) and `handleReauthenticate` (`:793`) held exactly, `MainContentPanel.tsx:249` held once the path was completed to `components/app-shell/`, and `CredentialHealthBanner`'s span was `:126-158`, not `:128-150` — both corrected in §P.4 above. **One premise was wrong and is corrected there too**: the row said to import `isNessyGatewayBaseUrl` from `@nessy-agent/shared/agent/backend`, but that barrel also re-exports `createAgent`/`ClaudeAgent`/`PiAgent` and **no production renderer module imports it** (`grep -a`: two hits in `apps/electron/src/renderer`, both in one test file). The renderer twin at `components/apisetup/nessy-gateway.ts:77` is the same whole-URL match against the same literal and is already reached this way by `byo-runtime.ts` — the RULE the row specifies is unchanged, only its source. Second correction: the hook is the PAGE's, not the row's — `useNessyGatewayAuth` subscribes to the global `nessy:gatewayAuthStatus` stream (`:70-75`), so a hook per `ConnectionRow` would mark every gateway row busy at once and would also react to the chat banner's flow; the page owns one hook plus `reconnectingSlug` and passes `reconnectPhase` per row, matching the `validationStates[conn.slug]` idiom already beside it. Only ONE new i18n key was needed (`settings.ai.reconnect`): the in-progress labels reuse the banner's own `onboarding.gatewayConnect.connecting`/`.waitingBrowser`, so the two surfaces cannot drift in wording. The oauth branch is pinned byte-identical by a six-line source match, and the new item is asserted to be a SIBLING of that ternary rather than a third arm. `bun test` has no DOM in this repo, so the rule is a pure exported function and the wiring is source-matched — see the Gate note. **Gates**: new `ai-settings-reconnect.test.ts` 13 pass/0 fail (47 expect); renderer 1456→1469 pass, 0 fail (delta = exactly this file, measured both ways); shared 8698 pass/29 skip/1 todo/0 fail — baseline unmoved; server-core 1812 pass/0 fail (the parent's 1807 baseline predates `1819fb937`, which added exactly 5 tests to `runtime-switch.test.ts`; this task touches no server-core file); `typecheck:all` exit 0; both i18n lints exit 0; `git diff --check` clean. A positive control was run on the membership assertion — deleting the `isNessyGatewayBaseUrl` guard turns the BYO row red, so the detector is not vacuous. Not live-verified: unit-level gates only, no app instance started. |
| T10 boot fails loudly on a bad storage layout; fresh dir boots packaged | debt | ✅ | `794532a80` | Landed 2026-08-21. **The row's evidence was three stacked DETECTOR failures over one real defect, and all of them are corrected in §P.9 above.** (1) "Packaged is fully silent" is evidence of nothing — `logger.ts` disables BOTH electron-log transports outside debug mode, so a packaged build never writes `main.log`, on successful launches too; the repo already names the lever (`DEBUG_LEVER`) and already ships one always-on log for the same reason (`autoUpdateLog`). (2) The pre-v2 tree is **not** refused by readiness: it carries `storageLayoutVersion: 2` and the three directories, so `ensureStorageLayoutV2` returns `ready` and the FIRST `loadStoredConfig()` then throws, because `activeWorkspaceId` is absent and `undefined !== null`. The two validators disagree, and that gap is the defect. (3) The hang is the unawaited `app.whenReady().then(async …)` — the rejection reached `process.on('unhandledRejection')`, which logs and returns, and with no window `window-all-closed` never fires. **The row's item (2) had nothing to fix**: a fresh dir initializes correctly, proven on an absent root, an existing empty root and live on the packaged build. What it was actually looking at is a config dir whose PARENT does not exist → blocked `unsafe-root`, on a path that had no log line at all; that path now logs before it opens its dialog. `loadStoredConfig` is deliberately NOT loosened — `activeWorkspaceId` is required in `StoredConfig` and this validator is the fail-closed guard against overwriting a legacy config. **The row's real finding is the ending**: `app.exit()` does not end a windowless startup here (sampled twice; controls: a minimal main on the same binary exits every time, the same call at the top of `whenReady` exits, and once a window exists it exits again), `process.exit()` behaves identically, and **three designs passed `bun test` and still hung on the rig** — a 60 s watchdog macOS never delivered (a 5 s one was delivered, so waits are now counted in 1 s steps), `app.exit()` from inside the dialog's nested loop (it consumes Electron's one-shot shutdown permanently), and a 2 s hard-exit grace armed after `app.exit()` (which stops timer delivery). The ending is now two calls in one tick: `app.exit(code)` then `process.kill(process.pid, 'SIGKILL')`. The parentless dialog blocks the main thread AND renders nothing on a windowless startup (zero windows per `System Events`), so it is genuinely best-effort, exactly as this row's gate anticipated. The global `unhandledRejection` backstop deliberately does NOT exit — the boot promise's own `.catch` is the exact signal; the handlers only add the always-on diagnostic while boot is incomplete. **Gates**: new `boot-fatal.test.ts` 14 pass/0 fail and new `storage-readiness-config-gap.test.ts` 4 pass/0 fail; the six touched suites 48 pass/0 fail; server-core 1812 pass/0 fail (baseline unmoved); shared 8723 pass/29 skip/1 todo/0 fail (8719 → 8723, delta = exactly the 4 new tests); `typecheck:all` exit 0; `git diff --check` clean. **LIVE, packaged arm64 1.31.0 unsigned, `build-dmg.sh` exit 0, packaged bundle verified byte-identical to a fresh build of the committed source**: (a) EMPTY temp config dir → page target in **2 s**, v2 tree created, no `boot.log`; (b) synthesized bad-layout tree → **exit 137 after 16 s** with the named line on stderr AND in `<config dir>/logs/boot.log`. `release/` deleted after. **Deviation**: the §P.9 correction text landed under `3529918ea`, not here — a parallel agent's `git commit <pathspec>` on the plan file took my working-tree edits, which is the AGENTS.md trap verbatim. Unblocks W-pkg. |
| T11 deny/ask Bash rules see into substitution spans | debt | ✅ | `c4418cbc9` | Landed 2026-08-21. One-line dispatch in `matchClaudeBashRule`: `allow` keeps `splitCompoundCommand`, `deny`/`ask` take `splitWithSubstitutions`. **The row's own instruction was the thing that was wrong and is corrected in §P.9 above**: permissions.md § *Compound commands* names the separator set only and says nothing about `$(…)` in either direction, so it cannot be the citation. The anchor is § *Wrappers* — "A deny or ask rule matches past any leading assignment, so `Bash(rm *)` in deny still matches `FOO=bar rm -rf tmp/`" — plus the page's any-depth deny/ask path rule and its stated reason for allow's narrower matching ("An allow rule for one parameter value wouldn't establish that the call is safe overall"). Nothing on the page contradicts the change, so no divergence to report. **The defect was measured on the pre-change function, not assumed**: all ten `deny Bash(rm:*)` rows against a substitution returned `no-match` before and `match` after, with the allow column byte-identical across all 14 probe rows (git-stash A/B). Two facts the row did not have: the reach also covers **subshells and process substitution** (`scanCommand` opens a span for a top-level `(`), and single-quoted text stays inert, so `echo '$(rm -rf ./x)'` is correctly still `no-match` — reaching into it would be a false positive, not extra safety. The `'unparseable'` contract is asserted action-independent rather than argued: `splitWithSubstitutions` starts with `splitCompoundCommand` and a nested span that fails alone is dropped (`echo $( )` still parses), so both splitters return null together — a table drives that over 10 inputs × 3 actions. The budget boundary is exact and its degradation is the pre-fix top-level reach: depth 32 matches, 33 does not, 500 returns in ~2 ms. **No caller test moved** — `permission-dsl`'s substitution rows use the structural `kind: 'bash'` matcher, and its unparseable rows are unaffected by construction. **Gates:** file suite **105 pass / 0 fail**; whole `pi-harness` **555 pass / 0 fail**; `bun test packages/shared` **8719 pass / 29 skip / 1 todo / 0 fail** (baseline 8698 + exactly the 21 rows added here); `bun test packages/server-core` **1812 pass / 0 fail** — baseline unmoved; `typecheck:all` exit 0 (`packages/shared/tsconfig.json` includes `src/**/*`, so the new test file is really typechecked — the pi-agent-server test-exclusion trap does not apply here); `git diff --check` clean. |
| T12 MCP-AUTH dp arm learns deferred MCP | debt | ✅ | `86af318f4` | Landed 2026-08-21. The dp arm now drives the app's own deferred path and the check it used to block on PASSES live: `dp-reached-by: mcp__tool_search → mcp__tool_load → the tool on the next request (deferred)`, result carrying the corp identity `i.i.gavrikov` — unfakeable, straight off `dpGitlab`. **Three row premises were corrected, all in §P.9 above.** (1) A load does NOT land inside the same request: the model loaded the tool (success text naming it) and the call nine seconds later in a separate model turn answered `Tool … not found` **twice**; the positive control — the same tool on the next USER request in the same session — ran and returned the identity. `onLoadToolNames` sets `toolsChanged` beside `registerTool`, and shared/AGENTS.md already says "Pi only picks up new proxy tool defs on the next handlePrompt". So the probe LOADS in turn one and CALLS in turn two. **The load tool's own message over-promises and that is a real product finding, left unfixed and out of scope.** (2) The absence detector must key off `mcpHealth` itself, not `snapshot.available` — that flag is `!!agent.getHarnessDiagnostics()`, i.e. "a Pi turn is live", and reads `false`/`pi-runtime-not-started` between turns while `connected:["dpGitlab","plugin_figma_figma"]` sits right beside it; gating on it blocked the case on a detector artifact. (3) The composer swallows newlines, so `sendPrompt` refuses a multi-line prompt with `composer-mismatch` — every probe prompt is one line. figma half byte-identical as the row requires; its own FAIL is the SAME deferral mechanism (`plugin_figma_figma` connected, tool "not found"), pre-existing and deliberately not touched here. Live: dp half `ok`, case FAIL on the figma check only. |
| T13 Q6-LIVE claim-4 control stops switching onto remote | debt | ✅ | `ab3fbe1a3` | Landed 2026-08-21. New `sessionCreatedOn` CREATES the refusal-control session on the cloud connection instead of switching onto it; `sessionOn` is untouched and still serves the three local runtimes, because only the cloud arm is refused. **The row's premise held exactly and the create-time door turned out to be shipped, so the fallback it offered ("read the catalog through a session that never switches") was not needed and the control keeps its full strength**: `CreateSessionOptions.llmConnection` rides the same `sessions:create` RPC as New Chat, `createSession` puts it straight on the managed session with no provider gate on the path, and `spawn_session` offers the same field to the model — a real product path, not a harness back door. Still no turn: `resolveManagedProvider` → `resolveConfiguredProvider` reads `managed.llmConnection`, set at creation here rather than at switch, so the control never touches a live remote. Live on the operator profile: `catalog-cloud: the session runs on nessy-cloud-agent — llmConnection=nessy-cloud-agent` then `claim 4 control: the gate still REFUSES a runtime that dispatches no definitions — 14/14 rows refused on nestor-cloud-agent`. All five claim-4 checks `ok` (Codex 0/14 refused, Pi control 0/14, workspace-scoped 0/14, cloud 14/14); the previous deterministic `CodedError CONNECTION_NOT_SWITCHABLE` is gone. Case ends BLOCKED, honestly: claims 1/2/3 need `NESSY_CDP_DEAD_CHILD_AGENT` / `NESSY_CDP_FOREIGN_MODEL_AGENT` / `NESSY_CDP_PLUGIN_AGENT`, none of which exist on this host. |
| T14 iOS renders the runtime-switch notice | debt | ✅ | `b5180fd32` | Landed 2026-08-21. **Both of D3's measured iOS gaps reproduced exactly and both are closed; three of the row's own assumptions are corrected in §P.9 above.** (1) **Decoding was not the large half the row hedged about** — `SessionEvent` is a flat enum with a `default: .unknown` arm and `ChatViewModel.apply` a flat switch, so `message_added` (`dto.ts:505`) cost one case, one decode arm reusing `user_message`'s own `ChatMessage` decoder, and one dedup-by-id `apply` arm; **no part of the iOS event pipeline was redesigned**, so §P.9's bound never bound. (2) The parser landed in **NessyAgentKit**, not the app: `RuntimeSwitchNotice.init?(markerContent:)` is a pure `Sendable` struct beside the `AgentRuntime` mirror it needs for labels, so its table runs under `swift test` on macOS with no simulator — the desktop suite's cases ported one for one, since both parsers read one durable string written by one server. Position-based, JSON tail read leniently: unknown value, unknown field, truncated JSON, `null`, `42` and a bare array all degrade to the pre-tail sentence, and the two-segment form keeps it — a marker from a NEWER server reaching an older phone is the normal case here, not the edge. (3) **The row does not mention the seam its visible half needed**: which rows the divider claims is a decision, and a decision inside a `@ViewBuilder` is proven by the compiler and nothing else, so it is extracted as `MessageBubble.switchNotice(for:)` and pinned both ways (an `.info` marker becomes the notice; an ordinary `info` row, a `.status` row carrying the same text and an assistant row all keep their card). Copy is four sentences, not three — the no-carry arm keeps the original wording so a pre-tail row reads today as it read when it was written — mirroring `chat.runtimeSwitch.notice*`. iOS localisation is English-literal-as-key, where a key typo **silently serves English instead of failing**, so the four `ru.lproj` rows were verified against the compiler's own emitted keys (`swift build -Xswiftc -emit-localized-strings`) and again inside the built `.app`, not by eye. Composed at render time, so the offline path gets it free (`CachedMessage` stores `role`+`content` verbatim). Mutation probes: reading the tail with `split(":")` reddens 6, collapsing `native` onto the generic sentence reddens 1, an inert `messageAdded` arm reddens 1. **Found, not fixed:** the switch-confirmation dialog iOS already shipped (`RuntimeSwitch.confirmation`) has no `ru.lproj` rows at all — English-only on a Russian phone, predating this plan. **Gates:** `swift test` (NessyAgentKit) **104 pass / 1 skip / 0 fail** (baseline 96); `xcodebuild -scheme NessyMobile -sdk iphonesimulator … test` on iPhone 17 Pro **52 pass / 0 fail** (baseline 49) and `** BUILD SUCCEEDED **` / `** TEST SUCCEEDED **`; `git diff --check` clean. No live sitting: a switch needs a paired desktop session, which is not reachable headlessly — the compile, the ported parser table and the routing test are the gate. |
| T15 tool_load's message stops over-promising | debt | ✅ | `ab26f0cd3` | Landed 2026-08-21. All three model-visible strings (description, prompt snippet, result text) plus the host debug line now state the truth — the loaded tool serves from the USER'S NEXT MESSAGE, and the snippet tells the model to finish its reply instead of calling now. The strings are part of the SIGNED model contract, so the change moved the `mcp__tool_load` pin in `PI_STATIC_MODEL_CONTRACT_HASHES` (dated comment in the table's own style; new hash computed by instrumenting the verifier's throw site, printed, reverted), the `tool-surface.json` fixture (hash + two prose notes), and required `electron:build:servers` — the live-manifest contract test caught the stale bundle by name, exactly as designed. Wording pinned in `session-tool-registration.test.ts` with the reason. Making the promise TRUE stays a recorded non-goal. Gates: pi-agent-server 714 ran / 0 fail, shared 8753 ran / 0 fail, typecheck 0. |
| T16 MCP-AUTH figma arm loads deferred tools | debt | ✅ | `da2f8128a` | Landed 2026-08-21. **MCP-AUTH is PASS 5/5 for the first time since deferral became the default** — and the fix falsified the row's own premise, so §P.9 above carries three corrections. T12's pattern transplanted exactly (turn one searches and loads, forbidden to call; turn two calls; the two arms now share one `deferredLoadTurn` helper while keeping their prompts written out separately, so the dp arm's prompt stays byte-identical to the one T12 measured and is a real regression control). Measured: `figma-reached-by: mcp__tool_search → mcp__tool_load → the tool on the next request (deferred)`, and the figma server ANSWERED with the operator's own account — `mcp__plugin_figma_figma__whoami → {"handle":"Igor Gavrikov","plans":[…]}`, which no log of ours could fabricate and no unauthenticated server could give. The `Tool … not found while mcpHealth.connected names the server` failure is gone. **But deferral was not the only fault, and only the fix could show it:** with the tool reachable, `get_metadata` died at Pi's own `validateToolCall` (`- fileKey: must have required properties fileKey`) before the call left the client — 31 of the remote figma server's 32 tools need a real file key, so that default could never have produced this arm's positive. Default probe is now `whoami`; a local schema refusal is now an honest BLOCK naming the knob, never a figma verdict. T12's header quoted the pre-T15 load message twice as if current (prose, not a pin) — corrected, and the case now pins NO wording of it. Dp arm green throughout: `dp_gitlab_whoami` → `i.i.gavrikov`. **Gates:** `bun run typecheck:all` exit 0; `bun build --no-bundle scripts/cdp/cases/mcp-auth.ts` OK; strict `tsc --noEmit` on the case exit 0; `git diff --check` clean; live `bun run scripts/cdp/cases/mcp-auth.ts` → `--- MCP-AUTH: PASS ---` (5/5), dev app, operator profile. No `packages/**` touched. **Owed to close-out:** the checklist's MCP-AUTH row still reads `FAIL 3/4` — this run is its update. |
| T17 iOS switch-confirmation dialog in Russian | debt | ✅ | `1959198d9` | Landed 2026-08-21. Four RU rows, not three: the emitted-key list caught the dialog's "Switch" button living in the APP target (`ModelPickerView.swift` SwiftUI literal), which reading the package alone missed. Title `"Switch to %@?"` → «Переключить на %@?», both bodies aligned with the desktop's `chat.runtimeSwitch.*` vocabulary (iOS keeps ONE title carrying the target name, so it is deliberately not a copy of the desktop's two titles). **The row's own recipe was wrong** — corrections in §P.9: `-emit-localized-strings` emits nothing outside a full build, and `SWIFT_EMIT_LOC_STRINGS=YES` is ignored for SPM targets on the xcodebuild command line; the working emitted list is the app target's `-exportLocalizations` with that setting (127 units). Package keys enumerated from source (8 calls: 4 translated by T14, 3 added); they resolve via `Bundle.main`, the mechanism T14 proved live. Gates: `plutil -lint` OK; export rebuild 0 errors; `Switch` left the missing list (19 → 18). Finding → new row T18: 18 more untranslated app-target units, incl. both iOS permission-prompt usage descriptions. |
| T18 remaining iOS strings in Russian | debt | ✅ | `98d58d182` | Landed 2026-08-21. All 18 units closed — re-export reports **missing 0** on the regenerated project. 14 translated units and 4 identity rows (audit correction 2026-08-21 — this note and the commit message both said 12+6; the enumeration itself always named 14) (both iOS permission-prompt usage descriptions, Appearance/Theme/Dark/Light, Integration, Permission mode → «Режим прав», the send/stop accessibility labels, both empty-state titles, both `ContentUnavailableView`s) + 6 identity rows (brand names, `%lld.`, `·`, annotated in-file). **Two corrections in §P.9**: `InfoPlist.strings` existed on NEITHER side (the export synthesizes those units from `Info.plist` — en base child created per the file's own convention), and a clean export was not yet proof — the pbxproj referenced no `InfoPlist.strings`, so a real build would have shipped neither file; `xcodegen generate` re-run (+14 lines, purely the new variant group + Resources entry) and the export re-proven on the regenerated project. Gates: `plutil -lint` OK ×3; export build 0 errors; missing 18 → 0. Finding → new row T19: the desktop's own ru.json echoes English in 77 values (incl. the same "Permission mode" this row translated). |
| T19 desktop RU locale echoes English | debt | ✅ | `61a516d64` | Landed 2026-08-21. All 77 triaged: **40 translated, 37 deliberately kept** — the kept set is (a) brands and product/feature names: Claude, Claude Code, Claude Pro / Max, Codex, Codex · ChatGPT Plus, OpenAI, Anthropic, Nessy Desktop Backend, T-bank, Guardian, Inter, OAuth, Webhook, Shell, Init, Slug, the three `plugins.origin.format.*`; (b) placeholders and examples: `sk-...`, URLs, file paths, the proxy-bypass list; (c) pure interpolation templates: `{{percent}}%`, `plugins.sourceNpm`, `plugins.version`, `plugins.compatDeferredEntry`, `taskChecklist.progress`, `transport.wsClosedReason`, `toast.fileCheckpointSkippedDescription`; (d) keyboard labels: Enter, Ctrl+Enter, ⌘ Enter — so the next sweep can skip them by category. Vocabulary aligned with the file's own precedents: scope → «Область» (per `plugins.detailScopes`), workflow → «Рабочий процесс» (per `chat.workflowLaunch.title`), `chat.permissionMode` → «Режим прав» matching iOS T18, both Steer surfaces → «Направить» with the tooltip carrying the semantics («Отправить, не прерывая модель»), provider-card titles keep the `Nessy · …` brand shape with the word agent translated. `mcpChannelPushSection` → «Вмешательство MCP-серверов», matching its sibling toggle's wording. Gates: `lint:i18n:parity` OK (2323 keys), `lint:i18n:sorted` OK, JSON parses; grep proved no test pins any changed RU value (matches were comments and fixture names). |
| W-pkg the packaged wave (after T10) | debt | ✅ | | Ran 2026-08-21 on the UNSIGNED arm64 1.31.0 build (`BUILD_EXIT=0`; `CSC_IDENTITY_AUTO_DISCOVERY=false` + the stub `NESSY_DESKTOP_UPDATE_URL` + `NESSY_DESKTOP_UPDATE_CHANNEL=dev`, the owner-mandated recipe). Narrative, verbatim tails and the snapshot/restore proof: `docs/testing/cdp-runs/2026-08-21-w-pkg-packaged-wave.md`. **Results:** CDX-148 **PASS 8/8** (the leg the close-out owed — `app-under-test.kind=packaged`, shipped `codex-app-server` sha256 = the rust-v0.148.0 pin, `mcp__sources__elicit-probe__whoami` with the server's own nonce); MCP-W1 **PASS 11/11**; MCP-W3 **PASS 6/6**; SKL-P1 **PASS 12/12** (metadata half; activation half stays operator-run); MCP-W2 **FAIL 14/25 — case debt, not a mint regression**, with the invariant proven by control on all three runtimes; COMPACT-LIFE claude **12/13**, the whole lifecycle green and only the case's own cleanup red. **U1's owed live arm is answered: our env pair wins** — on CLI 2.1.223 an unrecognized `tgpt/…` id still reports our catalogue's 240 000 and auto-compaction fires at 208 836 against the 207 000 derived from it, so `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` is not needed and U1 item 1 closes. **T10 re-proven three times incidentally** — three config dirs (one of them empty) booted packaged to a page target in 6/4/4 s, and the stale g6 tree's `config.json` was the T10 defect verbatim. **Corrections to the row's own text are in §P.9 above** (four: connections are part of a fixture rebuild; SKL-P1's case process needs `NESSY_CONFIG_DIR`; MCP-W2 needs the T16 two-turn shape; COMPACT-LIFE's cleanup is unpassable since `764ee8662`, so `NESSY_F5_SLUG_SUFFIX` is mandatory). **Picked up beyond the row, from the close-out's hand-off:** RTS-15 **PASS 11/11 packaged** (T7's live gate, no longer dev-only) and RTS-14, which **FAILED 33/36 packaged for a case gap** — `workLeg` never asserts its own plant, and both attempts had the Claude leg answer DONE without running the `cat` (0 occurrences of the tag in the Claude SDK's own transcript, no stage-2/6 tool row in ours) while the carry itself stayed green. **Two things left open for the owner:** RTS-14's one `HANDLER_ERROR` on an anchored codex → pi leg (one occurrence, no cause on the wire), and the case-debt fixes above. Skipped and named: the lane-G BYO set, PRV-N25 (owner: later), the fixture/policy-BLOCKED rows, and T2's live gateway day beyond this wave. `release/` deleted after the last leg; operator `config.json` restored byte-identical (`dafd7650…` both sides). **2026-09-11:** the CDX-148 PASS 8/8 recorded here is a reading at `rust-v0.148.0`; the pin is `rust-v0.150.1` since P7.2 and the case was re-pointed to `cdx-150`, whose own rule is that a foreign runtime's version bump invalidates every row measured against the previous one. The reading stays, as history; it is not evidence about the shipped runtime. |
| T8 sweep `claude-config/projects` (D5) | independent | ✅ | `0d096d6b5` | Landed 2026-08-20 as two new classes in the existing age-based allowlist — `vendor-transcript` and `vendor-project-root` — same `cleanupPeriodDays` cutoff, dry-runnable, logs before removing. **Two plan facts corrected.** (1) The layout line is incomplete and the gap is load-bearing: a transcript can carry a same-named sidecar directory `<sdkSessionId>/subagents/` (10 dirs, 17 of 217 files), which a `.jsonl`-only sweep would strand forever; it is removed as a second NAMED removal (never a hidden recursive delete) and its mtime joins the age decision via `max()`, which can only keep data longer. (2) "Nothing sweeps `claude-config`" is true of THIS repo but not of the vendor — a `.last-cleanup` stamp shows the Claude binary runs its own; that does not make T8 redundant (it ignores our `retentionDays` and only runs when that Workspace's subprocess does), and the code says so rather than claiming the vendor never cleans. Granularity is file-level because a project dir is keyed by CWD, not session (one holds five transcripts of five ages); emptied dirs go via their own class. Re-verified: 166 project dirs, 165 map to a session name, **37 orphaned**. Dry run over the real `~/.nessy-agent`: **0** vendor removals at the shipped 30-day default (the tree is 3–6 days old) with a **2-day positive control** giving 210 = 200 transcripts + 10 sidecars, 0 failed — an absence reported with a control, per AGENTS.md. |
| T7 Pi session rebuild | D | ✅ | `0b5670863` | **LANDED 2026-08-21.** A FIRST switch into Pi now forks a Pi session file the switch authored, so the model arrives holding the conversation — tool calls, results and intermediate commentary — instead of a 24×1200 text tail. Shape: translator + writer/verifier (`packages/shared/src/agent/pi-session-rebuild.ts`), `SessionManager.rebuildPiSessionForSwitch`, one init field (`carryHistorySessionFile`), one branch in `ensureSession`, `NATIVE_HISTORY_CARRY_IMPLEMENTED.pi → true`. **Corrections to the section, recorded there in full (six):** (1) every 0.80.3-era format claim re-verified on the 0.84.0 pin and ALL survived — v3 header, the single `entries[0].type==='session' && typeof id==='string'` gate, silent body skipping, verbatim entry copy; (2) the U2 oracle (`buildContextEntries`/`sessionEntryToContextMessages`) is what the translator test asserts against, not a restatement of the format; (3) “one init field + one branch” needed a RETURN channel too — `session_id_update.carriedHistory`, set only after `forkFrom` returned, plus a retry-once-as-`continue` on a carry fork that throws (a BRANCH fork still fails loudly); (4) NO anchor is written at rebuild time — Pi resumes by directory and `forkFrom` mints its own id, which the ordinary `session_id_update` path records; (5) “two contract tests” was **five** — `pi-harness-baseline` (TWO marker blocks), the init-field contract, `pi-runtime-h1-real-server`'s adapter-routing regex, and two `runtime-switch.test.ts` rows whose negative control WAS `pi` (now `nestor-cloud-agent`); all updated with dated notes; (6) the modal's generic `carryNative` says “image attachments … the model cannot open”, which is FALSE on Pi (its `read` tool returns image content), so `chat.runtimeSwitch.carryNativePi` was added to both locales and routed like `carryNativeCodex`. **Anchor still wins twice**: `ANCHORED_PROVIDERS` keeps `'pi'` so a return is planned `anchor`, and the subprocess refuses the carry again if `.pi-sessions` already holds any session. **Positive control (required by the plan) PASSED**: a real forked `AgentSession` loads 5 carried messages and emits ZERO `message_start`/`message_end`/`tool_call`, while the SAME listener sees both from `sendCustomMessage` — measured, not cited. Register edit G5-shaped: the Pi STRUCTURAL row's reason NARROWED (it is now “a session file the SDK owns is never rewritten”, with the byte-identical test re-scoped and re-titled to match) and a DECISION row ADDED; T2's row lost its now-false “still the standing rule for Pi” clause. Gates: `typecheck:all` **0**; shared **8759 ran / 0 fail** (8729 pass, 29 skip, 1 todo); server-core **1816 pass / 0 fail**; pi-agent-server **714 pass / 1 skip / 0 fail**; the tests-included `tsc -p` trap run reports **0 errors in every file this task touched** (567 pre-existing backlog errors elsewhere, none in the edited regions); i18n parity + sorted green; `lint` 0 errors; `git diff --check` clean. **Live**: RTS-15 (new) PASS 11/11 — preview `native`, marker `runtime_switched:anthropic:pi:{"carry":"native"}`, and Pi recalled a build tag that existed only inside a Claude tool result; RTS-14 PASS 35/35 with **`EXPECTED_TIER` unedited** (its circuit hosts Pi first, so every later entry into Pi is an anchored RETURN — which is precisely why RTS-15 had to be added). Run file: `docs/testing/cdp-runs/2026-08-21-t7-pi-carry.md`. §P.3's commit-subject table had no T7 row; one was added. |
| R1 crash-safety, what crossed, provenance | independent | ✅ | `26e33f54b` | Landed 2026-08-21. **Three of the row's premises were wrong and all three are corrected in §P.4 above.** (1) The crash window the row is written around **persists nothing**: `switchSessionRuntime` has exactly ONE persistence point and it sits after the arm, the rebuild and the notice, so a process that dies inside the switch leaves the on-disk record entirely pre-switch — the invariant holds vacuously and the residue is an orphan transcript T8 already sweeps. The states a next start can see vary along TWO dials (anchor set? transcript loadable?), giving four shapes, all four driven end-to-end through the two SHIPPED deciders in two different packages: `buildRuntimeHandoffPayload` (the body of the closure `SessionManager` hands the backend) and `ClaudeAgent.shouldSuppressTextHandoff`. (2) **The atomicity assertion the row asks for cannot fail as written** — with the destination occupied by a directory, a plain `writeFileSync` throws too, leaves nothing and passes every natural assertion; measured by removing the tmp+rename pair, which reddened nothing. The discriminator that does work is permission-shaped: `rename(2)` needs write on the DIRECTORY, `open(2)` on the FILE, so a read-only destination is replaced by a rename-based writer and refused with `EACCES` by a direct one — and the same mutation now reddens it. (3) **The notice can only record the PLAN, and the plan is not always what delivers**: `rebuildClaudeTranscriptForSwitch` now returns whether it landed, so a `native` plan whose Claude rebuild failed writes `carry:"text"` — the durable row cannot promise what the next turn will not keep. Codex's `thread/inject_items` runs on the FIRST TURN AFTER the switch and can still fall back to text there, which the notice structurally cannot see; recorded as a residual rather than papered over. Item 2 landed as D3's JSON tail — `runtime_switched:<from>:<to>:{"carry":…}` — parsed BY POSITION, not `split(':')`, because D3's own growth path for the tail (the model delta) carries ids that may contain `:`; three copy keys × 2 locales, and the pre-R1 two-segment marker keeps the original key, pinned both ways. `RuntimeSwitchMarker` is a `type` and not an `interface` on purpose: it is handed to `t()` as the interpolation bag and TS infers an implicit index signature only for the former. **Item 3 is closed as decided (D10) with no code** — T2's stamp-site comment already carried the decision and both limits; R1 adds one sentence naming this row as closed on it. **The iOS half of D3 remains OPEN exactly as D3 states it**: iOS does not decode `message_added` and renders the marker verbatim, so mobile now shows the tail as raw text until decoding + parsing land as an iOS-side task. Every new row carries a mutation probe: disabling the transcript-presence gate reddens 2, dropping the notice downgrade reddens 1, replacing tmp+rename reddens 1, removing the native mark reddens 2, dropping the tail reddens 5. **Gates:** `bun test packages/server-core` **1807 pass / 0 fail** (baseline 1801, +6); `bun test packages/shared` **8698 pass / 29 skip / 1 todo / 0 fail** — exactly the branch baseline; renderer input suite **172 pass / 0 fail** (from 166, +6); ChatDisplay + event-processor suites **247 pass / 0 fail**; `typecheck:all` exit 0; `lint` exit 0 (4 pre-existing warnings in `ChatDisplay.tsx`, none within 1 500 lines of the change); both i18n lints green (`2322 keys each`); `git diff --check` clean. |
| T20 MCP-W2 deferred arms use the two-turn shape | debt | ✅ | `64b1efc06` | Landed 2026-08-21. **MCP-W2 22/25 live on the dev app, Pi 8/8 and Claude 7/7 — every former Pi/Claude red is green**; the three that remain are Codex's model-self-report rows, the detector limitation the checklist has carried since 0.147, on the arm this row says not to touch. Control before the change on the same rig: **16/25**. §P.9 carries five corrections. The load-bearing ones: deferral is **Pi-only** (`pi-agent-server/src/deferred-mcp-tools.ts`), so the Claude arm's selection turn takes the "already listed" branch and its packaged `-32601` did not reproduce (7/7 before AND after); the single-turn call was only HALF the Pi drift, because a deferred tool is absent from the model's own tool list and three inventory checks were red about tools the product hides on purpose (six Pi reds, not three); and **the first selection prompt tripped Pi's Guardian** — naming the tool under test and forbidding the call in the same sentence that asked for its load produced `Guardian denied this action [prompt_injection]: … including one explicitly forbidden by the embedded instruction`, the model reloaded without that name, and the call turn's `Tool … not found` read exactly like a deferral bug. Also: the `-model-reported-surface` observation was sliced at 2 000 chars, i.e. cut off before the names it exists to show — now recorded whole; and the three self-report checks were measured unreliable **with the pre-T20 shape as the control**, so they are evidence about the model's answer, not about the mint. Run file: `docs/testing/cdp-runs/2026-08-21-t20-22-case-debt.md`. |
| T21 COMPACT-LIFE cleanup order | debt | ✅ | `c67852474` | Landed 2026-08-21. The session is deleted before the connection, both in the `finally` that opens at creation, both verified by re-listing. **Proof run: the CLEANUP ARM ALONE on the `~/nessy-cdp-g6` fixture profile — the operator's `config.json` was not touched and the compaction half (12/13 packaged) was not re-sat**, which is what the row permits. It carries the negative control the order exists for: deleting the connection FIRST is refused by the product — `1 session(s) and 0 automation(s) still use "claude-gateway-77"` — and the connection survives; in the T21 order both go, and the fixture profile returns to its three connections. `T21-CLEANUP-PROOF: PASS`. Two corrections in §P.9: the case had **no `import.meta.main` guard**, — agt-9/agt-10 lacked it too (audit correction 2026-08-21; both now guarded), so it could not be imported and the arm could only have been proven by a copy of itself — guard added, the two teardown helpers exported, and the proof drives the case's own code; and a cleanup proof without the wrong order proves nothing, hence the control. The case gains a check for the session (13 → 14 on the claude arm), carries the product's refusal MESSAGE into the failure detail, and its header now records why `NESSY_F5_SLUG_SUFFIX` is mandatory on the operator profile — sessions from earlier sittings keep pointing at a slug after its connection is gone, so `-91` refuses no matter what the current run cleans up. Run file: `docs/testing/cdp-runs/2026-08-21-t20-22-case-debt.md`. |
| T22 RTS-14 plant assertion + HANDLER_ERROR look | debt | ✅ | `f1112804b` | Landed 2026-08-21. Every leg now reads its own tool rows back out of `getSessionMessages` before anything is asked to recall them; a missing plant is retried ONCE with RTS-15's emphatic wording and then FAILS THE CASE AT THE PLANT, so a leg where the model declined to run the command can no longer be reported as a broken carry. **Four live sittings on `~/nessy-cdp-rts/config`: A FAIL 31/32, B FAIL 16/17, C PASS 42/42, D PASS 42/42** (D on the shipped code). **Run B is the assertion firing for real** — leg 3 (codex) produced no tool row after BOTH asks and the case stopped at the plant, never reaching a carry check; the transcript shows that codex turn emitted no assistant message at all. **⚠️ THE `HANDLER_ERROR` REPRODUCED (run A, leg 6, codex → claude) and is a PRODUCT FINDING for the owner — see §P.9 for the wire.** The widened capture named it: `HANDLER_ERROR` wraps `pi-session-disposal-failed` (`SessionManager.ts:11032`), which is the strict drain rethrowing a **codex** failure — `Failed to dispose agent … codex-runtime-cleanup-failed` in the app's own log for the same second (`codex-agent.ts:1941`). Three observability defects, none fixed here because they are `packages/**` and the row says stop and report: the message names the wrong runtime, the leaf cause (which of four cleanup steps failed) never leaves the process, and the user sees only `HANDLER_ERROR`. The switch itself is atomic — the session stayed on `codex-gateway` with no marker for the failed leg. Frequency once in four sittings today, once in two packaged; C and D are the non-reproduction control. Run file: `docs/testing/cdp-runs/2026-08-21-t20-22-case-debt.md`. |
| T23 lane-G BYO re-sit on the operator profile | debt | ✅ | `e5d47c39d` | Landed 2026-08-21 as docs, in T24's commit. Six legs on the owner's REAL `~/.nessy-agent`, owner-authorised: **BYO-CATALOG PASS 5/5 ×2** (`codex-custom`, `claude-custom-2`), **BYO-QWEN PASS on BOTH arms**, **CODEX-TURN PASS 8/8**, **G3-WIRE FAIL — server-side**, **the NEW Qwen-on-Claude arm PASS**, **the DeepSeek arm PASS**. **Five row premises corrected in §P.9 above.** The two that would have produced wrong answers: BYO-CATALOG does not read the ENTITLED catalogue (that is the form's own `fetchModels` RPC — **388 rows, byte-identical for all seven llm-proxy connections**, and a catalogue is not an entitlement: the per-model probe is), and **the row's own example model manufactures its own failure** — `tgpt/qwen3-235b-a22b`'s 40 960 window sits below a session's ~46 000 resting context, so the first translator turn came back `400 … maximum context length is 40960 … your request has 56666 input tokens`; on `tgpt/qwen35-397b-a17b-fp8` (262 144) it answered `TRANSLATE-OK`. **DeepSeek verdict: YES** — 21 of the 388 are deepseek ids, the two `tgpt/*` ones probe `ok` and the `openrouter/*`/`cloud/*` families `no-quota`; `tgpt/deepseek-v4-flash-fp8` then answered `DEEPSEEK-OK` on Pi. **The translator proof is the instrument's placement, not a new line**: `[codex-adapter] upstream auth:` is written by `postChat` ONLY (`nestor-client.ts:126`) — the passthrough never calls it — so exactly one new line across the turn, reading `bearer` and not `nestor-token`, is both "it was translated" and "the upstream was `openai-compatible`"; the wire router is `undefined` for `claude-custom` (no `anthropic-messages` model), so nothing could have bypassed it. **G3-WIRE's FAIL is the endpoint**: the tool-free probe answered `ok wire=anthropic-messages` while the live turn got `403 … Security Guardrail Triggered: Malicious MCP detected. Invalid tools: …` listing our own `mcp__session__*` tools — any tool-carrying turn on the anthropic wire — and the mixed half had no chat-completions model on the connection. **Every mutation went through the app's own `saveLlmConnection` RPC** (the one Settings → AI uses), never `config.json`, and both arms restored: all 11 connections key-sorted equal to the pre-arm snapshot, re-checked after teardown. **Three product findings recorded, none fixed (docs-only row)** — see §P.9: the dev window restoring a packaged `file://` pathname (contradicting the contract written on `window-state.ts` itself), a BYO 403 reported as an expired gateway sign-in, and the qualified-key subagent dispatch. Run file: `docs/testing/cdp-runs/2026-08-21-t23-lane-g.md`. |
| T24 Q6-LIVE claim-4 lawful control | debt | ✅ | `e5d47c39d` | Landed 2026-08-21. **The row is a DUPLICATE of T13 and its code fix had already landed** — `ab3fbe1a3`, hours before T23–T25 were written; `sessionCreatedOn` (`q6-live.ts:266`, used at `:504`) IS the create-on-connection rebuild this row asks for. Verified against the current tree before anything ran, so the row collapses to the RE-SIT — the half T13 could not carry, its own live evidence predating the corrected tree — and the duplication is recorded in §P.9 rather than absorbed. No further case change was needed; this commit carries the correction, the tracker and the run file. **Sitting A (the mandated re-sit): 8 checks, 8 ok** — `catalog-cloud: the session runs on nessy-cloud-agent` then `claim 4 control: the gate still REFUSES a runtime that dispatches no definitions — 14/14 rows refused on nestor-cloud-agent`, against `0/14` on Codex, `0/14` on the Pi control and `0/14` session-less; the deterministic `CONNECTION_NOT_SWITCHABLE` the 1.31.0 close-out measured is gone. Case ends BLOCKED on the three env-named arms, honestly. **Sitting B armed two of the three** (`cru-plain`, `scan-inventory`; DEAD_CHILD deliberately not set — both recipes damage the owner's real profile): 15/17, claim 4 green again, and both armed claims' SUBJECTS passed (`[model] scan-inventory asked for "sonnet" … it ran on "tgpt/qwen35-397b-a17b-fp8"` with no ceiling refusal; `cru-plain is IN the SDK's agent registry`). **Its two reds are one CASE defect, taken in as T26**: claims 2 and 3 read a background launch receipt as the child's answer — the exact trap the case header documents for claim 1, which claim 1 alone was rebuilt around. Run file: `docs/testing/cdp-runs/2026-08-21-t23-lane-g.md`. |
| T25 switch-disposal failure reports its true cause | debt | ✅ | `bce7c105e` | Landed 2026-08-21. Three reporting defects fixed: (1) the strict-drain AggregateError is named by `sessionDisposalFailureMessage(resolveManagedProvider(managed))` — a codex failure now reads `codex-runtime-session-disposal-failed` instead of wearing the Pi label that sent W-pkg's triage the wrong way; (2) `flattenDisposalFailure` logs every LEAF of every failure before the throw (nested AggregateError included — the codex cleanup shape whose leaves reached no log), bounded at depth 4; (3) the renderer parses the message shape and shows `chat.runtimeSwitch.failed` + new `failedDisposal` description naming the runtime and saying the fail-safe held (session stays whole) — keys in both locales, parity/sorted green (2325 keys). The message shape is now a CONTRACT (renderer regex + exported helper + test pins). The existing `pi-session-disposal-failed` assertions still pass untouched — a pi session's message is unchanged. **The underlying intermittent codex cleanup failure stays OPEN by design**: 2-of-6 sittings, and the leaf log this row adds is the instrument the next reproduction diagnoses it with. Gates: new `SessionManager.disposal-failure.test.ts` + `process-supervisor` suite 43 pass / 0 fail; `tsc -p` server-core 0; typecheck:all 0; i18n parity + sorted OK. |
| T26 Q6-LIVE claims 2/3 wait for the child, not the receipt | debt | ✅ | `861f7745e` | Landed 2026-08-21 under the commit that carries this row (same convention as T27/T28). Both arms detect the launch receipt, use it as the HANDLE and read the child's answer off the SETTLEMENT REPORT that names it (`backgroundDispatch` + `settlementReport` + `backgroundChildReport`); claim 1, claim 4 and the BLOCKED honesty are untouched and no `packages/**` file moved. **Six premises the row could not know, all corrected in §P.9 per step 4, three of them measured on the rig before a line was written**: (1) the Claude SDK's receipt is a DIFFERENT shape (`Async agent launched successfully … agentId:`, verbatim from the shipped binary) that `BACKGROUND_RECEIPT` cannot match; (2) the answer does NOT only arrive on a later turn — on Claude it lands inside the launch turn, which is why sitting B's existing wait burned five minutes; (3) binding on the handle is NOT sufficient — sitting C scored the parent's own launch prose (`ACDC7-… / The scan-inventory agent has been started as a background task (task ID: …)`) as the child's answer on a child still running, so the row as scoped would have replaced a false red with a **false green**; (4) "only each arm's last check moves" is one check short — the `[model]` announcement is written into the CHILD's report, never the receipt; (5) the follow must not short-circuit on the token (sitting D's `resume` results carry the text without the announcement); (6) one rig repair, `setConnectionWhenIdle`, for a `SESSION_BUSY` race on a three-second-old session. **Gate: 15/17, not 17/17, and the shortfall is a PRODUCT miss the fixed case is now able to see** — claim 3 green end to end via `tool-result:TaskOutput` carrying `<status>completed</status>` and the token; claim 2's two reds are one fact reproduced three times (a Pi background child settles and the host never receives `task_completed`), taken in as **T30**. Run file: `docs/testing/cdp-runs/2026-08-21-t23-lane-g.md`. |
| T27 restored dev window rebuilds its URL | debt | ✅ | `6fcb9b3a8` | Landed 2026-08-21. The dev restore branch now mirrors the prod branch exactly: `rebuildDevRestoreUrl` (pure, in `window-state.ts`, next to the `SavedWindow.url` contract it enforces) keeps only the saved QUERY on the dev-server origin; a parse failure returns null and the caller falls back to its default-query load, unchanged. The packaged-pathname replay — Vite 200, no `window.electronAPI`, no `did-fail-load` — is now impossible by construction. Gates: new `window-restore-url.test.ts` 3 pass / 0 fail (packaged pathname dropped + dev URL intact + unparseable → null); electron `tsc -p` 0. Live shape already measured by T23 (the finding and the `Page.navigate` repair are in its run file). |
| T28 BYO 403 is not a gateway sign-in prompt | debt | ✅ | `005faa817` | Landed 2026-08-21. **Correction to the row's own recipe:** the right scope key is not `isNessyGatewayBaseUrl` re-derived at the mapper — it is the upstream kind the adapter ITSELF resolved at postInit (`resolveClaudeRuntimeUpstream(...).kind`, the same authority that decides auth attachment), stashed on the agent and passed as `claudeRuntimeUpstreamKind`. The gateway sign-in wording now fires only for `'nestor'` or an unresolved kind (the gateway is the only out-of-the-box claude-runtime card); `'openai-compatible'`/`'anthropic-messages'` (BYO) keep the API-key wording that names the credential the card actually carries. The 2026-08-15 `403 → provider_error` branch (upstream reason carried through) is unchanged and still preferred whenever the status IS captured — T23's case was the uncaptured-status path. Gates: mapper suite 28 pass / 0 fail (2 new BYO rows + gateway/unresolved row); typecheck:all 0. |
| T29 qualified-key subagent dispatch | debt | ⏸ | | Scoping look DONE 2026-08-21, fix parked on an owner call — the two sides are both defensible and the row's escape hatch fires. **What the look established:** `resolveAgentDefinition` (definitions.ts) already indexes the UNSCOPED capability key as an alias — `qualifiedName = normalizeName(definitionKey)` rides `aliases`, so `agent:plugin://…#agent.scan-inventory` resolves today. What failed is the SCOPED selection key (`…@workspace:<id>`), which only the capabilities selection layer mints — the subagent registry never sees scope-suffixed keys, and the model read that scoped form off a capability-facing surface. **Owner question (one to pick):** (A) teach the resolver to strip a trailing `@<scope>` before matching — most permissive, but this file's own comments treat matching-widenings as shadowing hazards; (B) add the scoped selection key as one more alias when runtimeDefinitions are built — safest, key knows its workspace at build time; (C) find the surface that showed the model a scoped key and make it show the dispatchable name — cleanest if that surface is ours. Recommendation: **B**, with C as a follow-up if the surface is found. |
| T30 a settled background child reports to its parent | debt | ✅ | `14a7b0374` | Landed 2026-08-21 under the commit that carries this row. **Both faces fixed, and the row's own Pi diagnosis was wrong** — the four corrections are written into §P.9 per step 4. The Pi miss is not `registerBackgroundChildTask`'s `settled` promise: the subprocess emits the event correctly and the HOST drops it, at `PiAgent.handleSubprocessEvent`'s opening `if (this.rawEventAttemptTerminal) return` — a latch armed at the turn's terminal boundary and cleared only by the next `chatImpl`, which is why every one of this row's four positive controls is a run whose parent kept working. Fix: that one line now lets a DETACHED run's `task_completed`/`task_notification` past, into a sink that is not the turn (`BackendConfig.onPiDetachedTaskEvent` → `SessionManager.processEvent`, the same seam the turn loop feeds, so R86's gate, the renderer forward and `deliverMonitorEvent`'s three-rule discipline are all the production ones). Claude face: `tool-matching.ts:406` learns "background" from the SDK's own launch receipt (`Async agent launched successfully`, verbatim from the shipped 2.1.223 binary, one occurrence) as well as from `run_in_background`; the guard it joins is unchanged, because a foreground answer never carries that sentence. `adaptBackgroundTasksChanged`'s recorded refusal is NOT reversed — different feed, different path. **Units**: `tool-matching.test.ts` (receipt opens the gate; the existing foreground-`agentId:` negative stays green) and `pi-agent-max-turns.test.ts` (a detached run reports after the latch, and `turn_start`/`message_update`/`agent_end` still do not) — both extended rather than duplicated, and `background-result-delivery.test.ts` gained the header saying which file pins which face. **LIVE GATE: 16/17, not 17/17** — sittings L and M, check for check. The Pi half: `Background task task-subagent-mt3aswu8-465111 completed (status=completed)` in the host log, the line that was ABSENT for all three T26 reproductions, then `fallback-child-report {"via":"host-notice:user"}` and `ok claim 2: the substitution announces itself — requested=sonnet resolved=tgpt/qwen35-397b-a17b-fp8`, a check written into the CHILD's report and therefore only greenable by the report arriving. The Claude half: `claim 3: the agent ran and returned its answer — token=F9AD9-E1237-3D06B-A4335`, carried by `host-notice:user` on SDK id `ac6756d39e4034fd6` rather than by the blocking `TaskOutput` that rescued sitting H. **The one red is the child's own answer**: `scan-inventory` spends its turn reporting that `rg` is missing from its tool environment, so the codeword never appears; the report itself arrived in full. Two case-debt items recorded in the run file (that check's failure message says "never reached the parent" even when a report WAS found, and `scan-inventory` is a poor codeword carrier). Gates: shared 8767 ran/0 fail, server-core 1823/0, pi-agent-server 715/0, `typecheck:all` exit 0, `lint` exit 0 (0 errors), `git diff --check` clean. Run file: `docs/testing/cdp-runs/2026-08-21-t23-lane-g.md` §Sittings J–M. |
| T31 .pi-processes records fall under retention | debt | ✅ | `683f9939a` | Landed 2026-08-21 under the commit that carries this row. `retention-sweep.ts` gained a `pi-process-record` tier: the unit is one HANDLE (`process_<32hex>.json` + its `.log`), aged from the NEWER of the two, allowlist-shaped so `scratch/` and anything the store grows next survive by construction, and the directory itself is kept like `logs`/`feedback`. `NEVER_SWEPT_SESSION_ROOT_ENTRIES` stays and keeps its meaning (never enumerated as a workspace); what the module header claimed ON TOP of it — that the store is lifecycle-managed and needs no retention — is the recorded reason this row corrects, and it is measured false. **The row's premise about the EMFILE is ALSO false, and that is the finding.** Profile: 807 records / 1 615 files, all terminal (`exited` ×803, `stopped` ×4), oldest **8.0 days**, none older than 14, against a 30-day default — so the startup sweep on this fix's own launch reported `[retention] sweep found nothing older than 2026-07-22T18:37:15.647Z` and the count is **807 → 807**. Positive control for that absence: the same shipped sweep, dry-run at 7 days with every other tier disarmed, plans **310 removals (155 records × 2) and 0 from any other class**. At ~100 records/day a 30-day window settles near 3 000 — more than the ~800 that already broke it — so retention does not prevent the EMFILE. The proximate defect, measured on this launch's first switch: `ProcessStore.list()` (`process-store.ts:150`) opens every record in one `Promise.all`; the first `EMFILE` is on `automations.json` and `plugins/installed.json` and the `scandir '…/.pi-processes'` line is its 600 ms-later tail; `launchctl limit maxfiles` is **256** and the launcher's `ulimit -n 8192` does not reach Electron. **Bounding that fan-out is a different file and mechanism — NOT absorbed here per §P.3's scope bound; it needs its own row.** Units: old record swept / fresh survives / a live log keeps its pair / dry run equals the real run, plus the never-swept row rewritten to say what it now pins. Gates: shared 8767 ran/0 fail, `typecheck:all` exit 0, `lint` exit 0, `git diff --check` clean. |
| T32 ProcessStore.list() bounds its fan-out | debt | ✅ | `a179b9086` | Landed 2026-08-21 under the commit that carries this row. `ProcessStore.list()` no longer does `Promise.all(names.map(get))`: a fixed pool of `PROCESS_LIST_READ_CONCURRENCY = 32` readers walks the handle list, so the fd cost of a list stops scaling with the directory. Rejection semantics are deliberately unchanged — one unreadable record still fails the whole list, as the `Promise.all` did — and the constant is exported so the unit asserts the shipped value rather than a copy. **The row's "follow whatever bounded-concurrency helper the repo already has" was searched and there is none to follow**: the only one in the tree is `Semaphore` (`packages/pi-agent-server/src/orchestrator/spawner.ts:219`), and it is not importable here — `server-core` does not depend on `pi-agent-server` (the dependency runs the other way, and that package is the Pi SUBPROCESS), while `shared`/`core` offer nothing of the kind. So the bound is a local pool in the store, not a second general helper. **One number in the row is wrong and a future reader will check the bound against it**: `list()` opens the `.json` of each pair and never the `.log`, so the fan-out was 807 opens, not 1 615 — 1 615 is the directory's file count. The conclusion holds either way (807 does not fit in 256). Unit `process-store.test.ts`: peak simultaneous opens `=== 32` over bound+8 records, no more readers than work when under the bound, and the rejection row. **Positive control** — reverting `list()` to the old `Promise.all` makes the bound row red at **44** simultaneous opens. **The bound is free, measured rather than assumed** (a 32-wide pool over 851 files could have traded an EMFILE for a stall): against the profile's real store, bounded 284/283/226 ms vs unbounded 269/254/237 ms. **Live gate, operator profile, two launches, store 836 → 851 records**: eleven runtime switches completed, each proved in effect by the case's own `llmConnection=<slug>` check, and `grep -ac EMFILE` = 0 plus `grep -ac 'too many open files'` = 0 on BOTH logs from boot onward. The absence has its control in the same file — sitting J, same rig/profile/case, 807 records, unbounded `list()`, EMFILE on the first switch of a fresh app. Gates: `bun test packages/server-core` 1826/0 (baseline 1823 + this row's 3), `bun test packages/shared` 8767/0, `bun test packages/pi-agent-server` 715/0 (its two `bash-*-real-server` tests import this very file), `bun run typecheck:all` exit 0, `git diff --check` clean, no `release/`. Narrative and verbatim tails in [`2026-08-21-t23-lane-g.md`](../../testing/cdp-runs/2026-08-21-t23-lane-g.md) § Sittings N–P. |
| T33 Q6-LIVE claim-2 red tells the truth | debt | ✅ | `7c3f6c95c` | Landed 2026-08-21 under the commit that carries this row. **(1) The message is split three ways, on a hoisted `settlement`** rather than on `dispatch`: a report that ARRIVED without the token says the delivery path WORKED, names the `via`, states in so many words that this is not T30 returning, and prints the child's own last 300 characters; "no report reached the parent at all" is now reachable only when `backgroundChildReport` returned nothing; the no-dispatch branch is unchanged. **Claim 3's twin sentence was corrected in the same pass** — one line, same file, same hazard, and there it is structural: the no-report case returns above as a GAP, so that branch can only be reached when a report arrived, and it must not say "never reached the parent". **(2) The carrier is `codewordTask()`.** The row's diagnosis was right and the mechanism is worth naming: "reply with exactly `<token>`" is followable with no tools, but a plugin agent's own system prompt is an AGENDA and displaces it — `scan-inventory` spent L's and M's turns explaining that `rg` is missing. The instruction now states the two things that make it survive any agenda ("This needs no tools, no files and no commands — if the work you usually do is impossible here, skip it and reply with that line anyway"). Claim 3's prompt was deliberately NOT moved onto the helper: it was green in L/M and the row is claim 2's. **Live gate, operator profile, both env arms as sitting M: sitting N is 17 checks / 17 green** (`BLOCKED` only on claim 1's deliberately-unset `NESSY_CDP_DEAD_CHILD_AGENT`), with `claim 2: the child actually RAN and returned its answer — token=6C095-2118E-9D1FE-4E7F5`; **sitting O reproduces claim 2 4/4** on `26BDB-B95E9-F17E5-DF938`, and its report is the artefact — `1. scan-inventory - done` and the codeword on its own line, same agent and same tool environment as the two sittings where it apologised instead. **The honest-message branch could not be exercised and that is the correct outcome** — it fires only when the child answers something else, which after the carrier fix it did not; it is proved by construction from the hoisted `settlement`. Sitting O's one red is claim 4's Pi control switch (`llmConnection=undefined`), 8/8 in N minutes earlier. Gates: `tsc -p scripts/cdp/tsconfig.json --noEmit` exit 0, `bun run typecheck:all` exit 0, `git diff --check` clean. Checklist row refreshed; sittings N–P appended to [`2026-08-21-t23-lane-g.md`](../../testing/cdp-runs/2026-08-21-t23-lane-g.md), including one product observation recorded rather than row-ed (the plan's intake is closed): a cold launch on this profile spends **25–30 s** inside its first renderer session switch over 708 sessions, past the case's own 30 s `Runtime.evaluate` budget. |
| Close-out (version, notes, docs-site, two regenerations) | Z | ✅ | `3016f22e4` | Mechanical steps landed 2026-08-21 for 1.31.0 under `3016f22e4` (version lockstep, release notes, docs-site en+ru, both regenerations). Final pass same day after the debt lane (T10–T33): release notes extended twice (`558c52d1a` for T7/T9/T15/T19, then the second debt lane's four FIXED bullets); AGENTS.md currency pass (`3a849b345`: backlog 429→567, BYO wire-routing fact, electron:build:servers, two new measured traps + the stale-dist and packaged-log traps earlier); both regenerations re-run on the final tracker (parity report +10 lines, register unchanged); **master comparison clean — `origin/master` == merge-base == `bbd48f967`**, the branch contains master entirely; the six carried-by-own-commit rows pinned (`f77c9c47d`). **Full final regression on the final tree: 14 756 pass / 30 skip / 1 todo / 0 fail (14 787 ran, 1 216 files)** — one real red found and fixed on the way (`835ab2526`: the docs-integrity guard's 50 KB floor encoded the pre-restructure checklist shape; floor moved to 15 KB and the narratives ARCHIVE joined the guarded list), plus one non-reproducing fail in the first of three runs, consistent with the register's load-sensitivity class. typecheck:all 0, lint 0, i18n parity+sorted OK (2325 keys) — all measured on the final code tree at T25–T33's gates. **Row-by-row audit ran 2026-08-21** (workflow: 8 auditors + adversarial re-check of every discrepancy): 41/46 rows CONFIRMED, 0 unverifiable, 5 documentation discrepancies — U3's import-surface premise (zero imports, not four), T12's misattributed citation (in the plan and two code comments), T18's 12+6 split (really 14+4), T21's "only case without the guard" (agt-9/agt-10 lacked it too — both now guarded), and this row's own regenerated parity report left uncommitted — ALL five corrected in the audit-corrections commit, each marked in place. No product-code discrepancy. Open at close: **T29 ⏸** (owner call, recommendation B recorded) and the **intermittent codex cleanup failure** (2-of-6, instrumented by T25's leaf log). |

## P.8 Open from the 2026-08-20 four-pass audit

Four independent passes returned 70 findings (16 blocking, 16 decisions). **All of
them are now applied or folded into the tasks** — this section is retained as the
record of what was found and why each answer is what it is, not as a queue.

**Every owner gate is now answered.** G5 2026-08-20 (narrow the reason, add a
DECISION row — landed with T1a); **G2 2026-08-21: DO T7** — the row is unparked
and scheduled after the debt lane; G6 finally closed the same day (below).

### Applied to the tasks — the record of what each fix was

| # | Where | What is missing |
| --- | --- | --- |
| A1 | P3 call site | "beside `canHostSession`" is too early: `ensureMessagesLoaded` is at `SessionManager.ts:15542`, AFTER T4's `:15533`. A plan computed there reads `managed.messages === []` on any session not opened in this process, estimates 0 and returns `native` unconditionally. Compute it **after `:15542`, before the boundary acquire at `:15559`**, and test a `messagesLoaded: false` session. |
| A2 | P3 signature | It never says which model the window is resolved for. At that call site the session still carries the SOURCE model. Resolve for the **target's effective model**, computed the way T3 computes it, and test a source-window-larger-than-target case. |
| A3 | P3 `native` tier | It depends entirely on `resolveContextWindow`'s `connection_override` tier: `getDefaultModelsForConnection` returns `[]` for `pi_compat`/`claude-runtime`/`codex-runtime` and `MODEL_REGISTRY` holds no `tgpt/` ids, so only an object-shaped `connection.models` carrying `contextWindow` can produce a window. Say so, and upgrade the `runtime-switch-session.test.ts` fixtures from bare id strings to `ModelDefinition` objects. |
| A4 | P3 pre-confirmation surfacing | No transport. `RuntimeSwitchDialog` is fed only `{kind, from, to}` and `ConnectionRow.pick` is a synchronous callback with no server round-trip — ChatPage's own comment says the dialog "structurally cannot show anything the server only learns while switching". Either add a read-only `previewRuntimeSwitch` command awaited before `setPending`, or keep the copy plan-agnostic. |
| A5 | P3 vs the native tasks | P3 lands BEFORE any native carry exists, so between P3 and T1a/T2 the modal would promise "full history, tool calls included" while the code still sends 24×1200 with no tool rows. Decide: P3 keeps today's copy behind a capability check until a native path lands, or P3 lands last. |
| A6 | P2 §1 vs T2's fail-safe | `handlesRuntimeHandoffNatively` as a class constant makes the text fallback **unreachable** on ClaudeAgent — it suppresses the build on every turn. T2 promises the opposite. Make it a per-turn query (`shouldSuppressTextHandoff()`), or decide `native-transcript` vs `handoff` before the switch commits. |
| A7 | T1b | No Files list, no Gate, no DONE condition — and its real file set is wider than its lane: `getRuntimeHandoffRows()` is the sibling of `getRuntimeHandoffMessages`, defined at `SessionManager.ts:14054` and wired at `:14364`, with the config field typed at `backend/types.ts:578`. Either give it those files (which puts it on the serial lane) or move the seam into P2. **ANSWERED 2026-08-21 by T1b — the second option, and it needed no work**: T1a had already moved the seam out to `packages/server-core/src/sessions/runtime-handoff.ts`, where it receives `rows: managed.messages` — the whole transcript. So the row projection is a second exported function there, `SessionManager.ts` takes one added argument inside T1a's own closure, and T1b never joined the serial lane. All three anchors quoted in this row were stale by the time it was executed. |
| A8 | T1a gate leg 1 | The bundled `codex-app-server` is 183 MB, untracked and gitignored (fetched by `scripts/fetch-codex.mjs`), so a committed test that spawns it is skipped or red everywhere but this machine. Guard it the way `codex-e2e.test.ts` already does (`describe.if(process.env.NESSY_CODEX_E2E === '1')`) and state that the gate is a recorded local run, not CI. |
| A9 | T2 envelope | `toolUseResult` is kept with no constraint on its VALUE, but our stored result is a plain display string for most rows. Write it JSON-parseable — pass through when the stored value already parses, otherwise wrap as a JSON string literal — with golden cases for both. |
| A10 | T3 guard rows 2–3 | Two either/ors left open ("assert the substitution, or refuse"; "guard, or clamp"). Pick the option that preserves today's user-visible outcome (clamp / leave `undefined`) and strike "refuse" — a second refusal path contradicts the answered decision that size never refuses a switch. |
| A11 | T6 gate | "looks right at three widths" has no assertion, so the cleanest task in the plan cannot self-certify. Name the objective checks (no wrap at width X, error suffix not truncated, phrase present in the DOM) and demote the look to an optional glance. |

### Decisions — ALL ANSWERED 2026-08-20

> **FOLDED INTO THE TASKS 2026-08-20.** These rows are the record of *why*; the
> instruction now lives where an executor will meet it. **D4** → P1 (step 0, the
> display fix, plus the four assignment sites). **D5** → its own task **T8** (it
> also closes 37 pre-existing orphans, so it does not belong inside T2). **D6**,
> **D7**, **D10** → T2. **D7** and **D9** → P3's plan tiers — D7 added a *third*
> tier, `anchor`. **D8** → T2's live-gateway day. Keep these rows: the decision and
> its evidence are what a later reader needs when the task text alone looks
> arbitrary.

| # | Decision | Status |
| --- | --- | --- |
| ~~D1~~ | **RESOLVED — folded into G6, ANSWERED 2026-08-20: option A.** The modal stays accept/decline plus P3's "what will cross" line; revisited once at close-out on observed behaviour. | resolved |
| ~~D2~~ | **RESOLVED — folded into G3, ANSWERED 2026-08-20: option (A)** (write the file ourselves) **plus G3-D** (a mirror-only store as a test harness). The (B) recommendation it was written against was refuted by reading `sdk.mjs`. | resolved |
| ~~D3~~ | **DECIDED 2026-08-20 — mobile surface for the model change.** The transcript notice IS the right place — it is a persisted `role:'info'` row, so it survives reload and a language change, and it is the only surface both clients read. **But mobile cannot render it today**: `message_added` is absent from the iOS `SessionEvent` decoder, so the live event falls to `.unknown` and is dropped; on the next transcript load the row arrives and iOS renders the raw machine marker `runtime_switched:pi:anthropic` **verbatim** in an "Information" card. So putting the model delta into the marker without an iOS fix makes mobile *worse*, not better — and iOS's two-button `SwiftUI.Alert` also cannot host a third choice, which bears on G6. **Decision: carry the model change in the notice, and the same task adds the iOS half** — decode `message_added`, and parse the marker into copy instead of printing it. Drop the `ChatPage` toast: it is a second surface, on one client, saying what the durable row already says. **Implementation note:** the marker parser splits on `:` and model ids may contain `:` under our own charset — extend it with a JSON tail after the prefix, keeping the two-segment form working (tests pin it). | resolved — no longer an owner question |
| **D4** | **DECIDED 2026-08-20 — fix the display AND add the raw pair.** Measured: both formatters rebase against the HOST PROCESS's `process.cwd()` and nothing chdirs, so the base is whatever launched the app (`/` from Finder). In the corpus **4 of 190** stored path values carry the actively-wrong `./Users/…` form and **39** are absolute paths that sit inside the session cwd and should have been relativized. Damage today is cosmetic — the string is only rendered, never resolved — but a converter fed those 4 rows injects a path that resolves to the **wrong place**, and the reproduced `../sibling/…` arm is silently lossy. Cost of persisting both fields: **+11.75%** of the whole corpus (mean +2.0 KB per tool row, p99 +30 KB, worst session +112 KB); the 200 000-char cap is never reached today (max observed result 32 184 chars). **So: pass the resolved session cwd to both formatters at all four assignment sites, AND persist `rawToolInput`/`rawToolResult` beside them.** The alternative (raw pair only) pays the same storage and keeps showing `./Users/…` in every Read/Write card. | decided |
| **D5** | **DECIDED 2026-08-20 — sweep it with the mechanism we already have; the switch path deletes nothing.** Measured: **nothing in this repo sweeps `claude-config`** — `retention-sweep.ts` is an explicit allowlist that does not name it, and `deleteSession` removes only `sessions/<ws>/<id>`. The leak already exists independently of this plan: **37 of 165** vendor project dirs are orphaned right now (1 236 KiB), and the tree grew to 217 files / 8 552 KiB in five days. T2 mints a **new** sdkSessionId, so each switch strands the previous transcript rather than overwriting it. **So: add `claude-config/projects` as a new path class in the existing age-based `retention-sweep` allowlist under the same `cleanupPeriodDays` cutoff.** Rejected alternative: unlinking the previous transcript at the switch — it means deleting inside a vendor-owned directory, which contradicts the recorded mirror precedent ("the host never deletes from a mirror on its sweep"), and it would not touch the 37 orphans. | decided |
| **D6** | **DECIDED 2026-08-20 — text reference only, and say so in the copy.** Measured: 2 attachment rows in 677 sessions, so this is moot at corpus scale but a real correctness fork. No base64 is persisted; `storedPath` is stored as `{{SESSION_PATH}}` and expanded on read; and **217 vendor transcripts contain zero image blocks and zero base64**, so we have no evidence the SDK round-trips an image block written by us. **So: emit `[Attached file: <name>]` + `[Stored at: <resolved path>]`, with a visible could-not-load marker when the file is gone** — the exact text block our own agent already sends every turn, reusing the existing realpath + containment + stale-handle resolver. Zero new failure modes. **The loss is real and must be stated in P3's `native` copy**: our own code records that the Read tool cannot open an image, so the model sees a path it cannot look at. Rehydration stays available as a later row if anyone asks for vision across a switch. | decided |
| **D7** | **DECIDED 2026-08-20 — skip the rebuild when the target already holds an anchor.** Today's `anchor-and-handoff` stands: the SDK resumes its own real transcript and the trimmed text tail carries what it missed. Rejected alternative ("always rebuild", omnigent's answer): it makes our store the single source of truth, but what it destroys is **not recoverable** — the vendor's own native records for that session — and it strands a file per switch. **Consequence to state honestly in P3's copy:** for a RETURNING Claude leg the plan delivers nothing new, so the modal must not promise "full history" on a switch whose target is already anchored. That is a third tier for P3's plan value, not a footnote. | decided |
| **D8** | **DECIDED 2026-08-20 — leave `classifyRuntimeSwitch` alone.** Claude Pro/Max ↔ Claude Code (Nessy Gateway) stays `connection-same-runtime`, and T2's rebuild fires on `providerType`, so it covers both cards without touching the classifier. No behaviour change and no new confirmation modal for a switch that is silent about context today. **PRV-N25 stays open exactly as the closed plan states it** — one anchor slot serves both cards, so a transcript recorded against `api.anthropic.com` can be handed to the gateway adapter — and T2's live gateway day answers it for free, because that run already switches a Pi session onto `claude-gateway`. Record the answer back into the closed plan's open-questions list. | decided |
| **D9** | **DECIDED 2026-08-20 — retire the reservation; the text tail is the overflow answer.** The arithmetic settles it: `transferredSessionSummary`'s budget is 500 chars per message and 12 000 total, against the tail's 24 × 1200 = **28 800** — so escalating on overflow would **reduce** fidelity while adding a metered gateway call and a whole backend construction to the switch path. Record in the closed plan's decision log that the escalation was considered and declined, with this arithmetic, so it stops reading as pending work. | decided |
| **D10** | **DECIDED 2026-08-20 — mark it with the field that already exists, and state the limit.** Stamp `runtime` on the rows a rebuild synthesizes, so a later reader can tell a carried turn from a native one — which is what makes an incident like "the model quoted a file it never read" diagnosable. **Two limits to write down rather than discover:** `Message.runtime` is absent on **4 533 of 5 332** rows, so the marker works forward only and never retroactively; and it has exactly **one** production reader today (the handoff trim), so nothing renders it. R1 item 3 is therefore closed as decided, not promoted to a gate — and R1 item 2 remains the user-facing answer. | decided |

### Confirmed by the audit, no action

`bun test packages/server-core` 1739 pass / 0 fail; the two switch suites 56 pass /
0 fail; `typecheck:all` exit 0; both i18n lints green. Every omnigent citation
re-verified at `b08eb50`. Every P.2 corpus number re-derived independently. The
two STRUCTURAL rows exist at `runtime-capability-gaps.md:34` and `:109`. Six of the
13 rows (P1, P2, P3, T3, T3b, T4) are 100% agent-completable once A1–A6 are
written in; T5 needs one command named. **None of the eight startable rows makes
tool traffic cross a switch** — that lives entirely behind G3, G5 and G6.

## P.7 Provenance

Written 2026-08-20 from a read of `omnigent-ai/omnigent` at `b08eb50` (v0.10.0,
Apache-2.0). Nessy anchors verified on **`update/runtime-switch` at `bbd48f967`**,
version 1.30.1.

The costing pass was challenged once and then verified by three further independent
passes (anchors / executability / refutation, 59 findings). Everything above
reflects those corrections, of which the load-bearing ones were: the two facts in
P.2; the tilde-abbreviated `sdkCwd` (169 sessions match expanded, 0 raw); T1's real
scope (split into T1a/T1b) and the fact that its original gate could not fail;
Codex model-visibility settled **offline**, which removes a packaged build from T1a;
the four P1 assignment sites; the three ways T3 is not a superset; the
`<turn_aborted>` side effect; the loader's timestamp-fallback and cycle-guard arms,
which killed the "walk it like the binary does" fail-safe; the compaction records
that must not be emitted; `SessionManager.ts` as a five-task serial lane; and G5.

Two verifier claims were themselves checked and **rejected**: that the closed
runtime-switching plan landed "20 of 21" tasks (its Tracker holds 20 rows — 19 `✅`
and one `➡️ MOVED`), and that `scripts/cdp/lib/runtime-switch.ts`'s `runtimeOf`
carries a "keep in step by hand" comment (it does not; `MessageRuntimeProvider`
does).
