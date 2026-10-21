# Nessy Desktop Agent Guide

Always loaded, so kept under 300 lines (owner, 2026-09-25). Two companions hold the detail, moved verbatim:
`docs/agents/upstream-docs.md` (upstream-contract rules, page lists, anchor spelling, the component diff
script) and `docs/agents/traps.md` (every measured trap with its date; narratives in
`docs/superpowers/specs/2026-08-21-measured-traps.md`). Read them when a rule below points there.

## CodeGraph

Use CodeGraph before grep/find or file reads: `codegraph_explore` (MCP) or `codegraph explore "<q>"` (shell) —
line-numbered source, call paths, blast radius. Use `rg` for docs, configs, and generated artifacts.

## Current Shape

An internal desktop-agent fork rebranded for T-Bank: package scope `@nessy-agent/*`, CLI `nessy-general-agent`,
server binary `nessy-server`; env vars, config dirs, and gateway defaults are Nessy-specific.

## Upstream Docs Are Contracts

Nessy imports Claude Code and Codex plugins, so their docs are contracts. Consult them before changing
plugins/MCP/skills/hooks/commands/agents or the format adapters; cite the page in the plan or commit.

- **Claude:** index `https://code.claude.com/docs/llms.txt`; pages are `https://code.claude.com/docs/en/<page>.md`
  (WITH `/en/`, or 404). Corpus snapshot: `scripts/claude-doc-pages.tsv` (trust its `Snapshot:` line, not a
  prose count); verdicts: `docs/superpowers/specs/2026-07-31-claude-coverage-map.md`. `platform.claude.com/docs`
  is out of scope. Agent SDK pages (`agent-sdk/*`) specify behaviour our loop matches — read them before
  calling anything undocumented.
- **Plugin-format pages are TWENTY-FIVE** (2026-10-01; eleven until the docs moved under `plugins/`): the 20
  `plugins/*` pages `llms.txt` lists — the format is `manifest-reference`, `marketplace-reference`, `components`,
  `loading`, `cli-reference` — plus `plugin-evals`, `mcp`, `settings-reference`, `workflows`, `channels-reference`.
- **Pages split:** `settings.md` became `settings-reference.md` + `managed-settings.md` +
  `server-managed-settings.md`, so every line-numbered citation of the old page is dead. Cite
  `page.md#<section>` plus the verbatim sentence. `lint:settings-line-citations` ratchets `packages/**` and
  `apps/**`; read `docs/superpowers/specs/2026-09-07-settings-anchor-rot-disposition.md` before converting.
- **A correction must not spell the dead anchor** in `path:line` or `<word>.md#<word>` form, or every
  citation guard reports the fixed cell forever — name it in words ("line N of `<path>`"), placeholders too.
- **Anchors come from the RENDERED page:** dots and spaces hyphenate, `,:()` drop, `/ ' +` survive, only
  `##`–`####` get ids, duplicates take `-2`. For `code.claude.com` `curl` without `.md` and grep `id="…"`;
  codex pages (`learn.chatgpt.com`) are client-rendered — read their `.md`.
- **Codex:** contract pages `plugins/build/plugins.md`, `learn.chatgpt.com/docs/hooks.md`,
  `plugins/deploy/submission-errors.md`; hook events from `packages/codex-protocol/generated/v2/HookEventName.ts`,
  never prose. `github.com/openai/codex` is the SOURCE and outranks its pages; `github.com/openai/plugins` is
  practice — read both (`docs/superpowers/plans/2026-07-29-codex-adapter-spec.md`).
- **Renames and new component types are the recurring failure** (`Task`→`Agent`, `lsp` vs `lspServers`). On
  every touch run the companion's diff of the `## Fields` table of `plugins/manifest-reference.md` (entries take
  every field on it) against the three constants in `format-adapters/claude.ts`; it exits 1 on an empty read.
  A row in no constant usually has its own normalizer; one with neither is the real gap. `experimental.evals`
  is refused on purpose, `workflows` is a deliberate superset, `lspServers` must not join
  `CLAUDE_CUSTOM_PATH_FIELDS` alone — read each constant's header before "tidying" it.

## Native-first, and the host is the smooth seam (owner rule, 2026-08-28)

