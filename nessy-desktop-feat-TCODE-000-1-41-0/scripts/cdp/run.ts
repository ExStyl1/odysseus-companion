/**
 * Wave runner. `bun run scripts/cdp/run.ts [AGT-1 AGT-3 …]`
 *
 * Each case runs as its own process, so one hung case cannot take the wave with
 * it and a crash in one leaves the others' results intact. The runner reads only
 * the `##CDP-RESULT##` line each case prints; everything else is passed through
 * to the terminal.
 *
 * Exit code is the worst status seen: 0 all PASS, 1 any FAIL, 2 otherwise (`--check`, F1.184: see below).
 */
import { existsSync, readFileSync } from 'node:fs'
import { RESULT_PREFIX, type CaseResult, type CaseStatus } from './lib/report.ts'
import { sittingChecklistDrift } from './lib/sitting.ts'
/**
 * `MCP-W1..W3` are the MCP wire-name gate and need their own fixture tree and
 * their own `NESSY_CONFIG_DIR` (`scripts/cdp/fixtures/mcp-naming.ts`), so a
 * plain `bun run scripts/cdp/run.ts` against an operator's normal config dir
 * reports them BLOCKED rather than failing. Run them as a named subset.
 */
const CASES = [
  'AGT-1', 'AGT-2', 'AGT-3', 'AGT-4', 'AGT-5', 'AGT-6', 'AGT-7', 'AGT-8', 'AGT-9', 'AGT-10',
  'MCP-W1', 'MCP-W2', 'MCP-W3',
  // `SKL-P1` has its own fixture tree and its own `NESSY_CONFIG_DIR`
  // (`scripts/cdp/fixtures/paths-skill.ts`) for the same reason as the MCP-W
  // wave, and reports BLOCKED against any other config dir.
  'SKL-P1',
  // `ELC-1`/`ELC-2` share one fixture tree and config dir
  // (`scripts/cdp/fixtures/elicitation.ts`) and `CDX-150` defaults to the same
  // one for its MCP probe, so the three are a subset of their own. All four
  // below report BLOCKED rather than FAIL against any other config dir.
  //
  // The id was BORN carrying the codex tag (CDX-147 -> CDX-148 -> CDX-150) and
  // has STOPPED moving with it: C3.380 lift 2 re-pointed the case to
  // `rust-v0.154.0` on 2026-09-13 without renaming it, because the file is cited
  // by name in three plans and a spec and `lint:ledger-citations` reddens on the
  // rename — a repair only the controller can make. The case's own
  // `EXPECTED_CODEX_TAG` is what stops a result measured against the previous
  // binary sitting under a fresh headline; the id never was. See the docblock at
  // the top of `cases/cdx-150.ts`.
  'CDX-150', 'ELC-1', 'ELC-2',
  // `CDX-ROLES` runs against the operator's normal config dir and needs the two
  // probe agents from VERIFICATION-STATE.md's codex-roles gate; it BLOCKS,
  // naming the missing precondition, against any other setup.
  'CDX-ROLES',
  // `Q6-LIVE` runs against the operator's normal config dir and needs installed
  // agents named through its four env vars; it reports BLOCKED naming whichever
  // of its four claims it could not drive.
  'Q6-LIVE',
  // `MCP-AUTH` runs against the operator's normal config dir; its figma half
  // BLOCKS until the owner completes the app-driven OAuth, and its dp half
  // BLOCKS until a built-in dp server is enabled in settings.
  'MCP-AUTH',
  // D6: this plan's own surface. `RUN-MARKS` runs against the operator's real
  // connections and derives its expectations from them, so it needs no fixture.
  'RUN-MARKS',
  // Geometry, not eyeballing; BLOCKS honestly when no plate is mounted.
  'PLATE-GUTTER',
  // Session runtime switching. These run against their OWN config dir
  // (`scripts/cdp/fixtures/runtime-switch.ts`), not the operator's: a packaged
  // build cannot read the operator's credential store on this machine
  // (the `/usr/sbin` rig fact the fixture's header cites from `cdp-runs/`), and the three gateway cards
  // the wave drives need no store — they authenticate from
  // `~/.nessy/dp_auth_creds.json`. `RTS-9` BLOCKS without a plugin bundling an
  // always-on monitor, and `RTS-10` without a callable credential-free MCP tool.
  //
  // `RTS-4` (Claude Pro/Max -> gateway) BLOCKS on a precondition that is
  // nameable and REVERSIBLE: owner decision 2026-08-15 hides the Claude Pro/Max
  // card and disables it visually, **retaining the code**. It was briefly
  // deleted here on a stronger reading of that decision — "there will be no
  // subscription" — which the owner did not make. A deleted case and a
  // temporarily unavailable one are different states, and only the second one
  // can come back when the card is unhidden.
  'RTS-1', 'RTS-2', 'RTS-3', 'RTS-4', 'RTS-5', 'RTS-6',
  'RTS-7', 'RTS-8', 'RTS-9', 'RTS-10', 'RTS-11', 'RTS-12',
  // T1a (2026-08-20): the fact planted beyond the 24-message text window must
  // survive a Pi -> codex-gateway switch. Same fixture config dir as the RTS
  // wave. Its negative control (the case FAILS on a build without the native
  // carry) is recorded in the run file, not re-run every wave.
  'RTS-13',
  // RTS-14 (owner request 2026-08-21): the full switch matrix — an Eulerian
  // circuit over all six directed runtime pairs in one conversation, each leg
  // doing prose + tool-call (+ a /subtask on leg 1) work first. Assertions are
  // tier-aware: native into claude/codex carries tool facts, anchored returns
  // carry their own record plus the prose tail.
  'RTS-14',
  // RTS-15 (T7, 2026-08-21): the shape RTS-14's circuit has no leg for — a
  // FIRST switch into Pi (empty Pi anchor). Claude does tool work, the switch
  // plans `native`, and Pi must answer from a fact that exists only inside a
  // pre-switch tool result, which the text tier drops.
  'RTS-15',
  // The live Claude session (`docs/superpowers/plans/2026-08-17-claude-live-session.md`).
  // They run against the operator's normal config dir and need NOTHING seeded:
  // each creates its own session and picks a `claude-runtime` card by MEASUREMENT,
  // probing them in turn (starting with `NESSY_CDP_CLAUDE_CARD` when it is set)
  // and using the first whose model completes a turn.
  //
  // They BLOCK, never FAIL, on the two preconditions they cannot create:
  //   - no claude-runtime card completes a turn — an UPSTREAM refusal, and the
  //     block quotes each card's own words. On 2026-08-17 `claude-custom-2`
  //     answered `403 … Security Guardrail Triggered: Malicious MCP detected`
  //     (L10) and `claude-custom` refused its model, while `claude-gateway`
  //     answered normally;
  //   - `ps` cannot see the app or `lsof` cannot read a working directory. Every
  //     child here is attributed to a session BY CWD, so without that the
  //     measurement would report a healthy runtime as having no process at all.
  //
  // `LIV-3` additionally BLOCKS when the card offers no two models with the same
  // DERIVED session shape, because every switch on such a card respawns by
  // design (L4) and there would be nothing live to measure.
  'LIV-1', 'LIV-2', 'LIV-3',
  // L8 — a MID-TURN CORRECTION, on both runtimes that have a native or emulated
  // route for one. Same preconditions as the LIV wave (their own session, a card
  // chosen by measurement) plus one more: each arm SETS the connection's
  // `midStreamBehavior` through the app's own `saveLlmConnection` and restores
  // the operator's own value in a `finally`. That set is unavoidable rather than
  // convenient — `resolveMidStreamBehavior` honours a stored value over the
  // default by design, and every claude/codex connection on a real profile
  // carries an explicit `queue` written at creation, so flipping the DEFAULT
  // moves no existing connection.
  //
  // They BLOCK, never FAIL, when:
  //   - no card of the runtime completes a probe turn (an upstream refusal,
  //     quoted verbatim — `claude-custom-2` answers the L10 guardrail 403);
  //   - the seed turn makes no tool call, for `STR-1` — Claude's steer is
  //     delivered by the next `PreToolUse` hook, so a tool-less turn measures
  //     the prompt rather than the route (`STR-2` is the case FOR that arm);
  //   - `STR-2`'s seed turn DOES call a tool, which is the mirror image: the
  //     undelivered path is unreachable when a boundary exists.
  'STR-1', 'STR-2', 'STR-3', 'STR-4',
  // The Nestor Cloud remote agent (A2A 1.0 on `/api/v2/code-agent/a2a`).
  //
  // These run against the OPERATOR's normal config dir — every one of them needs
  // a real gateway day and none can be run without one, which is why the
  // checklist carries the whole block as `owed` rather than as a failure.
  // `lib/nestor-cloud.ts` defaults its config-dir resolver to `~/.nessy-agent`
  // for the same reason, deliberately NOT to any fixture tree: a wrong config
  // dir would make NCA-5's "the sidecar is gone" true for every run ever made.
  //
  // They BLOCK, never FAIL, on the preconditions they cannot create:
  //   - no `nestor-cloud-agent` connection, or one that is not signed in;
  //   - no app log (NCA-2 and NCA-3 read the codec's own account of the stream,
  //     not the reply — and a PACKAGED build writes no application log at all);
  //   - NCA-6: a genuinely exhausted budget, asserted by the operator with
  //     NESSY_CDP_NESTOR_RATE_LIMIT=1 and re-checked against the gateway's own
  //     `/quota` status before a turn is spent;
  //   - NCA-7: a SECOND remote connection on a non-default origin;
  //   - NCA-9: both a gateway-prefixed Pi card and a BYOK Pi card.
  'NCA-1', 'NCA-2', 'NCA-3', 'NCA-4', 'NCA-5', 'NCA-6', 'NCA-7', 'NCA-8', 'NCA-9',
] as const

