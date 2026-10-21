# Nessy Desktop Docs

This directory holds source documentation that belongs with the repository.
Design records for work that has shipped are deleted, not archived — the code and
`git log` are the record. What stays here is either still true, still unfinished,
or still an input to planned work.

## Product docs

- `cli.md` — CLI usage, server connection options, authentication, TLS, and
  troubleshooting.
- `nessy-mobile.md` — the iOS/iPadOS remote: what works today (approvals, stop,
  offline cache, two devices, iPad split view), how to run it against either
  server and why a plain-`ws` network bind is refused, the reachability options
  (LAN, tunnel, remote workspace, relay) with their real costs, and the gaps.

### Shipped user docs live OUTSIDE this directory, and they have owners

`apps/electron/resources/docs/*.md` is the other half of the product documentation
and it is not indexed above because it is not in `docs/`. Those files are the
**source** of the guides the app installs into `CONFIG_DIR/docs/` on first run
(`initializeDocs()` in `packages/shared/src/docs/index.ts`, called from
`initializeConfigDir`). Two consequences that make them different from anything
in this directory: a user reads them from their own config dir, and **the agent
reads them too** — the module's own header calls them "documentation that Claude
can reference when performing configuration tasks", and the installed path is
handed out at runtime: `agent/permissions-config.ts` builds
`docsPath: join(CONFIG_DIR, 'docs', 'permissions.md')` and `agent/mode-manager.ts`
prints it. So a wrong sentence there is not doc drift; it is a false statement to
a user about what is permitted, or model-facing text — which is also why the
owner in the table below is the code that emits that path.

Nothing claimed them, which is why they went stale (P3.212, named 2026-08-28).
**Ownership rule, assigned 2026-09-03: a shipped guide belongs to the zone of the
code it documents, and is updated in the SAME commit that moves that code.**

| Shipped guide | Owned by whoever changes |
| --- | --- |
| `permissions.md` | the permission DSL and its modes — `agent/pi-harness/permission-dsl.ts`, `agent/mode-manager.ts`, `agent/permissions-config.ts`, and the rule compiler under `agent/pi-harness/` |
| `sources.md`, `skills.md`, `automations.md`, `statuses.md`, `labels.md` | `packages/shared/src/capabilities/` and `packages/shared/src/automations/` |
| `nessy-general-agent.md` | the CLI (`apps/cli`) and `docs/cli.md` — keep the two in step |
| the preview/tool guides (`browser-tools`, `data-tables`, `html-preview`, `image-preview`, `markdown-preview`, `mermaid`, `pdf-preview`, `llm-tool`, `tool-icons`, `themes`) | the tool or renderer each one names |
| `artifacts.md` (UA1.21) | page publishing to t-artifacts — `publish_artifact`/`list_artifacts` (`session-tools-core/src/handlers/`), the host path `server-core/src/sessions/artifact-publishing.ts`, `shared/src/artifacts/`, the Claude `Artifact` alias in `claude-agent.ts` and the shell redirect in `agent/core/pre-tool-use.ts`; its five stated residues are model- and user-facing promises |
| `board.md` (UA4.10) | the task board and Tasks — the board renderer (`apps/electron/src/renderer/components/app-shell/kanban/`), `shared/src/tasks/`, the Conductor and the tasks RPC (`server-core/src/tasks/`, `handlers/rpc/tasks.ts`) and `create_board_task`; it also feeds the board guidance (`CREATE_BOARD_TASK_GUIDANCE` in `prompts/system.ts`) on every slot. UA4.4 (Run, Results), UA4.6 (Generate) and UA5.x (Projects) add their sections when they land |
| `pages.md` (UA6.5) | Pages — the six page tools (`session-tools-core/src/handlers/pages.ts`), the host closure `server-core/src/pages/tool-callbacks.ts`, `shared/src/pages/`, the frame policy `apps/electron/src/shared/page-frame-csp.ts` and the bridge `page-bridge.ts`; it also feeds the "## Pages" prompt section (`pagesPromptSection` in `prompts/system.ts`) |

