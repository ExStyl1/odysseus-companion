/**
 * Synthesize a Pi session file, so a FIRST switch INTO Pi hands over the
 * conversation instead of a summary of it.
 *
 * T7 of `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md`,
 * unparked by owner gate G2 (answered 2026-08-21).
 *
 * **Why this is possible at all, and why it needs no new resume path.** The Pi
 * subprocess already knows how to start from a session file that is not its
 * own: the BRANCH path takes a parent JSONL, preflights it and calls
 * `SessionManager.forkFrom(parent, cwd, sessionDir)`, which rewrites the header
 * cwd, stamps `parentSession` and writes a fresh `.pi-sessions` sidecar
 * carrying every non-header entry of the parent. `forkFrom` is one of the five
 * sanctioned entry points on the vendor's own class; nothing here touches the
 * private constructor. So a cross-runtime rebuild is a translator, one init
 * field and one branch in `ensureSession` — not a new lifecycle.
 *
 * **Everything below was read off the SHIPPED package on this disk**
 * (`node_modules/@earendil-works/pi-coding-agent`) — 0.84.0 when it was written,
 * re-read on 0.84.2 by S0-3 (2026-09-03) and on 0.84.3 by W11-pi (2026-09-11)
 * with `CURRENT_SESSION_VERSION = 3` and
 * the one-line header guard both unchanged — not off its docs alone —
 * the plan's own §P.3 records three load-bearing premises that were falsified
 * exactly because a doc was read without the code:
 *
 * - `CURRENT_SESSION_VERSION = 3` (`dist/core/session-manager.js:11`).
 * - `loadEntriesFromFile` parses line by line, **silently skipping every
 *   malformed line**, and then validates ONE thing:
 *   `if (header.type !== "session" || typeof header.id !== "string") return []`.
 *   That single check is the whole fail-loud arm — `forkFrom` turns the empty
 *   result into `Cannot fork: source session file is empty or invalid`. Bodies
 *   get no validation at all, which is why {@link verifyPiCarrySession} reads
 *   the file back itself rather than trusting the write.
 * - `forkFrom` copies `entry.type !== "session"` lines verbatim, so what we
 *   write is what the child session holds.
 * - `sessionEntryToContextMessages(entry)` returns `[entry.message]` for a
 *   `message` entry, and `buildContextEntries` walks `parentId` from the leaf to
 *   the root. Those two are upstream's OWN projection and this module's
 *   correctness oracle: `pi-session-rebuild.test.ts` runs them over the file we
 *   wrote rather than re-deriving what a loaded entry ought to look like. They
 *   became public exports in 0.84 (U2's note calls this out); before that the
 *   oracle did not exist.
 * - The provider request reads only `role`, the content blocks, `toolCallId`
 *   and `toolName` (`pi-ai/dist/api/openai-completions.js` — `assistantMsg` is
 *   rebuilt field by field, `tool_calls` from `type === "toolCall"` blocks, and
 *   a tool result becomes `{role:"tool", content, tool_call_id}`). `api`,
 *   `provider`, `model` and `usage` never reach the wire; they exist on the
 *   stored shape and are written for completeness, with the one consequence
 *   they DO have recorded at {@link PI_CARRY_PROVIDER}.
 *
 * **Pure, except for the writer.** The builder touches nothing; the writer does
 * tmp + rename + read-back, the same fail-safe `writeClaudeTranscript` runs, for
 * the same reason: the caller's contract is to leave `runtimeHandoffFrom` armed
 * on a failure, so the text handoff still delivers and the user loses nothing.
 *
 * The caller owns loading the transcript and owns the projection — see
 * `buildRuntimeHandoffHistory` in
 * `packages/server-core/src/sessions/runtime-handoff.ts`, whose OUTPUT is this
 * module's input. The keep/drop list and the four measured integrity guards
 * live there, in ONE place, for all three runtimes.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getSessionDirPath } from '../sessions/storage.ts';
import type { RuntimeHandoffHistoryItem } from './backend/types.ts';

/** `CURRENT_SESSION_VERSION` in the pinned `pi-coding-agent`. */
export const PI_SESSION_VERSION = 3;

