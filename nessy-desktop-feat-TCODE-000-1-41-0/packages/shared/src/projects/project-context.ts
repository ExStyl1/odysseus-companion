/**
 * UA5.5 — the project-context layer's host half (spec §12 "Context", §16 "Host-record integrity").
 *
 * Upstream (`v0.13.4`, Apache-2.0) rebuilds `ProjectPromptContext` from `config.json` inside each agent on every turn
 * (`resolveProjectContext` in `claude-agent.ts` / `pi-agent.ts`) and appends the formatted block to the system
 * prompt. Here there is ONE producer for every runtime, and it is a FILE:
 *
 * 1. **The mirror.** After every project config write (`setProjectConfigWrittenHook`, registered once by the host
 *    through {@link installProjectContextMirror}) the host renders the block from the config through
 *    `formatProjectContextForPrompt` (the ported sanitiser defangs closing tags and strips control characters),
 *    writes it to `{workspaceRoot}/projects/<slug>/context.md`, and records the bytes' sha256 in the MACed
 *    host-approvals ledger as a `project-context` entry (subject `project:<id>`).
 * 2. **The binding.** {@link resolveProjectContextLayer} — called by the capability input builder for a turn whose
 *    session is bound to a project — returns one `instruction` record over that file, but only for bytes that match
 *    the ledger digest. On a mismatch (an agent wrote the file: codex can, Pi and Claude are refused by the
 *    `projects/*\/context.md` guard pattern) it logs `project-context-tampered`, re-renders from `config.json`
 *    through the formatter — never from the file's raw bytes — writes that back, records it, and binds it. The
 *    record's `contentHash` is the hash of the bytes verified or rendered HERE, so a swap after this point fails the
 *    materializer's hash check (`capability-resource-stale`) instead of reaching the prompt.
 * 3. **Delivery.** The resolver's ordinary `instruction` arm turns the record into a `promptLayers` entry
 *    (`views.ts` `toAgentRuntime`), and `BaseAgent`'s pinned capability block carries it to Pi, Claude and codex
 *    alike. That block is keyed to the capability GENERATION, which folds every record's `contentHash`, so an edit
 *    reaches the NEXT turn — measured, so upstream's "System prompt context changed" drift notice is not needed.
 *
 * Decisions (TRANSPARENT and SIMPLE):
 * - No ledger key (the provider rejects — a sealed key the OS store cannot open) is the closed failure: the file is
 *   still re-rendered from `config.json` every turn and bound, and nothing is recorded (`unverified`). The layer is
 *   then exactly the sanitised render, so the key buys only the choice between "the bytes the host wrote" and "a
 *   fresh render", never the sanitiser.
 * - A file that was never mirrored (a project written before this row, or by a host with no registered hook) is
 *   `missing`: rendered and recorded on first use, logged without the tampered word.
 * - The asset manifest (UA5.6) is upstream's: `listProjectAssets` at render time, under upstream's always-present
 *   `<project_assets_path>`. `assets/` changes without a config write (an upload through the RPC, or a file an agent
 *   drops there), so — like the memory — the ledger entry also records the digest of the manifest its bytes were
 *   rendered with, and a resolve that finds the manifest moved re-renders (`refreshed`). UA5.6's reach readings
 *   (`project-assets-reach.test.ts`) are why the manifest is ported: every runtime can read `assets/`.
 * - Project memory (UA5.12, OQ-9): a FOLDERLESS project's `projects/<slug>/MEMORY.md` rides inside the block as
 *   upstream's `<project_memory_path>` / `<project_memory>` (capped by `loadProjectMemory`, sanitised like every other
 *   field); a FOLDERED project carries none — its folder's own `.nessy-agent/MEMORY.md` is its memory (reason (c)).
 *   The memory is agent-written by design, so no host write follows an edit of it: the ledger entry also records the
 *   digest of the memory its bytes were rendered with, and a resolve that finds `MEMORY.md` moved re-renders
 *   (`refreshed`) rather than binding a stale block. UA5.12's reach readings (`project-memory-reach.test.ts`) are why
 *   this is ported and not recorded as KNOWN: every runtime can read the file and write it under its ordinary posture.
 *
 * Residue (stated): an agent that rewrites `config.json` (codex; Pi/Claude are refused by the guard) changes what the
 * NEXT host write renders — sanitised, like every other field the user types. The ledger stops raw bytes, not
 * content the agent could have typed into the project's details itself.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  findHostApproval,
  getHostApprovalsKeyProvider,
  recordHostApproval,
  type HostApprovalsKeyProvider,
} from '../approvals/host-approvals.ts';
import type { NativeCapabilitySourceRecord } from '../capabilities/types.ts';
import { formatProjectContextForPrompt } from '../prompts/project-context-prompt.ts';
import { atomicWriteFileSync } from '../utils/files.ts';
import {
  getProjectAssetsPath,
  getProjectMemoryPath,
  getProjectPath,
  listProjectAssets,
  loadProjectById,
  loadProjectMemory,
  setProjectConfigWrittenHook,
} from './storage.ts';
import type { ProjectConfig, ProjectPromptContext } from './types.ts';

/** The mirror's file name, beside the project's `config.json`. Guarded by pattern in `pre-tool-use.ts` (UA1.10). */
export const PROJECT_CONTEXT_FILENAME = 'context.md';

