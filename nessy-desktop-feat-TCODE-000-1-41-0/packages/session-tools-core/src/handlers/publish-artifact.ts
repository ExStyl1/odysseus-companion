/**
 * UA1.18 — `publish_artifact`: put one page the session wrote (`.html`, `.htm` or `.md`) on the internal artifact
 * service `https://t-artifacts.t-tech.team` and hand back its link (OQ-18, OQ-22 (a)(b)(c), owner 2026-09-23).
 *
 * This handler carries NO approval logic, as `archive-session.ts` carries none (P6.466): the card, the unattended
 * refusal, the retention range, the update-target check and the publish guard all live in the host closure behind
 * `ctx.publishArtifact` (`SessionManager.publishArtifactForAgent`), the one seam a session MCP tool reaches on all
 * three runtimes — Pi and Claude in process, codex over `HOST_CALLBACK_BRIDGE_ROUTES.artifactPublish`. A second
 * check here would be a per-runtime copy of a host decision, the shape native-first exists to stop.
 *
 * The description is written in our words (UA1.21 owns the guidance page). It states the access model, the expiry,
 * the 1..30 retention range and "only when the user asked in this conversation", and names no command line: the
 * product has no Bash, npx or dp-login path to the service, and the description must not teach one.
 *
 * UA1.21 — the design note (OQ-22 (d)); the same five statements are on the shipped guide
 * `apps/electron/resources/docs/artifacts.md`, which is the user's and the agent's reference:
 *  1. The host card is a consent control for the sanctioned path, NOT an egress control: any Bash-capable agent with
 *     network can reach the service directly. On Pi and Claude a shell command naming the host or the
 *     `artifact-publish` skill/package is redirected here (`artifactPublishShellRedirect`, `core/pre-tool-use.ts`); it
 *     reads command text only, and codex shell commands never reach it (codex residue).
 *  2. Token custody (UA1.16): each request carries the opaque `dp auth print-token` value, a platform-wide credential,
 *     read fresh per request, never cached, stored or logged; never the Nestor JWT. A delegated token replaces it as
 *     soon as dp can mint one (OQ-22 (f)).
 *  3. The link is the only access control; the source is downloadable by id; a deletion does not recall copies.
 *  4. Page scripts run in the readers' browsers (the card counts them and lists external hosts).
 *  5. Codex's own MCP timeout (60 s default) is emitted as >= 121 s on the session tools, above the 110 s card (UA12.24).
 * Guidance source: the t-artifacts skill text `skills/artifact-publish/skilldata/core.md` at `14e402e`, as summarised
 * in the spec (§24, read 2026-09-23) — its trigger is the user's request; not re-read for UA1.21 (it sits on the
 * company GitLab), PARAPHRASE ONLY, licence UNVERIFIED: no sentence of it is copied here or in the description. The
 * skill itself is not shipped.
 *
 * UA1.20 — the NATIVE `Artifact` shape. Claude's own `Artifact` publishes to claude.ai, so it stays banned (F1.253,
 * `CLAUDE_SESSION_DISALLOWED_TOOLS`) and is ALIASED onto this tool (`CLAUDE_TOOL_ALIASES`, the P6.220 shape): a call a
 * skill document or the model's habit emits lands here, through the same host card, instead of dying as unknown. It
 * arrives as the vendored `sdk-tools.d.ts` `ArtifactInput` (claudeCodeVersion 2.1.274; re-derived for O12 from the
 * lifted bundle, not the 2.1.251 the plan row cites — `note` is gone, `icon` and the `list_types` action are new):
 *  - mapped: `file_path`, `title`, `description`, `url`, and `favicon` → `emoji` (emoji wins when both are given);
 *  - `action`: omitted or exactly `'publish'` publishes; EVERY other value is refused with the `list_artifacts`
 *    pointer before the host is called — none of them is mapped onto anything, and no delete-shaped action ever
 *    reaches a DELETE (deletion is not an agent action here);
 *  - dropped: the claude.ai-service knobs (`label`, `icon`, `force`, `capabilities`, `contract`) and the fields that
 *    only accompany a refused action (`limit`, `scope`, `prompt`, `out_dir`, `asset_id`, `after`). They are not in
 *    the schema, so the zod object parse every runtime applies (the SDK's in-process `tool()` on Claude, the session
 *    MCP server on codex) strips them; `claude-tool-aliases.test.ts` fails when the bundle grows a field nobody
 *    classified.
 *  - `file_path` is optional in the SCHEMA only so a native call without one (`{ action: 'list' }`) reaches this
 *    handler and gets the pointer rather than a validation error; the handler still requires it.
 *  - a `url` off the t-artifacts origin (a claude.ai link) is passed through unchanged and refused by the host's
 *    origin check (`artifact-publishing.ts`, `isTArtifactsUrl`) before any request.
 */
