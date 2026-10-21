# UB7.8 result (PARTIAL — the live drives are the END-sitting's) — the `auto` write floor already exists on all three runtimes

Row: `UB7.8 `[modes]` `[measure]`` of `docs/superpowers/plans/2026-10-14-upstream-adoption-0-15-1.md`
(OQ-43.4 (c) trigger). Prepared 2026-10-15 by lane L-P57a. The row's instrument — one `auto`-mode write to
a path outside cwd/plans/data per runtime, on the packaged app, card or no card recorded — is the sitting
ASK; this file records the static floors read at HEAD and the decision they provisionally answer.

## The decision rule (the row's, applied to what follows)

"If a runtime lacks the floor, a new row borrows Guarded's always-prompt into `auto` for that runtime;
otherwise record the null." The null is RECORDED below for all three runtimes — the floor exists — pending
the sitting's live confirmation of each.

## Pi and Claude (the host gate)

- `auto`'s file-write auto-approval is BOUNDED: `shouldPromptInAutoMode` takes `autoAllowWriteRoots` —
  "the SAME roots acceptEdits uses (working directory, workspace root, plans/data folders, additional
  directories). Omitted means NO write auto-approval: the roots check fails closed, so a caller that
  cannot name the session's roots gets prompts, never silent approvals"
  (`packages/shared/src/agent/core/pre-tool-use.ts:3879-3889`).
- The caller supplies exactly that list on the `auto` branch only, via the ONE session-roots list
  (`sessionWriteRootOptions({ workingDirectory, workspaceRootPath, plansFolderPath, dataFolderPath,
  additionalDirectories })`, `pre-tool-use.ts:3043-3052`, F1.951).
- `shouldPromptInAutoMode` delegates the file-write prompt to `shouldPromptInAskMode` with
  `autoAllowFileWrites: true` bounded by those roots (`pre-tool-use.ts:3976-3991`: "with none,
  `isInsideAutoAllowRoots` fails closed and every write follows the normal prompt rules"). So an
  outside-cwd/plans/data write in `auto` is NOT card-free — it follows the normal prompt rules (a card),
  and a Bash command in the risky band goes to the classifier with a card when the judge cannot answer.
- Protected paths are never auto-approved outside bypass (`protectedPathOutcome`), and the
  `bypassPermissions` deny-net reuses the same band with the same roots (`pre-tool-use.ts:5806-5822`).
- **Claude's own docs agree** (the local corpus copy, `work/wjcritmm/permission-modes.md`, the page is a
  contract): "Reads and working-directory edits outside protected paths skip the classifier" (:517) —
  i.e. edits OUTSIDE the working directory do NOT skip it, they are classifier-reviewed; and acceptEdits'
  "auto-approval applies only to paths inside your working directory or `additionalDirectories`. Paths
  outside that scope … still prompt" (:228).

## Codex

- The sandbox model floors it structurally: writes outside the workspace/writable roots are SANDBOX
  ESCAPES, and escapes are routed for review — `packages/codex-protocol/schema/ClientRequest.json:82`:
  approvals "include sandbox escapes, blocked network access, MCP approval prompts … `auto_review` uses a
  carefully prompted subagent to gather relevant context and apply a risk-based decision framework before
  approving or denying the request".
- Our wiring feeds the session's own roots as codex's writable set already:
  `packages/shared/src/agent/codex-agent.ts:3695-3730` documents that the profile's
  `filesystem: { <abs path>: 'write' }` map (fed from `CodexConfigOptions.writablePaths`) is what wins
  over the legacy `writable_roots` table, with the three fail shapes closed (over-broad roots throw,
  deny-collisions drop the deny).
- Residue for the sitting: WHICH reviewer sees an outside-roots write (the `approvals_reviewer`
  config — `user` vs `auto_review`, generated `ApprovalsReviewer.ts`) is configuration, and the live
  card/no-card reading is the drive.

## Provisional decision (per the row's rule)

**The null is recorded: every runtime already floors outside-roots writes in `auto` — no new row borrows
Guarded's always-prompt.** The sitting's drives confirm it live (one write outside cwd/plans/data per
runtime must produce a card or a classifier review, never a silent run; the control — the same write
inside cwd in `auto` — must run card-free). If a drive contradicts the static reading, the borrow-row
spawns then, with the drive as its evidence.

## The sitting ASK (drive recipe, per the row)

Packaged build, `env -u` launcher, `auto` mode (bypass OFF — the card is the subject), dark. Per runtime
(Pi, Claude, codex): prompt the agent to write a one-line file to a scratch `$HOME` target outside
cwd/plans/data (e.g. `~/ub7-8-outside-probe.txt`), then the control write inside cwd. Record: card or no
card (and which card: the permission card vs the classifier notice), per runtime, with a screenshot. Name
the case ids in this file's closing update.
