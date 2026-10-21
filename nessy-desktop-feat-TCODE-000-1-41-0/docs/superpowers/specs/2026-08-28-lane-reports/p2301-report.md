# P2.301 + P2.273 — report

**Status: BOTH ROWS LANDED. The pinned test now asserts the FIX, in the same commit that
made the fix compile — the tree never held a green test reading like a bug was intended.**

Commit: `e5c85f138` — `fix(sessions): the transport could not say "inherit", so an omitted
\`tools:\` meant nothing` (5 files, +248 / −56).
Absolute base SHA recorded before starting: **`f8d4d505664253f8ac72e75749b033940519e797`**.
(By the time I committed, other lanes had landed and my base was no longer `HEAD~1` — which
is exactly why the re-break was run against the absolute SHA.)

---

## 1. Step 1 of the method: I confirmed the compile failure myself

Applied the sibling lane's producer patch alone on the working tree at `f8d4d5056`
(`declaredTools … : undefined` + `...(declaredTools ? { tools: declaredTools } : {})`),
then `cd packages/server-core && bun run typecheck`, redirected to a file and read whole:

```
$ tsc --noEmit
src/sessions/SessionManager.ts(6679,11): error TS2322: Type '{ memory?: … ; model: string; }'
  is not assignable to type 'PiChildRestrictionsV1'.
  Types of property 'tools' are incompatible.
    Type 'string[] | undefined' is not assignable to type 'string[]'.
      Type 'undefined' is not assignable to type 'string[]'.
```

**Exactly one error, and it names the blocker.** Reproduced independently of the sibling
lane's report. Probe reverted before the real work started.

## 2. Documentation — category (b), and the anchors were re-verified against the rendered page

Both anchors `curl`ed **without** `.md` and grepped for `id="…"` (2026-08-28, both `200`):

- `https://code.claude.com/docs/en/errors` → `id="agent-would-be-spawned-with-zero-tools"`
- `https://code.claude.com/docs/en/sub-agents` → `id="supported-frontmatter-fields"`

`errors.md#agent-would-be-spawned-with-zero-tools`, verbatim:

> "Omitting the `tools` field never triggers this refusal. If you leave the `tools` list
> empty, or `disallowedTools` removes every entry in it, Claude Code also skips the refusal
> and launches the subagent without tools."

and, from the same section's fix list:

> "Delete the `tools` field instead of listing tools to give the subagent every tool
> available to subagents"

`sub-agents.md#supported-frontmatter-fields`, the `tools` row, verbatim:

> "Inherits every tool available to subagents if omitted."

**Split of the two rows.** The SEMANTICS are `[doc:claude]` (and, because Pi is built to
Claude's docs with no separate contract, a double gap). The TRANSPORT SHAPE —
`PiChildRestrictionsV1` — is `[doc:none]`: no upstream page decides how the host carries a
hook-spawned agent's ceiling. Said explicitly, per the rule, rather than left silent.

## 3. What landed

### `packages/shared/src/agent/pi-harness/child-session-port.ts`

`tools: string[]` → `tools?: string[]`, with a doc block that states the **three** states the
type could previously only express two of (absent = inherit; `[]` = the empty set; a list =
that list, narrowed), carries both citations, names the two layers beneath that already read
absence as "no ceiling", and carries the WIRE + PERSISTENCE paragraph its optional neighbours
carry. **The migration direction is the easy one** — absent is the NEW state and every record
written before this change carries the key, so an old record parses unchanged and still means
what it meant. Confirmed there is no runtime validator of `restrictions.tools` in
`child-session-service.ts` that a missing key could trip.

### `packages/server-core/src/sessions/SessionManager.ts` — six sites, not two

1. **The producer** (`:6667`, `:6682`) — `: []` → `: undefined`, and `tools: declaredTools` →
   `...(declaredTools ? { tools: declaredTools } : {})`, the idiom `skillKeys` /
   `mcpServerKeys` / `memory` already use three lines below it.
2. **The port's validator** (`:13968`) — `input.restrictions.tools?.find(…)`. An absent list
   declares nothing to validate; every name an inheriting child ends up with came from a
   ceiling this same check cleared when the parent was admitted.
3. **The parent narrowing** (`:14175`) — was two cases, is now four, because request-ceiling
   and parent-ceiling are each present-or-absent. **Narrow-only is preserved**: absent +
   parent ⇒ the parent's list; absent + no parent ⇒ stays absent (unrestricted, which is what
   a top-level spawn already was); present ⇒ byte-identical to before.
