/**
 * Pages tool handlers — list_pages / get_page / create_page / update_page /
 * write_page_data / delete_page.
 *
 * All storage logic (slug generation, digests, SQLite writes, watcher
 * notifications) happens behind the injected ctx.pages callbacks where the page
 * primitives live — this package must stay dependency-free of
 * @nessy-agent/shared (same rule as create_board_task).
 *
 * UA6.3 — copied from craft-agents-oss `v0.13.4:packages/session-tools-core/src/handlers/pages.ts` (Apache-2.0); the
 * six handlers are verbatim (UA8.2 restored the update hint's `refresh`). The schemas and descriptions upstream keeps in
 * `v0.13.4:packages/session-tools-core/src/tool-defs.ts` (L224–L277, L563–L587) live at the end of this file, so
 * `tool-defs.ts` gains its six rows below its cited lines and imports them at its end (the UA1.18 / UA3.5 precedent).
 * Stated divergences from v0.13.4:
 * - UA8.2: v0.13.4 tool-defs.ts L225–L232, L251, L261 (`PageRefreshSpecInputSchema`, the `refresh` property of
 *   `create_page` and `update_page`) land REWRITTEN under reason (b) — no agent-authored path into scheduled execution:
 *   the agent supplies the script's CONTENT (`scriptContent`, Bun), the host writes `pages/{slug}/refresh.ts`
 *   (`@nessy-agent/shared/pages` `setPageRefresh`, strict: a `script` path is refused there), and the refresh stays
 *   INERT until the user approves its digest in the page view. The handlers pass `refresh` through verbatim, as
 *   upstream; the descriptions say it is inert until approved. The refresh text UA6.3 withheld from the other two
 *   descriptions is restored verbatim (UA8.2 follow-up): v0.13.4 tool-defs.ts L565's "refresh schedule, last refresh
 *   outcome" in `list_pages` (its summaries carry `refresh` and `lastRefresh`) and L583's closing sentence of
 *   `write_page_data` (L565's share state followed with UA6.7, next item).
 * - UA6.7: v0.13.4 tool-defs.ts L563, L565, L567, L587 restored (share state in `list_pages` / `get_page`, which carry
 *   `shared` / `shareUrl`; unpublish-on-delete and `publicCopyMayRemain` in `delete_page`). L563's
 *   "password-protected" reads "view-only": passwords went with the Craft share service (reason (a), spec §6).
 * - The authoring guide is `~/.nessy-agent/docs/pages.md` (UA6.5) and the bridge protocol `nessy-pages/v1` (rebrand).
 *   "Explore-safe" upstream is our Plan / Don't ask: the reads are `allow` + `readOnly`, the four mutations `block`
 *   and NOT `readOnly`, so Plan and Don't ask refuse them before the host on Pi and Claude and codex's own MCP
 *   approval refuses them there (UA1.8's rule).
 * - `delete_page` raises the HOST's one-shot confirmation card in every mode (`SessionManager.confirmPageDeleteForAgent`,
 *   UA6.2); a refusal is the thrown sentence this handler wraps as "Failed to delete page: …".
 */

import { z } from 'zod/v3';
import type {
  SessionToolContext,
  CreatePageToolInput,
  UpdatePageToolPatch,
  PageDataToolPatch,
} from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

const PAGES_UNAVAILABLE =
  'Pages tools are not available in this context.';

function toError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

// ============================================================
// list_pages
// ============================================================

export interface ListPagesArgs {
  projectId?: string;
}

export async function handleListPages(
  ctx: SessionToolContext,
  args: ListPagesArgs
): Promise<ToolResult> {
  if (!ctx.pages) return errorResponse(PAGES_UNAVAILABLE);

  try {
    let pages = await ctx.pages.listPages();
    if (args.projectId !== undefined) {
      pages = pages.filter(page => page.projectId === args.projectId);
    }
    return successResponse(JSON.stringify({ total: pages.length, pages }, null, 2));
  } catch (error) {
    return errorResponse(`Failed to list pages: ${toError(error)}`);
  }
}

// ============================================================
// get_page
// ============================================================

export interface GetPageArgs {
  slug: string;
  includeContent?: boolean;
}

export async function handleGetPage(
  ctx: SessionToolContext,
  args: GetPageArgs
): Promise<ToolResult> {
  if (!ctx.pages) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  try {
    const page = await ctx.pages.getPage(args.slug, { includeContent: args.includeContent === true });
    if (!page) {
      return errorResponse(`Page not found: ${args.slug}. Use list_pages to see available pages.`);
    }
    return successResponse(JSON.stringify(page, null, 2));
  } catch (error) {
    return errorResponse(`Failed to get page: ${toError(error)}`);
  }
}

// ============================================================
// create_page
// ============================================================

