# P2.329 — a newline in a quoted argument slipped past every glob rule, DENY included

**Status:** DONE. **Commit:** `0d7af52cd`. **Base SHA recorded before starting:**
`05733c4ad7c8f4b68dfbdf8e89c44191a9ea7ca2`.

**The deny bypass reproduces exactly as the row states, and it is worse at DSL level.**
**Other compilers checked: 12 (expected: 1 named by the row).** Three carried the bug and are
fixed; five more carry the same omission but in the *grant* direction, where fixing it would
widen rather than narrow — those are reported, not changed.

---

## 1. The reproduction, with a literal newline

`matchClaudeBashRule('rm *', …, { ruleAction: 'deny' })` on HEAD before the fix. The newline is
a real U+000A, not the two-character escape:

| command | verdict |
| --- | --- |
| `rm -rf ~` | `match` |
| `rm -rf ~ 'x'` (control) | `match` |
| **`rm -rf ~ 'a<LF>b'`** | **`no-match`** |
| `rm -rf ~ 'a\nb'` (escaped — NOT the defect) | `match` |
| `rm -rf ~ 'a<CR>b'` | **`no-match`** |
| `rm -rf ~ 'a<U+2028>b'` | **`no-match`** |
| `rm -rf ~ 'a<U+2029>b'` | **`no-match`** |

**Correction to the row, in the widening direction: it is four characters, not one.** JavaScript
counts LF, CR, U+2028 and U+2029 as line terminators, and `.` without `s` refuses all four. The
row named only the newline. One `s` flag closes all four at once.

The row's warning about escapes is confirmed: the escaped `\n` matched all along, so a test
written with `'\n'` passes on the broken compiler. Every test I added uses a literal terminator
and asserts up front that `LF.length === 1` and `LF !== String.raw`\n``.

### The user-visible harm is one level worse than `no-match`

Measured through `evaluatePermissionDslV1` with a single configured `deny Bash(rm *)`:

| command | action |
| --- | --- |
| `rm -rf ~` | `deny` |
| `rm -rf ~ 'a<LF>b'` | **`undefined`** — no action at all |
| `rm -rf ~ "a<LF>b"` | **`undefined`** |
| `git status` (control: genuinely no opinion) | `undefined` |

The deny does not merely fail to match — it **vanishes**. The discriminating control pair is the
first two rows: the same command, one extra quoted argument, and the configured deny is gone.

## 2. The sweep — 12 compilers, against an expected 1

The row named one site and said "verify the same omission is not repeated in the other pattern
compilers". It gave no count. I found **12** glob→regex compilers. Consistent with this plan's
history, the stated site count was a subset — by 12×.

`git grep 'new RegExp'` over tracked non-test source returns **61** sites, which I treated as a
floor and did not trust: a glob compiler need not use `new RegExp` on a line matching that
string. I swept a second way, by *mechanism* — `split('*')`, `replace(/\*/g, …)`, and a literal
`'.*'` in a join — and then read each hit's neighbourhood. Positive control: the `git grep`
found the known site at `claude-bash-rule.ts:1268`, so an empty result would have meant
something.

**The mechanism sweep is what found the two the `new RegExp` grep alone would have mis-ranked**,
and reading is what found the entry in §2.3 that no grep would have surfaced at all.

### 2.1 Carried the bug, in the restrictive direction — FIXED (3)

| compiler | flags | why it is the same bug |
| --- | --- | --- |
| `claude-bash-rule.ts` `compileBashPattern` | `u` → **`us`** | the reported site |
| `claude-powershell-rule.ts` `compilePowerShellPattern` | `u` → **`us`** | its own docblock says "Identical shape to the Bash compiler" — the identity included the missing flag. Same deny/ask asymmetry, same permission surface. **Not reported by anyone; found by the sweep.** |
| `permission-dsl.ts` `wildcard()` | `u` → **`us`** | the non-Bash matcher glob. Its one caller that can see a terminator is `matcher.matches`, which stringifies a raw tool-input field |