**One naming hazard, worth knowing before you grep.** `permissions.md` is ALSO a
page of Claude's documentation corpus, cited all over this tree as
`permissions.md#bash`, `permissions.md § Cd`, `permissions.md § Project allow
rules`. A bare `permissions.md` in a comment is therefore ambiguous between our
shipped guide and a contract page on `code.claude.com`. Say which one you mean —
this is the same defect P2.377 fixed for `manage-app-updates.md`, where a bare
page name resolved in the wrong corpus.

## Architecture

Accepted architecture that current code implements.

All fourteen files under `architecture/` are listed here. If you add one, add it
here too — an unlisted architecture record is one nobody finds
(`scripts/architecture-index.test.ts` fails on one this list does not name, and
on a count above that no longer matches).

- `architecture/runtime-capability-gaps.md` — per runtime, what a user cannot
  do there and which of four reasons it is: structural, an owner decision, a
  planned row, or unverified. The reason is the point — it decides whether the
  gap can ever change.
- `architecture/runtime-control-boundary.md` — where our control ends and each
  runtime begins, per runtime: the levers we hold, the decisions that are the
  vendor's, whether our own tools reach the model, and which unused vendor
  functionality is structurally out of reach versus a switch nobody flipped.
  A measured snapshot — re-verify a coordinate before relying on it.

- `architecture/transport-locality.md` — which clients may do what: locality
  read from the advertised capability set, fail-closed on unknown, and the
  remote permission-mode ceiling it gates.
- `architecture/codex-like-workspace-storage.md` — storage v2, Workspace/Project,
  plugin, trust, and capability-resolution architecture.
- `architecture/unified-plugin-adapter-runtime.md` — the plugin format adapters
  and the normalized capability IR they produce, the trust and credential
  boundary, and which capability surfaces ship versus stay deferred.
- `architecture/extension-first-pi-agent-runtime.md` — the qualified Pi runtime and
  its pinned bill of materials (Pi `0.84.0`). Read before any Pi SDK version bump.
  Its line ledger is a qualification-time snapshot, not a current measurement.
  The former `pi-extension-adoption-scorecard.md`, which recorded the skipped
  `0.81.1` upgrade, was deleted in `97f7e7af`; recover it with
  `git show 97f7e7af^:docs/architecture/pi-extension-adoption-scorecard.md`.
- `architecture/project-local-nessy-agent-and-workspace-roots.md` — project-local
  `.nessy-agent` resolution and workspace root rules.
- `architecture/managed-mcp-access.md` — organization control over MCP servers:
  the `allowedMcpServers`/`deniedMcpServers` engine, its entry schema and
  matchers, and the two gaps it deliberately leaves open.
- `architecture/fork-subagents.md` — the `fork` subagent type: what a fork
  inherits that a named subagent does not, the fork-mode table, and the
  inherit-or-fail invariant.
- `architecture/file-checkpoint-rewind.md` — file checkpointing and rewind,
  including which sessions a parent rewind reaches.
- `architecture/guardian-command-judge.md` — the guardian command judge.
- `architecture/pages.md` — Pages (UA6.x–UA9.x): where each piece lives, the one host
  closure the six page tools reach on all three runtimes, the delete card, the frame
  policy and bridge, and the ranges still withheld.
- `architecture/task-board-and-planning.md` — the task board, durable tasks and the
  Conductor, Generate, projects and statuses (UA2.x–UA5.x): where each piece lives, the
  `assertCallerWorkspace` and grouped host-closure seams they run through, the run
  confirmation's ledger digest, the projects folder-identity rules, and what was not
  ported from v0.13.4.
- `architecture/decision-layer.md` — the decision layer (UB6.x, 1.43.0): the
  host-only classifier client no runtime sees, the gate order (switch → toggle →
  key → endpoint) and fail-closed, zero authority with what each feature sends, the
  records that never hold the state, the provider posture behind the five presets,
  and SEC-8 (only a local window chooses the provider, URL or key).

