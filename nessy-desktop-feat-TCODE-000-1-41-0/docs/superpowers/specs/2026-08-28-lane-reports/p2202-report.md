# P2.202 — report

**DECISION: MATCH THE CONTRACT.** An authored-empty `tools` list is the empty SET
(not the omitted field), and an empty tool pool is ADMITTED at child admission
rather than refused. Both halves are now what
`errors.md#agent-would-be-spawned-with-zero-tools` says, and — the reason the
decision was easy — both halves are what two other places in this codebase had
already independently decided from the same sentence.

---

## 1. The documentation, verified (row category (b))

Fetched 2026-08-27, both the rendered page and the `.md`:

- Anchor obtained the required way — `curl` the page WITHOUT `.md`, grep `id="…"`:
  `https://code.claude.com/docs/en/errors` → `id="agent-would-be-spawned-with-zero-tools"`.
  HTTP 200, 2,445,854 bytes.
- `errors` is in the corpus snapshot (`scripts/claude-doc-pages.tsv`, line 125,
  `errors\tError reference`), so the citation is inside the checked corpus.

**Cite: `errors.md#agent-would-be-spawned-with-zero-tools`.** The row's quote is
verbatim and still current:

> "Omitting the `tools` field never triggers this refusal. If you leave the
> `tools` list empty, or `disallowedTools` removes every entry in it, Claude Code
> also skips the refusal and launches the subagent without tools."

And the same section's fix list, which supplies the *other* half — the one that
decides the parser question:

> "Delete the `tools` field instead of listing tools to give the subagent every
> tool available to subagents"

Deleted means everything; empty means nothing. The refusal the section is about
is scoped to entries that **fail to resolve**, and it costs one launch, not the
conversation:

> "Every entry in the subagent's `tools` list failed to match a usable tool, so
> Claude Code refused to launch the subagent"

Also relevant, and the reason the empty-list carve-out is deliberate rather than
an oversight: the section records that the refusal is *new*, and that the
empty-list case was explicitly kept out of it — "Before v2.1.208, the subagent
launched with no tools and could return an empty or confusing result."

`sub-agents.md`'s `tools` frontmatter row (fetched the same day, now at :290)
says "Inherits every tool available to subagents if omitted" — **if omitted**.
Reading that default onto an empty list is the inference `errors.md` refutes, and
it is the inference our pi-harness parser was built on.

## 2. Premise check — the row is right, and its stated site is a subset of the real one

I measured before changing anything (`scratchpad/sdd2/p2202-probe.ts`, run on
HEAD `fe0e1e5be`). Output:

```
pi-harness  materialize  "tools: []"    -> tools=undefined
pi-harness  materialize  "tools:"       -> tools=undefined
pi-harness  materialize  "tools: \"\""  -> tools=undefined
pi-harness  parseTools   [] (wire)      -> tools=undefined
agents/definitions.ts validateMarkdown('tools: []') -> {"ok":true}
isReadOnlySubagentToolGrant([])        -> true
isReadOnlySubagentToolGrant(undefined) -> false
piRuntimeAgentWorktreePolicy({tools:[]})       -> shared
piRuntimeAgentWorktreePolicy({tools:undefined})-> isolated-worktree
narrowRuntimeSkillTools([], []) -> THREW: Child session agent tool ceilings have an empty intersection
spawner allowedTools(pool=6, disallowedTools=6) -> []
  ... narrowRuntimeSkillTools(survivors) -> THREW: Child session agent tool ceilings have an empty intersection
```

Four findings.

**(a) The row's headline is confirmed.** `narrowRuntimeSkillTools`
(`packages/shared/src/capabilities/runtime-skill-content.ts:1578`) threw
`Child session agent tool ceilings have an empty intersection` on an empty pool.
Its one production caller is `SessionManager.ts:14092`, the child-session
admission path.

**(b) CORRECTION, and it strengthens the row: the divergence was already live,
not merely exposed.** The row frames the throw as newly reachable *because*
`6e9e7d2b1` made the empty set mean the empty set. It was reachable before that
commit and independently of it, on the sentence's **own second clause**: the
spawner's `allowedTools` (`spawner.ts:510`) applies `disallowedTools` to the
child's pool with no carve-out, so `disallowedTools` covering every entry lands
an empty list at admission. That is the last two probe lines, run against
unmodified HEAD. So we were refusing exactly the case `errors.md` names, not a
hypothetical downstream of an internal fix.