`wildcard()`'s blast radius is genuinely small and I checked rather than assumed: tool ids, MCP
server/tool names and agent names cannot contain a terminator, and the `exec` matcher is fed by
`tokenizeShell`, which **returns null outright on `\r` or `\n`** — so executable and args are
newline-free before they arrive. Only `matches:` is live.

### 2.2 Carry the same omission but in the GRANT direction — REPORTED, NOT CHANGED (5)

This is the part of the sweep I want read carefully. In each of these, a `*` that matched *more*
would **widen a grant**, not tighten a deny. The row's own principle — ambiguity resolves toward
firing — points the opposite way here, so silently adding `s` would have been a security
regression dressed as a consistency fix.

| compiler | what matching *means* | direction if fixed |
| --- | --- | --- |
| `config/sandbox-settings.ts` `globMatches` → `matchExcludedCommand` | the command is **excluded from the sandbox** | more commands run **unsandboxed** |
| `agent/mode-manager.ts` `globToRegex` (`**` arm) → `matchesAllowedWritePath` | the path is on the **allowed-write list** | more paths become writable |
| `plugins/http-hook-env.ts` `pathMatches` | a hook URL pattern matches | measured unreachable: a raw newline cannot survive URL parsing (also missing `u`) |
| `agent/local-tools/runtime.ts` `matchesPattern` | a file-search filter — not a permission decision | cosmetic |
| `marketplace/relevance.ts` `globSegmentSource`, `agent/memory/rule-matching.ts` | relevance ranking / memory rules — not permission decisions | cosmetic |

Measured, not inferred — `matchExcludedCommand('docker run x', ['*docker*'])` matches and
`matchExcludedCommand('docker run<LF>x', ['*docker*'])` does not; `matchesToolPattern` with a
`**` pattern matches `a/b` and not `a/<LF>b`.

**`sandbox-settings.ts` deserves its own line, because it is the "read the neighbourhood" find.**
The defect there is not undiscovered — it was measured months ago and **worked around at the call
site instead of fixed**. `automations/hook-env-file.ts` carries this in a docblock:

> `globMatches` compiles `*` to `.*`, which does NOT cross a newline. A newline-joined preamble
> therefore made every `*docker*`-style exclusion stop matching the moment a hook wrote an env
> var — silently, and only for users who had configured one. Measured, not assumed. `;` keeps
> those globs matching.

So the preamble is joined with `;` rather than a newline *to route around a compiler bug*. No
grep for `new RegExp` or for `.*` would surface that; only reading the neighbouring file does.
It is a live, load-bearing workaround whose reason lives in a third file — exactly the shape that
breaks when someone later "tidies" the preamble. **Recommend the owner decide this one
explicitly**: either fix the compiler and accept a wider exclusion grant, or keep the workaround
and add a test pinning the `;`.

### 2.3 Examined and clean (3)

Worth stating, because two of them *look* like the bug and are not — a future sweep that pattern-
matches on shape will flag them:

- `pi-harness/gitignore-glob.ts` — `*` → `[^/]*`, `?` → `[^/]`. A **negated character class
  matches a newline already**, so `s` is irrelevant. Measured.
- `permission-dsl.ts` `matchesHost()` — `*` → `[^.]+`, same reason. Measured.
- `pi-harness/managed-mcp-entries.ts` `globToRegExp` — already compiles `*` to **`[\s\S]*`**, the
  newline-safe idiom. **This is the positive control for the whole sweep**: the codebase already
  knows the correct idiom, so its absence in the other compilers is an omission and not a house
  style.

## 3. Direction — the explicit answer the row asked for

The row required that no residual input class leave a deny as a silent `no-match`. Enumerated
after the fix, with the four terminators and both quoting forms:

