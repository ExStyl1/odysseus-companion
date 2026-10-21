/**
 * JSONL Session Storage
 *
 * Helpers for reading/writing sessions in JSONL format.
 * Format: Line 1 = SessionHeader, Lines 2+ = StoredMessage (one per line)
 */

import { openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { open } from 'fs/promises';
import { dirname } from 'path';
import { StringDecoder } from 'node:string_decoder';
import type { SessionHeader, StoredSession, StoredMessage } from './types.ts';
import type { PermissionMode } from '../agent/mode-types.ts';
import { parsePermissionMode } from '../agent/mode-types.ts';
import { expandPath, normalizePath } from '../utils/paths.ts';
import { summarizeSessionOutput } from './session-activity-summary.ts';
import { debug } from '../utils/debug.ts';
import { safeJsonParse } from '../utils/files.ts';
import { pickSessionFields } from './utils.ts';

// ============================================================
// Session Path Portability
// ============================================================

const SESSION_PATH_TOKEN = '{{SESSION_PATH}}';
/**
 * P3.324 · the escape marker, and the reason it is four characters and not one.
 *
 * A literal `{{SESSION_PATH}}` in a message gets ONE marker added on write and
 * has it taken off again on read, so the substitution token (zero markers) and a
 * user-written one (one or more) are different strings on disk. Nesting is what
 * makes it a bijection rather than a heuristic: `{{SESSION_PATH~ESC}}` typed by
 * a user is written `{{SESSION_PATH~ESC~ESC}}`, so no depth collides with any
 * other.
 *
 * `~ESC` rather than a bare `!` because the escape has ONE cost, and it lands on
 * records written before this change: an OLD record containing a literal
 * `{{SESSION_PATH` + marker + `}}` is now read one marker shorter. That cannot
 * be avoided without a per-record format version, and it is made harmless by
 * choosing a marker nobody writes by accident — `{{SESSION_PATH!}}` is a string
 * a person might type, `{{SESSION_PATH~ESC}}` is not.
 */
const SESSION_PATH_ESCAPE = '~ESC';
/**
 * `{{SESSION_PATH}}` with zero or more escape markers. Shared, and safe to
 * share: `String.prototype.replace` resets `lastIndex` on a global regexp
 * before and after each call. Never use it with `test`/`exec`.
 */
const SESSION_PATH_TOKEN_FAMILY = /\{\{SESSION_PATH((?:~ESC)*)\}\}/g;
/** Cheap pre-filter — every member of the family starts with this. */
const SESSION_PATH_TOKEN_PREFIX = '{{SESSION_PATH';
const SESSION_HEADER_READ_CHUNK_BYTES = 64 * 1024;
const MAX_SESSION_HEADER_BYTES = 1024 * 1024;

/**
 * Add one escape marker to every literal member of the token family.
 *
 * Run BEFORE {@link tokenizeSessionDir} on the write path, so the tokens this
 * module writes for a real path (zero markers) and the ones the user or the
 * model wrote (one or more) are distinguishable to {@link expandSessionPath}.
 *
 * Unconditional — it does not take a `sessionDir` and does not skip when there
 * is none. The reader always unescapes, so a line that skipped the escape would
 * come back one marker short.
 */
export function escapeLiteralSessionPathTokens(jsonLine: string): string {
  if (!jsonLine.includes(SESSION_PATH_TOKEN_PREFIX)) return jsonLine;
  return jsonLine.replace(
    SESSION_PATH_TOKEN_FAMILY,
    (_match, markers: string) => `${SESSION_PATH_TOKEN_PREFIX}${markers}${SESSION_PATH_ESCAPE}}}`,
  );
}

/**
 * Replace absolute session directory paths with the portable token, and nothing
 * else. The half of {@link makeSessionPathPortable} that is idempotent.
 *
 * Split out for `bundle.ts`, which applies the transform a second time to a line
 * it read back from disk (defence in depth against a managed storage path
 * leaving the server inside an export envelope). That line's literals were
 * escaped when it was written; escaping it again would add a second marker and
 * the importer would read the token one level short.
 *
 * ## The residue this does NOT fix, and cannot
 *
 * This is still a raw `replaceAll` over a SERIALIZED JSON line, so it cannot
 * tell a structured path field from prose. Shape 2 of the P2.217 measurement
 * therefore stands: on a session MOVED between machines, prose quoting the OLD
 * absolute path is rewritten to the NEW one — *"I saved it under
 * /Users/alice/…/out.txt"* becomes *"…/Users/bob/…/out.txt"* — which is right
 * for a `storedPath` and wrong for a sentence. Separating those needs a walk
 * over the parsed message's string values, not a line rewrite; the same shape is
 * recorded on `remapBranchedMessagePaths` in `SessionManager.ts`.
 */
export function tokenizeSessionDir(jsonLine: string, sessionDir: string): string {
  if (!sessionDir) return jsonLine;
  const normalized = normalizePath(sessionDir);
  let result = jsonLine.replaceAll(normalized, SESSION_PATH_TOKEN);
  // On Windows, also replace JSON-escaped backslash paths
  // (JSON.stringify escapes \ to \\, so C:\foo becomes C:\\foo in JSON strings)
  if (sessionDir !== normalized) {
    const jsonEscaped = sessionDir.replaceAll('\\', '\\\\');
    result = result.replaceAll(jsonEscaped, SESSION_PATH_TOKEN);
  }
  return result;
}

/**
 * Replace absolute session directory paths with a portable token.
 * Applied after JSON.stringify so paths embedded anywhere in message content
 * (datatable src, planPath, attachment storedPath, etc.) are made portable.
 *
 * ## P3.324 — the on-disk format decision, stated here because this is the site
 *
 * P2.217 measured, at HEAD, that a message whose text literally contains
 * `{{SESSION_PATH}}` — a model writes one trivially, and this repo's own
 * documentation contains the string — survived the write untouched and was
 * EXPANDED into an absolute filesystem path on read, in the SAME session
 * directory, with no move involved. `see {{SESSION_PATH}}/notes.md` read back as
 * `see /Users/…/sessions/s1/notes.md`: valid JSON, wrong content, and the reader
 * had no way to tell a token this function wrote from one the user typed.
 *
 * **The decision is ESCAPE ON WRITE, not a new sentinel.** A sentinel only the
 * new writer emits would still leave the reader expanding the OLD token, so a
 * user-typed `{{SESSION_PATH}}` in a NEW record would go on being expanded —
 * the sentinel moves the problem rather than closing it. Escaping closes it for
 * every record written from here on, in one bijection, with no per-record
 * version field and no migration pass over anybody's session directory.
 *
 * ## What round-trip identity now means, in both directions
 *
 *  - **A record written by this writer**: `expandSessionPath(write(line), dir)`
 *    is `line`, for every line — including one containing the bare token, one
 *    containing an already-escaped token at any depth, and one containing the
 *    session directory itself.
 *  - **A record written before this change**: reading is UNCHANGED. Its tokens
 *    carry no marker, so they expand exactly as they did.
 *  - **The one loss, and it is not recoverable by any reader**: in an OLD record
 *    a user-typed `{{SESSION_PATH}}` was written identically to a real path's
 *    token. The information was destroyed at write time in 2024-era records and
 *    in every record until this commit; nothing here can bring it back, and
 *    pretending otherwise would need a format version those records do not have.
 *
 * The write transform is therefore NOT idempotent — see {@link tokenizeSessionDir}
 * for the one call site that needs the idempotent half.
 */
export function makeSessionPathPortable(jsonLine: string, sessionDir: string): string {
  return tokenizeSessionDir(escapeLiteralSessionPathTokens(jsonLine), sessionDir);
}

/**
 * Expand the portable session path token back to an absolute path, and strip one
 * escape marker from every literal token beside it.
 *
 * Applied before JSON.parse so all path references resolve correctly at runtime.
 * ONE pass over the family, deliberately: expanding and unescaping as two
 * sequential passes would let the second pass see what the first produced and
 * expand a token the writer had escaped.
 */
export function expandSessionPath(jsonLine: string, sessionDir: string): string {
  if (!jsonLine.includes(SESSION_PATH_TOKEN_PREFIX)) return jsonLine;
  const expansion = normalizePath(sessionDir);
  // A replacer FUNCTION rather than a string: an expansion containing `$&` or
  // `$1` — a session directory may legally contain a `$` — would otherwise be
  // read as a replacement pattern. The `replaceAll(token, path)` this replaced
  // had that hazard.
  return jsonLine.replace(SESSION_PATH_TOKEN_FAMILY, (_match, markers: string) => (
    markers.length === 0
      ? expansion
      : `${SESSION_PATH_TOKEN_PREFIX}${markers.slice(SESSION_PATH_ESCAPE.length)}}}`
  ));
}

function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string') return undefined;
  return parsePermissionMode(value) ?? undefined;
}

