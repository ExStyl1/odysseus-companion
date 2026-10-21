# P2.254 — the first Bash check throws on any non-Electron host with PowerShell

Branch `feat/TCODE-000`. Base at start: `ef7634f6a`. **Committed: `c7fafb0e8`** (9 files).

---

## 1. What the defect actually was

`parseCommand` resolved the parser script through `getParserScriptPath()`, a
function that **threw** when `setPowerShellValidatorRoot()` had never been
called, and it called it **outside** its own `try`. The only production caller
of that setter is `apps/electron/src/main/index.ts:465`.

`getDeniedPathViolation` (`mode-manager.ts:317`) calls
`extractBashWriteTarget(command) ?? extractPowerShellWriteTarget(command)` on
**every** Bash permission check, ungated. So on any non-Electron host with
`pwsh`/`powershell.exe` on PATH — `nessy-server`, `apps/cli`; on Windows that is
every one of them — the **first Bash permission check threw an uncaught error**.

Confirmed as pre-existing, not P2.219's regression: see §2.

---

## 2. Reproduction — both arms, and three corrections to the row

### 2a. The pair alone at HEAD — the row says 19/2, I measure 15/6

`bun test .../mode-manager-bash-hints.test.ts .../mode-manager-path-boundary.test.ts`
alone at `ef7634f6a`, lock held:

```
 15 pass
 6 fail
Ran 21 tests across 2 files. [1156.00ms]
```

Every failure is `PowerShell validator root not set`. The row records **19 pass /
2 fail** for this pair. The test *count* matches exactly (21 = 9 + 12, and
471 + 21 = the 492 P2.219 reported), so the pair is the right one — **the split
does not match: three times as many tests fail as the row records.** All six fail
in single-digit milliseconds, so this is not the load-dependent family.

### 2b. A THIRD and a FOURTH file are in the blast radius, and the row names neither

The row names two `__tests__` files. Measured, the same throw also takes down:

| File | Alone, at HEAD before the fix | After |
| --- | --- | --- |
| `packages/shared/src/agent/__tests__/mode-manager-plan-shell-review.test.ts` | **2 pass / 5 fail** (979 ms, all throws) | 7 pass / 0 fail |
| `packages/shared/src/agent/backend/__tests__/read-patterns.test.ts` | **16 pass / 4 fail** (820 ms, failures at ~0.2 ms) | 20 pass / 0 fail |
| `packages/shared/src/agent/__tests__/pi-agent-guardian-consult.test.ts` | **14 pass / 139 fail** (2.32 s, all 139 the uncaught throw) | see §5 |

**The largest single casualty is a file nobody had named: 139 failing tests.**
Measured against the true pre-fix validator (`git show HEAD:` swapped in, my copy
restored after), that file alone is `14 pass / 139 fail` in 2.32 s, and *every
one* of the 139 is `PowerShell validator root not set`. Its `Remove-Item` ladder
is PowerShell, so it reaches the validator through `getBashRejectionReason`'s
`looksLikePowerShell && isPowerShellAvailable()` branch as well as through
`getDeniedPathViolation`.

Counting only what I measured, this one defect was failing **154 tests** across
four files on any dev machine with a real `pwsh`.

`read-patterns.test.ts` reaches it through the *other* extractor
(`extractPowerShellReadTarget`), which the row does not mention at all. Four of
its five `isPowerShellAvailable()`-gated cases threw; the fifth (`gc alias`)
survived only because `read-patterns.ts` gates on `looksLikePowerShell`, which
is false for `gc`.

**This also corrects the known-failing register.** Its entry for
`mode-manager-plan-shell-review.test.ts` records "HEAD 2 pass / 5 fail (25s); the
same file with P2.219's fixes 6 pass / 1 fail (40s)" and files it under the
*load-dependent spawn-ceiling* family. Measured at HEAD **with** P2.219's fixes
in the tree, that file is **2 pass / 5 fail in 979 ms** — the same 2/5 the
register calls "HEAD", but reached in under a second by five instantaneous
throws, not by spawn-ceiling expiry. Its "6 pass / 1 fail (40s)" arm can only
have been produced with a validator root already registered (co-scheduling), so
that register row attributes this defect's failures to the wrong cause. P2.240
already owns "the register family is named wrong in both directions"; this is a
third mis-naming for it.

