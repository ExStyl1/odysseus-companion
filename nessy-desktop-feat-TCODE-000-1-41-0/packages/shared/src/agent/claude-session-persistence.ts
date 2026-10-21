import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { getNeverPersistSessions } from '../config/storage.ts';
import {
  isSkipPromptHistoryEnabled,
  type SkipPromptHistoryEnvRecord,
} from '../config/skip-prompt-history.ts';

/**
 * C3.282 — which of the vendored SDK's session-store verbs the host reads, and
 * the reason for each one it does not. A PRODUCT POSTURE, stated here rather
 * than decided quietly, because "native-first" and "the host store is the
 * browsing surface" pull in opposite directions and the answer is not obvious.
 *
 * ## What exists, measured
 *
 * The bundle exports seven verbs this repo imports nowhere: `listSessions`,
 * `getSessionInfo`, `getSessionMessages`, `deleteSession`, `renameSession`,
 * `tagSession`, `forkSession`. C3.74 drove the first four against a session this
 * build created (`__tests__/claude-session-store-browse-e2e.test.ts`): the list
 * returns exactly that id, `getSessionInfo` answers with a runtime-derived
 * summary, `getSessionMessages` returns the turn carrying the prompt, and an id
 * that was never created reads back `undefined` as the control. There is no
 * ARCHIVE verb and no SEARCH verb — asserted with the seven present ones as
 * positive controls.
 *
 * ## The decision, verb by verb
 *
 *  - **LIST — no, and this is the posture.** The host's own store is the
 *    browsing surface a user meets, and it is the better denominator for THIS
 *    product: it spans all three runtimes, carries the metadata the list is
 *    sorted and filtered by, and survives a runtime switch. Reading the vendor
 *    store into the same list would show one conversation twice, and — worse —
 *    would surface exactly the ids the host deliberately has no record of: a
 *    session the user asked not to keep still has a vendor transcript unless
 *    `persistSession: false` reached it, which is the residue THIS module
 *    exists to close.
 *  - **READ — the two verbs SPLIT, and C3.313 is why.** `getSessionMessages` is
 *    adopted: it is the runtime-switch rebuild's confirmation that the file we
 *    wrote is one the runtime will actually load
 *    ({@link confirmClaudeTranscriptThroughSdk}). `getSessionInfo` stays
 *    DECLINED, on its own measurement rather than on a preference — see that
 *    function's block for the reading where a transcript `getSessionMessages`
 *    read in full came back `undefined` from `getSessionInfo`, which is the
 *    fragility P3.269 named and the reason a summary reader cannot gate a
 *    resume.
 *  - **`deleteSession` — the one genuine gap, and C3.311 closes it.** Deleting a
 *    host session removed the host's record and left the vendor's
 *    `projects/<projectKey>/<sdkSessionId>.jsonl` behind under the workspace's
 *    `CLAUDE_CONFIG_DIR` — until the RETENTION sweep's age cutoff reached it
 *    (`sessions/retention-sweep.ts`, class `vendor-transcript`), which is up to
 *    `retentionDays` away and never at all when `sweepEnabled` is false. The
 *    native verb is the instrument rather than a host `rm`, for the reason this
 *    module already records against sweeping the same file by hand: the SDK owns
 *    that tree's layout. {@link deleteClaudeVendorSession} is the wiring and the
 *    block above it is the measurement.
 *  - **`renameSession` / `tagSession` — declined.** Both write vendor metadata
 *    that nothing in this product reads, and a write to a key nothing reads is
 *    the same shape `PiAgent.applyPermissionRequestUpdates` refuses by name.
 *  - **`forkSession` — declined.** Branching already has one mechanism and it is
 *    the runtime's own: `SessionManager` pins every new branch to
 *    `branchContextStrategy: 'sdk-fork'` and resumes the parent by
 *    `resumeSessionAt`. A second fork path would be two answers to one question.
 *
 * `__tests__/claude-session-store-verbs.test.ts` holds the denominator so this
 * list can be re-derived rather than re-counted, and fails if a verb starts
 * being imported without this paragraph moving.
 */
