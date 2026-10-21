# P2.273 — report

**Status: REPRODUCED and pinned; producer fix BLOCKED out of zone, reported not landed.**

Commit: `1981a1470` — `test(sessions): an omitted hook-agent \`tools:\` reaches the child as the empty set`
(1 file, +95, `packages/server-core/src/sessions/SessionManager.plugin-hook-runners.test.ts`).
Base SHA recorded before starting: `f58f66a36f6314384fef1d4c535f7772dd0ca84b`.

---

## 1. The defect reproduced — first thing done, before any fix existed

The row was honest that it had no reproduction. It has one now.

Fixture: `createPinnedAgentCapabilityRuntime({ tools: undefined })` — the view agent
carries no `tools`, the instructions body carries no frontmatter, so
`buildPiRuntimeAgentDescriptor`'s `agent.tools ?? optionalToolList(frontmatter.tools)`
yields `undefined` and `parseDeclaredTools` keeps it `undefined`. It drives the REAL
`pluginAgentHookRunner` through the existing harness (a recording child port), so the
producer is the code under test, not a double.

**First run, on unmodified `f58f66a36` (`Ran 2 tests across 1 file`, `1 pass 1 fail`):**

```
expect(child.starts[0].restrictions.tools).not.toEqual([])
error: expect(received).not.toEqual(expected)
Expected: not []
(fail) … does not collapse an omitted `tools:` onto the empty pool …
```

The failing assertion masked the rest, so I measured the remainder with the assertion
replaced by a print, same commit:

```
MEASURED tools= [] worktreePolicy= isolated-worktree
1 pass 0 fail   (the receipt assertion — outcome 'success' — passed)
```

**All three consequences confirmed on one spawn:**

| Claim in the row | Measured |
| --- | --- |
| empty tool pool | `restrictions.tools === []` |
| isolated-worktree lease per firing | `worktreePolicy === 'isolated-worktree'` |
| `appendReceipt` writes a false `success` | `{ semanticId: 'plugin-agent-hook', outcome: 'success', isolationProfile: 'host-child-session' }` |

The worktree half follows from `piRuntimeAgentWorktreePolicy` →
`isReadOnlySubagentToolGrant(undefined) === false`, so an omitted list takes the
*isolating* policy: the tool-less child leases a worktree it cannot write in.

**The row is correct as written. No correction to report.** One refinement: the `: []`
branch is reached ONLY for the omitted key. An authored-empty `tools: []` parses to
`EMPTY_TOOL_LIST`, a frozen `[]`, which is **truthy**, so it takes the `?` branch and
produces `[]` for its own reason. The fix therefore changes exactly one case and cannot
disturb the authored-empty one.

## 2. Documentation — which half is which

**The semantics: category (b), `[doc:claude]`.**
`errors.md#agent-would-be-spawned-with-zero-tools` — anchor read off the RENDERED page
(`curl https://code.claude.com/docs/en/errors`, `id="agent-would-be-spawned-with-zero-tools"`;
note the corpus URL shape is `/docs/en/<slug>`, `/docs/<slug>` 404s), verbatim:

> "Omitting the `tools` field never triggers this refusal. If you leave the `tools` list
> empty, or `disallowedTools` removes every entry in it, Claude Code also skips the
> refusal and launches the subagent without tools."

and the same section's fix list:

> "Delete the `tools` field instead of listing tools to give the subagent every tool
> available to subagents"

`sub-agents.md#supported-frontmatter-fields` (anchor verified the same way) states the
positive half in the `tools` row:

> "Inherits every tool available to subagents if omitted."

Deleted means everything; empty means nothing. Both readings are already implemented in
`parseDeclaredTools`, which distinguishes them.

**The producer: category (a), `[doc:none]`.** `definition.tools ? [...definition.tools] : []`
is ours. No page decides how the host transports a hook-spawned agent's ceiling; the page
decides only what the two authored shapes MEAN, and the producer contradicts it.

## 3. The fix — identified, measured, and NOT landed (out of zone)

The correction is one line at the producer, and it is the idiom its own neighbours
already use. Every other optional restriction in the same object literal is a
conditional spread — `skillKeys`, `mcpServerKeys`, `memory`, `maxTurns`,
`permissionMode` — i.e. **omitted already means "the host decides / inherit"** in this
very call:

```ts
const declaredTools = definition.tools ? [...definition.tools] : undefined
...
...(declaredTools ? { tools: declaredTools } : {}),
```

An omitted ceiling already means inherit the whole way down, with no other change:
`SessionManager.ts:15980` reads `piAllowedTools: managed.piChildRestrictions?.tools`, and
`resolvePiAllowedBindingNames` (`packages/pi-agent-server/src/harness/tool-manifest.ts`)
opens with `if (!allowedToolNames) return null` — null being "no restriction". `[]` is
truthy there, which is exactly why today's value produces an empty binding set.

**It does not compile.** Applied and typechecked on `f58f66a36` (`cd packages/server-core
&& bun run typecheck`), it produces **exactly one** error, and that error names the
blocker:

