# P2.311 — the unparseable-command prompt fired only if a Bash rule already existed

**Status:** DONE. **Commit:** `4ab009360`. **Base SHA recorded before starting:**
`5a58014bf5495e97833c1a38fe17889bf35c5844`.

## The four-program table, after the fix

| program | before | after |
| --- | --- | --- |
| no rules at all | no action | no action |
| only non-Bash rules | no action | no action |
| a TOOL-level bash allow (`{kind:'tool',semanticId:'bash'}`) | **`allow`** | **`ask`** |
| one `Bash(tail:*)` deny | `ask` | `ask` |

**Corpus share of my change: 800 of 18,272 (4.38 %) under a bare `Bash` allow;
0.00 % under each of the other four programs measured. Every one of the 800 is
an `allow` → `ask`; zero transitions of any other kind.**

And the 800 are not a new verdict in the system — they are **set-identical**
(A\B = 0, B\A = 0) to the 800 that already prompt today whenever any
`Bash(prefix)` rule is present. The change makes that verdict rule-independent;
it does not invent one.

---

## 1. The measurement reproduced — including the third row

Reproduced all four rows from inside `permission-dsl.ts` before changing
anything (`scratchpad/p2311/probe1.ts`), on three unparseable shapes:

| program | `echo "unbalanced` | `echo <10,001 chars>` | `case a in a) rm -rf ~ ;; esac` | **control: `git status`** |
| --- | --- | --- | --- | --- |
| no rules at all | none | none | none | none |
| only non-Bash rules | none | none | none | none |
| a tool-level bash allow | **`allow`** | **`allow`** | **`allow`** | `allow` |
| one `Bash(tail:*)` deny | `ask` | `ask` | `ask` | none |

**The third row reproduces.** A tool-level bash allow returned `allow` on a
command nothing in the system could parse — including the >10,000-character form
the documented sentence names explicitly. The sibling lane's measurement was
correct in every row, confirmed from inside the file.

Positive control is the last column: the `Bash(tail:*)` deny program returns
*none* for `git status`, so the `ask` in its unparseable cells is the carve-out
firing and not a matcher that fires on everything; and the tool-allow program
returns `allow` for `git status`, so its rows are a live grant rather than a
program with no opinion.

## 2. The contract — verified on the rendered page, and it IS qualified

`[doc:claude]`. The sentence is present and verbatim as the row quotes it:

> **Commands the analysis can't parse**: when Claude Code can't fully parse a
> command, it asks for approval instead of treating the command as read-only.
> Commands longer than 10,000 characters always prompt because they exceed what
> the analysis parses.

Anchor taken by `curl`ing the page **without** `.md` and grepping `id="…"`:
`id="read-only-commands"` is published, so the citation is
**`permissions.md#read-only-commands`**.

**The row calls the sentence "unconditional". Read on the page, it is not — and
the brief asked me to say so if it was qualified.** It is the fifth bullet of a
list introduced by *"In Manual mode, commands from this set still prompt in these
cases:"*, inside `#### Read-only commands`, whose opening sentence is *"Claude
Code recognizes a built-in set of Bash commands as read-only and runs them
without a permission prompt in every mode."* So its scope is (a) Manual mode and
(b) the built-in read-only auto-approval set. It says: **do not give an
unreadable command the read-only free pass.**

**This does not rescue the defect — it re-aims it, and I changed the fix
because of it.** A no-match is not an auto-approval, so the DSL abstaining on an
unparseable command is defensible and I left it alone. A rule that *approves* the
command without ever consulting its text is not defensible, and that is the third
row. So the fix downgrades a winning **allow**, and only that.

### The second citation, which settles the third row on its own

`permissions.md#match-all-uses-of-a-tool` (anchor confirmed the same way):

> `Bash(*)` is equivalent to `Bash` and matches all Bash commands.

`Bash` compiles to `{kind:'tool'}`; `Bash(*)` compiles to `{kind:'bash',
pattern:'*'}` → a `bashPattern` matcher. Measured before the fix:

| command | allow `Bash` | allow `Bash(*)` |
| --- | --- | --- |
| `echo "unbalanced` | **`allow`** | `ask` |
| `echo <10,001 chars>` | **`allow`** | `ask` |
| control: `git status` | `allow` | `allow` |

Two spellings the page calls equivalent disagreed, and the bare one **approved
what the parenthesised one asked about**. That is a contract violation
independent of how one reads the read-only bullet's scope, which is why I treat
the third row as a genuine defect and not a doc-scope argument.

## 3. What I changed

`PROMPT_ANYWAY` is a **per-rule** verdict returned from inside `matchesRule`'s
`bashPattern` / `powershell` branches. Unparseability is a property of the
**request**, so the floor is now also asked at program level.

`commandIsUnparseable(request)` + one line in `evaluatePermissionDslV1`:

```ts
const action = selected.action === 'allow' && commandIsUnparseable(request) ? 'ask' : selected.action
```

Fourteen lines of code; the rest of the diff is documentation and tests.

Three properties, each deliberate:

- **It asks through the same `matchClaudeBashRule` the per-rule half uses**, with
  the pattern the page calls equivalent to the bare tool name — so the two halves
  cannot drift, and the answer is by construction the verdict a `Bash(*)` allow
  reaches. The pattern cannot skew it: `'unparseable'` is returned from the
  **split**, before any pattern is compiled; a pattern that merely failed to
  match comes back `'no-match'`.
- **It is consulted only on an `allow`** (`&&` short-circuits), so the extra
  parse is off the deny, `ask` and no-match paths entirely.
- **It never manufactures an action or a deny.**

### Written into the code, not only here

The brief's actual ask. `commandIsUnparseable`'s docstring carries the
before/after table and an explicit **"What it does NOT cover — do not lean on it
for these"** section: a no-match (with the `evaluateClaudeHookIfFilter` reason and
the 4.38 % number), `sh -c '<unparseable>'` (13.78 %, P2.91), PowerShell (§5), and
"any DENY". `PROMPT_ANYWAY`'s own docstring now opens by saying it is **half** the
carve-out and points at the other half — because the sentinel's docstring is
where the three deferring rows would have looked.

## 4. What I deliberately did NOT do — the no-match case

The row's sharpest line is *"the protection is absent exactly for the user who has
configured nothing"*, which invites making a no-match prompt. I refused, for
three reasons, and this is the one place my fix is narrower than the row implies:

1. **It would break hooks.** `evaluateClaudeHookIfFilter` compiles a ONE-RULE
   allow program and reads a no-match as "do not run". Manufacturing an `ask`
   there silently stops hooks running — the coupling the brief named. Pinned by
   the new `invalid-policy` assertion and by the 641-test coupled run.
2. **Blast radius.** 4.38 % of real commands, on every profile, for a decision
   nothing had an opinion about.
3. **The contract does not ask for it.** Abstaining is not "treating the command
   as read-only". In `default`/Manual mode — the mode the bullet's own lead-in
   scopes it to — a no-match already prompts at the gate.

**Consequence, stated plainly so nobody over-reads this fix:** under
`bypassPermissions` the mode default is allow, so an unparseable command is still
allowed on a profile with no rules. That is the mode's meaning, not this
carve-out's business, and it is written into the docstring.

## 5. A narrowing I made mid-flight, because the first version was too broad

My first implementation routed by `looksLikePowerShell` (PowerShell splitter for
PowerShell-looking text, sh splitter otherwise). Measured, that was **871
(4.77 %)**, not 800 — and the extra 71 were the wrong kind:

```
bash-splitter unparseable                    : 800
looksLikePowerShell routed                   : 1534   (8.39% of a pure-sh corpus)
  of those, PS-splitter unparseable          : 331
  PS-unparseable but bash-OK  (added noise)  : 94
  bash-unparseable but PS-OK  (lost)         : 23
```

