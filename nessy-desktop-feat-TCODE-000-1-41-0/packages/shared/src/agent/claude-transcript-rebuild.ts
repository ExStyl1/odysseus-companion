/**
 * Rebuild the Claude Agent SDK's own on-disk session transcript, so a switch
 * INTO Claude hands over the conversation instead of a summary of it.
 *
 * T2 of `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`.
 *
 * **Why this is possible at all.** `buildClaudeSubprocessEnv` points the SDK
 * subprocess at a per-Workspace `CLAUDE_CONFIG_DIR` (`options.ts`,
 * `workspaceClaudeConfigDir`), so the transcripts the SDK resumes from are
 * files we already own the directory of:
 * `<workspaceRoot>/claude-config/projects/<projectKey>/<sdkSessionId>.jsonl`.
 * Writing one and handing the SDK its id through `resume` is not a trick — it
 * is the last step of the SDK's own store-backed resume path, which
 * materializes exactly one such file (mode 0600, one `JSON.stringify` per line)
 * and then resumes from it.
 *
 * **Everything below was read off the shipped bundle, not off the typings.**
 * `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` at 0.3.223 (the pin U1
 * moved to; the minified names remangled from the 0.3.218 read the plan
 * recorded, so they are quoted here by BODY rather than by name):
 *
 * - the djb2-style hash: `function hE(e){let t=0;for(let r=0;r<e.length;r++)t=(t<<5)-t+e.charCodeAt(r)|0;return t}`
 * - its base-36 wrapper: `function ewe(e){return Math.abs(hE(e)).toString(36)}`
 * - the length ceiling: `var Jo=200`
 * - the sanitizer: `function Yo(e){let t=e.replace(/[^a-zA-Z0-9]/g,"-");if(t.length<=Jo)return t;return`${t.slice(0,Jo)}-${ewe(e)}`}`
 * - the projects root: `function Gr(){return mc(Qt(),"projects")}` (`mc` = `path.join`,
 *   `Qt` = memoized `(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(),".claude")).normalize("NFC")`)
 * - the project dir: `function fF(e){return mc(Gr(),Yo(e))}`
 * - the cwd normalizer: `async function Xo(e){try{return vr(await VEe(e))}catch{return vr(e)}}`
 *   where `VEe` = `fs/promises.realpath` and
 *   `function vr(e){return process.platform==="darwin"?e.normalize("NFC"):e}`
 *
 * The platform gate on the NFC normalize is load-bearing and easy to miss:
 * normalizing unconditionally diverges from the SDK on Windows for a non-ASCII
 * cwd, which would put our file in a directory the SDK never opens.
 *
 * **Verified against reality rather than derived and hoped for.** Running this
 * module's `claudeProjectKeyForCwd` over the `cwd` recorded inside each of the
 * 200 transcripts our own runtime wrote under
 * `~/.nessy-agent/workspaces/*&#47;claude-config/projects/` reproduces the directory
 * each of them actually sits in — **200 of 200**, 0 mismatches.
 *
 * **Pure and I/O-light on purpose.** The record builder touches nothing; the
 * two path helpers touch the filesystem only through `realpathSync` (the SDK
 * does the same, and falls back the same way when the path does not exist).
 * The caller owns loading the transcript and owns the projection — see
 * `buildRuntimeHandoffHistory` in `packages/server-core/src/sessions/runtime-handoff.ts`,
 * whose OUTPUT is this module's input.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { getSessionDirPath } from '../sessions/storage.ts';
import { isExistingDirectory } from './spawn-helpers.ts';
import type { RuntimeHandoffHistoryItem } from './backend/types.ts';

// ============================================================
// The cwd — the single most likely way this ships broken
// ============================================================

/**
 * The directory the Claude SDK subprocess will be spawned in, and therefore the
 * one its transcript's project key is derived from.
 *
 * **This IS the body of `ClaudeAgent.resolveSpawnCwd`**, extracted so there is
 * one implementation and two callers: the agent at spawn time, and
 * `SessionManager` at the switch, where the rebuild has to know the answer
 * before an agent exists. `claude-transcript-rebuild.test.ts` drives both over
 * the same table and asserts they agree — a rebuild written to a directory the
 * SDK never opens is the silent empty resume this whole task's fail-safe exists
 * to prevent, and it would look exactly like a working feature.
 *
 * **`session.sdkCwd` is a trap and the field name hides it.** It is
 * TILDE-ABBREVIATED on disk: 618 of the 676 session headers that carry it (91%),
 * and 6 of its 8 distinct path prefixes, begin with `~`. Measured against the
 * 166 real project directories under `claude-config/projects`, sanitizing the
 * expanded form matches 169 sessions and sanitizing the raw form matches
 * **zero**. So a `~`-form candidate is REJECTED here, by name and with a
 * reason, rather than left to fail an `lstatSync` that never expands it —
 * which is what today's code does and is why it survives by accident. Rejecting
 * is the whole change: the candidate list, and therefore the answer, is
 * identical to what shipped, and the next candidate down
 * (`getSessionDirPath`) is what the 200 real transcripts actually record as
 * their `cwd`.
 *
 * Expanding it instead was considered and refused: it would move the spawn cwd
 * of 91% of existing sessions, which is a behaviour change T2 has no mandate
 * for and no evidence is wanted.
 *
 * `branchFromSdkCwd` is consulted only on the first attempt of a branched
 * session — pre-spawn detection (in `chat()`) routes stale-branch cases through
 * `recoverFromStaleBranchFork` before the spawn path runs, so the branch
 * candidate is only relevant in the rare race where the cwd vanishes between
 * the pre-spawn check and the actual spawn.
 */
