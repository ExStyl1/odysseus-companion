/**
 * Manifest component-path resolution, shared by the Claude and Codex adapters
 * (B1a Task 1).
 *
 * `plugins-reference.md` § Path behavior rules, "For all path fields" (`:644`):
 * "All paths must be relative to the plugin root and start with `./`". And
 * § Path traversal limitations (`:773`): "Installed plugins cannot reference
 * files outside their directory. Paths that traverse outside the plugin root
 * (such as `../shared-utils`) will not work after installation".
 *
 * ## Why containment lives here, and why it is not downstream
 *
 * Before B1a a manifest path was an inert string: `isClaudeCustomPathOverride`
 * classified `"commands": ["../../../../etc"]` as a valid override and the
 * adapter then ignored it, so nothing read it. The two containment gates this
 * repo already had — `validatePluginRelativePath` (`schema.ts`) and
 * `isContainedRelative` (`projection-candidates.ts`) — sit downstream of
 * normalization and only ever see paths an adapter built from its own `readdir`
 * results. Resolving a manifest path turns that inert string into a real
 * filesystem read primitive, so the gate must sit at the manifest seam, before
 * any `join()`. A plugin manifest is untrusted input.
 *
 * ## The `./` prefix: normalised, not rejected — and why
 *
 * `:644` states the rule but the docs describe no failure mode for omitting it,
 * and both adapters have always stripped a leading `./` before use
 * (`normalizeCodexPathText`, `normalizeClaudePathText`). Our own shipped corpus
 * relies on that: the `codex-core` and `codex-deferred` fixtures declare
 * `"skills": "skills"` with no prefix, and `format-adapters.test.ts` declares
 * `"skills": "custom-skills-dir"`. Rejecting a bare relative path would break
 * bundles that load correctly today, for a rule whose purpose is disambiguation
 * rather than safety — containment is enforced separately and unconditionally
 * below. So a missing `./` is accepted, normalised away, and NOT reported: it
 * changes nothing about which file is read.
 *
 * What is rejected is anything the prefix rule exists to exclude: an absolute
 * path, a home-relative path, a Windows drive path, a backslash separator, a NUL
 * byte, and any `..` segment.
 *
 * ## Symlinks
 *
 * `:779`-`:781`: a symlink resolving "within the plugin's own directory" is
 * preserved, and one resolving "outside the marketplace" is "skipped for
 * security. This prevents plugins from pulling arbitrary host files such as
 * system paths into the cache." The string gate cannot see through a symlink, so
 * `manifestPathEscapesBundle` re-checks the realpath of anything that exists.
 */
import { readdir, realpath, stat, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { validatePluginRelativePath } from '../schema.ts';
import { pluginDiagnostic } from '../schema.ts';
import type { PluginDiagnostic } from '../types.ts';
import type { UnknownRecord } from './shared.ts';

/**
 * Bundle-relative path text with the documented `./` prefix removed and, for
 * directory fields, any trailing slashes trimmed. An empty result means the
 * plugin root itself — the shape `:647`'s own example `"skills": ["./"]` uses.
 */
export function normalizeManifestPathText(rawPath: string, allowDirectory = false): string {
  let normalized = rawPath.trim();
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (allowDirectory) normalized = normalized.replace(/\/+$/, '');
  return normalized === '.' ? '' : normalized;
}

/**
 * Containment gate for a raw manifest path. Pure by construction — string input,
 * string output, no filesystem access at all — so a rejected path cannot have
 * been read. Returns `null` when the path is a legal bundle-relative reference,
 * including the empty/`./` form that names the plugin root.
 */
export function manifestPathContainmentError(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return 'Path is required';
  // `~` is not expanded by `join()`, so it stays contained — but a manifest
  // author writing it means a home-relative path, and silently reading
  // `<bundle>/~/x` instead is worse than refusing.
  if (trimmed === '~' || trimmed.startsWith('~/')) return `Home-relative path not allowed: ${rawPath}`;
  const normalized = normalizeManifestPathText(trimmed, true);
  if (!normalized) return null;
  return validatePluginRelativePath(normalized);
}

/**
 * True when a declared path, once resolved through symlinks, lands outside the
 * bundle (`:781`). A path that does not exist cannot escape: the pure gate above
 * already proved the declared text is bundle-relative, and reporting a missing
 * directory as an escape attempt would misname an ordinary authoring mistake.
 */
export async function manifestPathEscapesBundle(rootDirectory: string, relativePath: string): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await realpath(rootDirectory);
  } catch {
    return false;
  }
  let realTarget: string;
  try {
    realTarget = await realpath(relativePath ? join(rootDirectory, relativePath) : rootDirectory);
  } catch {
    return false;
  }
  if (realTarget === realRoot) return false;
  const outward = relative(realRoot, realTarget);
  return outward === '..' || outward.startsWith('../') || outward.startsWith('..\\') || isAbsolute(outward);
}