`looksLikePowerShell` fires on 1,534 of 18,272 **sh** commands — heredoc bodies
containing `-match`, a `Verb-Noun` word, a `$var |` pipeline. Routing by it would
have prompted on 94 commands the sh analysis read correctly, buying nothing. I
narrowed to the sh reading only: **800, and every one of them already prompts
today under any `Bash(prefix)` rule.**

The cost of the narrowing is recorded rather than hidden: 23 commands (0.13 %)
that the sh splitter calls unreadable and the PowerShell one accepts have no
program-level floor. A `PowerShell(prefix)` rule still reaches `PROMPT_ANYWAY` on
its own text. Widening needs a tighter language predicate, not this one — said in
the docstring.

## 6. Tests — and proof they bite

`permission-dsl.test.ts`, 4 new tests (130 lines):

1. **`the unparseable carve-out no longer waits for a Bash pattern rule to
   exist`** — the four-program table, both unparseable shapes, **plus a
   positive-control readable command on every row** so an `ask` cannot be a
   matcher firing on everything and an `undefined` cannot be a program with no
   opinion. Assertions are `[name, action]` pairs so a failure names its row.
2. **`a tool-level Bash allow cannot approve a command the analysis could not
   read`** — the third row on its own, as the brief asked, over three unparseable
   shapes; plus four readable commands (including a heredoc) that must stay
   `allow`, so the fix cannot erode a working grant.
3. **`` `Bash` and `Bash(*)` agree on an unparseable command ``** — built through
   the real `parseClaudeRuleString` spellings, with a readable control so it
   cannot pass by making both forms uniformly useless.
4. **`the carve-out downgrades an allow and does nothing else`** — deny still
   outranks; an `ask` keeps its own rule id; a non-Bash request is untouched; and
   the `invalid-policy` carrier still reports a skipped rule with **no action** on
   an unparseable command.

**Re-break against the absolute base SHA** (`5a58014bf…`, never `HEAD~1`):
source reverted, tests kept → **16 pass / 3 fail**, and the 3 are exactly tests
1–3. Test 4 passes both ways *by design* — it pins behaviour that must not
change. Restored byte-identical (`diff -q` → identical).

**Two mutants**, because a guard that never fires is not a guard:

| mutant | result |
| --- | --- |
| M1 — also fire on a **no-match** (the tempting over-broad fix) | **3 fail**, including the `invalid-policy` fail-open guard |
| M2 — also downgrade a **deny** | **2 fail** |

Both restored byte-identical.

## 7. Gates — all RUN, with proof of work

| gate | result |
| --- | --- |
| `bun test permission-dsl.test.ts` (via mutex) | `19 pass / 0 fail`, `133 expect() calls`, **`Ran 19 tests across 1 file`** |
| `bun test` permission-dsl + claude-bash-rule + claude-powershell + hooks-automation + claude-project-settings-permissions (via mutex) | `640 pass / 0 fail`, **`Ran 641 tests across 5 files`** — the last two carry the `evaluateClaudeHookIfFilter` fail-open coupling |
| `bun run typecheck:shared` | exit 0; output file is **1 line** (the command echo), no diagnostics. It earned its keep: it caught `parseClaudeRuleString` arity in my own new test, which passed at runtime with the argument missing |
| eslint from `packages/shared`, `--format json` | `files linted: 2`, `errors=0 warnings=0` on both — json format precisely so "matched no files" cannot read as clean |
| `git diff --check` | exit 0, empty output |
| re-break vs `5a58014bf…` | `16 pass / 3 fail`, the 3 expected |
| commit isolation | `git show --name-only` → exactly my 2 files |

**NOT-RUN, named rather than left silent:** full-repo `bun test`, `typecheck:all`,
repo `lint`, builds, packaging, live CDP. Per the implementation-first budget
these belong to a verification-wave boundary; this change touches no wire, schema,
auth, migration, lock or build infra.

## 8. Findings

### F1 — the row's premise, CONFIRMED (`[doc:claude]`, forgotten-vs-doc) — FIXED