/** The layer's logical name (one per bound session; never a file label a native scan could produce). */
export const PROJECT_CONTEXT_LOGICAL_NAME = 'project-context';

/**
 * Why the bound bytes are the ones they are. Only `verified` binds the file as found; `refreshed` (UA5.12, UA5.6) is a
 * verified file re-rendered because the folderless project's `MEMORY.md`, or the asset manifest, moved since it was
 * written.
 */
export type ProjectContextVerdict = 'verified' | 'refreshed' | 'tampered' | 'missing' | 'unverified';

export interface ProjectContextLayer {
  record: NativeCapabilitySourceRecord;
  verdict: ProjectContextVerdict;
}

/** `{workspaceRoot}/projects/<slug>/context.md`; an unsafe slug throws (the `getProjectPath` chokepoint). */
export function getProjectContextPath(workspaceRootPath: string, projectSlug: string): string {
  return join(getProjectPath(workspaceRootPath, projectSlug), PROJECT_CONTEXT_FILENAME);
}

/** The ledger subject: by id, which survives a rename (the slug never changes either, but the id is the identity). */
export function projectContextSubject(projectId: string): string {
  return `project:${projectId}`;
}

/**
 * The formatter's input for a project. The asset manifest as upstream lists it (UA5.6). Memory for a folderless project
 * only (UA5.12): upstream's `memoryPath` always, `memoryContent` when `MEMORY.md` has any (`loadProjectMemory` caps it
 * and answers `null` for a foldered project anyway).
 */
export function projectPromptContextOf(workspaceRootPath: string, config: ProjectConfig): ProjectPromptContext {
  const memory = config.folder ? null : loadProjectMemory(workspaceRootPath, config.slug);
  return {
    name: config.name,
    ...(config.description ? { description: config.description } : {}),
    ...(config.details ? { details: config.details } : {}),
    assetsPath: getProjectAssetsPath(workspaceRootPath, config.slug),
    assets: projectAssetManifest(workspaceRootPath, config.slug),
    ...(config.folder ? {} : { memoryPath: getProjectMemoryPath(workspaceRootPath, config.slug) }),
    ...(memory ? { memoryContent: memory } : {}),
  };
}

/** UA5.12 — the digest of the memory a render of this project carries (`''` hashed for none); absent when foldered. */
function memoryDigestOf(config: ProjectConfig, ctx: ProjectPromptContext): string | undefined {
  return config.folder ? undefined : sha256(ctx.memoryContent ?? '');
}

/** UA5.6 — upstream's manifest (`resolveProjectContext`): name, type and size of each asset, newest first. */
function projectAssetManifest(workspaceRootPath: string, projectSlug: string): ProjectPromptContext['assets'] {
  return listProjectAssets(workspaceRootPath, projectSlug).map(asset => ({
    filename: asset.filename,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
  }));
}

/** UA5.6 — the digest of the manifest a render of this project carries. */
function assetsDigestOf(assets: ProjectPromptContext['assets']): string {
  return sha256(JSON.stringify(assets));
}

