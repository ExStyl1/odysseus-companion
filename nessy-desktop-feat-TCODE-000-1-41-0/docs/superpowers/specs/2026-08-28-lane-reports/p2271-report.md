# P2.271 — the compiler's diagnostics now have a consumer

**Does the warning reach a user, and by what route?** Yes, on the app's
diagnostic stream, and only there. A malformed rule in a project
`.claude/settings.json` now writes one line per dropped rule from
`permissions-config.ts` via `debug()` → stderr, and (because `SessionManager`
runs **in the Electron main process** — `apps/electron/src/main/index.ts:28`,
`:742`) mirrored into electron-log's `main.log`. That reach is conditional on
debug logging being on (`--debug` / `NESSY_DEBUG=1`); with it off, a packaged
build still logs nothing. **A user who never enables debug still does not see
it.** The remaining hop to an unconditional surface is named in §7 and is not
mine.

**Status:** DONE. Commit `2609b810c` on `feat/TCODE-000`, four files, 245
insertions / 2 deletions, verified by `git show --stat --oneline HEAD` to contain
exactly my four files and nothing from the other eight lanes. No `Co-Authored-By`.
Zone tests: **52 pass / 0 fail / 349 expect() / 524 ms** across both files.

---

## 1. The premise was measured first, and it holds — with one correction

Classification: **(b) upstream contract**, plus an (a) half.

- **(b)** `managed-settings.md#keys-that-fail-closed`. Anchor taken from the
  **rendered** page (`curl -s https://code.claude.com/docs/en/managed-settings |
  grep -o 'id="[^"]*"'` returns `id="keys-that-fail-closed"`, alongside
  `id="find-entries-claude-code-dropped"` and the explicit
  `<span id="invalid-entries-in-managed-settings" />`). Sentence verbatim from
  `managed-settings.md` line 256:

  > "This tolerance applies only to managed settings. User, project, and local
  > settings files remain strict: a file whose JSON or top-level shape fails
  > validation is rejected as a whole and reported, and an individual entry that
  > fails, such as a malformed permission rule, is skipped with a warning while
  > the rest of the file applies."

  Cadence, `permissions.md#tool-name-wildcards` (anchor confirmed on the
  rendered page; the sentence is `permissions.md` line 205):

  > "A deny or ask rule whose tool name matches no known tool produces a startup
  > warning to catch typos."

  That is why the warning fires once per merged-config **build**, not per
  request.

- **(a) our own, no upstream page governs it:** the choice of `debug()` as the
  channel, the message wording, the scope prefix, and the skill-grant half.

### The measurement, before any code

Probe on the production path (`parsePermissionsJson` →
`permissionsConfigCache.getMergedConfig` → `compilePermissionDslV1`), debug
enabled, stderr captured, input `deny: ['Read(C:\Users\alice\.env)', 'Cd(/a\b)']
+ allow: ['Bash(ls:*)']`:

```
PRODUCED  droppedRules: [["claude-settings-deny-0","deny"]]
          diagnostics:  [{"code":"unparseable-rule","message":"Permission rule
                          \"claude-settings-deny-0\" (deny) could not be compiled
                          (invalid pathGlob pattern) and was skipped. ..."}]
STREAM    [Permissions] Claude settings deny rule is anchored at its settings
          source, ... cannot be enforced: Cd(/a\b)
CONSUMED? stream mentions claude-settings-deny-0: false
          stream mentions unparseable-rule:      false
```

The row's premise is exactly right: **produced, and dropped.** The single line
on the stream is the **positive control** — a *parse-time* drop on the same rig
in the same function does reach it, so the absence of the *compile-time* one is
a real absence and not a dead rig.

### Correction to P2.270's report (worth carrying into the row note)

P2.270 §6.2 says "the only caller of `compilePermissionDslV1` in production,
`permissions-config.ts:1557`". **There are three**, measured with `git grep -a`
on committed blobs at HEAD (so no NUL-skip, and no working-tree noise):

| Call site | Diagnostics at HEAD | Verdict |
| --- | --- | --- |
| `packages/shared/src/agent/permissions-config.ts:1557` | dropped | **wired (this row)** |
| `packages/shared/src/agent/core/prerequisite-manager.ts:423` | dropped | **wired (this row)** |
| `packages/shared/src/agent/pi-harness/claude-permission-rules.ts:252` | already consumed | no change needed |