export type CreatePageArgs = CreatePageToolInput;

export async function handleCreatePage(
  ctx: SessionToolContext,
  args: CreatePageArgs
): Promise<ToolResult> {
  if (!ctx.pages) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.name?.trim()) return errorResponse('name is required.');

  try {
    const page = await ctx.pages.createPage(args);
    return successResponse(JSON.stringify(page, null, 2));
  } catch (error) {
    return errorResponse(`Failed to create page: ${toError(error)}`);
  }
}

// ============================================================
// update_page
// ============================================================

export interface UpdatePageArgs extends UpdatePageToolPatch {
  slug: string;
}

export async function handleUpdatePage(
  ctx: SessionToolContext,
  args: UpdatePageArgs
): Promise<ToolResult> {
  if (!ctx.pages) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  const { slug, ...patch } = args;
  const hasChanges = Object.keys(patch).some(key => (patch as Record<string, unknown>)[key] !== undefined);
  if (!hasChanges) {
    return errorResponse('Nothing to update — provide at least one of name, description, kind, projectId, content, refresh.');
  }

  try {
    const page = await ctx.pages.updatePage(slug, patch);
    return successResponse(JSON.stringify(page, null, 2));
  } catch (error) {
    return errorResponse(`Failed to update page: ${toError(error)}`);
  }
}

// ============================================================
// write_page_data
// ============================================================

export interface WritePageDataArgs extends PageDataToolPatch {
  slug: string;
}

export async function handleWritePageData(
  ctx: SessionToolContext,
  args: WritePageDataArgs
): Promise<ToolResult> {
  if (!ctx.pages) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  const { slug, ...patch } = args;
  try {
    const result = await ctx.pages.writePageData(slug, patch);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    return errorResponse(`Failed to write page data: ${toError(error)}`);
  }
}

// ============================================================
// delete_page
// ============================================================

export interface DeletePageArgs {
  slug: string;
}

export async function handleDeletePage(
  ctx: SessionToolContext,
  args: DeletePageArgs
): Promise<ToolResult> {
  if (!ctx.pages) return errorResponse(PAGES_UNAVAILABLE);
  if (!args.slug?.trim()) return errorResponse('slug is required.');

  try {
    const result = await ctx.pages.deletePage(args.slug);
    return successResponse(JSON.stringify(result, null, 2));
  } catch (error) {
    return errorResponse(`Failed to delete page: ${toError(error)}`);
  }
}

// ============================================================
// Schemas and descriptions (v0.13.4 tool-defs.ts L224–L277 and L563–L587, adapted — see the module header)
// ============================================================

// UA8.2 — REWRITTEN (module header): script CONTENT, never a path.
const PageRefreshSpecInputSchema = z.object({
  cron: z.string().describe('5-field cron expression evaluated once per minute (e.g. "*/15 * * * *"); runs at most every 5 minutes'),
  scriptContent: z.string().describe('Full source of the refresh script (Bun, TypeScript) — the script itself, NOT a path. The host writes it to pages/{slug}/refresh.ts; it must be one self-contained file.'),
  args: z.array(z.string()).optional().describe('Extra argv appended after the script path'),
  timezone: z.string().optional().describe('IANA timezone for cron evaluation (system local when omitted)'),
  timeoutMs: z.number().optional().describe('Per-run timeout in ms (default 60000, clamped to 1s–15min)'),
  enabled: z.boolean().optional().describe('Set false to pause scheduling without deleting the spec'),
});

export const ListPagesSchema = z.object({
  projectId: z.string().optional().describe('Only return pages bound to this project ID'),
});

export const GetPageSchema = z.object({
  slug: z.string().describe('Page slug (from list_pages or create_page)'),
  includeContent: z.boolean().optional().describe('Also return the full index.html content (can be large). Default false — the response always includes contentPath for reading it from disk instead.'),
});

export const CreatePageSchema = z.object({
  name: z.string().describe('Page name shown on the tile (also drives the slug)'),
  description: z.string().optional().describe('Short description shown in lists'),
  kind: z.enum(['static', 'interactive', 'live'])
    .optional()
    .describe('Runtime capability class: static = no JS, interactive = JS allowed, live = JS + receives data snapshot updates while open. Default: interactive.'),
  projectId: z.string().optional().describe('Stable Project ID to bind the page to'),
  content: z.string().optional().describe('Full self-contained HTML document for index.html (inline CSS/JS, no external requests). Read ~/.nessy-agent/docs/pages.md for the authoring guide and data-bridge snippet BEFORE writing page HTML.'),
  refresh: PageRefreshSpecInputSchema.optional().describe('Scheduled data refresh: cron + the Bun script that updates the page data store. Inert until the user approves the script in the page view.'),
});