/** The sanitised block for a project, exactly as the mirror writes it. */
export function renderProjectContext(workspaceRootPath: string, config: ProjectConfig): string {
  return formatProjectContextForPrompt(projectPromptContextOf(workspaceRootPath, config));
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Write `context.md` from `config` and, with a key, record its digest. Returns the bytes written. A project whose
 * `config.json` is gone (deleted since the write that queued this) is skipped and answers `null`.
 */
export function writeProjectContextMirror(
  workspaceRootPath: string,
  config: ProjectConfig,
  key: Buffer | undefined,
): Buffer | null {
  if (!existsSync(join(getProjectPath(workspaceRootPath, config.slug), 'config.json'))) return null;
  const ctx = projectPromptContextOf(workspaceRootPath, config);
  const bytes = Buffer.from(formatProjectContextForPrompt(ctx), 'utf-8');
  atomicWriteFileSync(getProjectContextPath(workspaceRootPath, config.slug), bytes.toString('utf-8'));
  if (key) {
    const memory = memoryDigestOf(config, ctx);
    recordHostApproval(workspaceRootPath, key, {
      kind: 'project-context',
      subject: projectContextSubject(config.id),
      digest: sha256(bytes),
      data: { slug: config.slug, assets: assetsDigestOf(ctx.assets), ...(memory !== undefined ? { memory } : {}) },
    });
  }
  return bytes;
}

let mirrorChain: Promise<void> = Promise.resolve();

/** Resolves once every queued mirror write has run (the binding waits for it; tests too). */
export function projectContextMirrorIdle(): Promise<void> {
  return mirrorChain;
}

async function keyOrUndefined(provider: HostApprovalsKeyProvider): Promise<Buffer | undefined> {
  try {
    return await provider.getKey();
  } catch {
    return undefined;
  }
}

const defaultLog = (line: string): void => console.warn(`[project-context] ${line}`);

/**
 * The host's ONE registration of the config-write hook (UA5.2's `setProjectConfigWrittenHook`). Mirror writes are
 * queued in order, because the ledger key is async while the hook is not; {@link resolveProjectContextLayer} waits for
 * the queue, so a turn right after an edit never mistakes a pending mirror for tampering.
 */
export function installProjectContextMirror(options: {
  keyProvider?: () => HostApprovalsKeyProvider;
  log?: (line: string) => void;
} = {}): void {
  const log = options.log ?? defaultLog;
  setProjectConfigWrittenHook((workspaceRootPath, config) => {
    mirrorChain = mirrorChain
      .then(async () => {
        const key = await keyOrUndefined((options.keyProvider ?? getHostApprovalsKeyProvider)());
        writeProjectContextMirror(workspaceRootPath, config, key);
      })
      .catch(error => log(`mirror write failed for ${config.slug}: ${error instanceof Error ? error.message : String(error)}`));
  });
}

/** The bytes of a REGULAR file at `path`, or null (absent, a directory, a symlink, unreadable). */
function readRegularFile(path: string): Buffer | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * The `instruction` record for the session's project, over bytes the ledger vouches for (module header item 2), or
 * `null` when the project does not exist in this workspace (an explicit missing project is the caller's refusal).
 */
export async function resolveProjectContextLayer(input: {
  workspaceRootPath: string;
  workspaceId: string;
  projectId: string;
  keyProvider?: HostApprovalsKeyProvider;
  log?: (line: string) => void;
}): Promise<ProjectContextLayer | null> {
  await mirrorChain;
  const { workspaceRootPath: root, workspaceId, projectId } = input;
  const log = input.log ?? defaultLog;
  const project = loadProjectById(root, projectId);
  if (!project) return null;
  const { config } = project;
  const path = getProjectContextPath(root, config.slug);
  const key = await keyOrUndefined(input.keyProvider ?? getHostApprovalsKeyProvider());
  const onDisk = readRegularFile(path);
  const entry = key ? findHostApproval(root, key, 'project-context', projectContextSubject(projectId)) : undefined;

  let bytes: Buffer;
  let verdict: ProjectContextVerdict;
  const memoryNow = config.folder ? undefined : sha256(loadProjectMemory(root, config.slug) ?? '');
  const assetsNow = assetsDigestOf(projectAssetManifest(root, config.slug));
  if (onDisk && entry && sha256(onDisk) === entry.digest && entry.data?.memory === memoryNow && entry.data?.assets === assetsNow) {
    bytes = onDisk;
    verdict = 'verified';
  } else if (onDisk && entry && sha256(onDisk) === entry.digest) {
    // UA5.12 / UA5.6 — the host's own bytes, but MEMORY.md or assets/ moved since: re-render, no tamper line.
    verdict = 'refreshed';
    const written = writeProjectContextMirror(root, config, key);
    if (!written) return null;
    bytes = written;
  } else {
    verdict = !key ? 'unverified' : !onDisk && !entry ? 'missing' : 'tampered';
    if (verdict === 'tampered') log(`project-context-tampered: ${config.slug} (re-rendered from config.json)`);
    else log(`project-context-${verdict}: ${config.slug} (rendered from config.json)`);
    const written = writeProjectContextMirror(root, config, key);
    if (!written) return null;
    bytes = written;
  }

  let revision = '0';
  try {
    revision = String(statSync(path).mtimeMs);
  } catch {
    // The materializer re-stats and fails the read as stale; nothing here reaches a prompt.
  }
  return {
    verdict,
    record: {
      key: ['instruction', 'workspace', workspaceId, '-', config.slug, PROJECT_CONTEXT_LOGICAL_NAME].join('::'),
      kind: 'instruction',
      scope: { kind: 'workspace', workspaceId },
      logicalName: PROJECT_CONTEXT_LOGICAL_NAME,
      sourcePath: path,
      revision,
      contentHash: sha256(bytes),
      mutable: false,
    },
  };
}
