# P2.91 — the removal breaker on unparseable text

**Status:** DONE. **Commit:** `63736e814`. **Baseline SHA recorded before starting:**
`b1824c4b4334256bc678cf6e932bac81e9d1b222`.

**Posture chosen:** `unparseable` means **read it with the weaker matcher** — NOT fire
unconditionally. **Blast radius behind that refusal: 784 of 18 272 real agent-issued Bash
commands (4.29 %, ~1 in 23) would newly get an unskippable prompt, and 504 of those 784
(64 %) are heredocs.** What I changed instead is narrower: the weaker matcher now sees
through the same enforcement wrappers the structured scan does. **Blast radius of the change
actually made: 0 of 18 272.**

---

## 1. The row's premise is STALE — the measurement wins

The row says: *"`findShRemoval` returns `null` whenever the split is `unparseable`* — measured
null on BOTH trees for every ANSI-C shape."

**Refuted on the current tree.** `findShRemoval` has not abstained on unparseable text since
P2.144 (`8ac746832`, "the removal floor reads a command the shared scanner could not parse"):
it hands the text to `findTextualRemoval`. Measured with the tree at `b1824c4b4`
(`scratchpad/sdd2/p291/probe1.ts`):

| command | `splitCompoundCommand` | breaker |
| --- | --- | --- |
| `echo $'a\'b' ; rm -rf ~` | UNPARSEABLE | **`home:~`** |
| `echo $'\'' ; rm -rf ~` | UNPARSEABLE | **`home:~`** |
| `x=$'\'' ; rm -rf /` | UNPARSEABLE | **`root:/`** |
| `echo "unterminated ; rm -rf ~` | UNPARSEABLE | **`home:~`** |
| `case $x in a) rm -rf ~ ;; esac` | UNPARSEABLE | **`home:~`** |
| `case $x in a) echo hi ;; esac; rm -rf ~` | UNPARSEABLE | **`home:~`** |
| `case $x in a) echo hi ;; esac` | UNPARSEABLE | null (no removal — correct) |

Positive control in the table: the last row proves the detector can return null, so the
non-null rows are not an artefact of a matcher that fires on everything.

One ANSI-C shape is worth separating, because it is the one the row's "measured null" almost
certainly came from and it is a **different defect**: `echo $'a\'b # c ; rm -rf /' ; rm -rf ~ \'`
**parses** (a MIS-parse, not a lost parse), so the fallback never runs on it. That is P2.179's
row, and it is already closed — the enforcement splitter now offers the ANSI-C reading as an
extra form and the breaker returns `home:~`.

So the row as written describes a state this tree left three commits ago. What is left of it
is real, and is below.

## 2. The reassurance is FALSE — this is the part I was asked to escalate

The row's safety net: *"the DSL's `PROMPT_ANYWAY` covers that ground, so the gap is invisible
today."*

**Measured false, in two independent ways.**

### (a) `PROMPT_ANYWAY` requires a `Bash(prefix)` rule to exist at all

`PROMPT_ANYWAY` is returned from inside `matchesRule`'s `bashPattern` / `powershell` branches
(`permission-dsl.ts`). It is not a program-level posture — it is a *per-rule* verdict. With no
such rule compiled, nothing in the program has an opinion, and the evaluation returns no
action at all. Measured (`scratchpad/sdd2/p291/probe5.ts`), one unparseable command carrying a
removal, four programs a real user can have:

| program | action |
| --- | --- |
| no rules at all | **none → falls to the mode default** |
| only non-Bash rules (`{kind:'tool',semanticId:'read'}` allow) | **none → mode default** |
| a TOOL-level bash allow (`{kind:'tool',semanticId:'bash'}`) | **`allow`** |
| a structural bash rule (`{kind:'bash',executable:'git'}`) | `deny` (via `unsafe-shell`, a different path) |
| one `Bash(tail:*)` deny **pattern** rule | `ask` ✅ |

Only the last row is the carve-out. Nessy ships **no** default `Bash(...)` rule — I grepped
for producers of `bashPattern` matchers outside `permission-dsl.ts` itself and every hit is a
test fixture; they arrive from user/workspace settings. So a fresh profile is the **first**
row, and a profile with a tool-level bash allow gets an outright **approval**.

Under `bypassPermissions` the mode default is allow, which is exactly the mode the breaker
exists for.

### (b) The `sh -c '…'` wrapper, already known but now measured wider

