# P2.127 — a backslash in a project `.claude` pattern bricks the native layer

**Status:** DONE. Commit `1e2aa4438` on `feat/TCODE-000`, two files, 329
insertions / 15 deletions, verified by `git show --stat --oneline HEAD` to
contain exactly my files and nothing from another lane. No `Co-Authored-By`
trailer. Zone tests **55 pass / 0 fail / 306 expect() / 489 ms** across both
files.

---

## 1. Reproduced on HEAD, before any edit

Base: `0112ed9c9`. Probe: a project `.claude/settings.json` block with the row's
pattern plus a co-resident allow, compiled through the real path
(`parsePermissionsJson` → `permissionsConfigCache.getMergedConfig` →
`evaluatePermissionDslV1`), not a hand-built DSL document.

```
{"label":"control-healthy","entry":"Read(/secrets/**)","docRules":2,"compiledRules":2,
 "diagnostics":[],"invalidSource":null,"coResidentAllow":"allow","ruleId":"claude-settings-allow-0"}
{"label":"backslash-source-anchor","entry":"Read(/a\\b)","docRules":2,"compiledRules":0,
 "diagnostics":["invalid-document"],"invalidSource":"project","coResidentAllow":"deny","ruleId":"invalid-policy"}
```

Every claim in the row is confirmed, in the same order it makes them:

| Row's claim | Measured |
| --- | --- |
| the native layer throws `invalid pathGlob pattern` | thrown at `permission-dsl.ts` `compileMatcher`, `case 'pathGlob'`, on `pattern.includes('\\')` |
| the per-layer catch sets `invalidSource` | `invalidSource: {scope:'project'}`, diagnostic `invalid-document` |
| the whole layer collapses to deny-everything | 0 of 2 rules compiled; the co-resident `allow:['Bash(ls:*)']` evaluated `ls -la` → **`deny`**, `ruleId: 'invalid-policy'` |
| silently | the only record is one generic `invalid-document` diagnostic that names no rule and reaches the user only as the reason attached to the denial of *every* call |

**What the user sees today:** every tool call refused, attributed to a rule id
they never wrote (`invalid-policy`), with the message "Permission DSL document
is invalid." Nothing names the offending entry. The tool list is empty too —
`filterCapabilityIdentitiesByWholeToolDeny` returns nothing on `invalidSource`,
so the tools also vanish from the model's context.

---

## 2. The step the row asked for first: which pattern classes reach this throw

**The row names one. Twenty-two entries reach it, spanning nine distinct
predicates over seven matcher kinds.** The backslash is not special, and the
`/` anchor is not special — a fix written in the `pathGlob` branch against
`includes('\\')` would have closed the row and left twenty-one live paths to the
same collapse.

Measured by driving each entry through the real project-settings path and
checking `invalidSource` (probe:
`scratchpad/sdd2/probe-enumerate.ts`; positive control = a healthy layer, which
is the one row that did not brick).

### Reached by a matcher predicate — 22 of 22 bricked on HEAD, 22 of 22 survive after the fix

| # | Class | Example entry | Rejected by |
| --- | --- | --- | --- |
| 1 | backslash, settings-source anchor — **the row's case** | `Read(/a\b)` | `pathGlob`: `pattern.includes('\\')` |
| 2 | backslash, absolute anchor | `Read(//a\b)` | same |
| 3 | backslash, home anchor | `Read(~/a\b)` | same |
| 4 | backslash, relative anchor | `Read(a\b)` | same |
| 5 | a Windows path — **the row's user story** | `Read(C:\Users\alice\.env)` | same |
| 6 | `Edit`, same matcher as `Read` | `Edit(/a\b)` | same |
| 7 | still `/`-led after the anchor strips | `Read(~//x)` | `pathGlob`: `pattern.startsWith('/')` |
| 8 | NUL byte | `Read(/a\u0000b)` | `pathGlob`: `pattern.includes('\0')` |
| 9 | pattern over 1024 chars | `Read(/aaa…)` | `bounded(…, 1024)` |
| 10 | `cdPath` backslash | `Cd(/a\b)` | `cdPath`: `includes('\\')` |
| 11 | `cdPath` still `/`-led | `Cd(~//x)` | `cdPath`: `startsWith('/')` |
| 12 | `cdPath` NUL | `Cd(/a\u0000b)` | `cdPath`: `includes('\0')` |
| 13 | `cdPath` over 1024 | `Cd(/aaa…)` | `bounded(…, 1024)` |
| 14 | Bash pattern over 1024 | `Bash(aaa…)` | `bounded('bash pattern', 1024)` |
| 15 | PowerShell pattern over 1024 | `PowerShell(aaa…)` | `bounded('powershell pattern', 1024)` |
| 16 | bare tool name over 256 | `aaa…` (300 chars) | `bounded('semanticId')` |
| 17 | MCP server over 256 | `mcp__aaa…__tool` | `bounded('server')` |
| 18 | MCP tool over 256 | `mcp__srv__aaa…` | `bounded('tool')` |
| 19 | Agent name over 256 | `Agent(aaa…)` | `bounded('agent')` |
| 20 | WebFetch domain over 256 | `WebFetch(domain:aaa…)` | `bounded('host')` |
| 21 | parameter name over 128 | `Foo(aaa…:v)` | `bounded('parameter name', 128)` |
| 22 | parameter glob over 256 | `Foo(p:*aaa…)` | `bounded('parameter matches', 256)` |

