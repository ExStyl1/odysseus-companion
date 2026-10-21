/**
 * UA5.5 — the project-context block, copied from craft-agents-oss
 * `v0.13.4:packages/shared/src/prompts/system.ts` (`PROJECT_BLOCK_TAGS`, `sanitizeProjectBodyText`,
 * `sanitizeProjectLine`, `formatProjectContextForPrompt`; Apache-2.0). Spec §12 "Context".
 *
 * Where it goes (the deviation from upstream, decided under TRANSPARENT and SIMPLE): upstream appends this block to
 * the SYSTEM prompt (`getSystemPrompt`'s `projectContext` argument, rebuilt from `config.json` per turn by
 * `resolveProjectContext` in `claude-agent.ts` / `pi-agent.ts`). Here it is the body of a FILE-BACKED capability
 * layer instead: the host writes it to `{workspaceRoot}/projects/<slug>/context.md` and records its sha256 in the
 * host-approvals ledger (`projects/project-context.ts`), and the capability resolver binds that file as one
 * `instruction` layer, which reaches every runtime through `BaseAgent`'s pinned block. So `system.ts` gets no hunk
 * and no agent carries a `resolveProjectContext` of its own; this module is the formatter alone, beside the
 * sanitiser it uses.
 *
 * Adapted (one change): `memoryPath` is optional (`ProjectPromptContext`, OQ-9). A FOLDERED project has no project
 * memory — the folder's own `.nessy-agent/MEMORY.md` is its memory on all three runtimes (reason (c)) — so with no
 * `memoryPath` the `<project_memory_path>` / `<project_memory>` lines and the four memory-guidance lines are left
 * out. With one, the block is byte-for-byte upstream's (UA5.12 decides when a folderless project carries it).
 */

import type { ProjectPromptContext } from '../projects/types.ts';
import { formatBytes } from '../utils/binary-detection.ts';
import { escapePromptXmlAttr, sanitizePromptBody, sanitizePromptLine } from './prompt-sanitize.ts';

/** Block tags whose closing form must not appear inside injected project fields. */
export const PROJECT_BLOCK_TAGS = [
  'project_context',
  'project_assets_path',
  'project_assets',
  'project_memory_path',
  'project_memory',
] as const;

/** Sanitize a multi-line body field (description/details/memory) before prompt injection. */
function sanitizeProjectBodyText(content: string): string {
  return sanitizePromptBody(content, PROJECT_BLOCK_TAGS);
}

/** Sanitize a single-line label (asset filename/path/MIME type) before prompt injection. */
function sanitizeProjectLine(name: string): string {
  return sanitizePromptLine(name, PROJECT_BLOCK_TAGS);
}

/**
 * Format the project-context block.
 *
 * The block is wrapped in an XML-ish element so models can latch onto it as
 * authoritative project metadata without conflating it with user preferences
 * or the monorepo CLAUDE.md context.
 */
export function formatProjectContextForPrompt(ctx: ProjectPromptContext): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`<project_context project="${escapePromptXmlAttr(ctx.name)}">`);
  if (ctx.description?.trim()) {
    lines.push(sanitizeProjectBodyText(ctx.description.trim()));
    lines.push('');
  }
  if (ctx.details?.trim()) {
    lines.push(sanitizeProjectBodyText(ctx.details.trim()));
    lines.push('');
  }

  lines.push(`<project_assets_path>${sanitizeProjectBodyText(ctx.assetsPath)}</project_assets_path>`);
  if (ctx.assets.length > 0) {
    lines.push('<project_assets>');
    for (const asset of ctx.assets) {
      lines.push(`- ${sanitizeProjectLine(asset.filename)} (${sanitizeProjectLine(asset.mimeType)}, ${formatBytes(asset.sizeBytes)})`);
    }
    lines.push('</project_assets>');
  }

  // UA5.5 adaptation: memory lines only when the project has project memory (module header).
  if (ctx.memoryPath !== undefined) {
    lines.push(`<project_memory_path>${sanitizeProjectBodyText(ctx.memoryPath)}</project_memory_path>`);
    if (ctx.memoryContent?.trim()) {
      lines.push('<project_memory>');
      lines.push(sanitizeProjectBodyText(ctx.memoryContent.trim()));
      lines.push('</project_memory>');
    }
  }
  lines.push('');

  lines.push(`The user has bound this session to the project above.`);
  if (ctx.assets.length > 0) {
    lines.push(`<project_assets> lists reference files the user provided. Read a specific file on-demand by`);
    lines.push(`its absolute path (<project_assets_path> + filename) only when it's relevant — you do not need`);
    lines.push(`to read them all.`);
  }
  if (ctx.memoryPath !== undefined) {
    // UB1.12 — upstream v0.15.1's rewritten guidance (its `prompts/system.ts`): the append-only
    // `project_memory_append` tool replaces the old "record it in MEMORY.md via Write/Edit" line,
    // whose Write rewrite dropped notes other sessions appended meanwhile (the row's measured
    // premise). The memoryPath-optional gate above stays ours (the module header).
    lines.push(`<project_memory> is authoritative accumulated knowledge for this project; treat it as`);
    lines.push(`established context. When you learn something durable (a decision, gotcha, convention, or`);
    lines.push(`project-specific user preference), add a short note with the project_memory_append tool. Never`);
    lines.push(`rewrite MEMORY.md with Write/Edit: other sessions append to it while you work, and <project_memory>`);
    lines.push(`is a snapshot from when this session started. To correct an outdated note, append the correction.`);
  }
  lines.push(`</project_context>`);
  lines.push('');
  return lines.join('\n');
}