## Release

- `release-channels.md` — which release and publish jobs are actually live, why
  the Windows and Linux four are parked, and the three things that are wrong
  because of it: an installer one-liner pointing at a prefix nothing writes, a
  park comment that contradicts its own blocker count and misses a third unpark
  option, and the unsigned update feed that unparking the Linux publish would
  ship. Recording only — launching publish jobs is user-owned.

## Planning

### The parity audit's three files

Read these three before anything else under `superpowers/`. Two of the three are
**generated** — never hand-edit them, and regenerate on every closing pass.

- `superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` — **the source of
  truth.** Row statuses, evidence, commit shas, and every correction an executor
  made to a plan. §0 is the work queue, and it carries the close/retention rules.
- `superpowers/specs/2026-07-30-parity-report.md` — **generated.** What we have,
  what is open and whether it has a plan, plus the same picture indexed by Claude
  doc page. Regenerate with
  `python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md`.
- `superpowers/specs/2026-07-29-deviation-register.md` — **generated** from the
  plans' category strings:
  `python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md`.
  This is the one file here that can be wrong without looking wrong: it was once
  stale by a third (185 rows on disk against 288 in the plans), and drift
  downward is invisible because a smaller number still looks like an answer.
  `scripts/build-parity-report.py` re-counts it and exits non-zero on a mismatch.

A fourth file answers the question from the *documentation's* side rather than
the tracker's:

- `superpowers/specs/2026-07-31-claude-coverage-map.md` — all 174 pages of
  Claude's `llms.txt`, numbered, each with a verdict. Use it to ask "what have we
  never looked at?"; use the parity report to ask "what did we build?". Its page
  list and the report's §3 share one allowlist, `scripts/claude-doc-pages.tsv`;
  refresh it with `scripts/refresh-claude-doc-pages.py` when Claude ships pages,
  because **new pages are this fork's recurring failure mode.**

The coverage map says which pages were looked at. Two files say what the looking
found, both **generated** by `scripts/build-doc-sweep-report.py` from the
per-finding verdicts under `superpowers/specs/data/`:

- `superpowers/specs/2026-08-02-claude-doc-sweep-worklist.md` — the working
  document. Only findings that survived adversarial challenge, each read back off
  the code and classified *not-built* / *built-wrong* / *built-partial*, with the
  file-level change list and a proposed slicing into plans. Cut plans from this.
- `superpowers/specs/2026-08-02-claude-doc-sweep-divergences.md` — the audit
  trail: every finding raised, including the refuted ones and the ones nobody
  challenged, each with its verbatim doc sentence and the challenger's verdict.

**Three states, not two.** Roughly half of all challenged findings were refuted,
so "unchallenged" is recorded as its own state and is never folded in with
"survived" — and nothing reaches the parity tracker until it has been challenged.
This sweep supersedes the depth caveat in the audit's §5e: that pass triaged most
pages by title and never opened the 18 `whats-new/*` pages; this one read all 174
in full.

### The rest of `superpowers/`

- `superpowers/specs/` — the audits and measurements the plans were written
  against. Several are closed records rather than queues; each says so in its own
  first lines. Four are operational rather than historical and are worth knowing
  by name: `2026-07-29-known-failing-tests.md` (check it before attributing a
  test failure to yourself), `2026-07-26-r-queue-doc-verification.md` (the
  distilled Claude doc contract that two production permission modules cite as
  their source instead of restating it),
  `2026-09-07-settings-anchor-rot-disposition.md` (read it before converting any
  dead `settings.md:<line>` citation: the census command, which buckets are
  deliberately frozen, and a rendered-verified successor anchor plus today's
  verbatim sentence for the most-cited ones), and
  `2026-09-23-hook-card-line-anchor-disposition.md` (read it before shaping a
  comment edit around the line citations into `claude-agent.ts`,
  `SessionManager.ts` or `hooks-automation.ts`: which are frozen, which are
  gated, and what the line-count rule protects).