Under `sh -c '<unparseable script>'` the OUTER command parses, so the verdict is `no-match`,
not `unparseable` — no `PROMPT_ANYWAY` at all, whatever rules are configured. Measured:
`sh -c 'case a in a) sudo rm -rf ~ ;; esac'` → breaker null (pre-fix), `deny Bash(rm:*)` →
`no-match`, DSL with a pattern rule → **none**. Codex wraps every command as `<shell> -lc`,
so this is that runtime's normal form. The file's docstring already recorded this one; I
confirmed it still holds.

**Consequence for the row's priority:** the row is filed as "not urgent because the prompt
covers it". It does not. Whether the breaker is the only line of defence depends on whether
the user happens to have written a `Bash(...)` rule — which is a coincidence, and nothing
records that the coincidence is load-bearing. That is the same shape as the row this one was
compared to.

I did **not** fix (a): `permission-dsl.ts` is outside my zone. Recorded in
`findTextualRemoval`'s docstring, and reported here for a row.

## 3. Blast radius FIRST — what "fire on everything unparseable" would cost

The corpus question mattered more than the posture question, so I built four and threw three
away. Method and dead ends are recorded because the discards are the finding:

1. **Permission-surface string literals** (the established sweep corpus,
   `claude-bash-rule.ts:558`): 17 317 distinct strings, 2 411 newly firing. **Discarded** —
   most "hits" are prose from doc comments, not commands. Over-counts by construction.
2. **Repo shell scripts, line by line**: 47/1205. **Discarded** — 40 of the 47 are `case`-ARM
   FRAGMENTS (`mac)`, `*.deb) … ;;`) that exist only because a line-splitting harvest cut a
   multi-line construct. A model issues `case … esac` as one call, never a bare arm. The
   harvest manufactured its own hits.
3. **Whole commands from the repo** (114 package.json script bodies + 131 single-command doc
   fences): **0 unparseable**. Clean, but too small and too tame.
4. **THE CORPUS — 18 272 distinct Bash commands actually issued by agents in this repo**,
   extracted from the local session transcripts (145 362 transcript lines scanned). Every
   entry is one whole Bash tool call: the exact unit the breaker judges. Aggregate only; no
   command text left this machine.

Result on corpus 4:

```
REAL agent-issued Bash commands (distinct) : 18272
fire the removal breaker TODAY            : 28
WHOLE-COMMAND unparseable                 : 800  (4.38%)
  of those, already prompt today          : 16
  NEWLY prompting if unparseable => fire  : 784  (4.29%)
commands that parse but carry an UNPARSED nested span/-c script: 2517 (13.78%)
```

Why the 784 are unparseable:

| count | cause |
| --- | --- |
| 504 | **a heredoc body** (`python3 - <<'PY' … PY`) |
| 128 | a `case` statement |
| 120 | **an apostrophe inside a comment** (`# don't`) |
| 17 | over the 10 000-character analysis cap |
| 12 | an ANSI-C `$'…'` literal |
| 3 | genuinely unbalanced quoting |

**None of the 784 removes anything.** A floor the user cannot switch off and cannot say "don't
ask again" to, firing on two thirds of all heredocs, is not a floor — it is the noise this
module's own founding rule says users route around. So: **posture refused, with the number.**

## 4. What I changed instead

The row's sentence — *"a floor that goes quiet on text it cannot parse is not a floor"* — was
true one level down from where it was aimed. `findTextualRemoval` requires `rm` in COMMAND
POSITION, and its docstring accepted losing `sudo` on the grounds that "the structured scan
already covers it". **That trade is only sound while both matchers see the same text, and on
unparseable text the structured scan sees nothing at all.** So the floor was present for
`rm -rf ~` and absent for the same removal run with MORE privilege.

Measured null at `b1824c4b4` for `case a in a) sudo rm -rf ~ ;; esac`, and the `env` /
`nohup` / `doas` / `timeout` / `FOO=bar` / `watch` / `/usr/bin/sudo` spellings.

**Runnable and destructive, not hypothetical.** With a sandbox stand-in tree in place of `~`:

```
/bin/bash env-wrapper:   exit=0 GONE      /bin/bash nohup-wrapper: exit=0 GONE
/bin/sh   env-wrapper:   exit=0 GONE      /bin/sh   nohup-wrapper: exit=0 GONE
/bin/zsh  env-wrapper:   exit=0 GONE      /bin/zsh  nohup-wrapper: exit=0 GONE
```

