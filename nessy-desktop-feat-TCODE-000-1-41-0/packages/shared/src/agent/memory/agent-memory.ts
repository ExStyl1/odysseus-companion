/**
 * PER-AGENT persistent memory: the directory a subagent's `memory:` frontmatter
 * names, and the prompt block that directory produces at spawn.
 *
 * `sub-agents.md:500` — "The `memory` field gives the subagent a persistent
 * directory that survives across conversations. The subagent uses this directory
 * to build up knowledge over time, such as codebase patterns, debugging
 * insights, and architectural decisions." The scope table at `:517-519` fixes
 * the three locations, and `:523-527` fixes what happens when memory is enabled:
 *
 * - ":525 The subagent's system prompt includes instructions for reading and
 *   writing to the memory directory."
 * - ":526 The subagent's system prompt also includes the first 200 lines or 25KB
 *   of `MEMORY.md` in the memory directory, whichever comes first, with
 *   instructions to curate `MEMORY.md` if it exceeds that limit."
 * - ":527 Read, Write, and Edit tools are automatically enabled so the subagent
 *   can manage its memory files."
 *
 * `:521` makes all three inert together — "if you turn auto memory off, with the
 * `autoMemoryEnabled` setting or `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, the `memory`
 * field has no effect and the subagent launches without the memory instructions
 * or the memory tool access described below." {@link getMemoryEnabled} is this
 * fork's `autoMemoryEnabled`, and it gates the whole module: when it is off
 * {@link prepareAgentMemoryDirectory} returns `undefined`, nothing is created,
 * no block is emitted and the caller grants no tools.
 *
 * WHY THIS IS A SEPARATE MODULE from `memory-store.ts`. Per-agent memory must
 * never merge into the session tier. `loadMemoryPromptBlock` dedups
 * session/user/project `MEMORY.md` through one `seenMemoryFiles` set and emits
 * ONE block for the conversation; folding a subagent's private index into it
 * would cross-contaminate the main session, which is exactly what the page's
 * "separate from your main session auto memory" (`claude-directory.md`, the
 * `agent-memory/` node) forbids. The two subsystems share the LIMITS
 * (`@nessy-agent/session-tools-core`) and nothing else.
 *
 * The caps come from `capMemoryIndexLoad`/`memoryIndexLoadedContent` in
 * `@nessy-agent/session-tools-core` — the one place the 200-line and 25 KiB
 * limits live since R56. `readMemoryFile` is deliberately NOT reused here: it is
 * line-only by a recorded decision (its docblock), because byte-capping it would
 * change which files become `memory` capability RECORDS for every user with a
 * large `MEMORY.md`.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MEMORY_LOAD_BYTE_LIMIT,
  MEMORY_LOAD_LINE_LIMIT,
  measureMemoryIndex,
  memoryIndexLoadedContent,
} from '@nessy-agent/session-tools-core';
import type { AgentMemoryScope } from '../../agents/definitions.ts';
import { CONFIG_DIR, getMemoryEnabled } from '../../config/storage.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../../projects/nessy-agent-layout.ts';
import { MEMORY_FILE_NAME } from './memory-store.ts';
import type { SessionMemoryScope } from './session-memory-scope.ts';

/**
 * `sub-agents.md:518` — `.claude/agent-memory/<name-of-agent>/`. Ours hangs off
 * `.nessy-agent` (project) and `CONFIG_DIR` (user), the fork's two namespaces.
 */
export const AGENT_MEMORY_DIR = 'agent-memory';

/**
 * `sub-agents.md:519` — `local` "writes to `.claude/agent-memory-local/`
 * instead" so the knowledge "shouldn't be checked into version control".
 */
export const AGENT_MEMORY_LOCAL_DIR = 'agent-memory-local';

/**
 * The three tools `:527` enables, in this fork's lowercase Pi spelling (the same
 * names `FULL_TOOLS` uses in `agents/definitions.ts`).
 */
export const AGENT_MEMORY_TOOLS: readonly string[] = Object.freeze(['read', 'write', 'edit']);

