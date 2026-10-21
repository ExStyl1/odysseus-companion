# Nessy Desktop

## What This Is

Nessy Desktop is an internal desktop coding-agent for T-Bank — an Electron shell over a
Bun/TypeScript monorepo in which every UI surface (desktop renderer, `nessy-general-agent`
CLI, iOS remote, web surfaces) is a thin client over one WebSocket RPC contract, and a
single `SessionManager` orchestrates agent turns behind pluggable runtimes (Pi, Claude
Agent SDK, Codex app-server, Nestor Cloud). It ships at **1.30.0** against the internal
Nessy Gateway, and its behavioural contract is Claude Code's published documentation.

Its users are this bank's engineers, plus the administrators who deploy managed policy to
them. It is not a product with external customers, so there is no Business Context section.

## Core Value

*Not set.* The previously recorded core value was derived by the roadmapper alongside a
milestone goal that has since been cleared; it is not carried forward as though the owner
had chosen it. Set this when the next milestone is defined.

## Milestone Goal

*No active milestone.* The roadmap was cleared to a blank slate on 2026-08-17 by owner
decision — see `ROADMAP.md`. The prior derived goal and its five-phase breakdown are in git
history at commit `9f4951e15`.

Define the next one with `/gsd-new-milestone --reset-phase-numbers "<name>"`, or add a
single phase with `/gsd-phase "<description>"`.

## Requirements

### Validated

Shipped, live-verified on a packaged build, and relied upon. This roadmap does not re-plan
any of it.

- ✓ Desktop shell, renderer, and one RPC wire contract shared by renderer / CLI / iOS / web
- ✓ Three agent runtimes behind `AgentBackend` — Pi (0.80.3, host-composed subprocess),
  Claude Agent SDK, Codex app-server — plus Nestor Cloud
- ✓ Nessy Gateway integration: one-click `dp` auth on both runtime cards, `Nestor-Token`
  scoped to the verified gateway URL prefix, model auto-refresh (post-wave verification,
  1.21.0: CLR-1/CLR-2/CLR-3/CBX-1 PASS on a packaged arm64 build)
- ✓ Storage v2 under `CONFIG_DIR`, project-local `.nessy-agent` namespace, per-session
  `SessionFilesystemScope`
- ✓ Plugin/skill/hook/MCP import from Claude and Codex bundle formats through one
  normalized `NessyPluginManifest`
- ✓ Permission modes, approvals, guardian judge, file checkpointing and rewind
- ✓ iOS remote (forked and owned since 2026-08-09), headless `nessy-server`, CLI client
- ✓ Parity against Claude Code's documentation: 143/150 rows built at the last generated
  rollup, 352 deviations each carrying a written reason

### Active

*None.* No active milestone — see § Milestone Goal.

### Out of Scope

- **Anything under `docs/superpowers/plans/`** — owner directive for this roadmap. Those
  plans keep their own trackers and their own close-outs; do not re-file their rows here.
- **Managed-MCP and managed-plugin filter work** — blocked on the open owner question
  below. No phase routes it.
- **Re-planning shipped surfaces** — this is a brownfield repo at 1.30.0.
- **Sandbox / process isolation returning by default** — standing owner decision
  2026-08-12/13; "bypass + no-sandbox is containers-only territory."
- **`SEATBELT_TESTING_WILDCARD → false`** — a dated owner decision with a designed re-arm;
  a scheduled pre-GA flip, not a defect to fix ad hoc.
- **A Pi SDK bump past 0.80.3** — `SUPPORTED_PI_RUNTIME_VERSION` is a strict `!==`; a bump
  is a qualification exercise, and 0.81.1 was assessed and skipped.
- **STRUCTURAL rows in the capability register** — they change only if the integration
  shape changes; treating one as a backlog item is the most likely way to waste a plan.
- **The `platform.claude.com` documentation corpus (549 pages)** — owner decision
  2026-07-31: our contract is Claude Code, not the platform API.