For any capability, in order: **(1)** does the runtime already have its own mechanism — then enable and
configure it, we supply the model; **(2)** can the host supply it uniformly for all three — then once, in the
host; **(3)** only then build per runtime, recording why 1 and 2 failed (e.g. codex's own
`approvals_reviewer="auto_review"`, durable grants projected into codex's own execpolicy). **The host's job is
to make the residual difference UNIFORM or HONEST:** a native mechanism adopted without a switch verdict is a
new silent divergence — this fork's largest defect class. "Absent" is two questions: missing, or never
enabled? **A proposal to BUILD must state what it found when it asked whether the runtime already has it.**
A native judge whose verdicts never reach us cannot mint an audit receipt; an unauditable influence on
permission outcomes is worse than an absent one.

## Where the documentation is silent: TRANSPARENT and SIMPLE (owner rule, 2026-08-28)

Where the ordering below runs out, **decide rather than queue**. **Transparent:** a diagnostic for the user, a
setting for the operator, a comment naming the choice and its reason — an undocumented choice nobody can see is
indistinguishable from a defect. **Simple:** a narrow mechanism with a stated residue beats a broad clever one
with hidden assumptions. Not a licence to invent where docs speak, nor to decide a **product posture** quietly
(a user-visible policy, a safety trade, an operator cost) — state it and continue.

## When a row is unclear: READ, do not INVENT (owner rule, 2026-08-28)

An ordering, not a menu: **1.** the nearest documented solution (the runtime owning the surface; Pi follows
Claude's pages, codex follows codex); **2.** a reference implementation (`openai/codex`, `openai/plugins`, the
Pi extensions, omnigent — evidence, not authority); **3.** ask the owner with the options; **4.** invent — last,
reason written down. Unread answers would have destroyed working behaviour four times, each looking obviously
right. *"I could not find it documented"* is a finding: record what you searched and let the row carry the null.

## Docs are the contract for BEHAVIOUR, not for MEMBERSHIP (2026-08-28)

For "what is the complete set of X?" (env vars, settings keys, tools, providers) the vendored bundle is the
denominator: `CLAUDE_CODE_USE_GATEWAY` is real, shipped and on zero corpus pages. Derive such guards from the
bundle's own array and pin them with a test. **It inverts where the bundle lags the docs** — a documented field
the bundle lacks is still the contract; check which side leads and say which one a guard came from. Read the
version from the two self-reports, never from a grep of the binary:

```sh
grep -o '"claudeCodeVersion"[^,]*' node_modules/@anthropic-ai/claude-agent-sdk/package.json
./node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --version
```

## The two runtimes need different evidence, and this is not symmetric

**Claude — the documentation IS the contract** (the binary is closed): a page anchor plus a verbatim sentence is
the strongest evidence; verify OUR behaviour against the page. **Codex — the source outranks the page** (the
binary has contradicted its Beta docs twice): a claim from `github.com/openai/codex` or measured on the binary is
**strong**; one from `developers.openai.com` / `learn.chatgpt.com` alone is **weak — intent, not behaviour** —
mark it a hypothesis. Do not import that caution to Claude.

## Monorepo Map

- `apps/electron` — shell/renderer/main/packaging; `apps/cli` — websocket client; `apps/viewer`, `apps/webui` —
  dormant.
- `apps/ios` — a **Swift/Xcode client** (SPM `NessyAgentKit` + app `NessyMobile`) with **no `package.json`**, so
  `bun install`, `typecheck:all`, `lint` and `bun test` never read it. Gated by `.gitlab-ci.yml`'s `build-ios`
  job (`swift build`/`swift test`, `xcodebuild`), which runs only when `apps/ios/**` changes — a change outside
  it that breaks it is not caught (P2.370). `check-typecheck-coverage.ts`'s `UNMAPPED_SURFACES` pins this bullet.
- `packages/core` — wire/types; `packages/shared` — agent backends, config, credentials, sessions, sources,
  i18n, model metadata; `packages/server` + `server-core` — headless server, RPC/runtime;
  `packages/pi-agent-server` — Pi subprocess wrapper (config knobs in its README).
- `packages/session-tools-core`/`session-mcp-server` — session tools; `packages/ui` — renderer primitives;
  `scripts` — build/release helpers; `fastlane`, `.gitlab-ci.yml` — signing/CI/publish infra.
- `docs/` — architecture, parity audit, plans, CLI reference, live-test checklist; `docs/README.md` is the
  index — update it when docs move.

## Commands

Use Bun: `bun install --frozen-lockfile`, `bun run typecheck:all`, `bun run lint`, `bun run test:shared:all`,
`bun test`, `bun run lint:i18n:parity`, `bun run lint:i18n:sorted`, `bun run validate:ci`.

```bash
bun run electron:dev
bun run electron:build
bun run electron:build:servers   # restage bundled subprocess servers — required
                                 # after changing anything the Pi subprocess ships
CSC_IDENTITY_AUTO_DISCOVERY=false bash apps/electron/scripts/build-dmg.sh arm64
```

Build-time provider flags — write `1`/`0` and NOTHING else (the five parsers disagree on `y`):

| Env var | Default |
| --- | --- |
| `NESSY_FEATURE_PROVIDER_NESSY` / `NESTOR_CLOUD` / `API_KEY` | on |
| `NESSY_FEATURE_PROVIDER_LOCAL` / `CLAUDE` / `CHATGPT` | off |
| `NESSY_FEATURE_CODEX_RUNTIME` / `CLAUDE_RUNTIME` | on |

`PROVIDER_CLAUDE` gates only the Pro/Max card, `CLAUDE_RUNTIME` the `claude-runtime` providerType; **either**
enables the anthropic backend and ships the SDK native binary. `isAnthropicBackendEnabled()`
(`packages/shared/src/feature-flags.ts`) is the OR, mirrored in `build-dmg.sh`, `build-win.ps1`,
`build-linux.sh`, `ensure-claude-sdk-binary-dir.cjs` and `fastlane/Fastfile` — change one, change all five.
Fastlane uses a repo-local bundle (Homebrew Ruby 3.4 + `BUNDLE_PATH=vendor/bundle`). Release rehearsal:
`scripts/prepare-release-assets.mjs`, `scripts/verify-update-feed.mjs`.

## Gateway Facts

- Base URL `https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1`; models
  `…/api/v1/cli/models`; auth header `Nestor-Token: <JWT>`.
- **Models are ALIASES, not ids** (`coder`, `fast`); ids rotate and a retired id answers 404. Resolve with
  `resolveGatewayCoderModelId` / `resolveGatewayFastModelId` (`config/llm-connections.ts`), never pin an id. The
  retired id in tests and fixtures is a fixture string, deliberately not renamed.
- JWT prefill reads `~/.nessy/dp_auth_creds.json`: the shape is nessy-cli's, the file is ours —
  `packages/shared/src/auth/dp` is its ONLY writer (atomic, 0600, keeps unknown keys). Nestor request rewriting
  stays scoped to the verified gateway URL; custom endpoints keep normal provider auth.
- **Claude Code (Nessy Gateway)** card: slug `claude-gateway`, providerType `claude-runtime` — the Agent SDK
  against a per-session loopback adapter translating Anthropic Messages to the gateway; `Nestor-Token` only on
  the verified URL. BYO `claude-runtime` uses the same adapter; models stamped `wire: 'anthropic-messages'`
  pass through natively per request (`buildClaudeRuntimeWireRouter`).
- Gateway models auto-refresh at startup (`packages/server-core/src/model-fetchers/nestor.ts`).

## Release And CI

- Branches: `<type>/TCODE-000`, `<type>` ∈ feat|bugfix|chore|docs. No MRs or tags during autonomous execution;
  one commit per task with the plan's subject; no `Co-Authored-By` trailers.
- Preserve GitLab/signing infra (`.gitlab-ci.yml`, `fastlane/*`, `policy.yml`, `.gitlab-ci-compliance.yml`)
  unless the phase changes it. Protected-ref secrets are absent on feature branches; signed release / S3 checks
  are reviewer-only.
- A squash merge orphans every sha the branch's docs cite: extend `archive/plan-cited-history` with the merged
  tip BEFORE master's pipeline reaches `lint:plan-shas`.

## Editing Rules

- Every plan in `docs/superpowers/plans/` carries a `## Tracker` (glyph, commit, note), updated in the SAME
  commit that lands the task. **Do NOT delete a finished plan** — two generators harvest its deviations.
- Findings become plan rows AT CONFIRMATION (owner, 2026-08-23), never held outside the plan. Since 2026-09-24
  only CRITICAL ones (security/safety, a regression the plan introduced, data loss, a red gate blocking the
  final gate, wrong user-facing behaviour) run at once; the rest are born DEFERRED and re-read at plan end.
- Insert rows IN SORTED POSITION, then run `python3 scripts/sort-plan-tracker.py <plan>` (`--check` = dry run).
- Stay in the active phase or explicit request. Do not modify `.references/`. Do not bypass supply-chain
  quarantine. Prefer existing package boundaries. i18n: keys in ALL locales, parity/sorted green.
- Adapted prompt/policy text: permissive upstreams only, record source+license; proprietary-binary extractions
  stay paraphrase-only.
- Before claiming completion, run the gate command and record real output.
- Close-out: (1) bump the version in BOTH root and electron `package.json` (not `bun.lock`; never
  `bun install` mid-wave to "fix" it); (2) add a NEW `apps/electron/resources/release-notes/<version>.md`
  (title, date line, NEW/IMPROVED/FIXED sections — see `1.0.2.md`); (3) update affected `docs-site/` pages;
  (4) update `docs/testing/cdp-live-checklist.md` (one case×runs table; narratives to `docs/testing/cdp-runs/`).

## Traps That Have Each Cost A Real Measurement

One rule each; the date and measurement behind every one are in `docs/agents/traps.md` — add new traps there.
Each produced a wrong answer that looked right.

**Running tests**
- `bun test`: prefix EVERY path with `./` (a bare path is a filter, a missing one is skipped silently) and read
  the FILE COUNT, not just pass/fail. `bun test` does not typecheck; `skip` counts include skipped hooks.
- zsh does not word-split an unquoted `$VAR` — `bun test $FILES` or `git grep -- $LIST` runs nothing and exits
  0. Use `"${arr[@]}"` or literal paths; an unquoted `$(…)` IS split.
- Never pipe a gate (`| tail` reports the pipe) and never wrap one in `timeout` (absent on macOS, "passes").
  Put an edit and its commit in ONE `&&` chain or under `set -e`.
- Concurrent `bun test` runs manufacture failures: take `bun scripts/bun-test-lock.ts run`, stop a locked run by
  killing its CHILD, and check `docs/superpowers/specs/2026-07-29-known-failing-tests.md` before recording a
  red. TaskStop skips a swap script's restore step.
- A timeout with zero assertion failures is usually the MODULE GRAPH (per-file-open I/O here), not load: price it
  with `-t '<matches nothing>'`, read per-test times with `--reporter=junit`, quote `user`/`sys` beside `real`,
  budget the FILE against the measured floor. A timing A/B needs paired, alternating arms.
- bun reprints failures at the end and glues `(fail)` onto dumps — read the job's own `N fail` line.
- `mock.module`: spread AND restore from a snapshot taken before mocking, never the live namespace
  (`bun scripts/check-mock-module-spread.ts`); file order cannot be chosen. Patch a CJS export before its first
  ESM import; extend every spread when you add a sibling export.
- Bun 1.3.14 `process.env`: `delete` then assign (some names are invisible to spread, and `in` lies — see the
  one-liner in the companion); a delete-then-assigned proxy var never reaches this process's own fetch.
- The isolate preload works under `bun test` only — export `NESSY_CONFIG_DIR` before bun starts; assigning it
  in a test's module body isolates nothing. The test preload sets NEITHER Pi marker.
- `toMatchObject` with an asymmetric matcher OVERWRITES the field — read the value into a local first. A fixture
  that exits in its module body kills the runner with exit 0 — gate it on `import.meta.main`.
- `spawnSync` beside a loopback server deadlocks; stubbing `process.stdout.write` does not catch `console.*`.
- `rm -rf release` before `bun test`; rebuild `packages/pi-agent-server` after removing its `dist`.
  `Unsupported Pi runtime` has three causes — assert package provenance FROM EACH WORKSPACE.

**Searching and counting**
- Every absence claim needs a positive control on the same instrument and scope. Use `grep -a`; `-a` and `-I`
  cancel (last wins); this `grep` is ugrep. `git grep -E` ignores `\b` silently (use `-P`); `**` pathspecs need
  `:(glob)`. `grep -c` with no file reads stdin — give probes `stdin=DEVNULL` and parse the number.
- Counts over a minified binary: name the instrument (`-c` lines vs `-o | wc -l` occurrences; `-F` the prefix,
  then read the bytes at the offsets). Grepping a binary for a version is not a version reading.
- A number in prose is a reading with a date — run the script instead (`check-nul-bytes`,
  `check-typecheck-coverage --tests`, `command-corpus`); a decision enumerating names cites the source list.
- A red beside a concurrent run is not evidence of a shared resource — read the resource first.

**Git in a shared tree**
- Commit only as `git commit -F <msg-file> -- <paths>` (backticks in `-m` are command-substituted; a bare
  `git add` sweeps siblings' index); never `--amend`. Zone work by FILE; hold edits outside the tree while
  another lane holds a file; re-read `git diff HEAD` by hunk just before committing.
- Remote-tracking refs are stale — `git fetch --prune` or `git ls-remote` before claiming "it is on origin".
- Tree-scanning generators and gates read neighbours' uncommitted edits: regenerate from a quiet tree, prefer
  `--cached`, commit a generator before announcing it; an untracked reader is invisible to `git ls-files` gates.
- Re-derive line anchors from `git show HEAD:<path>` right before committing; a comment edit in a heavily cited
  file keeps its line count. In markdown cells write `\|`, and alternations as separate `-e` patterns.
- A gate that opens its corpus is too slow for `lint:chain` — read clean files as git blobs, and say what a new
  gate walks (CI keeps runner caches such as `.cache/bun/` inside the checkout).

**Writing code and guards**
- `*/` in a quoted glob closes a `/** … */` docblock; a null-codepoint escape written via the editing tool lands
  as a literal NUL; a backtick inside a preload template literal closes it.
- One SYNTAX error (TS1xxx) blinds `tsc` to every semantic one; a TS2xxx in a neighbour does not. Run `eslint`
  from the package directory — from the root it says "ignored" and exits 0.
- Stale-count/name guards: bounded regexes (`four(?!teen)`), guard the CALL not the identifier, assert the
  successor. Boundary controls anchor BELOW the region; re-run `lint:braced-region-controls` after the fix
  commit; a negative needle must be spellable in the corpus's own grammar.
- A default flip leaves old pins GREEN but non-discriminating — ask of each whether it can still fail, and grep
  the promises (locales, dialogs, docblocks). Drive ONE real call through a lever's posture; a planted
  collaborator production lacks at that moment needs the un-planted arm.
- Prefer `{@link}` to a comment asserting what another module does; if you assert, leave a back-pointer there.
- A hand-off diff is a sketch: re-read the receiving file's neighbours and what else the expression feeds.
- Mutation harness: restore by writing the saved file back and asserting its hash; refuse ambiguous anchors.
- i18n: write characters, not `\uXXXX`; `ru.json` legitimately has more keys than `en.json`.
- TOML: a bare key after a `[table]` header belongs to that table — write top-level keys first.
- GitLab: a `when: manual` rules job with `allow_failure:exit_codes` BLOCKS the pipeline (use `true`); a
  `node_modules/` artifact carries the root install only.

**Rigs and live evidence**
- A worktree with symlinked `node_modules`, or a rig outside the repo, measures a DIFFERENT package tree — print
  provenance first. After a pin bump of a package with a native binary, read BOTH self-reports and count the
  lockfile's platform entries; diff the previous tarball from the bun cache.
- Launch the app via the `env -u` launcher in `scripts/cdp/README.md` (this shell exports `CLAUDE_CODE_*` names
  the product reads). Drive codex through the product's own config writer; out-of-workspace targets under `$HOME`.
- `electron:dev` runs BUILT bundles — live evidence comes from a packaged build, whose empty `main.log` means
  nothing (read `<config dir>/logs/boot.log`). Electron does not inherit `ulimit -n`.
- CDP: a turn counts only once it STARTED; `/clear` empties the transcript; quote multi-line pid lists in zsh;
  take case ids from the checklist; phrase test prompts positively (Guardian reads negatives as injection).
- "Pre-existing" means on the TARGET branch. Collect a fan-out against what was dispatched. A live case's
  detector is the likeliest thing to be wrong; size narrowing knobs against the resting state, not zero.

## The Parity Audit's Three Files

- `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` — source of truth.
- `docs/superpowers/specs/2026-07-30-parity-report.md` — GENERATED by `scripts/build-parity-report.py` from the
  tracker, the register, `scripts/claude-doc-pages.tsv` and every plan's text — regenerate from a clean tree,
  or use `--check`.
- `docs/superpowers/specs/2026-07-29-deviation-register.md` — GENERATED by
  `scripts/regenerate-deviation-register.py` on every closing pass.

Live cases: `docs/testing/cdp-live-checklist.md` (one case×runs table), driver `scripts/cdp/`.

## Implementation-First Verification Budget

Applies to every plan unless the user approves a stricter named exception; it changes TIMING, not acceptance.
- In the implementation loop run only: focused tests for changed behaviour, affected-package typechecks,
  directly affected contract tests, scope checks, `git diff --check`. Name the contract a command proves first.
- Minimum non-duplicative tests per new invariant (one positive, one negative/boundary). One independent review
  of the assembled phase diff; re-review only on a contract-changing fix. Never rerun green evidence unless its
  content, lock or toolchain inputs changed.
- Full typecheck/lint/test, builds, packaging, live smokes: only at a wave boundary, final close-out, or a risk
  trigger (shared wire/schema, auth/permissions, isolation/lifecycle, migrations/deletes, dependency locks,
  build/release infra) — smallest expanded set, once, on the final diff.
- A failed required check blocks commit; final acceptance still runs the plan's complete final regression.
