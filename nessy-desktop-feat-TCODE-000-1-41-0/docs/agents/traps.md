# Measured traps

Moved verbatim from the root `AGENTS.md` on 2026-09-25 (from `1a6de488a`) to keep the always-loaded
guide under 300 lines. The one-line rules in `AGENTS.md` §Traps are the index; the entries below are
the measurements behind them. Add new traps HERE, newest first, with their date — and add a one-line
rule to `AGENTS.md` only when it is one every lane must hold in mind. Full narratives stay in
`docs/superpowers/specs/2026-08-21-measured-traps.md`.

## Traps That Have Each Cost A Real Measurement

Newest first, and every bullet carries its own date — this line used to count them ("one from wave 9,
then eight from wave 8, and a ninth…") and the count was stale within a day of being written, which is
the very failure the enumeration bullets below describe. Read the dates, not a total.

- **Never put `--preload` in `BUN_OPTIONS` for a run whose nested commands include `bun test` — the nested
  `bun test ./x` becomes the root `test` script, which runs `bun test` again, and it recurses.** Measured
  2026-09-26 (DN-187, F1.641) on Bun 1.3.14.
  - `BUN_OPTIONS` is prepended to every nested bun's argv, so `bun test ./x` is parsed as
    `bun --preload <file> test ./x`. With a flag in front, `test` is no longer the subcommand: bun reads it
    as `bun run test`, the root `package.json` script (`bun test && bun run test:isolated`).
  - The reading: about 3 000 processes in about a minute, stopped by killing the process group. The tree
    and the test lock were untouched apart from the lane's own hold.
  - To hold a child's boot (a sleeping preload), put the `--preload` in the suite's OWN spawn args, or
    point `NESSY_PI_SERVER_ENTRYPOINT` at a wrapper — never in an environment every nested bun inherits.

- **On macOS, once a Bun process holds about 10 240 fds (`OPEN_MAX`), `Bun.spawnSync` returns exit 0 with
  EMPTY stdout AND stderr. The child still runs.** A bare-path `bun test` gets there on its own. Measured
  2026-09-26 (CI-i, F1.59) on Bun 1.3.14.
  - `fd-probe` holds N descriptors, then spawns `console.log("hi")`. With 10 200 held it captured `hi`;
    with 10 236 or more it captured nothing. The pipe fds land at 10 240 or above.
  - The bare-path trigger: `test:shared:config` passed bare paths, so they were FILTERS, and bun walked
    the whole checkout. It held one DIR fd open per directory: **19 658** in this tree (untracked
    `work/`, the `release-aside-*` copies, `fastlane/vendor`).
  - The failure: `default-thinking-level.test.ts` then read `""` from every `runEval` child. It went
    **4 pass / 8 fail**, while the one case that reads `config.json` instead of stdout stayed green.
  - With `./` paths the same file ran 12 / 12.
  - A green-exit child with no output is therefore a harness reading, not a product one. Count the
    parent's fds (`lsof -p <pid> | wc -l`) before debugging the child.

- **Stopping a background swap-and-restore script with TaskStop SKIPS its restore step — the swapped files stay swapped.**
  Measured 2026-09-24 (WJ-bp, F1.632): six files were left at their HEAD content, found and restored by hand from the saved
  copies with the hashes checked. Run a swap inside ONE locked run and never stop it early; restore by writing each whole
  saved pre-swap file back and asserting its hash (the mutation-harness bullet below), and after any interrupted swap read
  `git diff` of every swapped file before trusting the next reading.

- **Bun 1.3.14's own `fetch` sees a proxy name only through the slot Bun pre-creates for it: a PLAIN runtime assignment
  (introducing or overwriting `HTTP_PROXY`/`HTTPS_PROXY`) IS read per request, while delete-then-assign — the only spelling a
  child's `{...process.env}` spread can see (the `process.env` bullet below) — is NOT.** Measured 2026-09-24 (WJ-ai, F1.498)
  and 2026-10-09 (BK-1, F1.1155, a recording proxy, 4/4 per arm). So a projection that must reach children (delete-then-assign)
  never reaches this process's fetch, and this process needs a per-request `proxy` option. And a DESKTOP-shape network test needs a NODE child, because Bun's `fetch`
  ignores undici dispatchers — the recipe is `apps/electron/src/main/__tests__/network-proxy-host-hop.test.ts`.

- **A CDP turn wait that returns on "the transcript grew and nothing is processing" accepts the user's OWN row as a finished
  turn: the host appends and flushes it BEFORE it raises `isProcessing`.** Measured 2026-09-24 (WJ-ad, F1.491; F1.260 was
  this). A turn counts only once it has STARTED — `waitForTurn` (`scripts/cdp/lib/state.ts`) now throws `turn-not-started:`
  rather than return — and `/clear` EMPTIES the live transcript, so no count-based wait can see it end: send it with
  `noWait` and wait for the emptying.

- **`bun test` preloads `unified-network-interceptor.ts` (root `bunfig.toml`'s `[test]` table) with NEITHER Pi marker set,
  so an in-process test that fetches a provider URL runs in the HEADLESS-server shape, not Pi's.** Measured 2026-09-24
  (WJ-ww, F1.315, whose suite uses exactly this as its instrument): `runsInPiSubprocess` reads `NESSY_PI_SUBPROCESS=1` or a
  set `NESSY_PI_MODEL_API` (the first since F1.531), and the runner sets neither. Setting one is what makes a test
  Pi-shaped — restore it in the same file, because the value outlives the file in its process.

- **bun freezes a CommonJS module's named exports at its FIRST ESM import, so a test that patches `require('react').X`
  AFTER any `import * as React` reaches no importer — and one that patches it BEFORE reaches both import styles.**
  Measured 2026-09-23 (WJ-cc, F1.216): the ordering alone decides whether the patch exists for the code under test, and a
  late patch reads as "the stub does nothing". Patch a CJS export in a preload or before the first import of the module,
  never after.

- **Server-side rendering a renderer component differs from the page in four measured places, and a render test that
  meets one reads it as a broken entry:** `useSyncExternalStore` throws without a server snapshot, a Radix Portal renders
  NOTHING, `localStorage`/`location` do not exist, and the modal scroll lock reads `document.body` during render.
  Measured 2026-09-23 (WJ-cc, F1.216, 154 playground entries / 854 renders); the recipe for each is in
  `apps/electron/src/renderer/playground/__tests__/fixtures/render-every-entry.ts`. Read it before calling an entry blank.

- **`lint:braced-region-controls` cannot see the TEMPORAL shape: a boundary control is checked against the needle's occurrences
  AT THE MOMENT THE GATE RUNS, so a control that is valid when the test is written becomes unfalsifiable the instant the FIX
  removes its needle — and the gate is green in between.** Measured 2026-09-20 twice in one lane (WJ-h, F1.172): the gate
  passed when the F1.169 test landed and refused the same file one commit later, with no test edit in between, because the
  fix had deleted the only line the control could anchor on. Re-run the gate AFTER the fix commit, not only after the test
  commit — and name a needle the fix cannot remove.

- **A test file restored from a hold OUTSIDE the tree can be red for the RIGHT reason and uncompilable at once, because
  `bun test` does not typecheck.** Measured 2026-09-20 (WJ-c, F1.75 → F1.163): the held failing arm reproduced the defect
  exactly (3 pass / 1 fail, the intended red) and carried a `TS7006` implicit-`any` parameter that `typecheck:shared` refused —
  the red was honest and the file was still not landable. A hold protocol therefore has two verbs, not one: re-run a restored
  hold under the lock AND typecheck its package before calling it restored; and a "failing arm first" reading is only
  evidence about the assertion, never about the file.

- **A `when: manual` job written inside `rules` with `allow_failure:exit_codes` is a BLOCKING manual job: the pipeline's
  status is `manual` (blocked), never `success`, so auto-merge never fires and the MR cannot be merged — while the job's own
  header said "Manual means it never blocks an MR".** Measured 2026-09-20 (the controller, MR !50, F1.159): every fix-branch
  pipeline of the day finished all four gates green and stayed `manual` on `codex-protocol-regeneration-diff`; the owner could
  not merge and the 1.40.0 release waited on it. GitLab's `ci/yaml/#allow_failure`: the default is "`false` for jobs that use
  `when: manual` inside `rules`", and `exit_codes` is "`allow_failure` false for any other exit code". A manual job that must
  not block a merge is `allow_failure: true` — and then its failure is a JOB colour, never a pipeline colour, which the job's
  header has to say.

- **A SQUASH MERGE that deletes its source branch orphans every sha that branch's docs and history-reading tests cite,
  and master's OWN pipeline is the first to fail.** Measured 2026-09-20 (the controller, master pipeline 126387848 after
  MR !48): `lint:plan-shas` refused 3 884 cells and the `scripts` chunks of the `test` job failed five historical-control
  cases (`git ls-tree <sha>` on commits that were ancestors of the branch and of nothing on origin any more) — the same
  content had been green on the branch minutes earlier. Two standing remedies: extend `archive/plan-cited-history` with the
  merged tip BEFORE the master pipeline reaches those jobs (memory rule; `git commit-tree -p <old archive> -p <tip> <tree>`,
  `update-ref`, push), and every CI job that reads history fetches every remote head (`lint` did since D1.423, `test` since
  this bullet). A branch pipeline cannot show this class: on the branch the commits are ancestors of the ref built.

- **bun REPRINTS every failure at the END of a run under `N tests failed:`, so a `(fail)` grep over the log DOUBLES the
  count and a file-header parser attributes the whole reprint block to the LAST file — which then looks like the reddest
  file in the run while being green.** Measured 2026-09-20 (the controller, D1.440-C): the first completed CI `test` job was
  read as 132 failures over 29 files with 66 of them in `WorkflowLaunchRequest.test.tsx`; the job's own summary said `66 fail`,
  WI-cc's recount from the raw log said 66 over 28 files, and that renderer file was never red — its "66 cases" were the
  union of the other 28 files' failures reprinted after its header. Sibling of the glued-`(fail)` bullet above (that one
  under-counts, this one over-counts; both come from reading the stream instead of the summary). The fail total is the
  job's own `N fail` line; a per-file attribution stops at the first `tests failed:` marker.

- **A test that assigns `process.env.NESSY_CONFIG_DIR` in its OWN MODULE BODY isolates nothing under `bun test`, and the
  symptom is every arm quietly measuring runtime `pi`.** Measured 2026-09-20 (WI-cb, D1.436): the isolate preload freezes
  `CONFIG_DIR` before the file runs, so the connections the file wrote into its `mkdtemp` config dir are never read, every
  connection lookup answers "no connection", and `resolveBackendContext` resolves that to the named DEFAULT provider —
  the lane's claude-gateway arm measured a pi session while its pi control "passed" on the same fallback, a dead control
  (`permission-remember.test.ts` carries the same inert fixture today, F1.129). This is the in-process half of the
  invocation-forms bullet below. Seed connections through the real storage API and ASSERT the fixture's provider before
  any arm (`claude-gateway-always-allow-scope.test.ts` is the shape); the control that separates the two is the same slug
  answering `'anthropic'` with the storage-API fixture and `'pi'` with the env-assignment one, same minute.

- **A python heredoc that ASSERTS inside a multi-statement shell script stops only its own statement — the `&&` chain
  that follows it starts fresh and commits whatever the failed step left behind.** Measured 2026-09-20 (the controller,
  D1.437): the edit step's anchor assertion failed (`AssertionError`, exit 1), the pin/regen/commit chain on the NEXT line
  ran anyway, and `60eaab0ec` reached origin with a message announcing a bun lift it did not contain — the yml was
  untouched, only the plan row landed. Sibling of the `&&`-chain and pipefail bullets: a gate that stops gating quietly,
  here the edit itself. Put the edit and the commit in ONE `&&` chain (or `set -e` the script), and read
  `git show --stat` of a commit whose message names a file before pushing it.