/**
 * Alias-resolve one NESTED mode field in place. Unlike the two header fields,
 * an unknown spelling is left AS-IS (never deleted): these fields sit inside
 * required structures (`deferredToolCall.permissionMode` is non-optional), and
 * every downstream consumer already treats an unknown mode defensively
 * (`clampPermissionModeToParent` falls back to the parent). Normalizing only
 * resolvable spellings keeps the unknown-mode behavior exactly as before.
 */
function normalizeNestedPermissionMode(holder: unknown, key: string): void {
  if (!holder || typeof holder !== 'object') return;
  const record = holder as Record<string, unknown>;
  const normalized = normalizePermissionMode(record[key]);
  if (normalized) record[key] = normalized;
}

type HeaderModeFields = Pick<SessionHeader, 'permissionMode' | 'previousPermissionMode' | 'planModeState' | 'piChildRestrictions' | 'deferredToolCall' | 'childSessionState'>;

/**
 * Read every persisted mode in a session header through `parsePermissionMode`,
 * so a retired spelling (`explore`, `safe`) comes back as `plan` (F1.1050).
 * THE one header-mode normalizer: this module's readers, store-v2's `list()`
 * and `load()`, and the bundle import (the same record from another machine)
 * all call it. F1.1234: store-v2 used to skip it, so the startup restore
 * handed the mode manager a raw `explore` and the composer showed Manual.
 */