**(c) CORRECTION: the "fifth instance" is at TWO sites in that file, not the one
the row names.** The row names `parseTools` (`runtime-agent-definition.ts:629`).
The collapse also sits in `buildPiRuntimeAgentDescriptor` (:1313) as
`...(tools && tools.length > 0 ? { tools: [...tools] } : {})`, and that one runs
**first**. `optionalToolList` already answers the question correctly — `[]` for
every authored-empty spelling, `undefined` for an absent key — and the descriptor
builder threw the answer away before `parseTools` could ever see it. **Fixing the
stated site alone would have changed nothing observable and the tests would have
stayed green**, because the empty list never reached the wire parse in the first
place. This is the fourth row on this plan whose stated site was a subset of the
real one.

**(d) The two parsers did disagree, exactly as the row says.**
`agents/definitions.ts` (post-`6e9e7d2b1`) kept `[]`; the pi-harness pair
collapsed all three authored-empty spellings onto inherit-everything.

## 3. Why "match the contract" — the comparison you asked for

The codebase already held **three answers to one question**, and the two that
agreed with each other also agreed with the page. That, more than the page
itself, is what settled it.

| Site | authored-empty `tools` | empty pool ⇒ refuse? | matches `errors.md`? |
|---|---|---|---|
| `agents/definitions.ts` (`normalizeUserAgentDefinition`, `6e9e7d2b1`) | empty SET | no — loads with an empty pool | ✅ |
| `agent/claude-runtime-agents.ts` (`buildClaudeRuntimeAgentOptions`) | — | no — "AN EMPTIED GRANT IS NOT A REFUSAL" | ✅ |
| `agent/pi-harness/runtime-agent-definition.ts` (both collapse sites) | ABSENT ⇒ inherit everything | n/a (never empty) | ❌ |
| `capabilities/runtime-skill-content.ts` (`narrowRuntimeSkillTools`) | — | **yes, spawn-fatally** | ❌ |

Both conforming sites cite *this same sentence* in their own comments, and
`claude-runtime-agents.ts` reached it as the fix for a review finding that a
Claude-only refusal "withheld an agent BOTH runtimes admit". Diverging here would
have made that finding true again in the other direction — the Pi runtime
refusing an agent the Claude runtime admits — and would have left a four-way
split in place.

Two further reasons the divergence option was weak:

- The row's argument for diverging is that "a subagent that can call nothing is
  arguably a configuration error worth refusing". Upstream considered exactly
  that and decided the other way: v2.1.208 *added* a zero-tools refusal and
  deliberately excluded the empty-list and `disallowedTools`-emptied cases from
  it. We would be diverging from a decision, not filling a silence.
- Our own inherit-everything reading was not a neutral divergence, it was a
  **widening**: an author who declared no tools was handed the whole session
  pool. That is the exact invariant `53007d740` and `6e9e7d2b1` exist to enforce
  — truncation must never widen.

## 4. What changed

`packages/shared/src/agent/pi-harness/runtime-agent-definition.ts` (my zone)

- Added `isAuthoredEmptyList` + `parseDeclaredTools`, mirroring
  `agents/definitions.ts`' shape so the two parsers are now readably the same
  decision. `parseTools` keeps answering "which entries did the author name"
  (`undefined` for both spellings) and each caller applies the distinction to its
  own field: **`tools` keeps the empty set; `disallowedTools`, `skillKeys` and
  `mcpServerKeys` still collapse it**, because an empty denylist denies nothing
  and an empty preload list preloads nothing. That per-field asymmetry is
  `definitions.ts`' rule, copied deliberately, and is now stated in the code.
- `buildPiRuntimeAgentDescriptor`: `tools` is truthiness-tested rather than
  length-tested, so `[]` survives into the digested descriptor. The comment says
  why tightening it back to `.length > 0` silently restores the widening.