| input class | before | after |
| --- | --- | --- |
| terminator inside single quotes | silent `no-match` | **`match`** → `deny` |
| terminator inside double quotes | silent `no-match` | **`match`** → `deny` |
| unquoted terminator | already correct — it is a command **separator**, split into subcommands, deny fires on the right one | unchanged |
| unbalanced quote / >10,000 chars | `unparseable` → `ask` (the sibling lane's `4ab009360`) | unchanged |
| U+2028 / U+2029 | silent `no-match` | **`match`** |

**No residual class returns a silent `no-match` on a deny.** The two ways a pattern can fail to be
evaluated are covered by different mechanisms and both resolve toward firing: an unreadable
*command* yields `unparseable`, which the DSL turns into `ask`; an unreadable *pattern* does not
exist, because `compileBashPattern` escapes every metacharacter, so `new RegExp` cannot throw.

### Why widening cannot approve more

This is the property that makes the fix safe, and it is documented, not merely observed —
`permissions.md#bash`:

> "The recognized command separators are `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines. A rule
> must match each subcommand independently."

An **unquoted** terminator is a separator that `splitCompoundCommand` already splits on
(measured: `git status<LF>rm -rf ~` → `["git status", "rm -rf ~"]`, and an allow requires *every*
subcommand to match, so it stays `no-match`). A terminator that survives into the regex is
therefore **inside a quoted token** — inert argument data. An allow that newly matches is
matching the argument text the user actually wrote, e.g. `git commit -m 'a<LF>b'`. Both
directions are pinned by tests.

The one place the fix genuinely widens rather than narrows is `wildcard()`'s `matches:` glob on an
*allow* rule, which now also matches a multi-line field value. Stated in the code and here rather
than buried; it is the documented reading of `*`, and the deny side of the same matcher was
bypassable without it.

## 4. Blast radius — measured on 18,272 real agent-issued commands

Corpus: `scratchpad/sdd2/p291/real-commands.jsonl`, the same one the sibling lane used. **8,261 of
18,272 (45.21 %) carry a line terminator** — all LF; zero CR, U+2028 or U+2029 in the wild, so the
extra three terminators are hardening rather than an observed exposure.

Method: for every subcommand the deny splitter yields, take its head and build the deny a user
would plausibly write for it — `deny Bash(<head> *)` — then compare HEAD against HEAD+`s`.

| | newline-carrying (8,261 cmds) | control: newline-free, every 7th (1,431 cmds) |
| --- | --- | --- |
| (rule, command) pairs | 71,263 | 4,563 |
| deny `match`, base → fixed | 67,835 → **69,533** | 4,462 → 4,462 |
| **`no-match` → `match`** (deny newly fires) | **1,698** | **0** |
| **`match` → `no-match`** (deny stops firing) | **0** | **0** |
| distinct commands changed | 1,222 (6.69 % of corpus) | 0 |

**Every change is in the safe direction and the control confirms containment**: not one
newline-free command changes verdict, so the user-visible cost is confined to commands that
actually carry a terminator.

The examples are exactly the ordinary shell the row predicted — not exotic evasion:

```
deny Bash(python3 *)  vs  python3 -c "<LF>import json<LF>d=json.load(open(...))"
deny Bash(node *)     vs  cd /path<LF>node -e '<LF>const fs=require("fs")...'
```

A user-visible cost worth naming: 1,222 real commands (6.69 %) that a deny previously let through
will now be denied or prompted. That is the point of the fix, but it is a behaviour change
administrators will notice, and it belongs in the release notes.

## 5. Documentation — `[doc:claude]`

Anchors taken by `curl`ing the **rendered** page and grepping `id="…"`, per the standing rule.
All four verified present. **One correction worth recording: I first wrote
`#rule-value-wildcards` from a plausible slug and it does not exist** — grep returned 0. The real
section is `#match-by-input-parameter`. The rule about not deriving anchors earned its keep again.

| citation | verbatim sentence |
| --- | --- |
| `permissions.md#wildcard-patterns` | "A `*` in a Bash rule matches any text, including spaces, so one rule covers a family of commands." |
| `permissions.md#match-all-uses-of-a-tool` | "`Bash(*)` is equivalent to `Bash` and matches all Bash commands." |
| `permissions.md#bash` | "The recognized command separators are `&&`, `||`, `;`, `\|`, `\|&`, `&`, and newlines. A rule must match each subcommand independently." |
| `permissions.md#powershell` | "PowerShell permission rules use the same shape as Bash rules. Wildcards with `*` match at any position, the `:*` suffix is equivalent to a trailing ` *`, and a bare `PowerShell` or `PowerShell(*)` matches every command." |
| `permissions.md#match-by-input-parameter` | "The value supports `*` as a wildcard that matches any sequence of characters, so `Agent(isolation:*)` matches any explicit isolation value. Without `*` the match is exact" |

**Stated explicitly, as the brief required: the page does not say whether `*` crosses a newline.**
Its only mention of newlines is as *separators* (`#bash`, above). It is silent on a newline inside
a quoted argument. **So the choice is ours, and I made it in the restrictive direction** — which
here also agrees with what the page does say, since "any text" and "matches all Bash commands"
both read naturally as including a terminator.

## 6. Tests — and proof they bite

8 new tests. Every one uses a **literal** terminator, and the first assertion in each file is that
the literal and the escape are different strings, which kills a future rewrite that reaches for
`'\n'` and silently stops testing anything.

- `claude-bash-rule.test.ts` (5): the four terminators × both quoting forms on a deny; the `:*`,
  bare-prefix, interior-`*` and bare-`*` pattern shapes; the **DSL-level** test that the deny
  produces an action rather than `undefined`; and the allow-direction safety test (an unquoted
  terminator is a separator and must stay `no-match`; a quoted one must match).
- `claude-powershell-rule.test.ts` (2): the same deny bypass, plus a guard that the word boundary
  and case-insensitivity did not move.
- `permission-dsl.test.ts` (1): a `matches:` deny against a multi-line value, with a bare-`*`
  case and an exactness case so the fix cannot erode literal matching.

**Proof they discriminate** — the trap the standing rules name is a test that passes with and
without the behaviour. I ran every new assertion against a byte copy of the pre-fix compiler:

```
new assertions: 21; FAILED on base: 21; FAILED on fixed: 0
invariants:      6; held on both:   6
VERDICT: every new assertion discriminates, and no invariant moved.
```

The 6 invariants are the over-widening guards: `deny rm *` still fires on bare `rm -rf ~` and
stays silent on `git status`; `ls *` still refuses `lsof`; an allow still refuses an unquoted-LF
and a CRLF separator; the escaped `\n` matched all along.

## 7. Gates — with proof of work, not exit statuses

| gate | result |
| --- | --- |
| `bun test` — my three files (mutex) | **`Ran 521 tests across 3 files.` 521 pass, 0 fail**, 1135 expect() calls |
| `bun test` — new tests only, `-t "line terminator"` | **`Ran 8 tests across 3 files.` 8 pass, 0 fail** — proves all 8 ran rather than being skipped |
| `bun test` — whole `pi-harness/` dir (mutex) | **`Ran 1406 tests across 30 files.` 1406 pass, 0 fail**, 3942 expect() calls |
| `bun test` — the `evaluateClaudeHookIfFilter` coupling the brief flagged | **`Ran 132 tests across 3 files.` 131 pass, 1 skip, 0 fail** — the sibling lane's pinned coupling is green |
| `bun run typecheck:shared` | **0 errors** (see below) |
| `bunx eslint --format json`, 6 files | **`TOTAL errorCount=0 warningCount=0`** |
| `git diff --check` | clean, no output |
| re-run of 6 timed-out consumer tests in isolation | **NOT-RUN** (see below) |

### typecheck: the 4 errors are another lane's, proven

`typecheck:shared` first exited 2 with 4 errors, all four in
`src/agent/__tests__/fixtures/floating-emission-probe.ts` — an **untracked** file (`??`) a live
lane created, absent from HEAD, on `AbortReason.UserRequested`. Not one error names a file I
touched. I confirmed it rather than asserting it: with that one file moved aside,
`typecheck:shared` **exits 0 with zero errors**, and I restored it immediately.
*Worth passing to whoever owns that lane — it currently breaks `typecheck:shared` for everyone.*

### NOT-RUN, and why it does not gate this row

A consumer-wide run of 7 test files produced **6 failures — all timeouts**, in a run that took
538 s under six-lane contention (one failure at **35,247 ms**). The signature is the load artefact
the standing rules describe, and none of the 6 test names touches pattern matching. I tried to
re-run those two files in isolation **three times** and never acquired the mutex — `w4-gate` and
then `w4-gate2` held it for 7+ minutes each. **That re-run is NOT-RUN. I am not recording it as
passed.**

What I did instead is a direct measurement that needs no mutex, because "these failures are not
mine" is an absence claim and wanted a positive control:

```
pairs compared: 90; verdict differences: 0
positive control (newline command): no-match -> match
```

The 90 triples are the exact commands those failing tests exercise (`git status`, `ls -la`,
`cat package.json | head -5`, …) × 6 patterns × 3 actions, baseline vs fixed. **Zero verdict
differences**, while the same rig detects the real change. Combined with the corpus control (no
newline-free command changes verdict) and the green 1406-test pi-harness run, the 6 failures
cannot be attributable to this change. They remain unexplained as *someone's* problem, and I did
not add them to the known-failing register — that file is another lane's.

## 8. Findings to record — kind and tag

1. **`[doc:claude]` — bug.** The reported defect, fixed. It is **four** terminators, not one.
2. **`[doc:claude]` — bug, not previously reported.** `compilePowerShellPattern` carried the
   identical omission. Fixed. Found only by sweeping.
3. **`[doc:claude]` — bug, not previously reported.** `permission-dsl.ts` `wildcard()`, same
   omission, live via `matches:`. Fixed.
4. **`[doc:none]` — never looked at, and the most valuable thing in this row.**
   `sandbox-settings.ts` `globMatches` has the same omission, was **already measured**, and was
   **worked around at a call site** (`hook-env-file.ts`'s `;`-joined preamble) rather than fixed.
   Fixing it *widens* an unsandboxing grant, so the direction is a genuine owner decision.
   The workaround's reason lives in a third file and will not survive a tidy-up.
5. **`[doc:none]` — never looked at.** `mode-manager.ts` `globToRegex`'s `**` arm is newline-blind
   and feeds `matchesAllowedWritePath`, which takes file paths — and POSIX paths may contain a
   newline. Also a grant; also an owner decision.
6. **`[doc:none]` — bug, cosmetic.** `http-hook-env.ts` `pathMatches` lacks both `s` and `u`;
   measured unreachable because URL parsing encodes a raw newline. Low value, recorded for
   completeness.
7. **`[doc:none]` — not our surface, recorded as a verdict rather than silence.**
   `local-tools/runtime.ts`, `marketplace/relevance.ts`, `memory/rule-matching.ts` carry the
   omission but decide nothing security-relevant.
8. **`[doc:none]` — bug, another lane's.** The untracked `floating-emission-probe.ts` breaks
   `typecheck:shared` with 4 errors on `AbortReason.UserRequested`.

## 9. Concerns

- **The 6 timed-out consumer tests are NOT-RUN in isolation.** I have strong direct evidence they
  are not mine (§7), but I could not obtain a clean run and will not claim one.
- **Findings 4 and 5 are unresolved by design and need an owner call.** Both are the same
  omission in a grant-shaped matcher, so "fix it for consistency" is the wrong instinct — it
  loosens the sandbox and the write allowlist respectively. Left untouched deliberately; they are
  outside my zone (`config/`, `agent/`) and the direction is a policy choice, not a bug fix.
- **1,222 real commands (6.69 %) change verdict**, all toward denying/prompting. Correct, but
  administrator-visible, and it should reach release notes.
- The row said "the fix is likely one flag". It was three flags in three files, and the two
  unreported ones were found only because the sweep read rather than grepped.
