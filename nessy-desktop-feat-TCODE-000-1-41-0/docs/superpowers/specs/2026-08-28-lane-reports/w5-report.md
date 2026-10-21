# W5 — P2.328, P2.272, P2.302

**Absolute base SHA recorded before starting: `05733c4ad7c8f4b68dfbdf8e89c44191a9ea7ca2`.**
(Recorded first, per the method — several lanes commit to this branch and `HEAD~1` is
meaningless here. Every re-break below is against that SHA's exact bytes.)

Commits:

| Row | Commit | Files |
| --- | --- | --- |
| P2.328 | `c9b06f72f` — `docs(capabilities): a KNOWN GAP that is closed reads as a live warning` | 1 |
| P2.272 + P2.302 | `d75340b9c` — `fix(sessions): a child admitted with no tools spent a turn and said nothing` | 3 |

`d75340b9c` was built through an **isolated index** because a second lane is editing
`SessionManager.ts` concurrently — see the end of §5.

---

## 1. P2.328 — the three claims, and the premise correction

### All three claims confirmed FALSE, each against the code rather than the row

| Claim in the `KNOWN GAP 2` paragraph | Measured today |
| --- | --- |
| "`PiChildRestrictionsV1.tools` is required so the route cannot express 'inherit' by omission" | `child-session-port.ts:52` reads **`tools?: string[]`**, with a doc block stating absence = inherit |
| "`SessionManager.ts`'s plugin-hook agent spawn route builds its child's ceiling as `definition.tools ? [...definition.tools] : []` … NOT fixed by this row" | `SessionManager.ts:6667` reads `… : undefined` and `:6682` spreads conditionally — `...(declaredTools ? { tools: declaredTools } : {})` |
| "the route is UNTESTED for that shape: every fixture in `SessionManager.plugin-hook-runners.test.ts` declares `tools`" | Two fixtures pin the shapes APART (`:565` omitted-key, `:611` authored-empty), plus one real-port test in `SessionManager.orchestration.test.ts:721` |

### Premise correction — **no documentation page repeats the three claims. Zero, not two.**

The row and the brief both say "Two documentation pages repeat the same three claims."
Measured, byte-honest, with a positive control:

```
$ git grep -n --untracked -F "is required so the route" -- . ':!.codegraph'
packages/shared/src/capabilities/runtime-skill-content.ts:1606
$ git grep -n --untracked -F "route is UNTESTED" -- . ':!.codegraph'
docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:1461   ← P2.328's own row text
packages/shared/src/capabilities/runtime-skill-content.ts:1613
$ git grep -n --untracked -F "TWO KNOWN GAPS, both owned by" -- . ':!.codegraph'   ← POSITIVE CONTROL
packages/shared/src/capabilities/runtime-skill-content.ts:1588
```

Same for `NOT fixed by this row`, `turns it into the empty`, `admitted able to call nothing`,
`cannot express "inherit"`, `express "inherit" by omission`. Also swept every `.md` for
`PiChildRestrictionsV1` (outside the tracker: **7 hits, none asserting requiredness**) and for
`tools( is| was) (a )?required`.

The two pages P2.301's report named are **not stale**:

- `docs/architecture/extension-first-pi-agent-runtime.md:437` — "Both thread onto
  `PiChildRestrictionsV1` (additive, omit-when-default) via the spawner." The subject is
  `maxTurns`/`permissionMode`, not `tools`, and the sentence is still true.
- `docs/superpowers/plans/2026-07-29-fork-subagents.md:190` — "`PiChildRestrictionsV1` carries
  `prompt`, `model`, `tools`, …". A field LIST. It still carries `tools`; it never said
  required. It is also a historical plan's survey section.

So the correct action was to correct **one** site, not three, and I did not edit the two pages
— editing a true sentence to look like it was corrected would be worse than leaving it.

### What DOES restate the claims, and cannot be fixed

1. **`6f51646d2`'s commit message**, paragraph at lines 47–55: "no surface tells a user their
   child was admitted tool-less, and `SessionManager`'s plugin-hook spawn route writes
   `definition.tools ? [...] : []` … The shape is untested: every fixture in
   SessionManager.plugin-hook-runners.test.ts declares `tools`." Immutable history; no action.
   **Methodological note worth keeping:** the commit message never uses the string
   `KNOWN GAP`, so a phrase-grep for the label misses it entirely. I found it only by
   following the tracker's pointer. (And the tracker's own wording — "recorded as 'KNOWN GAP
   2' in the commit message" — is imprecise: the content is there, the label is not.)
2. **`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`** rows P2.202 / P2.273 /
   P2.328. Off-limits to me by the standing rule, and harmless: P2.273's row already carries
   its own `CLOSED` and the correction inline.

### The edit

`packages/shared/src/capabilities/runtime-skill-content.ts` — the `KNOWN GAP 2` paragraph is
**rewritten as a closed note, not deleted**. Rationale, stated in the comment itself: a
deleted marker invites rediscovery just as a stale one invites a re-fix. It now names the
three claims, says what each is today, and keeps the one conclusion that is still binding —
the fix belonged at the producer, and a refusal at admission would re-break P2.202's contract.
The header went `TWO KNOWN GAPS` → `ONE KNOWN GAP` in that commit, and → `NO KNOWN GAPS
REMAIN` in the second (gap 1 is what P2.272/P2.302 closed).

---

## 2. P2.272 + P2.302 — the premises, measured

### The three routes converge on ONE seam, which is what makes "every route" achievable

`createPiChildSessionPort`'s `start` (`SessionManager.ts:13875`) is the single admission seam
for every Pi child: the delegating port (`createPiDelegatingChildSessionPort`) routes
`start`/`resume`/`steer` through it for the current turn and for retained background
authorities alike, and the spawner's model-driven spawn reaches the host through the same
child-session protocol. So the surfacing is derived **once, at the end of that block, from the
child's final pool** — not bolted onto each producer. A fifth producer added above still
surfaces; it just surfaces with a less precise cause.

### Reproduction, before any change (the failing test IS the reproduction)

```
(fail) SessionManager Pi child orchestration composition > records a notice, not a refusal,
       on every route that admits a child with an empty tool pool [12.89ms]
  expect(received).toMatchObject(expected)
  -   "code": "agent_admitted_without_tools"
  +   "code": "permission_allowed"
      "outcome": "success",
      "semanticId": "agent-admission",
 0 pass  1 fail  1 expect() calls   Ran 1 test across 1 file. [16.82s]
```

A child admitted with `tools: []` produced an ordinary `permission_allowed` / `success` and
nothing else. That is P2.272's "nothing says so" and P2.302's "nothing records that anything
happened at all", reproduced on the real port rather than inferred.

### One precision correction to P2.302's wording

P2.302 says the model route and the skill-narrowing route "write no receipt at all". Measured,
that is not quite right and the distinction matters for anyone reading the row later: **every**
route writes an `agent-admission` receipt at `:14389`. What none of them wrote was anything
that distinguished an empty pool — the receipt said `permission_allowed` / `success`, which is
a TRUE statement about the admission and a silent one about the child. The row's *point*
stands exactly as written; only "no receipt" should read "no receipt that says anything".

### Route inventory as measured (four, not three)

| Cause | Producer | Reachable how |
| --- | --- | --- |
| `request` | the caller sent `[]` | `spawner.ts` `allowedTools` — `disallowedTools` removes every entry; or an authored `tools: []` |
| `parent-ceiling` | `parentTools` is itself `[]` | a parent that was admitted empty |
| `parent-intersection` | request ∩ parent = ∅ | disjoint lists, both non-empty |
| `skill-disallowed-tools` | the host-side chokepoint at `:14208` | an invoked skill's `disallowed-tools` removes the last entry |

The fourth is a route the rows did not separate out; all four are exercised by the test.

---

## 3. Documentation — category (b), and the anchor was verified against the RENDERED page

`curl`ed WITHOUT `.md` and grepped for `id="…"`, 2026-08-28, `status=200`:

```
$ curl -s https://code.claude.com/docs/en/errors | grep -o 'id="[^"]*zero-tools[^"]*"'
id="agent-would-be-spawned-with-zero-tools"
```

`errors.md#agent-would-be-spawned-with-zero-tools`, verbatim, the sentence that forbids a
refusal and names two of the four causes:

> "Omitting the `tools` field never triggers this refusal. If you leave the `tools` list
> empty, or `disallowedTools` removes every entry in it, Claude Code also skips the refusal
> and launches the subagent without tools."

And, from the same section, the sentence that describes exactly the state a silent launch
leaves us in — upstream's own account of its pre-refusal behaviour:

> "Before v2.1.208, the subagent launched with no tools and could return an empty or confusing
> result."

Both are quoted in the code. The page's refusal is for a DIFFERENT cause — entries that fail
to RESOLVE — which we do not implement at all.

**The split, stated explicitly per the tagging rule:** the ADMISSION behaviour (launch, never
refuse) is `[doc:claude]`, and since Pi is built to Claude's docs with no separate contract it
is a double gap. The SURFACE — a transcript notice and a receipt code — is `[doc:none]`: no
upstream page decides how a host reports this, and upstream reports nothing at all.

**I did not implement a refusal, and nothing I measured argued for one.** The direction in the
brief was already the direction the measurement supports.

---

## 4. What landed

### `packages/server-core/src/sessions/SessionManager.ts`

1. **`appendEmptyChildToolPoolNotice`** (new private method, placed beside its structural
   twin `appendMaxBudgetUsdChildNotice`): a durable transcript row (`role: 'info'`,
   `infoLevel: 'warning'`, `errorCode: 'agent_empty_tool_pool'`) **and** a live `info` event.
   Both, deliberately: a diagnostic that only reaches the wire is gone after a reload, and one
   that only reaches the transcript is invisible while the turn runs. Its doc block carries
   both citations and states plainly that re-adding a throw here would re-break P2.202.
   Prose is composed in English inline, exactly as its neighbour does — **no new i18n key**,
   so `lint:i18n:parity`/`sorted` are untouched by this change.
2. **`emptyToolPoolCause`**, derived once after the final `tools` binding. `undefined` is
   explicitly NOT folded in: an absent ceiling is "inherit every tool", the opposite of an
   empty pool. Order is producer-order, narrowest first; the comment records why the residual
   case is the skill chokepoint (`narrowRuntimeSkillTools` only canonicalises and cannot empty
   a non-empty list; the `memory:` grant only ever adds) and why `tools === []` guarantees
   `inheritedTools` is defined.
3. **The admission receipt's `code`**: an allowed admission that hands the child nothing now
   reads `agent_admitted_without_tools` instead of `permission_allowed`. Nothing is lost —
   `permission_allowed` is redundant with `outcome: 'success'` and is the weaker of the two
   statements. `code` is a free-form `string?` on `PiHarnessExecutionReceiptSummaryV1` and its
   only reader is `execution-observability.ts:140`, which passes it through; no test asserted
   the allowed value (three assert `semanticId`+`outcome` only).
4. **The notice call sits BELOW the deny throw.** A denied child spent no turn and took no
   lease, and the denial is its own louder surface.

### `packages/shared/src/capabilities/runtime-skill-content.ts`

`KNOWN GAP 1` ("NO SURFACE") rewritten as closed, naming the method that closed it, the four
causes it distinguishes, and — because this is the paragraph most at risk of being "fixed"
backwards — an explicit "do not fix it by restoring a refusal". The one fact the paragraph
always carried is kept: a runtime agent rarely lands here at all, because
`buildPiRuntimeAgentDefinitions` unions the five always-available task tools into every
child's pool.

### `packages/server-core/src/sessions/SessionManager.orchestration.test.ts`

One test, six arms, driving the **real** port end to end (not a recording double — the double
is precisely what cannot see the four sites the port itself reads the ceiling at):
four routes, one control with a non-empty pool (`permission_allowed`, zero rows), and one
control for the ORDERING claim (a denied admission: `permission_denied`, zero rows).

---

## 5. Gates — each with proof of work, none read from an exit status

Every gate was redirected to a file and read whole. Nothing was piped to `head`/`tail` before
its size was known, and no gate below is recorded from an exit status alone.

| Gate | Result |
| --- | --- |
| Reproduction, before any change | **`0 pass 1 fail 1 expect() calls — Ran 1 test across 1 file. [16.82s]`**, failure at **12.89 ms** (real-failure mode, not the ≥10 s load-artefact mode). Diff: `- "code": "agent_admitted_without_tools"` / `+ "code": "permission_allowed"` |
| Zone suite, final — `SessionManager.orchestration` + `.plugin-hook-runners` + `.child-model-fallback` | **`63 pass  0 fail  307 expect() calls — Ran 63 tests across 3 files. [64.12s]`** |
| Zone suite + `.process-supervisor` (the fourth file that reaches this seam) | **`104 pass  1 fail  537 expect() calls — Ran 105 tests across 4 files. [58.66s]`**. The 1 is the load artefact in §6.10 |
| `.process-supervisor` in isolation (the artefact's control) | **`42 pass  0 fail — Ran 42 tests across 1 file. [5.28s]`** |
| `cd packages/server-core && bun run typecheck` | **exit 0, and the whole output was the echoed `$ tsc --noEmit`** — zero diagnostic lines. Run three times across the work (initial, after the deny arm, final) |
| `cd packages/shared && npx tsc --noEmit` | **exit 0, `grep -c "error TS"` = 0** |
| `npx eslint --format json` (never `--format unix`), read via `errorCount` | `runtime-skill-content.ts` **0/0**, `SessionManager.ts` **0/0**, `SessionManager.orchestration.test.ts` **0/0** — each row carried its own `filePath`, which is the proof the files were processed rather than a zero-byte pass |
| `git diff --check` on all three paths | clean, exit 0 |
| i18n `lint:i18n:parity` / `lint:i18n:sorted` | **NOT RUN, and not needed:** no locale key was added or touched. The notice composes English inline, exactly as `appendMaxBudgetUsdChildNotice` does; `git diff` touches no file under `src/i18n/` |
| full repo `typecheck:all` / root `bun test` / lint / builds / packaging / live-CDP | **NOT RUN** — verification-wave work, outside this row's budget, and the brief says no full repo suite |

### Prove-by-breaking — two hunks, broken and restored independently

Against the absolute base SHA recorded before starting. `A_BASE` is **byte-identical** to
`05733c4ad…:packages/server-core/src/sessions/SessionManager.ts:14400`, checked with
`git show` before mutating. Every mutation is a string replace asserted to hit **exactly
once** — never a file copy, so a concurrent lane's edit elsewhere in the file cannot be
clobbered.

| Arm | What was reverted | Result |
| --- | --- | --- |
| **A** | only the receipt `code` ternary → the base one-liner | dies at `:919`, `- "code": "agent_admitted_without_tools"` / `+ "code": "permission_allowed"`, **77.87 ms** |
| **B** | only the `appendEmptyChildToolPoolNotice` call | dies at `:922`, `toHaveLength` **Expected 1, Received 0**, **61.86 ms** |
| **C** | nothing (both restored) | **`1 pass  0 fail  16 expect() calls — Ran 1 test across 1 file. [23.04s]`** |

**Arm B is the one that matters most:** the test got *past* line 919 before dying at 922, so
the receipt assertion passed while the notice assertion failed. The two halves are therefore
observed on independent branches — **neither is vacuous**, and neither is riding on the other.

The file came back **md5-identical three times** (`5446103360460897801f98e56969373f` at start,
after A, after B), and `git diff -- SessionManager.ts | grep -c '^@@'` stayed at **1**
throughout — the other lane's hunk, and only that. Nothing of theirs was disturbed and
nothing of mine was lost.

### A zoning collision, and how the commit was built

**Another lane (P2.315) is editing `SessionManager.ts` concurrently**, although the dispatch
said that file is mine. Detected mid-run: the file's md5 changed while my re-break job was
still queued on the mutex, i.e. before my own script could have touched it. A fourth hunk had
appeared at `@@ -20253` — the workflow keyword trigger gaining a `provider` term — together
with a signature change in `packages/shared/src/workflows/workflow-keyword.ts`.

`git commit <pathspec>` takes the **working-tree** state, so a plain commit would have stolen
their hunk. So the commit was built through an **isolated index**, per the standing rule:

1. **The marker was checked ABSENT at HEAD first**, or the isolation check false-passes:
   `P2.315` → **0** at HEAD, `All three gates fail closed` → **0** at HEAD, and the positive
   control `P2.301` → **5** at HEAD. Working tree → **1**. So the marker discriminates.
2. Their one hunk was **reverse-applied** to the working-tree file (single string replace,
   `count == 1` asserted, and `THEIRS_OLD` asserted present in HEAD), with four of my own
   markers asserted present in the result.
3. **Independent confirmation the reverse-apply was byte-exact:** the resulting blob hashed to
   `d3a14b502…`, which is exactly the hash git had printed as the working-tree blob in a
   `git diff` header taken *before* their hunk landed. Two derivations, same 40-hex string.
4. `GIT_INDEX_FILE` → `read-tree HEAD` → three `update-index --cacheinfo` → `write-tree` →
   `commit-tree` → `update-ref` **with the old-value guard**
   (`0d7af52cd… → d75340b9ca98abc8b8a1b8e83193b15c9af65905`).
5. **Isolation proved on the COMMITTED blob**, not on the working tree: `P2.315` → 0,
   `All three gates fail closed` → 0, `provider: this.resolveManagedProvider(managed),` → 0;
   and completeness: `appendEmptyChildToolPoolNotice` → 1, `agent_admitted_without_tools` → 1,
   `agent_empty_tool_pool` → 1, `const emptyToolPoolCause` → 1.
6. The phantom revert the real index then showed was cleared with a **path-scoped**
   `git reset -- <the three paths>`. Afterwards the working tree differs from HEAD by exactly
   **one hunk** — theirs — so their work survived intact.
7. `git show --stat --oneline HEAD` → exactly my 3 files. `Co-Authored-By` → absent (grep
   exit 1).

**Ordering note, stated because it deviates from the usual sequence:** the commit was landed
**before** the re-break rather than after. With another lane holding the same file, leaving my
work uncommitted through a mutex wait of up to 30 minutes was the larger risk; the re-break
window afterwards is bounded to two test runs *inside* the acquired lock, and it is closed by
the md5 and hunk-count checks above. The re-break therefore proves the code exactly as
committed.

**Honest limit on the typechecks:** `bun run typecheck` ran against the working tree, which
contained the other lane's hunk alongside mine. The committed blob differs from that tree only
by the reverse of their hunk — i.e. it restores HEAD's own text at that call site, which was
green at HEAD. I did **not** typecheck the committed tree in isolation, because doing so would
have required touching `workflow-keyword.ts`, which is another lane's file, and the standing
rule is to stop rather than reach across.

---

## 6. Findings, each tagged and each with its kind

1. **`[doc:none]` — forgotten-vs-doc (against our OWN record, not an upstream page). FIXED in
   `c9b06f72f`.** `narrowRuntimeSkillTools`' `KNOWN GAP 2` asserted three things that
   `e5c85f138` made false. Confirmed one by one against the code, not taken from the row.

2. **`[doc:none]` — bug in a recorded finding. REFUTED, and this is the correction the row
   most needs.** "Two documentation pages repeat the same three claims" is wrong: **zero** do.
   Measured byte-honest with a positive control (§1). The two pages P2.301's report named
   mention `PiChildRestrictionsV1` in passing and assert nothing about requiredness — one is
   about `maxTurns`/`permissionMode`, the other is a field LIST in a historical plan. I did
   not edit them; correcting a true sentence to look corrected is worse than leaving it.

3. **`[doc:none]` — never-looked-at. NO ACTION POSSIBLE, worth recording as method.**
   `6f51646d2`'s commit message restates all three claims in different words and **never uses
   the string `KNOWN GAP`**. A label-grep cannot find it; I found it only by following the
   tracker's pointer. The tracker's own wording ("recorded as 'KNOWN GAP 2' in the commit
   message") is therefore imprecise — the content is there, the label is not. Immutable
   history; the lesson is that a "who else cites this gap" sweep must follow pointers, not
   only grep the marker.

4. **`[doc:claude]` — never-looked-at. FIXED.** A child admitted with an empty tool pool was
   unobservable on every route: it burned a model turn and, under an isolating policy, a
   worktree lease, and the only record was an ordinary `permission_allowed` / `success`.
   Reproduced on the real port before any change (§2). Now surfaced at the single admission
   seam, as a notice and never a refusal, per
   `errors.md#agent-would-be-spawned-with-zero-tools`. Double gap, because Pi is built to
   Claude's docs with no separate contract. **The SURFACE itself is `[doc:none]`** — no
   upstream page decides how a host reports this, and upstream reports nothing.

5. **`[doc:none]` — precision correction to P2.302's own wording.** "Neither writes a receipt"
   → every route writes an `agent-admission` receipt (`:14389`); what none of them wrote was
   anything that *distinguished* an empty pool. The row's conclusion is unaffected and its
   priority is if anything strengthened: the silence was in a receipt that already existed and
   read like an ordinary success, which is harder to notice than no receipt at all.

6. **`[doc:none]` — never-looked-at. A FOURTH route the rows did not name.** Besides the
   caller's own empty list and the skill chokepoint, the pool also empties when the request
   and the parent ceiling are **disjoint**, and when the parent's own ceiling is `[]`. Both
   are now surfaced with their own causes and both are exercised by the test.

7. **`[doc:none]` — never-looked-at. OPEN, maintenance, does NOT gate the close-out.** The
   rename `docs/superpowers/plans/2026-08-12-audit-defect-closure.md:90` asked for is still
   pending and its stated blocker is gone. `narrowRuntimeSkillTools` still carries the
   ceiling-era name, still takes an `invocations` parameter it discards (`void invocations;`,
   `runtime-skill-content.ts:1644`), and its doc block still says "which this commit is zoned
   out of" — a sentence about `6f51646d2` that reads, out of context, as a live constraint.
   Blast radius measured: **one product call site plus one import** (`SessionManager.ts:354`,
   `:14256`), one import and ten assertions in
   `packages/shared/src/capabilities/__tests__/runtime-skill-content.test.ts`, and three prose
   mentions elsewhere. I did **not** do it — it is outside these three rows and renaming an
   exported symbol during a five-lane wave is exactly the kind of file-level collision the
   standing rules warn about.

8. **`[doc:none]` — verdict, recorded so it is not re-asked.** `docs-site/` has **no** page
   describing the subagent tool ceiling or an empty pool, so there is nothing there to update
   for this row. Positive control on the same rig: the same `git grep -i` over `docs-site/`
   returns two unrelated hits, so the search works.

9. **`[doc:none]` — refuted before it was reported, recorded because the intuition is
   inverted.** I suspected the skill-denial chokepoint was case-blind: the child ceiling
   carries Pi-canonical names (`read`) while skill frontmatter carries Claude names (`Read`),
   and `matchesToolPattern`'s `globToRegex` is **case-sensitive** (no `i` flag). It is not a
   bug: `parseSkillToolEntry` canonicalises **both** sides through `canonicalTool`, which is
   why `collectSkillDisallowedTools` returns `['askuserquestion']` for
   `disallowed-tools: AskUserQuestion`. Measured before writing anything down. The route-4
   test arm exercises exactly this pair (`disallowed-tools: Read` removing a ceiling entry
   spelled `read`), so it is now pinned rather than merely believed.

10. **Load artefact, not a finding, but named rather than dropped.**
    `SessionManager Pi process owner > applies hook permission policy and records only
    redacted supervised receipt metadata` timed out at **6575.98 ms** against a 5000 ms limit
    in the four-file run, with five lanes live. In isolation the same file is
    **`42 pass 0 fail — Ran 42 tests across 1 file. [5.28s]`**. Same test, same verdict
    P2.301 recorded a day earlier. Not added to
    `docs/superpowers/specs/2026-07-29-known-failing-tests.md` — another lane owns it. **This
    is an attribution, and attributions can be wrong.**

---

## 7. Concerns

- **The receipt `code` swap REPLACES rather than augments.** An allowed admission with an
  empty pool reads `agent_admitted_without_tools` where it used to read `permission_allowed`.
  I judged this safe and better: `permission_allowed` is redundant with `outcome: 'success'`,
  `code` is a free-form `string?` on `PiHarnessExecutionReceiptSummaryV1`, its only reader
  (`execution-observability.ts:140`) passes it through, `projectPiExecutionReceiptTelemetry`
  does not read it at all, **no renderer reads receipts at all** (`git grep` over
  `apps/electron` + `packages/ui` for `piExecutionReceipts`/`ExecutionReceiptSummary`: zero
  hits), and no test asserted the allowed value. But receipts **are persisted**, so this is a
  value that appears in a persisted record. Old records keep the old string and re-parse
  unchanged (free-form), so no migration — but a reviewer may still prefer a second receipt
  to a replaced code, and that is a judgement call rather than a measurement.
- **Because no renderer reads receipts, the receipt half is a diagnostic-surface record
  (harness snapshot + persisted transcript), not something a user sees.** The user-facing half
  is the `role: 'info'` transcript row, which is the same channel
  `appendMaxBudgetUsdChildNotice` uses. Said plainly rather than letting "surfaced" imply more
  than it delivers.
- **No live/packaged evidence.** This changes host-side admission behaviour; a packaged-build
  smoke of an agent whose `disallowedTools` empties its pool would be the live confirmation
  and belongs to a verification wave. Not run, and named as such.
- **The notice needs `managed.messages`.** Real sessions always have it; four test files reach
  this seam and none produced an empty pool before today, so nothing pre-existing changes
  behaviour. Verified by enumerating them
  (`SessionManager.orchestration`, `.plugin-hook-runners`, `.child-model-fallback`,
  `.process-supervisor` — the only files referencing `createPiChildSessionPort` /
  `pluginAgentHookRunner`), and by checking that the `tools: []` fixtures in
  `fork-permission.test.ts` / `fork-parent-scope.test.ts` / `auth-retry-lifecycle.test.ts`
  never reach the admission block at all.
- **Prose is English inline, not an i18n key** — matching its neighbour exactly. If the owner
  wants this localised, it is a deliberate follow-up and it would also want
  `appendMaxBudgetUsdChildNotice` moved with it; doing one and not the other would be worse
  than doing neither.
- **The plan file was not touched.** The controller pins tracker rows.
- **A ZONING COLLISION, and it needs the controller rather than me.** The dispatch said
  `SessionManager.ts` and `runtime-skill-content.ts` are mine; lane w4 (P2.315) is editing
  `SessionManager.ts` at the same time, plus
  `packages/shared/src/workflows/workflow-keyword.ts`. I handled my side (isolated index,
  isolation proved on the committed blob), but **the hazard is symmetric and they cannot see
  it from their side**: when that lane commits `SessionManager.ts` by pathspec it will take
  the working-tree file, which now equals HEAD — my hunks included — so their commit is
  harmless *now* only because I committed first. Had the order been reversed my work would
  have landed silently inside their commit. Worth a word to that lane, and worth noting that
  the standing rule "zone parallel work by FILE; two units needing one file run in sequence"
  was not honoured for this file.
