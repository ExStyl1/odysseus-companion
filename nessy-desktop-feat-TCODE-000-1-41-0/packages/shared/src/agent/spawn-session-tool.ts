/**
 * Spawn Session Tool (spawn_session)
 *
 * Session-scoped tool that enables the main agent to create independent sessions
 * with configurable connection, model, sources, and an initial prompt.
 *
 * Two modes:
 * - help=true: Returns available connections, models, and sources
 * - Default: Creates a session and sends the prompt (fire-and-forget)
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { partitionSourceSlugs } from '../protocol/source-slugs.ts';
import type { SpawnSessionResult, SpawnSessionHelpResult } from './base-agent.ts';

export type SpawnSessionFn = (input: Record<string, unknown>) => Promise<SpawnSessionResult | SpawnSessionHelpResult>;

// Tool result type - matches what the SDK expects
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface SpawnSessionToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for the spawn session callback.
   * Called at execution time to get the current callback from the session registry.
   */
  getSpawnSessionFn: () => SpawnSessionFn | undefined;
}

export const SPAWN_SESSION_TOOL_INPUT_SCHEMA = z.object({
  help: z.boolean().optional()
    .describe('If true, returns available connections, models, and sources instead of creating a session'),
  prompt: z.string().optional()
    .describe('Instructions for the new session (required when not in help mode)'),
  name: z.string().optional()
    .describe('Session name'),
  llmConnection: z.string().optional()
    .describe('Connection slug (e.g., "anthropic-api", "codex")'),
  model: z.string().optional()
    .describe('Model ID override'),
  /**
   * P2.510 — the model's own error message, and why it is a field REFINEMENT.
   *
   * Every entry here is used as a path segment by `getSourcePath`, and
   * `f2a4598f6` measured what that costs when nothing checks it: a slug of
   * `..` followed by `..` loaded a `permissions.json` from OUTSIDE the
   * workspace and merged its allows into the session's policy. Source configs
   * are additive, so a slug the model chose could only ever widen.
   *
   * That escape is contained at the merge, which is where it had to be, and
   * this refinement CLOSES NOTHING ON ITS OWN. This schema is one of several
   * routes onto `managed.enabledSourceSlugs`: the stored-session replay and the
   * workspace default reach the same field without passing through any tool
   * schema. Defence in depth, not the closure.
   *
   * What it buys is the most visible possible answer. The SDK validates tool
   * input against this schema and hands the caller back `Invalid arguments for
   * tool spawn_session: ...` as an error result, so a bad entry is reported to
   * the MODEL THAT CHOSE IT instead of being dropped somewhere it cannot see.
   *
   * By INDEX and closed reason, never by value — `RejectedSourceSlug`'s rule,
   * for the reason it records. Zod's issue `path` already carries
   * `enabledSourceSlugs` and the index, so the entry is named exactly without
   * echoing externally-authored text back out.
   *
   * Refined on the FIELD and not on the object, because `createSpawnSessionTool`
   * hands the SDK `SPAWN_SESSION_TOOL_INPUT_SCHEMA.shape`: an object-level
   * refinement is not part of `.shape` and would be discarded silently. The
   * refinement is invisible to JSON-Schema conversion, so the tool schema the
   * model reads is unchanged.
   */
  enabledSourceSlugs: z.array(z.string())
    .superRefine((slugs, ctx) => {
      for (const { index, reason } of partitionSourceSlugs(slugs).rejected) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `enabledSourceSlugs[${index}] is not a usable source slug (${reason}); a slug must name a direct child of the workspace sources directory`,
        });
      }
    })
    .optional()
    .describe('Source slugs to enable in the new session'),
  permissionMode: z.enum(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']).optional() // F1.1050: the six Claude modes a model may request
    .describe('Permission mode for the new session'),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the workspace default.'),
  labels: z.array(z.string()).optional()
    .describe('Labels for the new session'),
  workingDirectory: z.string().optional()
    .describe('Working directory for the new session'), projectId: z.string().optional().describe('Workspace project id to bind the new session to. Inherits the project working directory unless overridden.'), // UA5.4 — v0.13.4, verbatim; on this line so the cited line 103 keeps its number. The host allows a folderless project or one bound to this session's folder.
  ephemeral: z.boolean().optional()
    .describe('Do not persist this child session'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional()
    .describe('Files to include with the prompt'),
});

export function createSpawnSessionTool(options: SpawnSessionToolOptions) {
  return tool(
    'spawn_session',
    `Create a new session that runs independently with its own prompt, connection, model, and sources.

Use this to delegate tasks to parallel sessions — research, analysis, drafts, or any work that benefits from separate context.

Call with help=true first to discover available connections, models, and sources.
When spawning, the 'prompt' parameter is required.

Optional overrides: model, llmConnection, permissionMode, thinkingLevel, enabledSourceSlugs, labels, workingDirectory, ephemeral. Omitted fields inherit from the spawning session or the workspace default.

thinkingLevel is silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash) — the SDK drops the reasoning param rather than erroring.

The spawned session appears in the session list and runs fire-and-forget.
Only use 'attachments' for existing file paths on disk — the tool reads them automatically.`,
    SPAWN_SESSION_TOOL_INPUT_SCHEMA.shape,
    async (args) => {
      const spawnFn = options.getSpawnSessionFn();
      if (!spawnFn) {
        return errorResponse('spawn_session is not available in this context.');
      }

      try {
        const result = await spawnFn(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`spawn_session failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
