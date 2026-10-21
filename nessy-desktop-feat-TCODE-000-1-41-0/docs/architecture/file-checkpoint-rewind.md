# File checkpointing and rewind

Claude Code's contract is `agent-sdk/file-checkpointing.md`, with the result
shape in `agent-sdk/typescript.md`. Line numbers below are where each quotation
was found on 2026-07-29, in the raw `.md` fetched with `curl`.

Nessy's engine lives in `packages/shared/src/sessions/file-checkpoints.ts`. It is
driven from two dispatch sites, both of which create the checkpoint only after
the filesystem scope has canonicalised and authorised the target:

- Pi — `packages/pi-agent-server/src/index.ts`, `beforeDispatch` /
  `afterDispatch` on the tool executor, keyed by `descriptor.checkpointAdapter`;
- Nestor Cloud — `packages/shared/src/agent/backend/nestor-cloud/tool-executor.ts`.

Three surfaces report a rewind: the session menu
(`useSessionMenuActions.revertFileCheckpoint`), the conversation rewind
(`ChatDisplay.handleRewindConversation` over
`SessionManager.rewindToMessage({ restoreFiles: true })`), and the model itself,
through the `rewind_checkpoint` runtime request.

## Three producers, four runtimes — and what the surfaces used to say about it

**The producer list above is the WHOLE producer list**, and
`codex-runtime` joined it on 2026-09-12 (C3.67) — it was written as a runtime
with no producer and no upstream API to wire, and the second half of that was the
part to re-ask. The `anthropic` (Claude Code / `claude-runtime`) arm still has
none of ours. The consumers are runtime-agnostic: the session menu entry, the
message context menu's "Rewind and restore files", and `rewindToMessage` are
offered on every session regardless of what it runs on.

Nothing in between said so, and the failure was silent in the worst way an
absence can be. A runtime with no producer does not leave the manifest missing —
it leaves it EMPTY, which is byte-for-byte what a session whose agent has not
edited a file yet looks like. So `rewindToMessage({ restoreFiles: true })`
returned `success: true, restoredCheckpoints: 0`, and `ChatDisplay` drew a green
success reading "Restored 0 checkpoints; 0 failed" — a success toast for an
operation that could not have done anything, on a button whose label promises the
user their files back. Measured on `9696561b2` before the fix, through
`SessionManager.rewindToMessage` itself:
`{"success":true,"messageId":"u1","removedMessages":1,"restoredCheckpoints":0}`.

`RUNTIME_FILE_CHECKPOINT_PRODUCERS` (`file-checkpoints.ts`) is the inventory that
lets a caller tell the two apart:

| runtime | producer |
| :-- | :-- |
| `pi` | `packages/pi-agent-server/src/index.ts`, `beforeDispatch` |
| `nestor-cloud-agent` | `packages/shared/src/agent/backend/nestor-cloud/tool-executor.ts` |
| `anthropic` | none — the SDK has its own, unwired, into a store that is not ours (below) |
| `codex-runtime` | `packages/shared/src/agent/codex-agent.ts`, `checkpointCodexFileChange` — on codex's own pre-write `item/started` for a `fileChange` item (C3.67) |

### How the codex producer works, and the one thing it does not control

Codex applies patches inside its own process, so there is no `beforeDispatch` to
hang a snapshot on. What there is, is codex's own pre-write announcement:
`core/src/tools/handlers/apply_patch.rs` at `rust-v0.150.1` awaits
`emitter.begin(event_ctx)` before the orchestrator that applies the patch, and
`app-server-protocol/src/protocol/item_builders.rs`'s
`build_file_change_begin_item` turns that event into the `fileChange` item this
host receives as `item/started`, carrying every path. The producer snapshots
there and closes on `item/completed` with codex's own `PatchApplyStatus`.

The direction is codex's, not ours: its generated `ThreadRollbackParams` says
*"This only modifies the thread's history and does not revert local file changes
that have been made by the agent. Clients are responsible for reverting these
changes."*