/**
 * The RELEASE SITTING's drivable cases (P7.5) — P6.1007.
 *
 * Known ids, so `bun run scripts/cdp/run.ts RS-15` works; deliberately NOT in
 * {@link CASES}, so a bare `bun run scripts/cdp/run.ts` never sweeps them into a
 * wave. That split is the whole row: what was broken was the REFUSAL
 * (`unknown case(s): RS-15`, exit 2), not the absence of a wave.
 *
 * **Card at a time.** Each of these records WHICH card answered rather than
 * switching runtimes for you — the verdict is per runtime, and a wave would
 * measure whichever card the session happened to be bound to while spending a
 * turn on every other case beside it. Run them one at a time, naming the card in
 * the run notes:
 *
 * ```sh
 * bun run scripts/cdp/run.ts RS-15          # or the case file directly
 * bun run scripts/cdp/run.ts RS-27 RS-28    # a pair that shares a fixture
 * ```
 *
 * **Every one of them BLOCKS rather than FAILS** when its card, its env or its
 * fixture is missing — which is what makes running one by name safe, and is the
 * same property `MCP-W1…W3`, `SKL-P1` and the `NCA-*` block rely on. Measured on
 * all nineteen: each either calls `blocked(...)` itself or re-raises a
 * `BlockedError` through `runCase`.
 *
 * **The pure recipes are NEVER here** — `RS-14`, `RS-17`, `RS-18`, `RS-19`,
 * `RS-21`, `RS-23`, `RS-24`, `RS-26` and `RS-31` print `{ meta, manual }` as JSON
 * and no `##CDP-RESULT##` line, so `runOne` would score them FAIL for never
 * having been meant to run. `harness.test.ts`'s sitting block pins that
 * absence — it globs the directory and asserts every recipe id is missing from
 * this file, and every drive id present.
 *
 * That list said NINE and named `RS-25` until 2026-09-12, when `RS-25` grew a
 * `drive()` for the rig day and moved into the block below — which is why the
 * membership question is settled by the glob in `harness.test.ts` and never by
 * this sentence. Derive it:
 * `grep -L 'export async function drive' scripts/cdp/cases/rs-*.ts`.
 */