- **Themes and Channels in the plugin runtime** — deferred by ADR.
- **Claude Pro/Max and ChatGPT subscription cards** — opt-in build flags, not shipped on.
- **The nine dated owner decisions in `2026-07-29-inert-worklist.md` §3** — decisions with
  reasons, not defects. One of them ("just call `isManagedModelAllowed` at the selection
  site") permanently destroys a user's model list if "fixed".

## Context

**Brownfield, and the debt is in `docs/`, not in comments.** In-code `TODO`/`FIXME` markers
are almost absent (32 repo-wide, mostly the `TodoWrite` feature's own constants). A
grep-only sweep concludes the codebase is clean and is wrong by roughly 360 recorded items.

**Requirements here were not derived from a PRD.** The ingest set carried 11 ADRs, 20 SPECs
and 6 DOCs, and zero PRD-typed documents. Everything in `REQUIREMENTS.md` is derived from
decision records, measured findings and the codebase map, and each requirement names its
source. Do not read them as validated product requirements.

**The recurring defect shape.** Claude's documented schemas were implemented parse-first —
declare the field, validate it strictly, carry it through the manifest and the composed
policy — with the consumer deferred to a slice that never landed. The mechanical chokepoint
is projection (`projectHook`, `RuntimeHookRegistration`, `RuntimeSkillHandle` and the wire
types are hand-written field-by-field copies, so an upstream field stops there silently),
and the aggravating factor is that strictness shipped alongside the parse, so the product's
loudest signal of support is attached to precisely the fields that do nothing.

**Two re-verification passes each found a third of a raw finding list unactionable.** 34%
of one list would have produced a wrong change and two would have been damaging. Nothing
reaches an executor from a sweep without a re-verification pass against current HEAD.

**Three states, not two.** Roughly half of all challenged findings in this series were
refuted. "Unchallenged" is recorded as its own state and is never folded into "survived".

**A detector is the thing most likely to be wrong.** Three in a row looked authoritative
and were not — a typed-but-never-filled field reported "never compacted" through 27 real
compactions. Before filing "feature X never happens", confirm the negative against a source
the feature writes itself.

**Concurrency in this worktree.** Another agent session is editing source files on
`feat/models-fetch` right now. Zone work by file, never by subsystem: `git commit
<pathspec>` takes the file's working-tree state, so two agents editing one file will cross.

## Constraints

- **Repo rules (`AGENTS.md`)**: one commit per task; branch names `<type>/TCODE-000`; no MR
  or tag creation during autonomous execution; the Implementation-First Verification Budget
  (focused checks during the loop, full suites only at an explicit wave boundary or a named
  risk trigger); close-out = version bump in **both** root and `apps/electron`
  `package.json`, a **new** `apps/electron/resources/release-notes/<version>.md` (never
  edit or delete an existing one), and updated `docs-site/` pages.
- **Claude Code's documentation is the contract, not inspiration.** Where our behaviour
  differs from the documented behaviour, our behaviour changes. The only admissible reason
  to diverge is a demonstrated impossibility, and every deviation is recorded in one of
  exactly three category strings. "A deviation with no category is a defect, not a
  decision." Cite the quoted sentence, never a line number — pages grow.
- **Generated files are generated**: `2026-07-30-parity-report.md`,
  `2026-07-29-deviation-register.md`, the doc-sweep pair, and
  `parity-wave-verification-checklist.md`. Never hand-edit; regenerate.
- **Live evidence comes from a packaged build.** `electron:dev` runs the host and the Pi
  subprocess from built bundles, and `resolveInterceptorBundlePath` starts Pi **unpatched
  and silent** when `dist/interceptor.cjs` is missing.
- **Test-rig rules**: `rm -rf release` before a root `bun test`; never two concurrent `bun
  test` processes; `grep -a` for any absence claim (a NUL byte makes plain `grep` skip a
  file SILENTLY — run `bun scripts/check-nul-bytes.ts` for the live list, and do not trust
  a count written in prose: this sentence has said "eight", the scan has since said
  fourteen and then zero, and the first NUL of one file moved 33936 → 34420 inside a single
  wave); `mock.module` must spread the real module **and** restore in `afterAll`.
- **Before any merge, compare against the target branch, not your own base.** The per-base
  "pre-existing" check cannot see an accumulation, and that is how a register grew to 15
  rows `master` did not have.
- **Credential boundary**: `~/.nessy/dp_auth_creds.json` is nessy-cli's shared contract;
  `packages/shared/src/auth/dp` is the only writer; everything else treats it read-only.
- **Feature flags are build-time and mirrored in five places** — `feature-flags.ts` plus
  three build scripts and `fastlane/Fastfile`. Change one, change all five.
- **`SessionManager.ts` is ~22 000 lines** and is the single largest coupling point. Add
  runtime behaviour behind `AgentBackend`, never as an `if (providerType === …)`.

## Key Decisions

<decisions locked="true">

**Two ADRs are LOCKED. Work below must conform; neither is reopened by this roadmap.**

| Decision | Source | What it locks |
|----------|--------|---------------|
| Codex-like workspace storage (storage v2) | `docs/architecture/codex-like-workspace-storage.md` — Accepted 2026-07-13, "still in force at 1.15.0" | One supported runtime layout. Nessy-managed Workspaces, sessions, plugins, policies, trust records and credentials live below `CONFIG_DIR` (default `~/.nessy-agent`, relocatable by `NESSY_CONFIG_DIR`, blank = unset). External Projects and shared user-authored resources stay outside. `workspaceId` + composite `SessionKey` are identity; paths are I/O details. No renderer or remote caller chooses a managed path. Plugin installation never implies activation, credential readiness or trust. Repository content never enters resolution before explicit project trust. Legacy data is **not** migrated; unsafe, ambiguous, corrupt, symlinked or colliding layouts fail closed before any window, RPC listener, session or service starts. |
| Project-local `.nessy-agent` and session filesystem roots | `docs/architecture/project-local-nessy-agent-and-workspace-roots.md` — self-declared "Final architecture" for the P1–P6 cutover | A Nessy Workspace is the logical isolation boundary; the selected external project is the session's actual filesystem workspace. `<project>/.nessy-agent` is the ONLY Nessy-native project namespace — `.nessy` has no reader, alias, fallback, migration or warning path. `SessionFilesystemScope` is the one captured filesystem authority per session and everything resolves through `resolveScopedPath`. Capability collisions resolve Nessy-native > portable > plugin after scope specificity. A project permission mode may only narrow the Workspace/global floor. Git metadata is read-only inside every allowed root and approval cannot broaden it. Managed Nessy storage is denied even under a broad approved parent. Approve-always receipts are revoked on cwd/project switch, identity or trust loss, revocation RPC, session close and Workspace drain, and are never inherited by branches. |

**One known tension, carried unamended.** The storage ADR's operational invariant "Claude,
ChatGPT, and Codex runtime provider flags remain disabled by default" is contradicted by a
later measurement: `isClaudeRuntimeEnabled()` returns `true` when unset and
`PROVIDER_FLAG_DEFAULTS` carries `nessy_claude: true` / `nessy_codex: true` (owner flag flip
2026-08-06/08). A LOCKED decision is not auto-overridden by synthesis, so the invariant
stands as written and the correction belongs to the owner. Its security consequence is the
open question below.

</decisions>

<decisions locked="false">

**Nine further decision records, carried as decisions.** None carries an `Accepted` marker,
so `locked: false` means "no marker found", **not** "provisional". Work below conforms to
them; reopening one is an owner call.

| Decision | Source | Substance |
|----------|--------|-----------|
| Runtime control boundary | `runtime-control-boundary.md` (measured 2026-08-16) | "Pi is ours and is built to Claude Code's documentation; Claude runs 'as-is' so we do not diverge from its real behaviour." Pi: everything model-visible is ours, signed into a manifest asserted identical across the subprocess boundary; the Pi SDK contributes **no** tool. Claude: their agent, tools and loop, with our `PreToolUse` gate (which can block *and rewrite* inputs), an added MCP server for session tools, and our subagent definitions through their `agents` option. Codex: the thinnest control — a config file (14 of 93 keys), an approval answer, and text on the user message; **no `PreToolUse` gate at all**. Since R3 (2026-08-16) the pinned `bypassPermissions` is **gone**: the user's own mode is translated into the SDK's vocabulary and `.claude/settings.json` permission blocks now take effect. |
| Runtime capability gaps | `runtime-capability-gaps.md` (measured 2026-08-16) | Per-runtime register of what a user cannot do and **which of four reasons it is** — STRUCTURAL / DECISION / PLANNED / UNVERIFIED. The reason tag decides whether a gap can ever change. Stated purpose: honesty at the seam, plus a queue where DECISION rows are reopenable and STRUCTURAL rows are not. **Its R3 row and its section header are stale** (overtaken by the change above, commit `3b78acb00`) — do not schedule R3. Rows resting on the same bypass premise were not re-measured and are neither confirmed nor refuted. |
| Extension-first Pi agent runtime | `extension-first-pi-agent-runtime.md` | Pi ships as a closed, host-composed subprocess pinned to `0.80.3`. Only source-controlled built-ins from the closed extension registry load; no ambient scanning. One owner per durable responsibility — "no standalone manifest ingress, fallback runtime, second resolver, second scheduler, or shadow permission path." |
| Unified plugin adapter runtime | `unified-plugin-adapter-runtime.md` | One installed/runtime representation, `NessyPluginManifest`. Codex/Claude layouts and marketplaces are import adapters only, never a second runtime mode. Runtime behaviour never inspects `adapterId`, provider format or marketplace origin. Every hook type executes through the same single hook executor; blocking verdicts are decided by `AGENT_EVENT_CONTRACTS_V1`, not by hook type. |
| Managed MCP access | `managed-mcp-access.md` | `allowedMcpServers`/`deniedMcpServers` on the managed Pi policy, filtered before any denied server materializes; denylist evaluated first and nothing overrides a denylist match. Records its own deliberate deviations and one known open: the lists do not cover the workspace **browse** pool. **Its premise ("the Claude and Codex providers are off unless a build enables them") is contested — see the open question below.** |
| Guardian command judge | `guardian-command-judge.md` | An LLM safety judge that is a consulted input, never an authority — "the deterministic `permission-service` remains the ONLY permission authority." Fail-closed: every runner failure resolves to `unsure`; "the judge NEVER fails open to `no_objection`." Runs only in `auto` and `allow-all`; `safe`/`plan`/`ask`/`acceptEdits` are byte-identical to pre-guardian. Only the user's own current-turn message is authorization evidence. |
| File checkpointing and rewind | `file-checkpoint-rewind.md` | Partial rewind, not whole-rewind refusal — per-path skip, the rewind continues, count and reasons reach the user, and a skip is not a failure. Three ordered link-safety guards ending in `O_WRONLY \| O_CREAT \| O_NOFOLLOW` with an `nlink` re-check on the open descriptor. |
| Conversation forks | `fork-subagents.md` | `NESSY_FORK_SUBAGENT` unset means OFF (no rollout mechanism to mirror upstream's staged one). Fork mode resolves **host**-side and travels in the execution manifest, because it changes the `subagent` schema hashed into `modelContractHash`. Must-not-regress: "a fork that cannot inherit **fails**; it never runs as a summarised or seeded child." |
| Transport locality | `transport-locality.md` | "Locality is read from the capability set the client advertises at handshake, not from a flag it sets." Unknown or empty reads as REMOTE (fail closed). Gates browser tools and `REMOTE_CLIENT_PERMISSION_MODE_CEILING = 'auto'`; deliberately does **not** gate reading and steering a session. `apps/cli` classifies REMOTE today; the recorded fix is for the CLI to advertise the capability, not to loosen `isLocalClient`. |

</decisions>

## Open Owner Questions

### OQ-1 — Managed MCP / plugin filter scope on non-Pi turns (UNRESOLVED, blocking)

`packages/server-core/src/bootstrap/storage-runtime.ts` gates both the managed MCP filter
and the managed plugin filter on `isPiCapabilityTurn = context.provider === 'pi'`
(`:804`, `:888`, `:1091`). So an organisation's managed MCP and plugin restrictions are
unenforced under the Claude backend — "an admin security control that silently does not
apply on a backend whose code we ship."

The parity audit — the declared source of truth — **closed** this by owner directive dated
2026-07-29 on the stated ground that the Claude backend is flag-off and out of scope. That
premise has since moved: `isClaudeRuntimeEnabled()` returns `true` when unset,
`PROVIDER_FLAG_DEFAULTS` carries `nessy_claude: true` / `nessy_codex: true`, `AGENTS.md`
now records the runtime flags as default-ON since 2026-08-06, and the directive's own
citation (`AGENTS.md:127-138`) no longer holds the flag table. Precedence resolves this the
**wrong** way (both flag-off sources are SPEC; the contradicting source is DOC), which is
why it was surfaced rather than picked.

**One answer is needed covering all three sub-questions:**

1. Does the 2026-07-29 scope directive still hold now that `NESSY_FEATURE_CLAUDE_RUNTIME`
   and `NESSY_FEATURE_CODEX_RUNTIME` default on?
2. Is `isPiCapabilityTurn` on the managed filters an intent (the type is named
   `ManagedPiPolicyV1`) or the historical accident the worklist argues it is — noting that
   the same object carries `sandbox`, `channelsEnabled`, `cleanupPeriodDays` and the
   permission DSL, none of which are Pi-specific?
3. Is the ADR sentence "the Claude and Codex providers are off unless a build enables them"
   amended, or is the gate?

**Until one answer covers all three, no managed-MCP or managed-plugin work is routed.** No
phase in `ROADMAP.md` schedules any. Both variants are preserved verbatim in
`.planning/intel/` and neither was picked.

### OQ-2 — Two register rows must not be scheduled

Marked SUPERSEDED-BY-MEASUREMENT and already landed code: the deviation-worklist **P5**
MCP-timeout row (`4a5de5554`) and the capability-gaps **R3** row (`3b78acb00`). Both are
marked in place rather than deleted so the history stays readable.

---
*Last updated: 2026-08-17 — roadmap cleared to a blank slate by owner decision. Decisions,
validated surfaces, constraints and open questions below are retained from the doc ingest
(37 documents) at 1.30.0; only the milestone agenda was removed.*