`stripTextualEnforcementWrappers` rewrites each command-position segment with its
enforcement-wrapper prefix removed, **only where doing so uncovers an `rm`**, and identity
otherwise. It asks `stripSubcommand(segment, true)` rather than keeping a second copy of the
wrapper list — that list has grown repeatedly and a mirror nothing checks is this repo's
most-repeated failure mode.

Three properties keep the false-positive posture, and each is a test:

- a segment with no `rm` word is returned untouched **without calling the stripper** — the 504
  heredocs and 128 `case` blocks pay one regex test and change not at all;
- a segment whose first word is already `rm` is returned untouched — every pinned `subcommand`
  / `argument` spelling is byte-identical, including `argument === '~"'`;
- **`git` is not a wrapper**, so `git rm -rf ~` stays quiet.

All three original requirements still hold after stripping: a removal word, RECURSION, and an
operand `classifyTarget` resolves to root or home. `sudo rm ~` and `sudo rm -rf ./build` stay
quiet.

### Blast radius of the change itself

Baseline `b1824c4b4` (materialized into the scratchpad with absolute import paths, so the
repo tree was never a second state) vs the working tree, over the same 18 272 commands:

```
identical verdict         : 18272
NEWLY FIRING (new prompts): 0
went quiet (a REGRESSION) : 0
same verdict, new wording : 0
```

Positive control that the differ is live, not comparing a module with itself:

```
"case a in a) sudo rm -rf ~ ;; esac"  before=NULL  after=home  << CHANGED
"case a in a) env rm -rf ~ ;; esac"   before=NULL  after=home  << CHANGED
"case a in a) nohup rm -rf / ;; esac" before=NULL  after=root  << CHANGED
"case a in a) git rm -rf ~ ;; esac"   before=NULL  after=NULL
"rm -rf ~"                            before=home  after=home
```

### What I deliberately did NOT widen

- **`rmdir`** — `rmdir ~` removes nothing on a non-empty home, and the fallback requires
  recursion, which `rmdir` has no flag for. Same reasoning `carriesRecursiveRemoval` already
  records for `--dir`.
- **`find … -delete`** — destructive, but the structured scan's `find` rule turns on
  `FIND_NON_NARROWING_OPTIONS`, and applying that to word soup would either invent removals or
  miss them silently.

Both stay declared as `structured-only` rows in the differential, so a later widening is
visible rather than silent.

## 5. Tests

`removal-circuit-breaker.test.ts`:

- 11 new rows, `a wrapper no longer hides the removal` — every wrapper class, both targets,
  plus the unbalanced-quote route and the codex `sh -c` form. Each asserts the **operand
  name** too, so a rewrite that fires but names the wrapper fails.
- 4 new rows, `a wrapper does not manufacture a removal` — `git rm`, wrapper-without-shape
  (×2), `echo` as a non-wrapper head.
- 1 new test, `the wrapper rewrite is the IDENTITY on text with no rm word` — a heredoc inside
  a `case` stays null, and the two pinned spellings stay byte-identical.
- Differential buckets: `sudo`/`doas`/`nohup` moved `structured-only` → `both-fire`, `env` and
  `FOO=bar` added there, `git rm -rf ~` added as `both-quiet`. The gap test lost its `sudo`
  line and kept `rmdir` / `find`.
- Removed a rotted count ("`structured-only` above is nine rows") rather than correcting it.

**Mutant check on the negative guards** (the "test double that drops the argument" concern —
the new positive rows would pass just as well with a rewrite that skips ANY leading word).
Applied that mutant and ran the suite: **6 fail**, including all three `git rm -rf ~` guards
and `[both-quiet] git rm -rf ~`. Restored byte-identical. So the guards bite in both
directions.

## 6. Gates — all RUN, with proof of work

| gate | result |
| --- | --- |
| `bun test removal-circuit-breaker.test.ts` (via mutex) | `493 pass / 0 fail`, `Ran 493 tests across 1 file` |
| `bun test` claude-bash-rule + permission-dsl + claude-powershell (via mutex) | `509 pass / 0 fail`, `Ran 509 tests across 3 files` |
| `bun test` codex-permission-floors + codex-execpolicy-persistence + claude-can-use-tool-ask-user-question (via mutex) | `69 pass / 0 fail`, `Ran 69 tests across 3 files` |
| `bun run typecheck:shared` | exit 0, `tsc --noEmit` emitted **no diagnostic lines** (output file is 1 line: the command echo) |
| eslint from `packages/shared` | `files linted: 2`, `errors=0 warnings=0` on both — run with `--format json` precisely so an empty result cannot be confused with "matched no files" |
| `git diff --check` | exit 0, no output |
| **re-break vs `b1824c4b4`** (absolute SHA, never `HEAD~1`) | source reverted → **`477 pass / 16 fail`**, and the 16 are exactly the new invariants (11 wrapper rows + 5 differential rows). Restored byte-identical (`diff -q` → IDENTICAL). |