const SITTING = [
  // First half (W10-h): one case per `measure:` row, all twelve drive.
  'RS-02', 'RS-03', 'RS-04', 'RS-05', 'RS-06', 'RS-07',
  'RS-08', 'RS-09', 'RS-10', 'RS-11', 'RS-12', 'RS-13',
  // Second half (W10-i): SEVEN of `RS-14`…`RS-29` drive, not the six the README
  // said until this row — `RS-28` carries a `drive()` and a `main(ID, TITLE,
  // drive)` exactly like its `RS-27` partner, and was counted as a recipe.
  'RS-15', 'RS-16', 'RS-20', 'RS-22', 'RS-27', 'RS-28', 'RS-29',
  // P6.1052 (W11-z): the auto-mode classifier note, the one P7.14 clause a unit
  // test cannot reach. It drives, so it belongs here; it BLOCKS without its
  // claude card or its PostToolUse hook, like every id above it.
  'RS-30',
  // P6.1080 (W14-sit2): the one-click gateway card a FRESH profile seeds, and
  // whether its first turn answers. It drives, and it is the one case here that
  // needs a config dir created for the run — on an older profile the startup
  // refresh has already repaired the seed, which the case records rather than
  // hides.
  'RS-32',
  // P6.255 open item (b) / plan row C3.54 (R2, the 2026-09-12 rig day): every
  // runtime against a proxy that REFUSES everything — the ledger C12 drive. It
  // blocks without `NESSY_CDP_PROXY_URL` + `NESSY_CDP_PROXY_LOG` and a packaged
  // app whose config dir names that same proxy, like every id above it.
  'RS-33',
  // P6.544 (R2, the 2026-09-12 rig day): the recipe grew a drive() — five shell
  // spellings per runtime against a FAKE HOME. One card at a time via
  // `NESSY_CDP_RS25_RUNTIME`; it BLOCKS without `NESSY_CDP_FAKE_HOME`.
  'RS-25',
  // P6.265 / plan row C5.13 (R1, the 2026-09-12 rig day): the compaction recipe
  // grew a drive() — six files of differing mtime with ONE past the row's
  // 5 000-token boundary, `/compact`, then the runtime's own session file read
  // before and after. One card at a time via `NESSY_CDP_COMPACT_RUNTIMES`; it
  // blocks when that names no family on the host.
  'RS-17',
  // C3.246 + C5.34 (R5, the 2026-09-12 rig day): the four chat-pane dialogs'
  // boxes against the pane's, with the sidebar open and collapsed, plus what a
  // click inside and Escape do to each. It needs NO card and NO turn, so it is
  // the one sitting id that cannot block on a credential — the only precondition
  // is a single content panel.
  'RS-34',
  // C3.37 + C3.38 (R5, the 2026-09-12 rig day): the administrator's plugin-trust
  // sentence on the install confirmation, and the organization's announcement on
  // the session's own notice channel. It BLOCKS without the delivered policy the
  // fixture writes and the two sentences exported to match VERBATIM; its CONTROL
  // is a second sitting with the policy withdrawn and the app relaunched.
  'RS-35',
  // C5.29 / denominator F40 (R6a, the 2026-09-12 rig day): what a BRANCH inherits
  // at the keyboard — an allow-for-this-session grant re-issued in the branch,
  // and a backgrounded command branched mid-flight. It needs no fixture and no
  // policy, only a card that answers a turn; `NESSY_CDP_BRANCH_RUNTIMES` selects
  // the families and defaults to `claude,codex`, because Pi cannot complete a
  // turn while the dp CLI session is lapsed.
  'RS-36',
  // P6.287 / plan row C5.16 (R6a, the 2026-09-12 rig day): the titling recipe grew
  // a drive() when its own proxy premise was refuted — claude's mini request is
  // filed by the SDK itself (with `message.model`), and codex's never reaches the
  // app-server at all, so two of the three arms need no egress proxy. Pi still
  // does, and the recipe is kept verbatim for it. `NESSY_CDP_TITLE_RUNTIMES`
  // selects the families and defaults to `claude,codex`.
  'RS-21',
  // C5.30 (R4, the 2026-09-12 rig day): C4.13's live proof — a REAL detached
  // codex review, `review/start` with `delivery: "detached"`, and its findings
  // arriving back in the session. It needs no env and no fixture (it mints its
  // own git repository under the OS temp dir and removes it in a `finally`), and
  // it BLOCKS when the host lists no codex-runtime card, like every id above it.
  'RS-37',
  // C3.371 (RV, the 2026-09-12 release verification of 1.37.0): the reopen
  // compact-or-keep card's three answers, each measured at `awaitingApprovalCount`
  // rather than on the screen. It DRIVES, in two passes: the first seeds four
  // named sessions and BLOCKS for `fixtures/reopen-compact.ts` plus a relaunch,
  // because the offer's preconditions are a config write a case may not do.
  'RS-38',
  // DA2.11 (WB-f, wave A2 of the dp-auth wave-2 plan, 2026-09-14): the app's own
  // `sessions:command` reply ceiling while an operator proxy refuses the app's own
  // auth hosts. It needs the lane's own refusing proxy
  // (`fixtures/refusing-proxy.ts`) and a FRESH config dir carrying the app's own
  // `networkProxy`, and it runs as its own UNPROXIED control arm when neither is
  // exported — so it is reachable by name here and never swept into a wave.
  'RS-43',
  // DA2.16 (lane SIT, the 1.39.0 release sitting): the two DA2.6 disclosure
  // surfaces read off the RENDERED DOM of the packaged build. It creates its own
  // BYO card with a fabricated key and removes it again, drives no turn at all,
  // and BLOCKS without a gateway card to read the absence on — so it is
  // reachable by name here and never swept into a wave. It RESIZES the window
  // between its arms (the two composers carry different pickers) and restores
  // the viewport it started in.
  'RS-44',
  // DA1.11 + DA1.10 (lane SIT, the 1.39.0 release sitting): a BYO endpoint on
  // the gateway HOST — named, accepted, and carrying the connection's own Bearer
  // rather than the corporate token. It BLOCKS without NESSY_CDP_APP_LOG (the
  // app's own captured stderr, where `logUpstreamAuthScheme` writes the only
  // line that says which scheme went upstream), so it is reachable by name here
  // and never swept into a wave.
  'RS-40',
  // DA1.13 + its RS-42 control (lane SIT, the 1.39.0 release sitting): the three
  // gateway cards keep no stored credential and stay selectable, and a BYO card
  // on the gateway HOST keeps its own key across a card re-run. It presses the
  // product's own one-click buttons on a profile created for the run and BLOCKS
  // without NESSY_CDP_APP_LOG, so it is reachable by name here and never swept
  // into a wave.
  'RS-41',
  // DA1.17, rewritten for F1.6 by F1.203: `/quota` on the claude and codex gateway
  // cards renders the SAME budget the Pi card reads, with two BYO controls (R1's
  // gateway-chat-base SUBPATH included) still refused. It presses the product's
  // one-click buttons on a profile created for the run and BLOCKS when a card
  // cannot be created, so it is reachable by name here and never in a wave.
  'RS-39',
  // DA2.5 (lane SIT, the 1.39.0 release sitting): the loopback MCP pool server's
  // bearer floor on the SHIPPED listener, and the ORDERING — 401 before the body
  // parse and before the session lookup. It creates a codex session (only
  // `codex-runtime` starts a pool) and BLOCKS without a codex card, so it is
  // reachable by name here and never swept into a wave.
  'RS-45',
  // D1.14 (lane WI-f, the first MEASURE sitting on the packaged 1.39.0):
  // `/tasks` and `/workflows` typed into the composer, beside `/help` and
  // `/status` as the two controls the parser demonstrably carries. It needs no
  // env and no fixture, only a card that lets a session exist, and it BLOCKS
  // when the profile lists none — so it is reachable by name here and never
  // swept into a wave.
  'RS-46',
  // D1.3 (lane WI-f): the playground page inside the PACKAGED artefact — does it
  // ship, does any route reach it, and does a forced navigation. It reads the
  // `.app` from disk (`NESSY_CDP_APP_ROOT` overrides the default) and BLOCKS
  // when that directory is the repo rather than the artefact.
  'RS-47',
  // D1.13 (lane WI-f): a Pi sidecar planted under a session id the Nessy store
  // has never heard of, against the product's own search and session list. It
  // BLOCKS without `NESSY_CONFIG_DIR` — it writes into that directory — and
  // without a Pi sidecar in the profile to copy.
  'RS-48',
  // D1.18 (lane WI-f): the SDK's dynamic-Workflows tool in a PACKAGED claude
  // session's own roster. It BLOCKS without a claude-runtime card AND — measured
  // 2026-09-17 — on its own control, because the SDK's persisted transcript
  // carries no tool roster on 1.39.0; the file records that rather than scoring
  // an absence its instrument could not have seen.
  'RS-49',
  // DA2.26 (lane WI-m, the second MEASURE sitting; re-pointed for F1.6 by F1.203):
  // the ordinary-turn POSITIVE CONTROL RS-39 never had, plus the three typed forms
  // of `/quota` read on BOTH surfaces — a budget on all three gateway cards, and
  // the refusal on one fabricated-key BYO card. It BLOCKS when a gateway card
  // cannot be created, so it is reachable by name here and never swept into a
  // wave.
  'RS-50',
  // D1.21 (lane WI-m): whether claude's own `EnterWorktree` built-in fires in a
  // packaged session, and whether what it produces lands under the HOST's own
  // worktree root. It mints its own git repository under the OS temp dir and
  // removes it — and any worktree inside it — in a `finally`, and BLOCKS when
  // the host lists no claude-runtime card, so it is reachable by name here and
  // never swept into a wave.
  'RS-51',
  // D1.27 (lane WI-u, the third MEASURE sitting on the packaged 1.39.0): whether
  // a `scout` child really runs on the gateway's `fast` model, driven against the
  // SAME card with the alias stripped as arm B. It edits the rig profile's stored
  // catalogue through the app's own saveLlmConnection and restores it in a
  // `finally`, and it BLOCKS when the app inherited `CLAUDE_CODE_SUBAGENT_MODEL`
  // from the shell that launched it — so it is reachable by name here and never
  // swept into a wave.
  'RS-52',
  // D1.235 (lane WI-u): RS-51's open question — the documented worktree approval
  // driven in `default` mode, with an ungranted shell command in the SAME session
  // as the positive control that the card mechanism is alive. It mints its own
  // git repository under the OS temp dir and removes it, and its worktrees, in a
  // `finally`; it BLOCKS without a claude-runtime card and on an app that
  // inherited the lane shell's own CLAUDE_CODE_* names.
  'RS-53',
  // D1.33 (lane WI-u): an Always Allow granted INSIDE a worktree, and whether
  // the rule lands in the main checkout and reaches a second worktree. It mints
  // its own repository and two worktrees under the OS temp dir and removes them
  // in a `finally`, and it BLOCKS without a claude-runtime card, on a
  // contaminated app environment, and when no Bash spelling raises a card at all
  // — which on this build is a reading rather than a failure.
  'RS-54',
  // D1.183 (lane WI-u): a PROTECTED FILE write driven on codex, with the SAME
  // write on claude in the same run as the control that the floor exists at all.
  // It mints a scratch WORKSPACE (not a repository, not a scratch HOME) under the
  // OS temp dir and removes it in a `finally`, and it BLOCKS without BOTH cards
  // and on a contaminated app environment.
  'RS-55',
  // D1.260 (lane WI-aa): the INSTRUMENT every child-reading case rests on, asked
  // about itself — `getPiHarnessRuntime` read on one session BEFORE and AFTER its
  // first turn, with `listPiAgentView` scored as its own before/after beside it,
  // and the agent panel's mount against the child record on disk. It BLOCKS
  // without a pi card and on a contaminated app environment, writes no
  // configuration and edits no stored connection.
  'RS-56',
  // D1.78 (lane SIT-5c, the fifth MEASURE sitting on the packaged 1.40.0): the
  // per-session runtime diagnostic file, read for pi, claude and codex in ONE
  // profile so the absence on one is scored beside a sibling's file found by the
  // same reader in the same directory. It needs cards for at least two families
  // and BLOCKS otherwise, writes no configuration and edits no connection.
  'RS-71',
  // D1.60 (lane SIT-5c): the six ambient prompt-caching OFF switches read off the
  // SHIPPED claude child's own environment rather than off
  // `buildClaudeSubprocessEnv()`, with an arbitrary planted name as the positive
  // control and a strip-list name as the negative one. It BLOCKS unless the app
  // was launched with that plant, and its BITE arm drives a Pi session on the
  // same gateway model to decide whether the cache accounting has a subject.
  'RS-72',
  // D1.234 (lane SIT-5b): is the SDK's auto-mode classifier REACHED at all on a
  // packaged claude card, with a long transcript in front of it? It reads the
  // app's OWN captured output, so it BLOCKS without `NESSY_CDP_APP_LOG`.
  'RS-63',
  // D1.6 (lane SIT-5b): the composer's claude safety sentence against the
  // behaviour it asserts, on the row's own decisive arm — `default` and `auto`,
  // each with a read-only command beside the dangerous one as the negative.
  'RS-64',
  // D1.7 (lane SIT-5b): the seven Pi permission-mode sentences against the
  // behaviour they assert — a fresh session per mode, a read-only and a mutating
  // probe each, cards counted per PROBE. It needs a pi card and nothing else.
  'RS-65',
  // D1.244 (lane SIT-5a): what the gateway catalogue publishes for the `fast` and
  // `coder` rows, read off `config.json` — the file the refresh itself writes —
  // after the startup refresh has landed. It states the artefact question first
  // out of `ROW_ARTEFACT_MARKERS` and BLOCKS on a build predating `4e3b57caf`;
  // it drives no turn and writes nothing.
  'RS-57',
  // D1.162 / ledger K34 (lane SIT-5a): the model picker's catalogue-provenance
  // label PER ENTRY, in BOTH pickers, with all three states of `catalogueListed`
  // planted on one connection and read in one pass. It creates a BYO card with a
  // fabricated key, never spends it, and deletes the card in a `finally`.
  'RS-58',
  // D1.63 (lane SIT-5c): whether an output-token figure reaches the renderer
  // MID-TURN, read off `onSessionEvent` — the channel the session atom is
  // updated from — and never off `getSessions()`, which does not carry
  // `tokenUsage` while a turn runs. Its positive control is `text_delta` on the
  // same subscription. It BLOCKS when the profile lists no card at all.
  'RS-73',
  // D1.61 (lane SIT-5c): which model the claude arm's MINI tier resolves to on a
  // gateway card, read off `ANTHROPIC_DEFAULT_HAIKU_MODEL` in the child the
  // packaged app spawned — four model-id variables and nothing else from that
  // environment. Its control is the resolved id being in the card's OWN
  // catalogue, since the SDK's built-in default is a Haiku id no gateway serves.
  'RS-74',
  // D1.56 (lane SIT-5c): whether a non-zero command in a parallel tool batch
  // cancels its sibling, on all three families in one profile. Its detector is a
  // marker only the sibling can print, in a tool RESULT; its control is the same
  // batch with both succeeding, in the same session. It keeps a permission
  // approver running underneath and BLOCKS when the profile lists no card.
  'RS-75',
  // D1.57 (lane SIT-5c): whether anything stops a model overwriting a file it
  // has never read, on all three families over ONE scratch workspace the case
  // mints under the OS temp dir and removes in a `finally`. Its detector is the
  // file's own bytes, its control is a NEW file the same turn creates, and it
  // separates "the model complied" from "the runtime stopped it" by tool ORDER.
  'RS-76',
  // D1.95 / P2.62 (lane SIT-5d): a RUNNING background record from a PREVIOUS host
  // process, read through the product's own `listSessionScheduledWork` after a
  // restart — the half sitting 4 could not take, because the surface travelled in
  // the snapshot D1.264 fixed. TWO PHASES on one config dir
  // (`NESSY_CDP_RS61_PHASE=plant`, the operator's relaunch, then `=read`), with a
  // state file and the app's pid supplied by the rig; it BLOCKS on the two pids
  // being equal, which is an operator who did not relaunch.
  'RS-61',
  // D1.74 (lane SIT-5c): the settings COMBINE rule per family, read off the
  // product's own `getSettingsProvenance`, cross-checked against the claude
  // child's own `[DEBUG]` account of which `settings.json` files it opened. Its
  // control is NOT that the two accounts overlap — the finding itself falsifies
  // that — but that the child's account names a path under this profile. It
  // needs a claude card and NESSY_DEBUG=1, and BLOCKS without either.
  'RS-77',
  // D1.207 (lane SIT-5d): `session.id` on codex's OTLP TRACE resource, with the
  // `/v1/logs` stream P2.450 already drove as the positive half and a second
  // session as the per-session control. The exporters are resolved from the MAIN
  // process's environment when the runtime is built, so no case can turn them on:
  // it BLOCKS without `NESSY_CDP_OTLP_LOG`, and without a codex card it presses
  // the product's own one-click button for one.
  'RS-59',
  // D1.40 / P6.288 (lane SIT-5d): how much of a session's FIRST turn is the agent
  // process starting, per runtime — `cold − warm` over FOUR identical turns on
  // the PRODUCT's own message timestamps, because a packaged build reports no
  // spawn time anywhere. The LAST TWO turns are the control — turn 2 is measurably
  // not warm yet — and the case reports UNAVAILABLE rather than a number when they
  // disagree past its ceiling. It drives every family the profile has, and BLOCKS on none.
  'RS-62',
  // D1.64, the OUTPUT-STYLE half (lane SIT-5e): a fork inherits the session's
  // output style and a named subagent does not, read off each CHILD's own
  // composed prompt on disk rather than through `getPiHarnessRuntime`, which
  // throws on this packaged build (RS-56). It asks the product's own palette
  // whether `/subtask` is offered before typing it — a PI-only entry here — so
  // the fork clause is a measured NULL on claude and codex rather than a rig
  // failure. Needs the `agent-surfaces.ts` output style plus its marker.
  'RS-78',
  // D1.65 (lane SIT-5e): the memory-index over-limit and near-limit write
  // notices, read off the `remember` tool RESULT and off the session's own
  // runtime file — the row's "not only in the tool result envelope". ONE ARM PER
  // RUN (`NESSY_CDP_MEMORY_ARM=over|near|ok`), because the levels are one-way:
  // `scripts/cdp/fixtures/memory-index-limits.ts` seeds the index for the arm and
  // the case BLOCKS when the profile is seeded for a different one.
  'RS-79',
  // D1.67 (lane SIT-5e): nested skill discovery — a skill under `pkg/web` is
  // absent from the composed prompt until a file under that directory is read,
  // and present on the turn after, with the same-named project-root skill still
  // there. The root skill's own token is the reader's positive control. It mints
  // and removes its own scratch project; no env, no fixture.
  'RS-80',
  // D1.81 (lane SIT-5e): claude's interrupt receipt at the seam — the host's own
  // `Claude turn interrupt (…); child advertises|does NOT advertise
  // interrupt_receipt_v1 (capabilities: …)` line, read out of the per-session
  // diagnostic BEFORE and AFTER a real Stop with a message queued behind it. It
  // needs a claude card and NESSY_DEBUG=1 (the diagnostic is written only in
  // host debug mode) and BLOCKS without either.
  'RS-81',
  // D1.43 (lane SIT-5f): the three hook fields the row names — the effort input
  // read out of a PreToolUse child's own env dump, `terminalSequence` against
  // its own `systemMessage` sibling in ONE SessionStart document, and `async`
  // against the product's own turn-end timestamp. It needs the Pi card and the
  // two markers `scripts/cdp/fixtures/hook-output-fields.ts` prints, and BLOCKS
  // without either.
  'RS-86',
  // D1.71 (lane SIT-5e): whether installing a plugin turns its bundled MCP
  // server ON, read off `capabilities.getCatalog` before the install, straight
  // after it with no user action, and after the uninstall. It INSTALLS a
  // marketplace plugin — the precondition every earlier sitting recorded as the
  // operator's — into the config dir the run was launched with, resolving the
  // listing BY NAME, and removes it in a `finally` using the key the CATALOG
  // reports. It requires an empty `installedPlugins` to start, so it refuses a
  // dirty profile rather than measuring one.
  'RS-82',
  // D1.76 half (a) (lane SIT-5e): what a RUNNING session re-reads when a settings
  // file is edited under it — the product's own `getSettingsProvenance` before
  // and after a merge into `<config>/config.json`, the app's own output since the
  // edit (`NESSY_CDP_APP_LOG`, UNAVAILABLE rather than negative without it), and
  // the claude child's own account of which settings files the NEXT turn opened.
  // The write is the fixture's (`fixtures/live-settings-edit.ts`), merge-
  // preserving and restored in a `finally`; it needs a claude card and
  // NESSY_DEBUG=1.
  'RS-83',
  // D1.70 (lane SIT-5e): does a plugin installed at PROJECT scope in a main
  // checkout load in a `git worktree` of the same repository? It mints the repo
  // and the worktree under the OS temp dir, installs with
  // `activateIn: { kind: 'project', context: { workspaceId, sessionId } }`, and
  // reads `capabilities.getCatalog` once PER SESSION so each answer is that
  // session's own project scope. The main-checkout session is the control; both
  // sessions' trust states are recorded beside the verdict so "never trusted
  // there" cannot be read as "the handle does not follow the repository".
  'RS-84',
  // D1.134 (lane SIT-6b): ONE command hook per AgentEvent, each appending to its
  // own `<Event>.hit` file, so "which events actually fire on claude" is read
  // off a file rather than off the handful of events whose stdout is delivered
  // somewhere. It reads a DELTA per phase because one hits directory serves both
  // arms, takes the row's own named control (the same matrix on Pi) in the same
  // run, and keeps `not-provoked` apart from `provoked-and-silent`. It BLOCKS
  // without `NESSY_CDP_HOOK_MATRIX_DIR`.
  'RS-97',
  // D1.75 (lane SIT-6a): which of the four settings keys wait for workspace
  // trust, read off `getWorkspacePermissionsConfig`, `getSettingsProvenance` and
  // `marketplace.listRegistries()` BEFORE the app's own trust dialog is answered
  // and again after it. No turn and no fixture — the gate is a host predicate —
  // but it needs a config dir whose trust modal has never been CANCELLED, and it
  // blocks rather than reporting a table whose two halves were taken under the
  // same condition.
  'RS-87',
  // D1.135 (lane SIT-6b): the forwarded subagent fields as DIFFERENCES — a
  // `maxTurns: 1` cap against no cap (H25) and `background: true` against no
  // flag (H26), each pair one frontmatter line apart with an identical body.
  // The detector is a file the CHILD appends to, because neither arm is legible
  // in the parent's transcript. One card at a time via `NESSY_CDP_RS98_RUNTIME`;
  // it BLOCKS without `NESSY_CDP_SUBAGENT_PROBE_DIR`.
  'RS-98',
  // D1.137 (lane SIT-6b): Pi's LSP route driven once with an official `*-lsp`
  // plugin in a TRUSTED project — the positive control P3.366 asked for, whose
  // absence is why J25's Pi cell is `partial` on inference. Three gates produce
  // the same empty result for different reasons, so it reads all three: the
  // plugin's catalog contribution, the trust state (the gate is literally
  // `projectTrustState === 'trusted'`), and a type-breaking edit against a
  // type-correct one in the same session. It BLOCKS when the trust gate answers
  // `not-shown`, which is a profile that cannot answer rather than an untrusted
  // project.
  'RS-99',
  // D1.392 (lane SIT-8): the `/btw` panel and the agent-driven add popover are
  // ONE card since `7011c3bf4`, and this case measures both in the SAME session
  // - same width, same grip, no title row, no footer, the empty-state sentence
  // centred - with the add popover's own copy as the control, because a shared
  // shell that restyled the four add-source / add-skill call sites it came from
  // is a regression rather than a fix. RS-101 (D1.384, a `/btw` typed inside the
  // panel) and RS-102 (D1.383, no `queueGet` for a renderer-minted id) fold in
  // as arms with their own PASS/FAIL. It needs ONE card that answers a turn - a
  // side question rides the real session's runtime - and it switches the app's
  // language for the second locale, putting it back in a `finally`.
  'RS-100',
  // D1.429 / D1.430 / D1.343 / D1.426 (lane SIT-10, the 1.40.0 release re-smoke):
  // the safety floor those four rows left behind, measured in one app run because
  // three of them write to the SAME two records and the fourth and fifth are the
  // floor that says nothing was taken away. It writes the operator's own
  // `hooks.json` and restores it in a `finally`, mints its own scratch git
  // repositories and removes them, and needs ONE card that can call a session
  // tool. D1.425's arm is recorded as not drivable WITH its two measured
  // reasons rather than skipped.
  'RS-103',
  // D1.435 / D1.436 / D1.438 (lane SIT-10): the three fixes that landed AFTER
  // the 1.40.0 dmg was first cut, re-driven on the packaged artefact - the cold
  // `/btw`, the claude-gateway "Always Allow" scope, and the workspace
  // `permissions.json` floor. The middle arm needs BOTH a `claude-runtime` card
  // and a `pi` card in the same run (the two readings are only meaningful beside
  // each other) and says so rather than passing on one of them.
  'RS-104',
  // D1.401 / D1.402 / D1.403 / D1.404 / D1.413 (lane WJ-j, F1.122): the
  // Always-Allow FLOOR, which SIT-9 drove from a scratch rig that lives only in
  // that lane's scratchpad. One click must write the NARROW `Bash(npm test *)`
  // and never `Bash(npm *)`; a compound chain, a different subcommand and every
  // interpreter head must still ask, with a NEW session running the granted
  // command card-free as the positive control - without it every "a card
  // appeared" arm is equally true of a build whose persist is broken. It needs
  // ONE card that can run a Bash command, mints its own git repository under the
  // OS temp dir and removes it in a `finally`, and runs its subject turns in
  // `default` (read back) because the shipped `auto` asks for nothing.
  'RS-108',
  // F1.148 + F1.156 (lane WJ-jj): SIT-11 surface B as a case - the seven bundled
  // skills in the palette on every runtime the profile offers, then one fresh
  // chat per skill on ONE runtime (`NESSY_CDP_RS106_FAMILIES` widens it) with a
  // body-unique sentence as the detector and the same probe WITHOUT the selection
  // as the negative control. It mints a scratch git repository and removes it,
  // and deletes any session whose `/loop` turn scheduled something.
  'RS-106',
  // F1.148 + F1.157 (lane WJ-jj): SIT-11 surface A as a case - the built-in dp set
  // read against the shipped definitions on two readers, two servers switched on
  // through the Settings write (the called one and a breadth control) and back off
  // in a `finally`, one fresh session per chosen runtime calling a read-only dp
  // tool and the session MCP server, and the dp-less branch where the machine can
  // reach it (it names why it cannot when `/usr/local/bin/dp` exists).
  'RS-105',
  // F1.148 (lane WJ-jj): SIT-11 surface C as a case - the command-and-hook fixture
  // bundle (`buildCmdHookFixture`, registry market-c) installed through the
  // product's marketplace RPC, its command dispatching a body-only token and its
  // two hooks firing behind their cards in `default` on every runtime offered,
  // then uninstalled with the palette and the identical hook turn as the
  // negative controls. It writes only under the fixture root and removes the
  // plugin and its registry in a `finally`.
  'RS-107',
  // UA1.12 (lane UA-m, 1.42.0): the closure guard and codex status and labels
  // on Pi, Claude Code and Codex - the agent sets Needs Review and a configured
  // label, is refused Done by name with the status unchanged, and the user closes
  // the session from the row's status menu as the control. One fresh session per
  // runtime (`NESSY_CDP_RS109_RUNTIMES` narrows it); a selected family with no
  // card FAILS as unmeasured, because the Phase 1 cut needs all three.
  'RS-109',
  // UA2.7 (lane UA-ae, 1.42.0): the Kanban board - the List / Board toggle, a
  // real pointer drag into Done without and then with a drop status, both
  // placements and the status surviving a reload, and the needs-input badge and
  // runtime chip of a session holding a DENIED permission card on Pi, Claude
  // Code and Codex (`NESSY_CDP_RS110_RUNTIMES` narrows it). It deletes every
  // session it created and restores the per-viewer drop-status map.
  'RS-110',
  // UA3.9 (lane UA-ae, 1.42.0): durable tasks - a two-node task through the
  // editor's tasks:create channel reads 0/2 on its tile; per runtime
  // (`NESSY_CDP_RS111_RUNTIMES`), create_board_task lands a task in To do with
  // one `main` node and no turn, the same title takes `-2`, and a foreign folder,
  // a source the caller has not enabled and another connection are each refused
  // by the tool with their code, creating nothing. It deletes what it created.
  'RS-111',
  // UA7.6 (lane UA-ao, 1.42.0): the Pages 6+7 unit - per runtime
  // (`NESSY_CDP_RS112_RUNTIMES`) create_page + write_page_data, update_page, an
  // open live page updating in place, and delete_page's one-shot card under
  // bypass (Deny keeps, Allow removes); once, the frame egress matrix on
  // case-owned loopback ports (a connection is a LEAK and holds the unit out),
  // compatMode, open-url's full-URL confirmation with Cancel opening nothing,
  // and a thumbnail capture that reaches no port. It deletes what it created.
  'RS-112',
  // UA8.5 (lane UA-av, 1.42.0): a page's scheduled refresh and a user-authored
  // script action - an agent's create_page refresh is inert until its digest is
  // approved (one real tick runs nothing), runs on the next tick and on Run now
  // with an audit line, an edit re-asks; the script action is refused by Run
  // test until approved on its row, then runs, then is refused after an edit;
  // no denied parent env name reaches either child. ~15 min (three real ticks);
  // `NESSY_CDP_RS114_RUNTIMES` narrows the agent arm. It deletes what it created.
  'RS-114',
  // UA4.12 (lane UA-ar, 1.42.0): the Conductor and Generate - a Pi/Claude/Codex
  // DAG passes outputs, takes a forced FAIL, repairs b and its dependent, PASSes;
  // pause/resume; the mode ceiling and needs-input on a blocked node; the run
  // confirmation from the tile's Play and an on-disk edit re-asking; fds under
  // four codex nodes; background producers holding a node; Generate drafting,
  // adopting and running. Families by `NESSY_CDP_RS113_ARMS` (default
  // D,P,M,C,F,W,G; R1 then a relaunch then R2 for the restart). It deletes what
  // it created.
  'RS-113',
  // UA9.5 (lane UA-av, 1.42.0): page source actions on one case-authored page -
  // a timer grant request opens no dialog; a click asks, the dialog shows the
  // host descriptor and pinned sha256, Allow issues a ledger grant; Act runs the
  // script once with page-actions and privileged-actions audit lines; a timer
  // action after a host-toolbar click is refused frame-focus-required; a content
  // edit makes the grant stale (grant-stale); a revoked grant is refused
  // (grant-not-found). No turn, no card. It deletes what it created.
  'RS-115',
  // UA5.11 (lane UA-ay, 1.42.0): Projects - a project bound to a case-minted
  // folder raises the trust card for that folder (UA5.7's folder wording) and a
  // decided one does not; the list groups by project and setProjectId moves a
  // row live without moving its folder; a project's own board columns persist
  // across a reload; a renamed folder keeps the identity and trust, a replaced
  // one (or a config.json pointed elsewhere) is refused; delete unbinds; the
  // project context and an asset reach a turn on Pi/Claude/Codex. Arms by
  // `NESSY_CDP_RS116_ARMS` (default T,G,C,R,X,D,K), the K runtimes by
  // `NESSY_CDP_RS116_RUNTIMES`. It deletes what it created.
  'RS-116',
  // UA6.7 (lane UA-be, 1.42.0): Pages publishing - THE OWNER'S dp identity (the
  // case PUBLISHES FOR REAL to t-artifacts, O15 with UA1.22/UA1.27; it BLOCKS,
  // never fails, when the dp identity cannot publish): the Share dialog's review
  // card before anything is sent, publish without data (the link renders, init
  // with a NULL snapshot, an action answers view-only), publish with data (the
  // reviewed sha256 changes, the amber warning for a planted FAKE apiToken key,
  // a drifted review refused with nothing sent, "Publish latest" keeps the
  // link), the two-step Unpublish (the link answers 404), the page delete taking
  // the service copy down FIRST (registry.json and the folder polled beside it;
  // no pending-delete row left), and a script grant blocking Publish. Retention
  // of every publication is lowered to 1 day and every artifact id is deleted in
  // the sitting. No turn, no card, no runtime surface. The dark playground sweep
  // (Share Page Dialog states, Page Tile "Published", Library "Three kinds · one
  // published", Delete dialog "Published page") is a MANUAL add-on: the packaged
  // build's will-navigate admits only index.html (P6.667) and the playground
  // refuses a bridge it did not install (P6.668).
  'RS-117',
  // F1.1289 (lane BK-4, 2026-10-09): F1.1241's hand arms as a case - on a direct
  // Anthropic card, Opus 4.8 and Fable 5.1 answer one turn each, the runtime's
  // resolved window (refreshContextUsage) reads 1M and no [1m] reaches the
  // session model, the turn's rows or the page; the launch is read off the app's
  // own environment, and a run on an app launched with
  // CLAUDE_CODE_DISABLE_1M_CONTEXT=1 drives Opus 4.8 alone and reads 200K. Run it
  // twice per sitting, once per launch. `NESSY_CDP_RS118_CARD` picks the card.
  'RS-118',
  // A16 (P6.194, lane L5F1, 2026-10-11): the project-settings defaultMode row as
  // a case — three repos (bypass / auto / default-control) opened once per
  // runtime on a packaged build, reading C3.18's host-side scope refusal, the
  // session record's mode, and one mutating command per arm under an approver.
  'A16',
] as const