Each of 1–22 produced, on HEAD: `compiled=0`, `invalidSource=project`,
co-resident allow → `deny`. After the fix each produces `compiled=2` and no
`invalidSource`.

Notes worth recording:

- **The row's framing "a backslash in a `/`-anchored pattern" is narrower than
  the defect.** The backslash check does not consult the anchor at all, so all
  four anchors brick identically (rows 1–4). The `/` anchor is incidental.
- **`Read(C:\Users\alice\.env)` is exactly what a Windows user writes**, and
  `permissions.md § Read and Edit` tells them not to — "On Windows, paths are
  normalized to POSIX form before matching. `C:\Users\alice` becomes
  `/c/Users/alice`, so use `//c/**/.env` to match `.env` files anywhere on that
  drive." So the pattern is genuinely wrong; the failure mode was the problem.
- **Length classes (9, 13–22) are reachable because the rule-string cap is 2048
  and the matcher caps are 1024/256/128.** Not a plausible hand-written entry,
  but a generated or pasted one, and they collapse the policy exactly as
  loudly as the backslash.

### Reached by a document-level predicate — still fails the layer closed, deliberately

| Class | Example | Predicate |
| --- | --- | --- |
| more than `MAX_PERMISSION_DSL_RULES` (512) rules in one settings file | 513 entries | `document.rules.length > 512` |
| an unknown matcher kind, or an unknown field on a matcher | `{kind:'substring'}` in a native DSL document | `default:` / `exact()` — messages containing `unknown` |
| a rule whose `id` is unreadable | (not writable from a settings file — ids are generated) | `bounded(rule.id, 128)` |
| a rule whose `action` is not allow/ask/deny | (not writable from a settings file) | `action` check |