- **bun glues the `(fail)` line onto the TAIL of the preceding `Received:` dump when a source-text assertion fails, so
  `grep '^(fail)'` over a CI log under-counts the reds — and the miss is silent.** Measured 2026-09-20 (the controller,
  D1.433): pipeline 126365816's `test` job carried TWO failing cases and the anchored grep reported one; the second —
  `claude-default-mode-scope.test.ts`'s `not.toContain` over the whole of `claude-agent.ts` — printed its `(fail)` after a
  10 000-character `Received: "import …"` line with no newline between, and had been red on CI for eight days
  (the P6.665 stale-name guard, tripped by a docblock). Count `error: expect(` blocks, or grep `(fail)` UNANCHORED and cut
  the match; and read the job's own summary, never a grep's, for the fail total.

- **A remote-tracking ref is a reading from the LAST fetch, so `git branch -r --contains` reports a branch origin
  deleted weeks ago as present — and a "fix" derived from it cannot work.** Measured 2026-09-20 (the controller, D1.423):
  207 plan-cited shas were "all reachable from `origin/update/master`, `origin/feature/claude-like`, `origin/feat/models-fetch`
  or `origin/feature/mobile`", the `lint` job was taught to fetch every head, and the next pipeline was red on the same 207 —
  a `git fetch --prune` deleted `origin/update/master` on the spot and the re-measurement answered **0 of 207 on any origin
  branch**: all four branches were squash-merged MR sources origin no longer carries, alive only in one developer's clone.
  Before any "it is on origin" claim, `git fetch --prune` (or `git ls-remote --heads origin <name>`, the positive control that
  reads the remote and not the cache); and a sha that origin lacks needs an ARCHIVE REF pushed (`archive/plan-cited-history`,
  a compliance-files-only commit over the covering local tips — the push rule rejects an empty tree), not a wider fetch.

- **A CI artifact path of `node_modules/` carries the ROOT install only — every workspace's nested `node_modules/` is
  silently omitted from every downstream job.** Measured 2026-09-19 (WI-bs, MR !48): eleven workspaces' nested trees were
  missing from the `test` job's checkout, and the suites that needed them failed as if the code were wrong. The install
  artifact now lists each workspace's tree; when a job downstream of `install-bun` cannot resolve a workspace-local
  dependency, read the artifact's `paths:` before reading the test.

