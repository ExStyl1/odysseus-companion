# R27a — model-invocable delivery tools

**Status:** closed
**Parity row:** R27 (Ord 9), first of two slices — scheduling is R27b
**Branch:** `fix/renderer`
**Base:** `59250af2` (stale — executed on `7c7317d2`, which is where HEAD stood
when execution began; `ee2af780` at first read, advanced by two `docs(audit)`
commits mid-run)

## Contract source — quoted from raw markdown, with line cites

`curl -sL https://code.claude.com/docs/en/tools-reference.md` (465 lines).
**Fetch it yourself.** This series shipped a wire contract with three of four
field names wrong because a plan and then an executor each trusted a `WebFetch`
summary; that tool reconstructs "verbatim" text rather than returning it. Every
line I cite below must be re-read before you implement against it.

`:41` — `PushNotification`:

> Sends a desktop notification, and a phone push when Remote Control is
> connected, so a long-running task or scheduled task can reach you when you step
> away.

`:45` — `ReportFindings`:

> Reports code-review findings as a structured list, with a file, summary, and
> failure scenario per finding, so Claude Code can render them instead of
> printing them as text. Claude calls it when active code-review instructions
> tell it to. … a finding can also carry an optional `category` slug, such as
> `correctness` or `test-coverage`, shown next to the file location in the
> rendered list.

`:48` — `SendUserFile`:

> Sends files from the session to you with an optional caption, so a generated
> report, diagram, screenshot, or built artifact reaches your device instead of
> only being mentioned in the transcript. … the optional `display` input controls
> presentation: `render` opens the file inline in the client, `attach` shows a
> download card only, and when unset the client decides by file type.

**Where the doc says "not available on Bedrock / Vertex / Foundry", read why
before copying the limitation.** For `PushNotification` and `SendUserFile` the
stated reason is that *delivery runs through Anthropic-hosted infrastructure* —
i.e. the hop to a phone or a browser client. **We are a desktop app: the user's
device is the machine the session runs on.** The local half of both tools needs
no hosted infrastructure at all, and is the half worth building. Do not port the
provider gate; port the contract, and note in the close-out that the phone-push
half is inapplicable rather than missing.

## Verified state on HEAD

- None of `PushNotification`, `SendUserFile`, `ReportFindings` exist. 47 session
  tools in `packages/session-tools-core/src/tool-defs.ts`; none of these three.
- `apps/electron/src/main/notifications.ts:54` already exports
  `showNotification(title, body, workspaceId, sessionId)` with per-workspace /
  per-session routing and an isolated test
  (`__tests__/notifications-routing.isolated.ts`). `PushNotification` is a
  model-invocable wrapper over a surface that already works — do not build a
  second notification path.
- We ship `review` and `auditor` subagents, so `ReportFindings` has producers
  waiting for a contract.

## Tasks

### Task 1 — `ReportFindings`

The cheapest and the most immediately useful: it is entirely local, and our
review subagents already generate exactly this data as prose.

Per finding: a file, a summary, and a failure scenario, plus an optional
`category` slug rendered next to the file location. Read `:45` for the exact
field list and follow the documented names; where our renderer needs more, add
fields, never rename theirs.

The tool's job is to hand the host a structured list instead of text. State in
the commit body what renders it today — if the answer is "nothing yet, the data
lands in the transcript as structured output", say that plainly rather than
implying a UI exists.

**Commit:** `feat(tools): ReportFindings for structured review output`

### Task 2 — `PushNotification`

Wrap `showNotification`. The model calls it when a long task finishes and the
user has stepped away.

Two things that need deciding, not assuming, and stating in the commit body:
whether a notification fires when the session's window is already focused (a
notification for something the user is watching is noise), and what the
permission posture is — this reaches outside the sandbox to the OS, so it is not
obviously an always-allowed read-only tool. Pick a posture and justify it against
how our existing always-allowed set is drawn.

Rate-limit it. A model in a loop must not be able to produce an unbounded stream
of OS notifications; state the bound you chose.

**Commit:** `feat(tools): PushNotification for finished long-running work`

### Task 3 — `SendUserFile`

Files from the session reach the user with an optional caption, instead of only
being named in the transcript. `display: 'render' | 'attach'`, and **unset means
the client decides by file type** — implement the three-state input, not a
boolean.

