# P2.270 — drop a malformed permission rule whatever its action (OQ-8)

**Status:** DONE. Commit `4d4bd82a1` on `feat/TCODE-000`, three files, 233
insertions / 151 deletions, verified by `git show --stat --oneline HEAD` to
contain exactly my files and nothing from another lane. No `Co-Authored-By`.
Zone tests on the **committed** content: **56 pass / 0 fail / 400 expect() /
584 ms** across both files.

---

## 1. The premises hold — and one is stronger than the brief claimed

Classification: **(b) upstream contract.** Anchors taken by curling the
**rendered** pages and grepping `id="…"`, never derived from a slug rule.

`curl -s https://code.claude.com/docs/en/managed-settings | grep -o 'id="[^"]*"'`
returns both `id="find-entries-claude-code-dropped"` and the explicit
`<span id="invalid-entries-in-managed-settings" />`. The brief's cited sentence
is verbatim correct:

> "When a managed settings file, MDM profile, registry value, or server-managed
> payload fails schema validation, Claude Code first skips the individual
> entries it can repair, such as one invalid permission rule, with a warning for
> each, then drops any top-level key whose value still fails and keeps enforcing
> every remaining valid key."

**The correction worth reporting: that sentence is about MANAGED sources, and
our defect is a project `.claude/settings.json`.** The page closes the same
section with a sentence that covers our surface directly, under
`managed-settings.md#keys-that-fail-closed` (anchor confirmed present):

> "This tolerance applies only to managed settings. User, project, and local
> settings files remain strict: a file whose JSON or top-level shape fails
> validation is rejected as a whole and reported, and an individual entry that
> fails, such as a malformed permission rule, is skipped with a warning while
> the rest of the file applies."

That is the contract for this row, and it is unqualified by action. The
brief's characterisation was right; its citation was one paragraph short of the
strongest form. **This strengthens the settled decision — it does not reopen
it.**

The anti-over-denying argument, same page, `deniedMcpServers` row:

> "A wholly invalid value is dropped with a warning, since denying every server
> would block servers the policy never named."

Corroboration that skip-with-warning is the house posture, from
`permissions.md#match-by-input-parameter` and `#tool-name-wildcards` (both
anchors confirmed on the rendered page):

> "A rule like `Bash(command:rm *)` would be bypassable by a compound command,
> so Claude Code ignores it and emits a startup warning."

> "An unanchored allow glob such as `"*"`, `"B*"`, or `"mcp__*"` is skipped with
> a warning and doesn't auto-approve anything."

**(a) our own, no upstream page governs it:** the per-layer catch and
`invalidSource`; `MAX_PERMISSION_DSL_RULES` and every `bounded()` cap; the
reserved `invalid-policy` id; the `CompiledMatcher` union.

---

## 2. What changed

One implementation file, `packages/shared/src/agent/pi-harness/permission-dsl.ts`.

**The `unparseable` matcher kind is deleted.** It is not a marker, not an
internal placeholder, not a kind that evaluates — `git show HEAD:… | grep -c
"kind: 'unparseable'"` returns **0**. A rule whose matcher will not compile is
`continue`d out of the compile loop and never enters `program.rules`.

Consequently, and all measured by the tests below, a skipped rule:

| Surface | Before (`1e2aa4438`) | Now |
| --- | --- | --- |
| `evaluatePermissionDslV1` | deny/ask decided over **everything**; allow never granted | decides nothing at all |
| `evaluateCdPermissionDslV1` | deny→`deny`, ask→`prompt`, allow→`{deny, allowlistRefusal}` | absent from `isCdRule`, so `prompt` in all three; a skipped Cd allow **no longer switches allowlist mode on** ("adding any Cd allow rule" — a rule nobody could read was not added) |
| `isWholeCapabilityDeniedByPermissionDsl` | uncompilable deny → `true` | `false` |
| `filterCapabilityIdentitiesByWholeToolDeny` | stripped every tool from context | strips nothing |

`CompiledPermissionDslV1` gains `droppedRules: readonly DroppedRule[]` (id,
action, scope, sourceDigest, diagnostic). One `unparseable-rule` diagnostic is
raised **per skipped rule**, naming the rule id, its action and the compiler's
own reason, and saying it was skipped.

**Preserved from the previous lane, as instructed:** the diagnostic names the
offending rule (not "Permission DSL document is invalid"), and the failure stays
rule-scoped — `invalidSource` is never set by this path. **Unknown matcher kinds
remain layer-fatal**, untouched.

**No compensating safety net was added.** The accepted cost — a typo in a `deny`
rule stops denying — is asserted by a test rather than mitigated.

### The one thing kept, and why it is not a safety net

When nothing decided **and** a rule was skipped, the evaluation returns
`{ match: { ruleId: 'invalid-policy', … }, diagnostic }` **with no `action`**.