4. **The skill-denial chokepoint** (`:14208`) — guarded on `grantedTools` (see §6, finding 3).
5. **The `memory:` grant** (`:14253`) — short-circuited on an absent ceiling. This one was a
   REAL hazard: the naive `[...(narrowedGrantedTools ?? []), ...memoryTools]` would have
   turned an unrestricted child into one that can touch **only** its memory file — a silent
   narrowing dressed as a grant. `writable` reads true for an absent ceiling, because no list
   means every tool, `write` and `edit` included.
6. **The record assembly** (`:14440`) — `tools,` → `...(tools === undefined ? {} : { tools })`,
   so "no ceiling" reaches the persisted record as an **omitted key** rather than a key
   holding `undefined`. Invisible to a reader, different to a persisted record.

### The three test files

- `SessionManager.plugin-hook-runners.test.ts` — **the pinned test is flipped, not deleted and
  not weakened.** Renamed from `P2.273 DEFECT pinned: …` to `an omitted \`tools:\` reaches the
  child as an omitted ceiling, not the empty set`; `toEqual([])` → `toBeUndefined()` **plus**
  `expect('tools' in …).toBe(false)`. Its doc comment now records that it landed asserting the
  defect on `1981a1470`, why, and that it was flipped in the same commit that made it compile —
  so the history stays legible instead of looking like a bug that was quietly reinterpreted.
  The `worktreePolicy` and receipt-`success` assertions are KEPT and re-commented: both values
  are unchanged and both are now honest, because the child arrives with a pool.
  The **authored-empty boundary test** gains `expect('tools' in …).toBe(true)` — it was
  non-discriminating before the fix (both shapes produced `[]`) and discriminates now.
- `SessionManager.orchestration.test.ts` — **one new test driving the REAL path** end to end
  (producer → the real `createPiChildSessionPort` → the admitted record), because the unit test
  above observes the producer through a recording port and cannot see any of the four sites the
  port itself reads the ceiling at. Two arms: no parent ceiling ⇒ the key is still absent on the
  record; a parent ceiling `['read','grep']` ⇒ the child holds **exactly that**, not a wider
  list and not `[]`. This is the "at least one test must exercise the real path" rule; the
  recording port is precisely a double that would go green with and without the behaviour.
- `child-session-service.test.ts` — one non-null assertion (`record.restrictions.tools!.push`).
  Forced by the type change; see the scope note in §7.

## 4. Prove-by-breaking, against the absolute SHA