Hard requirements, because this one moves file content to a surface:

- The path must be resolved and contained. A model-supplied path must not be
  able to send an arbitrary file from outside the session's own reachable scope;
  reuse the containment helper the repo already has rather than writing a second
  one, and name it in the commit body.
- Size bound, with a clear error rather than a hang or an OOM.
- A missing or unreadable file is a reported tool error, never silence.

**Commit:** `feat(tools): SendUserFile to deliver generated artifacts`

### Task 4 — close-out

Append per-task shas, real gate numbers, the Task 2 decisions (focus behaviour,
permission posture, rate limit), the Task 3 containment helper, and what renders
`ReportFindings` today.

**Commit:** `docs(plans): close R27a with gate evidence`

## Tests that must exist

- `ReportFindings` with and without `category`; a finding missing a required
  field is a tool error, not a silent drop.
- `PushNotification` respects its rate limit (the bound is exercised, not just
  configured).
- `SendUserFile` refuses a path outside the contained root, refuses an
  over-size file, reports a missing file, and carries all three `display`
  states — including unset, which must stay distinguishable from `attach`.

## Gate

Affected packages during the loop: `session-tools-core`, the agent tool-surface
suites, `apps/electron` main for the notification path, plus `typecheck:all`,
`lint`, `git diff --check`. Adding session tools changes the projected tool
surface, so the harness manifest/tool-surface fixtures will need updating —
**update the pin, never loosen the assertion**, and say in the close-out which
fixtures moved and why. A previous unit in this series hit a manifest error
caused by a descriptor with no `PI_TOOL_BINDINGS` entry; expect the same class of
failure and treat it as the test doing its job.

Tests from the REPO ROOT. Running a suite from a package directory bypasses the
config-dir isolation preload and will destroy the real
`~/.nessy-agent/config.json`; a guard fails the run, do not work around it.

## Out of scope

Session scheduling — `CronCreate`/`CronList`/`CronDelete` and `ScheduleWakeup` —
is **R27b**, and it is a bigger unit than it looks: exact vixie-cron semantics
including "when both day-of-month and day-of-week are constrained, a date matches
if either field matches", ID-derived deterministic jitter, seven-day expiry with
one final fire, no catch-up for missed fires, restore-on-resume for unexpired
tasks only, and a symlinked task file being a hard error. It also has a question
this plan will not prejudge: whether it rides our existing **Automations**
scheduler or stays separate. Our Automations are user-authored and durable;
these are model-invocable and session-scoped with a seven-day ceiling. They are
not the same thing, and merging them by reflex would be wrong.

`ScheduleWakeup` additionally presupposes `/loop`, which we do not have.

## Live cases for the planner (do not run these yourself)

1. A review subagent's findings render as a structured list rather than prose.
2. A long turn finishing while the window is unfocused produces one OS
   notification.
3. A generated SVG sent with `display: render` appears inline; the same file with
   `attach` shows a download card only.
4. A path outside the contained root is refused.

## Execution constraints