These are **out of the per-rule catch on purpose** and are pinned by a test.
A rule count is a property of the document, not of any one rule; a rule whose
id or action cannot be read can neither be named in a warning nor given a
direction to fall back to; and an unknown matcher kind does not mean one
specifier was written wrong — it means the document speaks a vocabulary this
compiler does not have, so salvaging the rules it happens to recognize would
enforce a policy nobody wrote. That is the same reasoning
`managed-policy.ts:tolerantPermissionDsl` already records for a document
stamped with another DSL version ("reading v2 rules with the v1 parser would
invent a policy nobody wrote"), and it is what keeps `permission-dsl.test.ts`'s
existing `fails closed for unknown matchers, invalid documents and stale
generations` assertion true without editing a file outside my zone.

**None of the 22 classes reach the `unknown` path** — re-measured after adding
the exception: still 22 of 22 surviving, 2 of 2 document-level bricking.

**This means one class from the enumeration is NOT fixed by this row**: a
project settings file with more than 512 permission entries still collapses to
deny-everything. It is real but it is not the row's defect, and closing it
safely means deciding *which* 512 to keep — which for deny rules is the
widening direction. Flagged for the controller rather than done here.

---

## 3. Documentation classification

### (b) — upstream contract, and it is decisive

**`managed-settings.md#find-entries-claude-code-dropped`** (the section also
publishes an explicit `<span id="invalid-entries-in-managed-settings" />`;
anchors taken by curling the rendered page and grepping `id="…"`, per the lane
rule). Verbatim:

> "When a managed settings file, MDM profile, registry value, or server-managed
> payload fails schema validation, Claude Code first skips the individual
> entries it can repair, such as one invalid permission rule, with a warning for
> each, then drops any top-level key whose value still fails and keeps enforcing
> every remaining valid key."

That sentence names **"one invalid permission rule"** as the unit that gets
skipped-with-a-warning while the remaining valid keys stay enforced. Our native
layer did the opposite, so this is not a judgement call about the fix direction
— the row's fix direction is what the page already specifies.

The same section reserves whole-file rejection for a different failure:

> "A managed settings file or drop-in file that isn't valid JSON contributes no
> settings at all; Claude Code reports it with the other validation errors and
> reads the remaining sources as usual."

Three more sentences on the same posture, from
**`permissions.md#match-by-input-parameter`**, **`#tool-name-wildcards`** and
**`#read-and-edit`** — in each, one unusable rule is warned about and skipped
while the file keeps working:

> "A rule like `Bash(command:rm *)` would be bypassable by a compound command,
> so Claude Code ignores it and emits a startup warning."

> "An unanchored allow glob such as `"*"`, `"B*"`, or `"mcp__*"` is skipped with
> a warning and doesn't auto-approve anything."

> "Claude Code checks file permissions against `Edit(path)` and `Read(path)`
> rules only. If you write a path rule for `Write`, `NotebookEdit`, `Glob`, or
> the legacy `MultiEdit` tool instead, Claude Code accepts the rule but never
> consults it, and warns at startup"

And the pattern syntax the row's case violates,
**`permissions.md#read-and-edit`**:

> "On Windows, paths are normalized to POSIX form before matching.
> `C:\Users\alice` becomes `/c/Users/alice`, so use `//c/**/.env` to match
> `.env` files anywhere on that drive. To match across all drives, use
> `//**/.env`."

Also cited in code, unchanged from before:
**`permissions.md#cd`** — "Adding any `Cd` allow rule switches `/cd` to
allowlist mode".

Anchor spellings were taken from the rendered pages
(`curl https://code.claude.com/docs/en/<page> | grep -o 'id="[^"]*"'`), not
derived from a slug rule.

### (a) — our own, no upstream page governs it

- The per-layer `try`/`catch` and `invalidSource` are entirely ours. No page
  describes a "layer" or an `invalidSource`; the collapse is an artefact of
  where we put the catch.
- `MAX_PERMISSION_DSL_RULES = 512` and every `bounded()` cap (1024 / 256 / 128)
  are ours. Classes 9 and 13–22 above exist only because of our caps.
- The reserved `invalid-policy` rule id and the `CompiledMatcher` union are ours.

---

## 4. The fix

One file: `packages/shared/src/agent/pi-harness/permission-dsl.ts`.

`compilePermissionDslV1` now catches around **`compileMatcher` per rule**
instead of around the whole layer. The rule's `id` and `action` are still read
*outside* that catch (they are structure, not specifier — see §2's second
table). A rule whose matcher will not compile becomes
`{ kind: 'unparseable', action, reason }`, which `matchesRule` matches against
**every** request, and a `unparseable-rule` diagnostic is raised naming the rule
id, the action, and the compiler's own reason.

### Decision 1 — malformed **deny** rules: NOT dropped

**Chosen: an uncompilable `deny` (or `ask`) rule keeps deciding, at its own
action, over everything.** It is never skipped.

Rationale, in the mandated direction: a deny rule matched some set of requests;
the part that would have bounded that set is precisely the part that failed to
parse, so no request can be shown to fall outside it. The only sound
over-approximation is "everything". Skipping it would hand back permission the
user wrote a rule to withhold, and the widening would be invisible — the one
direction this fix must not take.

Consequences, stated plainly:

- On the **effective verdict for the row's headline case** (`deny` +
  a Windows path), the user is no better off than before: everything is still
  denied. That is the price of the non-widening constraint and I did not trade
  it away.
- What *does* change for a malformed deny: the rest of the layer's rules are
  compiled and present in `program.rules` (before: zero rules); the diagnostic
  names the offending rule instead of saying "Permission DSL document is
  invalid"; and the failure is scoped to a rule rather than to the program's
  `invalidSource`, which every consumer reads globally.
