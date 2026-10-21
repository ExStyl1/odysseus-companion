# P2.195 fix wave — report

**Status: DONE. All four items landed, including I3.** Commit `8cf4d726d549339374f41d2af50a03cfa52fd8bf`
on `feat/TCODE-000`, parent `d8c1cb450`.

`test(codex): the reachable sub-case a loosened usage guard walks straight through`

Two files, 76 insertions / 18 deletions:
`packages/shared/src/agent/__tests__/codex-cost-declaration.test.ts` (78 changed) and
`packages/shared/src/agent/codex-agent.ts` (16 changed — **comment only**, one line replaced and
fourteen added; the whole diff is a doc block).

---

## The measurement that mattered: the reviewer's premise, reproduced verbatim

The claim under test was "loosening that guard passes the file today". Reproduced exactly, on a rig
confirmed three ways, against the shipped test file taken from git rather than from my working tree:

| Variant | codex-agent.ts | test file | pass / fail / skip |
| --- | --- | --- | --- |
| **B** baseline | clean | **new** | **4 / 0 / 0** |
| **M1** `reportsCostUsd` override DELETED | mutated | new | **2 / 2 / 0** |
| **M2** `if (usage?.last)` → `if (usage)` | mutated | new | **3 / 1 / 0** |
| **M2pre** same mutation, **HEAD's** test file | mutated | shipped | **3 / 0 / 0** |
| **B2** restored | clean | new | **4 / 0 / 0** |

**M2pre is the finding: 3 pass, 0 fail.** Before this commit, loosening the guard killed nothing. After
it, M2 fails — and fails on the *wording*, which is the assertion that carries the meaning:

```
Expected to contain: "does not report spending"
Received: "Spending limit of $5 cannot be enforced here: this runtime reported no cost for the turn, …"
```