export function normalizeHeaderPermissionModes<T extends HeaderModeFields>(header: T): T {
  const permissionMode = normalizePermissionMode(header.permissionMode);
  const previousPermissionMode = normalizePermissionMode(header.previousPermissionMode);

  if (permissionMode) {
    header.permissionMode = permissionMode;
  } else {
    delete (header as Partial<HeaderModeFields>).permissionMode;
  }

  if (previousPermissionMode) {
    header.previousPermissionMode = previousPermissionMode;
  } else {
    delete (header as Partial<HeaderModeFields>).previousPermissionMode;
  }

  // The four nested mode fields persisted inside the header. These used to
  // come back raw (never normalized), so a spelling change would have leaked
  // stale vocabulary into the clamp and the deferred-call restore.
  normalizeNestedPermissionMode(header.planModeState, 'previousMode');
  normalizeNestedPermissionMode(header.piChildRestrictions, 'permissionMode');
  normalizeNestedPermissionMode(header.deferredToolCall, 'permissionMode');
  for (const child of header.childSessionState?.children ?? []) {
    normalizeNestedPermissionMode(child?.restrictions, 'permissionMode');
  }

  return header;
}

/**
 * Read only the header (first line) from a session.jsonl file.
 * Uses low-level fs to read minimal bytes for fast list loading.
 */
export function readSessionHeader(sessionFile: string): SessionHeader | null {
  try {
    const fd = openSync(sessionFile, 'r');
    try {
      const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_CHUNK_BYTES);
      const decoder = new StringDecoder('utf8');
      let firstLine = '';
      let position = 0;

      while (true) {
        const bytesToRead = Math.min(buffer.length, MAX_SESSION_HEADER_BYTES + 1 - position);
        const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
        if (bytesRead === 0) break;

        const chunk = buffer.subarray(0, bytesRead);
        const newline = chunk.indexOf(0x0a);
        const lineBytes = newline === -1 ? bytesRead : newline;
        if (position + lineBytes > MAX_SESSION_HEADER_BYTES) {
          throw new Error('session-header-too-large');
        }
        firstLine += decoder.write(chunk.subarray(0, lineBytes));
        if (newline !== -1) {
          firstLine += decoder.end();
          return parseSessionHeaderLine(firstLine, sessionFile);
        }

        position += bytesRead;
      }

      firstLine += decoder.end();
      return parseSessionHeaderLine(firstLine, sessionFile);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    debug('[jsonl] Failed to read session header:', sessionFile, error);
    return null;
  }
}