/** One accepted, normalized, contained bundle-relative component path. */
export interface ManifestComponentPath {
  /** Bundle-relative and normalized; `''` names the plugin root (`:647`). */
  path: string;
  /** The manifest entry this came from, for diagnostics. */
  diagnosticPath: string;
}

export interface ManifestComponentPathResolution {
  /**
   * Whether the manifest declared this field at all. An absent field and an
   * empty collection both declare nothing — the same rule the existing deferral
   * reader already applied to `hooks: {}` / `mcpServers: []`.
   */
  declared: boolean;
  /** Accepted paths, in manifest order. */
  paths: ManifestComponentPath[];
  /**
   * A documented inline configuration object, for the "own merge rules" fields
   * (`:638`: hooks, MCP servers, LSP servers) whose value may be config rather
   * than a path. Never a path list.
   */
  inline?: UnknownRecord | unknown[];
  /** Entries refused by the containment gate, with the reason. */
  rejected: Array<{ raw: string; reason: string; diagnosticPath: string }>;
}

/**
 * The single resolver every manifest component path field goes through.
 *
 * Accepts the documented shapes: `string`, `string[]`, and — for the own-rules
 * fields — an inline object. A record whose values are ALL strings is Claude's
 * documented multi-path override shape and resolves as paths; anything else with
 * an object shape is inline configuration and is returned untouched for the
 * caller to defer or parse.
 *
 * Containment is enforced here, before the caller can build an absolute path.
 */
export function resolveManifestComponentPaths(
  value: unknown,
  options: { field: string; allowDirectory?: boolean },
): ManifestComponentPathResolution {
  const { field, allowDirectory = true } = options;
  const empty: ManifestComponentPathResolution = { declared: false, paths: [], rejected: [] };
  if (value === undefined || value === null) return empty;

  const accept = (raw: unknown, diagnosticPath: string, into: ManifestComponentPathResolution): void => {
    if (typeof raw !== 'string') {
      into.rejected.push({ raw: String(raw), reason: 'Path must be a string', diagnosticPath });
      return;
    }
    const reason = manifestPathContainmentError(raw);
    if (reason) {
      into.rejected.push({ raw, reason, diagnosticPath });
      return;
    }
    into.paths.push({ path: normalizeManifestPathText(raw, allowDirectory), diagnosticPath });
  };

  if (typeof value === 'string') {
    if (!value.trim()) return empty;
    const resolution: ManifestComponentPathResolution = { declared: true, paths: [], rejected: [] };
    accept(value, field, resolution);
    return resolution;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return empty;
    if (!value.every(entry => typeof entry === 'string')) {
      return { declared: true, paths: [], rejected: [], inline: value };
    }
    const resolution: ManifestComponentPathResolution = { declared: true, paths: [], rejected: [] };
    value.forEach((entry, index) => accept(entry, `${field}.${index}`, resolution));
    return resolution;
  }

  if (typeof value === 'object') {
    const record = value as UnknownRecord;
    const entries = Object.entries(record);
    if (entries.length === 0) return empty;
    if (!entries.every(([, entry]) => typeof entry === 'string')) {
      return { declared: true, paths: [], rejected: [], inline: record };
    }
    const resolution: ManifestComponentPathResolution = { declared: true, paths: [], rejected: [] };
    for (const [key, entry] of entries) accept(entry, `${field}.${key}`, resolution);
    return resolution;
  }

  // A boolean/number is neither a path nor a config object.
  return { declared: true, paths: [], rejected: [{ raw: String(value), reason: 'Path must be a string', diagnosticPath: field }] };
}