- **`bun scripts/bun-test-lock.ts run … | tail -N` reports the PIPE's status, so a run that never acquired the lock
  reads as exit 0 having executed ZERO tests.** Measured 2026-09-19 (WI-br's closing re-run): the lock script's `run` branch
  returns **3** when it cannot acquire, prints `not acquired`, and the `| tail` behind it answered 0 — the pipefail bullet
  below, met in the one place it is most dangerous, a closing confirmation. The FILE COUNT is what caught it (`Ran 0 tests`
  is not a pass). Never pipe a gate; write its output to a file and read the exit code from the process itself.

- **A `lint:chain` gate that walks the FILESYSTEM meets the RUNNER's caches on CI — `.gitlab-ci.yml`'s `.bun-cache` anchor
  keeps `.cache/bun/` (and `.npm/`, `.cache/electron*`) INSIDE the checkout because GitLab can only cache paths under the
  project directory.** Measured 2026-09-19 (WI-bs, MR !48): `check-conditional-expect` saw 2 662 test files on the runner
  against 2 318 locally and failed on 29 hits inside a cached `beautiful-mermaid@1.1.3` — green on every developer machine,
  red only on CI, the most expensive shape a gate can take. The discriminator is IGNORED (`git check-ignore`), not
  untracked: a lane's brand-new `foo.test.ts` must stay in scope. Every other chain walker enumerates through `git grep` /
  `git ls-files` or is scoped to a workspace root (swept the same day); a new gate that reads the filesystem must say which.

- **Releasing the test lock does not kill the child it was guarding — a `bun-test-lock.ts run` wrapper stopped early
  leaves its `bun test` ORPHANED and running UNLOCKED beside the next holder.** Measured 2026-09-19 22:04–22:05: WI-bs
  released after 65 min of a whole-repo run, WI-bt acquired at :55, and WI-bs's `bun test` child (pid 28833, 1 h 09 min old)
  was still alive for the next holder's first ~30 s until the controller killed it — the two-concurrent-runs trap with the
  lock honestly held by BOTH sides. Stop a locked run by killing the CHILD (`ps -o pid,ppid,command` under the wrapper),
  then let the wrapper release; and a lane told to stop mid-run re-takes anything red from the overlap minute.

- **A codex rig that omits the product's own permission profile measures a DIFFERENT product, and a `mkdtemp` under
  `$TMPDIR` is INSIDE codex's `workspace-write` sandbox.** Measured 2026-09-18 (WI-aw → WI-az, D1.342/D1.349): a rig built
  on the minimum options emitted no `[permissions]` block, so an 'out-of-workspace' `apply_patch` into `$TMPDIR` wrote with 0
  approvals and was reported as a safety hole; every REAL session passes `deniedReadPaths` (the credentials file), which makes
  the writer emit `default_permissions = "nessy_runtime"`, and with it the same arm raised `item/fileChange/requestApproval`
  even under `danger-full-access` — `exclude_tmpdir_env_var`/`exclude_slash_tmp` default to false in the pinned
  `config-schema.json`. Drive codex through the product's own config writer with the options a real session passes, and put
  the out-of-workspace target under `$HOME`, never under `/tmp`.

- **A landing script that checks cleanliness, applies its patch and commits WILL commit a neighbour's mutant planted in the same
  second.** Measured 2026-09-18 (WI-av on `SessionManager.ts`, WI-au's mutant): the file was clean at the check, the patch
  applied, and a `// MUTANT:` line from the sibling arrived before the commit. Re-read `git diff HEAD` by HUNK between the apply
  and the commit and refuse any hunk not carrying your own row marker; back out with `git apply -R` and land on a later window —
  never `checkout --`/`restore`/`reset` on a file another lane holds.

- **Inside a markdown table cell a real pipe must be written as a backslash-pipe, so `a\|b` under `-E` (a literal pipe) and
  the alternation the author meant are the SAME BYTES in the raw file and the count arm re-runs the raw form.** Measured
  2026-09-18 (WI-at → WI-ax, D1.319/D1.337): eleven declared probes read as `'a\|b'` under `-E`, every one declaring zero, and
  a correction that spelled 'the same command with a real alternation' was byte-identical to the command it contrasted. Spell an
  alternation in a cell as separate `-e` patterns — no pipe at all — so the raw text, the rendered page and the gate agree.

- **A control taken over a DIFFERENT scope than its probe cannot fail, and it makes a meaningless zero look verified.**
  Measured 2026-09-18 (WI-am, WI-ao, D1.160/D1.317): ledger cell A43 quoted `unmatched_form` → 3 files as the positive
  control of a probe run over `packages/core/src` + `packages/shared/src/protocol` — the control answers 0 there and 3 over
  `packages apps`, because the file it names lives under the Pi harness. A wrong probe makes a number meaningless; a dead
  control makes a meaningless number look verified, and the citation gate re-runs declared probes, never the prose control
  beside them. `check-ledger-citations` now has an arm for the two decidable shapes (D1.317); take every control over the
  probe's own pathspec, and never call a WIDER reading a positive control.

- **A null-codepoint escape written through the editing tool decodes to a LITERAL NUL byte, `lint:nul-bytes` then reddens
  `lint:chain` for every lane, and plain `grep` cannot show you why.** Measured 2026-09-18 (WI-an, D1.303): the commit
  shipped two NUL bytes; ugrep 7.8.4 answered rc=1 with NO output for strings the file really contained, at any flag, while
  `git grep` found them — the `-a` bullet below, live. Write such an example in words, and read a 'my edits did not apply'
  with `git grep` before believing it.

- **On this rig a gate that OPENS its corpus cannot be a `lint:chain` step.** Measured 2026-09-18 (WI-an, D1.318/D1.320):
  `readFileSync` over 860 files cost 155 s and one `cat` 139 s at `user 0.00` — the filesystem, not the runtime — against
  `git grep` 0.27 s over 4 790 files and one `git cat-file --batch` ~2 s; `check-nul-bytes` went 173.80 s → 1.33 s and the
  shape-pointer gate 132 s → 2.0 s by reading every clean file's BLOB (a clean file's blob IS its working-tree bytes) and
  opening only the `git status --porcelain` exceptions — a ` D` path named and skipped rather than crashing the chain.
  And the per-open cost is paid ONE FILE AT A TIME and overlaps under concurrency — 2026-09-24 (WJ-bz, F1.608): 25 files
  read one by one 12.22 s, the same 25 through `Promise.all` 0.19 s. So once a gate reads its clean files as blobs, its
  remaining cost is the porcelain exceptions it opens serially; a new gate opens them through
  `scripts/read-changed-files.ts`, as the four existing blob-reading gates do since F1.622.

- **`for p in $MINE; do kill -9 $p; done` with `MINE` a MULTI-LINE command substitution iterates ONCE over the whole string in
  zsh — nothing is killed, the old app keeps the debug port, the next launch fails to bind silently and the next case attaches
  to the OLD renderer.** Measured 2026-09-18 (SIT-5a): it presented as a fresh profile failing RS-32. Sibling of the
  unquoted-`$VAR` bullets below. Quote the expansion (`${(f)MINE}`), read pids from a real array, or list them literally — and
  prove the port free with `lsof` before the next launch.

- **Telling a child that never STARTED from one that ran and failed: bun 1.3.14 spells the difference in `syscall`, two
  ways, and a string `code` alone is not it.** Measured 2026-09-18 (WI-al, DA1.77): a spawn failure carries a STRING errno
  plus a `syscall` — `posix_spawn` for the ENOEXEC family and `spawn <path>` for ENOENT/EACCES, neither a prefix of the
  other — where a non-zero exit carries the NUMERIC status and no `syscall`; an `AbortError` carries a string `code` too, so
  `typeof code === 'string'` would call a cancellation a dead binary; and `accessSync(X_OK)` passes on a DIRECTORY. The
  table is `packages/shared/src/auth/dp/internal.ts`'s `spawnFailureErrno` docblock; read it before classifying a child's error.

- **`spawnSync` inside a test that also runs a loopback server DEADLOCKS — the blocked event loop cannot answer the child it
  just started.** Measured 2026-09-18 (WI-ak, DA1.48): it presents as a 5 000 ms timeout with ZERO assertion failures — the
  two-causes signature below — and it is neither cause: the test built the deadlock itself. Use async `spawn`, and give the case
  a budget sized for a bun CHILD's own module-graph load (30 s there, against a 5 s default sized for in-process work).

- **A test's 'stated reason' for keeping a hand-built double can be a POINTER at a sibling's shape, and a pointer decays silently
  the day the sibling converts.** Measured 2026-09-18 (WI-ah, D1.242): seven files in the SessionManager test family said 'the
  same shape as `<sibling>.test.ts`'; TWO were already false at the lane's launch HEAD because a sibling lane had converted the
  target the day before, and no phrase census can tell a pointer from an argument. Sibling of the 'comment asserting what a
  DIFFERENT module does' bullet below, one corpus over. Read the sibling before honouring the reason; D1.303 owes the guard.

- **A docs-site build is blind to a MISSING SECTION (it is not a dead link), and a heading-count parity check across locales is
  blind to the body under matching headings.** Measured 2026-09-18 (WI-af, D1.299/D1.300): `vitepress build` was green on all five
  ru/en gaps, and the ru page documented two provider types against en's four with the heading counts already equal. The build
  gate (D1.297) and the heading assertion (D1.301) each say in their docblock what they cannot see; read the section, not the count.

- **A sitting lane is a Claude Code agent, and that agent's shell exports names THIS PRODUCT reads — a bare `exec` of the
  packaged binary hands every one to the app.** Measured 2026-09-17 (WI-u, sitting 3): every Pi subagent spawn resolved its child
  to `opus` — a model the gateway does not serve, named nowhere in the profile, not asked for by the parent — because the shell
  carried `CLAUDE_CODE_SUBAGENT_MODEL=opus` AND `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, and the force flag outranks the per-call
  parameter, the frontmatter and the tier map; invisible in the transcript (the child's stored `model` is substituted back).
  Thirteen names scored non-zero (`CLAUDE_EFFORT=xhigh`, `ANTHROPIC_BASE_URL`, `MCP_CONNECTION_NONBLOCKING=true` among them); the
  derivation command lives in `scripts/cdp/lib/app-env.ts`'s docblock — never a copied list. Sittings 1, 2 and the 1.39.0
  release sitting launched the app with these inherited (D1.260 re-takes the readings that move). Launch every rig with the
  `env -u` launcher `scripts/cdp/README.md` prescribes; `lib/app-env.ts` blocks every new case that does not.

- **Stubbing `process.stdout.write` / `process.stderr.write` does NOT intercept `console.log`/`warn`/`error` under bun 1.3.14** —
  measured 2026-09-17 (WI-v, D1.232) on a first draft whose stubbed stderr captured nothing the sink wrote. A test of a log SINK
  must drive a CHILD and read its streams (the case now plants a `SINK-STDOUT-CONTROL` marker to prove the instrument reads
  stdout). And `console.debug` is an ALIAS of `console.log` in Node and Bun — a DEBUG line rides the stdout stream too.

- **`ru.json` legitimately carries MORE keys than `en.json` (2 849 against 2 783, measured 2026-09-17 by WI-q), and `lint:i18n:parity`
  is green.** A count comparison is not the parity instrument; never "repair" the larger file by deleting, and never assume the two
  files have the same shape — both are FLAT dotted-key maps kept sorted, and a nested lookup reports DRIFT on correct strings.

- **A boundary control whose anchor is declared ABOVE the region it bounds cannot fail** — a brace scan only runs
  forward, so `expect(region).not.toContain('<something earlier in the file>')` passes on the very runaway it exists to
  catch. Measured 2026-09-17 (WI-s, D1.111): four of four first drafts had it; the instrument is the LINE NUMBER of the
  needle's declaration against the region's start, not a re-read of the test. Name a declaration BELOW the region.

- **A negative needle can be one the corpus cannot spell.** Measured 2026-09-17 (WI-s, D1.111): `not.toContain('.env')` over
  the SDK's restrictive managed-settings table, whose grammar writes every path segment as a quoted string (`["env"]`) — the
  dotted needle can never match there, while the same bundle spells `.env` 219 times elsewhere, which is what made the needle
  look right. Before believing a negative, ask what the MATCH would look like in the corpus's own grammar.

- **A comment census that keeps only lines starting with `*` or `//` misses every single-line `/** … */`.** Measured
  2026-09-17 (WI-s, D1.109): it under-counted a justification census by one file. Include the `/\*` opener, or extract
  comments properly.

- **A bun `skip` count is NOT a test count: a skipped `describe`'s `beforeAll`/`afterAll` hooks are counted as skipped entries.**
  Measured 2026-09-17 (WI-r, D1.226), fitting exactly twice: 4 gated tests reported `6 skip`; 14 gated tests over 5 files
  reported `24 skip`. Read the pass/fail counts and the FILE count; a `skip` number larger than the case list is the hooks,
  not hidden cases.

- **A `grep -aoF` absence over the codex binary can be an absence of the FORMAT, not of the feature.** Measured 2026-09-17
  (WI-r, D1.112): the sentence `SessionEnd MCP hooks are not supported` answered **0** while its templated PREFIX answered
  **2**, the gate intact — the binary carries the message as a template with the event name substituted. Probe the shortest
  stable prefix, then read the bytes at the offsets, and give every absence a positive control on the same instrument.

- **zsh does not word-split an unquoted `$VAR`, so `git grep … -- $LIST` is ONE pathspec matching nothing and answers a
  SILENT ZERO — worse than the `bun test $FILES` case below, because `git grep` prints no file count and the run reads exactly
  like a clean absence.** Measured 2026-09-17 (WI-i, D1.159): five needles over five documents answered `0 / 0 / 0 / 0 / 0`,
  and the same five with the paths written out literally answered `5 / 166 / 138 / 5 / 6`. Write `"${LIST[@]}"` from a real
  array or list the paths literally, and give every absence census a positive control on the same instrument.

- **A comment edit in a heavily cited file must keep its LINE COUNT, or it blanks every line-tailed anchor below it within
  the minute.** Measured 2026-09-17 (WI-i, D1.167): a three-line docblock growth in `packages/shared/src/agent/mode-manager.ts`
  turned three plan anchors dead at once (each blank, each correct three lines lower); a lane cannot repair a plan anchor, so
  `847ba4768` put the conversion back into exactly the two lines the original occupied. Before editing a comment in a file the
  ledgers cite by line, `git grep -c "<basename>:[0-9]" -- docs` tells you the cost; then keep the count, or convert the
  anchors to symbol form in the same batch. Price the constraint with the GATED and LIVE citations, not the whole `docs/` grep: in `claude-agent.ts`, `SessionManager.ts` and
  `hooks-automation.ts` 95 % of line citations sit in dated specs, plans and generated data, and every one that landed inside
  `askToolApproval` or `releaseHookCard` on 2026-09-23 was already off its content
  (`docs/superpowers/specs/2026-09-23-hook-card-line-anchor-disposition.md`, F1.190).

- **`eslint` invoked from the REPO ROOT with `--config packages/<pkg>/eslint.config.mjs` answers "File ignored because no
  matching configuration was supplied" and exits 0 — a false green, and it hid a `lint:chain` red from every lane for hours.**
  Measured 2026-09-17 (WI-g, D1.199): `34aa88785` landed a duplicated `case` label, `no-duplicate-case` is `error` in
  `packages/shared`'s eslint base (P2.480), so `lint:chain`'s `lint:shared` step was RED at `436f7e7c7` for every lane —
  and nothing surfaced it, because lanes do not run `lint:chain` in the implementation loop (D1.1's decided policy) and the
  root-invoked probe said green. From the PACKAGE directory `eslint src/agent/claude-sdk-error-mapper.ts` answered
  `431:5 error Duplicate case label` at once. Run `eslint` from the package directory (or `bun scripts/lint-package.ts <pkg>`,
  which does), and read an "ignored" line as "nothing was linted", never as a pass.

- **`timeout <n> <cmd>` does not exist on macOS, and a gate wrapped in it reports a GREEN it never ran.** Measured
  2026-09-17 (WI-d, D1.69), three times in one lane: `timeout 900 bun run typecheck:shared` printed
  `(eval):1: command not found: timeout` and the wrapper exited **0**; unwrapped, the same command reported four real
  errors, three of them the lane's own. `timeout` is GNU coreutils; macOS ships none (`gtimeout` only with coreutils
  installed). Same family as the `&&`-chain and pipefail bullets below — a gate that stops gating quietly. Never wrap a
  gate in `timeout`; run it in the background and poll, which the lane rules already prescribe.

- **A lift is diffable as an ARTEFACT, because the bun install cache keeps the previous versions' tarballs.** Measured
  2026-09-17 (WI-a): `~/.bun/install/cache/@anthropic-ai/claude-agent-sdk@<version>@@artifactory.tcsbank.ru@@@1` still
  held 0.3.233 and 0.3.247 beside the vendored 0.3.251, so `diff -u` over the two `sdk.d.ts` (313 lines, 156 added / 9
  removed) settled the re-derivation clause of fourteen plan rows in one reading — where the string probes it replaced
  would have been twenty-two greps each needing its own positive control. The same cache holds the older codex and Pi
  packages. Diff the artefact first; probe by name only for what the diff cannot show (a behaviour, not a declaration).

- **A census of OVERRIDES cannot find a defect in the BASE method — and the base method can commit exactly the drop its
  own docblock warns subclasses about.** Measured 2026-09-17 (WC-c, DA3.8 HIGH): `McpClientPool.connect` computed the
  isolated connection key and then called `registerClient(slug, client, config)` — THREE arguments where the signature is
  `(slug, client, authority?, isolatedConnectionKey?)` — so every client was filed under the SHARED identity while every
  lookup used the isolated one; thirteen failures, one argument. `registerClient`'s docblock had warned OVERRIDING
  SUBCLASSES not to drop that argument, DA3.6's census swept 31 override sites and could never have seen it, and the
  isolation suite's every fixture pool overrode `connect` — the one method the defect lived in. When a guard or a census
  targets the subclasses, read the base method by hand once; and when a lever's suite stubs a method, drive that method
  for real at least once (cases (i)/(j) now do, 15/2 on the one-argument mutant).

- **A hand-off DIFF can delete a documented safety control while reading as a one-line tidy.** Measured 2026-09-17
  (WC-a, DA1.52): a one-line `resolveDpRuntime().workdir` conversion was right at one consumer and WRONG at
  `agent/backend/internal/runtime-resolver.ts`, where the same value is also a sandbox `writableRoots` grant — verbatim
  it de-canonicalised the grant (`plugin-node-runtime.test.ts` 2 fail → 0 after: a `/var/…` grant against a child
  writing through `/private/var/…`), would have let `DP_WORKDIR=$HOME` become a whole-home write grant, and would have
  REMOVED the grant in the dominant case (the record's `undefined` means dp falls back to `~/.dp`, still the directory
  it refreshes its token into). The AGENTS.md rule that a hand-off diff is a sketch, not a patch, already existed; this
  is the instance where following it saved a control: read what ELSE the replaced expression feeds before replacing it.

- **`lint:i18n:reachable` enumerates readers with `git ls-files`, so a key whose reader is UNTRACKED reads as
  "became unreachable" — and the gate's message tells you to delete the key.** Measured 2026-09-17 (WC-d, DA2.23): five
  `chat.modelPicker.provenance*` keys went red while their new reader `ModelListDisclosures.tsx` sat untracked in the
  working tree, and green with no drift the moment it was committed (2806 → 2807 tracked files); the sibling key
  `toolEgressDisclosure` stayed silent throughout, the control. Same family as the generated-ledger bullet above (a
  tree-scanning gate that reads the index): commit the new reader by the new-file recipe BEFORE reading the gate, and
  never delete a key on that gate's word while `git status` shows an untracked `.tsx`. Row DA1.62 makes the gate say so.

- **`git grep -E` on this rig does NOT honour `\b`, and the miss is SILENT — a word-boundary census answers zero and
  reads as an absence.** Measured 2026-09-17 (RF-b on the review's own R8 instrument; re-measured by the controller,
  git 2.43.0 on macOS): `git grep -anE '\beight\b' -- apps/cli packages/server-core/src/sessions` → **0** lines where
  the plain literal `git grep -an 'eight'` → **27**, `git grep -anP '\beight\b'` → **18** and the BSD form
  `git grep -anE '[[:<:]]eight[[:>:]]'` → **18** (same corpus, same minute). Under `-E` the `\b` is not an error — it is
  matched as something else, and nothing says so. Sibling of the `-a`/`-I` bullet below: a flag that is legal on one
  engine and silently different on another. Write word boundaries with `-P` or the `[[:<:]]…[[:>:]]` form, and give
  every absence census a positive control on the same instrument — the review's `"eight .DpAuthError"` pattern also
  missed one of its three sites (the test label has no backtick for the `.` to consume) and the plain literal found all
  three.

- **A LEVER whose only test stubs the path the lever changes measures the lever's KEY and never its POSTURE — a
  measured mechanism can select a posture that does not work.** Measured 2026-09-17 (WB-e, DA3.2 → DA3.8): P3.371's
  `NESSY_MCP_CONNECTION_ISOLATION=per-leaser` shipped with a suite proving three sessions get one shared and three
  isolated connections — TRUE, and not evidence that an isolated connection WORKS, because that fixture pool stubs
  `connect` and never calls a tool. The first end-to-end exercise (flipping DA3.2's default) answered 571 pass / 59
  fail: an isolated connection is created under its own key and is then unreachable through every surface that routes
  by tool NAME or reports by VERDICT (`mcp-pool-elicitation-routing.test.ts`, a REAL Streamable HTTP server: 10/0 under
  `shared`, 2 pass / 8 fail under `per-leaser` — same bytes, same day, only the env lever varied). Sibling of the
  C3.371 planted-collaborator bullet below: before advertising a lever, drive ONE real call through the posture it
  selects; and when a default flip goes red, run the OLD spelling on ONE unmodified file first — it separates "my
  change" from "the lever was always broken", which is what turned a size-S row into a HIGH finding instead of a
  wrong fix.

- **A green commit MESSAGE can hide a red: a count quoted before the failing arm existed.** Measured 2026-09-17 (WB-a,
  DA1.39): `080b545cb`'s message quoted `28/0 across 2 files`, taken before that same commit's last arm was written;
  the arm read a fixture from a directory `beforeEach` recreates and was red from birth, found by the NEXT row.
  Re-run a file your commit edited AFTER its evidence was taken, and read the pass count against the arm LIST, not
  against the previous run.

- **`TS2300: Duplicate identifier` is a SEMANTIC error — unlike the syntax-error bullet below, the program WAS fully
  checked, so a red in your own files would have been reported beside it.** Measured 2026-09-17 (WB-d, on a sibling's
  uncommitted DA1.40 edit): `typecheck:electron` exited 2 naming only `pi-agent.ts` twice, then 0 a minute later.
  Read the CATEGORY of the error before deciding what the run proves: a syntactic diagnostic (TS1xxx) blinds `tsc` to
  every semantic one in the package; a semantic diagnostic (TS2xxx) in a neighbour's file does not blind it to yours.

- **A CDP case can take a checklist id another row already CLAIMS, and nothing failed.** Measured 2026-09-17 (WB-f,
  DA2.11): the new case was born as `rs-39.ts` while RS-39…RS-42 were claimed by wave-A rows whose File column reads
  "case owed" — the harness checked the PLAN for the row id and the FILENAME for the case id, never the checklist.
  `10c10c142` adds the guard (a case whose id the checklist assigns to a different file fails `harness.test.ts`), which
  38 of 39 cases already satisfied. Read `docs/testing/cdp-live-checklist.md` before choosing a number; the guard sees
  only ids the checklist already carries, and `scripts/cdp/run.ts`'s own `SITTING` list is still unguarded (DA2.18).

- **A `mock.module` SPREAD isolates only the names it lists — widen a call site onto a NEW sibling export and the
  stub silently un-stubs it, and when that module reads a credential file the un-stubbed path is the REAL one.**
  Measured 2026-09-13 (WA-b, DA1.12): `CodexAgent.queryLlm` moved from `readNestorJwt` to a new sibling in
  `packages/codex-responses-adapter/src/nestor-auth.ts`; `codex-byo-upstream.test.ts`'s `mock.module` spread stubbed
  only the old name, so the suite read the developer's real `~/.nessy/dp_auth_creds.json` — caught LOUD by its own
  assertions (2 fail, not a silent pass), value redacted, fixed in `0f1d82996` by stubbing both readers. When you add
  an export to a module that tests stub, grep the stubs for the module path and extend every spread that names a
  sibling — the spread-and-restore rule below keeps the batch honest, not the seam.

- **A BACKTICK inside a preload TEMPLATE LITERAL closes it, and the file still PARSES.** Measured 2026-09-13 (WA-r,
  `pi-runtime-cwd-transaction.test.ts`): quoting identifiers house-style inside the test's preload template paired the
  backticks, the file compiled, and the CHILD received a broken preload — 0 pass / 1 fail / 1 error at 30 s where the
  fixed file runs in 1.9 s. Sibling of the `*/`-in-a-docblock bullet below: a preload string is code the child parses,
  so write identifiers in it unquoted, or build it from an array of lines.

- **CORRECTION 2026-09-20 to the ripgrep bullet below (WI-cc, D1.440, `f38c11c73`): the remedy it prescribes now BREAKS CI.**
  `@vscode/ripgrep@1.18.0` declares no `scripts` at all and ships the binary in a per-platform OPTIONAL dependency
  (`@vscode/ripgrep-<platform>-<arch>`), resolved through `require('@vscode/ripgrep').rgPath` — so
  `node_modules/@vscode/ripgrep/bin/rg` is an artefact of the old layout on machines that once installed it (4.5 MB dated
  2026-09-13 here) and never exists on a fresh checkout, and `bun pm trust @vscode/ripgrep` exits **1** (`0 scripts ran …
  already trusted, don't have scripts to run, or don't exist`), which skipped every job after `install-bun` on pipelines
  126382092/126382096. Resolve `rgPath` and prepend `dirname(rgPath)` to the child's PATH (`pi-denied-result-paths.test.ts`
  does now), and the CI install job asserts the resolver's answer instead of trusting a package with nothing to run.

- **The vendored ripgrep is a PRECONDITION of every real-search suite, and its absence reads as a denied-path
  REGRESSION.** `bun install --frozen-lockfile` does not run `@vscode/ripgrep`'s trusted postinstall, so
  `node_modules/@vscode/ripgrep/bin/rg` can be absent on a fresh checkout (this host has no system `rg`); the suites
  prepend that `bin` to the child's PATH and then fail carrying the tool's own refusal — *"This tool requires `rg`…
  exit 127"* — POSITIVE CONTROLS included, which presents as a runtime lift having taken over the filtering natively.
  Measured 2026-09-13 (WA-r): `pi-denied-result-paths.test.ts` 3 fail at 16:49, the binary's mtime 16:59 (the dmg
  build's `bun pm trust`), 5 pass / 0 fail twice after. `ls node_modules/@vscode/ripgrep/bin/rg` before believing any
  denied-path or search red; `bun pm trust @vscode/ripgrep` belongs beside `bun install --frozen-lockfile`.

- **A minified binary's packed string table makes a character-class grep UNDER-COUNT while the prefix count stays
  right — so the number is correct and the NAMES are wrong.** Measured 2026-09-13 (W19-z2, C3.380 lift 2) on
  `codex-app-server 0.154.0`: `grep -aoE 'configRequirements/read\.[A-Za-z0-9_]+'` answers **2** where
  `grep -aoF 'configRequirements/read.'` answers **4**, because the strings are concatenated with no separator and the
  class swallows the neighbour that follows. The gate that reads the COUNT fired correctly and the hand-probe that read
  the NAMES reported two of four. Use `-F` for the prefix, then read the bytes at each `grep -aobF` offset to recover
  the names.

- **`check-ledger-citations` enumerates with `git ls-files` and reads from DISK, so a file you have RESTORED but not yet
  committed is invisible to it and its citations still read as dead.** Measured 2026-09-13 (W19-z2): a reverted rename
  looked like it had not worked until the restore was committed. Same family as the ledger-generator trap above — a
  tree-scanning gate run mid-edit measures the working tree, and here the working tree was right while the gate read
  the index's file list.

- **A `bun install` after a dependency pin bump can DROP that package's optional platform-package entries from
  `bun.lock` and leave the previous version's native binary on disk — reporting success.** Measured 2026-09-13 (W19-z,
  C3.380) lifting `@anthropic-ai/claude-agent-sdk` 0.3.247 → 0.3.251: the three pins moved, bun printed `+ …@0.3.251`
  and `2 packages installed`, exit 0, and the eight `@anthropic-ai/claude-agent-sdk-<platform>` entries went **8 → 0**
  while `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64` stayed at 0.3.247. The two self-reports then
  DISAGREED — `claudeCodeVersion` 2.1.251, `claude --version` 2.1.247 — the only thing in the tree that could see it; a
  CI `--frozen-lockfile` would then have pinned no native binary at all. `bun install` again, `bun install --force`
  (1328 packages) and removing the stale directory all failed to repair it; two isolated rigs at the same registry
  refused to reproduce it. What repaired it: revert the pins, install, re-bump, install. **The cause is not named and
  the instrument is what transfers**: after ANY pin bump of a package that ships a native binary, read BOTH
  self-reports and count the lockfile's platform entries before trusting the install — and the §"docs are the contract
  for BEHAVIOUR" bullet that says the two self-reports *agree* is a reading with a date: they CAN part company, and the
  parting is the signal.