/** A resolved, live per-agent memory directory and what loaded from its index. */
export interface AgentMemoryContext {
  scope: AgentMemoryScope;
  /** Absolute path; created if it did not exist. */
  directory: string;
  /** Absolute path of `MEMORY.md` inside it, whether or not it exists yet. */
  indexPath: string;
  /** The capped index content — '' when the file is absent or empty. */
  content: string;
  /** Whether a cap actually cut something (`:526`'s curate instruction). */
  truncated: boolean;
}

/**
 * One filesystem segment from an agent name.
 *
 * Imported Claude/Codex plugin agents arrive with keys and names that can carry
 * `:` and `/` (`runtime-agent-definition.ts`'s plugin route), and this value
 * becomes a directory name — so this is containment, not cosmetics. Anything
 * outside `[A-Za-z0-9._-]` collapses to `-`, leading dots are dropped so `..`
 * and dotfiles are unreachable, and the result is length-bounded.
 */
export function sanitizeAgentMemorySegment(agentName: string): string {
  const collapsed = agentName.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return collapsed.slice(0, 96);
}

export interface AgentMemoryPathOptions {
  /**
   * The PARENT session's project root. Never a worktree path: an
   * `isolation: worktree` child's checkout is a throwaway lease, so a
   * project/local directory derived from it would vanish with the worktree and
   * cross-session learning would silently never persist for exactly the agents
   * most likely to declare it.
   */
  projectRoot?: string;
  configDir?: string;
}

/**
 * The absolute directory for one agent's memory, or `undefined` when the scope
 * cannot be resolved (a project/local scope on a session with no project root,
 * or a name that sanitizes to nothing).
 */
export function getAgentMemoryDirPath(
  scope: AgentMemoryScope,
  agentName: string,
  options: AgentMemoryPathOptions = {},
): string | undefined {
  const segment = sanitizeAgentMemorySegment(agentName);
  if (!segment) return undefined;
  if (scope === 'user') return join(options.configDir ?? CONFIG_DIR, AGENT_MEMORY_DIR, segment);
  if (!options.projectRoot) return undefined;
  const namespace = join(options.projectRoot, NESSY_AGENT_PROJECT_DIR);
  return scope === 'local'
    ? join(namespace, AGENT_MEMORY_LOCAL_DIR, segment)
    : join(namespace, AGENT_MEMORY_DIR, segment);
}

/**
 * Refuse a symlinked path on the way to the memory directory.
 *
 * Same rule `cron-store.ts` applies to `.nessy-agent` before it writes there,
 * checked with `lstat` so the link itself is inspected rather than its target; a
 * missing path is fine, because it is about to be created as a real directory.
 * The helper there is private to that module and its error type is scheduling
 * specific, so the RULE is reused rather than the function.
 */
function hasSymlinkOnPath(directory: string, projectRoot: string | undefined): boolean {
  const candidates = projectRoot
    ? [join(projectRoot, NESSY_AGENT_PROJECT_DIR), directory]
    : [directory];
  return candidates.some(path => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true);
}

/**
 * Resolve, create and read one agent's memory directory, or return `undefined`
 * when per-agent memory does not apply to this spawn.
 *
 * `undefined` — not a throw — for every failure: auto memory off (`:521`), an
 * unresolvable scope, a symlinked namespace, or any filesystem error. The
 * refusal is of the FEATURE, not of the spawn: the caller's contract is that no
 * context means no prompt block AND no tool grant, so an agent is never told it
 * has a memory it cannot reach, and a task never dies because a directory could
 * not be made. (`cron-store` throws on a symlink because scheduling IS the
 * user's request; here the user's request is the task.)
 */