- `ask` behaves the same way at its own action: prompts on everything. Never
  grants, so it cannot widen.

A narrower substitute was considered and rejected: bounding the fallback to the
matcher kind's own surface (a bad `pathGlob` denying only path-carrying calls, a
bad `bashPattern` only Bash). It is meaningfully better for the user, but each
per-kind predicate is a chance to under-approximate, and an under-approximation
here is exactly the silent widening the row forbids. It is a clean follow-up
with its own measurement per kind; it is not something to ship untested inside
a fix for a widening bug.

### Decision 2 — malformed **allow** rules: dropped, and it announces itself

An `allow` rule that will not compile can only ever have granted, so losing it
narrows the policy — the safe direction, and the one the upstream page takes
for every action. It is held out of selection entirely and can never grant.

**Where the warning reaches the user.** A dropped allow decides nothing, so on
its own it would announce nothing. It therefore reports itself on the very
request it would have cleared: when no other rule decided, the evaluation
returns `match.ruleId: 'invalid-policy'` plus the `unparseable-rule` diagnostic
and **no action**. `invalid-policy` is the reserved id that already means "this
verdict belongs to no rule the user wrote", and three consumers outside this
module already act on it:

- `SessionManager.ts:3671` (Monitor gate) — hands the call to the human and
  logs `evaluation.diagnostic?.message`, which now names the rule;
- `codex-agent.ts:1899` — same, on the answer path;
- `claude-permission-rules.ts:271` (`evaluateClaudeHookIfFilter`) — fails the
  hook filter **open**, which is its documented contract.

That third one is load-bearing and is why the degraded rule reports
`invalid-policy` rather than its own id. `evaluateClaudeHookIfFilter` compiles a
**one-rule `allow`** program and reads that id to detect an uncompilable rule.
A plain drop would have left it with an empty program, no match, and
`run: false` — silently breaking the documented fail-open. There is a test.

### Decision 3 — the fail-closed reach is kept consistent in all four surfaces

`invalidSource` is read in four places, and a rule-scoped degradation has to
reproduce each or it leaks:

| Surface | Treatment |
| --- | --- |
| `evaluatePermissionDslV1` | deny/ask decide over everything; allow never grants |
| `evaluateCdPermissionDslV1` | `isCdRule`/`matchesCdRule` admit it: deny → `deny`, ask → `prompt`. An uncompilable Cd **allow** still switches allowlist mode on and still cannot be the allow that satisfies it → `{decision:'deny', allowlistRefusal:true}`, the restrictive reading of `permissions.md#cd` |
| `isWholeCapabilityDeniedByPermissionDsl` | an uncompilable deny → `true` |
| `filterCapabilityIdentitiesByWholeToolDeny` | an uncompilable deny removes every tool from context (EndConversation exception preserved), honouring that function's own contract that "a tool the gate denies in every possible call must not [stay advertised]" |

Measured shapes (probe `scratchpad/sdd2/probe-shape.ts`, entry
`Read(C:\Users\alice)`):

```
### deny   rules: claude-settings-deny-0[unparseable]
  evaluation: {"action":"deny","ruleId":"invalid-policy","diag":"unparseable-rule"}
  cd: {"decision":"deny",...}   wholeDeny: true    advertised: 0
### ask    evaluation: {"action":"ask","ruleId":"invalid-policy","diag":"unparseable-rule"}
  cd: {"decision":"prompt",...} wholeDeny: false   advertised: 1
### allow  evaluation: {"ruleId":"invalid-policy","diag":"unparseable-rule"}   (no action)
  cd: {"decision":"deny","allowlistRefusal":true}
### allow-lost + a co-resident allow that matches → {"action":"allow","ruleId":"claude-settings-allow-1"}
### allow-lost + a deny elsewhere               → {"action":"deny","ruleId":"claude-settings-deny-0"}
```

---

## 5. Findings the controller should record

1. **The row's pattern class is one of 22, not one.** §2. A fix scoped to the
   backslash would have closed the row with 21 live paths to the same collapse.
2. **The `/` anchor is incidental** — all four anchors brick on a backslash.
3. **One enumerated class is deliberately left open**: a project settings file
   with more than 512 permission entries still collapses the layer. Closing it
   requires deciding which 512 survive, which for deny rules is the widening
   direction.
