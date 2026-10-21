/**
 * `SendUserFile` (R27a) — hand a generated artifact to the user.
 *
 * Contract, read from the raw markdown of `tools-reference.md:48`:
 *
 * > Sends files from the session to you with an optional caption, so a
 * > generated report, diagram, screenshot, or built artifact reaches your device
 * > instead of only being mentioned in the transcript. … As of v2.1.196, the
 * > optional `display` input controls presentation: `render` opens the file
 * > inline in the client, `attach` shows a download card only, and when unset
 * > the client decides by file type. Available when a Remote Control client is
 * > connected or the session runs in a managed cloud environment … Delivery runs
 * > through Anthropic-hosted infrastructure, so the tool is not available on
 * > Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry.
 *
 * The provider gate is not ported: it gates the hop to a remote client. We are a
 * desktop app, and the file is already on the user's own machine, so the local
 * half needs no hosted infrastructure. `display` is implemented as the
 * documented THREE states — unset is carried as unset, never coerced to
 * `attach`, because "the client decides by file type" is a distinct instruction.
 *
 * The doc publishes no JSON schema; `caption` and `display` are the names it
 * writes literally, and `paths` is ours for the plural "files" it describes.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';
import { isPathWithinDirectory } from '../runtime/path-security.ts';
import { SendUserFileSchema } from '../tool-defs.ts';

/**
 * The size ceiling for one delivered file.
 *
 * Generous for everything the doc names — a report, a diagram, a screenshot, a
 * built artifact — and small enough that a model pointing at a multi-gigabyte
 * build output or a core dump gets a named error instead of the client trying
 * to move it.
 */
export const SEND_USER_FILE_MAX_BYTES = 10 * 1024 * 1024;

export interface DeliveredFile {
  path: string;
  name: string;
  bytes: number;
  /** Lowercase, with the dot, or empty. What an unset `display` is decided on. */
  extension: string;
}

/**
 * One spelling per directory or file.
 *
 * This normalises the INPUTS to the containment check; it is not a second
 * containment check — the decision stays {@link isPathWithinDirectory}, which
 * resolves symlinks itself. It matters because that helper's fast lexical stage
 * runs before its symlink stage, so a root and a target written with different
 * spellings of the same place (macOS `/var` -> `/private/var` is the everyday
 * case) are rejected before the symlink stage ever sees them.
 */
function realPath(value: string): string {
  const resolved = resolve(value);
  try {
    return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
  } catch {
    return resolved;
  }
}

/**
 * The roots a delivered file may come from — all host-supplied, none of them
 * model-supplied. Every one of them is already readable by this session, so
 * delivery grants no read authority the session did not have.
 */
function containmentRoots(ctx: SessionToolContext): string[] {
  return [ctx.workingDirectory, ctx.sessionPath, ctx.dataPath, ctx.plansFolderPath]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map(realPath);
}

export async function handleSendUserFile(
  ctx: SessionToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const parsed = SendUserFileSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return errorResponse(`SendUserFile input is invalid — ${detail}`);
  }

  const roots = containmentRoots(ctx);
  if (roots.length === 0) {
    return errorResponse('SendUserFile has no reachable directory for this session.');
  }

  // Every file is checked before ANY is delivered: a half-delivered call would
  // leave the user with an artifact set that does not match what was reported.
  const files: DeliveredFile[] = [];
  for (const candidate of parsed.data.paths) {
    // A relative path resolves against the session's working directory, which
    // is where the model's own file tools resolve it too. The model chose this
    // path, so a symlink in it is resolved BEFORE containment is decided —
    // a link inside a reachable root that points out of it is still refused.
    const target = realPath(resolve(roots[0]!, candidate));
    // Symlink-aware containment from `runtime/path-security.ts`, shared with
    // transform_data and script_sandbox rather than reimplemented here. It runs
    // BEFORE the existence check, so a refusal never reveals whether a file
    // outside the session's scope exists.
    if (!roots.some(root => isPathWithinDirectory(target, root))) {
      return errorResponse(
        `SendUserFile refused ${candidate}: it is outside this session's reachable directories.`,
      );
    }

    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(target);
    } catch {
      return errorResponse(`SendUserFile could not find ${candidate}.`);
    }
    if (stats.isDirectory()) {
      return errorResponse(`SendUserFile refused ${candidate}: it is a directory, not a file.`);
    }
    if (stats.size > SEND_USER_FILE_MAX_BYTES) {
      return errorResponse(
        `SendUserFile refused ${candidate}: ${stats.size} bytes exceeds the`
        + ` ${SEND_USER_FILE_MAX_BYTES}-byte limit for one file.`,
      );
    }
    try {
      accessSync(target, constants.R_OK);
    } catch {
      return errorResponse(`SendUserFile could not read ${candidate}.`);
    }

    files.push({
      path: target,
      name: basename(target),
      bytes: stats.size,
      extension: extname(target).toLowerCase(),
    });
  }

  const requested = parsed.data.display === 'render'
    ? 'opened inline'
    : parsed.data.display === 'attach'
      ? 'shown as a download card'
      : 'presented by file type';
  const summary = files.length === 1 ? `1 file` : `${files.length} files`;

  return {
    content: [{
      type: 'text',
      text: [
        // NOT "Sent … to the user". Nothing in `apps/electron/src` or
        // `packages/ui/src` reads this tool's result — verified by grep — so no
        // file reaches anyone. The old wording made the tool report a delivery
        // that cannot have happened, the model relayed it faithfully, and the
        // product told the user it had sent them a file it had not sent.
        //
        // A tool that cannot deliver must not report delivery. Say what actually
        // happened — the files were validated and registered — and name the
        // missing half, so the model tells the user where the file IS rather
        // than claiming it arrived. Delete this note when a surface renders the
        // record; the wording changes back with it.
        `Registered ${summary} for delivery (requested presentation: ${requested}).`,
        'NOTE: no client surface renders delivered files yet, so the user has'
        + ' NOT received them. Tell the user the path instead of saying you sent'
        + ' the file.',
        ...files.map(file => `- ${file.path} (${file.bytes} bytes)`),
        ...(parsed.data.caption ? [`Caption: ${parsed.data.caption}`] : []),
      ].join('\n'),
    }],
    structuredContent: {
      files,
      // `display` is OMITTED when unset. Defaulting it to `attach` here would
      // erase the documented third state.
      ...(parsed.data.display ? { display: parsed.data.display } : {}),
      ...(parsed.data.caption ? { caption: parsed.data.caption } : {}),
    },
    isError: false,
  };
}