**The residue, stated rather than hidden.** Codex does not wait for our snapshot
— the ordering above is inside codex's process and the read is in ours, so the
window is codex's remaining work against a pipe. It is measured rather than
assumed by
`packages/shared/src/agent/__tests__/codex-file-change-preimage-e2e.test.ts`,
which drives the shipped binary through a real patch and reads the file at the
instant the notification lands. A checkpoint that did lose the race records a
pre-image equal to its post-image, which `finalizeFileCheckpoint` reports as
`no-op` rather than as a restore that would do nothing.

**What is NOT covered on codex, and is not covered on Pi or claude either:** a
file changed by a shell command rather than by a patch. The renderer already says
so — `uncoveredRewindCategories` names the `bash` category from the transcript.

It is a `Record<AgentProvider, boolean>` per `runtime-vocabulary.ts`'s property —
a new runtime breaks the build here rather than inheriting a silent `true` —
and `runtimeProducesFileCheckpoints` answers `false` for a provider this build
does not know, because defaulting open re-creates the exact lie.

`rewindToMessage` and `revertFileCheckpoint` now carry
`fileCheckpointsTracked` and both renderer surfaces read it. **Three states, not
two:** `true`, `false`, and ABSENT, where absent means the runtime could not be
resolved (the resolver reads workspace config off disk and can throw). Only an
explicit `false` warns — a truthiness test would fire against every older server
and every failed config read, which is the same lie inverted. The rewind is never
aborted by that resolution failing.

The flag is about the runtime the session is on **now**, and that is deliberately
only half the answer for a switched session: its Pi-era checkpoints are still in
the manifest and really are restored, while its Claude-era edits were never
tracked. Both are true at once, so the surface reports the count AND the flag.

The single-checkpoint refusal got the same treatment for a smaller reason: an
empty manifest used to arrive as a bare "No file checkpoint found", which on Pi
means "edit something first" and on Claude means "this can never work". The flag
is set only when the manifest is genuinely empty — with checkpoints present the
refusal means "already reverted", and a tracking note there would be the wrong
explanation.

## The SDK's own checkpointing, and why wiring it is not a wiring job