Re-broke **only the producer** back to `f8d4d5056`'s exact two lines (verified by
`git show f8d4d5056:… | awk 'NR==6667 || NR==6682'` before mutating), ran the three-file zone
suite, then reverted surgically (python string replace with a `count == 1` assertion, never a
file copy, so a concurrent lane's edit could not be clobbered):

```
(fail) SessionManager effectful plugin hook runners > an omitted `tools:` reaches the child
       as an omitted ceiling, not the empty set [0.56ms]
  expect(received).toBeUndefined()   Received: []
(fail) SessionManager Pi child orchestration composition > admits a plugin-hook agent that
       omits `tools:` with an inherited ceiling, never the empty set [5.76ms]
  expect(received).toBeUndefined()   Received: []
 86 pass  2 fail   Ran 88 tests across 3 files. [1169.00ms]
```

**Exactly the two tests that should die, die — and the authored-empty boundary test survives**,
which proves the two shapes are observed on different branches and that neither test is
vacuous. Both failures land at sub-millisecond/6 ms in a 1.17 s run, i.e. the real-failure mode,
not the ≥10 s load-artefact mode.

## 5. Gates — with proof of work, not exit statuses

Every gate redirected to a file and read whole; nothing piped to `head`/`tail` before its size
was known.

| Gate | Result |
| --- | --- |
| `bun scripts/bun-test-lock.ts run --label P2.301-final -- bun test` on the three zone files | **`88 pass  0 fail  415 expect() calls — Ran 88 tests across 3 files`** (was 86/0/… before this row) |
| Wider affected set — the 7 test files matching `createPiChildSessionPort\|startPiChildRuntime\|pluginAgentHookRunner` + `child-session-service.test.ts` | **`193 pass  1 fail  790 expect() calls — Ran 194 tests across 8 files`**. The one failure is `SessionManager Pi process owner > applies hook permission policy and records only redacted supervised receipt metadata`, and it is a **load artefact**: the message is `this test timed out after 5000ms` at **17413 ms**, and the file alone runs **`42 pass  0 fail  233 expect() calls — Ran 42 tests across 1 file [6.79s]`**. Not attributed to this change; not added to the known-failing register (another lane owns that file). |
| `cd packages/server-core && bun run typecheck` | **`$ tsc --noEmit`, zero diagnostic lines** (whole output was the echoed command) |
| `cd packages/shared && bun run tsc --noEmit --extendedDiagnostics` | **`Files: 3271, Types: 420656, Check time 7.98s`, zero `error TS` lines** on the run taken with my change and before another lane's edit landed. A later run showed one error — `src/agent/pi-harness/permission-dsl.test.ts(535,22)` — inside a **130-line block another lane added in the working tree** (`git diff --stat` on that file: `1 file changed, 130 insertions(+)`; the line does not exist at HEAD). Not mine, not in my commit. |
| `cd packages/pi-agent-server && bun run typecheck` | **exit 0**, `check:surface` printed its `6/6 match live source` pin line |
| `npx eslint -f json` from `packages/server-core` (4 files) and from `packages/shared` (1 file) | **`errorCount: 0, warningCount: 0` on each of the 5**, each row carrying its own `filePath` — proof the files were processed, since a zero-byte pass proves nothing |
| `git diff --check` on the five paths | clean, exit 0 |
| scope | `git show --stat --oneline e5c85f138` → exactly my 5 files. Other lanes' dirty files (`permission-dsl.test.ts`, and earlier `routed-client.ts`, `removal-circuit-breaker.*`, `channels.ts`, `routing.ts`) are NOT in the commit. Committed by explicit pathspec; no `git add`, no `-a`. |
| `Co-Authored-By` | absent (grepped the committed message; exit 1) |
| full repo typecheck / lint / test, builds, packaging, live smoke | **NOT RUN** — verification-wave work, outside this row's budget |

## 6. Findings — each tagged, each with its kind

1. **`[doc:claude]` — forgotten against the documentation. FIXED.** An omitted `tools:` on a
   plugin-hook agent was spawned as the empty set, contradicting
   `errors.md#agent-would-be-spawned-with-zero-tools` and
   `sub-agents.md#supported-frontmatter-fields`. Pi is built to Claude's docs, so this was a
   double gap. Landed in `e5c85f138`.

2. **`[doc:none]` — never-looked-at. FIXED.** `PiChildRestrictionsV1` could not express
   "inherit": `tools` was a required `string[]` while every other optional restriction in it
   uses absence for exactly that meaning, and both layers beneath already read absence as
   "no ceiling". Landed in the same commit.

3. **`[doc:claude]` — never-looked-at. OPEN, and it is the honest cost of this fix.** A skill's
   `disallowed-tools` has **no representation on this wire for a ceiling-less child**: the
   ceiling is a positive NAME list, which cannot say "everything except X", so the host-side
   chokepoint at `SessionManager.ts:14208` has nothing to subtract from when the ceiling is
   absent. Reachable only for an agent that declares `skills:` whose skill carries
   `disallowed-tools` **and** omits `tools:`; a declared ceiling narrows exactly as before.
   I did **not** paper over it — the alternative is to enumerate the pool host-side, which is a
   second hand-written copy of Pi's inherit rule and would trade an unnarrowed pool for a
   silently narrowed child, the exact trade the sibling lane rejected. **NOT measured either
   way, and the comment in the code says so:** `BaseAgent.applySkillInvocationDeniedTools`
   (`base-agent.ts:4045-4058`) passes `denied` to the child's own `PrerequisiteManager`
   **regardless** of whether it knows a universe (`universe?.filter` is used only to decide
   `mayRemoveEndConversation`), so the removal may well survive at the child's own gate — but
   whether the child's preloaded skills produce invocation records there was outside this row's
   reach to measure. **This deserves a row and a measurement, not an assumption in either
   direction.**

4. **`[doc:none]` — bug in a recorded measurement. The blast radius was UNDER-counted, and the
   brief repeated it.** The row (and `p2273-report.md` §3) said the readers were "three, all
   inside `SessionManager.ts`" / "all in the lane's own test file". Measured by making the
   field optional and typechecking: **four** compile sites, and one of them is in a **different
   file** — `packages/server-core/src/pi-harness/child-session-service.test.ts:316`
   (`record.restrictions.tools.push('write')`, on a `PiChildSessionRecordV1`). The sibling lane
   flagged its own number as static and untypechecked and told me to verify it; the brief then
   restated it as measured. Two further reader classes were verified NOT to break:
   `spawner.test.ts` / `SessionManager.orchestration.test.ts` read it only through
   `expect(...).toEqual(...)`, which accepts `undefined`; `runtime-skill-content.ts:614` guards
   on truthiness already and is a different `restrictions` type.

5. **`[doc:none]` — never-looked-at, and I would rank it above the ternary for danger.** The
   `memory:` grant at `SessionManager.ts:14253` is a **silent-narrowing trap** for anyone who
   makes this field optional carelessly: the reflexive `[...(narrowedGrantedTools ?? []),
   ...memoryTools]` compiles, typechecks, passes every existing test, and hands an
   *unrestricted* child a ceiling containing **only** its three memory tools. Handled here
   (the grant short-circuits on an absent ceiling, and `writable` reads true), but it is worth
   recording because nothing in the tree would have caught it.

6. **`[doc:none]` — forgotten documentation, OUT OF MY ZONE, needs a row.** The `KNOWN GAP 2`
   doc comment on `narrowRuntimeSkillTools`
   (`packages/shared/src/capabilities/runtime-skill-content.ts`, around `:1601-1614`) now
   states something **false**: "`PiChildRestrictionsV1.tools` is required so the route cannot
   express 'inherit' by omission — it has to send the parent's list", and "NOT fixed by this
   row … Note the route is UNTESTED for that shape: every fixture in
   `SessionManager.plugin-hook-runners.test.ts` declares `tools`." All three clauses are now
   untrue. That file is **not in my zone**, and per the standing rule I stopped rather than
   reached across — but this is precisely the "stale claim a reader will believe" shape, and it
   should be corrected soon. `docs/architecture/extension-first-pi-agent-runtime.md:437` and
   `docs/superpowers/plans/2026-07-29-fork-subagents.md:190` also describe the old required
   shape and are likewise out of zone.

7. **`[doc:none]` — verdict, recorded so it is not re-asked.** `pi-agent-server`'s
   `spawner.ts` composes `PiChildRestrictionsV1` at two sites and **always** supplies `tools`
   (`:551` `tools: [...tools]`, `:808` `tools: allowedTools(args.agentDef)`), so the
   model-driven spawn route is unchanged by this row — absence arises only from the plugin-hook
   producer today. `child-session-service.ts` performs **no** validation of
   `restrictions.tools`, so an omitted key persists and re-parses without a migration.

## 7. Scope notes and concerns

- **One file is arguably at my zone's edge:** `packages/server-core/src/pi-harness/
  child-session-service.test.ts`. It is a *test alongside* the changed type (my zone says
  "tests alongside these"), it is in the same package, it was clean in the working tree, and
  the change is a single non-null assertion forced by making the field optional — leaving it
  out would have shipped a package that does not typecheck. Flagging it rather than burying it.
- **Neither prohibition was violated.** No throw was re-added at the admission gate, and no
  producer-side refusal was added. My measurements gave me no reason to think either is right,
  so there is nothing to escalate on that front.
- **Finding 3 is the one thing I would not want quietly closed with this row.** It is a real,
  if narrow, expressiveness gap that this fix creates, its resolution turns on a measurement
  nobody has taken, and the code comment states it as an open question rather than as a
  verdict. It wants its own row.
- **The wider-set green is 193/1, not 194/0**, and the 1 is a 5 s timeout that passes in
  isolation (42/0). Recorded as a load artefact with the evidence, not silently dropped — but
  it is an attribution, and attributions can be wrong.
- **Not run, and named as such:** full-repo `typecheck:all`, root `bun test`, lint over the
  repo, any build or packaging, any live/CDP evidence. This row changes a host-side transport
  shape and a producer; a packaged-build smoke of a plugin-hook agent that omits `tools:`
  would be the live confirmation, and it belongs to a verification wave.
- The plan file `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` was **not**
  touched — the controller pins tracker rows.