/**
 * True when any declared path names the field's documented default path exactly.
 * Widened from the Codex-only `declaresDefaultPath` to the array and
 * record-of-strings shapes: `:636`'s own "keep the default and add more" example
 * is an array (`"commands": ["./commands/", "./extras/"]`), and the string-only
 * reader silently scanned the default a second time for it.
 */
export function declaresManifestDefaultPath(value: unknown, defaultPath: string, allowDirectory = false): boolean {
  const resolution = resolveManifestComponentPaths(value, { field: 'path', allowDirectory });
  return resolution.paths.some(entry => entry.path === defaultPath);
}

/**
 * True when a normalized path names the default folder or something inside it.
 * `:640`'s stated exception to the ignored-folder warning: "Claude Code doesn't
 * warn when the manifest key points into the default folder, for example
 * `"commands": ["./commands/deploy.md"]`, because that path names the folder
 * explicitly."
 */
export function manifestPathIsWithinDefault(normalizedPath: string, defaultPath: string): boolean {
  return normalizedPath === defaultPath || normalizedPath.startsWith(`${defaultPath}/`);
}

/**
 * Shared replacement for the byte-identical `normalizeClaudeRelativePath` /
 * `normalizeCodexRelativePath` pair. Single-path fields (an MCP `cwd`, a hooks
 * file) where the empty/root form is meaningless and stays an error.
 */
export function resolveManifestRelativePath(
  rawPath: string,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
  options: { reasonCode: string; allowDirectory?: boolean },
): string | undefined {
  const normalized = normalizeManifestPathText(rawPath, options.allowDirectory);
  if (!normalized) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      options.reasonCode,
      'Path is empty after normalization.',
      diagnosticPath,
      { path: rawPath },
    ));
    return undefined;
  }
  const pathError = manifestPathContainmentError(rawPath) ?? validatePluginRelativePath(normalized);
  if (pathError) {
    diagnostics.push(pluginDiagnostic('warning', options.reasonCode, pathError, diagnosticPath, { path: rawPath }));
    return undefined;
  }
  return normalized;
}

/**
 * `lstat`-based probes: a symlink is neither a regular file nor a regular
 * directory. Kept as the Codex adapter's existing default so its behaviour is
 * unchanged by the extraction. Pass `followSymlinks` where the caller has
 * already run `manifestPathEscapesBundle`, which is what makes `:779`'s
 * "preserved as a relative symlink … it keeps resolving to the copied target"
 * loadable without also admitting `:781`'s out-of-bundle case.
 */
export async function isManifestFile(path: string, followSymlinks = false): Promise<boolean> {
  try {
    return (await (followSymlinks ? stat : lstat)(path)).isFile();
  } catch {
    return false;
  }
}

export async function isManifestDirectory(path: string, followSymlinks = false): Promise<boolean> {
  try {
    return (await (followSymlinks ? stat : lstat)(path)).isDirectory();
  } catch {
    return false;
  }
}

/** One discovered `<slug>/SKILL.md` under a scanned directory. */
export interface DiscoveredManifestSkill {
  slug: string;
  path: string;
}

/**
 * What a declared skills path turned out to be. `:647` and `:649` are different
 * cases and the caller must be able to tell them apart, so the direct-`SKILL.md`
 * layout is reported as its own variant rather than folded into the nested scan.
 */
export type ManifestSkillScan =
  /** The directory contains a `SKILL.md` directly (`:647`). */
  | { kind: 'root-skill'; directory: string; skillPath: string }
  /** The directory was scanned for `<slug>/SKILL.md` children. */
  | { kind: 'nested'; directory: string; skills: DiscoveredManifestSkill[] }
  /** The directory does not exist or could not be read. */
  | { kind: 'missing'; directory: string };