4. **A doc-vs-mandate tension, deliberately resolved toward the mandate.**
   `managed-settings.md#find-entries-claude-code-dropped` skips an invalid
   permission rule *whatever its action*, and the same page's `deniedMcpServers`
   row spells out the reasoning against over-denying: "A wholly invalid value is
   dropped with a warning, since denying every server would block servers the
   policy never named." **Two in-repo precedents agree with the page and
   disagree with what I shipped**: the importer
   (`claude-setup-import.ts`, drops with a named warning, any action) and the
   managed-policy loader (`managed-policy.ts:tolerantPermissionDsl`, drops the
   individual rule via `sink.drop(...)`, any action). I followed the dispatch's
   explicit non-widening mandate instead. **If the controller prefers alignment
   with upstream and the two siblings, the flip is one branch** — make the
   `catch` in `compilePermissionDslV1` `continue` for every action instead of
   substituting, and delete the `unparseableAllow` handling in the evaluator
   (keeping some `invalid-policy` signal for the hook-`if` contract, which is
   the only thing that makes the drop non-trivial).
5. **`evaluateClaudeHookIfFilter`'s fail-open contract is coupled to
   `invalid-policy` through a one-rule allow program.** Any future change to how
   uncompilable rules are represented must keep that id reachable, or hooks
   silently stop running. Not obvious from either file; now pinned by a test.
6. **`managed-policy.ts` is untouched.** It tolerates per rule via
   `parsePermissionDslV1`, which this change does not modify.

---

## 6. Gate — what each command proves

Run under the shared-tree mutex where required. The host's `/usr/bin/git` and
`/usr/bin/python3` are Xcode-licence-blocked on this machine (an environmental
break the coordinator confirmed mid-run, not a finding); every git invocation
below used `/opt/homebrew/bin/git` 2.43.0.

| Command | Contract it proves | Result |
| --- | --- | --- |
| `bun scripts/bun-test-lock.ts run --label P2.127 -- bun test permission-dsl.test.ts claude-project-settings-permissions.test.ts` | the compiler's own contract (existing suite, unmodified) AND the new per-rule behaviour | **55 pass, 0 fail, 306 expect(), 489 ms, 2 files** |
| `bun run typecheck:shared` | the new `CompiledMatcher` variant is exhaustively handled everywhere the union is switched on | clean |
| `bunx eslint` on both changed files (from `packages/shared`) | style/lint | exit 0 |
| `git diff --check` on both changed files | no whitespace damage | exit 0 |
| `probe-enumerate.ts` before/after | the 22-class enumeration in §2 | 22/22 bricked before, 22/22 survive after |
| `probe-shape.ts` | the per-action evaluation, Cd, whole-tool-deny and advertisement shapes in §4 | as tabulated |

**Not run, and why:** the full repo suite. The implementation-first budget
confines the loop to focused tests for changed behaviour and affected-package
typechecks. `permission-dsl.ts` has no wire/schema/migration surface and its own
suite plus the settings suite are the direct contract tests. Nothing was
cancelled or skipped mid-run.

I did **not** need to edit `permission-dsl.test.ts` (which is outside the zone
the brief names). That was not luck — it is why unknown matcher kinds stayed
layer-fatal; see §2. Its three `invalid-policy` assertions all still hold: two
of them are `deny` rules, which under this change still decide `deny` under the
reserved id.

One cosmetic staleness left behind, for whoever owns that file: at
`permission-dsl.test.ts` the comment "a source-anchored rule without one fails
the layer closed" is now half-true — it fails the RULE closed. The assertion
beneath it is unchanged and green.

## 7. Proving the fix by breaking it

The implementation file was reverted to HEAD **under the mutex**, with the new
tests kept, then restored inside the same locked command so the shared tree was
never left inconsistent for another lane.

Result: **28 of the 30 new tests fail without the fix** — `12 pass, 28 fail, 69
expect() calls, Ran 40 tests across 1 file`. The full list, from the run itself
(the first attempt's `tail` truncated it, so it was re-run capturing everything
rather than inferring the remainder):