`@anthropic-ai/claude-agent-sdk` (vendored `0.3.247` / `claudeCodeVersion 2.1.247` since P7.1, 2026-09-10; this line said `0.3.223`, then `0.3.233`) ships `Query.rewindFiles`,
`Options.enableFileCheckpointing` and `RewindFilesResult`, and the vendored
native CLI implements all of it (`replay-user-messages`, `rewind_files`,
`--rewind-files`, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`,
`No file checkpoint found for this message`, `File rewinding is not enabled` and
`skippedLinks` are all present in
`node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`). We call none
of it: `enableFileCheckpointing`, `rewindFiles` and `replay-user-messages` have
**zero call sites** outside a doc comment.

`agent-sdk/file-checkpointing.md#how-checkpointing-works` says what it restores:

> "When you rewind to a checkpoint, Claude Code deletes the files it created and
> restores the files it modified to their content at that point."

That is one sentence of overlap and several of divergence:

| | SDK `rewindFiles(userMessageId)` | ours |
| :-- | :-- | :-- |
| anchor | a user-message **UUID** the CLI emits | our message's **millisecond timestamp** |
| granularity | every tracked file, back to that message | one checkpoint owns one path; the walk is ours |
| single-file revert | **none** — no counterpart in either direction | `revertFileCheckpoint({ checkpointId })`, the session menu and `rewind_checkpoint` |
| store | inside the CLI's own session | `<sessionPath>/file_checkpoints/manifest.json` |
| session scope | "Checkpoints are tied to the session that created them" | plus this session's **fork children's** separate manifests |
| conversation | untouched | `rewindToMessage` truncates the transcript and drops the SDK anchors |
| preview | `dryRun` | none |
| result | `{canRewind, error?, filesChanged?, insertions?, deletions?, skippedLinks?}` | per-path outcome, plus `conflict` / `alreadyReverted` / `alreadyAbsent` |

Four consequences decide the scope, and none of them is a call site:

1. **Two stores that cannot see each other.** Everything downstream reads
   `listFileCheckpoints(sessionPath)` — the session menu, `rewind_checkpoint`,
   the fork-child walk, the checkpoint GC. An SDK-tracked Claude session is
   invisible to all of them, so a rewind would have to fan out to two engines and
   merge two incompatible result shapes.
2. **The anchor does not exist on our side, and the flag that supplies it is a
   STREAM-SHAPE CHANGE, not a flag (P3.47).** Nothing persists an SDK
   user-message UUID, and obtaining one costs
   `extraArgs: { 'replay-user-messages': null }`. The published contract, from
   `cli-reference.md#cli-flags` (anchor verified against the rendered page,
   2026-09-03) — the `--replay-user-messages` row, verbatim:

   > "Re-emit user messages from stdin back on stdout for acknowledgment.
   > Requires `--input-format stream-json` and `--output-format stream-json`"

   with the page's own example spelling out what that means in practice:
   `claude -p --input-format stream-json --output-format stream-json --verbose
   --replay-user-messages`. The binary's CLI help says the same thing in the
   older wording (*"only works with `--input-format=stream-json` and
   `--output-format=stream-json`"*), so page and artefact agree here.

   **Read the requirement as the cost it is.** It is not "pass a flag": it
   forces stream-json in BOTH directions and re-emits every user message on
   stdout, so adopting it changes the shape of the stream our event adapter
   reads and adds a class of inbound event the adapter must recognise and
   discard or attribute. Anyone costing this as a flag will under-estimate it by
   an order of magnitude — which is the whole reason this paragraph exists
   rather than a one-line "needs `replay-user-messages`".
   `#user-messages-don’t-have-uuids` (that curly apostrophe is in the published
   id — measured, not derived) confirms the dependency is only about
   ADDRESSING a restore point: *"**Cause**: The `replay-user-messages` option
   isn't set."* Checkpointing itself is switched on by `enableFileCheckpointing`
   alone. (Which answers the question the ledger asked be measured first: yes,
   `enableFileCheckpointing` takes effect without the extra arg — you simply have
   nothing to pass to `rewindFiles`.)
3. **`enableFileCheckpointing` is a construction option with no live setter**
   (`claudeLiveSessionSignature`'s list of what a running child can be told), and
   `#”file-rewinding-is-not-enabled”-error` — again the published id, curly
   quotes and all — requires it on the session performing the rewind too: *"The SDK sets the `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`
   environment variable internally only when … `enableFileCheckpointing`
   (TypeScript) is enabled on the session performing the rewind."* So it must be
   on from spawn, for every session, and the rewind path needs a live or resumed
   query — while our `rewindToMessage` currently clears `sdkSessionId` and
   `sdkSessionAnchors`, the very handle such a rewind would need.
4. **Codex has no such API at all.** Wiring the SDK closes one of the two lying
   runtimes; the other needs a different answer.

**Recorded as an open decision, not taken here:** whether to build that, or to
narrow the promise — gate the "Rewind and restore files" affordance and the
session-menu entry to runtimes that track. This change does neither; it makes
both surfaces tell the truth about what happened, which is correct under either
outcome.

## Link safety

> "Claude Code skips a tracked path that is a symlink, hard link, or other
> non-regular file." — `file-checkpointing.md:43`

`RewindFilesResult` "counts every skipped path in its `skippedLinks` field"
(`:43`), and `typescript.md:4266` gives the full taxonomy: "a symlink, hard link,
or other non-regular file at the tracked path, a parent directory that no longer
resolves to where it pointed when the checkpoint was taken, or a backup that
couldn't be read safely."

Before this layer existed, a rewind wrote the pre-image straight through a hard
link. The probe: check point a file, let the tool write it, hard-link it, rewind.
The alias went from `post-image` to `pre-image` and the API returned
`{success: true, restored: true}` — a corrupted inode reported as a successful
restore. No filesystem scope can catch that, because a hard link has no second
path to check.

Three guards, in order:

1. `lstat` on the tracked path — a symlink is seen as a link rather than as
   whatever it points at, and `nlink > 1` is the only signal a hard link gives.
   This runs BEFORE the digest comparison: a symlink whose target matches the
   post-image passes every content check there is.
2. The parent directory is re-resolved. `lstat` must report a real directory (so
   a parent swapped for a link fails even on a manifest written before this
   existed), and `realpath` must still land on the `parentRealPath` recorded at
   checkpoint time. A missing parent is a refusal — the old code called
   `mkdir(dirname(filePath), { recursive: true })` and restored into a directory
   the user had deleted.
3. The write itself opens with `O_WRONLY | O_CREAT | O_NOFOLLOW` and re-checks
   `nlink` on the open descriptor, which closes the window between the `lstat`
   and the write. The old `copyFile` had neither guard.

### Partial rewind, not whole-rewind refusal

**Decision: per-path skip; the rewind continues; the count and reasons reach the
user.** Reasoning:

- The page describes per-path skipping ("skips a tracked path", `:43`), and
  `skippedLinks` is a count — a shape that only makes sense if the rewind
  proceeds past the first skip.
- At the single-checkpoint level a skip IS whole-rewind refusal, because one
  checkpoint owns one path. `revertFileCheckpoint` returns `success: false` with
  `skippedLinks: 1`; reporting success would be the exact lie this unit exists to
  remove.
- At the multi-file level (`rewindToMessage`), aborting every remaining file
  because one path is hostile would let a single planted link block recovery
  entirely, and the loop is not transactional — earlier files are already
  restored by the time a later one is refused.
- A skip is not counted as a failure. `failedCheckpoints` excludes it and
  `skippedLinks` / `skippedPaths` carry it on their own axis, because "3 failed"
  sends the user looking for an error that did not happen.
- The checkpoint keeps its un-reverted state, so removing the link and rewinding
  again works.

## Row-by-row status

### Implemented

| Contract | Where | Status |
| :-- | :-- | :-- |
| `:9`/`:29`–`:31` Write, Edit and NotebookEdit are the tracked tools | `HARNESS_TOOL_DESCRIPTORS` marks `write`, `edit`, `notebook_edit` with `checkpointAdapter: 'file'` | `documented, implemented` — plus `format`, which also rewrites a file in place and would otherwise be an untracked mutation |
| `:23` a backup is taken before the tool modifies the file | `createFileCheckpoint` snapshots the pre-image to `<session>/file_checkpoints/files/<id>/`, mode 0600, before dispatch | `documented, implemented` |
| `:43` files the agent created are deleted, files it modified are restored | `revertFileCheckpoint`: `existed: false` → unlink, `existed: true` → write the pre-image back and restore the mode | `documented, implemented` |
| `:43` skip a symlink, hard link or other non-regular file at the tracked path | `inspectRewindTarget` + the `O_NOFOLLOW` write | `documented, implemented` |
| `:43` skip a file whose parent no longer resolves to its checkpoint-time location | `inspectRewindParent` against `entry.parentRealPath` | `documented, implemented` |
| `:43` skip a file whose backup can't be read safely | `readSnapshotBytes` — the snapshot must be a regular, singly-linked file | `documented, implemented` |
| `:43`/`typescript.md:4266` count every skipped path in `skippedLinks` | `FileCheckpointRevertResult.skippedLinks` and `ConversationRewindResult.skippedLinks`, summed across the walked checkpoints | `documented, implemented` — plus `skippedPaths`, because a bare count cannot tell the user which file or why |
| `:18`/`:729` Bash edits are not tracked | `bash` carries no `checkpointAdapter`; the coverage is derived from the descriptor table in `file-checkpoints.test.ts`, not hardcoded | `documented, implemented` |
| `:34` rewinding files does not rewind the conversation | `SessionManager.revertFileCheckpoint` touches no message; `rewindToMessage` is a separate command and its `restoreFiles` flag is opt-in | `documented, implemented` — Nessy additionally offers the conversation rewind Claude does not have |
| `:731` checkpoints are tied to the session that created them | the manifest lives at `<sessionPath>/file_checkpoints/manifest.json`; deleting the session reclaims it | `documented, implemented` |
| `:732` creating, moving or deleting directories is not undone | only file content and mode are restored, and a missing parent directory is now a refusal rather than a `mkdir -p` | `documented, implemented` |
| `:194`/`typescript.md:500` rewind to a user message | `rewindToMessage(messageId, { restoreFiles: true })` walks every unreverted checkpoint created after that message | `documented, implemented — anchored by the message timestamp, not by a user-message UUID` (see below) |
| `:353` multiple restore points | every checkpoint keeps its own id; `revertFileCheckpoint({ checkpointId })` targets any of them | `documented, implemented` |

### Divergences and gaps

**`:18`/`:730` Subagent edits aren't tracked or restored, "except a skill with
`context: fork` running in the foreground".**
`documented, implemented — by a different mechanism.` A Pi subagent runs as its
own managed session with its own `sessionPath`, so its edits are checkpointed
into the CHILD's manifest and a parent rewind never walks them — the observable
behaviour the row asks for. **The fork exception now holds too, and by a second
mechanism rather than by shared storage:** after walking its own checkpoints,
`rewindToMessage` calls `revertForkChildCheckpoints`
(`SessionManager.ts:13424`, called at `:13523`), which reverts the checkpoints
of this session's fork children specifically. A `context: fork` child's edits
are therefore undone by a parent rewind and a named subagent's are not — exactly
the documented split. Pinned by
`packages/server-core/src/sessions/fork-parent-scope.test.ts:125`, "restores a
fork child's file edit and leaves a named subagent's alone".

**`:194` the checkpoint id is the user message UUID.**
`documented, not implemented — a different identifier.` Our checkpoint id is a
content hash seeded from the tool call, not a message UUID, and there is no
`replay-user-messages` stream to carry one. `rewindToMessage` bridges the gap by
selecting checkpoints whose `createdAt` is strictly after the target message's
timestamp. The divergence is real at millisecond granularity: a checkpoint
created in the same millisecond as the target user message is not selected. In
practice a tool call never lands in the same millisecond as the message that
triggered it, but the ordering is by clock rather than by lineage.

**`:163`–`:164` `enableFileCheckpointing` and `extraArgs: {'replay-user-messages'}`.**
`documented, impossible on Pi — checkpointing is unconditional.` There is no SDK
option surface to enable; `beforeDispatch` checkpoints whenever the session has a
`sessionPath` and the descriptor declares an adapter. The equivalent of "not
enabled" is a session without a session path, which is the headless one-shot case.

**`:260`–`:266` the `--rewind-files` CLI flag and
`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`.**
`documented, impossible on Pi — no equivalent CLI entry point.` Our rewind is an
RPC command (`revertFileCheckpoint`, `rewindToMessage`) and a model-facing
runtime request (`rewind_checkpoint`), not a flag on a binary.

**`typescript.md:530`/`:4266` `rewindFiles(userMessageId, { dryRun: true })`
previews the change and never sets `skippedLinks`.**
`documented, not implemented — no revert dry run.` `sweepFileCheckpoints` has a
dry run, but that is the GC, not the rewind. A preview would want the same
inspection pass without the write — roughly half a day, and the honest version
must also decide whether a preview reports link skips at all, since Claude's
explicitly does not.

**`typescript.md:4259`–`:4261` `filesChanged`, `insertions`, `deletions`.**
`documented, not implemented — no diff accounting.` One checkpoint owns one path,
so `filePath` covers `filesChanged` for a single revert, but `rewindToMessage`
returns only counts and never the list of paths it restored. Line-level
`insertions`/`deletions` are not computed anywhere; both the pre-image and the
post-image digest are stored, so the diff is derivable but has never been asked
for by a surface.

**`typescript.md:4257` `canRewind`.**
`documented, implemented — under a different name and with more states.`
`success` is the boolean, and the refusals are distinguished:
`conflict` (the target changed after the tool ran), `alreadyReverted`,
`alreadyAbsent`, and now `skippedLinks`. The digest-conflict refusal has no
counterpart in Claude's documented shape — it is a Nessy addition, and it is why
the link check has to run first: a symlink or hard link would otherwise be
reported as a content conflict, sending the user to look for an edit that never
happened.

**`:733` remote or network files are not tracked.**
`documented, not implemented — no network-path detection.` A tracked path is
whatever the workspace filesystem scope admits, and nothing inspects the mount.
A workspace on a network mount is snapshotted and restored like any other. The
link-safety layer does reduce the blast radius — an SMB or NFS path that presents
as a symlink or a non-regular file is now refused — but that is a side effect,
not the row.
