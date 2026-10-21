# Line anchors into `claude-agent.ts`, `SessionManager.ts` and `hooks-automation.ts` — census and disposition

> **Operational, not historical.** Read this before shaping a comment edit around "the cited
> lines below it must not move" in any of these three files. It says which of those citations
> a reader can still follow, which are already dead in content, and what the line-count rule
> actually protects. It does not convert anything: every citation it is about lives in a
> controller-owned document, so the conversions are handed back as a recipe (§5).

F1.190, measured by lane WJ-ll on **2026-09-23** at `feat/TCODE-000-1-41-0` (first at HEAD `fa450fdb5`,
every number re-taken at HEAD `2a5f5833e`).
Modelled on `2026-09-07-settings-anchor-rot-disposition.md`, which did the same pass for the
dead `settings.md` line anchors. Every number here is a reading with a date.

## 1. What prompted it, and the finding that changes the question

F1.169 had to fit a pointer into `askToolApproval`'s docblock (`claude-agent.ts`) and F1.97 had
to correct `releaseHookCard`'s (the local in `SessionManager`'s plugin command-hook runner),
each WITHIN its existing line count, because the lines inside and below them are cited by line
in `docs/**` and AGENTS.md's rule says a comment edit in a heavily cited file keeps its line
count. F1.169's pointer became a five-line paragraph rewrite; F1.97's reasoning moved out of its
own method.

**Measured: every citation that lands INSIDE either symbol today was already dead in content
before either edit.**

- `releaseHookCard` (its comment block and declaration, eleven lines at HEAD) is hit by
  **22** citations, **all** from the 2026-08-02 Claude doc sweep — seven in its worklist, one in
  its divergences table, fourteen in the generated `specs/data/**` files behind them. They cite
  lines 11141 to 11143 of `SessionManager.ts` as the nested-child budget clamp (the
  `inherited.maxDepth` read and the `Math.min` of `concurrency`). That code is still in the file,
  hundreds of lines away; the numbers now land on the D1.346 comment above `releaseHookCard`.
- `askToolApproval` (docblock, signature and body, 114 lines at HEAD) is hit by **2** citations,
  both in `2026-09-11-coverage-95-owner-questions.md`: line 6873 of `claude-agent.ts` as
  `includePartialMessages` and line 6915 as `forwardSubagentText: true`. Those options are at
  8542 and 8585 today; the two numbers land on `settle` and a C3.312 comment inside the method.

So the constraint those two rows paid for protected nothing a reader could still follow. The
cost was real (a paragraph rewritten to fit, a reason exiled from its method); the benefit was
nil. That is the whole case for a disposition rather than a blanket rule.

## 2. The census — run it, do not quote it

The row's own instrument (distinct `<basename>:<line>` citations in `docs/`, ranges folded to
their first line):

```sh
for f in claude-agent.ts SessionManager.ts hooks-automation.ts; do
  printf '%s %s\n' "$f" "$(git grep -ahoI -E "${f//./\\.}:[0-9]+" -- docs | sort -u | wc -l)"
done
```

**Reading of 2026-09-23: 275 / 660 / 85** — against WJ-h's 275 / 658 / 85 of 2026-09-20, so the
population is not growing by much; what grows is the files underneath it.

By bucket (occurrences, ranges kept, `git grep -anoI` over `docs packages apps scripts` — `-a` for
the NUL-byte trap; the classifier is the script at the end of this section):