```
src/sessions/SessionManager.ts(6679,11): error TS2322: Type '{ … }' is not assignable to
type 'PiChildRestrictionsV1'.
  Types of property 'tools' are incompatible.
    Type 'string[] | undefined' is not assignable to type 'string[]'.
```

`PiChildRestrictionsV1.tools` is a **required `string[]`** in
`packages/shared/src/agent/pi-harness/child-session-port.ts:22` — **one file outside this
lane's zone**, so per the zone rule I stopped rather than reaching across. The probe was
reverted; `SessionManager.ts` is byte-identical to HEAD (sha256 `51cee443…`), verified.

### The ready patch, for whoever gets the row next

1. `packages/shared/src/agent/pi-harness/child-session-port.ts` — `tools: string[]` →
   `tools?: string[]`, with the doc paragraph: omitted = inherit (no ceiling), `[]` = the
   empty set, citing the `errors.md` sentence above. It is a WIRE + PERSISTENCE field
   (embedded verbatim in `PiChildSessionRecordV1.restrictions`), so it needs the same
   "records written before the field existed must keep parsing with it absent" treatment
   the neighbouring optional fields carry — here the direction is the easy one: absent is
   the NEW state, and every existing record has it present.
2. `packages/server-core/src/sessions/SessionManager.ts` — the producer line above, plus
   two undefined guards in the port's own `start`:
   - `:13968` `input.restrictions.tools.find(…)` → skip the validation when absent (an
     absent list declares nothing to validate);
   - `:14171-14172` `inheritedTools` → when absent, inherit `parentTools` if the spawning
     session has a ceiling, else stay absent.
   `:15980` needs nothing — `managed.piChildRestrictions?.tools` is already
   undefined-tolerant and already means "no ceiling" for a top-level session.
3. Flip the pinned test (below) from `toEqual([])` to the inherit assertion, and keep the
   authored-empty boundary test as it is.

**Blast radius, read statically (NOT typechecked — I did not apply step 1):** the only
readers of `PiChildRestrictionsV1['tools']` in the tree are those three sites, all inside
`SessionManager.ts`. Writers always supply it (`spawner.ts`'s `allowedTools` and
`composeForkRestrictions`; `SessionManager.ts:14397` spreads then overrides; the guardian
judge at `:14475`). `runtime-skill-content.ts:614` guards on truthiness already and is a
different `restrictions` type.

**Why NOT the alternatives I considered and rejected:**

- **A throw / refusal at the producer.** Strictly better than today on every axis except
  the one that matters — the agent still would not run — and it is the same trade the
  admission gate deliberately stopped making. Not done, per the brief.
- **Enumerating the pool host-side** from `capabilityRuntime.piExecutionManifestSeed.staticTools`
  plus `mcp__<server>__*` wildcards. This is a second hand-written copy of Pi's inherit
  rule (`buildPiRuntimeAgentDefinitions`, which subtracts `ORCHESTRATION_TOOLS` and
  `SUBAGENT_UNAVAILABLE_TOOLS` from the live manifest). The producer's own P8 comment is
  the scar from exactly this class of duplication, and the seed omits dynamic tools, so
  it would trade a visible empty pool for an invisible narrowed one.

## 4. What was committed, and why it pins the defect rather than the intent

Two tests, both driving the real producer:

1. **`P2.273 DEFECT pinned: an omitted \`tools:\` is collapsed onto the authored-empty pool
   and still receipts success`** — asserts the three measured facts. Its doc comment says
   in as many words that it pins the defect, not the intent, carries the citation, the
   one-line fix, and the tsc error that blocks it. **It must fail the moment the producer
   is corrected**, which makes it a hard tripwire in the default suite rather than a
   `test.todo` (measured: `bun test` 1.3.14 does NOT execute todo bodies without `--todo`,
   so a todo here would be a silent skip — a false green by another name).
2. **`keeps an authored-empty \`tools: []\` as the empty pool it declared`** — the boundary
   the fix must not widen, and the positive control that the fixture route reaches the
   producer at all. Honest caveat: today the two shapes are indistinguishable at this
   assertion, so this test only becomes discriminating after the fix.

### Prove-by-breaking (re-break against the recorded absolute SHA, never `HEAD~1`)

Mutated the producer's fallback in place — `: []` → `: ['__p2273_probe__']` — and ran:

```
(fail) … P2.273 DEFECT pinned … expect(received).toEqual(expected)  - []  + ["__p2273_probe__"]
1 pass  1 fail   Ran 2 tests across 1 file.
```