/**
 * Scan one bundle-relative directory for skills. Returns locations only: the
 * capability id namespace, the invocation-name rule and the diagnostic
 * vocabulary differ per adapter and stay with the adapter.
 */
export async function scanManifestSkillDirectory(
  rootDirectory: string,
  directory: string,
): Promise<ManifestSkillScan> {
  const absoluteDirectory = directory ? join(rootDirectory, directory) : rootDirectory;
  const prefix = directory ? `${directory}/` : '';
  if (existsSync(join(absoluteDirectory, 'SKILL.md'))) {
    return { kind: 'root-skill', directory, skillPath: `${prefix}SKILL.md` };
  }
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    return { kind: 'missing', directory };
  }
  const skills: DiscoveredManifestSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = `${prefix}${entry.name}/SKILL.md`;
    if (!existsSync(join(rootDirectory, skillPath))) continue;
    skills.push({ slug: entry.name, path: skillPath });
  }
  return { kind: 'nested', directory, skills };
}

/**
 * Scan one bundle-relative directory for component files with the given
 * extension (`commands/*.md`, `agents/*.md`, `workflows/*.js`), or accept the
 * path itself when it names such a file. `:636`'s own example list mixes both
 * (`"./custom/cmd.md"` and `"./commands/"`).
 *
 * P6.740 — the scan stays ONE LEVEL, and `directories` is what makes that
 * honest. Subdirectory names are reported rather than skipped so the caller can
 * say what it ignored; see `claude.ts` `collectClaudeComponentFiles` for why
 * recursing here would be wrong for every kind that uses this expander.
 *
 * C3.352 — `rejectedExtensions` is the same honesty one level down, for FILES.
 * A directory holding `audit.ts` where the loader wants `.js` used to expand to
 * an empty `files` list indistinguishable from an empty directory, and C5.28
 * measured what that costs: a plugin workflow written as `.ts` installed
 * `ok: true, state: "supported"` and the SDK's own runtime then answered
 * `Workflow "…" not found`. The extensions actually present are returned so the
 * caller can name them; nothing here decides what to say about them, because the
 * diagnostic vocabulary is the adapter's.
 */
export async function expandManifestComponentDirectory(
  rootDirectory: string,
  entry: ManifestComponentPath,
  extension: string,
): Promise<
  | { kind: 'files'; files: string[]; directories: string[]; rejectedExtensions: string[] }
  | { kind: 'missing' }
> {
  const absolute = entry.path ? join(rootDirectory, entry.path) : rootDirectory;
  if (entry.path.toLowerCase().endsWith(extension) && await isManifestFile(absolute, true)) {
    return { kind: 'files', files: [entry.path], directories: [], rejectedExtensions: [] };
  }
  if (!await isManifestDirectory(absolute, true)) return { kind: 'missing' };
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return { kind: 'missing' };
  }
  const prefix = entry.path ? `${entry.path}/` : '';
  const files = entries
    .filter(child => child.isFile() && child.name.toLowerCase().endsWith(extension))
    .map(child => `${prefix}${child.name}`);
  const directories = entries
    .filter(child => child.isDirectory())
    .map(child => `${prefix}${child.name}`);
  // Distinct, lowercased, in first-seen order, and only for files that carry an
  // extension at all: a dotfile or an extensionless `README` is not a component
  // shape anyone meant, and naming it would bury the one that matters. A leading
  // dot in the name itself is skipped for the same reason.
  const rejectedExtensions: string[] = [];
  for (const child of entries) {
    if (!child.isFile()) continue;
    const name = child.name.toLowerCase();
    if (name.endsWith(extension)) continue;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) continue;
    const suffix = name.slice(dot);
    if (!rejectedExtensions.includes(suffix)) rejectedExtensions.push(suffix);
  }
  return { kind: 'files', files, directories, rejectedExtensions };
}