One commit per task with the subjects above; no `Co-Authored-By`; no push, MR or
tag; never `reset`/`rebase`/`amend`; pathspec-limited commits; no version bump or
release notes. Never `git checkout --` or `git stash` a file you are editing.
Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`.
You may edit this plan file.

Report any propagation of these gaps on other paths — do not fix it.

## Close-out

### Commits

| Task | Sha | Subject |
| --- | --- | --- |
| 1 | `6bcb52c4` | `feat(tools): ReportFindings for structured review output` |
| 2 | `ce0f85ee` | `feat(tools): PushNotification for finished long-running work` |
| 3 | `ae997953` | `feat(tools): SendUserFile to deliver generated artifacts` |
| 4 | this commit | `docs(plans): close R27a with gate evidence` |

### Contract cites — all three verified correct

`tools-reference.md` re-fetched raw (465 lines, matching the plan's count).
`:41` is `PushNotification`, `:45` is `ReportFindings`, `:48` is `SendUserFile`.
No cite was off. The quoted prose matches the raw lines; note that each row's
tail also carries a `{/* min-version */}` marker and a `Permission required`
column the plan's quotes elided, and all three rows read `No` there.

### The phone-push half is inapplicable, not missing

`:41` and `:48` both scope their provider exclusion to Anthropic-hosted delivery
— the hop to a phone or a remote browser client. The session runs on the user's
own machine here, so the local half of both tools needs no hosted infrastructure
and excludes no provider. The provider gate was not ported. What is absent is
the phone push and the Remote Control client, neither of which exists for us.

### Task 2 decisions

**Focus.** Nothing is shown while the window showing this session's workspace
has focus. Decided from the documented default, then confirmed verbatim against
the raw `env-vars.md:224`: `CLAUDE_CODE_DISABLE_NOTIFICATION_PRESENCE_CHECK`
sends the notification "even while you are typing in or focused on the terminal.
By default the tool skips both the desktop notification and the mobile push when
it detects recent keyboard activity or terminal focus." We implement the FOCUS
half of that presence check, per workspace window rather than `isAnyWindowFocused`.
NOT implemented, and named here rather than left implicit: the recent-keyboard-
activity half, the `CLAUDE_CLIENT_PRESENCE_FILE` screen-lock extension, and the
escape hatch that disables the local check.

**Permission posture.** `safeMode: 'block'`, and deliberately NOT added to
`ALWAYS_ALLOWED_TOOLS` in `mode-manager.ts`. That set is drawn by its own
comment as "read-only by nature" — Read/Glob/Grep/WebFetch/TodoWrite/SubmitPlan,
plus `read_mcp_resource`/`list_mcp_resources`/`read_skill_resource`, the last
admitted on the explicit argument that it is "strictly less powerful than
`Read`, which is itself always allowed". An OS notification is neither read-only
nor weaker than Read: it writes to a surface outside the sandbox and outside the
transcript, which is exactly why `send_agent_message` and `set_session_status`
are blocked in Explore mode. The doc's "Permission required: No" is about
Claude's DEFAULT mode — our `ask`/`auto`, where nothing here prompts either
(`shouldAllowToolInMode` returns allowed for those modes and the descriptor's
risk feeds only the capability catalog). Different axis, matched where it
applies.

**Rate limit.** At most 5 DELIVERED notifications per session per rolling
5-minute window. Past the bound the tool returns an error naming the bound and
the seconds until the next slot, and the host port is never reached. Suppressed
calls are not charged — a call the user never saw must not consume the quota.
The window rolls, so the cap is not a permanent per-session ceiling; both the
refusal and the roll are exercised in `push-notification.test.ts`, not merely
configured.

### Task 3 containment helper

`isPathWithinDirectory` from
`packages/session-tools-core/src/runtime/path-security.ts` — the same
symlink-aware helper `transform_data` and `script_sandbox` use. No second
containment helper was written. Roots are the host-supplied `workingDirectory`,
`sessionPath`, `dataPath` and `plansFolderPath`; containment is decided before
existence so a refusal leaks nothing; both the roots and the model's path are
reduced to their real path first so the helper's fast lexical stage compares one
spelling of each directory (that is input normalisation, not a second check, and
a link inside a root pointing out of it is still refused).

### What renders `ReportFindings` today

Nothing. The findings land on `structuredContent` of the tool result and ride
the ordinary `tool_result` event, whose `structuredContent` no renderer
component reads — a repository-wide search for `structuredContent` under
`apps/electron/src/renderer` returns no hits. The same is true of
`SendUserFile`: its delivery record is structured output, not a UI. These
commits ship the contract, the structure, the containment and the bounds; the
surface that draws them is not built here and is not claimed to be.

### Fixtures moved

`packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json`
— three new `sessionTools` rows (`session.report_findings`,
`session.push_notification`, `session.send_user_file`), their three
`schemaContracts` entries regenerated from the live
`getToolDefsAsJsonSchema` builder with the test's own canonical-JSON digest
rather than hand-written, and `PushNotification` appended to
`availabilityAudit.hostCallbackExcludedNames`.
`pi-harness-baseline.test.ts` — `expectedSemanticIds` grew by three, the
Pi-only set by one (`session.push_notification`), and the test title moved
47 -> 50. Every change adds a pin; no assertion was relaxed.

The `PI_TOOL_BINDINGS` failure the plan predicted did not fire, because the
three `sessionBinding` entries were added in the same commit as the descriptors.
Without them each new tool would have fallen through
`finalizePiExecutionManifest` to the dynamic-MCP arm and thrown
`Pi execution manifest MCP wireName must resolve exactly once`.

### Gate

Run from the repository root.

| Check | Result |
| --- | --- |
| `bun test packages/session-tools-core` | 195 pass / 0 fail (29 files) |
| `bun test packages/server-core` | 919 pass / 0 fail (131 files) |
| `bun test packages/shared/src/agent/pi-harness` | 227 pass / 0 fail (20 files) |
| `bun test packages/pi-agent-server` | 463 pass / 1 pre-existing fail |
| `bun test ./apps/electron/src/main/__tests__/notifications-routing.isolated.ts` | 4 pass / 0 fail |
| `bun run test` (whole repo + the `.isolated.ts` loop) | 9066 pass / 18 skip / 12 fail, 9096 tests across 842 files, 305s |
| `bun run typecheck:all` | clean |
| `bun run lint` | 0 errors (pre-existing warnings only, none in changed files) |
| `git diff --check` | clean |

All 12 repository-wide failures are pre-existing, proven against a clean
detached worktree at `7c7317d2` with none of this work applied:

- 9 in `packages/shared/src/config/__tests__/paths-default-root.test.ts` and
  `packages/shared/src/workspaces/__tests__/storage-readiness.test.ts`
  (`config path default-root classification`, `ensureStorageLayoutV2` ×7) — 9
  fail on the clean worktree too.
- 1 in `packages/shared/src/workspaces/__tests__/paths-env.isolated.ts`
  (`managed paths with NESSY_CONFIG_DIR`) — fails on the clean worktree too.
- 1 `Pi harness R0 baseline > executes golden foreground and background process
  contracts` (`isolationProfile` `networked` vs the pinned `workspace`) — fails
  on the clean worktree too.
- 1 `session file watcher isolation > creates independent watchers per client
  and cleans up on disconnect` — a load flake, not a regression: the file passes
  3/3 in isolation on BOTH this branch and the clean worktree.

None is in a session-tool, notification or harness-manifest path.

### Propagation found, not fixed

1. **The reviewer subagent cannot call `ReportFindings`.** `BUILTIN_AGENT_DEFINITIONS`
   in `packages/shared/src/agents/definitions.ts` gives `reviewer`
   `tools: ['read','grep','find','ls']`, and `resolveExplicitTools` honours an
   explicit list, so the producer this plan names has the contract available at
   the session level but not inside the subagent. The R20 precedent is
   `SUBAGENT_ALWAYS_AVAILABLE_TOOLS` in
   `packages/pi-agent-server/src/orchestrator/runtime-agent-definitions.ts`.
2. **An imported Claude agent naming these tools is rejected whole.**
   `PI_RUNTIME_AGENT_TOOL_ALIASES` has no entry for `reportfindings`,
   `pushnotification` or `senduserfile`, and `resolveExplicitTools` pushes an
   unknown name onto `unresolved` and THROWS — the documented `EnterWorktree` /
   `TodoWrite` failure mode. Permission rules are unaffected: `permissionName`
   is the documented spelling for all three.
3. **`isPathWithinDirectoryForCreation` mishandles a symlinked base.** In
   `packages/session-tools-core/src/runtime/path-security.ts` its existing-path
   arm calls `isPathWithinDirectory(resolvedTarget, realBase)`, whose own
   lexical pre-check then compares an un-realpathed target against a realpathed
   base — so a perfectly contained file is rejected whenever the base directory
   is reached through a symlink. `transform_data` depends on that arm for its
   output path. Found while writing the `SendUserFile` containment test.

### Deviations from the plan

- `ReportFindings` and `SendUserFile` are NOT `pi-only`: neither reaches a host
  port, so both are projected onto every backend, including Claude sessions and
  the session-mcp-server. Only `PushNotification` is `pi-only`, because its port
  is bound on the Pi path.
- Field names the doc does not publish are ours and are named as such:
  `failureScenario` (camelCase of the documented phrase), `message`/`title` on
  `PushNotification` (the doc names no inputs), and `paths` on `SendUserFile`
  (the doc says "files", plural). `file`, `summary`, `category`, `caption` and
  `display` are the doc's own spellings, unchanged.
- `SendUserFile` is atomic: one bad path fails the whole call, so a reported
  delivery set never differs from what was delivered.
