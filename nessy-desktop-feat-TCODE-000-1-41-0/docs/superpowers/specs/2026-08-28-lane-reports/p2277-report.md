# P2.277 — a malformed hook `if` rule fails open and says nothing

**Status:** DONE. **SHA:** `0d0f4da00`. **Base SHA (recorded before starting):** `32631ac41f758381b3d08bca54f59d128394c215`.

**Verdict on the first question: the fail-open is DELIBERATE.** This row is therefore
**surfacing only** — the hook keeps running, and the direction is unchanged.

---

## 1. The premise, re-measured

Confirmed exactly as the row states, including the line number, which is unusual for this
plan.

- Producer: `packages/shared/src/agent/pi-harness/claude-permission-rules.ts:240`
  `evaluateClaudeHookIfFilter` returns `{ run: true, unparseableRule: true }` from **two**
  branches — `:242` (the rule string will not parse at all) and `:271` (the rule parses but
  the DSL cannot compile it, `evaluation.match?.ruleId === 'invalid-policy'`).
- Sole production caller: `packages/shared/src/plugins/hooks-automation.ts:713`, verbatim at
  base:
  ```ts
  if (matcher.ifRule && !hookIfFilterRuns(matcher, event, input, options).run) continue;
  ```
  `.run` is read; `.unparseableRule` is dropped on the floor. `rg` over `packages/` finds
  `hookIfFilterRuns` at exactly two sites — its definition (`:1198`) and this call.