/**
 * Where a synthesized parent lives: `<session dir>/.pi-carry/handoff.jsonl`.
 *
 * **Deliberately NOT inside `.pi-sessions`.** That directory is what
 * `continueRecent(cwd, sessionDir)` scans, and `findMostRecentSessionFile`
 * picks the newest `.jsonl` in it — so a synthesized file dropped there would
 * become the session Pi resumes and appends to, making us the writer of a live
 * Pi session for the rest of its life. Forking out of a sibling directory keeps
 * exactly one authored file, read once, and leaves every subsequent write to
 * the vendor.
 *
 * The name is FIXED rather than minted, and that is what saves a persisted
 * field: `PiAgent` re-derives the path from the workspace and session ids
 * instead of carrying one across a quit. A second carry into the same session
 * cannot happen (the target then holds a Pi anchor and `planHistoryCarry`
 * answers `anchor`), and if one ever did, overwriting is the correct outcome.
 */
export const PI_CARRY_DIRNAME = '.pi-carry';
export const PI_CARRY_FILENAME = 'handoff.jsonl';

/**
 * The `provider` / `api` stamped on synthesized assistant messages, and why it
 * is deliberately not a real Pi provider id.
 *
 * `createAgentSession` restores a model from the session when no explicit one
 * is passed: `getSessionContextSettings` takes the LAST assistant message's
 * `{provider, model}` and the SDK then calls
 * `modelRuntime.getModel(provider, modelId)`. Our carried assistant rows were
 * produced by Claude or Codex; naming a Pi provider on them would let a rebuilt
 * history decide which model the Pi session runs, which is T3's decision
 * (`resolveCarriedModel`) and arrives separately as `sessionOptions.model`. A
 * sentinel provider resolves to nothing, so the restore arm cannot fire and the
 * session lands on the model the switch actually chose. The SDK's own
 * `modelFallbackMessage` for that case is a returned string our adapter does
 * not read, so nothing surfaces.
 */
export const PI_CARRY_PROVIDER = 'nessy-runtime-handoff';

/** Zeroed, and honest: no Pi request produced these rows, so no Pi tokens were spent on them. */
const ZERO_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
});

export interface PiTextContent { type: 'text'; text: string }
export interface PiToolCallContent { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
/**
 * P6.604 · Pi's own reasoning block, declared by the SDK we ship against.
 *
 * `@earendil-works/pi-ai`'s `ThinkingContent`:
 * `{ type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }`.
 * Restated here rather than imported for the same reason `PiTextContent` is —
 * this module writes a FILE FORMAT and must not silently follow a dependency's
 * type change — and `redacted` is deliberately omitted: it describes a
 * safety-filter outcome on a live turn, which a carried row never is.
 */
export interface PiThinkingContent { type: 'thinking'; thinking: string; thinkingSignature?: string }

export interface PiUserMessage {
  role: 'user';
  content: PiTextContent[];
  timestamp: number;
}

export interface PiAssistantMessage {
  role: 'assistant';
  content: Array<PiTextContent | PiToolCallContent | PiThinkingContent>;
  api: string;
  provider: string;
  model: string;
  usage: typeof ZERO_USAGE;
  stopReason: 'stop' | 'toolUse';
  timestamp: number;
}

export interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: PiTextContent[];
  isError: boolean;
  timestamp: number;
}