export function resolveClaudeTranscriptCwd(input: {
  isRetry: boolean;
  branchFromSdkSessionId: string | null | undefined;
  branchFromSdkCwd: string | null | undefined;
  sdkCwd: string | null | undefined;
  workspaceId: string;
  sessionId: string | null | undefined;
  workspaceRootPath: string;
  /** Where the tilde rejection announces itself. Optional — the resolver stays callable from a test with no logger. */
  debug?: (message: string) => void;
}): string {
  const candidates: Array<string | null | undefined> = [
    !input.isRetry && input.branchFromSdkSessionId ? input.branchFromSdkCwd : null,
    input.sdkCwd,
    input.sessionId ? getSessionDirPath(input.workspaceId, input.sessionId) : null,
    input.workspaceRootPath,
  ];
  for (const candidate of candidates) {
    if (isTildeForm(candidate)) {
      input.debug?.(`[claude-cwd] skipping tilde-abbreviated candidate ${candidate} — a '~' path is neither an existing directory nor a valid project key`);
      continue;
    }
    if (isExistingDirectory(candidate)) return candidate!;
  }
  // workspaceRootPath itself is missing — pathological, but we have nothing
  // better to fall back to. Let the SDK surface the spawn failure.
  input.debug?.(`[claude-cwd] no cwd candidate exists; falling back to workspaceRootPath anyway (${candidates.join(', ')})`);
  return input.workspaceRootPath;
}

/** `~` or `~/…`. Not `~foo`, which is a real relative directory name. */
function isTildeForm(candidate: string | null | undefined): boolean {
  return typeof candidate === 'string' && (candidate === '~' || candidate.startsWith('~/') || candidate.startsWith('~\\'));
}

// ============================================================
// Path derivation — the SDK's four helpers, ported verbatim
// ============================================================

/** `var Jo=200` in `sdk.mjs`. A sanitized key longer than this gets the hash suffix. */
export const CLAUDE_PROJECT_KEY_MAX_LENGTH = 200;

/**
 * The SDK's `hE` — a djb2-style 32-bit hash over UTF-16 code units.
 *
 * `charCodeAt` and not a code-point iteration: the SDK reads code UNITS, and a
 * cwd containing an astral character (an emoji in a directory name is the
 * realistic case) hashes differently under the two readings. `| 0` is what
 * keeps it in int32, and it is why the `Math.abs` below can legitimately
 * exceed int32 for `-2147483648`.
 */
function djb2(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i) | 0;
  }
  return hash;
}