| Bucket | `claude-agent.ts` | `SessionManager.ts` | `hooks-automation.ts` | Disposition |
| --- | ---: | ---: | ---: | --- |
| `docs/superpowers/specs/data/**` (generated sweep artifacts) | 447 | 947 | 198 | **FROZEN** — a regeneration would undo an edit |
| `docs/superpowers/specs/*.md` (dated records, gated ones excluded) | 419 | 863 | 145 | **FROZEN** — a dated measurement is true of its date |
| `docs/superpowers/plans/*.md` (gated one excluded) | 63 | 213 | 26 | **FROZEN** — rows describe the tree they landed on |
| `docs/testing/cdp-runs/*.md` | 3 | 8 | 0 | **FROZEN** — dated run narratives |
| **GATED** — the five documents `scripts/check-ledger-citations.ts` reads (`LEDGERS`) | 23 | 25 | 12 | **CONVERT** — a reader is expected to open them, and the gate fires when one turns blank |
| `docs/architecture/**` | 12 | 1 | 0 | **CONVERT** — live reference docs |
| `docs/testing/` outside `cdp-runs/` | 2 | 9 | 2 | **CONVERT** — live checklists |
| source comments (`packages/**`, `apps/**`, `scripts/**`) | 23 | 39 | 1 | **CONVERT** — followable, and outside this row's docs scope |

Totals: 992 / 2 105 / 384 occurrences. Followable (the last four rows, summed over the three
files — gated, live docs, source comments): **60 + 26 + 63 = 149** — about 4 % of the population. Everything else is a dated record whose line numbers were true on the
day it was written, which the settings disposition already argued at length and this pass
re-measures rather than re-argues.

**Correction, 2026-09-24 (F1.579): eight of the 60 GATED occurrences were never read by the gate.**
They were written as PARTIAL paths — starting at `agent/` or at `server-core/` — and
`check-ledger-citations` drops such a token twice over: `collectCitations` keeps a path only
when its first segment is a tracked top-level directory, and the bare-name pass skips a file
name that a `/` precedes. So the GATED row above priced them as checked while they were
unguarded: the ledger's F39, I16 and L117 cells and their three gaps twins, plus the gaps
doc's two changelog rows. F1.470 (3) (`9df58e360`) wrote all eight as full paths in the symbol
form of §4. Measured with the gate's own `collectCitations` over the committed documents: on
those eight document lines, a citation of the cited file was read on 1 before the conversion
(a different citation sharing the line) and on 8 of 8 after, each carrying its symbol. The
class is wider than these three files, and closing it is a change to the gate rather than to
this spec: over the five documents at `fa397cfb2`, 629 line-tailed and 711 tail-less partial
paths each resolve to exactly one tracked file, and none of them is read (a reading with a
date, taken with a suffix match against `git ls-files`).

The classifier (paste into a shell at the repo root; it reads `LEDGERS` and `PLAN_DOC` from the
gate itself, so a sixth gated document joins the GATED row without an edit here):

```sh
python3 - <<'PY'
import re, subprocess
from collections import defaultdict
gate = open('scripts/check-ledger-citations.ts', encoding='utf-8').read()
plan = re.search(r"PLAN_DOC = '([^']+)'", gate).group(1)
block = gate[gate.index('export const LEDGERS'):]
block = block[block.index('= ['):]   # past the `readonly string[]` annotation
gated = set(re.findall(r"'(docs/[^']+)'", block[:block.index(']')])) | {plan}
def bucket(p):
    if p in gated: return 'GATED'
    for pre, name in [('docs/superpowers/specs/data/', 'specs/data'), ('docs/superpowers/specs/', 'specs/*.md'),
                      ('docs/superpowers/plans/', 'plans'), ('docs/testing/cdp-runs/', 'cdp-runs'),
                      ('docs/architecture/', 'architecture'), ('docs/testing/', 'testing, other'),
                      ('docs/', 'docs, other')]:
        if p.startswith(pre): return name
    return 'source'
table = defaultdict(lambda: defaultdict(int))
names = ['claude-agent.ts', 'SessionManager.ts', 'hooks-automation.ts']
for b in names:
    out = subprocess.run(['git', 'grep', '-anoI', '-E', re.escape(b) + ':[0-9]+(-[0-9]+)?', '--',
                          'docs', 'packages', 'apps', 'scripts'], capture_output=True, text=True).stdout
    for line in out.splitlines():
        table[bucket(line.split(':', 1)[0])][b] += 1
for k in sorted(table): print(f'{k:16}', *(table[k][b] for b in names))
PY
```

