import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';

export interface ReadSkillResourceArgs {
  handle: string;
}

/**
 * `read_skill_resource` — dereference one `skill-resource:` handle from an
 * invoked skill's `<skill-resource>` tag.
 *
 * Claude's supporting-file contract (`skills.md`, "Add supporting files") is
 * that reference material loads "only when needed". Our invoked-skill block
 * therefore carries a handle, a digest and a relative path instead of the file
 * body, and this is how the model turns one back into bytes.
 *
 * The bytes come from the snapshot pinned at invocation time, re-verified
 * against their digest — never from a fresh read of the file, and never with the
 * skill's absolute path attached. Read-only, no permission (see
 * `ALWAYS_ALLOWED_TOOLS`), for the same reason `read_mcp_resource` is: it
 * reveals nothing the session did not already pin on the user's own action.
 */
export async function handleReadSkillResource(
  ctx: SessionToolContext,
  args: ReadSkillResourceArgs,
): Promise<ToolResult> {
  if (!ctx.skillResources) {
    return errorResponse('read_skill_resource is not available: this session has no invoked skills.');
  }
  const handle = typeof args.handle === 'string' ? args.handle.trim() : '';
  if (!handle) {
    return errorResponse('read_skill_resource requires the handle from a <skill-resource> tag.');
  }
  try {
    const resource = await ctx.skillResources.read(handle);
    return successResponse(JSON.stringify({
      skill: resource.skill,
      path: resource.relativePath,
      digest: resource.digest,
      content: resource.content,
    }, null, 2));
  } catch (error) {
    return errorResponse(`read_skill_resource failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