This is the coupling the brief named. `evaluateClaudeHookIfFilter`
(`claude-permission-rules.ts:271`) compiles a **one-rule allow** program and
reads exactly that id; with a plain drop it would see an empty program, no
match, and `run: false` — silently breaking hooks.md's documented fail-open.

I did not take this on trust. **Measured** (§5): patching that one line to
report nothing turns `the hook 'if' filter still fails open on a rule that
cannot compile` **red**. The coupling is real and this line is what defuses it.

It is not a hidden decision: I read both other consumers of the id and both test
`action` **before** reading `match` — `SessionManager.ts:3669`
(`if (evaluation.action !== 'allow' && evaluation.action !== 'deny') return undefined`)
and `codex-agent.ts:1943` (`if (evaluation.action === undefined) { … continue }`).
An actionless report therefore reaches them as the ordinary "no rule matched"
that it is. The only behaviour it changes is the hook filter's, which is the
behaviour it exists to preserve.

---

## 3. Every test I inverted, and what each still forbids

The brief's warning is the right one, so here is each flipped assertion with the
bug it would still catch. **Nothing was deleted.** Three tests were added.

### Inverted (5)

**1. `it.each(UNCOMPILABLE)` (22 cases) — `…: the layer survives it` → `…: the
rule is skipped and the rest of the layer stands`.**
Was: `rules == [deny-0, allow-0]`, `rules[0].matcher.kind == 'unparseable'`.
Now: `rules == [allow-0]` with a real `bashPattern` matcher,
`droppedRules == ['claude-settings-deny-0']`, exactly one `unparseable-rule`
diagnostic naming it and containing "skipped", **and** the co-resident allow
actually decides (`evaluate(...).action === 'allow'`).
*Still forbids:* a regression to layer-fatal (`invalidSource` set, or `rules`
empty); a regression to keeping the rule (`rules` length 2); a silent skip (no
diagnostic); a skip that also loses the co-resident rule. The added evaluation
assertion is what makes it a behaviour test rather than a shape test.

**2. `an uncompilable DENY does not silently widen the policy` → `… is skipped
too, and the accepted cost is that it stops denying`.**
Was: `action === 'deny'` under `invalid-policy`; tool stripped from context.
Now: `droppedRules == [['claude-settings-deny-0','deny']]`, `action === 'allow'`
from the co-resident rule, diagnostic names the rule and says "skipped",
`isWholeCapabilityDeniedByPermissionDsl === false`, tool **stays** advertised —
**plus a positive control** on the same rig proving a `deny: ['Bash']` that DOES
compile still returns `true` and still strips the tool.
*Still forbids:* a regression to blanket-deny; a silent skip; and specifically a
**half-flip** where the gate drops the rule but the advertisement filter still
removes the tool — Bash allowed and invisible, which is a worse bug than either
direction.
*This is the test that states the owner-accepted cost out loud.* It is the one
most worth reading if anyone revisits OQ-8.

**3. `an uncompilable ASK prompts rather than granting` → `… is skipped too, so
it no longer prompts on everything`.**
Now: dropped with action `'ask'`, co-resident allow decides; **and** with no
co-resident rule the skipped ask still reports itself (`action` undefined,
`invalid-policy`, diagnostic naming it).
*Still forbids:* the ask surviving as a blanket prompt; and the skip becoming
completely silent when it is the only rule.

**4. `the Cd evaluator keeps the same posture` → `… skips it too — and a skipped
Cd allow does not switch allowlist mode on`.**
Was: deny→`deny`, ask→`prompt`, allow→`{deny, allowlistRefusal}`.
Now: all three → `prompt`. **Three `prompt`s in a row is exactly the shape that
can be satisfied by an evaluator that has stopped evaluating**, so this test
carries three positive controls on the same rig: a compilable `Cd(/sub)` deny
still refuses; a compilable `Cd(/vendor)` allow still switches allowlist mode on
and refuses an unmatched target; a compilable `Cd(/sub)` allow still allows.
*Still forbids:* the Cd path silently ceasing to enforce anything.