/** Every id this runner will accept — the wave, plus the sitting by name. */
const KNOWN = [...CASES, ...SITTING] as const

function caseFile(id: string): string {
  return new URL(`./cases/${id.toLowerCase()}.ts`, import.meta.url).pathname
}

async function runOne(id: string): Promise<CaseResult> {
  const child = Bun.spawn(['bun', 'run', caseFile(id)], {
    stdout: 'pipe',
    stderr: 'inherit',
    env: process.env,
  })
  const stdout = await new Response(child.stdout).text()
  await child.exited
  const line = stdout.split('\n').find(l => l.startsWith(RESULT_PREFIX))
  if (!line) {
    return {
      case: id,
      title: '(case produced no result line)',
      status: 'FAIL',
      durationMs: 0,
      checks: [],
      observations: {},
      error: `no ${RESULT_PREFIX} line; exit code ${child.exitCode}`,
    }
  }
  return JSON.parse(line.slice(RESULT_PREFIX.length)) as CaseResult
}

/**
 * F1.184 — `bun run scripts/cdp/run.ts --check`: `SITTING` against the checklist,
 * both directions, and nothing driven. The logic and why it is a check rather
 * than a harness gate are `sittingChecklistDrift`'s (`lib/sitting.ts`). Exit 0
 * clean, 1 on drift, 2 when the checklist read found no sitting row at all —
 * an unreadable checklist must not read as a clean one.
 */
