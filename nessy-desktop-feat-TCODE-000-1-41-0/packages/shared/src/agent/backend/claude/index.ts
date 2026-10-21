/**
 * Claude Agent Module
 *
 * Exports the ClaudeEventAdapter for Claude SDK message → AgentEvent conversion.
 *
 * Note: The main ClaudeAgent class is at ../claude-agent.ts. This index
 * re-exports it alongside the event adapter for convenience.
 */

export { ClaudeAgent } from '../../claude-agent.ts';
export { ClaudeEventAdapter, buildWindowsSkillsDirError } from './event-adapter.ts';
export type { ClaudeAdapterCallbacks } from './event-adapter.ts';
// P2.458 — the worktree seam. Also reachable directly as
// `@nessy-agent/shared/agent/backend/claude/worktree-port` through the
// package's `./agent/backend/*` export, which is how the host lane that
// implements the port will import it.
export { withClaudeWorktreeHooks, screenClaudeWorktreePath, CLAUDE_WORKTREE_HOOK_EVENTS } from './worktree-hooks.ts';
export type { ClaudeWorktreeHookContext } from './worktree-hooks.ts';
export type {
  ClaudeWorktreeCreateOutcome,
  ClaudeWorktreeCreateRequest,
  ClaudeWorktreePort,
  ClaudeWorktreeRemoveRequest,
} from './worktree-port.ts';