export function prepareAgentMemoryDirectory(
  scope: AgentMemoryScope | undefined,
  agentName: string,
  options: AgentMemoryPathOptions & {
    /**
     * P6.390(1) — the SPAWNING chat's resolved memory scope. A subagent's
     * private directory is still this chat's memory, so a chat kept out of
     * memory keeps its subagents out too. Absent ⇒ the global switch alone,
     * which is every existing caller.
     */
    memoryScope?: SessionMemoryScope;
  } = {},
): AgentMemoryContext | undefined {
  if (!scope) return undefined;
  const directory = getAgentMemoryDirPath(scope, agentName, options);
  if (!directory) return undefined;
  try {
    // Inside the `try`: `getMemoryEnabled` reads config.json and THROWS on an
    // unsupported layout, and a corrupt config must not be able to kill every
    // spawn of an agent that happens to declare `memory:`.
    if (!(options.memoryScope ? options.memoryScope.read : getMemoryEnabled())) return undefined;
    if (hasSymlinkOnPath(directory, scope === 'user' ? undefined : options.projectRoot)) return undefined;
    mkdirSync(directory, { recursive: true });
    // `claude-directory.md` marks `agent-memory/` committed and
    // `agent-memory-local/` the keep-it-out-of-git alternative. The fork writes
    // no project `.gitignore` anywhere, so the split needs its own mechanism:
    // one `*` file inside the local tree, written once, next to the per-agent
    // directories rather than in the repository's own `.gitignore`.
    if (scope === 'local' && options.projectRoot) {
      const ignorePath = join(options.projectRoot, NESSY_AGENT_PROJECT_DIR, AGENT_MEMORY_LOCAL_DIR, '.gitignore');
      if (!existsSync(ignorePath)) writeFileSync(ignorePath, '*\n', { encoding: 'utf-8' });
    }
    const indexPath = join(directory, MEMORY_FILE_NAME);
    if (!existsSync(indexPath)) return { scope, directory, indexPath, content: '', truncated: false };
    const raw = readFileSync(indexPath, 'utf-8');
    const measured = measureMemoryIndex(raw);
    return {
      scope,
      directory,
      indexPath,
      content: memoryIndexLoadedContent(raw),
      truncated: measured.lines > MEMORY_LOAD_LINE_LIMIT || measured.bytes > MEMORY_LOAD_BYTE_LIMIT,
    };
  } catch {
    return undefined;
  }
}

/**
 * The block `:525`/`:526` require, appended to the child's system prompt.
 *
 * The page states that the instructions and the excerpt exist and states the
 * caps; it quotes no wording, so the text is ours.
 *
 * `writable` is not decoration. The defect this whole change closes is a
 * `toolset: read-only` agent being told to curate a file it has no tool to
 * write, so when the caller's grant did not actually deliver `write` and `edit`
 * (a parent tool ceiling, or an author `disallowedTools` that contradicts the
 * `memory:` declaration) the block says so instead of instructing a write that
 * cannot happen.
 */
export function formatAgentMemoryPromptBlock(
  context: AgentMemoryContext,
  options: { writable: boolean },
): string {
  const lines = [
    '## Agent Memory',
    '',
    `Your own persistent memory directory, which survives across conversations, is \`${context.directory}\`.`,
    'It belongs to you alone: it is not the main session\'s memory, and no other subagent reads it.',
    '',
    options.writable
      ? `Read \`${MEMORY_FILE_NAME}\` there before you start, and record what you learn back into it — codebase patterns, debugging insights, architectural decisions — with the Read, Write and Edit tools. Keep one line per entry and put longer notes in separate files in the same directory.`
      : `Read \`${MEMORY_FILE_NAME}\` there before you start. You have no write access this run, so treat it as reference only and report anything worth keeping in your result instead.`,
    '',
    `### ${MEMORY_FILE_NAME}`,
    '',
  ];
  lines.push(context.content
    ? context.content
    : `(empty — nothing has been recorded for you yet${options.writable ? `; create ${MEMORY_FILE_NAME} in that directory when you have something worth keeping` : ''}.)`);
  if (context.truncated) {
    lines.push(
      '',
      `Only the first ${MEMORY_LOAD_LINE_LIMIT} lines or ${MEMORY_LOAD_BYTE_LIMIT} bytes (25KB) of ${MEMORY_FILE_NAME} load here, whichever comes first, and this copy was cut at that limit — everything past it is invisible to you.`
      + (options.writable
        ? ` Curate it: keep one line per entry, move detail into separate files in ${context.directory}, and merge or drop stale entries.`
        : ''),
    );
  }
  return lines.join('\n');
}