### 2c. "Reproduces at base `8384b4239`" — confirmed, by a different route

I could not run the two mode files against a true base validator: `mode-manager.ts`
at HEAD imports `isWindowsPathWithinDirectory`, which P2.219 **added** to the
validator, so swapping in the base validator is a link error, not a base tree
(my first attempt produced `0 pass / 2 fail / 2 errors` — an artifact, discarded).

`read-patterns.test.ts` does not touch those symbols, so it *is* link-compatible
with the base validator, and gives a clean base measurement:

```
### BASE 8384b4239 validator: read-patterns.test.ts ALONE
 16 pass
 4 fail
Ran 20 tests across 1 file. [820.00ms]
```

Failures instantaneous (~0.16 ms), all `PowerShell validator root not set`. The
defect is pre-existing. ✔

### 2d. Arm B — the co-scheduling rescue, confirmed

`bun test packages/shared/tests/mode-manager.test.ts` + the pair:
**492 pass / 0 fail** — exactly P2.219's figure. `tests/mode-manager.test.ts`
calls `setPowerShellValidatorRoot(...)` at module scope and rescues its
neighbours in the same process. That green run was an artifact of which files
happened to run together.

---

## 3. The fix

`packages/shared/src/agent/powershell-validator.ts`

1. **`getParserScriptPath()` (throws) → `resolveParserScriptPath()` (returns
   `string | null`)**, and the call moved **inside** `parseCommand`'s `try`.
2. **A real default for non-Electron hosts.** Two candidates, in this order and
   no others:
   - an explicitly registered root — **authoritative**: the registration is the
     app's claim about where it *staged* the script
     (`apps/electron/scripts/copy-assets.ts` → `dist/resources/`), so a miss
     there is a packaging break we report, never something we paper over by
     reaching for a copy the app did not ship;
   - otherwise the script **sitting next to this module**. `@nessy-agent/shared`
     publishes `src/index.ts` as its entry and `nessy-server`/`apps/cli` both run
     `bun run src/index.ts`, so those hosts load this very file from
     `packages/shared/src/agent/`, where `powershell-parser.ps1` lives. That is a
     real default for exactly the hosts the throw was killing.
3. **Never `process.cwd()`-relative**, unlike the sibling helper
   `getBundledAssetsDir`. This path is handed to `pwsh -File`: a cwd-based
   candidate would let any checked-out repository supply a script we then
   **execute**. That is the hazard `getBundledAssetsRoot`'s own comment documents
   for trust material, except here the asset is code. Stated at the site.
4. **An explicit refusal that says so** when neither candidate resolves:
   `parseCommand` returns `{ success: false, error: 'PowerShell parser script
   (powershell-parser.ps1) not found; …' }` **and** emits a one-time
   `console.warn` naming the registered root (or saying none was registered).
   `debug()` alone would have been silent — silence is how this survived.
5. `setPowerShellValidatorRoot(dir: string | undefined)` now accepts `undefined`
   to clear (documented test seam), and resets the one-time warn flag; new
   `getPowerShellValidatorRoot()` mirrors `getBundledAssetsRoot()` so a caller
   can save/restore. Neither is added to `agent/index.ts` — surface unchanged.

### Why this fails toward firing

| Caller of `parseCommand` | On "script not found" | Direction |
| --- | --- | --- |
| `validatePowerShellCommand` | `parse_error` → `allowed: false` | **refuses** ✔ |
| `getPowerShellRejectionReason` (`mode-manager.ts:1484`) | non-null rejection → command rejected | **refuses** ✔ |
| plans/data-folder exception (`mode-manager.ts:2510`) | `null` target → exception does not fire → write stays blocked | **refuses** ✔ |
| `getDeniedPathViolation` (`mode-manager.ts:317`) | `null` → no PowerShell write-target candidate | under-approximates |
| `extractPowerShellReadTarget` | `null` → a read goes untracked | not a grant |