## 3. What the line-count rule protects, measured

AGENTS.md's bullet ("A comment edit in a heavily cited file must keep its LINE COUNT, or it
blanks every line-tailed anchor below it within the minute") was written after one gated
failure: a three-line docblock growth in `mode-manager.ts` blanked three plan anchors. The rule
is right about the GATED population — `check-ledger-citations` reports a cited line that turned
blank, and a lane cannot repair a ledger cell. It is wrong about the rest:

- a FROZEN citation is already off its content in most cases (§1 is two of hundreds), and no
  gate reads it — keeping its line number in place keeps a wrong pointer pointing at a
  different wrong line;
- the gate only sees BLANK lines. A shift that lands a gated citation on another non-blank line
  passes silently, so "0 cited lines moved" is not the same as "every gated citation still
  says what it said".

## 4. Disposition

1. **FROZEN buckets stay as written.** Do not renumber them, do not convert them, and do not
   shape an edit around them. Their numbers describe their date.
2. **GATED citations into these three files are converted to symbol form, written
   `` `path` symbol `name` ``** — the full repo path in backticks, the word `symbol`, then the
   identifier in backticks, one citation per identifier. That is the form
   `check-ledger-citations` checks: its symbol arm (`findAbsentSymbolCitations`) opts in on the
   connective word and requires the identifier to occur as a whole token in the cited file, and
   the word also does the pairing that AGENTS.md §Traps (the two-anchor repair) otherwise has to
   put in the punctuation. The path is written in FULL, from its tracked top-level directory:
   a partial path (one starting at `agent/` or at `server-core/`, say) is dropped by the gate
   unread (F1.579). **Amended 2026-09-24 (F1.578, decided by the controller):** until then this
   rule prescribed the path followed by the identifier in parentheses, and NO arm of the gate
   reads that form once the line tail is gone (`attachedIdentifier` runs only on a line-tailed
   citation, and the symbol arm opts in only on the word), so a prescription the gate could not
   verify was itself a silent divergence. 40 distinct citations over the five documents; the
   list, with what each line held on 2026-09-23, is §6. **Done** by F1.470 (3), `9df58e360`
   (2026-09-24): 56 occurrences over 38 anchors converted, one reader's wrong anchor written in
   words (it appears twice), and one kept as written — F48's import-line census entry, line 2 of
   `claude-agent.ts`, whose nine sibling entries are import lines in other files. Control, the
   same day: all 809 occurrences of this form that cite one of the three files across the five
   documents are read by the symbol arm (a probe that feeds the gate's own `collectCitations`,
   `collectBareNameCitations` and `attachedSymbol` the committed documents).
3. **Live docs and source comments** are converted opportunistically by whichever lane edits
   next to them, by the same recipe.
4. **Once 2 is done, the line-count rule for these three files narrows** to "keep the line
   count only where a CONVERTED-bucket citation still carries a line" — which after the
   conversion is the source comments and the live docs, 89 occurrences, not the 1 020 distinct
   lines the whole-`docs/` grep prices. (2 is done since 2026-09-24; the one gated line
   citation it kept, F48's entry in the ledger and its gaps twin, is line 2 of `claude-agent.ts`, the SDK
   import, which only an edit of the import block can move.)

## 5. Hand-back — the AGENTS.md sentence (the controller's file)

Proposed amendment to the line-count bullet, appended as its last sentence:

> Price the constraint with the GATED and LIVE citations, not the whole `docs/` grep: in
> `claude-agent.ts`, `SessionManager.ts` and `hooks-automation.ts` 95 % of line citations sit in
> dated specs, plans and generated data, and every one that landed inside `askToolApproval` or
> `releaseHookCard` on 2026-09-23 was already off its content
> (`docs/superpowers/specs/2026-09-23-hook-card-line-anchor-disposition.md`).

## 6. The gated citations, as they stand (2026-09-23)

