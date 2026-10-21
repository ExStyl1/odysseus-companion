# P2.85 — the provider escape hatch is inert by accident

**Status:** done, committed `1ba1423967217951e3fc4a67787b9b9090647a8c`.
Remedy (2) taken — the parameter rule no longer depends on the drive regex.
The row's premise is CONFIRMED, with two sharpenings (§2).

`git show --stat` confirms the commit carries exactly
`removal-circuit-breaker.ts` and `removal-circuit-breaker.test.ts`
(+262/−15) and nothing from the four sibling lanes.

---

## 1. The premise, verified by measurement before anything was changed

Rig: `bun run` against the real exported `findRootOrHomeRemoval` /
`findRemoveItemLadderDeny` (no doubles anywhere — this module is pure string
semantics), `home: 'C:/Users/testuser'`, `platform: 'win32'`, parent commit.

| command | breaker | ladder |
| --- | --- | --- |
| `Remove-Item HKLM:\` | null | null |
| `Remove-Item Cert:\` | null | null |
| `Remove-Item WSMan:\` | null | null |
| `Remove-Item Env:\` | null | null |
| `Remove-Item C:\`  *(positive control)* | root | drive-root |
| `Remove-Item X:\`  *(positive control)* | root | drive-root |
| `Remove-Item -s C:\` | null | null |
| `Remove-Item -s /` | null | null |
| `Remove-Item -s ~` | null | null |
| `Remove-Item /` *(positive control)* | root | root |
| `Remove-Item ~` *(positive control)* | home | home |
| `Remove-Item -s HKLM:\` | null | null |

Both halves of the row hold:

1. **Multi-letter PSDrive roots classify as nothing today.** Positive control on
   the same rig: `C:\` and `X:\` classify, so the scan is live and the nulls are
   real absences, not a dead rig.
2. **The `-s` skip really does swallow a classifying token** — `-s C:\`, `-s /`,
   `-s ~` are all null while the bare forms all fire. The mechanism is live.

So **the exploit path is genuinely CLOSED today**, and closed redundantly: the
token that `-s` swallows would not have classified anyway. Nothing here is
urgent — this is housekeeping, exactly as the row framed it.

### The decisive measurement: it is closed only by coincidence

I widened the drive regexes to `[A-Za-z]+` on the parent commit and re-ran:

| command | breaker | ladder |
| --- | --- | --- |
| `Remove-Item HKLM:\` | **root** | **drive-root** |
| `Remove-Item -s HKLM:\` | **null** | **null** |

That is the re-opened hole, from one `sed`, with no warning anywhere in the
file. The row's concern is real and correctly diagnosed.

> Method note: my first attempt at this widening was a `perl -0pi -e` whose
> `\Q…\E` escaping silently matched nothing. The "measurement" it produced was
> just the unchanged baseline and would have read as a clean confirmation. I
> caught it by grepping the file afterwards to confirm the edit had landed, and
> redid it in `python3` with an `assert count > 0` per substitution. Every
> subsequent edit-then-measure step asserts the edit landed first.

## 2. Two sharpenings of the row (the measurement wins)

Neither refutes the row; both make the safety *more* accidental than stated.

**(a) It is FOUR regexes across three functions, not one.** The row names
`normalizeWindowsPath`'s `^([A-Za-z]):`. Measured: widening that one **alone
changes nothing** — `Remove-Item HKLM:\` stayed null on both scans, because
`isWindowsRoot` and `classifyWindowsSystemPath` carry their own single-letter
`[A-Z]` tests. All four must widen together. This matters for the choice of
remedy: remedy (1) "state the dependency at both sites" would actually have had
to state it at *five* sites, and a five-site comment invariant is precisely the
kind that rots.

**(b) The safety rests on shipped drive NAMES, not on anything structural.**
`New-PSDrive.md` § `-Name`: "For temporary PowerShell drives, you aren't limited
to drive letters, use any valid string." So a **single-letter** non-FileSystem
PSDrive (`New-PSDrive -Name X -PSProvider Registry …`) needs no code change at
all — and `Remove-Item X:\` already classifies as root today while
`Remove-Item -s X:\` did not. The multi-letter regex was never a barrier to
that spelling; it only happened to cover the eight shipped drive names.

## 3. Remedy chosen: (2), make the rule not depend on it

Remedy (1) was rejected on the strength of §2(a) — a security property held up
by prose at five sites, one of which the row itself did not know about.

The change is in `windowsTargetTokens`
(`packages/shared/src/agent/pi-harness/removal-circuit-breaker.ts`):

> A non-target parameter's value is still skipped, **except** when the parameter
> was spelled as a strict **abbreviation** of a **`providerDynamic`** row **and**
> the value is one this scan classifies — then it stays in the scan.

Supporting changes: `NON_TARGET_PARAMETERS` rows became a named
`NonTargetParameter` interface carrying `providerDynamic`, set only on `stream`;
`isNonTargetParameter` became `matchNonTargetParameter`, returning the matched
row plus whether this spelling was abbreviated; `windowsTargetTokens` takes a
`classifiesAsTarget` predicate.

### Why each scope limit is where it is

- **Abbreviation only.** The FULL name is unambiguous in every binding
  namespace (a provider cannot contribute a second `-Stream`), and where
  `-Stream` is absent `Remove-Item -Stream …` is a *binding error*, not a
  removal — so nothing runs for the breaker to miss. This is also what leaves
  P2.72's measured rows measuring what they measured: the pinned quiet row
  `Remove-Item -Stream ~ -Path ./logs` spells it in full and is untouched.
- **`providerDynamic` only.** `-Exclude`/`-Include`/`-Filter` are *declared by
  the cmdlet*, so they are in the namespace under every provider and their
  measured minima stand. Extending the guard to them would have broken no
  existing test — I checked — but it buys a defence against an unmeasured
  collision at the price of a real false positive: `Remove-Item -Ex ~ -Path
  ./logs` is legal, *spares* the home, and would start denying in every mode.
  Declined deliberately; pinned as a negative so a future widening is loud.
- **Caller-supplied predicate, not a shared one.** Neither scan can be blinded
  to something the *other* scan happens not to classify. The ladder's predicate
  excludes its `wildcard` rung on purpose: a glob is a documented `-Stream`
  value (`Accept wildcard characters: True`), so rescuing `*` would undo P2.72
  outright.

### What the fix costs

`Remove-Item -s ~ -Path ./logs` now prompts and denies. Under FileSystem that is
`-Stream ~`, a stream named `~` — and also a command that cannot run, since an
unbound `-Path` fails mandatory binding. The annoyance lands on commands that
were already errors, which is the direction this file has chosen twice before
("an over-firing deny is an annoyance, an under-firing one is a missed
removal").

### Durability — the actual success criterion

Re-ran the same four-regex widening **with the guard in place**:

| command | breaker | ladder |
| --- | --- | --- |
| `Remove-Item HKLM:\` | root | drive-root |
| `Remove-Item -s HKLM:\` | **root** | **drive-root** |

The two now agree. Widening the drive regexes can no longer re-open an
under-fire through the parameter rule; it costs over-fire only, which is a scope
decision rather than a security one. That is recorded at `normalizeWindowsPath`
itself, so the next person to widen it reads what it does and does not hold up —
a comment describing a property that code now enforces, rather than one
defending it.

## 4. Documentation classification

**Category (b) for the PowerShell semantics; category (a) for the classifier.**

All fetched with `curl -s` on 2026-08-27 from
`MicrosoftDocs/PowerShell-Docs@main` (`raw.githubusercontent.com/.../reference/7.5/…`),
quoted verbatim, section-anchored not line-anchored:

- `Remove-Item.md` § `-Stream`: "This is a dynamic parameter made available by
  the **FileSystem** provider."
- `about_Providers.md` § Finding dynamic parameters: "These parameters are
  available only when the cmdlet is used with the provider that added them."
  — this is the load-bearing one: it is what makes `-Stream` *absent*, not
  merely un-abbreviated, under another provider.
- `about_Providers.md` § Built-in providers: drives `Alias:`, `Cert:`, `Env:`,
  `Function:`, `HKLM:`, `HKCU:`, `Variable:`, `WSMan:`, against FileSystem's
  "`C:` and other depending on hardware" — the eight-name basis of §2(b).
- `New-PSDrive.md` § `-Name`: "For temporary PowerShell drives, you aren't
  limited to drive letters, use any valid string."

The classification rules themselves (what counts as root/home, the ladder rungs,
the deny-list posture) are **category (a)** — our own implementation, no upstream
page governs them.

## 5. Tests

Added one describe block, `an abbreviated provider-dynamic parameter never
blinds the scan (P2.85)`, 32 tests. No doubles: every test calls the real
exported entry points, so there is no argument-dropping stub that could make the
suite green in both states.

- 6 positives × 2 authorities (breaker prompt + ladder deny).
- 6 negatives/boundaries × 2 authorities: full spelling still blinds (both
  cases), a non-classifying value still skipped, and the three non-provider-
  dynamic rows pinned as *not* rescued.
- 1 row pinning that cmd heads are untouched (P2.74's branch, which the shared
  filter must not have changed).
- 7 property rows: *whatever the bare scan classifies must still classify behind
  an abbreviated `-s`*, re-deriving the expectation from the bare form rather
  than hard-coding it — so it keeps holding if the drive regexes are widened
  later. Each carries its own positive control (`expect(bare?.target)
  .toBeDefined()`) so a token that stopped classifying cannot pass vacuously.

### Re-break (prove the fix by breaking it)

Restored the original implementation, kept the new tests:

**19 of 32 fail**, and nothing outside the new block fails. All 19 land at
1.6–20 ms inside a 1.94 s run — the "real failure" band, not the ≥10 s load-
artefact band. Failing: the 6 `prompts:` rows, the 6 `denies:` rows, and all 7
property rows.

The 13 that pass in *both* states are the intended negatives — they pin what
must not move, and the P2.72/P2.51 rows they guard (`-Stream ~ -Path ./logs`
quiet, `-S *` no-deny, `del -s C:\ /q` still firing) are all pre-existing rows
in the suite that stayed green throughout.

## 6. Gate results

| command | contract it proves | result |
| --- | --- | --- |
| `bun test …/removal-circuit-breaker.test.ts` (mutex, label P2.85) | the breaker + ladder classification contract, incl. the new invariant | **463 pass, 0 fail** |
| same, with impl reverted | the new tests actually pin the new behaviour | **19 fail** (all new) |
| `bun test` breaker + `claude-bash-rule` + `pi-agent-guardian-consult` (mutex) | the shared target-token filter's downstream consumers | **1096 pass, 2 fail** — both flaky, NOT mine (§6a) |
| `bun run typecheck:shared` | the 3-arg `windowsTargetTokens` signature and the new interface across the package | **exit 0** |
| `npx eslint` on both changed files | style/lint on changed files | **exit 0**, no output |
| `git diff --check` on both changed files | no whitespace damage | **clean** |

**Not run, and deliberately:** the full repo suite, builds, packaging, live
smokes. This plan runs the implementation-first verification budget and this row
changes no shared wire, schema, auth, or lock. `claude-powershell-rule.test.ts`
is excluded from my batch — it spawns real subprocesses since the sibling lane's
`c7fafb0e8` and exceeded a 2-minute ceiling; per the brief that is known and
tracked, and I did not raise any timeout for it. It does not import
`windowsTargetTokens`; it reaches this module only through the same two exported
entry points the 463-test suite covers directly.

### 6a. The two guardian failures — run down, not waved away

The consumer batch came back **1096 pass / 2 fail**, both in
`pi-agent-guardian-consult.test.ts`, both 30 s timeouts. That suite is not in the
known-failing register, and it *does* reference `Remove-Item` 19 times, so it was
not dismissible on inspection. I ran the A/B properly:

| run | impl | order | fails | time |
| --- | --- | --- | --- | --- |
| batch | with fix | — | 2 | (3 files, 822 s) |
| A | with fix | 1st | 3 | 708 s |
| B | reverted to parent | 2nd | **0** | 254 s |
| C | reverted to parent | 1st | **4** | 940 s |
| D | with fix | 2nd | 2 | 1108 s |

**Run A alone would have convicted me** (3 fails with the fix, 0 without) — which
is exactly why I reversed the order instead of stopping there. Run C shows the
*parent-commit* implementation producing the worst result of all five runs. The
parent impl produced both the maximum (4) and the minimum (0); the failing set
differs on every run; every failure is a timeout, never an assertion. The
variable is run order and machine load, not the diff.

Two independent confirmations:

- **Structural:** my guard's rescue branch can only fire on an *abbreviated*
  provider-dynamic spelling. `grep -aoiE -- "-(s|st|str|stre|strea)\b"` finds
  **zero** in the guardian suite — positive control, the same grep finds 33 in my
  own new test file. The changed branch is unreachable for every command that
  suite runs.
- **Mechanical:** the suite's own header (lines 48–58) documents that each check
  spawns `powershell-parser.ps1` at 0.69–0.88 s idle and that this is why it
  already calls `setDefaultTimeout(30_000)`; P2.241 owns the ungated spawn. I
  observed a live `powershell-parser` process mid-run, and two concurrent
  `bun test` processes on that same file — the documented phantom-failure
  condition.

I did not raise any timeout ceiling, per the brief.

### An environment note that is NOT an excuse

`typecheck:shared` first failed with
`base-agent.ts(4268,48): Property 'canDispatchWorkflowCommands' does not exist`.
I did not write that off as "another lane's". I measured it: the symbol is
absent at `HEAD` and present twice in the working-tree `base-agent.ts`, which is
`M` alongside that lane's `pi-agent.ts` and a new untracked
`workflow-command-runtime-gate.test.ts` — a half-landed edit from the Pi
child-admission lane. It cleared on its own when that lane landed the method.

Because "tsc reported nothing in my files" is an **absence** claim, I ran a
positive control on the same rig: injected a deliberate `const x: number =
'not a number'` into `normalizeWindowsPath`, confirmed tsc reported it at
`removal-circuit-breaker.ts(353,9)`, then restored and verified the file's
SHA-256 matched byte-for-byte.

## 7. Concerns / open items for the controller

0. **NEW FINDING for the tracker — `pi-agent-guardian-consult.test.ts` is flaky
   under load and is NOT in the known-failing register.** Measured five times
   (§6a): 0–4 failures, a different set each run, always 30 s timeouts, on the
   parent commit as well as on mine. Cause is the per-check
   `powershell-parser.ps1` spawn (P2.241's ungated spawn) meeting five concurrent
   lanes. I could not record it myself — the register is another lane's and the
   plan is controller-pinned — so it needs a row. Its practical cost is high: a
   single run of this suite is enough to convict an innocent diff, which it
   nearly did to mine.
1. **`claude-powershell-rule.test.ts` was not run by me** (subprocess-spawning,
   exceeded the ceiling; the brief pre-authorised not chasing it). It shares no
   internal function with my change, but if the controller wants belt-and-braces
   before merge, that is the one suite to add.
2. **§2(b) is a live, if exotic, gap I did not close** and it is *not* what this
   row asked for: `Remove-Item X:\` classifies as a drive root today, so a
   user-created single-letter non-FileSystem PSDrive was always reachable
   without any regex change. My guard now covers the `-s` spelling of it, but
   the broader question — whether a PSDrive root on a non-FileSystem provider
   should classify as a "drive root" at all — is a scope question for the
   ladder, not a security one, and belongs in its own row if anyone cares.
3. **The `providerDynamic`-only scoping is a judgement call**, documented in the
   docstring and pinned by three negative rows. If a future provider is ever
   found to collide with `-Exc`/`-Inc`/`-Fi`, the guard is one flag per row away
   from covering them — but it should not be widened speculatively, because the
   false positive it buys (`-Ex ~` denying in every mode) is real.
4. **`NON_TARGET_PARAMETERS` now has a marker that only one row sets.** If a
   second provider-dynamic, value-taking parameter is ever added to that table,
   it needs `providerDynamic: true` or it silently inherits the old fragility.
   The docstring says so; there is no mechanical enforcement, because the table
   is hand-maintained against a documented enumeration either way.