export const UpdatePageSchema = z.object({
  slug: z.string().describe('Slug of the page to update'),
  name: z.string().optional().describe('New page name (slug stays stable)'),
  description: z.string().nullable().optional().describe('New description. Pass null to clear.'),
  kind: z.enum(['static', 'interactive', 'live']).optional().describe('New runtime capability class'),
  projectId: z.string().nullable().optional().describe('New Project ID. Pass null to unbind from its project.'),
  content: z.string().optional().describe('Replacement index.html (full document). Re-digests the content — existing source-action grants become stale by design and need re-approval.'),
  refresh: PageRefreshSpecInputSchema.nullable().optional().describe('New refresh spec. Pass null to remove scheduled refresh. A changed script needs the user\'s approval again before it runs.'),
});

export const WritePageDataSchema = z.object({
  slug: z.string().describe('Slug of the page whose data store to write'),
  set: z.record(z.string(), z.unknown()).optional().describe('KV upserts: key → any JSON value (objects/arrays allowed)'),
  delete: z.array(z.string()).optional().describe('KV keys to delete'),
  appendSeries: z.record(z.string(), z.array(z.object({
    t: z.number().optional().describe('Timestamp epoch ms (defaults to now). Writing an existing (series, t) overwrites its value — re-runs are idempotent.'),
    v: z.number().describe('Numeric value'),
  }))).optional().describe('Timeseries appends: series name → array of points'),
  pruneSeries: z.record(z.string(), z.number()).optional().describe('Timeseries prunes: series name → deleteBefore timestamp (points with t < value are removed)'),
});

export const DeletePageSchema = z.object({
  slug: z.string().describe('Slug of the page to delete'),
});

export const LIST_PAGES_DESCRIPTION = `List the workspace's Pages — persistent, agent-authored HTML mini dashboards/documents rendered in the app's Pages section (sidebar) and optionally shared via view-only public links.

Returns compact summaries: slug, name, kind (static/interactive/live), project, refresh schedule, last refresh outcome, share state, and folder path. Optionally filter by projectId. Use get_page for full details on one page.`;

export const GET_PAGE_DESCRIPTION = `Get full details for one Page by slug: config, content digest/length/path, a data summary (KV keys + per-series point counts and latest values), source-action grants, and share state.

The response includes absolute paths (contentPath, data.snapshotPath) — Read those files for the full HTML or the complete data snapshot. Pass includeContent: true only when you need the HTML inline.`;

export const CREATE_PAGE_DESCRIPTION = `Create a new Page: a persistent, self-contained HTML document stored at pages/{slug}/ in the workspace, shown as a tile in the app's Pages section, and rendered in a sandboxed iframe.

IMPORTANT — read ~/.nessy-agent/docs/pages.md BEFORE authoring page HTML. Key rules: provide a FULL standalone HTML document with ALL CSS/JS inline (no external requests — the page frame blocks network egress); to display data from the page's data store, listen for the 'nessy-pages/v1' bridge messages (init/data) documented there; kind 'live' pages receive replacement data snapshots automatically while open.

Use Pages (instead of chat previews) when the user wants something persistent: a dashboard, a report they'll revisit, a tracker fed by write_page_data or a scheduled refresh. A refresh carries the script's content (not a path); it does not run until the user approves the script in the page view — tell them to. Returns the created page details including the slug.`;

export const UPDATE_PAGE_DESCRIPTION = `Update an existing Page: metadata (name, description, kind, projectId), its scheduled refresh, and/or replace its HTML content.

Only provided fields change; pass null to clear description/projectId/refresh. A refresh carries the script's content (not a path), and a new or changed script does not run until the user approves it in the page view. Replacing content re-computes the content digest, so existing source-action grants go stale by design (the user must re-approve them). The slug never changes.`;

export const WRITE_PAGE_DATA_DESCRIPTION = `Write to a Page's data store: KV upserts/deletes plus numeric timeseries appends/prunes, applied in one transaction. The data snapshot (data/snapshot.json) is regenerated and pushed to open renders — 'live' pages update on screen without a reload.

Data model: kv is key → any JSON value; series are named lists of { t: epoch ms, v: number } points with idempotent (series, t) upserts — re-running the same write is safe. Use timeseries for anything you may want charted over time (metrics, counts, prices). Composes with scheduled refresh scripts writing the same store.`;

export const DELETE_PAGE_DESCRIPTION = `Delete a Page permanently — removes its folder including content and data store. DESTRUCTIVE: the user is asked to confirm every deletion, in every permission mode; when nobody can answer (an automation, a subagent, Don't ask), the deletion is refused and nothing is removed.

A published page is unpublished first (best effort); the result reports publicCopyMayRemain when the remote copy could not be confirmed removed.`;