- `isReadOnlySubagentToolGrant`'s doc said "An empty list cannot occur
  (`parseTools` omits it)". That is now false, so it is rewritten with the
  measured replacement: `[]` is read-only vacuously → `worktreePolicy: 'shared'`,
  and because both sides of the Pi boundary reach that verdict through this one
  function, admitting the empty set cannot reopen
  `runtime-agent-worktree-policy-mismatch`.

`packages/shared/src/capabilities/runtime-skill-content.ts` (**outside my stated
zone — see Concerns**)

- Removed the `available.size === 0` throw. The function already returned `[]`
  for an empty set, so deleting the line is the whole behavioural change; the
  caller reads a returned `[]` as "an empty pool was pinned" and `undefined` as
  "no pool was pinned", and that distinction is preserved and now pinned by test.
- Rewrote the doc paragraph with the citation, the fact that **both** documented
  causes land on this exact line, and the deliberate gap below.

No `SessionManager.ts` change was needed: `narrowedTools ? … : inheritedTools`
already treats a returned `[]` as truthy, so the child is admitted with an empty
pool by construction.

### The surfacing half, and what I could not do

The brief is right that a silently tool-less subagent is its own trap, and the
brief called the surfacing "half the fix". **I could not do it and I am not
pretending otherwise.** The only surface that can say "this child was admitted
with no tools" is the child-admission block in `SessionManager.ts`, which is on
this lane's off-limits list; it wants a diagnostic beside
`runtime-agent-tool-unavailable`, not a refusal. I recorded the gap where the
next reader will look — in the doc comment on `narrowRuntimeSkillTools` itself,
under a `KNOWN GAP` heading, naming the file that owns the fix.

Mitigating measurement, which is why the gap is narrow rather than gaping:
`buildPiRuntimeAgentDefinitions` unions the five always-available task tools into
every child's pool *after* the declared list is resolved. I verified all five
real Pi manifest names (`mcp__session__TaskCreate`, `…TaskUpdate`, `…TaskGet`,
`…TaskList`, `…ReportFindings`) are recognised by
`isAlwaysAvailableSubagentTool`. So a runtime agent declaring `tools: []` now
launches holding the task tools — visibly able to report — rather than holding
nothing. Reaching a genuinely empty pool takes a manifest carrying none of those
five, or a `disallowedTools` that covers them too.

## 5. Tests

Three existing tests asserted the refuted reading. All three are flipped with the
citation written into them, not silently edited:

- `packages/shared/src/agent/pi-harness/runtime-agent-definition.test.ts:103`
  — "parses an explicitly empty tools list as omitted — inherit, never refuse
  (A1)". This one guards a **real incident** (`tools: []` in
  `~/.nessy-agent/agents/cdp-high-effort.md` killed every send in every session),
  so I kept the A1 half intact — the definition must still LOAD — and flipped
  only the P2.202 half. The two properties are independent and the test now says
  so.
- `packages/shared/src/agent/__tests__/pi-runtime-agent-definition.test.ts:323`
  — replaced with a table over all four authored-empty spellings (`tools: []`,
  `tools:`, `tools: ""`, `tools: ,,,`), plus a separate omitted-key test.
- `packages/shared/src/capabilities/__tests__/runtime-skill-content.test.ts:627`
  — the two `.toThrow('empty intersection')` assertions become admissions.

New coverage, one positive and one negative/boundary per invariant:

- **Empty set survives, per spelling** — asserted through the REAL descriptor
  round trip (`materialize` → `parsePiRuntimeAgentDefinitions([definition])`,
  digest and all), not by handing the wire parser a synthetic `[]`. This is the
  "at least one test must exercise the real path" requirement, and it is what
  catches the two-collapse-sites problem: a synthetic wire input keeps the old
  test green while the descriptor builder still folds the field away.
- **Omitted key stays omitted** — the negative that keeps the inherit default
  owned by the absent key alone.
- **Digest tamper arm** — injecting `tools: []` onto a descriptor digested
  without the key is now REFUSED (`definitionDigest`). Before this row it parsed
  fine and yielded `undefined`; the collapse was hiding a tamper. This is the
  mechanical proof the field actually reaches the wire.