What each cited line holds TODAY and the top-level symbol around it, so the converting lane
reads the cell's claim against the right code. A mismatch between the two is the conversion's
finding, not this table's; the symbol column is a heuristic (the nearest top-level
declaration above the line) and is to be checked, not copied. Anchors are written in words
(line N of the file) on purpose: a correction that spells the old anchor re-creates it for
every citation census (AGENTS.md).

| File | Line(s) cited | Nearest declaration above | Holds today |
| --- | --- | --- | --- |
| `SessionManager.ts` | 44 | the import block | an import specifier |
| `SessionManager.ts` | 514–516, 526–531 | the import block | imports |
| `SessionManager.ts` | 3757 | a helper near `blocked` | a closing brace |
| `SessionManager.ts` | 4079 | `piChildSessionServices` | a docblock sentence |
| `SessionManager.ts` | 4321–4326, 4321–4336 | `announceChannelSources` | a comment |
| `SessionManager.ts` | 5566 | `announcedDpSessionLapse` | a docblock sentence |
| `SessionManager.ts` | 6001 | `announceSettingsTiers` | `collectConfigDoctorInput()` |
| `SessionManager.ts` | 8606 | `getPiHarnessRuntimeSnapshot` | a comment |
| `SessionManager.ts` | 9190–9229 | `runBranchSessionCommand` | a comment |
| `SessionManager.ts` | 10848 | `createCapabilityTurn` | a comment |
| `SessionManager.ts` | 11383 | the plugin command-hook runner | `environmentDigest` |
| `SessionManager.ts` | 22109 | `appendEmptyChildToolPoolNotice` | the notice's sentence |
| `claude-agent.ts` | 2 | the import block | the SDK import |
| `claude-agent.ts` | 217–225 | `IMAGE_READ_EXTENSIONS` | its docblock |
| `claude-agent.ts` | 773–850 | `buildClaudePreToolUseContinue` | its docblock |
| `claude-agent.ts` | 1725 | `asRecord` | its body |
| `claude-agent.ts` | 2090, 2090–2091 | a docblock inside the permission-card helpers | a docblock sentence |
| `claude-agent.ts` | 2723 | `buildClaudeTurnShapeOptions` | its docblock |
| `claude-agent.ts` | 2816 | the worktree `caps` block | a comment |
| `claude-agent.ts` | 3168 | `buildClaudeExtendedContextDisableEnv` | its docblock |
| `claude-agent.ts` | 3517–3520 | a docblock | blank docblock lines |
| `claude-agent.ts` | 3553–3583 | `buildClaudeSubagentPromptAppendArgs` | its signature and body |
| `claude-agent.ts` | 3896 | a docblock | a blank docblock line |
| `claude-agent.ts` | 5303–5323 | `modelQuestionAsk` | its docblock |
| `claude-agent.ts` | 5421 | `localAdapterDisposed` | a docblock sentence |
| `claude-agent.ts` | 5481 | `resolveSelectedPluginSkillRuntimePolicy` | a `throw` |
| `hooks-automation.ts` | 400 | `hasSensitivePluginHookUrlCredentials` | its body |
| `hooks-automation.ts` | 469 | `externalHookInput` | its signature |
| `hooks-automation.ts` | 493–513 | `pluginMatcherMatches` | its docblock |
| `hooks-automation.ts` | 577 | `hookBindingsForMatcher` | its docblock |
| `hooks-automation.ts` | 590–591 | `hookBindingHandlerType` | two `case` arms |
| `hooks-automation.ts` | 713, 714–721, 720 | the service constructor | field assignments |
| `hooks-automation.ts` | 930 | `buildSdkHooks` | a docblock line |
| `hooks-automation.ts` | 1376 | `captureRun` | a `continue` |
| `hooks-automation.ts` | 1745 | `gatedDecision` | an object spread |

Regenerate the list rather than trusting it: the five `LEDGERS` paths in
`scripts/check-ledger-citations.ts`, the same `git grep -anoI -E` as §2 restricted to them, and
`sed -n '<line>p'` on each file.
