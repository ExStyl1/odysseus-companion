import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import {
  AUTO_MEMORY_KINDS,
  type AutoMemoryKind,
  isAutoMemoryKind,
  measureMemoryIndex,
  memoryIndexWriteNotice,
  stampMemoryModified,
  stampMemoryType,
} from '../memory-index.ts';

export interface RememberArgs {
  memory: string;
  scope?: 'session' | 'project' | 'user';
  /**
   * Which of the four documented kinds of note this is (P6.389).
   *
   * `memory.md`: *"Claude saves four kinds of notes for itself. Claude records
   * the kind as a `type` field in the memory file's frontmatter"*. Optional so
   * every existing caller stays valid and an untyped write still saves — the
   * kind is a label on the note, never a gate on remembering it.
   *
   * Typed as `string` rather than the union because the value arrives from a
   * model over a tool schema: narrowing it here would make an unknown kind a
   * type error at a boundary that has no types, instead of the named refusal
   * below.
   */
  type?: string;
}

export const MEMORY_FILE_NAME = 'MEMORY.md';

/**
 * Machine marker appended to agent-written memory entries so the scheduled
 * cleanup pass can tell them apart from human-written lines (which are never
 * touched). The format is mirrored in
 * `packages/shared/src/agent/memory/memory-store.ts` (stripped at load, before
 * dedup, so it never reaches the prompt) and `memory-cleanup.ts` — keep in sync.
 */
const AUTO_MEMORY_MARKER_RE = /<!-- nessy:auto:\d{4}-\d{2}-\d{2} -->/g;

function autoMemoryMarker(date = new Date()): string {
  return `<!-- nessy:auto:${date.toISOString().slice(0, 10)} -->`;
}

function formatMemoryFile(existing: string, memory: string): string {
  // Strip marker lookalikes from the input so the trailing marker stays the
  // single machine-readable one on the entry.
  const trimmed = memory.replace(AUTO_MEMORY_MARKER_RE, '').trim();
  if (!trimmed) return existing;
  const entry = `- ${trimmed.replace(/\r?\n/g, '\n  ')} ${autoMemoryMarker()}`;
  if (!existing.trim()) {
    return `# Memory\n\n${entry}\n`;
  }
  return `${existing.trimEnd()}\n\n${entry}\n`;
}

/**
 * Append one entry and return the file contents as written, or `null` when
 * nothing was written.
 *
 * The return value is what `handleRemember` measures, so the measurement is of
 * the exact bytes this call left on disk — re-reading the file would race a
 * concurrent writer and could report someone else's overflow as this write's.
 */
function appendMemory(filePath: string, memory: string, kind?: AutoMemoryKind): string | null {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const formatted = formatMemoryFile(existing, memory);
  // Stamp AFTER the no-op guard, never before: `formatMemoryFile` returns its
  // input unchanged when the entry strips to nothing (a marker lookalike is the
  // reachable case), and stamping first would rewrite the file with a fresh
  // timestamp for no recorded fact.
  if (formatted === existing) return null;
  // `type` BEFORE `modified`, so a file that gains its frontmatter from this
  // write also gets stamped: `stampMemoryModified` only writes into a block
  // that already exists, by design.
  const next = stampMemoryModified(kind ? stampMemoryType(formatted, kind) : formatted);

  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, next, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, filePath);
  chmodSync(filePath, 0o600);
  return next;
}

function getMemoryPath(ctx: SessionToolContext, scope: RememberArgs['scope']): string | null {
  switch (scope ?? 'session') {
    case 'session':
      return ctx.dataPath ? join(ctx.dataPath, MEMORY_FILE_NAME) : null;
    case 'project':
      // P-WJ-c-2 · ABSOLUTE, not merely non-empty. `join` on a relative value
      // resolves against THIS PROCESS's own working directory — the codex
      // child's, or the app's — which no caller chose, so a `workingDirectory`
      // of `docs` would quietly write a memory index somewhere nobody asked
      // for. The guard sits HERE rather than in one of the three binders (pi's
      // `getSessionToolContext`, claude's `getSessionScopedTools(...)` call
      // site, the codex child's `--working-directory`): none of them checks,
      // so a check on one runtime would manufacture the silent divergence the
      // host exists to remove.
      return ctx.workingDirectory && isAbsolute(ctx.workingDirectory)
        ? join(ctx.workingDirectory, MEMORY_FILE_NAME)
        : null;
    case 'user':
      return ctx.userMemoryPath ?? null;
  }
}

function getMissingScopeMessage(ctx: SessionToolContext, scope: RememberArgs['scope']): string {
  switch (scope ?? 'session') {
    case 'session':
      return 'remember requires dataPath in context.';
    case 'project':
      // Two faults, two sentences. "This session chose no project" is what all
      // three runtimes already answer and it stays BYTE-IDENTICAL — it is
      // quoted in the codex child's own context docblock and asserted over the
      // real transport by `remember-scopes.test.ts`. A non-empty RELATIVE value
      // is a different fault: the host bound something the user cannot see, so
      // the refusal carries it.
      return ctx.workingDirectory
        ? `remember with scope=project requires an ABSOLUTE workingDirectory in context; got ${JSON.stringify(ctx.workingDirectory)}.`
        : 'remember with scope=project requires workingDirectory in context.';
    case 'user':
      return 'remember with scope=user requires userMemoryPath in context.';
  }
}

export async function handleRemember(
  ctx: SessionToolContext,
  args: RememberArgs
): Promise<ToolResult> {
  if (ctx.memoryEnabled === false) {
    return errorResponse('Memory is disabled for this workspace.');
  }
  const memory = args.memory.trim();
  if (!memory) {
    return errorResponse('memory must not be empty.');
  }

  // An unknown kind is refused BY NAME rather than dropped: writing the note
  // without the label would leave a memory the documented format cannot
  // classify, and silently ignoring the argument teaches the model that the
  // field does nothing.
  if (args.type !== undefined && !isAutoMemoryKind(args.type)) {
    return errorResponse(
      `remember: unknown type ${JSON.stringify(args.type)}. Use one of ${AUTO_MEMORY_KINDS.join(', ')}.`,
    );
  }

  const filePath = getMemoryPath(ctx, args.scope);
  if (!filePath) {
    return errorResponse(getMissingScopeMessage(ctx, args.scope));
  }

  const written = appendMemory(filePath, memory, args.type as AutoMemoryKind | undefined);
  const saved = `Saved memory to ${filePath}`;
  // Nothing on disk changed, so no write "left the index" anywhere — the
  // documented measurement is of what THIS write produced (`memory.md:386`).
  if (written === null) return successResponse(saved);

  const notice = memoryIndexWriteNotice(filePath, measureMemoryIndex(written));
  // ONE result shape for the over-limit case, chosen once because f103 and f166
  // disagreed: an ERROR result, and the write is NOT rolled back.
  // `memory.md:386` — "If the file is over a limit, the write still succeeds,
  // but Claude Code returns an error telling Claude to rewrite the index";
  // `errors.md:1541` files it as an error entry and `:1551` says it is
  // "delivered to Claude after the write". So the error is advisory to the
  // model, never a failure of the save, and the message text says so on its own
  // (see `response.ts` — `isError` is invisible on the Codex/Responses path).
  if (notice.level === 'over') return errorResponse(notice.message);
  if (notice.level === 'near') return successResponse(`${saved}. ${notice.message}`);
  return successResponse(saved);
}