`PROMPT_ANYWAY` was reachable only once a `Bash(prefix)` rule existed, making an
approval possible on a command the analysis could not read. Fixed in `4ab009360`.
Cited: `permissions.md#read-only-commands` and `#match-all-uses-of-a-tool`.

### F2 — the contract sentence is SCOPED, and the row calls it unconditional (`[doc:claude]`, forgotten-vs-doc)

Detail in §2. It sits under *"In Manual mode, commands from this set still prompt
in these cases:"* inside `#### Read-only commands`. **This does not refute the
row** — the `Bash` ≡ `Bash(*)` equivalence convicts the third program on its own —
but any future row that quotes the sentence as unconditional is over-claiming, and
the `bypassPermissions` no-match case is genuinely outside it.

### F3 — a `*` in a Bash rule never crosses a newline, and **deny rules miss** (`[doc:claude]`, bug) — OUT OF ZONE, NOT FIXED

`compileBashPattern` (`claude-bash-rule.ts`) turns `*` into `.*` in a regex built
**without the `s` flag**, so `.` never crosses `\n`. A subcommand carrying an
embedded newline — a newline *inside a quoted argument*, not a compound separator,
which splits normally — fails every `*` pattern. **Including deny.** Measured with
positive controls:

| command | `deny Bash(rm *)` |
| --- | --- |
| `rm -rf ~` | `match` |
| `rm -rf ~ 'x'` | `match` |
| `rm -rf ~ 'a\nb'` | **`no-match`** |
| `rm -rf ~ "a\nb"` | **`no-match`** |

Corpus scale: **2,482 subcommands in the 18,272 where a deny rule written for
that subcommand's own head (`deny Bash(<head> *)`) returns `no-match`.** A deny
rule failing to match the very command it names is an enforcement hole, and it is
a different mechanism from this row's — nothing here fixes it.

Scoping honesty: I first read the 6,039 corpus `Bash` vs `Bash(*)` disagreements
as all one bug. **They are not** — only 2,626 involve an embedded newline; the
rest are heredoc-body lines and `$(…)`/assignment forms that the **allow** side
refuses deliberately (allow is conservative by design). So F3 is the newline
mechanism and the deny consequence, not the 33 % headline.

Fix belongs in `claude-bash-rule.ts`, outside my zone — reported, not reached
across for. Needs a row.

### F4 — the "three rows leaned on this" claim (`[doc:none]`, never-looked-at)

I confirmed the mechanism that made the reassurance false, and the code now says
so in two docstrings. I did **not** identify which three rows leaned on it — that
is the controller's tracker, not visible from here. Worth checking each: the
reassurance was false in a specific way (only for profiles without a
`Bash(prefix)` rule), so a row that deferred for a *different* reason may still
stand.

## 9. Concerns

- **The `bypassPermissions` gap is real and I chose not to close it.** With no
  rules configured, an unparseable command is still allowed in that mode. I think
  that is right — closing it means manufacturing an action on a no-match, which
  breaks the documented hook fail-open — but it is exactly the shape of gap this
  row was opened about, and someone should agree with the reasoning rather than
  inherit it. It is written into the docstring so the next reader meets it.
- **F3 is more dangerous than what I fixed.** This row's defect turned an
  `allow` into an `ask`; F3 makes a **deny fail to fire** on 2,482 corpus
  subcommands. I'd prioritise it above anything remaining here.
- **The corpus is this repo's own agent traffic** — the right unit (whole Bash
  tool calls) and large, but one project and one team's style, unusually
  heredoc-heavy and multi-line. The 4.38 % is not a universal rate. It is also a
  pure-sh corpus, so it can say nothing about the PowerShell gap in §5.
- **The 800 flip only under a bare `Bash` allow.** That program is not shipped by
  default (I found no default `Bash(...)` or tool-level bash allow rule in the
  tree — every producer of `semanticId: 'bash'` outside tests builds a *request*,
  not a rule). Users who wrote `"allow": ["Bash"]` themselves will see new prompts
  on ~1 command in 23. That is the documented behaviour of `Bash(*)` today, but it
  is a visible UX change and should be in release notes.