- `superpowers/plans/` — the parity series' plans, both in flight and closed. A
  closed plan keeps a `> **CLOSED — do not execute.**` banner as its first lines
  and is retained for the end-of-series review; without that banner a finished
  checklist reads as work still to do and an implementer redoes it. **This
  directory is therefore not the work queue** — the queue is §0 of the tracker.
  All plan files are deleted in one sweep once the series is verified. Before
  that sweep runs, check what the deletion would take with it: the plans' own
  category strings are the deviation register's only input, and several plans
  hold recorded owner decisions that live nowhere else.
- `superpowers/plans/2026-08-23-runtime-parity-closure-handoff.md` — the operating
  document for `2026-08-22-runtime-parity-closure.md`: how that plan is executed
  (subagent-driven, parallel lanes in one tree), the standing owner rules, the
  traps that fired during its run, and the close-out obligations. It is a handoff
  for whoever continues the plan, not a plan itself — no tracker, nothing to
  execute. Delete it with the plan it serves.
- `superpowers/plans/2026-09-11-coverage-95-parity.md` — the plan that follows the
  runtime-parity closure (owner decision 2026-09-11: a separate plan, started after
  the 1.36.0 close-out): the owner's 144 coverage-95 answers as C1 re-stamps, C2
  refusals, C3 builds and C4 owner postures. Its machine-readable inputs — one
  edit file and one readme per question family — are
  `superpowers/specs/2026-09-11-coverage-95-apply/`; the answers themselves are
  `superpowers/specs/2026-09-11-coverage-95-owner-answers.md` and the evidence
  `superpowers/specs/2026-09-11-coverage-95-owner-questions.md`. Read the plan's
  §"Application rules" before applying any family.
- `superpowers/plans/2026-09-10-integrations-and-authorization.md` — the plan
  after that one: the rows the closure deferred (Phase 1, D1.1–D1.123, every one
  pointing back to its source row), the integrations to update, and authorization.
- `superpowers/plans/2026-09-18-integrations-followup-1.41.0.md` — the 1.41.0
  plan (`F1.*` rows): what 1.40.0 deliberately did not ship, each row carrying
  `Origin D1.n` back to its source row in the plan above, plus every finding born
  during its waves and sittings. Closed at the 1.41.0 close-out (2026-10-02); its
  still-open rows each carry a DEFERRED pointer into the leftovers file.
