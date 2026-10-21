# P2.287 — report

**Status:** DONE. **Commit:** `097e70596` on `feat/TCODE-000`.
**Base SHA recorded before starting:** `f58f66a36f6314384fef1d4c535f7772dd0ca84b`.

Files touched (both in zone, nothing else):
- `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/agent/pi-harness/removal-circuit-breaker.ts`
- `/Users/i.i.gavrikov/Desktop/work/nessy-desktop/packages/shared/src/agent/pi-harness/removal-circuit-breaker.test.ts`

---

## 1. The premise: CONFIRMED, and the site count was a subset

Reproduced on the base SHA before touching anything, with a direct-import probe
(`home: '/Users/testuser'`, `platform: 'win32'`), comparing the bare spelling against the
same token behind an abbreviated provider-dynamic parameter (`-s`), on **both** scans.

| token | bare ladder | `-s` ladder (base) | bare prompt | `-s` prompt |
| --- | --- | --- | --- | --- |
| `/usr/*` | wildcard/top-level | **NULL** | NULL | NULL |
| `C:\Windows\*` | wildcard/top-level | **NULL** | NULL | NULL |
| `R:\SOFTWARE\*` | wildcard/top-level | **NULL** | NULL | NULL |
| `C:\*` | wildcard/drive-root | **NULL** | root | root |
| `/*` | wildcard/root | **NULL** | root | root |
| `~/*` | wildcard/home | **NULL** | home | home |
| `$HOME/*` | wildcard/home | **NULL** | home | home |
| `*` | wildcard/null | NULL | NULL | NULL |
| `vendor/*` | wildcard/null | NULL | NULL | NULL |
| `./build/*` | wildcard/null | NULL | NULL | NULL |
| `~`, `/`, `C:\` | system-path/… | system-path/… | home/root/root | same |

**The row named five spellings. Measured, it is SEVEN** — `-s ~/*` and `-s $HOME/*` were
blinded too and were not on the list. This is the third recurrence on this plan of a stated
site count being a subset of the real one (1 of 11, 1 of 22, five that was six — now five
that was seven).

One correction *in the row's favour* and one *against* it:

- **In its favour:** the row says "the home and root rows still raise a prompt no mode can
  clear". True for `~/*`, `$HOME/*`, `C:\*`, `/*`. But `/usr/*`, `C:\Windows\*` and
  `R:\SOFTWARE\*` resolve to **top-level**, which `findRootOrHomeRemoval` does not classify —
  so behind `-s` those three were **null on both scans**. Nothing named them at all. The
  "no wrong behaviour ships" claim rests entirely on the PowerShell-binding argument for
  those three, with no second authority behind it.
- The mechanism is exactly as stated: the guard predicate at `:1401` was
  `?.ladderCase === 'system-path'` while the loop body two lines later accepts any non-null
  match, so a target on the `wildcard` rung was swallowed by `windowsTargetTokens`.

## 2. The reviewer's fix: validated, and it is a strict superset

`?.resolved != null`. `classifyRemoveItemLadderTarget` only ever returns
`ladderCase: 'system-path'` **with** a non-null `resolved` (`return resolved ? {…} : null`),
so the new predicate is a strict superset of the old one: **nothing that denied stops
denying.** What it adds is exactly the `wildcard` rows whose base resolves to a nameable
system path.

Re-probed after the fix: all seven blinded spellings restored to their bare verdicts
(case, `resolved` and argument identical); `*`, `vendor/*`, `./build/*` still swallowed —
P2.72's decision unmoved, because those are the globs whose base this scan cannot name and
which are therefore plausible `-Stream` values.

`resolved != null` turns out to be the discriminator the rung test was only standing in for:
a glob is a documented `-Stream` value, but a glob **over a root, a drive root, a top-level
directory or the home** is not a plausible stream name.

I also fixed the two claims the row said were broader than the code:

- `windowsTargetTokens`'s closing paragraph asserted "neither scan can be blinded to
  something the OTHER scan happens not to classify" and that the ladder "excludes its
  `wildcard` rung deliberately". The first was true and beside the point — the ladder was
  blinded to its **own** rung; the second is no longer the case. Rewritten.
- The `:1401` comment now records the measurement, the seven spellings, and why
  `resolved != null` keeps P2.72 intact.

## 3. The unchallenged fourth item: **VERIFIED**

The question was whether the guard's recorded cost is wrong for the command it names, such
that a runnable benign command now hard-denies. It is wrong, and it does.

`windowsTargetTokens`'s docstring said, verbatim:

> The cost this DOES pay is `Remove-Item -s ~ -Path ./logs`: … Under FileSystem it is also a
> command that cannot run — an unbound `-Path` fails mandatory binding — so the annoyance
> lands on commands that were already errors …

**`-Path` is bound in that command, by name, in the same line.** From
`MicrosoftDocs/PowerShell-Docs@main`, `curl -s` 2026-08-28,
`reference/7.4/Microsoft.PowerShell.Management/Remove-Item.md`:

- § `-Path` — `Required: True`, `Position: 0`. Position 0 means it *may* bind positionally;
  it does not stop `-Path ./logs` from binding it by name.
- The FileSystem `Path` parameter set is
  `Remove-Item [-Path] <String[]> … [-Stream <String[]>]` — `-Stream` and `-Path` are one
  parameter set, not a conflict.
- § Example 7, "Remove an alternate data stream", runs that exact shape:
  `Remove-Item C:\Test\Copy-Script.ps1 -Stream Zone.Identifier`, and the prose says
  "`Remove-Item` uses the **Stream** parameter to remove the `Zone.Identifier` stream of the
  file" — the file survives.

So `Remove-Item -s ~ -Path ./logs` is, under FileSystem, `-Stream ~ -Path ./logs`: it removes
an alternate data stream named `~` from `./logs`, touches nothing under the home directory,
and binds cleanly. Measured on the same rig, it takes **both** authorities:

```
Remove-Item -s ~ -Path ./logs         | deny: system-path/home/~ | prompt: home/~
Remove-Item -s ~ -LiteralPath ./logs  | deny: system-path/home/~ | prompt: home/~
Remove-Item -Path ./logs -s ~         | deny: system-path/home/~ | prompt: home/~
Remove-Item -Stream ~ -Path ./logs    | deny: NULL               | prompt: NULL   (P2.72's row, unmoved)
```

That is an every-mode deny with no override, plus a `nonNegotiable` prompt, on a runnable
benign command — not "an annoyance on commands that were already errors".

**What still holds, and is worth keeping:** § `-Stream` says the parameter "can't be used in
combination with the **Recurse** parameter", so P2.85's traced shape
`Remove-Item -s ~ -Recurse -Force` genuinely *is* a binding error under FileSystem and
rescuing it genuinely *is* free. The false step was generalising that to the `-Path`-bound
spelling.

**What I did about it, and what I did not.** I corrected the docstring to record the real
cost with the citation, and pinned the current behaviour as a test so a future change to it
is deliberate rather than silent. I did **not** narrow the guard. The sound narrowing exists
— skip the swallowed value whenever `-Path`/`-LiteralPath` is bound elsewhere, since an
explicitly bound `-Path` leaves no positional slot for the swallowed token to be the target
of, which holds under both the FileSystem and the hypothetical-provider reading — but that
reverses part of a security decision (P2.85) and is an owner call, not a side effect of this
row. **This is a live finding for the controller; see §6.**

## 4. Documentation classification

Split, as the brief anticipated:

- **Category (a)** for the classifier itself — the predicate/loop divergence, the rung
  taxonomy, `classifyRemoveItemLadderTarget`. No upstream page decides how we spell our own
  guard. Tagged `[doc:none]`.
- **Category (b)** for everything resting on PowerShell parameter binding and provider
  paths. Cited above from `Remove-Item.md` § `-Path`, § `-Stream`, § Example 7 and the
  SYNTAX block, `MicrosoftDocs/PowerShell-Docs@main`, fetched 2026-08-28. Note this is the
  **PowerShell** corpus, not the Claude/Codex corpora — the Claude page that governs the
  ladder itself (`permission-modes.md` § `Remove-Item in PowerShell`) is already cited in
  the file and is **unchanged by this row**: `:602`'s "any target ending in `/*` or `\*`" is
  what the fix restores behind an abbreviation, it is not reinterpreted.

## 5. Gates — with proof of work

Every gate redirected to a file and inspected; no gate read through a pipe.

| Gate | Command | Proof of work | Verdict |
| --- | --- | --- | --- |
| Focused suite (mutex) | `bun scripts/bun-test-lock.ts run --label P2.287-final -- bun test …/removal-circuit-breaker.test.ts` | `474 pass / 0 fail / 699 expect() calls / Ran 474 tests across 1 file` | PASS |
| Whole `pi-harness` dir (mutex) | same lock, `bun test packages/shared/src/agent/pi-harness/` | `1375 pass / 0 fail / 3820 expect() calls / Ran 1375 tests across 30 files` | PASS |
| Package typecheck | `cd packages/shared && bun run tsc --noEmit` | exit 0, **zero** output lines — plus a positive control, below | PASS |
| ESLint (from package dir) | `cd packages/shared && npx eslint <both files>` | exit 0, zero output; `--format json` reports `files linted: 1, errors: 0, warnings: 0` on the source file | PASS |
| `git diff --check` | on both paths | exit 0, no output | PASS |
| Full repo suite / builds / packaging / live | — | — | **NOT-RUN** (out of budget for this row; the brief says no full repo suite) |

**The suite the row asked me to run.** The brief called it 463 tests; the file now reports
**474**, and the delta is exactly my 11 new tests (7 + 3 + 1). So the 463 figure was this
file, it was accurate, and the reviewer's fix passes it in full — the concern that the fix
had only been validated against the pinned negatives is discharged.

**tsc positive control** (because an empty output is not evidence): I temporarily replaced
`?.resolved` with `?.noSuchField` and re-ran the same command — exit 2, and
`src/agent/pi-harness/removal-circuit-breaker.ts(1456,52): error TS2339: Property
'noSuchField' does not exist on type '{ ladderCase: RemoveItemLadderCase; resolved:
RemoveItemLadderResolved | null; }'`. So tsc really does read this file at the changed line.
File restored and re-verified before commit; the committed blob carries `?.resolved != null`
at `:1456`.

**Re-break, against the recorded absolute SHA — not `HEAD~1`.** I reverted the predicate to
the byte-identical form at `f58f66a36` (confirmed by diffing against
`git show f58f66a36…:<path>`) while keeping the new tests, and re-ran:

```
467 pass / 7 fail / Ran 474 tests across 1 file
```

All seven failures are the new positive rows, one per blinded spelling:
`/usr/*`, `C:\Windows\*`, `R:\SOFTWARE\*`, `C:\*`, `/*`, `~/*`, `$HOME/*`.
The three boundary rows and the cost row stayed **green** in the re-break — correct, since
those pin what must *not* change, and a boundary test that flipped would mean the fix had
moved P2.72.

**Real-path coverage:** every test calls the exported `findRemoveItemLadderDeny` /
`findRootOrHomeRemoval` directly. No doubles, no stubs — nothing in this row can go green
with and without the behaviour.

## 6. Findings, tagged and classified

**F1 — `[doc:none]`, kind: bug. The row's premise, confirmed, with a wider blast radius than
stated.** Seven spellings, not five: `-s ~/*` and `-s $HOME/*` were blinded and unlisted.
Three of the seven (`/usr/*`, `C:\Windows\*`, `R:\SOFTWARE\*`) were null on the prompt scan
as well as the ladder, so no authority named them. **Fixed in `097e70596`.**

**F2 — `[doc:none]` for the guard, with a category-(b) PowerShell basis; kind: bug. The
unchallenged fourth item is VERIFIED, not refuted.** `Remove-Item -s ~ -Path ./logs` is a
runnable, benign ADS removal that binds `-Path` by name, and it takes an every-mode deny
plus a `nonNegotiable` prompt. The docstring's justification ("an unbound `-Path` fails
mandatory binding") is false for the exact command it names. **Docstring corrected and
behaviour pinned in `097e70596`; the behaviour itself is unchanged and needs an owner
decision.** Proposed narrowing, for the row the controller opens: *when `-Path` or
`-LiteralPath` is explicitly bound in the same subcommand, an abbreviated provider-dynamic
parameter may swallow its value as before* — sound under both readings, because an
explicitly bound `-Path` leaves no positional slot for the swallowed token to be the target
of. Not taken here: it reverses part of P2.85's security decision.

**F3 — `[doc:none]`, kind: never-looked-at. The `system-path` rung has no glob-side twin in
the prompt scan, and that asymmetry is undocumented.** `findRootOrHomeRemoval` classifies
`~/*` and `/*` (via `classifyWindowsTarget`) but not `/usr/*` — it has no `top-level`
concept at all, by design, since it answers "root or home". That is almost certainly
correct, but nothing in the file states it, and it is what makes the three top-level
spellings in F1 single-authority rather than double-covered. Recording it as a verdict
rather than staying silent; **no action taken, and I do not think action is needed** — the
ladder is the right authority for `/usr/*` and it now fires.

## 7. Scope and hygiene

- Committed by explicit pathspec, two files. `git show --stat --oneline HEAD` confirms
  exactly `removal-circuit-breaker.ts` and `removal-circuit-breaker.test.ts`,
  `162 insertions(+), 11 deletions(-)`, nothing from the other six lanes.
- No `Co-Authored-By` trailer (`git log -1 --format='%b' | grep -ci` → 0).
- No second tree, no worktree, no branch. No push, no MR, no tag.
- The plan file was not touched; `.references/` and the known-failing register were not
  touched. No new i18n keys.
- Probe scripts live in the scratchpad only.