export type PiCarriedMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export interface PiSessionHeaderLine {
  type: 'session';
  version: typeof PI_SESSION_VERSION;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface PiSessionMessageLine {
  type: 'message';
  /** 8 hex characters — the shape `generateId` mints and `parentId` refers to. */
  id: string;
  parentId: string | null;
  /** ISO, per `SessionEntryBase`. The message carries its own epoch-ms one. */
  timestamp: string;
  message: PiCarriedMessage;
  /**
   * D10 · which of OUR runtimes produced the row this entry was built from.
   *
   * Not a vendor field, and deliberately on the ENTRY rather than on the
   * message: `sessionEntryToContextMessages` hands the `message` object
   * onwards, so a foreign key there could ride into a provider request, while
   * an entry-level one is never read by anything that talks to a model and
   * still survives `forkFrom`'s verbatim copy. Same two limits the Claude
   * rebuild records: `Message.runtime` is absent on most stored rows, so this
   * works forward only, and nothing renders it.
   */
  nessyRuntime?: string;
}

export type PiSessionLine = PiSessionHeaderLine | PiSessionMessageLine;

export class PiSessionRebuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PiSessionRebuildError';
  }
}

/** `<session dir>/.pi-carry/handoff.jsonl`. Pure — derives, never creates. */
export function piCarrySessionPath(input: { workspaceId: string; sessionId: string }): string {
  return join(getSessionDirPath(input.workspaceId, input.sessionId), PI_CARRY_DIRNAME, PI_CARRY_FILENAME);
}

/**
 * Whether a carry file at this path is one Pi would actually fork from.
 *
 * The predicate is upstream's, not ours: `loadEntriesFromFile` returns `[]`
 * unless the FIRST parsed entry is `{type:'session'}` with a string `id`, and
 * `forkFrom` refuses an empty result. So a file that fails this check is one
 * `forkFrom` would throw on — which is exactly what
 * `PiAgent.shouldSuppressTextHandoff` must not suppress the text handoff for.
 *
 * Reads only the first line, so it stays cheap enough to run at the top of
 * every turn.
 */
export function piCarrySessionIsLoadable(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    const raw = readFileSync(filePath, 'utf8');
    const firstLine = raw.split('\n').find(line => line.trim().length > 0);
    if (!firstLine) return false;
    const header: unknown = JSON.parse(firstLine);
    if (!header || typeof header !== 'object') return false;
    const candidate = header as { type?: unknown; id?: unknown };
    return candidate.type === 'session' && typeof candidate.id === 'string' && candidate.id.length > 0;
  } catch {
    return false;
  }
}

export interface PiSessionRebuildInput {
  /**
   * The row projection, ALREADY built — `buildRuntimeHandoffHistory`'s output.
   *
   * The same input `buildClaudeTranscriptRecords` takes, for the same reason:
   * §P.2(b)'s keep/drop list and the four measured integrity guards live in one
   * place and this package depends on that one, so re-implementing the
   * projection here would mean two copies of the guards.
   */
  history: readonly RuntimeHandoffHistoryItem[];
  /** The cwd the Pi subprocess will run in. `forkFrom` rewrites the header to its own target cwd anyway; this is what we record. */
  cwd: string;
  /** The model the session lands on after the switch (T3's `resolveCarriedModel`). Stamped for completeness — see {@link PI_CARRY_PROVIDER}. */
  model?: string | undefined;
  /** Injected for deterministic tests. Defaults to `crypto.randomUUID().slice(0, 8)`. */
  newEntryId?: () => string;
  /** Injected for deterministic tests. Epoch milliseconds. */
  now?: () => number;
  /** Injected for deterministic tests. The header's session id. */
  newSessionId?: () => string;
}