import { z } from 'zod/v3';
import type { PublishArtifactVerdict, SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

/** The range a MODEL may ask for (OQ-22 (b)); unlimited and longer retention are set by the user in the app (UA1.19). */
export const PUBLISH_ARTIFACT_MIN_RETENTION_DAYS = 1;
export const PUBLISH_ARTIFACT_MAX_RETENTION_DAYS = 30;
/** The service's own default (`internal/artifact/retention.go`), applied on a create when the model names none. */
export const PUBLISH_ARTIFACT_DEFAULT_RETENTION_DAYS = 7;

export const PUBLISH_ARTIFACT_DESCRIPTION = `Publish a page the session wrote (an .html, .htm or .md file inside the working folder) to the company's internal artifact service (t-artifacts) and get a shareable link.

Call this ONLY when the user asked in this conversation to publish or share a page. Otherwise offer it in one line of text; never publish proactively.

- Every call shows the user a confirmation card with a preview of exactly what will be sent, in every permission mode. Nothing is sent until they approve, and the approval cannot be remembered.
- Access: anyone who has the link can open the page — the link is the only access control — and the page source can be downloaded by its id. Deleting a page does not recall copies readers already saved.
- Expiry: the link stops working after retention_days days (${PUBLISH_ARTIFACT_MIN_RETENTION_DAYS} to ${PUBLISH_ARTIFACT_MAX_RETENTION_DAYS}, default ${PUBLISH_ARTIFACT_DEFAULT_RETENTION_DAYS}). Longer or unlimited retention can only be set by the user in the app.
- Update: pass url with the link of a page this workspace published before to replace its content; the link stays the same and its expiry is kept unless you pass retention_days. Use list_artifacts to find this session's pages.
- Refused without sending anything: credential files, files outside the session's folders, files other than .html/.htm/.md, pages over 16 MiB, pages containing tokens or card numbers, password fields and forms, and calls from automations, schedules, subagents or Don't ask mode.`;

export const PublishArtifactSchema = z.object({
  file_path: z.string().optional().describe('Required. The page to publish: an .html, .htm or .md file, absolute or relative to the working folder.'),
  title: z.string().optional().describe('The page title. Defaults to the document\'s own <title>, its first heading, or the file name.'),
  description: z.string().optional().describe('A one-line description shown in the service\'s list.'),
  emoji: z.string().optional().describe('One or two emoji used as the page icon (for example 📊). Defaults to 📄.'),
  url: z.string().optional().describe('UPDATE only: the link of a page this workspace published before. Omit to publish a new page.'),
  retention_days: z.number().int().optional().describe(`Days until the link expires, ${PUBLISH_ARTIFACT_MIN_RETENTION_DAYS} to ${PUBLISH_ARTIFACT_MAX_RETENTION_DAYS}. Defaults to ${PUBLISH_ARTIFACT_DEFAULT_RETENTION_DAYS} for a new page; on an update, omit it to keep the current expiry.`),
  // UA1.20 — the native `Artifact` tool's spellings (see the header); omit both.
  action: z.string().optional().describe('Omit. Only "publish" is accepted (the native Artifact tool\'s spelling); any other action is refused.'),
  favicon: z.string().optional().describe('Same as emoji (the native Artifact tool\'s name for it); emoji wins when both are given.'),
});

export interface PublishArtifactArgs {
  file_path?: string;
  action?: string;
  favicon?: string;
  title?: string;
  description?: string;
  emoji?: string;
  url?: string;
  retention_days?: number;
}

/**
 * UA1.20 — the sentence for a native `Artifact` action this tool does not perform. It names what IS available
 * (publish with file_path, list_artifacts) and says plainly that nothing left the machine and nothing was deleted.
 */
export function nativeArtifactActionRefusal(action: string): string {
  const shown = JSON.stringify(action.length > 40 ? `${action.slice(0, 40)}…` : action);
  return `The ${shown} action of the native Artifact tool is not available in Nessy, and nothing was sent, read or deleted. `
    + 'Pages are published only with publish_artifact (omit action, pass file_path), after the user approves a confirmation card; '
    + 'use list_artifacts to see the pages this session published. Reading, watching, assets and deleting published pages are not agent actions here.';
}

/** The tool's success payload — `{ url, expires_at, updated }` (plan UA1.18 Interfaces), plus the host's sentence. */
function publishedResult(verdict: PublishArtifactVerdict): ToolResult {
  return successResponse(JSON.stringify({
    url: verdict.url,
    expires_at: verdict.expiresAt ?? null,
    updated: verdict.status === 'updated',
    note: verdict.note,
  }, null, 2));
}

export async function handlePublishArtifact(
  ctx: SessionToolContext,
  args: PublishArtifactArgs,
): Promise<ToolResult> {
  if (!ctx.publishArtifact) {
    return errorResponse('publish_artifact is not available in this context.');
  }
  // UA1.20 — a native `Artifact` action other than publish: refused here, before the host, mapped onto nothing.
  if (args.action !== undefined && args.action !== 'publish') {
    return errorResponse(nativeArtifactActionRefusal(args.action));
  }
  if (!args.file_path) {
    return errorResponse('publish_artifact needs file_path: the .html, .htm or .md file to publish. Nothing was sent.');
  }
  const emoji = args.emoji ?? args.favicon;
  try {
    const verdict = await ctx.publishArtifact({
      filePath: args.file_path,
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(emoji !== undefined ? { emoji } : {}),
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.retention_days !== undefined ? { retentionDays: args.retention_days } : {}),
    });
    switch (verdict.status) {
      case 'published':
      case 'updated':
        return publishedResult(verdict);
      // A refusal reaches the model AS a refusal (archive_session's `done_means` (c)): a denial read as a success
      // would be a page the model believes is live.
      case 'denied':
      case 'refused':
      case 'failed':
        return errorResponse(verdict.note);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to publish ${args.file_path}: ${message}`);
  }
}