Not run, and named rather than left silent: full-repo `bun test`, `typecheck:all`, `lint`,
builds, packaging, live CDP. Per the implementation-first budget these belong to a
verification-wave boundary; the change touches no wire, schema, auth, migration or lock.

## 7. Findings, tagged and classified

1. **`[doc:none]` / bug** — `findTextualRemoval` was selectively blind to enforcement wrappers,
   so on text the structured scan could not read the floor was present for `rm -rf ~` and
   absent for `sudo rm -rf ~`. **Fixed in `63736e814`.** No upstream page governs this: the
   textual fallback is entirely our own construction (owner decision 2026-08-25, option (c)),
   and neither Claude's `permissions.md` nor any Codex page describes a removal circuit
   breaker at all.

2. **`[doc:claude]` / forgotten-vs-doc** — **`PROMPT_ANYWAY` does not cover the ground.** It is
   reached only when the compiled program carries a Claude-shaped `Bash(prefix)` rule; with no
   rules, with only non-Bash rules, or with a tool-level bash allow, an unparseable command
   gets no prompt (and in the third case an outright `allow`). Nessy ships no default
   `Bash(...)` rule. The page this is measured against is `permissions.md`, the sentence
   `permission-dsl.ts` itself cites for the carve-out: *"when Claude Code can't fully parse a
   command, it asks for approval instead of treating the command as read-only."* That sentence
   is unconditional; our implementation makes it conditional on a rule existing. **Outside my
   zone (`permission-dsl.ts`) — not fixed, recorded in the breaker's docstring, needs a row.**
   *(Anchor caveat: I did not `curl` the rendered page to confirm the section id, so I am
   citing the page and the verbatim sentence only, per the "quote sentences, not line
   numbers" rule. The sentence is the one already quoted verbatim in `permission-dsl.ts`
   above `PROMPT_ANYWAY`.)*

3. **`[doc:none]` / never-looked-at** — **13.78 % of real commands (2 517 of 18 272) parse at
   the top level but carry a nested span or `-c` script the walk could not parse.** Those go
   to `unparsed` and reach the textual fallback, which is correct — but the DSL sees
   `no-match`, so there is no `PROMPT_ANYWAY` behind them at all. This is the `sh -c` hole
   quantified for the first time; the docstring described it qualitatively. Worth a row: it
   says the breaker is the *sole* floor for one command in seven.

4. **`[doc:none]` / never-looked-at** — the row's premise was three commits stale and nobody
   noticed. Both this row and the one before it (`097e70596`) carried a reassurance that
   measurement refuted. Suggest the controller treat "the row says X is safe" as a claim to
   measure rather than a premise to inherit — it has now failed twice in a row on this file.

5. **Sibling left alone, as instructed** — `splitPowerShellCommand` still does not model
   here-strings (`@'…'@`, `@"…"@`). Not touched, no `pwsh` on this rig, no executable miss
   constructible. Confirming I did not stumble into it.

## 8. Concerns

- **The escalation in finding 2 is the one that matters.** This row was filed "not urgent"
  on a reassurance that is false for any profile without a `Bash(...)` rule — which includes
  a fresh install. The breaker is now stronger, but the class it still cannot see (`rmdir`,
  `find … -delete`, and anything else the weak matcher lacks) has **no** second line of
  defence for those profiles, not the one the row assumed.
- The corpus in §3 is this repo's own agent traffic. It is the right *unit* (whole Bash tool
  calls) and it is large, but it is one project and one team's style. The heredoc share in
  particular is probably higher here than in general use — which makes the 4.29 % a *lower*
  bound on the noise argument in some settings and an upper bound in others. I would not
  restate it as a universal rate.
- `stripSegmentWrappers` calls `stripSubcommand` on text that by definition did not parse.
  `tokenize` is total (it never throws, it just keeps appending on an unbalanced quote), so
  there is no crash path, but the tokens it returns for such text are best-effort. That is
  acceptable here — the result is only ever used to decide whether the head is `rm`, and the
  three requirements are re-checked afterwards on the rewritten text — but it is the seam a
  future widening should be careful with.