/**
 * Read full session from JSONL file.
 * Parses header and all message lines.
 */
export function readSessionJsonl(sessionFile: string): StoredSession | null {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const firstLine = lines[0];
    if (!firstLine) return null;

    const sessionDir = dirname(sessionFile);
    const header = normalizeHeaderPermissionModes(
      safeJsonParse(expandSessionPath(firstLine, sessionDir)) as SessionHeader
    );
    // Parse messages resiliently: skip lines that fail to parse (e.g. truncated by crash)
    // rather than losing the entire session's messages.
    // Expand session path tokens before parsing so embedded paths resolve correctly.
    const expandedMessageLines = lines.slice(1).map(line => expandSessionPath(line, sessionDir));
    const messages = parseMessagesResilient(expandedMessageLines);

    // Migration: For sessions created before sdkCwd was added, use workingDirectory as fallback.
    // This is correct because the old code used workingDirectory for SDK's cwd parameter.
    const workingDir = header.workingDirectory ? expandPath(header.workingDirectory) : undefined;
    const sdkCwd = header.sdkCwd ? expandPath(header.sdkCwd) : workingDir;

    return {
      ...pickSessionFields(header),
      // Path expansion for portable paths (external project paths only)
      workingDirectory: workingDir,
      sdkCwd,
      // Runtime fields
      messages,
      tokenUsage: header.tokenUsage,
    } as StoredSession;
  } catch (error) {
    debug('[jsonl] Failed to read session:', sessionFile, error);
    return null;
  }
}

/**
 * Write session to JSONL format using atomic write (write-to-temp-then-rename).
 * Prevents file corruption if the process crashes mid-write: either the old
 * file remains intact or the new file is fully written. Never a partial file.
 *
 * Line 1: Header with pre-computed metadata
 * Lines 2+: Messages (one per line)
 */
export function writeSessionJsonl(sessionFile: string, session: StoredSession): void {
  const header = createSessionHeader(session);
  const sessionDir = dirname(sessionFile);

  const lines = [
    makeSessionPathPortable(JSON.stringify(header), sessionDir),
    ...session.messages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
  ];

  const tmpFile = sessionFile + '.tmp';
  writeFileSync(tmpFile, lines.join('\n') + '\n');
  // On Windows, rename fails if target exists. Delete first for cross-platform compatibility.
  try { unlinkSync(sessionFile); } catch { /* ignore if doesn't exist */ }
  renameSync(tmpFile, sessionFile);
}

/**
 * Create a SessionHeader from a StoredSession.
 * Pre-computes messageCount, preview, and lastMessageRole for fast list loading.
 * Uses pickSessionFields() to ensure all persistent fields are included.
 */
export function createSessionHeader(session: StoredSession): SessionHeader {
  return {
    ...pickSessionFields(session),
    // Override lastUsedAt with current timestamp (save time, not original)
    lastUsedAt: Date.now(),
    // Pre-computed fields
    messageCount: session.messages.length,
    lastMessageRole: extractLastMessageRole(session.messages),
    preview: extractPreview(session.messages),
    // P6.504 · derived, never model-written — see `session-activity-summary.ts`.
    lastOutputSummary: summarizeSessionOutput(session.messages),
    tokenUsage: session.tokenUsage,
    lastFinalMessageId: extractLastFinalMessageId(session.messages),
  } as SessionHeader;
}

/**
 * Extract the role of the last message for badge display.
 * Only returns roles that are meaningful for UI display (user, assistant, plan, tool, error).
 */
function extractLastMessageRole(messages: StoredMessage[]): SessionHeader['lastMessageRole'] {
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return undefined;
  // Map message types to the subset we care about for display
  const role = lastMessage.type;
  if (role === 'user' || role === 'assistant' || role === 'plan' || role === 'tool' || role === 'error') {
    return role;
  }
  return undefined;
}

/**
 * Extract the ID of the last final (non-intermediate) assistant message.
 * Used for unread detection in session list without loading all messages.
 */