/** The SDK's `ewe`. */
export function claudeProjectKeyHash(value: string): string {
  return Math.abs(djb2(value)).toString(36);
}

/**
 * The SDK's `Yo`: non-alphanumerics to `-`, and a hash suffix over the ORIGINAL
 * path once the sanitized form exceeds 200 characters.
 *
 * Note which string is hashed: `ewe(e)` takes the un-sanitized argument, not
 * the truncated one. Hashing the truncation would make two long paths sharing a
 * 200-character prefix collide — which is the whole point of the suffix.
 *
 * @param resolvedPath a path that has ALREADY been through
 *   {@link normalizeClaudeTranscriptCwd}. Passing a raw `~`-form path here is
 *   the defect T2 exists to prevent (see that function's note).
 */
export function claudeProjectKey(resolvedPath: string): string {
  const sanitized = resolvedPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= CLAUDE_PROJECT_KEY_MAX_LENGTH) return sanitized;
  return `${sanitized.slice(0, CLAUDE_PROJECT_KEY_MAX_LENGTH)}-${claudeProjectKeyHash(resolvedPath)}`;
}

/**
 * The SDK's `Xo`: realpath, then NFC-normalize **on darwin only**.
 *
 * Both halves matter. The realpath is why our own transcripts sit under
 * `-private-var-folders-…` rather than `-var-folders-…` on macOS, and why a
 * workspace reached through a symlink resolves to one project dir rather than
 * two. The platform gate is why this must not be a bare `.normalize('NFC')`.
 *
 * Falls back to normalizing the ORIGINAL path when realpath throws, exactly as
 * the SDK's `try/catch` does — a cwd that does not exist yet still yields a
 * stable key rather than an exception.
 */
export function normalizeClaudeTranscriptCwd(cwd: string): string {
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = cwd;
  }
  return process.platform === 'darwin' ? resolved.normalize('NFC') : resolved;
}

/** `normalizeClaudeTranscriptCwd` then `claudeProjectKey`, which is the whole derivation. */
export function claudeProjectKeyForCwd(cwd: string): string {
  return claudeProjectKey(normalizeClaudeTranscriptCwd(cwd));
}

/**
 * `<CLAUDE_CONFIG_DIR>/projects/<projectKey>/<sdkSessionId>.jsonl` — the file
 * the SDK opens when it is handed `resume: <sdkSessionId>` with this cwd.
 */
export function claudeTranscriptPath(input: {
  /** The per-Workspace `CLAUDE_CONFIG_DIR` (`workspaceClaudeConfigDir`). */
  configDir: string;
  /** The cwd the SDK subprocess will be spawned in — `resolveClaudeTranscriptCwd`'s answer. */
  cwd: string;
  sdkSessionId: string;
}): string {
  return join(input.configDir, 'projects', claudeProjectKeyForCwd(input.cwd), `${input.sdkSessionId}.jsonl`);
}

/**
 * Whether a transcript at this path is one the SDK would actually load.
 *
 * `size > 0` is the SDK's own precondition, not a nicety: its transcript
 * locator (`Qo` in `sdk.mjs`) stats each candidate and skips any file whose
 * size is zero. A half-written file is therefore indistinguishable from an
 * absent one to the SDK, and must be to us as well — this predicate is what
 * `ClaudeAgent.shouldSuppressTextHandoff` reads to decide whether a rebuild is
 * really in force on this turn.
 */