- **A rig that PLANTS a collaborator the production path does not have converts an end-to-end test into a
  tautology, and the greenness is indistinguishable from a working feature.** Measured 2026-09-12 (F3,
  C3.371): `reopen-compact-or-keep.test.ts`'s `answerRig` set `managed.agent = { respondToPermission: () => {} }`
  (cast away), and three cases then drove the REAL `requestPiToolApproval` + the REAL `respondToPermission`
  and passed — over a card whose every answer returned `false` on the packaged build, because
  `respondToPermission` gated its whole body on `managed?.agent` and the reopen card is raised from
  `getSession`, before the reopened session's first message has created one. The test was end-to-end in
  every respect except the one that mattered, and the HIGH hid for two waves. **Ask of every planted
  collaborator whether production has it AT THIS MOMENT in the lifecycle** — not whether it exists
  somewhere — and when a rig must plant one, add the un-planted arm as the negative: it is four lines and
  it is the whole defect.

- **An absence probe DECLARES its unit to the gate; its positive CONTROL stays prose with a date.**
  Measured 2026-09-12 (W18-a, C3.21/C3.319, after wave 17 had paid six wrong counts the same way): a
  control written as `**files=401**` was answered **402 within minutes** by a sibling lane's commit
  that happened to name the key — a declared number is a RATCHET, and a control's whole job is to
  prove the probe can see, not to hold a value. So the zero (the absence) is declared in the gate's
  `**files=N**` form, which re-runs it and goes red the day a reader appears; the control beside it
  is written as prose with the date it was taken (`answered 401 on 2026-09-12`), never declared. A
  declared control that moves with the tree is the class of red the wave-17 ledger lanes spent a day
  on, and it teaches the next reader that the gate cries wolf. The ledger's own census section
  (§"Counts, honestly" in `2026-08-28-capability-ledger.md`) carries the recipe for a quiet-tree sweep.

- **A count over a MINIFIED binary is two different numbers, and a docblock that quotes one without
  naming the INSTRUMENT will be read as refuted by the next measurement.** Measured 2026-09-11 (W16-l2,
  C3.159, then C3.294): the same three needles over the vendored darwin-arm64 `claude` at `2.1.247` answer
  **0 / 5 / 43** under `grep -ac` and **0 / 9 / 156** under `grep -ao … | wc -l` — `-c` counts LINES, and a
  minified bundle puts thousands of occurrences on one line, so the two instruments disagree by up to 4x
  on the same bytes and the same day. The test header that said `0 / 13 / 135` at `2.1.233` was not wrong
  and not contradicted; it was taken with the other instrument, and nothing said so. AGENTS.md already
  forbids reading a `-c` probe by its OUTPUT line count (the `grep -c` bullet below); this is the
  symmetric rule for the number you write down: **name the instrument beside every binary count**
  (`grep -ac` → lines, `grep -ao … | wc -l` → occurrences, `-aoF` for a literal), and prefer occurrences
  on a minified file, because a line count there measures the minifier. A number with no instrument is a
  reading nobody can repeat.