/**
 * Translate the handoff projection into Pi session lines, header first.
 *
 * **One item can become TWO entries, and that is the whole tool story.** Pi
 * stores a tool call as a `toolCall` content block on an ASSISTANT message and
 * its result as a separate `toolResult` message keyed by `toolCallId` — the
 * same pairing every provider requires, and an unpaired result is the hard
 * provider error the projection's guard 1 exists to prevent. So a `kind:'tool'`
 * item emits the assistant call and then the result, back to back, chained.
 *
 * The call is emitted as its OWN assistant entry rather than merged into the
 * preceding text entry. Both shapes are valid to the converter (it keeps an
 * assistant message that has `tool_calls` and no content), and separate entries
 * keep the entry→item mapping one-way and testable — the same choice the Claude
 * rebuild makes with one record per `tool_use`.
 *
 * Tool NAMES cross verbatim. They were minted by whichever runtime ran them and
 * are historical labels, not a call the model is making now; §P.1 of the plan
 * is explicit that a transcript converter must not touch name resolution.
 */
export function buildPiCarrySessionLines(input: PiSessionRebuildInput): PiSessionLine[] {
  const newEntryId = input.newEntryId ?? (() => randomUUID().replace(/-/g, '').slice(0, 8));
  const clock = input.now ?? (() => Date.now());
  const used = new Set<string>();
  const mintId = (): string => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = newEntryId();
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
    throw new PiSessionRebuildError('could not mint a unique entry id');
  };

  const header: PiSessionHeaderLine = {
    type: 'session',
    version: PI_SESSION_VERSION,
    id: (input.newSessionId ?? randomUUID)(),
    timestamp: new Date(clock()).toISOString(),
    cwd: input.cwd,
  };

  const lines: PiSessionLine[] = [header];
  let parentId: string | null = null;
  const model = input.model ?? '';

  const push = (message: PiCarriedMessage, runtime: string | undefined): void => {
    const id = mintId();
    lines.push({
      type: 'message',
      id,
      parentId,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
      ...(runtime ? { nessyRuntime: runtime } : {}),
    });
    parentId = id;
  };

  for (const item of input.history) {
    const timestamp = typeof item.timestamp === 'number' ? item.timestamp : clock();
    if (item.kind === 'message') {
      if (item.role === 'user') {
        push({ role: 'user', content: [{ type: 'text', text: item.content }], timestamp }, item.runtime);
      } else {
        push({
          role: 'assistant',
          content: [{ type: 'text', text: item.content }],
          api: PI_CARRY_PROVIDER,
          provider: PI_CARRY_PROVIDER,
          model,
          usage: ZERO_USAGE,
          stopReason: 'stop',
          timestamp,
        }, item.runtime);
      }
      continue;
    }

    // P6.604 · REASONING, and Pi's own carry format has a slot for it.
    //
    // Native-first, case (1): `@earendil-works/pi-ai` declares
    // `ThinkingContent` — `{type:'thinking', thinking, thinkingSignature?}` —
    // beside `TextContent` and `ToolCall`, so nothing is invented here and no
    // adapter is built. `thinkingSignature` is the same attestation Anthropic
    // calls `signature`, and pi-ai's own docblock says it exists so the payload
    // "can be passed back to the API for multi-turn continuity".
    //
    // Unlike the claude arm, a missing signature is NOT fatal here: pi-ai types
    // it optional and the field carries the redaction payload rather than a
    // required attestation. So the block goes with what the row has. The
    // same-runtime gate has already been applied by the projection.
    if (item.kind === 'reasoning') {
      push({
        role: 'assistant',
        content: [{
          type: 'thinking',
          thinking: item.content,
          ...(item.signature ? { thinkingSignature: item.signature } : {}),
        }],
        api: PI_CARRY_PROVIDER,
        provider: PI_CARRY_PROVIDER,
        model,
        usage: ZERO_USAGE,
        stopReason: 'stop',
        timestamp,
      }, item.runtime);
      continue;
    }

    push({
      role: 'assistant',
      content: [{ type: 'toolCall', id: item.callId, name: item.name, arguments: item.input }],
      api: PI_CARRY_PROVIDER,
      provider: PI_CARRY_PROVIDER,
      model,
      usage: ZERO_USAGE,
      stopReason: 'toolUse',
      timestamp,
    }, item.runtime);
    push({
      role: 'toolResult',
      toolCallId: item.callId,
      toolName: item.name,
      content: [{ type: 'text', text: item.output }],
      isError: false,
      timestamp,
    }, item.runtime);
  }

  return lines;
}