The one under-approximating row is the same direction P2.241 refused to move in
by gating — but it is **not blind**: `extractBashWriteTarget` runs *first* and
its patterns 5–8 cover `Out-File`/`Set-Content`/`Add-Content` including the
escaped-quote `powershell.exe -Command` wrapper (mode-manager.ts:2043-2065
documents them as "a REQUIRED fallback" for exactly the case where AST parsing is
unavailable), and `extractShellPathTokens` still contributes every path-like
token. And on the hosts that were broken, the new default means the AST answer is
now actually available, where before there was a crash.

**Electron is strictly improved too:** with `dist/resources/powershell-parser.ps1`
missing (copy-assets only *warns* on a failed copy), the old code spawned pwsh
per command against a nonexistent script and got `success: false`; the new code
refuses without spawning and says why, once.

---

## 4. Removing the co-scheduling coupling

The default resolves to `packages/shared/src/agent/`, which is exactly what
`tests/mode-manager.test.ts` registers at module scope. **The rescue is therefore
no longer needed and the outcome no longer depends on which files run together.**
Its setter call is left in place deliberately — it still exercises the
"explicit root wins" branch, and removing it would weaken coverage.

New file `packages/shared/src/agent/__tests__/powershell-validator-root.test.ts`
(4 cases) locks this in, and each case sets and restores the module state it
depends on, so it is order-independent:

1. no root registered → `shouldAllowToolInMode('Bash', …)` does **not throw** and
   answers `allowed: false` — the product path, the first Bash check;
2. no root registered → `extractPowerShellWriteTarget("… | Out-File -FilePath 'C:\…'")`
   returns the real target. **Positive control**: it can only be non-null if the
   module-adjacent script was located *and spawned*, so this proves a real
   default rather than a silenced throw. (Guarded by `isPowerShellAvailable()`;
   this host has pwsh 7.6.5 at `/opt/homebrew/bin/pwsh`, so the real branch ran.)
3. a registered root **without** the script → `validatePowerShellCommand('Get-Process', […allow…])`
   returns `allowed: false` with `parse_error` naming `powershell-parser.ps1`,
   and the warning names the bad root. Negative/boundary: it must **refuse**, not
   allow, and must not fall back to the module-adjacent copy.
4. a registered root without the script → a Bash check still does not throw.

---

## 5. The second-order finding: this fix makes P2.241's cost real

Before the fix, on this host the PowerShell extractor **threw instantly**, so
nobody ever paid for the ungated spawn. After it, every
`shouldAllowToolInMode('Bash', …)` on a host with a real PowerShell pays a
~0.69–0.88 s `powershell-parser.ps1` spawn — which is P2.241's defect, now
actually on the hot path.

In the test suite this immediately manufactured a *new* failure family: bun's
**5 s default per-test timeout sits below these files' new resting cost**, the
exact "narrowing knob below the resting state" trap. Measured `timed out after
5000ms` at 5.0 s, 5.4 s, 5.7 s, 8.7 s and 15.4 s in five different files, a
different subset each run.

Fixed by adding `setDefaultTimeout(30_000)` — the same value and reasoning
`packages/shared/tests/mode-manager.test.ts` already carries, recorded at each
site — to the **seven** files measured failing this way:

- `packages/shared/src/agent/__tests__/mode-manager-bash-hints.test.ts`
- `packages/shared/src/agent/__tests__/mode-manager-path-boundary.test.ts`
- `packages/shared/src/agent/__tests__/mode-manager-plan-shell-review.test.ts`
- `packages/shared/src/agent/__tests__/mode-gate.test.ts`
- `packages/shared/src/agent/__tests__/permission-mode-runtime-translations.test.ts`
- `packages/shared/src/agent/backend/__tests__/read-patterns.test.ts`
- `packages/shared/src/agent/__tests__/pi-agent-guardian-consult.test.ts`

Files in the same blast radius that call `shouldAllowToolInMode('Bash', …)` and
still have **no** ceiling — they passed both of my runs but are at risk under
load, and I did not edit them without evidence:

- `packages/shared/src/agent/__tests__/dont-ask-mode.test.ts` (2 sites)
- `packages/shared/src/agent/__tests__/mode-block-reason.test.ts` (3)
- `packages/server-core/src/sessions/SessionManager.process-supervisor.test.ts` (6)

**`pi-agent-guardian-consult.test.ts` does not come all the way back, and that
is a finding, not a loose end.** Its three arms on this host, each alone:

| Validator | Ceiling | Result |
| --- | --- | --- |
| HEAD, pre-fix | bun default 5 s | **14 pass / 139 fail** in 2.32 s — every failure the uncaught throw |
| fixed | bun default 5 s | **112 pass / 41 fail** in 666 s — every failure `timed out after 5000ms` |
| fixed | 30 s (committed) | **145 pass / 8 fail** in 1318 s — all 8 `timed out after 30000ms` |

139 → 41 → **8**. The eight survivors are the cases that consult repeatedly, so
they pay the spawn many times over: 31.9 s, 33.8 s, 42.7 s, 43.1 s, 43.8 s,
52.7 s, 63.8 s, 66.7 s. By name —

- `auto mode self-downgrade … > three consecutive fresh classifier blocks pause auto and announce it`
- `auto mode self-downgrade … > a non-blocked consult resets the consecutive counter`
- `auto mode: EVERY uncertainty tag downgrades to ask (R21) > circuit-open: the borderline action still reaches the human ask flow, never allow`
- `verdict binds to the EXECUTED input (TOCTOU) > original vs hook-rewritten forms are DISTINCT cache keys (no cross-hit)`
- `post-denial human override (G3 finding 1) > judge deny → circuit opens → user approves the prompt → …`
- `the three moved check classes (P2.3) > dangerous rm > auto + circuit OPEN: falls back to the human prompt`
- `the three moved check classes (P2.3) > background job > auto + circuit OPEN: falls back to the human prompt`
- `a nullish judge verdict fails closed, never hangs (P2.20) > a nullish verdict registers with the circuit breaker exactly like a transport failure`

I deliberately did **not** raise the ceiling further. A ceiling long enough to
cover 67 s of subprocess would hide a genuinely hung permission check for over a
minute — the same mistake the register argues against when it refuses to raise
the 10 s production `spawnSync` ceiling. The residue belongs to P2.241 (remove
the cost), not to a bigger number. It is also why the whole file now takes
**1318 s** where it took 2 s while broken: that is what P2.241's ungated spawn
costs once the code actually reaches it.

**This is the argument for P2.241 that the row asked for.** Its own note says
"measure how often the slow path is reached in a real session before choosing —
0.75 s is only a defect if it is frequent". Measured here: it is reached on
**every single Bash permission check**, in every one of the 21 test files that
touch that path, and in production on every Windows host. It is frequent.

---

## 6. A measurement trap hit live, worth carrying forward

`git checkout <sha> -- <path>` (used to put the base validator in place for §2c)
**silently rewrites the index for that path.** After restoring the file, `git
diff` compared my working tree against the *base* blob and showed me "adding"
P2.219's `isWindowsStylePath`/`isWindowsPathWithinDirectory` — a 164-insertion
diff of code I never wrote. `git reset -- <path>` restores the correct 116-line
diff. This is the same follow-on trap the brief describes for the isolated-index
commit method, reached through a different verb.

A second one, smaller: `rg` output rendered into this session has the **matched
text elided**, so `getBundledAssetsDir('docs')` was displayed as `n('docs')` and
read like a call to a function named `n`. Any absence/shape claim made off rg
output here needs a second look.

---

## 7. Evidence

All runs under `bun scripts/bun-test-lock.ts run --label …`. No `release/` dir
existed. Reported as pass/fail/skip splits, never ran counts.