- **A bare top-level TOML key appended AFTER a table header belongs to that table — and codex then
  discards the WHOLE file naming a section that had nothing to do with it.** Measured 2026-09-11 (W16-g,
  C3.214): appending `log_dir = …` to the end of a real `config.toml`, whose last section was
  `[permissions.<profile>]`, produced `invalid configuration: … FilesystemPermissionToml in 'permissions'`
  and the binary fell back to defaults — the key had become `permissions.<profile>.log_dir`. The same
  shape hides in every writer that concatenates fragments: a top-level key is top-level only ABOVE the
  first `[table]` line. Write top-level keys first, or emit them through the writer's own key/section
  model (`packages/codex-responses-adapter/src/config-writer.ts` builds sections in order for this
  reason); never `>>` a bare key onto a file you did not read to the end.

- **A DEFAULT FLIP has no instrument, because its stale pins go GREEN rather than red.** Measured
  2026-09-11 twice from opposite sides (W13-b, P6.1073; W13-i). P6.531 flipped the unattended codex
  verdict from `accept` to `deny` and stranded four tests; **three of the four were PASSING** — each had
  stopped *discriminating* rather than started failing (a floor test "outranking the headless yes"
  passed against a build with no floor at all, because with the hatch shut the floor and the fallback
  both decline). And a copy test pinning the runtime NAMES stayed green while the sentence beside them
  ("approval granted in advance") had turned false — literally true words, false reading. Neither half
  trips any gate this repo has. **When a change flips a DEFAULT, ask of every old pin whether it can
  still FAIL** — a control whose two arms now agree is a deleted test that still runs — and grep the
  PROMISES the old default made (locales, dialogs, docblocks), not only the assertions.

- **A multi-sha tracker cell is INVISIBLE to the obvious regex.** Measured 2026-09-10 (W9-ca, the
  1.35.0 close-out): the plan writes several shas as ONE backticked span joined by ` + `, so a
  `` `([0-9a-f]{7,12})` `` extraction finds nothing there — **609 rows instead of 766**, and every one of
  the twelve controller-named release highlights was in the missing 157. Extract with `\b[0-9a-f]{9}\b`
  over the sha CELL, and read the row TOTAL against `plan-status.py`'s before trusting a derived list.

- **A bare `.isolated.ts` path handed to `bun test` is a FILTER, not a path — and beside ONE matching
  filter the whole run goes green with nothing naming what was dropped.** Measured 2026-09-10 (W9-ce
  met it as 14 paths -> `Ran 81 tests across 13 files`; re-measured at HEAD by W9-cf on
  `paths-env.isolated.ts`, `paths-security-env.isolated.ts` and `lifecycle.test.ts`). With NO
  `./`-prefixed argument, EVERY argument is a filter, and a filter can only match a file bun already
  counts as a test file — `.test`, `_test_`, `.spec` or `_spec_` in the NAME — so a bare `.test.ts`
  path works by accident, matching itself as a substring, while a bare `.isolated.ts` path matches
  nothing. **All-bare-and-nothing-matches is loud**: `The following filters did not match any test
  files`, exit 1, and bun even prints the remedy. **One matching filter beside it is silent**: a bare
  `lifecycle.test.ts` plus a bare `paths-env.isolated.ts` printed `Ran 35 tests across 1 file.` and
  exit 0 — byte-for-byte what a nonsense filter (`zzz-no-such-filter-zzz`) produces in the same
  position. Prefixing ANY argument with `./` switches the whole list to path mode, and the bare
  siblings then resolve as paths too (`./A` + bare `B` ran `3 tests across 2 files`) while a
  nonexistent path goes back to being silently skipped. `package.json`'s `test:isolated` survives only
  by accident of `find .` emitting `./`-prefixed paths. This is one step past the missing-path trap
  below — there the path did not exist, here it exists and is reinterpreted. **Write `./` on every
  path you hand `bun test`, and read the FILE COUNT**: it is the only instrument that sees this.

- **An unescaped `|` inside a ledger cell DROPS THE ROW from `plan-status.py`'s table — and the guard
  that names it writes to STDERR while the damage lands on STDOUT.** Measured 2026-09-08 (W9-bn, twice
  in one session — a TypeScript union and a regex alternation, each written verbatim into a `Why` cell),
  mechanism re-measured 2026-09-09 (P6.935) on a rig copy of the ledger: ONE injected pipe takes the row
  total **632 → 631** and moves six other numbers with it — Pi partial 132 → 131, Claude covered
  142 → 141, Codex covered 95 → 94, Host no-verdict 519 → 518, and both remainder columns — every one of
  them exactly the size of a plausible verdict delta, which is what a lane is reading that table for
  after its own commit. **The "silent" half of that account is refuted**: `b3e92c8ca` (2026-09-03) added
  `⚠ ledger row <id> has N fields, not 9 — an unescaped |` and it fires. What survives is *where* it
  fires — stderr, beside the run's other stderr line, while the table a lane actually reads is stdout, so
  any invocation that captures or pipes only stdout drops it. **Escape every pipe inside a cell as `\|`,
  and read the row TOTAL rather than the deltas after every ledger commit**: a column that moved by one
  and a row that vanished are indistinguishable in the deltas alone.

- **A REPAIR of a citation can CREATE a finding, because the identifier check reads the FIRST backticked
  token after the anchor and cannot tell it belongs to the NEXT anchor.** Measured 2026-09-08 (W9-bn),
  mechanism re-measured 2026-09-09 against `attachedIdentifier` (`scripts/check-ledger-citations.ts`):
  a two-anchor repair written in the natural order — identifier, its path, sibling identifier, its line —
  hands the SECOND identifier to the FIRST anchor, and the gate fires against a correction that is
  entirely right. Probed on the two forms: the flowing one returns `isForkAgentName` (the far identifier)
  where the parenthesised one returns `FORK_AGENT_NAME` (the near one). **The only form that survives is
  one citation, one parenthesised identifier** — `<path>` then `(NAME)`, then the sibling anchor then
  `(ITS NAME)`. Same family as §"Upstream Docs Are Contracts"'s rule that a correction spelling the dead
  anchor re-creates the finding it repairs: a guard reading prose beside a citation cannot tell which
  citation the prose is about, so put the pairing in the punctuation.

- **A citation sweep RACES the shared tree, and one session's sweep lost that race nine times.** Measured
  2026-09-08 (W9-bn); the growth re-read from the index 2026-09-09: across that lane's own commits
  `SessionManager.ts` went **34 287 → 34 297** lines and `claude-agent.ts` **10 731 → 10 767**, from
  sibling lanes, inside a window of about forty minutes. Anchors derived twenty minutes earlier were
  already wrong when the gate ran — and the gate reported them as NEW findings **against the lane's own
  repair**, which reads as the repair having been done badly. This is the working-tree-reading trap with
  the clock in it: the reading was right when taken. **Re-derive every anchor from the INDEX
  (`git show HEAD:<path>`) immediately before the commit, not when the batch was planned**, and read the
  cited file's own line count as the tell — a count that moved since you derived means every anchor into
  that file must be re-taken.

- **`grep -c <pattern>` with NO file argument reads STDIN — it hangs a runner forever, and its output is
  ONE line whichever way it ends.** Measured 2026-09-08 (W9-bn: a probe runner hung for an hour on
  exactly these), re-measured 2026-09-09 on ugrep 7.8.4: with stdin left as an unwritten pipe the process
  is still running after 3 s and never returns; with `stdin=DEVNULL` it exits 1 and prints `0`. The
  second half is the one that corrupts a result rather than stalling it: **a runner that counts OUTPUT
  LINES cannot read a `-c` probe at all** — `grep -ac <pat> <file>` prints one line and `grep -c <pat>`
  with no file prints one line, so such a runner answers **1** in both cases and never the count. Four of
  one sweep's 45 "stated 0, now non-zero" refutations were that artefact and not a refutation. **Parse
  the number a `-c` prints; never count its lines. Give every probe runner `stdin=DEVNULL`.**

- **A timing A/B needs a THIRD instrument beside the control run: PAIRED, ALTERNATING arms.** Measured
  2026-09-08 (W9-bg, P6.910): the same COMMITTED bytes of the four `session-mcp-server` harness suites
  ran **719.08 s at load 14.49** and **32.58 s at load 36.55** — a **22x** spread running BACKWARDS
  against load, at 0.7 % cpu. So the rule below ("a control run at the same moment") is not enough on an
  I/O-bound suite: "the same moment" is minutes wide, and the page cache moves more than the change
  does. The before/after pair that lane committed is weakened by exactly this — the after-run was
  adjacent to the before-run and inherited its warmer cache — and its own commit message says so, which
  is the honest half. **Run the two arms A, B, A, B and compare ADJACENT runs**; a single before/after
  pair, however carefully timed, is one cache reading. The claim that survives with no confound is the
  STRUCTURAL one (26 children became 10; the same cases, expect() and FILE counts before and after) —
  prefer it to a wall-clock sentence whenever it is available.