That is the whole point of the case. Under M2 the notice still *fires* and the count is still 1, so a
`toHaveLength(1)` test would have stayed green; only the discrimination between the permanent sentence
and the per-turn sentence catches it. Which is exactly why the sibling below it — the identical payload
**with** `.last`, asserting the per-turn wording — has to stay, and does (it is green in every variant
above except M1's total silence).

**M1 signature, matching the row's earlier RED verbatim:**

```
error: expect(received).toHaveLength(expected)
Expected length: 1
Received length: 0
```

fired twice — on shipped test 1 *and* on the new case, at their own `toHaveLength` lines. Test 2 (the
decorated turn) and the CONTROL stay green under M1, which reproduces the review's scope note: ordinary
decorated codex turns already warned pre-fix, and the window this row closes is the empty-tracker one.
Deleting the override is behaviourally identical to `return true` — `base-agent.ts:806` is
`protected reportsCostUsd(): boolean { return true; }`, and its own comment says so.

## Why the sub-case is reachable, in one line of mechanism

`handleNotification` feeds the tracker only inside `if (usage?.last)`, but the *next* statement,
`if (usage?.modelContextWindow)`, runs regardless. So a `thread/tokenUsage/updated` carrying a context
window and no breakdown **does** reach the agent, **does** update the context window, records no message
usage, and leaves `getLastMessageUsage()` null — `withCodexUsage` returns the bare `complete`,
`classifyEventCost` says `absent`, and only the runtime declaration produces a notice. Test 1's "no
notification at all" and this case arrive at the same hole down different paths, and the mutation that
distinguishes them is precisely the guard.

Under M2 the loosened guard calls `readCodexTokenCount(undefined, …)`, which returns `0` rather than
throwing (`event-adapter.ts:427-435`), so the tracker gets a **zeroed** snapshot and the turn looks
merely unpriced-this-time. That is why the mutation is silent rather than explosive, and why it needed a
wording assertion to catch.

## Line-number drift, recorded

The review cited `codex-agent.ts:958`. **Correct at the row's own commit** — at `c95e1ab46` the guard is
at `:958` exactly. It is `:1039` at the commit parent and `:1103` in the working tree with the other
lane's hunk applied. Three numbers, one sentence; the sentence is what I anchored on.

## I2 — P2.238 named at the assertion

The `toContain('reported no cost for the turn')` in test 2 now carries a comment saying the string is
**pinned, not endorsed**, that P2.238 calls it wrong, that the honest sentence for the identical runtime
sits in the test directly above it, and that its being green is not a reason to leave it alone. That is
the pointer the review said was missing: the intent lived only in the tracker.

## I3 — the claim no longer reads as impossibility

Landed, not deferred. Two changes, both in the override's doc block:

- The heading `codex establishes no USD figure at all` → `…no USD figure on the wire this agent reads`.
  Corrected in place rather than deleted — the complaint was that it misdirects, not that it is false.
- A new paragraph: `ThreadUsage.estimatedUsageUsdMicros` (`bigint | null`,
  `packages/codex-protocol/generated/v2/ThreadUsage.ts:6`) **is** a real USD figure, on
  `GetAccountTokenUsageResponse`, and **whoever wires that RPC must delete this override**, or the app
  keeps announcing it cannot price a runtime that by then can. P2.258 is named for the other half.

Verified independently rather than transcribed: `estimatedUsageUsdMicros` has **six** hits repo-wide and
**zero callers** — two schema JSONs, the generated type, one doc comment in
`codex-responses-adapter/src/config-writer.ts:898`, and two plan rows. No code reads it.

## I4 — hygiene

`try/finally` around all three shipped tests plus the new one, so a failing assertion cannot leak a
`CodexAgent` or leave a destroyed agent's capability runtime installed for whatever runs next. Test 3
now releases its capability runtime like its two siblings.

## Rig, and how it was proved

A `git worktree` at the measured commit, with `node_modules` built **entry-by-entry** — every parent
entry symlinked except `@nessy-agent`, which is a real directory whose entries point at the worktree's
own packages. Confirmed three ways before any mutation was believed:

1. A planted marker in `packages/core/src/types/index.ts` read `WORKTREE`, not `ABSENT`, through a
   **value** import of `@nessy-agent/core/types` (a type-only import would have been erased and proved
   nothing).
2. `Bun.resolveSync` reported `@nessy-agent/shared` and `codex-agent.ts` both inside the worktree.
3. Mutations killed tests only in the tree they were applied to — B2 restored to 4/0.

## Commit isolation, and a correction to my own check

`codex-agent.ts` carried another lane's (P2.257) uncommitted 120/7 hunk throughout. The committed blob
was built from **the parent commit's blob plus my comment**, hashed with `git hash-object -w`, staged
through an isolated `GIT_INDEX_FILE`, and the ref moved with `update-ref`'s old-value guard. The working
tree never touched the commit path.

**HEAD moved mid-run**, from `7e5b0ab3f` to `d8c1cb450`. The script re-read the ref at commit time and
built from `d8c1cb450`; the anchor assertions still held. I then checked what that drift touched —
`options.ts`, `config/proxy-env.ts`, one new test file, the plan — and **not** `codex-agent.ts`,
`base-agent.ts` or my test file, so the campaign's measurements remain valid for the tree I committed on.

**My isolation check reported a false positive and I caught it.** I greped the committed blob for three
of the other lane's identifiers; `CODEX_REQUEST_TIMED_OUT` came back **4**, not 0. It is **pre-existing
at the parent** (4 there too) and their hunk merely adds a fifth. A marker that already exists at HEAD
cannot discriminate. The two that do — `CODEX_THREAD_REFORK_TIMEOUT_MS` and `DEFINITIVE_REFUSAL_CODES` —
are **0 in the committed blob and 3 / 1 in the working tree**. Stronger still, and checkable from the
artefact without trusting any narrative: `git diff <parent> <commit> -- codex-agent.ts` is **one deleted
source line and fourteen added, all inside a `/** … */` block**, and the committed test blob
(`0d17a4036…`) is byte-identical to the one the campaign measured.

**The other lane's hunk is intact and still uncommitted**, and my comment was *also* applied to the
working tree by a single read-modify-write that re-read the file and asserted the hash was unchanged
before writing (a concurrent write would have aborted, not been clobbered). That matters: without it,
the next pathspec commit on that file would have reverted my comment. Post-commit state is exactly
`120 insertions / 7 deletions` — their original hunk, unchanged — with my comment now in HEAD and no
longer in the diff. The predicted stale-index phantom appeared on **both** paths (`MM` / `MM`) and was
cleared with a path-scoped `git reset`.

## Verification

- `bun test packages/shared/src/agent/__tests__/codex-cost-declaration.test.ts` in the **real working
  tree** (other lane's hunk present): **4 pass / 0 fail / 0 skip**, 8 expect() calls.
- `packages/shared` `tsc --noEmit` at the commit, in the isolated worktree so no in-flight edit could be
  attributed to me: **exit 0**.
- `git diff --check` on the commit: clean.
- Every `bun test` ran under `scripts/bun-test-lock.ts`. The lock was contended the whole session
  (`P2.257-break1`, `p2254-new`, `review-p2245`); nothing was reaped and nothing was held while thinking
  — the five-variant campaign ran as one scripted hold.

## Not done, deliberately

- The plan file and `AGENTS.md` are untouched, per the brief. **The row still needs its tracker update**
  (glyph, this SHA, and the M2pre number) — that is the controller's to write.
- P2.238, P2.239 and P2.258 are named in comments and left alone.