- `superpowers/plans/2026-09-23-upstream-adoption-0-13-4-board-planning-pages.md`
  — the 1.42.0 plan (`UA*.*` rows): upstream craft-agents-oss v0.13.4's task
  board, tasks and planning, projects and pages, ported onto our three runtimes
  (owner decision 2026-09-23, no feature gating). Its spec is
  `superpowers/specs/2026-09-23-upstream-0-13-4-board-planning-pages-design.md`;
  read the plan's Global Constraints, §0.8 serialised files and the Port manifest
  before taking a row. **Status:** closing, not cut. A first close-out ran on
  2026-10-04 (UA11.7's final gate, `bef964953`; version 1.42.0), and the
  2026-10-08 verification re-opened the close-out rows (UA11.1, UA11.3,
  UA11.5–UA11.7, `4365c5b1f`): the final gate re-runs at the release HEAD. The
  leftovers wave — the DEFERRED `UA12.*` rows and the findings of the 2026-10-08
  verification, born as rows of their own — lands on this branch before RC4 and
  ships in 1.42.0 (owner 2026-10-03, 2026-10-08); 1.43.0 starts after it. The
  tracker is the truth of what is still open.
- `superpowers/specs/2026-10-03-ua-upstream-reconciliation.md` — UA11.8's
  upstream completeness reconciliation of the 1.42.0 plan against craft-agents
  v0.13.4: every upstream piece ported, adapted (reason a/b/c) or excluded with
  its row; the eight real gaps and where each landed (UA12.135–UA12.141,
  UA12.181, and a note on UA12.29 for gap 5); and
  the dated corrections an independent audit made to it on 2026-10-08. Read it
  before claiming an upstream behaviour is missing, and before planning 1.43.0.
- `superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md` — the 1.43.0 plan
  (`UB*.*` rows): everything upstream craft-agents-oss shipped through v0.15.1
  with our specifics — the five permission fixes first (their CRITICAL findings
  ran in 1.42.0 as UA12 rows), the decision-free fixes, the decision layer with
  upstream's five provider presets, the carried 1.42.0 rows, and the v0.15.x
  redesign, settings 1:1, browser set, MCP prompts and background tasks (owner
  2026-10-14: the whole app as close to upstream as possible, with our
  specifics). Promoted from the planning workspace by UB1.1 (2026-10-15). Its
  spec is `superpowers/specs/2026-10-14-upstream-adoption-0-15-1-spec.md` (with
  the controller's inputs file as its appendix beside it); the reading evidence
  is `superpowers/specs/data/2026-10-14-ub-delta-0-15-1/` and
  `superpowers/specs/data/2026-10-14-ub-0-14-0/`. Read the plan's Global
  Constraints, §0.6/0.6b serialised files and the Port manifest before taking a
  row; the tracker is the truth of what is still open.

## Testing

- `testing/parity-wave-verification-checklist.md` — **generated.** One row per
  finding of the doc-sweep parity wave, worded from what a user does and sees.
  Regenerate with `python3 scripts/build-parity-verification-checklist.py`.
  It separates 🖐 live rows from 🧪 latent ones on purpose: a latent finding has
  no observable behaviour, so a green live pass on it would mean nothing, and
  mixing the two is how a checklist starts certifying work it never exercised.
- `testing/cdp-live-checklist.md` — the single case×runs table for CDP live
  verification (owner rule 2026-08-20): one row per case, grouped by app area,
  updated at every plan close-out. Run narratives live in `testing/cdp-runs/`,
  one file per run; the pre-2026-08-21 history is archived there verbatim.
  **A case file that no row names is now a RED TEST**, not an oversight:
  `scripts/docs-integrity.test.ts` compares `scripts/cdp/cases/*.ts` against the
  backticked filenames in the table. Deliberately one-directional — a row may
  exist with no file, which is what a `— (case owed)` File cell is FOR — because
  the failure that actually happened was the other way round: nine written
  `nca-*.ts` cases sat on disk for three weeks while their rows still read
  "case owed", which that file's own legend defines as *not yet written*, so the
  whole remote-agent block would have been dropped from a close-out sitting as
  un-writable rather than un-run (P3.359).

## Agent guide companions

The root `AGENTS.md` is loaded into every agent session, so it is kept under 300 lines; these two
files hold what was moved out of it verbatim on 2026-09-25.

- `agents/upstream-docs.md` — the full "upstream docs are contracts" rules: Claude and codex page
  lists, anchor-spelling measurements, the component-table diff script, and the bundle-vs-docs
  version rules.
- `agents/traps.md` — every measured trap, newest first, each with its date and measurement; new
  traps are added here, with a one-line rule in `AGENTS.md` only when every lane must hold it.

## Documentation Rules

- Write for Nessy Desktop and the internal gateway behavior that ships in this
  repo.
- Environment variables are `NESSY_*`, runtime symbols are `Nessy*`, and package
  scopes use `@nessy-agent/*`.
- Do not copy upstream product documentation verbatim. Rewrite in our own words
  and link only where a source reference is useful.
- Claude Code's docs are a contract source, not inspiration — read the `AGENTS.md`
  section of that name (full rules in `agents/upstream-docs.md`) before changing
  plugins, MCP, skills, hooks, commands or agents.
- Update this index when adding, moving or deleting docs.