function extractLastFinalMessageId(messages: StoredMessage[]): string | undefined {
  // Walk backwards to find the last assistant message that isn't intermediate
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type === 'assistant' && !msg.isIntermediate) {
      return msg.id;
    }
  }
  return undefined;
}

/**
 * Extract preview from first user message.
 * Sanitizes by stripping special blocks and normalizing whitespace.
 * Returns first 150 chars.
 */
function extractPreview(messages: StoredMessage[]): string | undefined {
  const firstUserMessage = messages.find(m => m.type === 'user');
  if (!firstUserMessage?.content) return undefined;

  // Sanitize: strip special blocks, tags, and bracket mentions, normalize whitespace
  const sanitized = firstUserMessage.content
    .replace(/<edit_request>[\s\S]*?<\/edit_request>/g, '') // Strip entire edit_request blocks
    .replace(/<[^>]+>/g, '')     // Strip remaining XML/HTML tags
    .replace(/\[skill:[^\]\r\n]+\]/g, '')   // Strip [skill:...] mentions
    .replace(/\[source:[\w-]+\]/g, '')              // Strip [source:...] mentions
    .replace(/\[file:[^\]]+\]/g, '')                // Strip [file:...] mentions
    .replace(/\[folder:[^\]]+\]/g, '')              // Strip [folder:...] mentions
    .replace(/\s+/g, ' ')        // Collapse whitespace (including newlines)
    .trim();

  return sanitized.substring(0, 150) || undefined;
}

/**
 * Async version of readSessionHeader for parallel I/O.
 * Uses fs/promises for non-blocking reads.
 */
export async function readSessionHeaderAsync(sessionFile: string): Promise<SessionHeader | null> {
  try {
    const handle = await open(sessionFile, 'r');
    try {
      const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_CHUNK_BYTES);
      const decoder = new StringDecoder('utf8');
      let firstLine = '';
      let position = 0;

      while (true) {
        const bytesToRead = Math.min(buffer.length, MAX_SESSION_HEADER_BYTES + 1 - position);
        const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
        if (bytesRead === 0) break;

        const chunk = buffer.subarray(0, bytesRead);
        const newline = chunk.indexOf(0x0a);
        const lineBytes = newline === -1 ? bytesRead : newline;
        if (position + lineBytes > MAX_SESSION_HEADER_BYTES) {
          throw new Error('session-header-too-large');
        }
        firstLine += decoder.write(chunk.subarray(0, lineBytes));
        if (newline !== -1) {
          firstLine += decoder.end();
          return parseSessionHeaderLine(firstLine, sessionFile);
        }

        position += bytesRead;
      }

      firstLine += decoder.end();
      return parseSessionHeaderLine(firstLine, sessionFile);
    } finally {
      await handle.close();
    }
  } catch (error) {
    debug('[jsonl] Failed to read session header async:', sessionFile, error);
    return null;
  }
}

function parseSessionHeaderLine(firstLine: string, sessionFile: string): SessionHeader {
  const parsed = safeJsonParse(expandSessionPath(firstLine, dirname(sessionFile))) as SessionHeader;
  return normalizeHeaderPermissionModes(parsed);
}

/**
 * Read only messages from a JSONL file (skips header).
 * Used for lazy loading when session is selected.
 * Resilient to corrupted/truncated lines (skips them instead of failing entirely).
 */
export function readSessionMessages(sessionFile: string): StoredMessage[] {
  try {
    const content = readFileSync(sessionFile, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    // Skip first line (header), expand session path tokens, parse rest as messages resiliently
    const sessionDir = dirname(sessionFile);
    const expandedLines = lines.slice(1).map(line => expandSessionPath(line, sessionDir));
    return parseMessagesResilient(expandedLines);
  } catch (error) {
    debug('[jsonl] Failed to read session messages:', sessionFile, error);
    return [];
  }
}

/**
 * Parse message lines resiliently: skip lines that fail JSON.parse
 * (e.g. truncated by a crash mid-write) rather than losing all messages.
 */
function parseMessagesResilient(lines: string[]): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as StoredMessage);
    } catch {
      // Corrupted/truncated line (likely from a crash during write).
      // Skip it and continue — losing one message is better than losing all.
      debug('[jsonl] Skipping corrupted message line (truncated?):', line.substring(0, 100));
    }
  }
  return messages;
}