if (process.argv.includes('--check')) {
  const checklistPath = new URL('../../docs/testing/cdp-live-checklist.md', import.meta.url).pathname
  const checklist = existsSync(checklistPath) ? readFileSync(checklistPath, 'utf8') : ''
  if (!/^\| RS-\d+ \|/m.test(checklist)) {
    console.error(`--check: no RS-* row read from ${checklistPath}, so no verdict — an empty read is not a clean one`)
    process.exit(2)
  }
  const drift = sittingChecklistDrift(SITTING, checklist, id => {
    const file = caseFile(id)
    if (!existsSync(file)) return 'absent'
    return readFileSync(file, 'utf8').includes('export async function drive') ? 'drive' : 'recipe'
  })
  const list = (ids: readonly string[]): string => (ids.length > 0 ? ids.join(', ') : '(none)')
  console.log(`SITTING ids with NO checklist row (reachable by name, nowhere to record a verdict): ${list(drift.sittingWithoutRow)}`)
  console.log(`checklist RS rows whose case DRIVES but SITTING does not name (refused by name): ${list(drift.rowsNotInSitting)}`)
  console.log(`  info — checklist RS rows whose case is owed (no file yet): ${list(drift.rowsOwed)}`)
  console.log(`  info — checklist RS rows whose case is a recipe (never in SITTING by design): ${drift.rowsRecipe.length}`)
  process.exit(drift.sittingWithoutRow.length + drift.rowsNotInSitting.length > 0 ? 1 : 0)
}