/**
 * C3.69 — never-persist reaches the CLAUDE child too.
 *
 * ## The defect
 *
 * "Never persist this session" was a host-side promise only. `SessionManager`
 * resolves one `ephemeral` flag from three inputs (an explicit caller option,
 * `isSkipPromptHistoryEnabled`, and `getNeverPersistSessions`) and every
 * `!ephemeral` gate on our side honours it — no session record, no transcript,
 * no pending-plan store, no checkpoint reporting. The claude child was never
 * told, so it went on writing the VENDOR's own transcript at
 * `<projectKey>/<sdkSessionId>.jsonl` under the per-workspace
 * `CLAUDE_CONFIG_DIR`. A user who asked for nothing on disk got a full
 * conversation on disk, under a path they have no reason to know about.
 *
 * ## Native-first, tier 1 — the runtime has its own switch and we passed it
 * ## nowhere
 *
 * `@anthropic-ai/claude-agent-sdk/sdk.d.ts` declares `Options.persistSession`
 * and says what it does, verbatim: *"When false, disables session persistence to
 * disk. Sessions will not be saved to ~/.claude/projects/ and cannot be resumed
 * later. Useful for ephemeral or automated workflows where session history is
 * not needed."* Probed at the vendored `0.3.247` / `2.1.247`: 2 occurrences in
 * `sdk.d.ts`, 5 in `sdk.mjs` and 17 in the native binary, against a fabricated
 * key at 0/0/0 as the negative control.
 *
 * The CLI half is documented too, and the pairing is why this repo already had
 * the env readers: `cli-reference.md`'s `--no-session-persistence` row —
 * *"Disable session persistence so sessions are not saved to disk and cannot be
 * resumed. Print mode only. The `CLAUDE_CODE_SKIP_PROMPT_HISTORY` environment
 * variable does the same in any mode"*.
 *
 * ## A HOST SWEEP IS EXPLICITLY NOT THE MECHANISM
 *
 * Deleting the vendor's jsonl after the fact fails the sentence twice over. It
 * satisfies "cannot be resumed" while failing "are not saved to disk" — the file
 * exists for the window in between, which is the same reasoning
 * `config/skip-prompt-history.ts` records for our own transcript. And it would
 * delete the input `agent/claude-transcript-rebuild.ts` reads to carry real
 * history across a runtime switch, for every OTHER session sharing that
 * `CLAUDE_CONFIG_DIR` tree.
 *
 * ## What this resolver deliberately does not do
 *
 * It never passes `persistSession: true`. The SDK's default is `true`, so the
 * "on" case is the absence of the key — the smallest honest wiring, and the one
 * that cannot fight a future contributor of the same option.
 *
 * ## C3.280 — the third input, which C3.69 named as a residue and this closes
 *
 * `SessionManager` resolves ONE `ephemeral` flag from three inputs
 * (`options?.ephemeral === true || isSkipPromptHistoryEnabled() || getNeverPersistSessions()`)
 * and only the last two were readable from here. The first — an explicit
 * `CreateSessionOptions.ephemeral` from a caller, which is how a background or
 * one-shot session is created — was invisible, so that session still left the
 * vendor transcript on disk while every host-side `!managed.ephemeral` gate
 * honoured it.
 *
 * It is NOT closed by giving `SessionConfig` an `ephemeral` field, and that is
 * the reason it stayed open: an ephemeral session deliberately writes no session
 * record, so a persisted field could not carry the fact for it. It is closed by
 * carrying the ALREADY-RESOLVED flag on `BackendConfig.sessionEphemeral`, a
 * runtime-only input read once at agent construction — the same shape
 * `managedToSession` uses to put `ephemeral` on the renderer's DTO without
 * persisting it.
 *
 * Direction, matching `SessionManager`'s own OR exactly: this input can only
 * turn persistence OFF. `false` and `undefined` are the same answer here, so a
 * caller who says nothing changes nothing, and no caller can turn the vendor
 * transcript back ON against the setting or the environment.
 *
 * ## The cost, stated because the user pays it
 *
 * *"cannot be resumed later"* is the vendor's own sentence and it binds the
 * RESPAWN path as well as a later reopen: `ClaudeAgent.ensureLiveSession`
 * rebuilds the child on a drifted construction option and resumes it by
 * `sdkSessionId`, which needs the file this switch prevents. That is the same
 * loss `getNeverPersistSessions`' own docblock already announces for resume,
 * rewind and search — measured rather than assumed, in
 * `__tests__/claude-persist-session-e2e.test.ts`, which drives the real binary
 * against a loopback Anthropic stub and reads the directory tree on both arms.
 */