**1 test fails, and it is the right one.** The boundary test survives untouched, which
proves the two observe different branches and that neither is vacuous. Mutation reverted
surgically (not by file copy, so a concurrent lane's edit could not be clobbered);
sha256 re-verified identical to pre-mutation, `git status` clean for that path.

## 5. The extra question — does `appendReceipt` write `success` for any other zero-work path?

Audited all `appendReceipt` sites in `SessionManager.ts` (six runners). **Verdict: no
second config-emptied false success in this file.** The other four `success` writers each
require an observable act:

| Site | `success` requires |
| --- | --- |
| `:6491` skill-context command | a real command exiting 0, under the output-size cap |
| `:6844` MCP tool hook | a tool call returning `isError: false` |
| `:6959` HTTP hook | `result.success` from the webhook executor |
| `:7045` prompt hook | a PARSED verdict (unparseable is `error`; `verdict-block` is a success with a code, deliberately — the hook did its job) |
| `:6760` **agent hook** | **only that the child session `completed` — which an empty-pool child does immediately** |

Only the agent route lets configuration empty the child's capacity to act *before* the
run, so only it can complete honestly and mean nothing. Two adjacent observations, both
recorded rather than withheld:

- `:6844` will write `success` for an MCP tool that returns empty content with
  `isError: false`. That is a zero-work success, but it is the *tool's own* report, not a
  pool we emptied — no action proposed, recorded as a verdict.
- **The empty pool is reachable from the MODEL route too**, by the other two clauses of
  the same `errors.md` sentence: `narrowRuntimeSkillTools(inheritedTools, skillInvocations)`
  at `:14178` can intersect to `[]`, and the spawner's `allowedTools` filter can have
  `disallowedTools` remove every entry. Neither writes a Pi execution receipt — the
  child's emptiness surfaces through the Agent tool result instead — so the **false
  success in a receipt is specific to the hook route**, exactly as the row said. The
  wasted turn and the worktree lease are not.

`grep -a` over `SessionManager.ts` for the collapse shape `? [...x] : []` returns exactly
one hit, line 6667. No sibling instance in this file.

## 6. Findings, tagged

1. **`[doc:claude]` — forgotten-vs-doc.** An omitted `tools:` on a plugin-hook agent is
   spawned as the empty set, contradicting `errors.md#agent-would-be-spawned-with-zero-tools`
   and `sub-agents.md#supported-frontmatter-fields`. Reproduced, pinned, cause located.
   Fix identified and blocked (see 3). **Pi is built to Claude's docs, so this is a double
   gap.**
2. **`[doc:none]` — never-looked-at.** `PiChildRestrictionsV1` **cannot express
   "inherit"**: `tools` is a required `string[]`, while every other optional restriction
   in it uses absence for exactly that meaning, and the two layers underneath it
   (`piAllowedTools`, `resolvePiAllowedBindingNames`) already read absence as "no
   ceiling". Nobody had examined whether the host transport can say what the page
   requires. This is the real reason the row's one-line fix does not exist yet, and it is
   the finding I would rank above the ternary itself.
3. **`[doc:none]` — never-looked-at (verdict: clean).** No other zero-work `success`
   receipt in `SessionManager.ts`'s runners; the MCP-tool empty-content case is the tool's
   own report. Recorded so the question is not asked a third time.
4. **`[doc:claude]` — never-looked-at.** The model route reaches an empty pool by the same
   sentence's other two clauses (skill narrowing at `:14178`, `disallowedTools` at the
   spawner) but writes no receipt, so it loses the turn and the lease without the false
   success. Not fixed here; worth a row of its own if the owner wants the wasted-turn half
   closed everywhere rather than only on the hook route.

## 7. Gates — with proof of work, not exit statuses

| Gate | Result |
| --- | --- |
| `bun scripts/bun-test-lock.ts run --label P2.273 -- bun test …plugin-hook-runners.test.ts` | **`20 pass 0 fail 107 expect() calls — Ran 20 tests across 1 file`** (was 18 before this row) |
| `cd packages/server-core && bun run typecheck` | **`tsc --noEmit`, zero diagnostic lines** (the whole output was the one echoed command line) |
| `npx eslint` from `packages/server-core` (not the repo root) | **`errorCount: 0, warningCount: 0`**, `-f json` showing the file's own `filePath` — proof it was processed, since a zero-byte pass proves nothing |
| `git diff --check` | clean, exit 0 |
| scope | `git show --stat --oneline 1981a1470` → 1 file, mine. A sibling lane's `project-capability-watcher.test.ts` was dirty in the tree throughout and is NOT in the commit. |
| full repo suite / builds / packaging | **NOT RUN** — outside the row's budget, and this commit adds tests only. |

All gate output was redirected to files and read whole; nothing was piped to `tail` or
`head` before its size was known.

## 8. Concerns

- **The MUST-FIX is not fixed.** The reproduction landed; the correction is one line in my
  file plus one line in a file I was told not to touch. It needs a dispatch that owns both,
  or my zone extended by one file. Everything needed is in §3.
- **A test that asserts a defect is a liability if it outlives the defect.** It is named
  and commented to make that impossible to miss, and it fails loudly the moment the
  producer is fixed — but if this row is not picked up soon, that assertion is the thing
  most likely to be misread as intent.
- The boundary test is non-discriminating until the fix lands (both shapes produce `[]`
  today). Stated in its own doc comment so nobody mistakes its green for coverage.
- The blast-radius reading in §3 is **static**, not typechecked; I did not apply the
  shared-file change. Whoever lands it should expect the two guards at `:13968` and
  `:14171` and should re-run the server-core typecheck to find anything I read past.