The third is the hook `if` filter. It does not read `.diagnostics`, but it
*does* consume the drop: a one-rule program whose rule is skipped evaluates to
`match.ruleId === 'invalid-policy'`, which it turns into
`{ run: true, unparseableRule: true }` — the documented fail-open. So it is not
silent at its own boundary. (What happens to that flag afterwards is a separate
gap; see §7.)

The absence claim was re-run with `-a` after the coordinator's NUL warning, with
positive controls both ways — see §6.

---

## 2. What changed

### `packages/shared/src/agent/permissions-config.ts`

New module-level `reportPermissionDslDiagnostics(program)`, called from
`finalizePermissionDsl()` immediately after `compilePermissionDslV1`.

- **One `debug()` line per diagnostic**, never an aggregate. The page says "with
  a warning for each"; "your settings had problems" does not let a user repair
  the rule they lost, and the diagnostic already names it, its action, the
  compiler's reason, and what the loss costs.
- A **per-rule** diagnostic is prefixed `Permission rule dropped from <scope>
  settings (<code>): …`. The scope is what points at *which* settings file to
  edit — a user with a workspace file, a project file and three plugin sources
  otherwise has to guess.
- A **layer-level** diagnostic (`invalid-document`, `unknown-matcher`,
  `stale-generation`, `invalid-jsonc`) has no rule and no scope to name — it is
  the *"rejected as a whole and reported"* half of the same sentence — so it
  reads `Permission policy diagnostic (<code>): …` and deliberately does not
  borrow the per-rule wording.
- Scope lookup is keyed by **diagnostic object identity**, because
  `compilePermissionDslV1` pushes the very same object into `diagnostics` and
  into `droppedRules[].diagnostic`. If that ever stops being true the line
  degrades to the unscoped wording rather than to a *wrong* scope. Pinned by
  the `dropped from project settings` assertion.

**Why `debug()` and not something new:** it is the same stream the two
**neighbouring** drops in this very file already write to — the parse-time inert
and unanchored drops inside `claudeSettingsPermissionDsl` (lines ~548, ~562) and
the managed-anchor drop in `buildMergedConfig` (~1455). All three halves of
"your rule was dropped" now land on one stream, keyed the same way. Measured:
`grep -ac 'debug(' permissions-config.ts` = **38**, `grep -ac 'console\.'` = **0**.
There is no second channel in this file to choose.

**No logging was added inside the compiler.** P2.270 declined to and was right;
the diagnostics come out in the return value and the caller routes them.

### `packages/shared/src/agent/core/prerequisite-manager.ts`

`compileSkillGrant` built a one-rule allow program per `allowed-tools` pattern
and discarded its diagnostics. Since P2.270 a pattern that **parses** but will
not **compile** is skipped, leaving that program with no rules;
`matchSkillToolPatterns` then answers `'no-match'` and the skill silently loses
the pre-approval its frontmatter asked for. Failing *closed* there is deliberate
and unchanged — a grant we cannot read must not widen — but it must not be
*silent*. One `this.onDebug?.(…)` per diagnostic, naming the **pattern**,
because the diagnostic's own rule id is the synthetic `skill-grant` and would
point the author at nothing.

Measured live before writing a test, so this is not dead code:

```
Skill allowed-tools grant "Read(/a\b)" was skipped (unparseable-rule):
  Permission rule "skill-grant" (allow) could not be compiled
  (invalid pathGlob pattern) and was skipped. It grants nothing; ...
grant on the good pattern:   true
grant on the broken pattern: false
```

**No behaviour changed in either file** — both edits are pure additions to the
reporting path. Every existing assertion about what a program contains or
decides is untouched.

---

## 3. Tests

**`bun scripts/bun-test-lock.ts run --label P2.271 --wait 3000 -- bun test
packages/shared/src/agent/__tests__/claude-project-settings-permissions.test.ts
packages/shared/src/agent/core/__tests__/skill-tool-grant-subject.test.ts`
→ 52 pass, 0 fail, 349 expect() calls, 524 ms, exit 0.**