const requested = process.argv.slice(2).map(a => a.toUpperCase())
// No argument runs the WAVE; the sitting is reachable only by name, per SITTING.
const selected = requested.length > 0 ? requested : [...CASES]
const unknown = selected.filter(id => !KNOWN.includes(id as (typeof KNOWN)[number]))
if (unknown.length > 0) {
  console.error(`unknown case(s): ${unknown.join(', ')}. Known: ${KNOWN.join(', ')}`)
  process.exit(2)
}

// F1.852 — refuse to start when the app on the CDP port runs on a different
// config dir than the one every case will read (`configDirVerdict`,
// `lib/app-env.ts`). Every case inherits THIS process's environment, so one
// comparison here covers the wave. Exit 2 with nothing run, like an unknown id.
// Imported here rather than at the top so `--check` never reads a process.
const { configDirVerdict, readAppConfigDirs } = await import('./lib/app-env.ts')
const { resolvePort } = await import('./lib/connect.ts')
const configDirCheck = configDirVerdict(process.env.NESSY_CONFIG_DIR, readAppConfigDirs(resolvePort()))
console.error(configDirCheck.line)
if (configDirCheck.verdict === 'mismatch') process.exit(2)

const results: CaseResult[] = []
for (const id of selected) {
  results.push(await runOne(id))
}

console.log('\n================ WAVE SUMMARY ================')
for (const result of results) {
  const failed = result.checks.filter(c => !c.ok).length
  console.log(
    `${result.status.padEnd(7)} ${result.case.padEnd(6)} ${Math.round(result.durationMs / 1000)}s  ` +
      `${result.checks.length - failed}/${result.checks.length} checks${result.error ? ` — ${result.error}` : ''}`,
  )
}
console.log(`${RESULT_PREFIX}-WAVE ${JSON.stringify(results)}`)

const statuses = new Set<CaseStatus>(results.map(r => r.status))
process.exit(statuses.has('FAIL') ? 1 : statuses.size === 1 && statuses.has('PASS') ? 0 : 2)