export function resolveClaudeSessionPersistence(
  input: {
    /** Defaults to the stored setting; injectable so a test needs no config dir. */
    neverPersistSetting?: boolean;
    /** Defaults to the real environment, as every sibling reader does. */
    env?: SkipPromptHistoryEnvRecord;
    /**
     * C3.280 — the session's already-resolved `ephemeral`, from
     * `BackendConfig.sessionEphemeral`. One direction only: `true` turns the
     * vendor transcript off, and anything else defers to the two readers below.
     */
    sessionEphemeral?: boolean;
  } = {},
): Pick<Options, 'persistSession'> {
  if (input.sessionEphemeral === true) return { persistSession: false };
  const setting = input.neverPersistSetting ?? getNeverPersistSessions();
  if (setting === true) return { persistSession: false };
  if (isSkipPromptHistoryEnabled(input.env ?? process.env)) return { persistSession: false };
  return {};
}

/**
 * C3.311 — a deleted session's VENDOR transcript goes with it, through the
 * SDK's own `deleteSession` rather than a host `rm`.
 *
 * ## The gap, stated precisely
 *
 * `SessionManager.deleteSession` removes the host record, the pending plans, the
 * checkpoints and the crons, and left
 * `<CLAUDE_CONFIG_DIR>/projects/<projectKey>/<sdkSessionId>.jsonl` — the whole
 * conversation, plus its `<sdkSessionId>/` subagent sidecar — on disk. It was
 * not forever: `sessions/retention-sweep.ts`'s `vendor-transcript` class ages
 * that tree out under the user's own `retentionDays`. But that is up to
 * `retentionDays` later, and `sweepEnabled: false` (`config/storage.ts`,
 * "explicit false = never sweep, whatever the window says") makes it never. A
 * user who deletes a conversation means now.
 *
 * ## Native-first, and what the measurement cost
 *
 * The SDK's own verb, not a host unlink — the reason C3.69's block above already
 * records against sweeping this file by hand: the SDK owns the tree's layout.
 * Its own doc sentence is the contract we hold it to: *"Without `sessionStore`:
 * removes `{sessionId}.jsonl` and the `{sessionId}/` subagent-transcript
 * subdirectory from the local projects dir. Throws if the session is not
 * found."*
 *
 * Driven 2026-09-12 against the vendored `0.3.247` / `2.1.247`, in a HOST
 * process (no child, no binary — the verb is filesystem work), seven arms:
 *
 *  1. transcript **and** its subagent sidecar removed under the named config dir;
 *  2. CONTROL — a byte-identical transcript with the SAME id and project key
 *     under a DIFFERENT workspace's config dir survives, so the scoping below is
 *     load-bearing rather than decorative;
 *  3. an id that was never created **throws**
 *     `Session <id> not found in any project directory`;
 *  4. a non-UUID id throws `Invalid sessionId: <id>` — a different message, and
 *     the reason the two are classified apart here;
 *  5. the memo re-keys: the same process deleted under config dir A and then
 *     under config dir B, which is the fact that makes host-side wiring possible
 *     at all (see below);
 *  6. a ZERO-BYTE transcript is NOT removed by the vendor's verb and reports
 *     "not found" — the SDK's own `size > 0` precondition, the same one
 *     {@link import('./claude-transcript-rebuild.ts').claudeTranscriptIsLoadable}
 *     records for the loader (`if(m.size>0)return{filePath:f,…}` in the vendored
 *     `sdk.mjs` at `0.3.247`). Recorded as a residue by C3.311 and CLOSED by
 *     C3.333 — see {@link unlinkEmptyVendorTranscript};
 *  7. with no `dir` at all the verb still finds and removes it, searching every
 *     project directory under that config dir.
 *
 * ## The awkward part, written down rather than hidden
 *
 * The verb takes a PROJECT directory (`dir`) but no config directory: its
 * projects ROOT comes from `process.env.CLAUDE_CONFIG_DIR`, read through a
 * memoized accessor in the bundle — `var Gt = memoize(() => (Ch() ??
 * join(homedir(),".claude")).normalize("NFC"), Ch)` with
 * `function Ch(){return process.env.CLAUDE_CONFIG_DIR}` as the RESOLVER, so the
 * cache is keyed by the current value and a changed value re-evaluates (arm 5).
 * This host never sets that variable for itself — it is composed per Workspace
 * into the CHILD's environment (`agent/options.ts`,
 * `workspaceClaudeConfigDir`) — so the only way to aim the verb is to set it
 * around the call.
 *
 * That is a process-global for the duration of a few filesystem operations, and
 * two host readers of the same variable exist
 * (`agent/claude-shell-command-settings.ts` and
 * `agent/memory/instruction-excludes.ts`, both resolving a settings location).
 * So: the calls are SERIALIZED through one queue, the variable is restored in a
 * `finally` to exactly the state it was in (absent stays absent), and the
 * assignment follows the delete-then-assign discipline AGENTS.md records for
 * Bun's env slots. The alternative — deriving the path ourselves and unlinking —
 * is the one C3.282 decided against by name: read the store, do not rebuild it.
 *
 * ## What it deliberately does not do
 *
 * No `dir` is passed. The search is already bounded by the per-Workspace config
 * dir, the id is a UUID, and omitting it means the delete still lands when the
 * session's spawn cwd has moved since the transcript was written — which
 * `resolveClaudeTranscriptCwd`'s candidate list exists precisely because it can.
 *
 * It does not derive the transcript PATH and unlink it — *"read the store, do
 * not rebuild it"* — **with exactly one exception, which C3.333 argued rather
 * than assumed: the ZERO-BYTE file, where there is no reading to prefer.** The
 * store's own finder skips a file of size 0, so the vendor cannot name it, and
 * "prefer the store's answer" has nothing to prefer. {@link unlinkEmptyVendorTranscript}
 * is that exception and stays inside it: it runs only after the verb reported
 * not-found, it looks only for the one file name the id spells, and it unlinks
 * only when the size is still 0 when read.
 *
 * It removes ONE transcript: the claude anchor the session holds now
 * (`sessions/runtime-anchors.ts`, `readRuntimeAnchor(…, 'anthropic')`). A
 * session that lost and re-minted a claude anchor has an earlier transcript
 * nothing records, and that one stays for the retention sweep.
 *
 * It NEVER throws at the caller. Session deletion is a durable, partially
 * ordered operation with a rollback arm, and a vendor-side cleanup failure must
 * not cost the user the deletion they asked for; the outcome is returned so the
 * call site can log it.
 */