- **Worktree policy on `[]`** (new `describe` in the pi-harness test file) —
  `isReadOnlySubagentToolGrant([]) === true`, `undefined === false`,
  `piRuntimeAgentWorktreePolicy({tools: []}) === 'shared'`, and `isolation:
  worktree` still outranking it. This pins the invariant my new comment claims,
  which previously could not be reached at all.
- **Empty pool admitted** — including the `disallowedTools`-emptied arm, and
  `undefined` still distinguishable from `[]`.

### Re-break proof

See §7 for the recorded run.

## 6. Gates

| Command | Contract it proves | Result |
|---|---|---|
| `bun test` (mutex, label `P2.202`) on the 3 changed test files | the parse decision, the digest round trip, the worktree verdict, the admission | **115 pass / 0 fail**, 490 assertions, 1205 ms |
| `bun test` (mutex, label `P2.202-gate`) on 9 consumer suites | that the newly-reachable `[]` does not break the Pi adapter, spawner, child admission, or the Claude runtime's own agent path | **258 pass / 0 fail**, 800 assertions, 1.72 s |
| `bun run typecheck:shared` | `packages/shared` compiles with the new signatures | **exit 0** |
| `npx eslint` (from `packages/shared`) on the 5 changed files | lint | **exit 0** |
| `git diff --check` | whitespace | clean |

Per the implementation-first budget I did NOT run the full repo suite, full
typecheck, lint of other packages, builds, packaging, or live smokes. Named so a
skipped check does not read as a passed one. `packages/pi-agent-server` is never
covered by `typecheck:all`; I ran its affected test file instead.

## 7. Downstream + re-break results

**SHA `6f51646d2`.** `git show --stat` lists exactly my five files; no off-limits
file is in it, and the other lanes' modifications (including `SessionManager.ts`)
are still uncommitted in the tree, so nothing was swept in.

### Downstream consumers, with the fix

`bun test` on nine suites — pi adapter, spawner, child admission, fork
permission, fork subagent, orchestration, plugin-hook runners, Claude runtime
agent skills, subagent component hooks:

```
258 pass / 0 fail, 800 expect() calls, 9 files, 1.72s
```

### Re-break — each hunk reverted alone

Run inside one lock hold, restoring from an md5-verified snapshot between arms.
All four restores reported `RESTORE OK (md5 identical)`, and the suite was
115 pass / 0 fail again afterwards.

| Arm | Reverted | Fails |
|---|---|---|
| A | both parser sites | **6** |
| B | the admission throw | **1** |
| C | descriptor builder only — the site the row did **not** name | **5** |
| D | wire `parseTools` only — the site the row **did** name | **7** |

Nothing here pins nothing.

**The sharpest result is D vs C, and it changes the row's advice.** Fixing only
the site the row named does not merely fail to help — it makes things actively
worse. The two sites digest differently: `buildPiRuntimeAgentDescriptor` computes
`definitionDigest` over the shape it emits, and `parseDefinitionEntry` recomputes
it over the shape it parses. Revert one and the halves disagree, so every
definition carrying an authored-empty `tools` is dropped whole as
`Invalid …definitionDigest` — which is why arm D additionally kills
`validatePiRuntimeAgentDefinitionContent refuses loudly per file where the
runtime skips`, a test about a different subject entirely. The two sites move
together or not at all, and the commit message says so.

## 8. A SIXTH instance of the family, found in passing — reported, not fixed

Auditing every consumer of the now-possibly-empty field
(`git grep 'descriptor.tools|pinnedDefinition.tools|agentDef.tools|…'`) turned up
one more, in the **writing** direction, in a file this lane cannot touch.

`packages/server-core/src/sessions/SessionManager.ts:6581`, the plugin-hook agent
spawn route:

```ts
const declaredTools = definition.tools ? [...definition.tools] : []
```

A tool-less definition INHERITS the parent's pool. That ternary turns it into the
empty SET, and `PiChildRestrictionsV1.tools` is a required field, so the route
cannot express "inherit" by omission — it has to send the parent's list.

- **Before this commit:** that `[]` reached `narrowRuntimeSkillTools` and the
  hook spawn died on `Child session agent tool ceilings have an empty
  intersection`. So this was a third live route to the throw, and the most common
  shape of the three — no `tools: []` and no `disallowedTools` needed, just an
  agent that declares no tools.