```
 1  backslash, settings-source anchor (the row's case): the layer survives it
 2  backslash, absolute anchor: the layer survives it
 3  backslash, home anchor: the layer survives it
 4  backslash, relative anchor: the layer survives it
 5  a Windows path, which is the user story: the layer survives it
 6  Edit carries the same matcher as Read: the layer survives it
 7  a pattern still `/`-led after the anchor strips: the layer survives it
 8  a NUL byte in the pattern: the layer survives it
 9  a pathGlob pattern over 1024 chars: the layer survives it
10  cdPath backslash: the layer survives it
11  cdPath still `/`-led after the anchor strips: the layer survives it
12  cdPath NUL byte: the layer survives it
13  cdPath pattern over 1024 chars: the layer survives it
14  a Bash pattern over 1024 chars: the layer survives it
15  a PowerShell pattern over 1024 chars: the layer survives it
16  a bare tool name over 256 chars: the layer survives it
17  an MCP server name over 256 chars: the layer survives it
18  an MCP tool name over 256 chars: the layer survives it
19  an Agent name over 256 chars: the layer survives it
20  a WebFetch domain over 256 chars: the layer survives it
21  a parameter name over 128 chars: the layer survives it
22  a parameter glob over 256 chars: the layer survives it
23  the surviving rules still decide — a lost ALLOW does not take the others down
24  the warning reaches the user on the very request the lost allow would have cleared
25  an uncompilable ALLOW never grants, and a real deny still outranks it
26  an uncompilable DENY does not silently widen the policy
27  an uncompilable ASK prompts rather than granting
28  the Cd evaluator keeps the same posture — it has its own rule filter
```

Representative failure text under the revert:

```
25: Expected: "claude-settings-deny-0"   Received: "invalid-policy"
26: Expected to contain: "claude-settings-deny-0"
    Received: "Permission DSL document is invalid."
27: Expected: "ask"     Received: "deny"
28: Expected: "prompt"  Received: "deny"
```

The **two that pass with and without the fix are the two that should**, and I
checked that rather than assuming: `the hook 'if' filter still fails open on a
rule that cannot compile` and `a DOCUMENT-level failure still fails the layer
closed`. Both pin behaviour this change deliberately preserves, so passing on
both sides is the correct signal, not a dead assertion. Neither of them uses a
double that drops the argument under test — the hook test drives the real
`evaluateClaudeHookIfFilter` in `claude-permission-rules.ts` and carries a
positive control (a rule that *does* compile still gates, both ways).

## 8. Scope

- Edited: `packages/shared/src/agent/pi-harness/permission-dsl.ts`,
  `packages/shared/src/agent/__tests__/claude-project-settings-permissions.test.ts`.
- **Not** edited, and not needed: `claude-setup-import.ts` (P2.9's), the
  prompt/fence files, `codex-agent.ts`, `permissions-config.ts`,
  `claude-permission-rules.ts`, the plan file, the known-failing register.
- The fix did not require reaching outside the zone. `claude-permission-rules.ts`
  and `codex-agent.ts` both special-case `invalid-policy`; the design preserves
  that id precisely so neither needed a change.
- The lanes holding `codex-agent.ts` and `packages/shared/src/prompts/` were not
  touched. `codex-agent.ts` was read only, to confirm its `invalid-policy`
  handling survives.
- Committed by explicit pathspec, never `git commit -a`. The tree was verified
  byte-identical to the intended state immediately before committing (the
  revert-probe restores its backup inside the same locked command, and
  `diff -q` confirmed it), and `git show --stat --oneline HEAD` afterwards.

## 9. Environmental note

Mid-run, this machine's Xcode licence stopped being accepted, so `/usr/bin/git`
and `/usr/bin/python3` fail on every invocation with "You have not agreed to the
Xcode license agreements." I hit it on `git diff --check` and switched to
`/opt/homebrew/bin/git` 2.43.0 before drawing any conclusion; the coordinator
independently confirmed it is environmental. **No command's failure in this
report is attributable to it** — every git result quoted here was produced by
the Homebrew binary, and no commit was attempted before the switch, so nothing
partially applied.

Separately: the `bun test` mutex was contended for the whole session (P2.226-wave
held it ~25 minutes, then p2136 / p2260-probe-namecheck / NCA-wiring / review in
succession), so each of the three test runs queued for a long time. That is
queueing, not slowness in my tests — the zone run itself took 489 ms. I did not
touch the mutex or reap another lane's hold, and I did not raise any timeout
ceiling.
