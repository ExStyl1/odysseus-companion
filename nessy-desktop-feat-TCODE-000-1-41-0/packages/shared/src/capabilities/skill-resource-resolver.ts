import { createHash } from 'node:crypto';
import type { CapabilitySnapshotMaterializer } from './materializer.ts';
import type { SkillInvocationRecord, SkillSupportingResourceSnapshot } from './runtime-skill-content.ts';
import type { AgentRuntimeView } from './views.ts';

/**
 * Turn a `skill-resource:` handle back into the bytes that were pinned when the
 * skill was invoked.
 *
 * Claude's contract (`code.claude.com/docs/en/skills.md`, "Add supporting
 * files") is that a skill's reference material loads "only when needed" — its
 * mechanism is a path plus the ordinary read tool. Ours cannot be a path: the
 * model is never handed a skill's absolute location, and reading the live file
 * would bypass the digest that makes the pinned snapshot trustworthy at all.
 * So the handle is the address and this is the only thing that dereferences it.
 *
 * THE DIGEST IS THE AUTHORITY. Bytes are always served from the snapshot, never
 * from the filesystem. The file is re-read only to answer one question — has it
 * changed since it was pinned? — and a change is a named error, never newer
 * bytes and never a live read substituted for the pinned one.
 */

export type SkillResourceResolutionFailure =
  /** Not a `skill-resource:<hex64>` string at all. */
  | 'skill-resource-handle-invalid'
  /** No active invocation in THIS session pinned that handle. */
  | 'skill-resource-unknown-handle'
  /** Pinned before the current capability generation; the grant no longer covers it. */
  | 'skill-resource-generation-changed'
  /** The owning skill is gone from the runtime view, or its SKILL.md changed. */
  | 'skill-resource-skill-inactive'
  /** The snapshot's own bytes no longer hash to their pinned digest. */
  | 'skill-resource-digest-mismatch'
  /** The file on disk no longer matches what was pinned. */
  | 'skill-resource-changed'
  /** No live capability turn, or a pre-R17 record with no path to re-verify. */
  | 'skill-resource-unavailable';

export class SkillResourceResolutionError extends Error {
  override readonly name = 'SkillResourceResolutionError';
  constructor(readonly code: SkillResourceResolutionFailure, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface ResolvedSkillResource {
  handle: string;
  digest: string;
  relativePath: string;
  /** The invoked skill's logical name — never its path. */
  skill: string;
  /** The PINNED bytes. */
  content: string;
}

export interface SkillResourceResolutionRuntime {
  view: Pick<AgentRuntimeView, 'generation' | 'skills'>;
  materializer: CapabilitySnapshotMaterializer;
}

const HANDLE = /^skill-resource:[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function findPinned(
  invocations: Iterable<SkillInvocationRecord>,
  handle: string,
): { invocation: SkillInvocationRecord; resource: SkillSupportingResourceSnapshot } | undefined {
  for (const invocation of invocations) {
    const resource = invocation.supportingResources.find(candidate => candidate.handle === handle);
    if (resource) return { invocation, resource };
  }
  return undefined;
}

/**
 * Resolve one handle against the invocations pinned by ONE session.
 *
 * The caller supplies the session's own active invocations, which is what makes
 * a handle minted elsewhere unresolvable here: handles carry no session
 * identity, so scope is enforced by whose snapshot is searched, not by parsing
 * the handle. A foreign handle is simply unknown.
 */
export async function resolveSkillResource(input: {
  handle: string;
  invocations: Iterable<SkillInvocationRecord>;
  runtime: SkillResourceResolutionRuntime | undefined;
}): Promise<ResolvedSkillResource> {
  const handle = typeof input.handle === 'string' ? input.handle.trim() : '';
  if (!HANDLE.test(handle)) {
    throw new SkillResourceResolutionError('skill-resource-handle-invalid');
  }

  const pinned = findPinned(input.invocations, handle);
  if (!pinned) throw new SkillResourceResolutionError('skill-resource-unknown-handle');
  const { invocation, resource } = pinned;

  // The snapshot must still be internally consistent before anything is served.
  if (sha256(resource.content) !== resource.digest) {
    throw new SkillResourceResolutionError('skill-resource-digest-mismatch', invocation.name);
  }
  if (!resource.relativePath) {
    throw new SkillResourceResolutionError(
      'skill-resource-unavailable',
      'this resource was pinned without a path and cannot be re-verified',
    );
  }

  const runtime = input.runtime;
  if (!runtime) {
    throw new SkillResourceResolutionError('skill-resource-unavailable', 'no active capability turn');
  }
  if (invocation.generation !== runtime.view.generation) {
    throw new SkillResourceResolutionError('skill-resource-generation-changed', invocation.name);
  }
  const skill = runtime.view.skills.find(candidate => candidate.key === invocation.key);
  if (!skill || skill.resource.contentHash !== invocation.sourceDigest) {
    throw new SkillResourceResolutionError('skill-resource-skill-inactive', invocation.name);
  }

  runtime.materializer.assertActive();
  if (!runtime.materializer.readRelativeText) {
    throw new SkillResourceResolutionError('skill-resource-unavailable', invocation.name);
  }
  // Re-read purely to detect drift. `readRelativeText` is also what enforces
  // containment, plugin-bundle integrity and text-ness, so the resolver inherits
  // every guard the eager path had rather than reimplementing them.
  const live = await runtime.materializer.readRelativeText(skill.resource, resource.relativePath);
  if (live.contentHash !== resource.digest) {
    throw new SkillResourceResolutionError('skill-resource-changed', resource.relativePath);
  }
  runtime.materializer.assertActive();

  return Object.freeze({
    handle,
    digest: resource.digest,
    relativePath: resource.relativePath,
    skill: invocation.name,
    content: resource.content,
  });
}