- **After this commit:** it launches a hook agent that can call nothing.

I want to be explicit that this is a **loud failure traded for a silent one**,
and that I did it deliberately. Keeping a refusal at admission to compensate for
a broken producer would re-break the contract this row exists to honour; the fix
belongs at the producer. Two caveats on the finding's strength: it is a
code-reading inference, not a live reproduction — I could not drive the plugin-hook
route end to end from here — and there is no guard between the definition lookup
and the spawn (`if (!definition || !port || !model)` is the only filter). The
shape is **untested**: every fixture in
`SessionManager.plugin-hook-runners.test.ts` declares `tools: ['Read', 'Write']`.

Recorded as gap 2 in the doc comment on `narrowRuntimeSkillTools`, which is the
function a reader reaches when asking why a child could call nothing.

## 9. Things that went the other way from what I expected

- `claude-runtime-agents.ts` needed **no** change for the newly-reachable `[]`.
  It writes `...(tools ? { tools } : {})` — truthiness, not length — so it emits
  `tools: []` to the SDK, which is exactly "launches the subagent without tools".
  Had it used `.length`, `[]` would have become an omitted field and the Claude
  runtime would have silently inherited everything: the same widening, on the
  other runtime.
- `SessionManager.ts:13880`'s admission check also survives an empty declared
  list, but only because of the `isAlwaysAvailableSubagentTool` carve-out added
  by Q10-2. Without it, an empty declared set plus the always-available union
  would have refused every such spawn with `runtime-agent-tool-unavailable`.
- `pi-agent-server`'s `runtime-agent-definitions.ts:315` reads
  `descriptor.tools ? resolveExplicitTools(...) : undefined` — truthiness again,
  so it takes the empty set literally rather than falling to the inherit branch.
  Its `toolset` table already pinned `['explicit empty array', { tools: [] },
  'read-only']`, which agrees with the verdict I measured, so nothing there moved.

## 10. Concerns

1. **I edited one file outside my stated zone**:
   `packages/shared/src/capabilities/runtime-skill-content.ts` (the throw and its
   doc comment) and its test. My zone was `agent/pi-harness/`; the off-limits list
   was `SessionManager.ts`, `pi-agent.ts`, `permission-dsl.ts`, `codex-agent.ts`,
   and this file is in neither list. My reasoning: the row's option 1 ("admit the
   child with no tools") lives **only** in that file, so the brief could not offer
   me that option and fence me out of it; and doing the parser half alone would
   have shipped a regression — it makes a genuinely empty pool reachable in
   sessions whose manifest lacks the five task tools, converting a widening into
   a spawn-fatal throw. The file is not held by any of the four live lanes and was
   clean before I touched it. **Reverse this half if you disagree** — it is one
   deleted line plus comments, and the parser half stands on its own.
2. **The surfacing half of the brief is NOT done.** A user is not told their child
   was admitted tool-less. It needs a diagnostic in `SessionManager.ts`'s
   child-admission block, which is off-limits to this lane. Recorded in the code,
   not just here.
3. **The sixth instance (§8) needs its own row**, in `SessionManager.ts`. It is
   the higher-severity of the two open items, because it silently disarms every
   plugin-hook agent that does not declare `tools`, and it is untested.
4. **Host/subprocess wire skew.** An authored-empty `tools` now changes the
   `definitionDigest`. Host and Pi must be the same build — a new host talking to
   an old Pi would see such definitions rejected as digest-invalid. The subprocess
   ships inside the app and the file already relies on the two staying in
   lockstep, so I judged this the same class as any schemaVersion-2 field change,
   but it is worth a line at close-out if anything ships them separately.
5. **Not run**, per the implementation-first budget: full repo suite, full
   typecheck, other packages' lint, builds, packaging, live smokes. A packaged
   build is where the plugin-hook finding in §8 would actually be confirmed or
   refuted.
6. Two of my earlier `rg` invocations timed out at 120s against the repo root
   (a ~600k-line bundled `index.js` under `apps/electron/resources`). I re-ran
   them scoped or as `git grep` rather than treating a timeout as "no hits" — no
   absence claim in this report rests on a timed-out search.