export type ClaudeVendorSessionDeleteOutcome =
  /**
   * The transcript was removed — by the vendor's own verb (with its sidecar, if
   * any), or, when that verb could not see it, by C3.333's zero-byte sweep.
   */
  | 'deleted'
  /** Nothing was there: neither the vendor's verb nor the zero-byte sweep found a file. */
  | 'absent'
  /** Nothing was attempted: no claude anchor, no config dir, or a non-UUID id. */
  | 'skipped'
  /** The verb threw something that is neither of the above. */
  | 'failed';

/** The two message shapes arms 3 and 4 measured, kept together so a vendor reword is one edit. */
const VENDOR_SESSION_NOT_FOUND = /not found in (any project directory|project directory for )/;
const VENDOR_INVALID_SESSION_ID = /^Invalid sessionId:/;

/**
 * One queue for every call into the vendor store, because the aiming mechanism
 * is a process-global and two calls must not read each other's value.
 * Rejections are swallowed into the chain, never into the caller's promise.
 */
let vendorStoreQueue: Promise<void> = Promise.resolve();

/** Run `task` after every vendor-store call queued before it. */
function serializeVendorStoreCall<T>(task: () => Promise<T>): Promise<T> {
  const next = vendorStoreQueue.then(task, task);
  vendorStoreQueue = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * C3.333 — remove a vendor transcript the vendor's own remover is structurally
 * unable to see: one of size 0.
 *
 * The bundle's session finder is `if(m.size>0)return{filePath:f,projectPath:p,
 * fileSize:m.size}` (vendored `sdk.mjs`, `0.3.247`), so a zero-byte
 * `<sdkSessionId>.jsonl` reads as *not found* and `deleteSession` throws the
 * same message it throws for an id that never existed. C3.311 measured that and
 * left the file, reasoning that it carries no conversation and the retention
 * sweep collects it. Both halves are true and neither is the whole answer: the
 * sweep is up to `retentionDays` away and never runs at all with
 * `sweepEnabled: false`, and a file the user's own delete did not delete is an
 * unexplained leftover whichever way it is argued.
 *
 * Deliberately the NARROWEST thing that closes it, because this module's
 * standing rule is *read the store, do not rebuild it*:
 *
 *  - it runs ONLY after the verb reported not-found, so the ordinary path is
 *    byte-identical and costs not one extra syscall;
 *  - it looks only for the exact file name the id spells, under
 *    `<configDir>/projects/<each project dir>/`, which is the same tree and the
 *    same bound the verb itself searches with no `dir`;
 *  - it unlinks only when the size is STILL 0 at the moment it is read. A file
 *    with content is left untouched even here, because then the vendor's
 *    not-found is about something this sweep has no view of and the store's
 *    answer is the one to keep;
 *  - it never throws. A cleanup that fails must not cost the user the deletion
 *    they asked for, which is this whole function's contract;
 *  - it removes the file and NOT a sidecar directory beside it. A sidecar
 *    belongs to turns, and a transcript of size 0 has had none; inventing a
 *    directory removal for a case never observed would be building past the
 *    evidence.
 *
 * Returns whether anything was actually unlinked, so the caller can report
 * `'deleted'` rather than `'absent'` — the outcome has to mean what it says or
 * the next reader meets the same puzzle from the other side.
 */
async function unlinkEmptyVendorTranscript(
  configDir: string,
  sdkSessionId: string,
  debug?: (message: string) => void,
): Promise<boolean> {
  // The id becomes a path segment here, where everywhere else it is only handed
  // to the SDK. The verb has already accepted it as well-formed on this arm, so
  // this is a floor rather than a check that is expected to fire.
  if (sdkSessionId.includes('/') || sdkSessionId.includes('\\') || sdkSessionId === '.' || sdkSessionId === '..') {
    return false;
  }
  const { readdir, stat, unlink } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const projectsRoot = join(configDir, 'projects');
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(projectsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    // No projects root at all: there is nothing this sweep could be about.
    return false;
  }
  let removed = false;
  for (const projectDir of projectDirs) {
    const filePath = join(projectsRoot, projectDir, `${sdkSessionId}.jsonl`);
    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size > 0) continue;
      await unlink(filePath);
      removed = true;
      debug?.(`[claude-vendor-delete] removed the zero-byte vendor transcript at ${filePath}`);
    } catch {
      // Absent (the ordinary case, for every project dir but one) or unreadable.
      // Neither is a reason to fail a session deletion.
    }
  }
  return removed;
}

/** @see {@link deleteClaudeVendorSession} — the whole reason this exists is documented there. */
async function withClaudeConfigDir<T>(configDir: string, run: () => Promise<T>): Promise<T> {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_CONFIG_DIR');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  // Delete before assigning: AGENTS.md's Bun env-slot trap. Unconditional rather
  // than gated on a list of affected names, which cannot be complete.
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return await run();
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    if (had && previous !== undefined) process.env.CLAUDE_CONFIG_DIR = previous;
  }
}

/**
 * Remove the claude runtime's own transcript for a session the host is deleting.
 *
 * Safe to call for every session on every runtime: with no claude anchor or no
 * workspace config dir it answers `'skipped'` without touching anything.
 */
export function deleteClaudeVendorSession(input: {
  /** The session's CLAUDE anchor — `readRuntimeAnchor(session.sdkSessionAnchors, 'anthropic')`. */
  sdkSessionId: string | null | undefined;
  /** The per-Workspace `CLAUDE_CONFIG_DIR` — `workspaceClaudeConfigDir(workspaceId)`. */
  configDir: string | null | undefined;
  /** Where the outcome announces itself. Optional, as every sibling resolver's is. */
  debug?: (message: string) => void;
}): Promise<ClaudeVendorSessionDeleteOutcome> {
  const { sdkSessionId, configDir, debug } = input;
  if (!sdkSessionId || !configDir) return Promise.resolve('skipped');

  const run = async (): Promise<ClaudeVendorSessionDeleteOutcome> => {
    try {
      const { deleteSession } = await import('@anthropic-ai/claude-agent-sdk');
      await withClaudeConfigDir(configDir, () => deleteSession(sdkSessionId));
      debug?.(`[claude-vendor-delete] removed the vendor transcript for ${sdkSessionId}`);
      return 'deleted';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (VENDOR_INVALID_SESSION_ID.test(message)) {
        debug?.(`[claude-vendor-delete] ${sdkSessionId} is not a session id the SDK accepts; nothing removed`);
        return 'skipped';
      }
      if (VENDOR_SESSION_NOT_FOUND.test(message)) {
        // C3.333 — "not found" has TWO causes and only one of them is an
        // absence: the vendor's finder skips a file of size 0, so this same
        // message is what a zero-byte transcript produces. Ask that question
        // before reporting nothing was there.
        if (await unlinkEmptyVendorTranscript(configDir, sdkSessionId, debug)) return 'deleted';
        debug?.(`[claude-vendor-delete] no vendor transcript for ${sdkSessionId} under ${configDir}`);
        return 'absent';
      }
      debug?.(`[claude-vendor-delete] failed to remove the vendor transcript for ${sdkSessionId}: ${message}`);
      return 'failed';
    }
  };

  return serializeVendorStoreCall(run);
}

/**
 * C3.332 — retire the vendor transcript a session's PREVIOUS claude anchor
 * named, at the moment a new one replaces it.
 *
 * ## The residue this closes
 *
 * `RuntimeAnchorMap` has ONE slot per provider (`sessions/runtime-anchors.ts`),
 * so the moment a session's claude anchor is rewritten the earlier
 * `projects/<projectKey>/<sdkSessionId>.jsonl` becomes unreachable from
 * everything the host holds: {@link deleteClaudeVendorSession} removes the
 * anchor a session carries NOW and cannot name the one it carried before. Until
 * this, that file waited for the retention sweep's `vendor-transcript` class —
 * up to `retentionDays` away, and never at all with `sweepEnabled: false`.
 *
 * ## The posture, STATED rather than decided quietly
 *
 * **A supersession is retired; a CLEAR is not, and that difference is the whole
 * safety property.**
 *
 *  - **Supersession** — a new claude id replaces an old one for the same
 *    session. Nothing is lost with the file: the runtime-switch rebuild writes
 *    the whole projected history into the NEW transcript, so the old one is a
 *    stale duplicate of a conversation the host still holds in its own store.
 *  - **A CLEAR is not a supersession, and it stays with the sweep.** A rewind
 *    (`sdkSessionAnchors = undefined`), a resume recovery and a fork
 *    invalidation all drop the anchor with nothing replacing it, so the vendor
 *    file can be the last remaining copy of what was dropped. Removing it on
 *    those paths is a decision about the user's data and a wider one than this
 *    row — so it is written down here rather than taken. The guard below makes
 *    the rule mechanical instead of incidental: no next id, no retirement.
 *
 * Two refusals inside the supersession case itself:
 *
 *  - it NEVER retires the id it is about to write. `previous === next` is the
 *    ordinary shape of a resumed session reporting its own id back, and the live
 *    transcript is the one file that must survive.
 *  - **whether the previous id belongs to THIS session is the caller's to know,
 *    and it must be checked rather than assumed.** The dangerous shape is a
 *    BRANCH FORK: a child session resuming its parent's claude id would retire
 *    the parent's transcript while the parent is still alive. This function
 *    cannot see that relationship — it is handed two strings — so a call site
 *    beside a fork anchor must refuse the retirement when the previous id is
 *    that anchor, explicitly and in its own code, not on the strength of a
 *    sentence written here about a module this one cannot read.
 *
 * Never throws, for {@link deleteClaudeVendorSession}'s reason: whatever the
 * caller was doing matters more than this cleanup, and the outcome is returned
 * so it can be logged.
 */
export function retireSupersededClaudeVendorSession(input: {
  /** The claude anchor the session held BEFORE the write — read it before `writeRuntimeAnchor`. */
  previousSdkSessionId: string | null | undefined;
  /** The claude anchor being written. Absent means a CLEAR, which is not a supersession. */
  nextSdkSessionId: string | null | undefined;
  /** The per-Workspace `CLAUDE_CONFIG_DIR` — `workspaceClaudeConfigDir(workspaceId)`. */
  configDir: string | null | undefined;
  /** Where the outcome announces itself. */
  debug?: (message: string) => void;
}): Promise<ClaudeVendorSessionDeleteOutcome> {
  const { previousSdkSessionId, nextSdkSessionId, configDir, debug } = input;
  if (!previousSdkSessionId || !configDir) return Promise.resolve('skipped');
  // A clear, not a supersession. See the posture above — this is the guard that
  // keeps a rewind's discarded thread on disk for the sweep to decide about.
  if (!nextSdkSessionId) return Promise.resolve('skipped');
  if (previousSdkSessionId === nextSdkSessionId) return Promise.resolve('skipped');
  debug?.(
    `[claude-vendor-delete] retiring the superseded claude anchor ${previousSdkSessionId} `
    + `(replaced by ${nextSdkSessionId})`,
  );
  return deleteClaudeVendorSession({ sdkSessionId: previousSdkSessionId, configDir, debug });
}

/**
 * C3.313 — the runtime-switch rebuild asks the RUNTIME'S OWN reader whether the
 * transcript it just wrote is one the runtime will load.
 *
 * ## What this is not, and the refutation it had to clear first
 *
 * It does not replace `verifyClaudeTranscript`
 * (`agent/claude-transcript-rebuild.ts`). That verifier answers *"is the file we
 * wrote well-formed"* — exact record count, a usable uuid per record, and the
 * PARENT CHAIN read back off the file. None of the three is expressible through
 * the SDK: `SessionMessage` carries `uuid`, `type`, `session_id`, `message` and
 * `parent_tool_use_id`, and NO `parentUuid`. Measured on a deliberately
 * corrupted two-line transcript (one non-JSON line, one record with an unusable
 * uuid): `getSessionMessages` returned **one** message rather than throwing, so
 * the SDK reader is lenient where our verifier is strict, and swapping one for
 * the other would have DELETED a check.
 *
 * It answers the different question our own verifier structurally cannot: *"can
 * the runtime FIND and parse this file."* That is the failure
 * `claude-transcript-rebuild.ts`'s header is arranged against — a file at a path
 * the SDK never opens is a silent empty resume, and it looks exactly like a
 * working feature.
 *
 * ## P3.269 refused this switch on two grounds. One is measured false today, the
 * ## other stands and is why `getSessionInfo` is still declined
 *
 * P3.269 wrote: *"The three SDK readers resolve their root from
 * `process.env.CLAUDE_CONFIG_DIR` at call time … Calling them from the host means
 * mutating a process-global for the duration of the call — a race across
 * concurrent workspaces in the headless server."* True, and no longer a reason
 * to decline: C3.311 measured the bundle's accessor RE-KEYING on the env value
 * and built the discipline this function reuses — one queue for every
 * vendor-store call, restore in a `finally`, absent stays absent. The race was
 * the obstacle; it has an answer.
 *
 * Its other ground stands, and it is about the WRONG VERB. `getSessionInfo`
 * *"Returns undefined if the session file is not found, is a sidechain session,
 * or has no extractable summary"* — so a loadable transcript with nothing a
 * summariser can use reads as ABSENT. That is not hypothetical: driven
 * 2026-09-12 against the vendored `0.3.247`, a rebuilt transcript whose records
 * carried no prompt text was read back by `getSessionMessages` in FULL — eight
 * of eight, uuids identical and in order — while `getSessionInfo` answered
 * `undefined` for the same file in the same process. A summary reader cannot
 * gate a resume. `getSessionMessages` is the verb this row adopts, and the only
 * one.
 *
 * ## The agreement, measured 2026-09-12 (vendored `0.3.247` / `2.1.247`)
 *
 * A transcript written by `writeClaudeTranscript` from a five-entry projected
 * history (messages plus a tool call), read back through `getSessionMessages`:
 * **six records written, six read, the uuid sequence IDENTICAL in order**, the
 * types in the same order, the first prompt recoverable from the payload, and
 * `session_id` equal to the minted id on every record. `includeSystemMessages`
 * and an explicit `dir` changed nothing. So the comparison below is exact rather
 * than approximate, which is what makes a veto safe.
 *
 * The two NEGATIVE readings the veto rests on, from the same run: an id that was
 * never written and a config dir with no such tree BOTH come back as an EMPTY
 * ARRAY — never a throw, never `undefined`. `length === 0` is therefore the
 * whole "the runtime cannot see it" signal.
 *
 * ## What it may do about it, kept deliberately narrow
 *
 * Only `'unreadable'` — nothing at all came back — is meant to cost the native
 * carry. A disagreement in COUNT or ORDER is reported as `'partial'` and is NOT
 * a veto: a partially-read native transcript still puts real turns back on the
 * wire, and the alternative is the host's text carry, which is itself lossy by
 * construction (24 rows × 1200 characters). A THROW is `'no-verdict'` and never
 * a veto — an instrument that failed is not evidence about the file.
 *
 * The caller owns the consequence; this function never deletes and never writes.
 * A transcript the caller vetoes is left on disk deliberately: it is unreferenced
 * (no anchor was written), the retention sweep's `vendor-transcript` class
 * collects it, and it is the only artefact from which a wrong veto could later be
 * diagnosed.
 */
export type ClaudeTranscriptSdkConfirmation =
  /** Every record we wrote came back, in order. */
  | { verdict: 'agreed'; read: number }
  /** Something came back, but not what we wrote. Reported, never a veto. */
  | { verdict: 'partial'; read: number }
  /** The runtime's own reader sees nothing at this id. The one vetoable verdict. */
  | { verdict: 'unreadable'; read: 0 }
  /** The reader itself failed, or there was nothing to ask about. Never a veto. */
  | { verdict: 'no-verdict'; reason: string };

/**
 * Ask the runtime's own reader what it can see at `sdkSessionId`.
 *
 * `expectedUuids` is the record uuid sequence `writeClaudeTranscript` just
 * persisted — compared in ORDER, because the measurement above shows the reader
 * preserves it and an order change is a format divergence worth hearing about.
 */
export function confirmClaudeTranscriptThroughSdk(input: {
  /** The per-Workspace `CLAUDE_CONFIG_DIR` — `workspaceClaudeConfigDir(workspaceId)`. */
  configDir: string | null | undefined;
  /** The id the transcript was written under. */
  sdkSessionId: string | null | undefined;
  /** `records.map(record => record.uuid)`, in the order they were written. */
  expectedUuids: readonly string[];
  /** Where the verdict announces itself. Optional, as every sibling resolver's is. */
  debug?: (message: string) => void;
}): Promise<ClaudeTranscriptSdkConfirmation> {
  const { configDir, sdkSessionId, expectedUuids, debug } = input;
  if (!configDir || !sdkSessionId || expectedUuids.length === 0) {
    return Promise.resolve({ verdict: 'no-verdict', reason: 'nothing to confirm' });
  }

  return serializeVendorStoreCall(async (): Promise<ClaudeTranscriptSdkConfirmation> => {
    let read: Array<{ uuid: string }>;
    try {
      const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
      read = await withClaudeConfigDir(configDir, () => getSessionMessages(sdkSessionId));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      debug?.(`[claude-transcript-confirm] the runtime's own reader failed for ${sdkSessionId}: ${reason}`);
      return { verdict: 'no-verdict', reason };
    }

    if (read.length === 0) {
      debug?.(`[claude-transcript-confirm] the runtime's own reader sees no records at ${sdkSessionId}`);
      return { verdict: 'unreadable', read: 0 };
    }
    const agreed = read.length === expectedUuids.length
      && read.every((message, index) => message.uuid === expectedUuids[index]);
    if (!agreed) {
      debug?.(
        `[claude-transcript-confirm] the runtime's own reader returned ${read.length} record(s) at `
        + `${sdkSessionId}, not the ${expectedUuids.length} written (or not in that order)`,
      );
      return { verdict: 'partial', read: read.length };
    }
    return { verdict: 'agreed', read: read.length };
  });
}