- **zsh does NOT word-split an unquoted `$VAR`, so `bun test $FILES` runs ZERO files and exits 0.** (And the SYMMETRIC fact, measured 2026-09-19 on both shells: an unquoted `$(…)` command substitution IS word-split by zsh and by bash alike — `env $(bun -e '…-u A -u B…') cmd` unset both names under both shells while `UNSET=…; env $UNSET cmd` left them set under zsh. So a list that must reach a command as separate arguments goes INLINE as `$(…)`, or through a real array; the first draft of the cdp README's launcher repair put it in a variable and would have re-created the trap it closed.)
  Measured 2026-09-08 (W9-bg, P6.910): a paired A/B passed its four test paths through an unquoted
  parameter expansion; `bun test` received ONE filter matching nothing, ran nothing, and returned green
  in **0.45 s**. Only the FILE COUNT caught it. This is one step past the trap below ("a path that does
  not exist runs the rest and says nothing"): here **nothing ran at all**, and the exit code did not say
  so. The controller met the same shape the same day on `git diff -- $FILES`, which produced an empty
  patch and read as "no changes". Write `"${FILES[@]}"` from a real array, or list the paths literally —
  and read the FILE COUNT of every run, which is the only instrument that sees this.

- **A red that appears BESIDE a concurrent run is not evidence of a shared resource — read the resource
  before naming it.** Measured 2026-09-08 (P6.626): a `plugin.test.ts` red seen next to a background
  `bun test` was written up as a fixed staging path two processes share, and the row's fix was scoped to
  that cause. At HEAD **every** staging site is unique per call — three `randomUUID()` in `store-v2.ts`,
  three `mkdtemp` across `source-resolver.ts`, `acquisition.ts` and `adapter-migration.ts` — the suite
  builds its own `mkdtempSync` root per `beforeEach` and never touches the config dir, and `bunfig.toml`'s
  `[test]` preload gives each PROCESS a private `NESSY_CONFIG_DIR` anyway. The failure then did not
  reproduce in three runs (alone; beside one concurrent suite; beside two), 46/0 each time at 4 % cpu.
  Concurrency is the loudest hypothesis in this tree because so many real traps here are concurrency, and
  that is exactly why it gets asserted without a reading. The refutation and the two non-reproductions are
  in the known-failing register; the transferable half is the ordering — **read the shared thing first,
  and if it turns out not to be shared, that is the finding.**

- **A COMMAND-CORPUS count is a reading with a date, and the corpus is discoverable from nowhere else.**
  The one read-only copy of real agent-issued Bash commands lives OUTSIDE the repo — transcripts are
  untrusted data and may carry secrets — named by `NESSY_COMMAND_CORPUS` and read ONLY through
  `bun scripts/command-corpus.ts` (`build` | `stats` | `split-diff`), which SKIPS cleanly and exits 0
  wherever the copy is absent, so nothing in `bun test` depends on it. P2.91 measured **18 272** distinct
  commands and every posture decision the heredoc model rests on quotes numbers derived from that figure;
  the same source measured **19 619** on 2026-09-07. Quote the script's own output beside the date, never
  a number carried forward — and never commit the copy. CI's arm is the derived counts-only slice at
  `packages/shared/src/agent/pi-harness/__fixtures__/heredoc-shape-slice.json`
  (`scripts/heredoc-shape-slice.ts`), which is structurally incapable of emitting command text; it is
  deliberately the weaker half, so a number it pins moving is a reason to run `split-diff` again rather
  than to edit the number.
- **A generator script edited in a shared tree is LIVE for every other lane before it is committed.** A
  neighbour ran `bun run ipc:inventory` while another lane's change to `scripts/ipc-inventory.ts` sat
  uncommitted, and the generated file briefly gained a line that exists in no commit (measured 2026-09-07,
  W8-td). Nothing broke only because that line had been made non-load-bearing. Every other shared-file
  rule here is about a FILE two lanes write; this is a shared TOOL — one lane writes the script and the
  damage lands in a different file committed by someone who never touched it, whose own `git status` looks
  correct. **Commit the generator BEFORE announcing the regeneration step**, or make the change safe to run
  uncommitted.

- **`expect(obj).toMatchObject({ k: expect.stringContaining(x) })` OVERWRITES `obj.k` WITH THE MATCHER**,
  so every later read of that object gets `[object ExpectStringContaining]` — `JSON.stringify` gives
  `{}` — instead of the value. Measured 2026-09-07 (W8-td, P6.699) on bun 1.3.14, with both controls in
  the same file: the identical object asserted with a LITERAL expectation is untouched, and **`toEqual`
  with the identical asymmetric matcher does not mutate**, so this is `toMatchObject`'s doing and not
  the matcher's. It cost a confusing red on a test that was already passing its real assertion. The
  danger is the silent direction: a later `expect(obj.k).toBeDefined()` PASSES on the matcher, and a
  later snapshot or log records `{}`. **Read the value into a local FIRST, then assert on it** — never
  assert a shape with a matcher and then read the same object. 41 call sites in 22 of this repo's 1 892
  test files pass an asymmetric matcher into `toMatchObject`; the same-line grep finds only 8 of them,
  so count with a window, not a line.


- **The two-causes timeout rule below has a THIRD outcome, and it is the common one on a suite whose
  wall time is its MODULE GRAPH: a timer lottery.** The same bytes pass and fail at comparable loads,
  so *"run at both load extremes"* can return the same verdict twice by luck. Measured 2026-09-07
  (W7-ag, P6.652) on `plugin-info-diagnostics.test.ts`, every arm byte-restored and sha-verified to
  baseline: **354.41 s at load 7.59** and **127.25 s at load 14.97** — slowest at the LOWEST load, a
  2.8x spread running BACKWARDS against load, every cold run under 2 % cpu — plus **2.19 s at 90 % cpu**
  on the same bytes straight after `typecheck:electron` had warmed the page cache, **162x**. So
  *"passes alone at low load → starvation"* hands out the wrong name on an I/O-bound graph. **The
  separating instrument is the zero-case control — `bun test <file> -t '<a name nothing matches>'`,
  which prices the graph with no test running at all** (53.87 s, 0 cases executed, 0.56 s user /
  0.35 s sys). **Read `user`/`sys` beside the wall time**: cpu under ~2 % of wall is I/O, not
  contention. And never take a reading straight after a typecheck or a tree-wide grep as the floor —
  that is the cache, not the file.
- **`bun test --reporter=junit` is what separates a module-graph red from a test red, and nothing else in
  this list can.** It prints a `time=` attribute per TEST BODY beside the file's own total, so the two
  costs stop being one number. Measured 2026-09-07 (W7-ae, P6.646) on `pi-harness-baseline.test.ts`: all
  23 bodies are milliseconds — slowest three 152 ms, 100 ms and **65 ms for the very case that times out
  at 5 000 ms** — against file totals of **75.66 s**, **341.01 s** and **1.32 s** for the same bytes, plus
  W8-g's filtered reading of 542.83 s. So a per-test budget sized from the failure message would have been
  set against 65 ms and left the other 22 tests exposed to the identical mechanism: the budget belongs to
  the FILE (`setDefaultTimeout`), sized against the largest observed run total. It pairs with the zero-case
  control above — the control prices the graph with nothing running, junit prices every body inside it, and
  a body in milliseconds under a file total in minutes means the red is the graph, not the test:
  `bun test <file> --reporter=junit --reporter-outfile=<out.xml>`, then read the `time=` attributes.
- **Waiting for a shared file to be released does NOT protect your hunk — the holder's pathspec commit
  sweeps it.** Measured 2026-09-07 (W7-ah): its 73-line block in the known-failing register sat
  uncommitted beside W7-ag's three live hunks in the same file; obeying the shared-file rule it waited,
  and W7-ag's `git commit -F … -- <paths>` took the WORKING TREE, so the block landed under
  `234e09383` with another lane's subject. Nothing was lost, the row→sha mapping was — the staged-index
  trap from the third side. Hold the edit OUTSIDE the tree (your report, the scratchpad) until the file
  is clean, or hand the text to the file's holder. Waiting inside the tree is not waiting.
- **And when you APPLY a hand-off, re-read its call signatures against the receiving file's own
  neighbours — a hand-off diff is a sketch of intent, not a patch.** Measured 2026-09-08 (W9-bh,
  P6.913): W9-av's P6.868 diff was wrong in three places and **two of them would have COMPILED** — a
  `rpc/settings.ts` handler written as `(mode: unknown)` where every neighbour in that file takes
  `(_ctx, …)`, so it would have read the context as the mode; and `setCrossSessionInbound(mode as never)`,
  where the cast silently returns `false` for a bad value instead of refusing it. The third (`routing.ts`
  classification unmentioned) was a hard `AssertNever` compile error, and it is the only one a gate
  caught. All three were found by reading the neighbours, which is the instrument — the two cast bugs
  would have shipped a green typecheck.
- **A stale-count guard written as a substring of a number WORD will match the number that replaces
  it**, and it then fails on the CORRECT sentence — reporting as unfixed the very thing the commit just
  fixed. Measured twice in one wave by W8-h (2026-09-07): `not.toContain('Claude → Codex lists four')`
  matched its own live successor *fourteen* (P6.391), then `not.toContain('SIX rows are surfaced')`
  matched *TWENTY-SIX*. `six`/`sixteen`, `SEVEN`/`SEVENTEEN` and every `TWENTY-`/`THIRTY-` compound are
  one row away from the same failure. Write bounded matches (`/… four(?!teen)/`, or a word-boundary
  regex) — and convert every sibling guard in the same block at once, because the second occurrence was
  inside the block the first one was fixed in.
- **A stale-NAME guard on a bare identifier fails on the very commit that removes the name, because the
  comment explaining the removal spells it.** Measured 2026-09-08 (W9-f, P6.665):
  `expect(agentsOverlay).not.toContain('agents.tools')` went red on `6d6d5fece`, the commit that deleted
  the only reader of that key — the renamed line's own comment says why `agents.tools` was wrong, and
  says it by name. Same inversion as the number-word bullet above and as P6.675/P6.736: a substring
  guard cannot tell code from the prose beside it, and it fires exactly when the thing it guards has
  just been made correct. Guard the CALL, not the identifier — `not.toContain("t('agents.tools')")` —
  and assert the SUCCESSOR present in the same test, so the pair cannot be satisfied by deleting both.
- **`--update` on a derived ledger reads the SIBLING LANES' uncommitted edits.** Measured 2026-09-07
  (W8-h) on `scripts/i18n-unreachable-keys.txt`: one regeneration produced twelve new lines, **four of
  them another lane's mid-edit state** in `AppSettingsPage.tsx` that a `--check` twelve minutes earlier
  had not listed. Committing them would have recorded a neighbour's half-finished tree as a durable
  fact, to be met later as unexplained drift. Regenerate a derived ledger **from a quiet tree**, or
  commit the generated output MINUS the lines you did not cause, and diff it against the previous one
  before trusting it. Same family as the untracked-reader trap in the spec: any tree-scanning generator
  run mid-wave measures the neighbours. **The window is narrower than "the neighbours' tree", and knowing
  its exact shape is what makes the check cheap:** these ledgers enumerate with `git ls-files` and then
  read the file from DISK, so a neighbour's untracked file is invisible while a **tracked file they have
  edited and not yet committed** is read at its working-tree state — that one case is the whole residue.
  So when a ledger or a census fires on a line you do not recognise, re-run it against the index before
  believing it: `git grep --cached` (or `--cached` on a gate that offers it, as
  `scripts/check-settings-line-citations.ts` does) reads what is committed-or-staged rather than what a
  neighbour is mid-edit on, and the two agreeing is the evidence that the movement is yours.
- **(Already a trap below, and it was paid twice more anyway.)** A quoted glob inside a `/** … */`
  docblock **closes the comment** — the star-slash in a pattern like a double-star, slash, `*.pem` ends
  it and the rest of the file is parsed as code. Recorded 2026-08-31 (nine hard parse errors); paid
  again 2026-09-07 by W7-ai in `packages/shared/src/agent/mode-manager.ts`, twice, on
  `.a*/credentials` and a double-star `credentials.enc` pattern. The rule was written down and still
  cost two compile failures, because a denied-path docblock is exactly where a glob wants quoting.
  Write the example out in words, or put it outside the block comment.
- **A decision that ENUMERATES names must cite the list the enumeration was derived from.** Measured
  2026-09-07 (W8-i), twice in one wave, and inside tracker DECISIONS rather than inside comments —
  where no guard looks. P6.539's decision named **four** `OTEL_LOG_*` content opt-ins where the page's
  table has **five**, and the fifth is the one whose documented fallback to `OTEL_LOG_USER_PROMPTS`
  makes a four-name strip *look* total: an operator who exported it alone would have kept exporting
  every assistant turn through a strip this repo had recorded as complete. P6.530's done-means asked
  for a name to be ABSENT where absence re-enables the tool on Windows. This is §"docs are the contract
  for BEHAVIOUR, not for MEMBERSHIP"'s *prose enumerations age silently*, one layer up. Name the source
  beside the names — the bundle's own array, the page's table, the constant — so the next reader can
  **re-derive** the list instead of re-counting a sentence.
- **A comment asserting what a DIFFERENT module does not do has no guard, and the module that falsifies
  it has no reason to look.** Measured 2026-09-08 (W9-a, P6.551, `16ae99cc9`).
  `codexDeclinesAgentToolGrant` (`capabilities/resolver.ts`) stated its residue precisely — *"the
  resolver never opens the file. `markdownAgentRecords` (`capabilities/native-sources.ts`) hashes the
  file and reads nothing out of it"* — and both sentences were true when written and FALSE at HEAD:
  P6.602 (`ec4bc3173`) had taught `pinnedAgentMetadata` to parse the frontmatter with `matter()` two
  days earlier. **It cost a size-M plan row**: P6.551 was written from that premise and priced two
  seams (a synchronous parse per agent file on every scan, or carrying a per-session verdict back into
  the capability layer) against a cost of zero; it closed as an XS refutation. Three defences all
  missed — it is not a decaying ANCHOR (nothing to re-resolve, it asserts a behaviour); it is not
  testable from where it lives (a `resolver.test.ts` case cannot fail because another module started
  reading a file); and **the falsifying commit edited the very same file and walked past it**,
  correcting two docblocks stating the same premise in `runtime-agent-definition.ts` while the third
  sat ~650 lines above its own edit in `resolver.ts`. So: prefer a `{@link}` over an assertion — it can
  only fail to resolve, never quietly become false; when you do assert, leave a BACK-POINTER in the
  asserted module in the same commit (`pinnedAgentMetadata`'s docblock carries one now), because that
  is the only artefact placed where the falsifying edit happens; and when you falsify a premise, grep
  the CLAIM and grep it SHORT — `git grep -an 'hashes the file' -- ':(glob)packages/**/*.ts'` returned
  all three copies, while the longer `'reads nothing out of it'` returned two, the third being wrapped
  across a line break.
- **The three `mock.module('pdfjs-dist', …)` stubs every renderer test copies are HALF the recipe, and
  the half that is missing throws from a SECOND pdfjs the stub cannot reach.** Measured 2026-09-08
  (W9-y, evidence committed in the docblock of
  `components/info/__tests__/local-mcp-disabled-surfaces.test.tsx`, `5cb47993c`): importing
  `SourcesManagementRow` under bun costs **136 s** and then throws `ReferenceError: DOMMatrix is not
  defined`. Not from the `pdfjs-dist` the test stubbed — `mock.module` keys on the RESOLVED module, and
  `react-pdf` resolves its own nested copy (`node_modules/react-pdf/node_modules/pdfjs-dist`, **5.4.296**
  against the top-level **5.7.284**, both present at HEAD), which no stub of the bare specifier covers.
  So that copy really loads and wants a DOM. The missing half is the **global `DOMMatrix` polyfill** that
  sits below the stubs in `pages/__tests__/capability-info-pages.test.tsx` — a reader copying the three
  `mock.module` lines takes the visible half and leaves it. All 19 files stubbing `pdfjs-dist` in this
  tree carry the polyfill too; copy the block, not the stubs. And weigh the 136 s before choosing a
  render test at all: a source-text assertion is often the honest instrument for "does the value reach
  the component", which is what that file settled on.

Three more, measured 2026-09-06 by lane W7-r:

- `lint:i18n:sorted` compares against `JSON.stringify`, so a `\uXXXX`-escaped locale VALUE fails as "not sorted" —
  write the character, not the escape.
- A module and its `.test.ts` can sit in DIFFERENT lanes' zones (`runtime-backed-tools.ts` did) — zone the test with
  its module, always.
- `applyManagedEnv` records managed origin only when it writes the real `process.env`, so a test passing
  `target: process.env` passes VACUOUSLY — assert on the origin record, not on the write.


Rules only; the full narratives (what was measured, when, what it cost) are in
`docs/superpowers/specs/2026-08-21-measured-traps.md`. Every one produced a
wrong answer that looked right.

- "Pre-existing" vs YOUR base is not "pre-existing on `master`" — before any
  merge, compare against the target branch, never only your base.
- Some source files carry a NUL byte and plain grep skips them SILENTLY: use
  `grep -a` for any absence claim, and never `head -N` a grep before knowing
  the hit count. **The count is a reading with a date, not a fact — run
  `bun scripts/check-nul-bytes.ts` instead of trusting any number in prose,
  including this one.** It reads every byte of every tracked `.ts`/`.tsx`.
  Measured 2026-08-29: 14 files, 28 NUL bytes, of which 12 were escaped as
  `\u0000` (byte-identical value, source stays greppable) leaving 2. Measured
  2026-08-30 after P2.415 escaped those last two: **0 files.** This tree has said
  "one", "eight", "thirteen", "fourteen" and now zero, each correct when written
  — which is why `lint:nul-bytes` is now a step of `lint:chain` (P2.416) and why
  four documents were changed to point at the script instead of quoting a number.
  A count here is a reading with a date; the gate is the fact. **And the
  clever instrument is the dangerous one:**
  `comm -23 <(git ls-files) <(git grep -lI '')` reads only the ~8000-byte prefix
  git inspects, so it found 4 of the 14 — plus one zero-byte file carrying no
  NUL at all — and looked like a complete answer both times.
- **And the flag that undoes it is one letter away: `-a` and `-I` are OPPOSITES and the LAST one
  wins**, so `git grep -anI` / `grep -naI` silently cancels the `-a` the bullet above prescribes.
  Measured 2026-09-08 on a two-file probe (one plain file, one carrying a NUL byte, the same NEEDLE in
  both): `grep -rna` found both needle lines in the NUL file, **`-rnaI` found neither**, `-rnIa` found
  both again; `git grep` behaved identically (`-na` two, **`-naI` none**, `-nIa` two). Worse than a
  smaller number: plain `git grep -n` at least prints `Binary file … matches`, and under `-I` that line
  is gone too, so the absence is unfalsifiable from its own output — and this rig's `grep` is **ugrep
  7.8.4, not GNU grep** (`grep --version`), which prints no binary notice at any flag, making `-rn` and
  `-rnI` byte-identical. The row that produced this bullet quoted `git grep -anI skipWebFetchPreflight
  -- packages apps` → 0 against `-an` → 13; **re-measured at HEAD both give 16** (15/15 at
  `c20c6671c`), and `bun scripts/check-nul-bytes.ts` says 0 of 4578 tracked files carry a NUL byte — so
  over TRACKED sources the two flags cannot diverge today, and that headline is refuted. The divergence
  that survives is outside them: unrestricted `grep -rn` and `-rnI` over `packages apps` gave 27 lines
  each where `grep -rna` gave 32. Never pass `-I` in the same command as `-a`, and say which corpus an
  absence claim was made over — `git grep` reads tracked blobs only.
- A `**` pathspec handed to `git grep`/`git ls-files` is read **WITHOUT glob magic** and silently
  drops files: `packages/shared/src/**/*.ts` gave 24 hits over 14 files and missed one file
  entirely, where `:(glob)packages/shared/src/**/*.ts` gave 25 (measured 2026-08-31). No error,
  just a smaller number that looks like an answer. **And a grep is not a rule run** — the same
  lane's row claimed 25 call sites where the rule itself found 16, nine of the difference sitting
  inside string literals no linter reads as code; an earlier row said 40 where the rule gave 172.
  Where the tool can answer (`eslint --print-config`, a throwaway tsconfig, the rule in a scratch
  config), run the tool.
- **`git commit -m "…"` with backticks in the message is COMMAND-SUBSTITUTED by zsh** — house style
  quotes identifiers in backticks, and one lane's message swallowed a `` `git ls-files` `` span into a
  5 921-line commit (measured 2026-09-03; the code was fine, the message is permanent). Write the
  message to a file and pass `-F <file>`, or single-quote it and never nest a backtick.
- **A bare `git add` followed by `git commit` in a SHARED working tree commits another lane's staged
  index** (measured 2026-09-06: three files a lane had staged were swept into a concurrent lane's
  `i18n(...)` commit whose own message said "committed alone"; nothing was lost, the row→sha mapping
  was). With parallel lanes, commit only in the atomic form `git commit -F <msg> -- <pathspec>` —
  it stages and commits exactly the named files in one step — and never `git commit --amend`, which
  once rewrote a sibling lane's message.
- `git commit <pathspec>` takes the file's WORKING-TREE state, not your hunks:
  zone parallel work by FILE; two units needing one file run in sequence.
- **`bun test` given a path that does not exist RUNS THE REST AND SAYS NOTHING** — a lane named five
  suites and ran four, and a green run over four of five is indistinguishable from a green run over
  five (measured 2026-09-01). Read the FILE COUNT, not the pass count; any *N pass / 0 fail* is only
  as strong as the number of files behind it.
- Two concurrent `bun test` processes manufacture failures (module-scope env
  mutation); check the known-failing register before recording a new one
  (`docs/superpowers/specs/2026-07-29-known-failing-tests.md`).
- Assigning to `process.env.X` in Bun 1.3.14 leaves the name readable by
  property and INVISIBLE to `Object.keys` and `{...process.env}`. Every
  subprocess env in this tree is built by spreading `process.env`, so the CHILD
  GETS NOTHING while the parent still reads the value. `delete` first, then
  assign — on the restore path too. **TWO conditions are needed, and the second
  is the one nobody stated** (measured 2026-09-01, both arms plus an
  arbitrary-name control):
  - **The name is one Bun pre-creates a slot for.** This is NOT "the six proxy
    names": it is those six **plus `NODE_TLS_REJECT_UNAUTHORIZED`**, a
    TLS-verification name that is no kind of proxy — while
    **`ALL_PROXY`/`all_proxy` ARE proxy names and are NOT affected** — plus `TZ`
    and `BUN_CONFIG_VERBOSE_FETCH`, which sit in no classification table at all.
    Do not trust that sentence either; it is a reading with a date, and this tree
    has said five, six, eight, fourteen and zero about such sets. **Run the
    command — the slots enumerate themselves, so it needs no list:**
    ```sh
    bun -e 'const s={...process.env};console.log(Object.getOwnPropertyNames(process.env).filter(n=>!(n in s)))'
    ```
    A managed `env` block carries ARBITRARY names, so the `delete` is
    unconditional rather than gated on a list that cannot be complete.
  - **The name is ABSENT from the launch environment.** Overwriting an inherited
    value was always visible; **INTRODUCING** one — the ordinary case for an
    administrator mandating a proxy — was not. **That is why it presents as
    machine-dependent: a reader who tests by overwriting concludes there is no
    bug.** The same command shows this arm too — a genuinely set `HTTPS_PROXY`
    drops off its list, because it is then enumerable and unaffected.
  **And `in` LIES for exactly these names.** `'HTTPS_PROXY' in process.env` is
  `true` in a fresh process where it is unset — the slot pre-exists and only
  enumeration skips it — so `in`, the natural way to write "was it present at
  launch", is wrong for every name under discussion; this lane's own
  launch-was-clean check reported a dirty rig that was clean. Read the value or
  the spread, never `in`. **The unlock is STICKY for the rest of the process**,
  so a suite whose setup deletes the name passes the assertion with the fix
  REMOVED; the only instrument that can see it is a throwaway child. Two live
  under `packages/shared/src/config/__tests__/fixtures/`:
  `proxy-env-spread-probe.ts`, and `managed-env-spread-probe.ts`, which spawns a
  real GRANDCHILD from the spread so the verdict is "the subprocess received it"
  rather than "an object literal contained it".
- **A fixture whose module body ends in a process exit, imported by a test,
  KILLS THE RUNNER AT IMPORT TIME and reports exit 0 with ZERO TESTS EXECUTED** —
  a green run that ran nothing, and the exit code does not say so. Measured
  2026-09-01 on `managed-env-spread-probe.ts`, whose test imports its name list
  precisely so the two halves cannot drift. Put EVERY side effect in such a
  fixture behind `import.meta.main`, and read the executed-test COUNT rather than
  the exit status — the same reading that separates a starved suite from a
  failing one.
- A `mock.module` without a spread amputates the module **when it is installed before
  anything in the process has loaded that module** — then every name the stub does not
  list is gone, for **some OTHER file in the batch, and you cannot choose which**; without
  a restore it is permanent for the process. Over a module that was ALREADY loaded, a
  narrow stub replaces only the names it lists and every unlisted export stays real
  (measured 2026-09-24 on bun 1.3.14, F1.561, pinned by
  `scripts/mock-module-load-order.test.ts`). Which case a file is in depends on what ran
  before it in its process, and `bun test` does not let you order that, so the recipe
  does not change: Spread AND restore — the pattern is the block of `const realX = { ...ns }`
  snapshots near the top of `claude-gateway-adapter.test.ts`, the mocks that spread
  them, and the `afterAll` that restores from the SAME snapshots (a bare line number
  here decayed once already; read the snapshots, not a line).
  **And the restore must come from that SNAPSHOT, never from the live namespace**:
  `mock.module` mutates the namespace object in place, so `const real = await import(x)`
  followed by `() => real` in an `afterAll` hands the MOCK back, silently, for every
  later file in the process. `bun scripts/check-mock-module-spread.ts` is the
  instrument for that half (P6.979, 2026-09-10) — it FAILS on a restore from a live
  namespace (3 instances, baselined with a reason each) and only PRICES the no-spread
  class it cannot classify (78 sites over 34 files, dominated by deliberate narrow
  stubs of `pdfjs-dist`, `electron` and `../logger`); the naive guard on that class
  would have reported all 79 CORRECT restores as findings.
  **This line said "every LATER test file" until P6.848, and that wording is what makes
  the trap look REFUTED when you go to check it** (measured 2026-09-08, bun 1.3.14, by
  W9-an and re-run independently): `bun test` IGNORES the order of the paths it is given
  — four files handed to it in three different CLI orders executed in the same fourth
  order, which is neither the given one, nor alphabetical, nor its reverse. So a consumer
  listed FIRST still received the amputated namespace, two suites run "amputator first,
  consumer second" both passed, and three readings came back inconclusive before the cause
  was seen. **The fix can therefore never be "order the batch"** — it is the spread and
  the restore, or running the file alone.
- **One SYNTAX error in one file makes `tsc` blind to every SEMANTIC error in the repo** —
  it reports the syntactic category instead, so a run exits 2 naming only that file while a
  deliberate `const x: number = "s"` planted elsewhere goes unreported (measured 2026-08-31 on a
  sibling's `*/` -in-block-comment defect). A failure naming only files outside your change proves
  NOTHING about your change: re-run in an isolated worktree, or plant a type error in your own file
  and confirm it is reported. Third gate in this list that stops gating quietly, beside the `&&`
  chain and the pipefail `$?`.
- A green `typecheck:all` does not mean YOUR test file was typechecked. Package
  REACH is machine-checked since P3.131 (`bun run typecheck:coverage`); TEST
  reach is `--tests` on the same script, still opt-in. Every count below is a
  READING WITH A DATE, not a standing fact — this one has moved three times in
  a day. 106 files across five packages, then 32 once P3.164 closed four of the
  packages, then **14 measured 2026-08-28**, still all `pi-agent-server`'s and
  named individually in `tsconfig.typecheck.json` (P3.165 is shrinking that
  list). Run `bun scripts/check-typecheck-coverage.ts --tests` for the live
  list rather than trusting any count written here — including this one, and
  including the two dated tables inside that script.
  Two things that list got wrong, both worth knowing before you read the next
  one: `shared`'s 33 were described as sitting behind an exclude glob, and only
  24 were — the other 9 were a top-level `tests/` directory outside `include`,
  which appears in no exclusion list to grep for, and it carried 54 errors
  nobody had counted. And `ui`'s `Cannot find module 'vitest'` was not a
  missing dependency: `vitest` is nowhere in this repo, and Bun's built-in
  `vitest`→`bun:test` alias is why those files ran at all. The "567-error
  backlog" this line carried until 2026-08-28 measured 423 with the glob
  dropped — and 206 of those were `server-core`'s, gone once a path mapping was
  fixed.
- A doc line number decays; the quoted sentence does not — quote sentences. **But a quoted glob
  can break the file: `*/` inside a block comment CLOSES it**, so quoting a documentation example
  like `*/plugins` in a `/** … */` docblock yielded nine hard parse errors (measured 2026-08-31).
  Write such examples out in words, or quote them outside a block comment.
- `electron:dev` runs main process AND Pi subprocess from BUILT bundles: a
  main-process fix can be on disk and absent from the running app, and a dev
  build is not the shipped artifact — live evidence comes from a packaged build.
- `rm -rf release` before `bun test` — the packaged tree adds phantom failures.
- `rm -rf packages/pi-agent-server/dist` (that suite's stale-dist step) breaks
  the dev app's Pi path until `cd packages/pi-agent-server && bun run build`
  (`Unsupported Pi runtime 1.0.2` — reads like the model declining to dispatch).
  **That message has THREE causes since 2026-09-11 (the Pi lift to 0.84.3), and the
  other two look identical:** (2) upstream's `getPackageDir()` now walks past a
  `dist/package.json` whose parent also has one — the dev bundle's own identity —
  so the host sets `PI_PACKAGE_DIR` at the spawn site and
  `pi-bundle-package-identity.test.ts` drives the SHIPPED resolver over both layouts;
  (3) after a workspace lift `bun install` can leave stale workspace-nested copies
  of the lifted packages that SHADOW the hoisted root install (three
  `@earendil-works` copies at 0.84.2 shadowed 0.84.3 while `bun.lock` said 0.84.3
  and described none of them) — assert provenance FROM EACH WORKSPACE
  (`cd packages/pi-agent-server && bun -e 'console.log(require("@earendil-works/pi-coding-agent/package.json").version)'`),
  never from the repo root.
- Electron does not inherit the shell's `ulimit -n` (floor 256 here): fd-hungry
  paths fail in the app while every shell probe succeeds. Bound fan-outs.
- A test prompt that names a tool and forbids calling it trips Pi's Guardian as
  prompt injection; the wreckage reads like a dispatch bug. Phrase positively;
  on `Tool not found`, read the Guardian lines first.
- An empty packaged `main.log` is not evidence — packaged builds log nothing
  outside debug mode; boot-fatal errors write `<config dir>/logs/boot.log`.
- An ABSENCE finding needs a positive control on the same rig.
- **A timeout with zero assertion failures has TWO causes needing different fixes** (measured
  2026-09-01). One suite showing that signature was not starved at all: a single module import in one
  hook cost 44.7s against a 5s default — a 9x overrun — while the hook's other three steps took 52ms,
  0 and 0. It presents as contention because the budget is a TIMER; a 1s heartbeat beside that import
  ticked 13 times in 44.7s with one 31.5s gap, so redness is decided by where a yield lands. The
  separating control is cheap: run the same batch at both load extremes — that lane's went 1.66s at
  load 9.4 and 81.64s at load 41-118, a 49x spread, passing 131 of 131 BOTH times. Passes alone at low
  load -> starvation, register it. Fails alone at low load -> profile the hook, then give it an
  explicit budget set against the MEASURED FLOOR, never zero. And a misnomer: bun prints the same
  `beforeEach/afterEach` message for the `beforeAll`/`afterAll` family, so the output alone can name
  the wrong hook kind — a row did exactly that here. **Sighted twice more on 2026-09-08, both on files
  whose only hook is a `beforeAll`**: W9-y's discarded render test (113 s) and
  `playground/__tests__/sources-management-registry.test.ts` (79 936 ms, a registered red). The message
  is not evidence about which hook family ran — read the FILE, and if it declares no `beforeEach`, the
  timeout is a `beforeAll` and the fix is that hook's budget, not the test's.
- A timing claim needs a CONTROL RUN at the same moment on unmodified code, or
  it invents a cause. Reproducing the number does not validate it — on a loaded
  box the second run inherits the same confound, so repetition measures the load
  twice rather than the change once. Read the load at that moment (`uptime`) and
  quote it beside the duration. **And on this rig `uptime` is the wrong instrument on its own: quote
  `user`/`sys` beside `real` — one `/usr/bin/time -p` — because the dominant cost here is I/O wait, and
  a CPU load average cannot see it.** Measured 2026-09-07 (W8-x, P6.560): importing
  `packages/shared/src/plugins/format-adapters.ts` costs **67.5 s** then **71.6 s** in two runs at load
  ~10 — reproducible, so not a cold cache — while `plugins/schema.ts` alone burns `user 0.08 sys 0.05`
  against `real 23.17`, and its five-way decomposition `user 1.07 sys 0.09` against `real 48.54`. `semver`
  alone imports in **17.6 s**, and bun prints `warn: Slow filesystem detected` naming `~/.bun/install/cache`;
  the volume is local APFS and directory traversal is normal, so it is per-file-open latency under
  concurrency, not the medium. Every wave-6/7/8 duration taken on this box therefore carries an I/O
  confound no load average reports.
- A mutation/re-break harness that fails to RESTORE does not merely fail to
  kill a mutant — it silently invalidates every verdict after it. Three lanes
  hit it in two waves (P2.449, P2.450, P2.452): an empty replacement side made
  the reverse swap search for `''` and abort AFTER the forward write, and a
  reverse anchor matched twice so the swap-back landed in an unrelated block.
  Restore by writing the whole pre-mutation file back and asserting the hash
  returns to baseline — the reverse STRING swap is the fragile part — and refuse
  an empty side, a non-unique anchor, and a reverse anchor already present, all
  BEFORE the forward write, because a guard on the reverse side can only report
  the corruption. Its three siblings all read as survivors and are none of them:
  a dead control (a mutant that changes nothing), a broken mutant
  (`false && a || b` disables nothing), and a HUNG mutant.
- Four shapes an "unused identifier" sweep keeps missing: getter/setter pairs,
  default-parameter reads, enforcement one layer up, same-named symbols in a
  sibling subsystem. Read `…specs/2026-07-29-inert-worklist.md` §3 first.
- Collect a fan-out's results against what was DISPATCHED, not what arrived;
  "unchallenged" is its own state, weaker than "confirmed".
- A live case's DETECTOR is the thing most likely to be wrong: a typed field
  is not a filled field, a reused session's marker is history, similar-named
  counters differ. Confirm negatives against a source the feature itself writes.
- A narrowing test knob set below the system's RESTING state manufactures its
  own failure — size thresholds against the floor, not zero.
- **A throwaway worktree with the parent's `node_modules` symlinked in measures
  the PARENT.** The workspace links are relative (`../../packages/*`), so
  `@nessy-agent/*` walks straight back out of the isolated copy. No error, no
  warning — the run simply measures the tree you built the worktree to isolate
  from, and it fails in whichever direction flatters the conclusion. Build a
  shadow `node_modules` that repoints the scope at the worktree's own packages,
  and **assert provenance before trusting a number**: the recipe and its
  one-line assertion are in `…specs/2026-08-21-measured-traps.md`.
- **A rig placed OUTSIDE the repo — the scratchpad, the usual place — resolves a
  DIFFERENT package tree, and Bun fills the hole for you.** W6-f's rig imported
  `@anthropic-ai/claude-agent-sdk` from `/private/tmp/…/scratchpad`; Bun walked up
  from the SCRIPT's directory, found nothing, and auto-installed **0.3.238**
  against the vendored **0.3.233**. Every arm ran, every arm produced a plausible
  number, nothing failed and nothing warned. Same class as the worktree trap above
  and it needs no worktree at all. **`env -i` cannot help — the cause is module
  resolution, not environment** — and a stack frame naming the Bun cache path is a
  hint, not evidence (the same frame shape appears for a correctly-resolved
  hardlinked package). **Print provenance before any number is trusted**, with the
  rig's own cwd and the package the rig actually imports:
  ```sh
  bun -e 'const p=Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json",process.cwd());
    console.log(p.startsWith(process.cwd())?"OK vendored: "+p+" "+require(p).version:"TRAP resolves elsewhere: "+p)'
  ```
  For a rig that drives a CHILD, assert the child's own self-report instead — the
  claude child announces `claude-cli/<version> (external, sdk-ts, agent-sdk/<sdk version>)`
  in its `user-agent` — the two halves are the two self-reports, so compare against what
  the vendored `package.json` says TODAY rather than against a number written here (this
  line carried `2.1.233`/`0.3.233` as a literal until 2026-09-12, W17-z, a bundle we no
  longer ship) — which says *what answered* rather than *what was on disk*.
  It has already falsified one row's headline: P6.543 was named for a
  `2.1.238`/`2.1.233` pair that does not exist in this tree. Narrative and both
  measured arms: `…specs/2026-08-21-measured-traps.md`.
- **The isolate preload isolates under `bun test` and NOT under `bun <file>` or
  `bun run`** — the root `bunfig.toml`'s own top-level `preload` runs ahead of
  any CLI `--preload`, freezing `CONFIG_DIR` at the real `~/.nessy-agent` while
  `NESSY_CONFIG_DIR` still reads as a temp dir, so the rig reports success.
  Export `NESSY_CONFIG_DIR` **before bun starts** — that works on every form.
  Which forms isolate, and the control that proves the cause, are in
  `…specs/2026-08-21-measured-traps.md`.


- **docs-site markdown is a Vue template** (measured 2026-10-03, UA-bb lane) — a
  bare `<slug>`-shaped token in PROSE is an unclosed element and the vitepress
  build fails with a line:column that points at the paragraph, not the token;
  code-format it (inline code and fenced blocks are escaped and safe).