export function claudeTranscriptIsLoadable(filePath: string): boolean {
  try {
    const stats = statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

// ============================================================
// The record envelope
// ============================================================

/**
 * One JSONL line of a Claude transcript, as the SDK's own writer emits it.
 *
 * The field list is the census of the 1 349 `user`/`assistant` records in the
 * 200 transcripts our own gateway runtime wrote, not a guess: every required
 * field below is present on 100% of them, and every optional one appears where
 * the census says it does (`promptId` on all 545 user records,
 * `sourceToolAssistantUUID` and `toolUseResult` on the 70 that are tool
 * results).
 *
 * **What is deliberately NOT here, and must never be added:**
 * `compactMetadata`, `type: 'system'` and `isCompactSummary`. The loader's
 * compaction handler destructures `compactMetadata.preservedMessages` /
 * `preservedSegment` and DELETES every pre-boundary record not in the preserved
 * set — so emitting a compaction boundary would throw away the history this
 * whole task exists to carry. All 60 `compaction_complete` markers in the
 * corpus are dropped on the floor by the projection upstream, and
 * `claude-transcript-rebuild.test.ts` asserts the produced file contains zero
 * of each.
 */
export interface ClaudeTranscriptRecord {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string | null;
  isSidechain: false;
  userType: 'external';
  cwd: string;
  sessionId: string;
  timestamp: string;
  message: Record<string, unknown>;
  version: string;
  entrypoint: string;
  gitBranch: string;
  /** User records only. Present on all 545 in the corpus. */
  promptId?: string;
  /** Tool-result records only: the uuid of the `tool_use` record it answers. */
  sourceToolAssistantUUID?: string;
  /** Tool-result records only. JSON-parseable by construction — see `toolUseResultValue`. */
  toolUseResult?: unknown;
  /**
   * D10 · which of OUR runtimes produced the row this record was built from.
   *
   * Not an SDK field. It is carried so that a later reader — a support session
   * opening the vendor transcript after an incident like "the model quoted a
   * file it never read" — can tell a CARRIED turn from one Claude produced
   * itself. Proven harmless on the shipped binary: the offline resume e2e
   * writes these records with `runtime` set and the SDK loads them and puts the
   * whole history on the wire.
   *
   * Two limits, written down rather than discovered later. `Message.runtime` is
   * absent on 4 533 of the 5 332 stored rows, so this marker works forward only
   * and is `undefined` for most historical rows (`core/types/message.ts`
   * requires a reader to treat absent as "the session's current runtime", never
   * as a distinct value). And it has exactly one production reader today, so
   * nothing renders it.
   *
   * **R1 item 3 is closed as decided on this comment, not on more code.** The
   * question it asked — "a rebuilt transcript is indistinguishable later from a
   * natively produced one; decide whether that matters" — is answered by the
   * stamp above plus the two limits above it. The user-facing half of R1 is a
   * different surface entirely: the switch notice, which names what crossed.
   */
  runtime?: string;
}

/**
 * `toolUseResult`, written so it is a JSON VALUE rather than a JSON-looking
 * string (audit row A9).
 *
 * Our stored tool result is a plain display string for most rows — bash output,
 * file contents, error text — while the SDK's own writer puts a structured
 * value there (the census: 65 objects, 3 arrays, 2 strings). So: pass the
 * stored value through when it already parses as JSON, and otherwise let it
 * ride as the string it is, which serializes to a JSON string literal.
 *
 * `null` is carved out of the pass-through arm deliberately. A tool that
 * printed the four characters `null` is overwhelmingly likelier than a tool
 * whose result genuinely is the JSON null, and `toolUseResult: null` is
 * indistinguishable from "no result" to any reader.
 */
export function toolUseResultValue(output: string): unknown {
  try {
    const parsed: unknown = JSON.parse(output);
    return parsed === null ? output : parsed;
  } catch {
    return output;
  }
}

/**
 * The CLI version stamp the SDK's own writer puts on every record, and the "bundled runtime" the Update Required card names.
 * Read from the INSTALLED SDK's manifest (`claudeCodeVersion`), never hardcoded. F1.1240 — found from the SDK's own entry
 * and read from disk: the packaged main is esbuild CJS, where `import.meta.url` is undefined (so `createRequire` threw), and
 * the SDK's `exports` map has no `./package.json` (Node refuses it; Bun does not). `claude-cli-version.test.ts` runs it under node.
 */
export function readClaudeCliVersion(resolveEntry: () => string = () => {
  const url = (import.meta as { url?: string } | undefined)?.url;
  return createRequire(typeof url === 'string' && url.startsWith('file:') ? url : __filename).resolve('@anthropic-ai/claude-agent-sdk');
}): string {
  try {
    for (let dir = dirname(resolveEntry()), up = 0; up < 4; dir = dirname(dir), up++) {
      const path = join(dir, 'package.json');
      const manifest = statSync(path, { throwIfNoEntry: false })?.isFile() ? JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; claudeCodeVersion?: unknown } : undefined;
      if (manifest?.name === '@anthropic-ai/claude-agent-sdk') return typeof manifest.claudeCodeVersion === 'string' && manifest.claudeCodeVersion ? manifest.claudeCodeVersion : 'unknown';
    }
  } catch {
    // No SDK entry, or an unreadable manifest: harnesses only — the SDK's JS core ships in every configuration.
  }
  return 'unknown';
}

/** The `entrypoint` stamp on all 1 349 records our runtime has written. */
export const CLAUDE_TRANSCRIPT_ENTRYPOINT = 'claude-desktop';

export interface ClaudeTranscriptRebuildInput {
  /**
   * The row projection, ALREADY built — `buildRuntimeHandoffHistory`'s output.
   *
   * This module deliberately does not take `StoredMessage[]`. §P.2(b)'s
   * keep/drop list and the four measured integrity guards live in ONE place,
   * `packages/server-core/src/sessions/runtime-handoff.ts`, and that package
   * depends on this one rather than the other way round — so re-implementing
   * the projection here to satisfy a `StoredMessage[]` signature would have
   * meant two copies of the guards, which is exactly the shape T1b's own
   * extraction existed to remove.
   */
  history: readonly RuntimeHandoffHistoryItem[];
  /** The cwd the SDK subprocess will run in. Must already be resolved — see `resolveClaudeTranscriptCwd`. */
  cwd: string;
  /** The minted SDK session id. Lowercase UUIDv4; it is also the file's basename. */
  sdkSessionId: string;
  /**
   * The model id to stamp on assistant records, or `undefined` to omit
   * `message.model` entirely. See {@link CLAUDE_TRANSCRIPT_WRITES_MODEL}.
   */
  model?: string | undefined;
  /** `readClaudeCliVersion()` at the call site. */
  version: string;
  /** The branch stamp. Environmental; excluded from the golden comparison. */
  gitBranch?: string;
  /** Injected for deterministic tests. Defaults to `crypto.randomUUID`. */
  newUuid?: () => string;
  /** Injected for deterministic tests. Epoch milliseconds. */
  now?: () => number;
  /**
   * P6.481 · where the reasoning strip announces itself.
   *
   * A dropped reasoning row is a deliberate loss and a deliberate loss nobody
   * can see is indistinguishable from a bug in this writer. Optional so the
   * module stays pure and callable from a test with no sink bound; absent means
   * the strip is silent, exactly as every pre-P6.481 caller behaved.
   */
  log?: (message: string) => void;
}

/**
 * **The `message.model` arm, and why it defaults ON.**
 *
 * omnigent's converter omits `message.model`, on a docstring about ITS path,
 * and importing that conclusion would have been a guess about our own. Ours is
 * measured: the 200 transcripts our gateway runtime has already written carry
 * `model: "tgpt/qwen35-397b-a17b-fp8"` on 652 assistant records and
 * `"tgpt/qwen36-35b-a3b-fp8"` on 26 more — non-Claude gateway ids — and the SDK
 * resumes off those files today. A field the writer always fills is not
 * something to omit on a hunch.
 *
 * Both arms are implemented (pass `model: undefined` for the other one) and the
 * test table drives both, because the plan reserves the FINAL choice for the
 * live gateway day, which is owed at the wave boundary rather than here. If
 * that run shows the id confusing the gateway leg, flipping this constant is
 * the whole change.
 */
export const CLAUDE_TRANSCRIPT_WRITES_MODEL = true;

/**
 * Turn the row projection into the SDK's own JSONL records.
 *
 * **Chaining is not optional.** The bundled binary carries, verbatim:
 * *"Conversation reconstruction walks parentUuid from the last record, so
 * unlinked records are dropped — the file's producer must chain records
 * (parentUuid null on the first, the previous record's uuid on each subsequent
 * one)"*, with telemetry `tengu_resume_unchained_transcript` at
 * `level: "error"`. So: `parentUuid: null` on record 0, the previous record's
 * `uuid` on every other, and a tool result's parent is its own `tool_use`
 * record — tracked through an explicit call-id map rather than left to "the
 * previous record happens to be it", so the invariant survives any future
 * reordering and can be asserted directly.
 *
 * The loader is NOT a strict walk — it falls back to timestamp order on a
 * missing parent and carries a cycle guard — which is precisely why the
 * fail-safe is a read-back and not a re-walk: porting three arms to check our
 * own output would be more code than the writer.
 */
export function buildClaudeTranscriptRecords(input: ClaudeTranscriptRebuildInput): ClaudeTranscriptRecord[] {
  const newUuid = input.newUuid ?? (() => randomUUID());
  const now = input.now ?? (() => Date.now());
  const envelope = {
    isSidechain: false as const,
    userType: 'external' as const,
    cwd: input.cwd,
    sessionId: input.sdkSessionId,
    version: input.version,
    entrypoint: CLAUDE_TRANSCRIPT_ENTRYPOINT,
    gitBranch: input.gitBranch ?? '',
  };

  const records: ClaudeTranscriptRecord[] = [];
  /** omnigent's `tool_parent_by_call_id` (`claude_native.py:4404-4409`), by name. */
  const toolParentByCallId = new Map<string, string>();
  let previousUuid: string | null = null;
  let previousTimestampMs = 0;
  /** P6.481 · reasoning rows dropped for want of an attestation. See the arm below. */
  let strippedReasoning = 0;

  /**
   * Non-decreasing timestamps. The stored row's own time is used where it
   * exists — it is the honest one, and it is what makes the file diagnosable
   * next to our `session.jsonl` — but the loader's fallback arm orders by
   * timestamp when the chain is incomplete, so a row that went backwards could
   * reorder history under a reader we do not control. A backwards row is
   * nudged one millisecond forward instead.
   */
  const stampFor = (timestamp: number | undefined): string => {
    const candidate = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : now();
    const chosen = candidate > previousTimestampMs ? candidate : previousTimestampMs + 1;
    previousTimestampMs = chosen;
    return new Date(chosen).toISOString();
  };

  const push = (record: Omit<ClaudeTranscriptRecord, keyof typeof envelope | 'parentUuid'> & { parentUuid?: string | null }): ClaudeTranscriptRecord => {
    const full: ClaudeTranscriptRecord = {
      ...record,
      ...envelope,
      parentUuid: record.parentUuid !== undefined ? record.parentUuid : previousUuid,
    };
    records.push(full);
    previousUuid = full.uuid;
    return full;
  };

  for (const item of input.history) {
    const runtime = item.runtime ? { runtime: item.runtime } : {};
    const timestamp = stampFor(item.timestamp);

    if (item.kind === 'message') {
      if (item.role === 'user') {
        push({
          type: 'user',
          uuid: newUuid(),
          promptId: newUuid(),
          timestamp,
          message: { role: 'user', content: item.content },
          ...runtime,
        });
        continue;
      }
      push({
        type: 'assistant',
        uuid: newUuid(),
        timestamp,
        message: assistantMessage([{ type: 'text', text: item.content }], 'end_turn', input.model),
        ...runtime,
      });
      continue;
    }

    // P6.481 · REASONING, and the signature is the whole of whether it can go.
    //
    // Owner Q10 = (b): claude-origin reasoning crosses a claude → claude switch
    // WITH its `signature`. The projection has already established the origin
    // (a `reasoning` item reaches this rebuild only when the row was produced
    // by this runtime), so what is left here is the attestation.
    //
    // A `thinking` block replayed to the Messages API without a valid signature
    // is a **400**, not a degraded read — so a signature-less block is STRIPPED
    // rather than sent, and stripped ENTIRELY rather than downgraded to a
    // `text` block: emitting one model's private reasoning as prose it spoke
    // out loud is the mislabelling P6.604 removed one layer up, and doing it
    // here would put it straight back.
    //
    // The observable shape this matches:
    // `"type":"thinking"` beside `"signature":"CAISmQIKiAEIEBgC…"`, present in
    // 149 of the first 200 of 5 324 `~/.claude/projects/**` transcripts.
    if (item.kind === 'reasoning') {
      if (!item.signature) {
        strippedReasoning += 1;
        continue;
      }
      push({
        type: 'assistant',
        uuid: newUuid(),
        timestamp,
        message: assistantMessage(
          [{ type: 'thinking', thinking: item.content, signature: item.signature }],
          'end_turn',
          input.model,
        ),
        ...runtime,
      });
      continue;
    }

    // A tool row is TWO records — the call and its result — and they must be
    // adjacent and correctly parented. An unpaired `tool_use` is a hard
    // provider error on the next turn, which is why the projection upstream
    // closes a dangling call with a synthetic result rather than dropping it.
    const call = push({
      type: 'assistant',
      uuid: newUuid(),
      timestamp,
      message: assistantMessage(
        [{ type: 'tool_use', id: item.callId, name: item.name, input: item.input }],
        'tool_use',
        input.model,
      ),
      ...runtime,
    });
    toolParentByCallId.set(item.callId, call.uuid);

    push({
      type: 'user',
      uuid: newUuid(),
      promptId: newUuid(),
      // The pairing link, taken from the map rather than from "the record
      // before this one" — which happens to be the same uuid today and is not
      // the invariant.
      parentUuid: toolParentByCallId.get(item.callId) ?? call.uuid,
      timestamp: stampFor(item.timestamp),
      message: {
        role: 'user',
        content: [{ tool_use_id: item.callId, type: 'tool_result', content: item.output, is_error: false }],
      },
      // The SECOND pairing link our own native writer always sets (70 of 70
      // tool-result records in the corpus carry it, always equal to
      // `parentUuid`). It costs nothing and omitting a field the writer always
      // emits is a guess.
      sourceToolAssistantUUID: call.uuid,
      toolUseResult: toolUseResultValue(item.output),
      ...runtime,
    });
  }

  if (strippedReasoning > 0) {
    input.log?.(
      `[claude-rebuild] ${strippedReasoning} reasoning row(s) were stripped: a thinking block replayed `
      + 'without its signature is refused by the Messages API, and these rows carry none',
    );
  }

  return records;
}

/**
 * The assistant `message` body, shaped like the SDK's own.
 *
 * `usage` is zeroed rather than invented: we genuinely do not know what the
 * previous runtime spent, and the SDK recomputes context accounting from each
 * turn's own API response. `id` is `msg_<32 hex>` because that is the shape the
 * corpus carries, derived from the record's own randomness so a rebuild is
 * reproducible when the uuid source is.
 */
function assistantMessage(
  content: unknown[],
  stopReason: 'end_turn' | 'tool_use',
  model: string | undefined,
): Record<string, unknown> {
  return {
    id: `msg_${createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 32)}`,
    type: 'message',
    role: 'assistant',
    ...(CLAUDE_TRANSCRIPT_WRITES_MODEL && model ? { model } : {}),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ============================================================
// The writer, and the read-back that makes it a fail-safe
// ============================================================

export class ClaudeTranscriptRebuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeTranscriptRebuildError';
  }
}

/**
 * Serialize records to JSON lines, one `JSON.stringify` per line — the exact
 * shape the SDK's own resume materializer writes.
 */
export function serializeClaudeTranscript(records: readonly ClaudeTranscriptRecord[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n';
}

/**
 * Write the transcript atomically and **read it back**.
 *
 * The read-back is the fail-safe, and it is deliberately not a re-walk of the
 * loader's logic: the loader has a timestamp-fallback arm and a cycle guard,
 * and its unchained diagnostic fires only when NO record is chained, so
 * reproducing it faithfully enough to trust would cost more than the writer.
 * What this checks instead is that the bytes on disk are the bytes we meant:
 * every line parses, the count matches, and the chain is intact from the file
 * rather than from the array we still hold in memory.
 *
 * A failure THROWS, and the caller's contract is to leave `runtimeHandoffFrom`
 * armed and set no anchor — so the text handoff delivers on the next turn and
 * the user loses nothing. That is R1's invariant: the rebuild or the text
 * handoff, never both.
 *
 * `tmp + rename` in the same directory, so a crash mid-write cannot leave a
 * partial file at the real path. Mode 0600 matches the SDK's own materializer.
 */
export function writeClaudeTranscript(filePath: string, records: readonly ClaudeTranscriptRecord[]): { records: number; bytes: number } {
  if (records.length === 0) throw new ClaudeTranscriptRebuildError('refusing to write an empty transcript');

  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const payload = serializeClaudeTranscript(records);
  try {
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, filePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the rename already consumed it, or the write never landed */ }
    throw error;
  }

  verifyClaudeTranscript(filePath, records.length);
  return { records: records.length, bytes: Buffer.byteLength(payload) };
}

/**
 * Read a written transcript back and prove it is WELL-FORMED.
 *
 * Exported so the test can drive it directly against a deliberately-corrupted
 * file: a verifier that is only ever called on good input is not a verifier.
 *
 * **C3.313 — this is one of two questions, and it is not the one about the
 * runtime.** What it checks is ours: the exact record count, a usable uuid per
 * record, and the parent CHAIN read back off the file. None of the three is
 * expressible through the SDK's own reader — `SessionMessage` carries no
 * `parentUuid`, and a corrupted two-line transcript came back from
 * `getSessionMessages` as one message rather than as an error. The second
 * question — *can the runtime find and parse this file* — is
 * `confirmClaudeTranscriptThroughSdk` in `agent/claude-session-persistence.ts`,
 * which the switch's caller asks after this one passes. Neither replaces the
 * other; if you change the record layout below, both are due a re-read.
 */
export function verifyClaudeTranscript(filePath: string, expectedRecords: number): ClaudeTranscriptRecord[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new ClaudeTranscriptRebuildError(`transcript unreadable after write: ${error instanceof Error ? error.message : String(error)}`);
  }

  const lines = raw.split('\n').filter(line => line.length > 0);
  if (lines.length !== expectedRecords) {
    throw new ClaudeTranscriptRebuildError(`transcript read back ${lines.length} record(s), expected ${expectedRecords}`);
  }

  const parsed: ClaudeTranscriptRecord[] = [];
  let previousUuid: string | null = null;
  lines.forEach((line, index) => {
    let record: ClaudeTranscriptRecord;
    try {
      record = JSON.parse(line) as ClaudeTranscriptRecord;
    } catch {
      throw new ClaudeTranscriptRebuildError(`transcript record ${index} is not valid JSON`);
    }
    if (!record.uuid || !CLAUDE_UUID_RE.test(record.uuid)) {
      throw new ClaudeTranscriptRebuildError(`transcript record ${index} carries an unusable uuid (${String(record.uuid)})`);
    }
    // The chain, checked against the FILE and not against the array we built:
    // a tool result parents to its own call, everything else to the record
    // before it, and record 0 to nothing.
    const expectedParent = index === 0 ? null : previousUuid;
    const parentIsCall = record.sourceToolAssistantUUID !== undefined && record.parentUuid === record.sourceToolAssistantUUID;
    if (!parentIsCall && record.parentUuid !== expectedParent) {
      throw new ClaudeTranscriptRebuildError(`transcript record ${index} is unchained (parentUuid=${String(record.parentUuid)}, expected ${String(expectedParent)})`);
    }
    previousUuid = record.uuid;
    parsed.push(record);
  });

  return parsed;
}

/**
 * The SDK's own session-id validator, quoted from the bundle:
 * `/^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i`.
 *
 * Restated here without the `urn:` prefix and without the `i` flag, because
 * what we MINT must be a plain lowercase UUIDv4 — the file's basename is this
 * string, and a mixed-case id would produce a filename the SDK's own
 * lowercase-normalizing readers may not find again.
 */
const CLAUDE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Mint an SDK session id: a lowercase UUIDv4, which is what the validator accepts. */
export function mintClaudeSdkSessionId(): string {
  return randomUUID().toLowerCase();
}

export function isClaudeSdkSessionId(value: string | undefined | null): boolean {
  return typeof value === 'string' && CLAUDE_UUID_RE.test(value);
}