/** One `JSON.stringify` per line, newline-terminated — the shape `forkFrom` writes and `loadEntriesFromFile` reads. */
export function serializePiSession(lines: readonly PiSessionLine[]): string {
  return lines.map(line => JSON.stringify(line)).join('\n') + '\n';
}

/**
 * Write the carry file atomically and **read it back**.
 *
 * The read-back is the fail-safe. Pi validates the HEADER and nothing else —
 * every malformed body line is skipped in silence — so a file that half-wrote
 * would fork successfully and arrive with holes nobody could see. What this
 * checks is that the bytes on disk are the bytes we meant: every line parses,
 * the count matches, the header is the one Pi's own validator accepts, and the
 * `parentId` chain is intact read FROM THE FILE rather than from the array we
 * still hold.
 *
 * A failure THROWS, and the caller's contract is to leave `runtimeHandoffFrom`
 * armed — so the text handoff delivers instead and nothing is lost. R1's
 * invariant: the rebuild or the text handoff, never both.
 */
export function writePiCarrySession(filePath: string, lines: readonly PiSessionLine[]): { entries: number; bytes: number } {
  if (lines.length < 2) throw new PiSessionRebuildError('refusing to write a carry session with no entries');

  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const payload = serializePiSession(lines);
  try {
    writeFileSync(temporary, payload, { mode: 0o600 });
    renameSync(temporary, filePath);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* the rename already consumed it, or the write never landed */ }
    throw error;
  }

  verifyPiCarrySession(filePath, lines.length);
  return { entries: lines.length - 1, bytes: Buffer.byteLength(payload) };
}

/**
 * Read a written carry file back and prove Pi would load it.
 *
 * Exported so a test can drive it against a deliberately-corrupted file: a
 * verifier only ever called on good input is not a verifier.
 */
export function verifyPiCarrySession(filePath: string, expectedLines: number): PiSessionLine[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new PiSessionRebuildError(`carry session unreadable after write: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rows = raw.split('\n').filter(line => line.length > 0);
  if (rows.length !== expectedLines) {
    throw new PiSessionRebuildError(`carry session read back ${rows.length} line(s), expected ${expectedLines}`);
  }

  const parsed: PiSessionLine[] = [];
  let previousId: string | null = null;
  rows.forEach((row, index) => {
    let line: PiSessionLine;
    try {
      line = JSON.parse(row) as PiSessionLine;
    } catch {
      throw new PiSessionRebuildError(`carry session line ${index} is not valid JSON`);
    }
    if (index === 0) {
      // Upstream's own gate, restated: anything else makes `loadEntriesFromFile`
      // return `[]` and `forkFrom` throw "empty or invalid".
      if (line.type !== 'session' || typeof line.id !== 'string' || line.id.length === 0) {
        throw new PiSessionRebuildError('carry session header is not one Pi would accept');
      }
      if (line.version !== PI_SESSION_VERSION) {
        throw new PiSessionRebuildError(`carry session header declares version ${String(line.version)}, expected ${PI_SESSION_VERSION}`);
      }
      parsed.push(line);
      return;
    }
    if (line.type !== 'message') {
      throw new PiSessionRebuildError(`carry session line ${index} is a ${String(line.type)} entry, expected a message`);
    }
    if (typeof line.id !== 'string' || !/^[0-9a-f]{8}$/.test(line.id)) {
      throw new PiSessionRebuildError(`carry session line ${index} carries an unusable entry id (${String(line.id)})`);
    }
    if (line.parentId !== previousId) {
      throw new PiSessionRebuildError(`carry session line ${index} is unchained (parentId=${String(line.parentId)}, expected ${String(previousId)})`);
    }
    previousId = line.id;
    parsed.push(line);
  });

  return parsed;
}