| Run | Result |
| --- | --- |
| `pi-agent-guardian-consult.test.ts` alone, **HEAD pre-fix validator** | 14 pass / 0 skip / **139 fail** (2.32 s, all the throw) |
| `pi-agent-guardian-consult.test.ts` alone, committed tree | 145 pass / 0 skip / **8 fail** (1318 s, all >30 s timeouts — §5) |
| `read-patterns.test.ts` alone, **base validator** | 16 pass / 0 skip / **4 fail** |
| pair alone, HEAD before fix | 15 pass / 0 skip / **6 fail** |
| `plan-shell-review` alone, HEAD before fix | 2 pass / 0 skip / **5 fail** |
| pair alone, after fix | **21 pass / 0 skip / 0 fail** |
| `plan-shell-review` alone, after fix | **7 pass / 0 skip / 0 fail** |
| `read-patterns` alone, after fix | **20 pass / 0 skip / 0 fail** |
| new `powershell-validator-root.test.ts` alone | **4 pass / 0 skip / 0 fail** |
| three mode suites co-scheduled (arm B) | **492 pass / 0 skip / 0 fail** |
| full Bash-permission blast radius, 20 files | **912 pass / 0 skip / 0 fail** |
| `bun run typecheck:shared` | clean |
| `bun run typecheck:electron` | clean |
| `packages/server-core` `tsc --noEmit` | clean |
| `git diff --check` | clean |

Blast radius = every test file referencing `shouldAllowToolInMode`,
`isReadOnlyBashCommand`, `getBashRejectionReason`, `parseReadCommand` or
`getDeniedPathViolation` (21 files; `pi-agent-guardian-consult.test.ts` run
separately, see §8).

Known-failing register diffed by name: no entry of mine matches; the
`plan-shell-review` entry is re-attributed in §2b.

---

## 8. Concerns for the controller

1. **The row's numbers are wrong in the harmless direction, but wrong.** 15/6 not
   19/2 for the pair at HEAD, and two more files are affected than it lists.
2. **The register mis-attributes `plan-shell-review`'s 2/5** to the spawn-ceiling
   family; it is this defect. → material for P2.240.
3. **P2.241 is now load-bearing, not cosmetic.** §5.
4. **One new esbuild warning in the Electron main build.** Measured: adding
   `import.meta.url` to `powershell-validator.ts` makes `bun run build:main`
   emit `▲ [WARNING] "import.meta" is not available with the "cjs" output format
   and will be empty [empty-import-meta]` (1 warning; the build previously had
   0). The warning is *true* and the code is written for it — esbuild rewrites
   `import.meta` to `{}`, so `MODULE_DIR` is `undefined` in the packaged app and
   the explicit root is used, which is correct there. It can be silenced with
   `--log-override:empty-import-meta=silent` on `build:main`/`build:main:win` if
   the noise is unacceptable; I did not touch the build scripts.
5. **`pi-agent-guardian-consult.test.ts` is the file this row should have been
   written about.** 139 of its 153 tests were failing at HEAD from this defect,
   in a file neither the row nor the register names. It is now the largest
   remaining consumer of P2.241's spawn cost and a handful of its
   repeated-consult cases still exceed a 30 s ceiling — 8 of 153, §5. I did **not** put
   that residue into `docs/superpowers/specs/2026-07-29-known-failing-tests.md`:
   P2.240 owns that file's PowerShell family and is chartered to re-name it, and
   two lanes editing the same register section would collide. All the data it
   needs is in §2b and §5.
6. Another lane holds uncommitted hunks in `packages/shared/src/agent/codex-agent.ts`
   and untracked `zz-*` probe files. None of my files carry their changes, so a
   plain pathspec commit is safe; verified immediately before committing. Note
   that `permission-mode-runtime-translations.test.ts` imports `CodexAgent`, so
   my runs of it exercised that lane's **uncommitted** `codex-agent.ts`. It was
   green, but the committed tree is not what I measured for that one file.
7. **`nessy-server` is confirmed as a real affected host, not a theoretical one:**
   `packages/server-core/src/sessions/SessionManager.ts` is a production caller of
   `shouldAllowToolInMode`, and `server-core` is what `nessy-server` runs on.
   `packages/pi-agent-server` was checked and does **not** import the validator —
   its only mention is a comment — so the Pi subprocess is not a third host.