**5. `permission-dsl.test.ts` — two assertions.** These are the ones the previous
lane expected to survive (its §6 says "its three `invalid-policy` assertions all
still hold"); under the flip two of them cannot. **This is a scope deviation:
the brief scoped that file to a comment only.** Reporting rather than leaving
them red:
- `rejects relative roots …` — a `{kind:'path', root:'.'}` deny was `action:
  'deny'` under `invalid-policy`; now `rules` empty, `droppedRules == ['relative']`,
  `invalidSource` undefined, evaluation actionless under `invalid-policy`.
  *Still forbids:* the relative root being resolved against the request cwd and
  denying on that basis — the thing the test is named for.
- `pathGlob: symlink pair asymmetry and the source anchor` — same shape for a
  source-anchored rule with no `sourceRoot`. *Still forbids:* the anchor falling
  back to the cwd or the filesystem root and denying on a directory the author
  never named. I also strengthened it: it now evaluates against
  `/policy/root/cfg/x`, the path the rule WOULD have matched, where the previous
  version used a generic request.

**The stale comment named in the brief is one of these two.** "a source-anchored
rule without one fails the layer closed" is the line I rewrote in edit 5; the
brief's suggested replacement ("fails the rule closed") would itself have been
stale after this flip, so it now says the rule is skipped.

### Added (3)

- `a warning for EACH — two uncompilable rules produce two, both named` — the
  page says "with a warning for each"; a layer reporting only the first leaves
  the second unrepairable. Asserts two `droppedRules`, two diagnostics, both
  named, and the survivor still deciding.
- The two positive-control blocks inside tests 2 and 4 above.

### Unchanged and still green (4)

`the surviving rules still decide`, `an uncompilable ALLOW never grants, and a
real deny still outranks it`, `the warning reaches the user…` (one added
assertion for the new "skipped" wording), `a DOCUMENT-level failure still fails
the layer closed`. The hook-filter test is unchanged and green.

---

## 4. A weakness in my own test that the positive control caught

Worth recording because it is the failure mode the brief warned about, and I
walked into it.

My first version of test 2 asserted
`isWholeCapabilityDeniedByPermissionDsl(program, 'bash') === false`, copying the
spelling from the test I was inverting. The positive control I added alongside
it — the same function on a compilable `deny: ['Bash']` — **failed**, and the
probe showed why: a bare `Bash` rule compiles to `{kind:'tool', semanticId:
'Bash'}` and `wildcard` is case-sensitive, so `'bash'` matches nothing.

`isWholeCapabilityDeniedByPermissionDsl(program, 'bash')` returns `false` for a
fully-working deny filter. **My negative assertion could not have failed under
any regression.** The previous lane's version was fine because its `unparseable`
matcher matched every spelling; the flip is what turned that line hollow.

Both are now spelled `'Bash'`, and the comment says why. Without the positive
control this would have shipped as a green assertion measuring nothing — which
is exactly the "test that quietly stops testing anything" the dispatch named.

---

## 5. Proving it by breaking it

Both probes ran **under the mutex**, restoring inside the same locked command;
`diff -q` confirmed byte-identical restoration each time (`RESTORED-OK`), and I
re-verified the working file against both backups before committing.

**(a) Implementation reverted to `1e2aa4438`, tests kept: 26 pass, 30 fail** of
56 (187 expect(), 836 ms). All 22 pattern classes, plus the per-each-warning
test, the announcement test, the DENY / ASK / Cd tests, and the two
`permission-dsl.test.ts` assertions.

One of the 30 is a structural failure rather than a behavioural one, and I
checked rather than counting it as a win: `a DOCUMENT-level failure still fails
the layer closed` fails only because `program.droppedRules` does not exist on
the old program (`Received value does not have a length property: undefined`).
Its behavioural assertions hold on both sides — that boundary is deliberately
unchanged.

**(b) The trap, measured directly.** Reverting the change proves the flip, but
the hook-filter test passes on **both** sides, so it discriminates nothing. To
show the coupling is real rather than folklore, I patched the single line that
reports a skipped rule so it reports nothing — a naive drop — and ran the suite:

```
(fail) the warning reaches the user on the very request the lost allow would have cleared
(fail) an uncompilable ASK is skipped too, so it no longer prompts on everything
(fail) the hook `if` filter still fails open on a rule that cannot compile
 38 pass, 3 fail
```

The coupling fires exactly as the brief predicted. It also shows the two
announcement tests are not hollow: they go red under a change that keeps the
drop but loses the report.

---

## 6. Findings for the controller

1. **The contract's decisive sentence is about project settings, not managed
   settings.** `managed-settings.md#keys-that-fail-closed`'s closing paragraph
   covers "User, project, and local settings files" and says a malformed
   permission rule "is skipped with a warning while the rest of the file
   applies". The plan row and P2.127's report both cite only the managed
   sentence from `#find-entries-claude-code-dropped`. Same direction, stronger
   footing — worth carrying into the row note.

2. **`CompiledPermissionDslV1.diagnostics` has NO consumer.** Measured: the only
   caller of `compilePermissionDslV1` in production, `permissions-config.ts:1557`,
   never reads `.diagnostics`, and `rg -a` over `packages`/`apps` finds no other
   reader. So "a warning for each" is *produced* but reaches no user-visible
   surface. The per-request `invalid-policy` report is the only escape hatch, and
   both consumers of that id (`SessionManager`, `codex-agent`) test `action`
   first and therefore log nothing for an actionless report.
   **This makes the owner-accepted cost larger than acknowledged: it is not "the
   user may not read the warning", it is "there is currently no warning to
   read".** Pre-existing — P2.127's `unparseable-rule` diagnostic had the same
   gap — and outside my zone to close (it needs `permissions-config.ts` or a UI
   surface). I did not reach across, and I deliberately did **not** add a
   `debug()` call inside what is otherwise a pure compiler. Recommend a row.
   *(Note: parse-time drops DO reach the debug stream — `permissions-config.ts:1456`
   and the `claude_rule.unknown_tool` warnings visible in test output. It is
   specifically the COMPILE-time diagnostics that go nowhere.)*

3. **Scope deviation, declared:** the brief scoped `permission-dsl.test.ts` to
   one comment. Two assertions in it encode the old direction and cannot survive
   the flip; both were rewritten (§3 item 5), neither deleted, and both still
   forbid the substantive bug they were written for. P2.127's report predicted
   these would survive — that prediction was correct for its direction and is
   void under OQ-8's.

4. **A test that could not fail, found and fixed** — §4. Recommend the
   `'bash'`/`'Bash'` asymmetry in `isWholeCapabilityDeniedByPermissionDsl` be
   noted somewhere durable; it is a live trap for anyone writing a negative
   assertion against that function.

5. **P2.127's open class is untouched and still open**: a settings file with
   more than 512 permission entries still collapses the layer. Not this row's
   defect.

6. **`managed-policy.ts` and the importer are untouched** — they already behaved
   this way. The three-way inconsistency the row named is now a one-way answer.

---

## 7. Gate — what each command proves

| Command | Contract it proves | Result |
| --- | --- | --- |
| `bun scripts/bun-test-lock.ts run --label P2.270-final -- bun test permission-dsl.test.ts claude-project-settings-permissions.test.ts` (on the **committed** blob) | the compiler/evaluator contract and the new skip-whatever-the-action behaviour, including the hook coupling | **56 pass, 0 fail, 400 expect(), 584 ms** |
| `bun run typecheck:shared` | the deleted `CompiledMatcher` variant is gone from every switch, and the new required `droppedRules` field is satisfied at every construction site (there is only one) | clean |
| `bunx eslint` on all three changed files | style/lint | exit 0 |
| `git diff --check` on all three | no whitespace damage | exit 0 |
| `git show --stat --oneline HEAD` | commit contains exactly my three files under concurrent lanes | confirmed |
| revert probe | 30 of 56 fail without the change | §5(a) |
| naive-drop probe | the hook fail-open coupling is real | §5(b) |

**Affected-suite sweep, and an honest note on it.** I additionally ran the 13
other suites that touch this module in one batch: **300 pass, 4 fail**. The four
(`permission-events-composed`, three in `hooks-automation`) all failed at
5.0 s / 5.0 s / 5.0 s / 14.1 s — timeouts. I did not attribute this to the
environment; I measured it: **re-run in isolation, the two files give 83 pass,
0 fail (11.5 s)**. The failures are batch-size dependent, not change dependent —
the same code passes and fails depending only on how many files share the
process. Neither test is in the known-failing register.

**Not run, and why:** the full repo suite, builds, packaging. The
implementation-first budget confines the loop to focused tests for changed
behaviour and affected-package typechecks; `permission-dsl.ts` has no
wire/schema/migration surface. Nothing was cancelled mid-run.

**Mutex:** heavily contended (P2.85 / P2.85-consumers held it for ~25 minutes
across two of my runs; one tool call hit its own 10-minute ceiling purely
queueing). I never reaped another lane's hold and never raised a timeout
ceiling. One consequence worth stating: the confirming run was taken **after**
the commit rather than before, because the lock was held. That is safe here and
I checked it mechanically rather than assuming — the implementation file was
proven byte-identical (`diff -q`) to the state that had already run 56/0, and
the post-commit run on the committed blob is the 56/0 quoted above.

---

## 8. Scope

- Edited: `packages/shared/src/agent/pi-harness/permission-dsl.ts`,
  `packages/shared/src/agent/pi-harness/permission-dsl.test.ts`,
  `packages/shared/src/agent/__tests__/claude-project-settings-permissions.test.ts`.
- **Not** edited: `claude-permission-rules.ts` (read only, to verify the
  coupling), `permissions-config.ts`, `codex-agent.ts`, `SessionManager.ts`,
  `managed-policy.ts`, the plan file, the known-failing register, `.references/`.
- Committed by explicit pathspec; never `git commit -a`; never inspected a
  pathspec-less `git diff --cached`. Ten other files in `packages/shared` were
  dirty from concurrent lanes at commit time and none of them entered the commit.
- Environment note: the Xcode-licence outage ended mid-task. Every measurement
  in this report was produced after that point or by `bun`/`curl`, which the
  outage never affected. **No failure in this report is attributed to the
  toolchain** — the only four failures I saw were reproduced-and-refuted by
  isolation, not excused.