The run's own stderr is incidental evidence for the row: with debug enabled, all
22 `UNCOMPILABLE` pattern classes P2.270 catalogued now each print their own
`Permission rule dropped from project settings (unparseable-rule): …` line,
naming the rule, the action and the compiler's reason — `invalid bash pattern`,
`invalid cdPath pattern`, `invalid semanticId`, `invalid server`, `invalid
agent`, `invalid host`, `invalid parameter name`, and so on. Before this commit
that output was empty.

### Added to `packages/shared/src/agent/__tests__/claude-project-settings-permissions.test.ts` (4)

All four run the **real** path — `parsePermissionsJson` →
`permissionsConfigCache.getMergedConfig` → `compilePermissionDslV1` — and read
the stream back with a stderr interceptor. **No double is handed a diagnostic
and asked whether it received it**, which is the failure mode this plan has been
burned by twice. The interceptor pattern is the one already in the file at
`the drop is reported with the reason and the remedy, not silently`.

1. **`names the rule, its action, the reason and the file it came from`** —
   asserts the drop still happens (`droppedRules`), then that the stream carries
   `unparseable-rule`, `claude-settings-deny-0`, `(deny)`, `invalid pathGlob
   pattern`, `skipped`, and `dropped from project settings`.
   *Forbids:* the wiring being removed; the message losing the rule id, the
   reason, or the scope.
2. **`one warning EACH, not one aggregate — three malformed rules, three lines`**
   — counts **lines**, not substrings, and asserts each id appears on exactly
   one line. Also asserts the surviving allow still decides, so announcing
   cannot be bought with enforcement.
   *Forbids:* an aggregated "your settings had problems"; a loop that reports
   only `diagnostics[0]`; a duplicate-emitting loop.
3. **`a clean settings file says nothing — the rig proves it by also failing`** —
   the absence claim, with a **positive control on the same rig**: the identical
   `build()` helper, one character different in the input, does produce the
   warning.
   *Forbids:* a wiring that warns unconditionally; and a rig that has silently
   stopped capturing, which would otherwise satisfy the absence half.
4. **`a DOCUMENT-level failure is announced too, under its own wording`** — 513
   rules trips `MAX_PERMISSION_DSL_RULES`; asserts `Permission policy diagnostic
   (invalid-document)` **and** `not.toContain('Permission rule dropped from')`.
   *Forbids:* a layer failure being reported as if it were one repairable entry.

### Added to `packages/shared/src/agent/core/__tests__/skill-tool-grant-subject.test.ts` (2)

Real `PrerequisiteManager`, real `setSkillInvocationToolGrants`, real `onDebug`.

5. **`names the pattern and the compiler's reason`** — one line, containing
   `Read(/a\b)`, `unparseable-rule`, `invalid pathGlob pattern`; plus the
   behaviour the line describes (`skillGrantAllows` → `false`).
6. **`one line per pattern, and a compilable neighbour is untouched and silent`**
   — three patterns, two uncompilable: exactly two lines, none naming the good
   one, and the good one still grants. Then a clean grant produces none.
   *Forbids:* one line per *grant* instead of per *pattern*; a warning fired for
   a pattern that compiled; and — via the positive control — a `withDebug`
   helper that had stopped wiring `onDebug` at all.

### The trap the dispatch warned about

I did **not** write any assertion against
`isWholeCapabilityDeniedByPermissionDsl`. P2.270 measured that
`isWholeCapabilityDeniedByPermissionDsl(program, 'bash')` returns `false` even
for a working deny filter, because rules compile to semanticId `'Bash'` and
`wildcard` is case-sensitive — so a negative assertion spelled `'bash'` cannot
fail. My row does not need that function, and the way to be safe from a trap you
do not need is not to walk near it. Every absence assertion I *did* write
(tests 3, 4, 6) carries a positive control on the same rig instead.

---

## 4. Proving it by breaking it

Both implementation hunks reverted to their HEAD state (`git show HEAD:<path> >
<path>`, **not** `git checkout` — the latter silently rewrites the index, which
under eight concurrent lanes would plant a phantom revert in someone else's
staged work), tests kept.

I first **stopped my queued `bun test` job**, because a lock acquisition landing
inside the revert window would have run the suite against reverted code and
produced a failure I could have misread as real. The probe itself runs under
plain `bun`, not `bun test`, so it never touches the mutex.

**17 assertions go red** with the wiring removed, spread across all six new
tests:

```
T1 contains unparseable-rule / claude-settings-deny-0 / (deny) /
   invalid pathGlob pattern / skipped / dropped from project settings   (6)
T2 line count 3 -> 0;  one line for deny-0 / deny-1 / ask-0 -> 0        (4)
T3 control fires -> ""                                                  (1)
T4 policy diagnostic line -> ""                                         (1)
T5 one line -> [];  names pattern / code / reason                       (4)
T6 two lines -> []                                                      (1)
RESTORED-OK
```

The assertions that survive the revert are the ones that should: the drop itself
still happens, the clean file is still clean, the survivor still decides, and
the skill grant still matches or does not. Those are P2.270's contract, not
mine, and this row must not change them.

Restoration verified byte-identical with `diff -q` before committing
(`RESTORED-OK`), and `git diff --stat` re-confirmed the working tree held my
version and nothing else.

**Assertions were also dry-run off-mutex before the real run** — the same six
tests' expectations executed under plain `bun` — so a wrong expectation would
not have cost a 30-minute lock wait to discover. That dry run and the real
`bun test` agree.

---

## 5. Gate

| Command | Contract it proves | Result |
| --- | --- | --- |
| `bun scripts/bun-test-lock.ts run --label P2.271 -- bun test <2 zone files>` | the diagnostics reach the stream, one line per rule, silent on a clean file | **52 pass, 0 fail, 349 expect(), 524 ms** |
| `bun run typecheck:shared` | the new `PermissionDslDiagnosticV1` import, the identity-keyed `Map`, and the restructured `compileSkillGrant` local all typecheck — and `tsc --listFiles` confirms **both new test files are in the program**, so a type error in them could not hide | clean, no output |
| `cd packages/shared && npx eslint <4 files>` | style/lint (note: `bunx eslint` from the repo root finds no config and exits 0 having linted **nothing** — that is not a pass; the real command is `lint:shared`) | exit 0, no output |
| `git diff --check` on all four | no whitespace damage | exit 0 |
| `git show --stat --oneline HEAD` | the commit holds exactly my four files under eight concurrent lanes | confirmed |
| revert probe | 17 assertions fail without the change | §4 |

**Not run, and why:** the full repo suite, builds, packaging, and the i18n
linters. Both edits are additive reporting on a path with no wire, schema, or
migration surface, and no localized string was added. Per the
implementation-first budget those belong to a verification-wave boundary.

**One skipped gate, stated so it does not read as a pass.** My first
`bun-test-lock` invocation (`--label P2.271`, default `--wait`) sat behind
`P2.85-attrib2` for ~32 minutes, then printed `bun-test-lock: not acquired` and
**exited 0 without running anything**. An exit code of 0 there means "gave up",
not "green". I re-ran with `--wait 3000` and that is the run quoted above; the
first attempt produced no evidence and none is claimed from it.

**Mutex:** heavily contended by `P2.85-attrib2` throughout. I never reaped
another lane's hold and never raised a lease ceiling.

---

## 6. The NUL trap, re-run as instructed

The coordinator's warning landed mid-task. It was **already the deciding factor
in one of my measurements** before the message arrived: `grep -c "debug("
permissions-config.ts` returned nothing, I re-ran with `grep -a`, got **38**,
and `file` reports the path as `data`. Every enumeration in this report used
`rg -an` (`-a` = `--text`) or `/usr/bin/grep -a`.

Re-run afterwards anyway, on **committed blobs** via `git grep -a` so no
working-tree state from the eight concurrent lanes could contaminate it:

| Enumeration | Result | Positive control on the same rig |
| --- | --- | --- |
| every `compilePermissionDslV1(` call site at HEAD | 3 production + 1 definition (§1) | 15 files total incl. tests, counted before filtering |
| any production read of `.diagnostics` on a compiled program at HEAD | **none** outside `permission-dsl.ts` itself (lines 860, 906) | the same expression finds the *producer*, `diagnostics: Object.freeze(diagnostics)`, in two files |
| any read of `.droppedRules` at HEAD across `packages`+`apps`, all extensions | **none** outside `permission-dsl.ts:908` and two test files | `git grep -a -c droppedRules` returns 5/6/2 hits in three files |
| a string inside the NUL-carrying file, via `/usr/bin/grep -a -rn` | found, both occurrences | — this *is* the control |