- Readers of `unparseableRule` anywhere in production: **zero**. The only reads in the tree
  were in one test (`agent/__tests__/claude-project-settings-permissions.test.ts:475-483`).
  This matches the standing inert-contracts entry
  (`docs/superpowers/specs/2026-07-29-inert-contracts.md:108`: "Seven write sites, zero
  readers anywhere including tests" — the tests have since gained reads, production has not).

There was also a **latent corroboration already in the test file**: the existing test was
named `a garbage if rule fails open with a diagnostic and the hook always runs` and its body
asserted only `matchedCount` and `state.invoked`. The title promised a diagnostic the code
did not emit. That is the defect, pinned by its own name for a year.

## 2. Is the fail-open deliberate? — four independent lines of evidence, all agreeing

**(a) The code says so, in a docblock written for exactly this question.**
`claude-permission-rules.ts:220-238` opens `FAIL-OPEN by documented contract` and quotes the
doc sentence verbatim before saying `An unparseable rule, an inert rule form, or an
unparseable Bash command all run the hook.`

**(b) The original plan paired the fail-open with a diagnostic, and only the diagnostic was
lost.** `docs/superpowers/plans/2026-07-26-claude-permission-rules.md:178`:

> **Step 2:** Implement, replacing the `if_deferred` diagnostic path. Keep an info diagnostic
> only for the garbage case (`plugin.hooks.if_unparseable_fail_open`).

That registration-time report was retired with the V1 bridge in F4 (recorded in the test
file's own comment at `hooks-automation.test.ts:1340-1343`) and **nothing replaced it**. So the
direction was always intended to be open; the missing half is the operator diagnostic. That
settles the row: surfacing only.

**(c) The upstream contract.** Category **(b)** — an upstream Claude page governs this.
`hooks.md#hook-handler-fields` (anchor verified by `curl`ing
`https://code.claude.com/docs/en/hooks.md` without `.md` and grepping `id="…"`; the `if`
row and the Bash matching table live under that h4, with an explicit
`<span id="bash-if-matching" />` inside it). Verbatim, the load-bearing sentence:

> The filter also fails open, running your hook regardless of pattern, when the Bash command
> can't be parsed. Because the `if` filter is best-effort, use the [permission system](/docs/en/permissions) rather than a hook to enforce a hard allow or deny.

And the `if` field's own row, verbatim:

> Permission rule syntax to filter when this hook runs, such as `"Bash(git *)"` or
> `"Edit(*.ts)"`. The hook command only runs if the tool call matches the pattern. […] Only
> evaluated on tool events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
> `PermissionRequest`, and `PermissionDenied`. On other events, a hook with `if` set never
> runs. Uses the same syntax as [permission rules](/docs/en/permissions)

**THE DOCS ARE PARTLY SILENT, AND THAT IS ITSELF A FINDING.** Read narrowly, what hooks.md
fixes is the unparseable Bash **command**. It says nothing anywhere about an `if` **rule**
that will not parse. I searched the page for `fails open`/`fail open`/`best-effort` and the
only two hits are the sentence above and an unrelated `UserPromptSubmit` callback-timeout
note at line 1284. Codex's `learn.chatgpt.com/docs/hooks.md` is not in play — its four hook
shapes carry no `if` condition at all, so no Codex contract governs this.

So the direction for the *rule*-parse case is **ours**. Our code's docblock over-claimed by
implying the quoted sentence covered it; I corrected that in this commit rather than leave a
future reader trusting a citation that does not reach.

**(d) Making it fail closed would be actively dangerous, on the exact coupling the brief
warned about.** The `:271` branch returns `unparseableRule: true` for a rule that is
perfectly well-formed but source-anchored (`Edit(/scripts/**)`) with no root to resolve
against — this is the `invalid-policy` id, and it is the same coupling P2.270 measured
(`permission-dsl.ts:898`; plan row P2.270 note: "a naive drop **silently stops hooks
running**"). A settings- or manifest-declared hook with no `pluginRuntime.rootPath` reaches
it on ordinary configs — the test file already pins that registration case as `rootless-if`.
Flipping the direction would silently disable those hooks. Combined with the doc's own
"best-effort … use the permission system … to enforce a hard allow or deny", fail-open is
right.

**Argued, not applied mechanically** (per the brief): this plan's "ambiguity resolves toward
the restrictive answer" rule does not decide here, because *restrictive* is ambiguous when
the subject is a hook. Dropping the hook is restrictive about hook execution but permissive
about whatever the hook was guarding — a `PreToolUse` deny gate that stops running is a
**wider** posture, not a narrower one. The doc explicitly refuses to let an `if` filter be a
security control, which removes the only reading under which closing would be the safe side.

## 3. What changed

Surfacing only. Three files, `+172 −1`.

1. **`packages/shared/src/plugins/hooks-automation.ts`** — `:711` the call site now keeps
   both halves of the result: it still `continue`s on `!run`, and carries `unparseableRule`
   forward to `reportUnparseableIfRule` after `matchedCount++`/`hookName`. New helper
   `reportUnparseableIfRule` pushes a `HookErrorNotice` onto the existing `hookErrors` array.
   - **Why `hookErrors`:** it is the existing operator channel and needs **no type change
     outside my zone** (`AgentEventExecutionResult.hookErrors` already exists). It is
     consumed by `SessionManager.reportHookErrors`
     (`packages/server-core/src/sessions/SessionManager.ts:7171`), which writes `detail` to
     `sessionLog.warn` and `summary` into the transcript as an `info`/`warning` message with
     `errorCode: 'hook_error'`. Precedent for a *non-execution* fault on this channel already
     exists in the same function: `command-hook-execution-authority-unavailable` (`:952`),
     pushed for a host-configuration problem that "left no trace anywhere".
   - The notice **quotes the offending rule** (P2.270's "the diagnostic names the offending
     rule") and names the hook and event.
   - **Deduplicated per matcher object** via a module-level `WeakSet`. This is a deliberate
     design call and the one part of the change that is not forced: a fail-open filter fires
     on *every* tool call across the five tool events, so an un-deduplicated notice would put
     a warning bubble in the transcript beside each one and the operator would stop reading
     the channel. Keyed on the matcher object, which the component-hook layers
     (`capabilities/component-hooks.ts:139-147`) hand back unchanged per dispatch, so the key
     is **per config load, not per process** — a reload, a second session and a second
     workspace each get their own notice, nothing is retained after the config is dropped,
     and no cross-session global state is introduced. If some future path ever rebuilds
     matchers per dispatch, this degrades to the un-deduplicated behaviour: noisier, never
     silent.
2. **`packages/shared/src/agent/pi-harness/claude-permission-rules.ts`** — comment only. The
   docblock now says to read the quoted doc sentence **narrowly** (it covers the Bash command,
   not the rule), records why the rule case is fail-open anyway, names the `invalid-policy`
   coupling, and states the invariant a future edit must not break: every
   `unparseableRule: true` return stays paired with `run: true`, because the consumer reports
   *after* deciding to run. No behaviour change.
3. **`packages/shared/src/plugins/__tests__/hooks-automation.test.ts`** — the existing garbage
   test now asserts the diagnostic its title always promised, plus three new tests (below).

**Nothing outside the zone was touched.** No new i18n keys (the notice text goes through the
same untranslated `hookErrors` path every other hook error uses).

## 4. Tests — and the re-break

Added/changed 4 tests in the `hook if filter evaluation (R1, hooks.md)` block:

| Test | Invariant |
| --- | --- |
| `a garbage if rule fails open with a diagnostic and the hook always runs` (updated) | positive: `'???'` → hook still runs **and** one notice naming hook, event, and the quoted rule |
| `reports the source-anchored fail-open too, and still runs the hook` (new) | the **second** producer branch — `Edit(/scripts/**)` with no root → `invalid-policy`; the P2.270-coupled path |
| `says nothing when the if rule parses, whether it matches or not` (new) | negative + boundary: a compiled rule is silent on match, on no-match, **and** on an unparseable Bash *command* (the one fail-open the docs do spell out, which is not a rule fault) |
| `reports an unparseable if rule once per matcher, not once per tool call` (new) | boundary: 3 dispatches → 1 notice, `invoked === 3` (dedupe never suppresses the hook); a fresh config load gets its own notice |

**Real path, no double of the unit under test.** These call the production
`executePluginHookAutomations` with the production `buildPluginHookAutomations` config
builder and the real `evaluateClaudeHookIfFilter`; `countingRunner` doubles only the *command
runner*, and the value under test (`hookErrors`) is read off the real result object.

### Gates — with proof of work, not exit statuses

| Gate | Result |
| --- | --- |
| `bun scripts/bun-test-lock.ts run --label P2.277 -- bun test packages/shared/src/plugins/__tests__/hooks-automation.test.ts` | **`82 pass / 1 skip / 0 fail / 190 expect() calls`, `Ran 83 tests across 1 file. [7.58s]`** |
| Focused: same, `-t "hook if filter evaluation"` | **`9 pass / 0 fail / 46 expect() calls`, `Ran 9 tests` [32.98s]** |
| **Re-break vs base blob `32631ac41…`** | **`6 pass / 3 fail / 39 expect() calls`** — see below |
| `bun run typecheck:shared` | exit 0, **no diagnostics emitted** |
| `bunx eslint …` (from `packages/shared`, 3 changed files) | **3 result records, `errors=0 warnings=0` each** |
| `git diff --check` on the 3 files | exit 0, no output |
| Full repo suite | **NOT RUN** — out of budget per the brief ("No full repo suite"). |

**Re-break method and result.** I restored *only* `hooks-automation.ts` from the absolute base
SHA via `git show 32631ac41…:<path> > <path>` — **never** `git checkout <sha> -- <path>`, so
the index was never rewritten and no other lane's staged work was disturbed — keeping the new
tests in place, and re-ran. Three of the four new/changed tests failed, each on the
`hookErrors` assertion, each in **under 1 ms** (0.66 / 0.63 / 0.57 ms — real failures, an
order of magnitude under the 3.3 s real-vs-load-artefact threshold):

- `a garbage if rule fails open with a diagnostic and the hook always runs` — `Received value
  does not have a length property: undefined`
- `reports the source-anchored fail-open too, and still runs the hook`
- `reports an unparseable if rule once per matcher, not once per tool call`

The fourth (`says nothing when the if rule parses…`) correctly **passes at base** — it is the
negative control and must be green in both states. Working copy restored afterwards and
verified by md5 (`d950cb9e178bd8add26f7e5430c94dcc`), which also matches the committed blob.

### An earlier run that was a load artefact, recorded for honesty

My first full-file run reported `79 pass / 3 fail` with failures at **11118 ms, 5002 ms and
17298 ms**, all timeouts, none touching `if` rules, and the file took **238 s** instead of
7.6 s. That is the documented five-lane contention signature (real failures under 3.3 s, load
artefacts at 10 s or more). The clean re-run above, with the same command, gave
`82 pass / 0 fail` in 7.58 s. None of the three appear in
`docs/superpowers/specs/2026-07-29-known-failing-tests.md`; I did not add them, since they do
not reproduce.

### One transient typecheck error that was not mine

`bun run typecheck:shared` first exited 2 with a single `TS2741` in
`packages/shared/src/agent/__tests__/session-command-seam.test.ts:471` — a file **another lane
is editing uncommitted** (`+156` lines vs base) and which this lane never touched. On re-run
minutes later it was gone (that lane had added the missing `activeSessionId`). Recorded rather
than silently re-run: it is also the positive control proving `typecheck:shared` really does
report and fail on errors in this tree, which is what makes the subsequent silent exit-0
meaningful.

## 5. Concerns and open items for the controller

1. **The dedupe is a judgement call, not a measurement.** Reporting once per matcher rather
   than once per tool call is the right trade in my view (an unread channel surfaces nothing),
   but if the controller would rather have the notice every time, deleting the `WeakSet` guard
   in `reportUnparseableIfRule` is a two-line change and the dedupe test names the behaviour
   explicitly.
2. **The transcript wording is untranslated**, consistent with every other `hookErrors`
   notice. If hook errors are ever i18n'd, this string joins them.
3. **Registration-time surfacing was NOT restored.** The retired
   `plugin.hooks.if_unparseable_fail_open` fired once at load, before any tool call; this
   restores an execution-time equivalent instead, because the registration path
   (`capabilities/runtime-automations.ts`, the format adapters) is outside my zone. The
   practical difference: an operator whose broken hook never fires on a tool event will still
   hear nothing. Worth a row if the controller wants load-time validation of `ifRule`.
   **There is currently no validation of `ifRule` at any registration site** — I checked all
   of them (`plugins/schema.ts:802`, `format-adapters/claude.ts:1477`,
   `capabilities/runtime-automations.ts:305-318`, `capabilities/resolver.ts:1470`); the string
   is passed through untouched from manifest to evaluator.
4. **A doc-citation correction worth recording on the plan.** `hooks.md` documents the
   fail-open for an unparseable **Bash command** only, and is silent on an unparseable
   **rule**. Anything in this tree that cites the quoted sentence as covering the rule case is
   over-citing. I fixed the one instance I own (the `evaluateClaudeHookIfFilter` docblock);
   `capabilities/runtime-automations.ts:317` carries a similar shorthand ("fail-open on an
   unparseable rule or command (if_unparseable_fail_open)") and is outside my zone.
5. **`ClaudeHookIfResult.unparseableRule` is no longer inert.** Two specs assert it has zero
   readers — `docs/superpowers/specs/2026-07-29-inert-contracts.md:108` and
   `…/2026-07-29-inert-worklist.md:79` (and unit U-D in
   `docs/superpowers/plans/2026-07-29-inert-units-cd.md`). Those statements are now stale.
   Both are outside my zone, so I did not edit them.