NUL detection was done by **reading bytes** (`python3 -c "…open(f,'rb').read().count(b'\x00')"`),
never by passing a NUL as a pattern. Of my six touched/read files, exactly one
carries a NUL: `permissions-config.ts` (×1). The other five are clean.

I did not use `xargs rg` or an unquoted `$DIRS` anywhere.

---

## 7. The scope boundary, and the precise hand-off

**What my zone honestly reaches:** the app's diagnostic stream, conditional on
debug mode. That is the same reach every other permission-rule drop in this
subsystem has had all along — the wiring makes the compile-time half consistent
with the parse-time half, it does not invent a new tier of visibility.

**What it does not reach, and where the next hop lives.** `MergedPermissionsConfig`
does not carry the diagnostics, and its consumers are all outside my zone:
`SessionManager.ts` (six call sites), `pi-agent.ts`, `codex-agent.ts`,
`core/permission-manager.ts`, `core/pre-tool-use.ts`, `mode-manager.ts`. The
per-request `invalid-policy` report P2.270 kept is also inert for this purpose:
`SessionManager.ts:3669` and `codex-agent.ts:1943` both test `action` **first**,
so an actionless report reaches them as the ordinary "no rule matched".

**The concrete landing site, if the controller wants an unconditional surface.**
There is already a channel of exactly the right shape:
`SessionManager.ts` (~4649–4653) builds `configDiagnostics` from
`loadProjectNessyAgentConfig(...).diagnostics`, filters `severity !== 'info'`,
bounds it, and emits it as
`security.filesystemScope.configDiagnostics: {severity, code}[]` in the Pi
runtime snapshot. A permission-DSL diagnostic is the same kind of object. Two
things that hop needs:

1. A carrier: a `permissionDslDiagnostics` field on `MergedPermissionsConfig`
   (that half is in **my** file and is one line) — **I deliberately did not add
   it.** Adding a field with no reader is precisely the defect this row exists to
   fix, and a second dead field would be this bug recurring inside its own
   remedy. It should land in the same commit as its consumer.
2. A shape decision the existing precedent gets wrong for us: that block is
   **code-only** on purpose ("the raw message may embed project paths"). Code
   alone is useless here — `unparseable-rule` without the rule id tells the user
   nothing. The rule id (`claude-settings-deny-0`) is **synthetic and carries no
   path**, so it is safe to include; the compiler's `reason` is a fixed
   vocabulary and also safe; the full `message` is likewise path-free today but
   is the part to re-check if it ever interpolates a pattern.

Then a renderer chip/banner. Both hops are **P4 UI work** and I did not touch
them.

**One further gap, found in passing, out of zone, not fixed:**
`evaluateClaudeHookIfFilter` returns `unparseableRule: true` for a hook `if`
rule that cannot compile, and the only production caller —
`hooks-automation.ts:713` — reads `.run` and discards the flag. So a hook whose
`if` filter is malformed fails open **and says nothing**. Same defect class,
different file (`packages/shared/src/plugins/hooks-automation.ts`), outside my
zone. Recommend a row.

---

## 8. Scope and commit hygiene

- **Edited (4):** `packages/shared/src/agent/permissions-config.ts`,
  `packages/shared/src/agent/core/prerequisite-manager.ts`,
  `packages/shared/src/agent/__tests__/claude-project-settings-permissions.test.ts`,
  `packages/shared/src/agent/core/__tests__/skill-tool-grant-subject.test.ts`.
- **Read only, not edited:** `permission-dsl.ts`, `claude-permission-rules.ts`
  (verified its consumer, no change needed), `SessionManager.ts`,
  `codex-agent.ts`, `hooks-automation.ts`, `apps/electron/src/main/index.ts`.
- **Not touched:** the plan file, the known-failing register, `.references/`,
  i18n (no new user-visible *localized* string — the warnings go to the
  diagnostic stream, which is English-only like all 38 of its neighbours in this
  file, so `lint:i18n:parity`/`sorted` are unaffected and were not run).
- Committed by explicit pathspec; never `git commit -a`; never inspected a
  pathspec-less `git diff --cached`. 21 other files were dirty from concurrent
  lanes; none of my four were, and none entered the commit.
