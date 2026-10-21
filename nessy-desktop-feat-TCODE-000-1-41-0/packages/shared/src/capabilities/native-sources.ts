/**
 * Native capability inventory (W6).
 *
 * Enumerates native (non-plugin) capability sources across explicit scopes and
 * emits one qualified `NativeCapabilitySourceRecord` per source. It NEVER
 * collapses duplicates by short name — two skills with the same slug in
 * different scopes both appear, each under a distinct qualified key. W8 owns the
 * final alias/precedence policy; W6 only records provenance.
 *
 * Trust boundary:
 * - Global (`CONFIG_DIR/*`, `~/.agents/skills`) and Workspace layers resolve
 *   without any project trust.
 * - Repository-owned project layers under `workingDirectory` are included ONLY
 *   when `projectTrustState === 'trusted'`. An untrusted project stays the
 *   execution cwd but contributes NO repository-owned content and exactly one
 *   safe, path-free blocked-layer diagnostic.
 *
 * No plugin cache/projection is read here (W7/W8).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import { CONFIG_DIR } from '../config/paths.ts';
import { parseBooleanEnv } from '../feature-flags.ts';
import {
  MANAGED_INSTRUCTION_FILE,
  managedFileTrustVerdict,
  managedSystemDirForPlatform,
} from '../config/managed-system-paths.ts';
import { ICON_EXTENSIONS } from '../utils/icon-constants.ts';
import {
  INSTRUCTION_FILE_MAX_BYTES,
  MEMORY_FILE_NAME,
  MEMORY_IMPORT_DEPTH_LIMIT,
  instructionFileOverSizeLimit,
  readMemoryFile,
} from '../agent/memory/memory-store.ts';
import {
  resolveMemoryImportPath,
  scanMemoryImports,
  stripBlockHtmlComments,
} from '../agent/memory/memory-imports.ts';
import { discoverRuleFiles } from '../agent/memory/rule-discovery.ts';
import {
  createInstructionExcludeMatcher,
  resolveInstructionExcludes,
} from '../agent/memory/instruction-excludes.ts';
import {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  readSkillInvocationControls,
  type SkillInvocationControls,
} from '../skills/storage.ts';
import { parsePermissionsJson, sourceConfigOwnToolsOnly } from '../agent/permissions-config.ts';
import type {
  BlockedCapabilityLayer,
  CapabilityScopeRef,
  DroppedInstructionLayer,
  McpConfigSkip,
  NativeCapabilityInventory,
  NativeCapabilityKind,
  OutsideProjectImport,
  NativeCapabilitySourceRecord,
  SafeSourceConnectorOrigin,
  WorkspacePolicyContext,
} from './types.ts';
import type { CredentialId } from '../credentials/types.ts';
import { NESSY_AGENT_PROJECT_DIR } from '../projects/nessy-agent-layout.ts';
import { normalizeMcpTransportAlias } from '../mcp/server-config-values.ts';
import { normalizeStoredStatus, sanitizeStoredConnectionError } from '../sources/connection-status.ts';
import {
  AGENTS_MD_INSTRUCTION_FILE,
  AGENTS_OVERRIDE_INSTRUCTION_FILE,
  agentsMdSupersededIn,
  isInstructionFileName,
  projectInstructionFilesIn,
} from './instruction-files.ts';

/** Test seam / multi-instance override for the global roots. */
export interface NativeSourcesEnv {
  configDir?: string;
  homeAgentsSkillsDir?: string;
  /**
   * `claudeMdExcludes` equivalent: glob/absolute patterns whose matches are
   * dropped from the inventory (instruction files AND rule files). Omitted, the
   * configured setting is read instead — passing `[]` disables exclusion.
   *
   * A full OVERRIDE of scope resolution, not one more scope: supplying it skips
   * the user/project/local/managed read entirely, which is what makes `[]` mean
   * "no exclusions" for a test that wants the matcher out of the way.
   */
  instructionExcludes?: readonly string[];
  /**
   * The MANAGED scope's `claudeMdExcludes` (`large-codebases.md:155`), off the
   * composed managed policy.
   *
   * Here rather than read inside the resolver because only the bootstrap that
   * composed the managed sources knows which one won, and it already holds the
   * policy at the call site (`storage-runtime.ts:buildCapabilityResolutionInputsV2`).
   * Merged with the other three scopes; it does not override them.
   */
  managedInstructionExcludes?: readonly string[];
  /**
   * The organization-wide system directory (`memory.md:58`'s **Managed policy**
   * row). Omitted, {@link managedSystemDirForPlatform} answers for the current
   * platform; a platform without one contributes no managed tier at all.
   *
   * A test seam and a multi-instance override, exactly like `configDir` — the
   * ownership guard on the file itself is applied either way, so overriding this
   * relocates the tier without weakening it.
   */
  systemDir?: string;
  /**
   * The nested skill roots (working-directory-relative, POSIX-separated) this
   * inventory pass should read, OVERRIDING the process-local registry
   * {@link registerNestedSkillRoots} fills — exactly the way
   * `instructionExcludes` overrides scope resolution, so `[]` means "no nested
   * roots" rather than "read the registry".
   *
   * A test seam first: the production producer is a file touch on the agent's
   * lazy channel, and a test that had to drive the whole gate to assert one
   * record would be testing the gate.
   */
  nestedSkillRoots?: readonly string[];
  /**
   * The administrator-owned skill roots this inventory pass should read. `[]`
   * means "no administrator tier", exactly the way `nestedSkillRoots: []` means
   * "no nested roots"; `getAdminAgentSkillsDirs` (`skills/storage.ts`) is what a caller that
   * wants the machine's own roots passes, and it must pass it.
   *
   * ## Why this one field is REQUIRED where every sibling is optional (P2.461)
   *
   * Because its default was a machine root, and **a default that reads a machine
   * root is a rig hazard by construction**. The production roots are absolute,
   * machine-wide, administrator-provisioned directories, so a caller that left
   * this defaulting read a different set of skills depending on whether the
   * machine running it is centrally managed — green on every developer's laptop,
   * red only on the deployment the tier exists for, with output that looks like a
   * content mismatch rather than a rig defect. P2.455 pinned the six call sites
   * that had it then and built a per-FILE scanner for the seventh; the scanner's
   * own residue says why that was not enough — a rig that keeps the WORD while
   * dropping the ARGUMENT passes a per-file scan, and **a per-call-site check
   * needs a parser. This required field is that parser.**
   *
   * So the only remaining way to read the machine's roots is to name
   * `getAdminAgentSkillsDirs()` at the call site, which is a decision a reader can
   * see. Exactly one caller in this tree does: the production inventory pass in
   * `server-core/src/bootstrap/storage-runtime.ts`.
   *
   * The OPERATOR's off switch is a different lever and stays where it is —
   * `NESSY_ADMIN_SKILLS_DIR`, read inside `getAdminAgentSkillsDirs`, so there is
   * exactly one answer to "which directories are the admin tier" and both loaders
   * get it from the same function.
   */
  adminSkillsDirs: readonly string[];
}

/**
 * Opt-in for loading memory/rule files from `--add-dir` roots — our
 * `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`. Off by default, exactly as
 * documented: "By default, CLAUDE.md files from these directories are not
 * loaded."
 */
export const ADDITIONAL_DIRECTORIES_MEMORY_ENV = 'NESSY_ADDITIONAL_DIRECTORIES_MEMORY';

let inertAdditionalDirectoryRulesWarned = false;

/** Test seam: re-arm the once-per-process inert-opt-in notice. */
export function resetInertAdditionalDirectoryRulesNotice(): void {
  inertAdditionalDirectoryRulesWarned = false;
}

/**
 * Say once that {@link ADDITIONAL_DIRECTORIES_MEMORY_ENV} is set and reaches
 * nothing (P3.339).
 *
 * **The reason it can be inert CHANGED, and so did this sentence.** It used to
 * read "Nothing in this host populates that list today", which was true while
 * `toWorkspacePolicyContext` set no roots at all. Since the owner's sitting §1.4
 * answer (A) that function feeds the list from the persisted
 * `additionalDirectories` setting, so an empty list now means the OPERATOR named
 * no directories — a different problem with a different fix, and telling them to
 * go read a host field would send them to the wrong place.
 *
 * The three runtimes answered this setting three different ways, which is why a
 * session says which answer IT got. This is the host arm's, and it is now the
 * same answer claude's child already gave.
 */
function noticeInertAdditionalDirectoryRules(): void {
  if (inertAdditionalDirectoryRulesWarned) return;
  inertAdditionalDirectoryRulesWarned = true;
  console.warn(
    `[Capabilities] ${ADDITIONAL_DIRECTORIES_MEMORY_ENV} is set, but this session was given no `
    + 'additional rule directories, so no memory or rule files are loaded from them. The list '
    + 'comes from the `additionalDirectories` setting in config.json; an empty or unreadable '
    + 'setting yields no roots.',
  );
}

/**
 * The machine-wide tiers `managedFileTrustVerdict` can withhold, each named as
 * the operator would look for it. One member per tier this file reads out of
 * `systemDir`; adding a third tier means adding a member here, which is the
 * whole point of keying the notice by tier (P6.632).
 */
export type UnverifiableManagedTier = 'instruction' | 'subagent';

const UNVERIFIABLE_MANAGED_TIER_LABELS: Record<UnverifiableManagedTier, string> = {
  instruction: 'instruction file',
  subagent: 'subagent',
};

const unverifiableManagedTiersWarned = new Set<UnverifiableManagedTier>();

/** Test seam: re-arm the once-per-tier withholding notice. */
export function resetUnverifiableManagedTierNotice(): void {
  unverifiableManagedTiersWarned.clear();
}

/**
 * Say once PER TIER that a machine-wide managed tier is WITHHELD on this
 * platform because no ownership check for it exists here (P3.331).
 *
 * `console.warn` for the reason `powershell-validator.ts` gives at the same kind
 * of seam: `debug()` is off unless `NESSY_DEBUG=1`, and the audience is an
 * administrator who deployed a file and needs to know it is not being read.
 *
 * ## Why the latch is a SET and not a boolean (P6.632)
 *
 * The verdict is a property of the platform, so repeating it for one tier is
 * noise — but the family stopped being one tier at P6.239, when the managed
 * SUBAGENT root joined the managed `CLAUDE.md`, and a single boolean tells a
 * win32 operator with both deployed about exactly ONE of them, whichever the
 * loop reaches first. Which one that is depends on directory order, so the
 * operator cannot even tell what they were not told. One line per tier, and the
 * line names the tier.
 *
 * RESIDUE, narrowed rather than papered over: the CALL SITES are reachable only
 * when `managedFileTrustVerdict` answers `unverifiable-platform`, which today
 * means win32, and they read the real `process.platform` — so no darwin test
 * reaches them through the inventory. Giving the inventory a platform seam would
 * widen a type several lanes share for a `console.warn`, which is the wrong
 * trade; this function is exported instead, so the latch and the wording ARE
 * exercised on darwin, and only the two `if` lines above the calls are not. The
 * DECISION they report stays fully pinned by
 * `config/__tests__/managed-system-paths.test.ts`, which drives every verdict by
 * passing the platform explicitly.
 */
export function noticeUnverifiableManagedTier(
  tier: UnverifiableManagedTier,
  path: string,
): void {
  if (unverifiableManagedTiersWarned.has(tier)) return;
  unverifiableManagedTiersWarned.add(tier);
  console.warn(
    `[Capabilities] The machine-wide managed ${UNVERIFIABLE_MANAGED_TIER_LABELS[tier]} at `
    + `${path} is NOT being read: this platform has no implemented ownership check for it, `
    + 'so the file cannot be distinguished from one an unprivileged account planted. '
    + 'See managedFileTrustVerdict.',
  );
}

/**
 * `CLAUDE_CODE_DISABLE_CLAUDE_MDS` — the operator's off switch for instruction
 * and memory layers (P6.588).
 *
 * `env-vars.md#variables`, whole sentence: *"Set to `1` to prevent loading any
 * CLAUDE.md memory files into context, including user, project, and auto memory
 * files"*. The vendored `claude` binary honours it and, until this reader, this
 * tree had ZERO of them — one docblock mention and no code, so an administrator
 * who set it got it on a claude-runtime session and silently lost it on Pi and
 * codex. That asymmetry is the whole subject of ledger L1.
 *
 * ## Why it is host-side, and therefore cannot become a switch divergence
 *
 * Instruction and memory layers reach ALL THREE runtimes through this capability
 * runtime — nothing downstream re-discovers them — so one reader at the single
 * choke point every walk funnels into (`importedFileRecords`) honours it
 * uniformly. Native-first step (2): the host supplies it once, rather than three
 * per-runtime builds of the same suppression.
 *
 * ## Value rule: a standard boolean, so `0` leaves the files loading
 *
 * Read from the shipped bundle rather than guessed: the accessor for this name
 * is `d.bool()`, the same parser its `CLAUDE_CODE_DISABLE_*` siblings use — not
 * the set-at-all rule `DISABLE_TELEMETRY` takes. `parseBooleanEnv` is this
 * tree's spelling of that (`1/true/yes/on`, any casing), a superset of the
 * page's `1`.
 *
 * ## What it covers, stated because the page's noun is narrower than our kinds
 *
 * The page says "CLAUDE.md memory files … including user, project, and auto
 * memory files". Here that is BOTH native kinds, `instruction` and `memory`, and
 * that includes rule files, which ride the `memory` kind through
 * `ruleMemoryRecords`. Including them is the decision: they are context layers
 * loaded at startup exactly like the rest, and leaving them behind would honour
 * "any … files" by half — the shape an operator cannot see and cannot debug.
 * Skills, agents, MCP servers and hooks are NOT touched; they are not memory.
 */
export const DISABLE_INSTRUCTION_FILES_ENV = 'CLAUDE_CODE_DISABLE_CLAUDE_MDS';

let instructionFilesDisabledWarned = false;

/** Test seam: re-arm the once-per-process suppression notice. */
export function resetInstructionFilesDisabledNotice(): void {
  instructionFilesDisabledWarned = false;
}

function instructionFilesDisabled(): boolean {
  return parseBooleanEnv(process.env[DISABLE_INSTRUCTION_FILES_ENV]) === true;
}

/**
 * Say once that every instruction and memory layer is being withheld on purpose.
 *
 * A suppression nobody can see is the same defect class as P6.387's silent
 * refusal: the user writes a CLAUDE.md, nothing loads it, and the session looks
 * broken rather than configured. Latched and `console.warn` for the reason the
 * two notices above give — the audience is the operator who set the variable.
 */
function noticeInstructionFilesDisabled(): void {
  if (instructionFilesDisabledWarned) return;
  instructionFilesDisabledWarned = true;
  console.warn(
    `[Capabilities] ${DISABLE_INSTRUCTION_FILES_ENV} is set, so NO instruction, memory or `
    + 'rule layer is loaded into context on any runtime — user, project and auto memory files '
    + 'alike. Unset it to load them again.',
  );
}

/**
 * Files this inventory pass skipped for being over
 * {@link INSTRUCTION_FILE_MAX_BYTES} (P6.389).
 *
 * ## Why a pass-scoped module variable and not a threaded parameter
 *
 * The rule is the PAGE's and applies to every tier, so every one of the walk's
 * fourteen call sites would have to pass the same sink through three wrapper
 * functions to reach one `if`. That is thirty lines of plumbing for a rule that
 * has no per-call-site variation — the opposite of the smallest honest change.
 *
 * It is safe because `buildNativeCapabilityInventory` is fully SYNCHRONOUS:
 * every read on the path is `readFileSync`/`statSync`, so no second pass can
 * interleave with this one, and the variable is set and cleared by that one
 * function in a `finally`. Contrast the two latched `…Warned` booleans above,
 * which are deliberately process-scoped because they gate a once-per-process
 * log; this one is per-pass because its content belongs to one snapshot.
 *
 * `null` means "no pass is running", which is what makes an accidental call
 * from outside the inventory a no-op rather than a leak into the next pass.
 */
let currentOversizeSkips: DroppedInstructionLayer[] | null = null;

function additionalDirectoryRulesEnabled(): boolean {
  const raw = process.env[ADDITIONAL_DIRECTORIES_MEMORY_ENV]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * The instruction-file rules live in `instruction-files.ts` and are RE-EXPORTED
 * here, so every reader that already imports them from this module keeps its
 * specifier — a re-export, not a copy: there is exactly one rule below the
 * import (P3.241, the shape `utils/tool-grant-list.ts` arrived at first).
 *
 * They moved because two siblings did not learn what P6.35 taught this file:
 * `agent/backend/nestor-cloud/metadata-builder.ts` walked ancestors for
 * `AGENTS.md` with rules of its own, and `agents/definitions.ts` held a second
 * copy of the exclusion set. Neither can import THIS module — it pulls
 * `gray-matter`, the permission parser and the MCP stack, and
 * `agents/definitions.ts` is loaded inside the Pi subprocess — so the rule had
 * to weigh less than its heaviest reader.
 */
export {
  AGENTS_MD_INSTRUCTION_FILE,
  AGENTS_OVERRIDE_INSTRUCTION_FILE,
  INSTRUCTION_FILE_NAMES,
  PROJECT_INSTRUCTION_FILES,
  agentsMdInstructionFilesIn,
  agentsMdSupersededIn,
  instructionFileExistsAt,
  isInstructionFileName,
  projectInstructionFilesIn,
} from './instruction-files.ts';

/** Native kinds that a trusted project's cwd can contribute. */
const PROJECT_WITHHELD_KINDS: NativeCapabilityKind[] = [
  'skill', 'agent', 'mcp', 'hook', 'instruction', 'memory',
];

function contentHashOfFile(path: string): string {
  try {
    return createHash('sha256').update(readFileCached(path)).digest('hex');
  } catch {
    return createHash('sha256').update(path).digest('hex');
  }
}

/**
 * UB12.4 (F1.212's fix rows) — the mtime-keyed read cache under the inventory.
 *
 * `buildNativeCapabilityInventory` ran on EVERY capability resolve — per send,
 * per lifecycle end — and re-READ the whole capability tree synchronously
 * (F1.794's probe: an edit between two resolves was visible, so the per-send
 * cost was the WHOLE tree, sampled 18-22 ms at 41 records and 131-139 ms at
 * 321, linear, on the Electron main thread). The cache makes the unchanged
 * case a `statSync` per file instead of an open+read: same visibility guarantee
 * the probe pinned (an edit bumps mtime → the next read misses and re-reads),
 * most of the cost gone when nothing changed. The identity test is the same
 * one `revisionOf` below already accepts for a whole file: `mtimeMs` + size.
 *
 * Bounded FIFO like {@link nestedSkillRootRegistry}: the tree a busy app
 * carries is hundreds of files, the cap is an order above it, and a workspace
 * switch simply evicts the oldest keys. Process-wide by design — the paths are
 * absolute, so two workspaces cannot collide, and the whole point is to
 * survive ACROSS resolves.
 */
const READ_CACHE_LIMIT = 4096;
const readCache = new Map<string, { mtimeMs: number; size: number; bytes: Buffer }>();

function readFileCached(path: string): Buffer {
  const s = statSync(path);
  const stat = { mtimeMs: s.mtimeMs, size: s.size };
  const hit = readCache.get(path);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    readCacheHits += 1;
    return hit.bytes;
  }
  readCacheMisses += 1;
  const bytes = readFileSync(path);
  if (readCache.size >= READ_CACHE_LIMIT && !readCache.has(path)) {
    const oldest = readCache.keys().next();
    if (!oldest.done) readCache.delete(oldest.value);
  }
  readCache.set(path, { ...stat, bytes });
  return bytes;
}

/** Test seam: hit/miss counters and the cache size, then a reset. */
export function nativeSourceReadCacheStatsForTest(): { hits: number; misses: number; size: number } {
  return { hits: readCacheHits, misses: readCacheMisses, size: readCache.size };
}

export function resetNativeSourceReadCacheForTest(): void {
  readCache.clear();
  readCacheHits = 0;
  readCacheMisses = 0;
}

let readCacheHits = 0;
let readCacheMisses = 0;

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Parse only safe Skill display metadata from the exact bytes being hashed. */
function pinnedSkillMetadata(path: string): {
  contentHash: string;
  displayName?: string;
  description?: string;
  alwaysAllow?: string[];
} & SkillInvocationControls {
  try {
    const bytes = readFileCached(path);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    try {
      const parsed = matter(bytes.toString('utf-8'));
      const data = (parsed.data ?? {}) as Record<string, unknown>;
      const displayName = trimmedString(data.name);
      const description = trimmedString(data.description);
      const alwaysAllow = safeStringArray(data.alwaysAllow);
      return {
        contentHash,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(alwaysAllow.length > 0 ? { alwaysAllow } : {}),
        // Shared with `skills/storage.ts`'s parser so the two readers of the
        // same frontmatter can never disagree on field names or spellings.
        ...readSkillInvocationControls(data),
      };
    } catch {
      return { contentHash };
    }
  } catch {
    return { contentHash: createHash('sha256').update(path).digest('hex') };
  }
}

/**
 * Parse the one REQUIRED display field of a native `agents/*.md` definition from
 * the exact bytes being hashed, the way {@link pinnedSkillMetadata} does for a
 * skill — one read, no second open.
 *
 * P6.602. `sub-agents.md` § *Supported frontmatter fields*: "Only `name` and
 * `description` are required", and the `description` row reads "When Claude
 * should delegate to this subagent". The SDK takes that string as-is, so if the
 * host never carries it the field cannot be recovered downstream:
 * `claude-runtime-agents.ts` substitutes `Imported <name> agent.` for an empty
 * one, and the model then matches every native agent against the same
 * contentless sentence.
 *
 * Display metadata only — never the body, never a path.
 */
/**
 * P6.551 — the agent frontmatter keys the CATALOG needs, read here because this
 * function is already reading the frontmatter.
 *
 * `codexDeclinesAgentToolGrant`'s docblock said a file-based agent's grant "is
 * not knowable here" because `markdownAgentRecords` "hashes the file and reads
 * nothing out of it". That was true of the record and NOT of this function,
 * which has parsed the frontmatter for `description` since it was written. So
 * the seam the row weighed against carrying a per-session verdict back into the
 * capability layer costs one more key off a parse that already happens — no
 * extra read, no extra file, no new clock.
 *
 * PRESENCE and not content, matching the writer exactly: `buildCodexAgentRoles`
 * tests `if (descriptor.tools || descriptor.disallowedTools)`, and the
 * materializer turns a present-but-empty `tools:` into `[]`, which is truthy.
 * A key written with no value parses as `null` here and is still PRESENT, which
 * is why the test is `in` rather than a truthiness check on the value —
 * `tools:` alone is an author declaring a grant of nothing, and codex refuses
 * the role rather than silently widening it to the session's whole surface.
 *
 * Both documented spellings of the second key (`disallowedTools` and the
 * hyphenated `disallowed-tools`) are accepted, because
 * `materializePiRuntimeAgentDefinitions` accepts both and a narrower reader here
 * would let one spelling read `active` and the other not.
 */
function pinnedAgentMetadata(
  path: string,
): { contentHash: string; description?: string; declaresToolGrant?: boolean } {
  try {
    const bytes = readFileCached(path);
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    try {
      const data = (matter(bytes.toString('utf-8')).data ?? {}) as Record<string, unknown>;
      const description = trimmedString(data.description);
      const declaresToolGrant = 'tools' in data
        || 'disallowedTools' in data
        || 'disallowed-tools' in data;
      return {
        contentHash,
        ...(description ? { description } : {}),
        ...(declaresToolGrant ? { declaresToolGrant: true } : {}),
      };
    } catch {
      return { contentHash };
    }
  } catch {
    return { contentHash: createHash('sha256').update(path).digest('hex') };
  }
}

/** Trimmed, non-empty string entries of an unknown value (frontmatter list). */
function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const trimmed = trimmedString(item);
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * Project a source's `permissions.json` into a read-only pattern/access view
 * (U2). Only tool/bash/api/mcp rules are captured — path-based rules
 * (`allowedWritePaths`/`deniedPaths`) are DELIBERATELY EXCLUDED because they may
 * hold absolute filesystem paths, which the Safe model forbids from reaching
 * the renderer. Returns `undefined` when the file is missing or carries no
 * captured rule, so the record field stays omit-when-empty. F1.1153: read through {@link sourceConfigOwnToolsOnly}.
 */
function pinnedSourcePermissions(
  permissionsPath: string, sourceSlug: string, // F1.1153 — the grants the runtime ignores (DN-231) are not "allowed"
): Array<{ pattern: string; access: 'allowed' | 'blocked' }> | undefined {
  if (!existsSync(permissionsPath)) return undefined;
  let config: ReturnType<typeof parsePermissionsJson>;
  try {
    config = sourceConfigOwnToolsOnly(parsePermissionsJson(readFileSync(permissionsPath, 'utf8')), sourceSlug);
  } catch {
    return undefined;
  }
  const rows: Array<{ pattern: string; access: 'allowed' | 'blocked' }> = [];
  const push = (pattern: string, access: 'allowed' | 'blocked') => {
    const trimmed = trimmedString(pattern);
    if (trimmed) rows.push({ pattern: trimmed, access });
  };
  for (const entry of config.allowedBashPatterns) push(entry.pattern, 'allowed');
  for (const pattern of config.allowedMcpPatterns) push(pattern, 'allowed');
  for (const rule of config.allowedApiEndpoints) push(`${rule.method} ${rule.path}`, 'allowed');
  for (const pattern of config.allowedTools) push(pattern, 'allowed');
  for (const pattern of config.disallowedTools) push(pattern, 'blocked');
  for (const pattern of config.deniedToolPatterns) push(pattern, 'blocked');
  // Per-tool rules: allow → allowed; deny/ask → blocked (a non-auto verdict).
  for (const rule of config.toolRules) push(rule.pattern, rule.action === 'allow' ? 'allowed' : 'blocked');
  return rows.length > 0 ? rows : undefined;
}

function revisionOf(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return '0';
  }
}

const ICON_MIME_BY_EXTENSION: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Capture the first conventional icon once; hash and data URL share bytes. */
function pinnedIconResource(
  directory: string,
): NativeCapabilitySourceRecord['iconResource'] {
  for (const extension of ICON_EXTENSIONS) {
    const iconPath = join(directory, `icon${extension}`);
    if (!existsSync(iconPath)) continue;
    try {
      const bytes = readFileSync(iconPath);
      return {
        revision: revisionOf(iconPath),
        contentHash: createHash('sha256').update(bytes).digest('hex'),
        dataUrl: `data:${ICON_MIME_BY_EXTENSION[extension] ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`,
      };
    } catch {
      // A broken/unreadable candidate is not an icon; preserve normal fallback.
    }
  }
  return undefined;
}

/** Same-scope precedence tier tag (nessy-native > portable compatibility). */
function withTier(
  records: NativeCapabilitySourceRecord[],
  sourceTier: 'nessy' | 'portable',
): NativeCapabilitySourceRecord[] {
  return records.map(record => ({ ...record, sourceTier }));
}

/** Stamp the owning directory onto a nested layer's skill records. */
function withNestedSkillQualifier(
  records: NativeCapabilitySourceRecord[],
  qualifier: string,
): NativeCapabilitySourceRecord[] {
  return records.map(record => ({ ...record, skillDirectoryQualifier: qualifier }));
}

/** True when `path` resolves inside the already-realpathed root. */
function insideRealRoot(path: string, realRoot: string): boolean {
  try {
    const real = realpathSync(path);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

function qualifiedKey(
  kind: NativeCapabilityKind,
  scope: CapabilityScopeRef,
  logicalName: string,
  discriminator = '',
): string {
  return [
    kind,
    scope.kind,
    scope.workspaceId ?? '-',
    scope.projectKey ?? '-',
    discriminator,
    logicalName,
  ].join('::');
}

/**
 * Exported for read-only reuse by the Claude-setup importer
 * (`claude-setup-import.ts`), which points it at `~/.claude/skills` — the exact
 * `<dir>/<slug>/SKILL.md` layout this reader already handles for every other
 * native skill tier. Only `logicalName` (the slug) and `sourcePath` (the skill
 * directory) are consumed there.
 */
export function skillRecords(
  skillsDir: string,
  scope: CapabilityScopeRef,
  discriminator = '',
  containRealRoot?: string,
): NativeCapabilitySourceRecord[] {
  if (!existsSync(skillsDir)) return [];
  const records: NativeCapabilitySourceRecord[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    const slugPath = join(skillsDir, entry.name);
    const skillFile = join(slugPath, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    // Reject symlink/traversal escapes from the verified root before hashing.
    if (containRealRoot && !insideRealRoot(skillFile, containRealRoot)) continue;
    const iconResource = pinnedIconResource(slugPath);
    const metadata = pinnedSkillMetadata(skillFile);
    records.push({
      key: qualifiedKey('skill', scope, entry.name, discriminator),
      kind: 'skill',
      scope,
      logicalName: entry.name,
      ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(metadata.alwaysAllow ? { skillAlwaysAllow: metadata.alwaysAllow } : {}),
      ...(metadata.disableModelInvocation === undefined
        ? {}
        : { skillDisableModelInvocation: metadata.disableModelInvocation }),
      ...(metadata.userInvocable === undefined ? {} : { skillUserInvocable: metadata.userInvocable }),
      ...(metadata.allowedTools ? { skillAllowedTools: metadata.allowedTools } : {}),
      ...(metadata.paths ? { skillPaths: metadata.paths } : {}),
      ...(iconResource ? { iconResource } : {}),
      sourcePath: slugPath,
      revision: revisionOf(skillFile),
      contentHash: metadata.contentHash,
      mutable: true,
    });
  }
  return records.sort((a, b) => a.key.localeCompare(b.key));
}

function markdownAgentRecords(
  agentsDir: string,
  scope: CapabilityScopeRef,
  containRealRoot?: string, discriminator = '',
): NativeCapabilitySourceRecord[] {
  if (!existsSync(agentsDir)) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile()
      && entry.name.toLowerCase().endsWith('.md')
      // Instruction files (AGENTS.md / CLAUDE*) are never agent definitions.
      && !isInstructionFileName(entry.name))
    .filter(entry => !containRealRoot || insideRealRoot(join(agentsDir, entry.name), containRealRoot))
    .map(entry => {
      const filePath = join(agentsDir, entry.name);
      const logicalName = entry.name.replace(/\.md$/i, '');
      const metadata = pinnedAgentMetadata(filePath);
      return {
        key: qualifiedKey('agent', scope, logicalName, discriminator),
        kind: 'agent' as const,
        scope,
        logicalName,
        ...(metadata.description ? { description: metadata.description } : {}),
        // P6.551 — omitted rather than `false`, so the capability generation
        // does not move for every agent file the first time this is read.
        ...(metadata.declaresToolGrant ? { agentDeclaresToolGrant: true } : {}),
        sourcePath: filePath,
        revision: revisionOf(filePath),
        contentHash: metadata.contentHash,
        mutable: true,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

function fileRecord(
  kind: NativeCapabilityKind,
  path: string,
  scope: CapabilityScopeRef,
  logicalName: string,
  discriminator = '',
  containRealRoot?: string,
): NativeCapabilitySourceRecord | null {
  if (!existsSync(path)) return null;
  if (containRealRoot && !insideRealRoot(path, containRealRoot)) return null;
  return {
    key: qualifiedKey(kind, scope, logicalName, discriminator),
    kind,
    scope,
    logicalName,
    sourcePath: path,
    revision: revisionOf(path),
    contentHash: contentHashOfFile(path),
    mutable: true,
  };
}

/**
 * A file an instruction import must NOT claim as an instruction record, because
 * another discovery pass owns it and that pass carries semantics this one does
 * not.
 *
 * - `MEMORY.md` is the auto-memory index. Its 200-line / 25 KB load cap
 *   (`memory.md:384`) is keyed off the record being a non-imported `memory`
 *   layer (`isMemoryIndexLayer`), so registering it as an instruction import
 *   would silently remove the cap AND take its `memory` record away, since one
 *   file gets one record.
 * - anything under a `rules` directory is a rule file, whose `paths:`
 *   frontmatter decides whether it loads at all. Claiming one as an instruction
 *   import drops `format: 'rule'` and promotes a path-scoped rule to an
 *   unconditional one.
 *
 * Nothing is lost by refusing: if that other pass produced a layer for the same
 * file, `composeMemoryLayerBodies` still resolves the token against it. The
 * guard only decides which pass OWNS the record.
 */
function instructionImportOwnedElsewhere(path: string): boolean {
  if (basename(path) === MEMORY_FILE_NAME) return true;
  return dirname(path).split(sep).includes('rules');
}

/**
 * The bytes an import walk scans, which is NOT the same read for both families.
 *
 * A memory file is line-capped on the way in (`readMemoryFile`), and R55
 * accepted the consequence there. An instruction file is delivered UNCAPPED by
 * the pinned block, so scanning only its first `MEMORY_LOAD_LINE_LIMIT` lines
 * would ship the `@path` line to the model while never registering the file it
 * names — the exact silent failure this unit exists to remove.
 */
function importWalkSource(kind: 'memory' | 'instruction', path: string): string {
  if (kind === 'memory') return readMemoryFile(path);
  try {
    return readFileCached(path).toString('utf-8');
  } catch {
    return '';
  }
}

function memoryFileRecords(
  entryPath: string,
  containmentRoot: string,
  scope: CapabilityScopeRef,
  logicalName: string,
  discriminator: string,
  seen: Set<string>,
  rootMemoryFormat?: 'rule',
  refusedImports?: OutsideProjectImport[],
): NativeCapabilitySourceRecord[] {
  return importedFileRecords('memory', entryPath, containmentRoot, scope, logicalName, discriminator, seen, rootMemoryFormat, refusedImports);
}

/**
 * One instruction file and every file its `@path` imports pull in, as records.
 *
 * `memory.md:95` — "CLAUDE.md files can import additional files using
 * `@path/to/import` syntax. Imported files are expanded and loaded into context
 * at launch alongside the CLAUDE.md that references them." R55 built the scanner
 * and wired it to MEMORY.md and rules; this is the file family the sentence
 * literally names, and until R77 an `@README` inside a CLAUDE.md became no
 * record, so it could never load however the composers behaved.
 *
 * The `seen` set is SHARED with the memory walks — one file, one record, one
 * qualified key. That is what makes the flagship case (`CLAUDE.md` whose body is
 * `@AGENTS.md`, beside an `AGENTS.md` already registered as its own root) resolve
 * at COMPOSE time rather than here; see `memory-layers.ts` for that half of the
 * rule.
 */
function instructionFileRecords(
  entryPath: string,
  containmentRoot: string,
  scope: CapabilityScopeRef,
  logicalName: string,
  discriminator: string,
  seen: Set<string>,
  refusedImports?: OutsideProjectImport[],
): NativeCapabilitySourceRecord[] {
  return importedFileRecords('instruction', entryPath, containmentRoot, scope, logicalName, discriminator, seen, undefined, refusedImports);
}

function importedFileRecords(
  kind: 'memory' | 'instruction',
  entryPath: string,
  containmentRoot: string,
  scope: CapabilityScopeRef,
  logicalName: string,
  discriminator: string,
  seen: Set<string>,
  rootMemoryFormat?: 'rule',
  /**
   * P6.387 — sink for an `@path` import whose target resolves OUTSIDE the
   * containment root. Optional because most walks (global, workspace, rules)
   * have no project to be outside of; the project-scope call sites pass it.
   */
  refusedImports?: OutsideProjectImport[],
): NativeCapabilitySourceRecord[] {
  // P6.588 — the one reader for `CLAUDE_CODE_DISABLE_CLAUDE_MDS`. Every
  // instruction, memory and rule walk in this file funnels here, so the switch
  // is honoured once for all three runtimes instead of three times.
  if (instructionFilesDisabled()) {
    noticeInstructionFilesDisabled();
    return [];
  }
  let root: string;
  try {
    root = realpathSync(containmentRoot);
  } catch {
    return [];
  }

  const records: NativeCapabilitySourceRecord[] = [];
  const visit = (path: string, depth: number, parentPath?: string): void => {
    const resolvedPath = resolve(path);
    let current: string;
    try {
      current = realpathSync(resolvedPath);
      if (!statSync(current).isFile()) return;
    } catch {
      return;
    }
    const relativePath = relative(root, current);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      // P6.387 — this used to be a bare `return`. The containment decision
      // STANDS: an instruction file outside the project must not enter a
      // trusted project's context on the say-so of a line inside it. What was
      // wrong is that it happened in silence — the author wrote `@~/notes.md`,
      // nothing loaded it, and no surface anywhere said why. A refusal nobody
      // can see is indistinguishable from a bug in the import scanner.
      //
      // Only `depth > 0` is an IMPORT. At depth 0 the entry file itself is
      // outside the root, which is the caller handing us a path it should not
      // have — a different fault with no author to inform.
      if (depth > 0 && parentPath) {
        refusedImports?.push({
          // The path AS THE IMPORT ADDRESSED IT, not its realpath — the same
          // choice every `sourcePath` in this file makes. It is the string the
          // author can relate to the `@` line they wrote and edit. A symlink
          // that leaves the project is therefore named by the link, which is
          // the thing inside the project and the thing they can change.
          path: resolvedPath,
          importerPath: parentPath,
          reason: 'outside-containment-root',
        });
      }
      return;
    }

    const seenKey = `${scope.kind}:${scope.workspaceId ?? ''}:${scope.projectKey ?? ''}:${current}`;
    if (seen.has(seenKey)) return;
    seen.add(seenKey);

    // P6.389 — `memory.md`: "Claude Code loads a CLAUDE.md file of up to 4 MiB
    // in full and skips a larger file." SKIP means no record at all, not a
    // truncated one: a record is what puts a file in the Sources list and in
    // the composed context, so emitting one for a file we will not read would
    // promise a layer that never arrives. Recorded rather than dropped in
    // silence, on the same surface the ancestor cap uses, because a bound that
    // hides its own effect is indistinguishable from a defect (P6.388).
    //
    // Deliberately AFTER the `seen` insert: the file is genuinely accounted
    // for, so a second walk reaching the same path does not report it twice.
    // Deliberately BEFORE the import recursion: an unread file's `@path` lines
    // are not requests we ever saw.
    if (instructionFileOverSizeLimit(current)) {
      currentOversizeSkips?.push({
        path: resolvedPath,
        reason: 'over-size-limit',
        limit: INSTRUCTION_FILE_MAX_BYTES,
      });
      return;
    }

    const imported = depth > 0;
    const name = imported ? basename(current) : logicalName;
    records.push({
      key: qualifiedKey(
        kind,
        scope,
        name,
        imported
          ? `import-${createHash('sha256').update(relativePath).digest('hex').slice(0, 16)}`
          : discriminator,
      ),
      kind,
      scope,
      logicalName: name,
      ...(!imported && rootMemoryFormat ? { memoryFormat: rootMemoryFormat } : {}),
      // The importer, for the documented `parent_file_path` an
      // `InstructionsLoaded` `include` load carries.
      ...(imported && parentPath ? { memoryImportParentPath: parentPath } : {}),
      sourcePath: resolvedPath,
      revision: revisionOf(resolvedPath),
      contentHash: contentHashOfFile(resolvedPath),
      mutable: true,
    });

    if (depth >= MEMORY_IMPORT_DEPTH_LIMIT) return;
    // DISCOVERY, not loading — deliberately NOT byte-capped, decided rather than
    // inherited. `readMemoryFile` keeps its line-only slice and
    // `capMemoryIndexLoad` (the 200-line / 25 KB index load cap, `memory.md:384`)
    // is applied where the body is composed instead. A byte cut here would change
    // which files become `memory` RECORDS, and the record set is hashed into the
    // capability snapshot: every user with a >25 KB MEMORY.md would get a new
    // generation, a different Sources list and a different `InstructionsLoaded`
    // set. Consequence accepted and named: an `@path` line sitting past the load
    // cut still registers its target as a record, and an imported layer's body is
    // not index-capped, so that topic file still loads while the line requesting
    // it does not. That leak is the SAME pre-existing divergence as eagerly
    // loading topic files at all (`memory.md:392` — "Topic files like
    // `debugging.md` or `patterns.md` are not loaded at startup. Claude reads them
    // on demand using its standard file tools when it needs the information."),
    // which is its own finding; the cap neither creates nor widens it.
    //
    // ONE recogniser with the two composition seams (`memory-imports.ts`): a
    // token is read anywhere in a line, an extension is not required, and a
    // token inside a code span or a fenced block is not an import
    // (`memory.md:99`, `:101`). Comments come off first so a `@path` the author
    // commented out does not become a record — `memory.md:161` says the comment
    // never reaches the model, and a record it cannot see is worse than no
    // record at all.
    for (const token of scanMemoryImports(stripBlockHtmlComments(importWalkSource(kind, resolvedPath)))) {
      const target = resolveMemoryImportPath(resolvedPath, token.path);
      // The record's OWNER, not its resolvability — see
      // `instructionImportOwnedElsewhere`.
      if (kind === 'instruction' && instructionImportOwnedElsewhere(target)) continue;
      visit(target, depth + 1, resolvedPath);
    }
  };

  visit(entryPath, 0);
  return records;
}

/**
 * The server-only transport identity of one declared MCP server.
 *
 * Read VERBATIM from the configuration, with no `${VAR}` expansion: the managed
 * matcher expands both sides itself (`managed-mcp.md:176`), so an entry written
 * as `${HOME}/bin/server` must still meet the reference the config wrote.
 *
 * `command` is the full argv — `[command, ...args]` — because `:175` matches
 * "Every argument, in order".
 */
function mcpTransportIdentity(
  config: unknown,
): NativeCapabilitySourceRecord['mcpServerIdentity'] | undefined {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return undefined;
  const value = config as { type?: unknown; transport?: unknown; url?: unknown; command?: unknown; args?: unknown };
  // `.mcp.json` spells it `type`; a Source `config.json` spells it `transport`.
  // `mcp.md:83` names `streamable-http` as an alias for `http`; folded so the
  // inventory record and the managed-MCP identity carry the real transport.
  const declared = normalizeMcpTransportAlias(
    typeof value.transport === 'string' ? value.transport : value.type,
  );
  const transport = declared === 'stdio' || declared === 'http' || declared === 'sse'
    ? declared
    : undefined;
  const url = typeof value.url === 'string' && value.url.length > 0 ? value.url : undefined;
  const command = typeof value.command === 'string' && value.command.length > 0
    ? [
        value.command,
        ...(Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : []),
      ]
    : undefined;
  if (transport === undefined && url === undefined && command === undefined) return undefined;
  return {
    ...(transport ? { transport } : {}),
    ...(url ? { url } : {}),
    ...(command ? { command } : {}),
  };
}

/**
 * One qualified inventory record per declared MCP server (never one per file).
 *
 * Exported for read-only reuse by the Claude-setup importer
 * (`claude-setup-import.ts`), which points it at a user's `~/.claude.json` /
 * `~/.claude/.mcp.json` so the import reads MCP servers through THE native MCP
 * reader rather than a second parser. Callers outside the inventory pass a
 * throwaway scope; only `logicalName` and `mcpServerIdentity` are consumed.
 */
export function mcpServerRecords(
  path: string,
  scope: CapabilityScopeRef,
  discriminator = '',
  containRealRoot?: string,
  skips?: McpConfigSkip[],
): NativeCapabilitySourceRecord[] {
  if (!existsSync(path)) return [];
  // Not a validation failure: a containment refusal is a path decision made
  // before the file is read, and reporting it would name a path we deliberately
  // refused to follow.
  if (containRealRoot && !insideRealRoot(path, containRealRoot)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    // `headless.md:215` — "Claude Code validates each `--mcp-config` entry at
    // startup and skips entries that fail validation … The run continues and
    // exits cleanly, so check these fields to catch a server that never
    // loaded." A whole unparsable file skips every server it declares, so the
    // name is the file's own, which is the only identity that survives.
    skips?.push({
      name: basename(path),
      type: 'invalid_config',
      message: `MCP config ${basename(path)} is not valid JSON; every server it declares was skipped.`,
    });
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    skips?.push({
      name: basename(path),
      type: 'invalid_config',
      message: `MCP config ${basename(path)} is not a JSON object; every server it declares was skipped.`,
    });
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    // An `mcpServers` key that is present and wrong is a validation failure; a
    // file with no `mcpServers` key at all simply declares nothing.
    if (servers !== undefined) {
      skips?.push({
        name: basename(path),
        type: 'invalid_config',
        message: `MCP config ${basename(path)} has an "mcpServers" entry that is not an object; every server it declares was skipped.`,
      });
    }
    return [];
  }
  const revision = revisionOf(path);
  const contentHash = contentHashOfFile(path);
  const declarations = servers as Record<string, unknown>;
  return Object.keys(declarations)
    .filter(Boolean)
    .sort()
    .map(logicalName => ({
      key: qualifiedKey('mcp', scope, logicalName, discriminator),
      kind: 'mcp' as const,
      scope,
      logicalName,
      ...(() => {
        const identity = mcpTransportIdentity(declarations[logicalName]);
        return identity ? { mcpServerIdentity: identity } : {};
      })(),
      sourcePath: path,
      revision,
      contentHash,
      mutable: true,
    }));
}

/** Workspace Sources: one record per `sources/<slug>/config.json`. */
/**
 * Project a persisted source `connectorOrigin` to its presentation-only safe
 * shape (K4). Returns undefined for a non-connector source or malformed data —
 * cosmetic metadata only, never an authorization input.
 */
function safeSourceConnectorOrigin(raw: unknown): SafeSourceConnectorOrigin | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const pluginKey = typeof value.pluginKey === 'string' ? value.pluginKey : undefined;
  const connectorId = typeof value.connectorId === 'string' ? value.connectorId : undefined;
  const serverName = typeof value.serverName === 'string' ? value.serverName : undefined;
  if (!pluginKey || !connectorId || !serverName) return undefined;
  const authTiming = value.authTiming === 'ON_INSTALL' || value.authTiming === 'ON_FIRST_USE'
    ? value.authTiming
    : undefined;
  return { pluginKey, connectorId, serverName, ...(authTiming ? { authTiming } : {}) };
}

function workspaceSourceRecords(
  workspaceRootPath: string,
  scope: CapabilityScopeRef,
  skips?: McpConfigSkip[],
): NativeCapabilitySourceRecord[] {
  const sourcesDir = join(workspaceRootPath, 'sources');
  if (!existsSync(sourcesDir)) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(sourcesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: NativeCapabilitySourceRecord[] = [];
  for (const entry of entries) {
    const sourceDir = join(sourcesDir, entry.name);
    const configFile = join(sourceDir, 'config.json');
    if (!existsSync(configFile)) continue;
    let safeConfig: {
      type?: unknown;
      name?: unknown;
      enabled?: unknown;
      provider?: unknown;
      tagline?: unknown;
      mcp?: unknown;
      api?: unknown;
      connectorOrigin?: unknown;
      connectionStatus?: unknown;
      connectionError?: unknown;
    } = {};
    let parseFailed = false;
    try {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        safeConfig = parsed as typeof safeConfig;
      } else {
        parseFailed = true;
      }
    } catch {
      // Inventory still retains an invalid Source for safe diagnostics/resolution.
      parseFailed = true;
    }
    const sourceType = safeConfig.type === 'api' || safeConfig.type === 'mcp' || safeConfig.type === 'local'
      ? safeConfig.type
      : undefined;
    // The two config-validation refusals the headless init frame reports
    // (`headless.md:220`). The record above is still retained — the Sources list
    // must keep showing a broken Source so it can be repaired — but a retained
    // record with no usable `type` never becomes a running server, and until now
    // that skip existed nowhere a CI job could read it.
    if (parseFailed) {
      skips?.push({
        name: entry.name,
        type: 'invalid_config',
        message: `Source "${entry.name}" has a config.json that is not a JSON object; the source was skipped.`,
      });
    } else if (sourceType === undefined) {
      skips?.push({
        name: entry.name,
        type: 'unknown_type',
        message: safeConfig.type === undefined
          ? `Source "${entry.name}" declares no "type"; the source was skipped.`
          : `Source "${entry.name}" declares an unrecognized "type"; the source was skipped.`,
      });
    }
    const displayName = typeof safeConfig.name === 'string' && safeConfig.name.length > 0
      ? safeConfig.name
      : undefined;
    const description = trimmedString(safeConfig.tagline);
    const credentialId = sourceCredentialId(safeConfig, scope, entry.name);
    const guideFile = join(sourceDir, 'guide.md');
    const iconResource = pinnedIconResource(sourceDir);
    const connectorOrigin = safeSourceConnectorOrigin(safeConfig.connectorOrigin);
    const sourcePermissions = pinnedSourcePermissions(join(sourceDir, 'permissions.json'), entry.name);
    // Only for an MCP Source: the managed MCP lists say nothing about `api` or
    // `local` Sources, and pinning a base URL for them would be metadata nobody
    // reads.
    const mcpServerIdentity = sourceType === 'mcp' ? mcpTransportIdentity(safeConfig.mcp) : undefined;
    // UB14.48 — the verdict `source_test` (and the credential/refresh writers) stored, in the app's
    // vocabulary, and its reason reduced for the safe summary. A failed test used to reach no renderer
    // surface at all: every one of them renders `SafeCapabilitySummary`, which carried no verdict.
    const sourceLastTestStatus = typeof safeConfig.connectionStatus === 'string' && safeConfig.connectionStatus !== ''
      ? normalizeStoredStatus(safeConfig.connectionStatus)
      : undefined;
    const sourceConnectionError = sanitizeStoredConnectionError(safeConfig.connectionError);
    records.push({
      key: qualifiedKey('source', scope, entry.name),
      kind: 'source',
      scope,
      logicalName: entry.name,
      ...(sourceType ? { sourceType } : {}),
      ...(mcpServerIdentity ? { mcpServerIdentity } : {}),
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      ...(sourcePermissions ? { sourcePermissions } : {}),
      ...(iconResource ? { iconResource } : {}),
      ...(connectorOrigin ? { connectorOrigin } : {}),
      ...(sourceLastTestStatus ? { sourceLastTestStatus } : {}),
      ...(sourceConnectionError ? { sourceConnectionError } : {}),
      sourceEnabled: safeConfig.enabled !== false,
      ...(credentialId ? { credentialId } : {}),
      ...(existsSync(guideFile)
        ? {
            guideResource: {
              sourcePath: guideFile,
              revision: revisionOf(guideFile),
              contentHash: contentHashOfFile(guideFile),
            },
          }
        : {}),
      sourcePath: sourceDir,
      revision: revisionOf(configFile),
      contentHash: contentHashOfFile(configFile),
      mutable: true,
    });
    const permissions = fileRecord(
      'permission',
      join(sourceDir, 'permissions.json'),
      scope,
      `sources/${entry.name}/permissions.json`,
      'source',
    );
    if (permissions) {
      records.push({ ...permissions, permissionSourceSlug: entry.name });
    }
  }
  return records.sort((a, b) => a.key.localeCompare(b.key));
}

function sourceCredentialId(
  config: {
    type?: unknown;
    provider?: unknown;
    mcp?: unknown;
    api?: unknown;
  },
  scope: CapabilityScopeRef,
  sourceId: string,
): CredentialId | undefined {
  if (!scope.workspaceId) return undefined;
  if (config.type === 'mcp') {
    const mcp = config.mcp && typeof config.mcp === 'object' && !Array.isArray(config.mcp)
      ? config.mcp as { transport?: unknown; authType?: unknown }
      : undefined;
    if (mcp?.transport === 'stdio' || mcp?.authType === undefined || mcp.authType === 'none') {
      return undefined;
    }
    return {
      type: mcp.authType === 'bearer' ? 'source_bearer' : 'source_oauth',
      workspaceId: scope.workspaceId,
      sourceId,
    };
  }
  if (config.type !== 'api') return undefined;
  const api = config.api && typeof config.api === 'object' && !Array.isArray(config.api)
    ? config.api as { authType?: unknown }
    : undefined;
  if (api?.authType === undefined || api.authType === 'none') return undefined;
  const type: CredentialId['type'] = config.provider === 'google' || api.authType === 'oauth'
    ? 'source_oauth'
    : api.authType === 'bearer'
      ? 'source_bearer'
      : api.authType === 'basic'
        ? 'source_basic'
        : 'source_apikey';
  return { type, workspaceId: scope.workspaceId, sourceId };
}

/**
 * Rule memories: one record per markdown file under `rulesDir`, discovered
 * RECURSIVELY with symlinks resolved (R28 / `memory.md`).
 *
 * Discovery is unconditional. Whether a rule reaches the model is decided
 * later, by its frontmatter: an unscoped rule joins the pinned capability
 * context at launch, a `paths:` rule waits for a matching file read. Matching
 * used to happen HERE against the working directory, which is exactly why no
 * documented file glob ever fired.
 */
function ruleMemoryRecords(
  rulesDir: string,
  containmentRoot: string,
  scope: CapabilityScopeRef,
  seen: Set<string>,
  discriminator = 'rules',
): NativeCapabilitySourceRecord[] {
  return discoverRuleFiles(rulesDir)
    .flatMap(file => {
      try {
        // A rule reached through a symlink resolves outside the containment
        // root BY DESIGN — that is the documented shared-rules layout
        // (`ln -s ~/shared-claude-rules .claude/rules/shared`). Contain such a
        // record, and its `@import` walk, to the resolved file's own directory
        // rather than dropping it; in-tree rules keep the caller's root.
        const root = isContained(containmentRoot, file.realPath)
          ? containmentRoot
          : dirname(file.realPath);
        return memoryFileRecords(file.path, root, scope, file.relativePath, discriminator, seen, 'rule');
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Whether `candidate` resolves at or under `root` (both already absolute). */
function isContained(root: string, candidate: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rel = relative(realRoot, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * How many instruction files the ancestor walk may contribute, on top of the
 * working directory's own (which is never dropped).
 *
 * Every level between the working directory and the project root can hold one
 * file per `PROJECT_INSTRUCTION_FILES` entry, and each one is read in full into
 * the pinned capability block, which is UNCAPPED on the live path — a single
 * layer is routinely 10-15 KB. So the walk is bounded by what it costs the
 * context rather than by tree depth. Counted root-first: a tree deep enough to
 * hit the cap loses the levels nearest the working directory, never the
 * repo-wide contract at the root, which is the whole reason to walk.
 */
const MAX_INSTRUCTION_ANCESTOR_LAYERS = 8;

/** Claude's rules directory, imported beside our own (`.agents/`, `.nessy-agent/`). */
const CLAUDE_PROJECT_DIR = '.claude';
const CLAUDE_RULES_DIR = join(CLAUDE_PROJECT_DIR, 'rules');

/**
 * The WORKING DIRECTORY's instruction candidates — relative PATHS, not bare
 * names, which is the whole point of the constant.
 *
 * `memory.md:60` gives **Project instructions** as "`./CLAUDE.md` or
 * `./.claude/CLAUDE.md`" and `:69` repeats it: "A project CLAUDE.md can be
 * stored in either `./CLAUDE.md` or `./.claude/CLAUDE.md`." Every other
 * consumer of {@link PROJECT_INSTRUCTION_FILES} joins a bare name onto a
 * directory, and the alternative location is bound to THIS tier only: `:153`
 * spells the ancestor walk with the bare names ("checking each directory along
 * the way for `CLAUDE.md` and `CLAUDE.local.md` files") and `:157` spells the
 * subdirectory walk the same way. So the ancestor, workspace-root and nested
 * walks deliberately stay on the bare-name constant.
 *
 * Both are loaded when both exist — `:155`, "All discovered files are
 * concatenated into context rather than overriding each other". The pages say
 * "either/or" and never state a preference, so this is the fail-open reading.
 *
 * ## Why `logicalName` is a field rather than `basename(relativePath)`
 *
 * `qualifiedKey` ends in the logical name and carries no path. Keying the
 * `.claude` file as `CLAUDE.md` — the obvious implementation, since that IS its
 * file name — produces a key BYTE-IDENTICAL to `<cwd>/CLAUDE.md`'s. Nothing
 * fails: the inventory is an array, so both records survive discovery and then
 * every key-addressed consumer downstream (the session-disable set, the policy
 * store, `collapseToUnqualifiedNames`) treats them as one capability and one of
 * the two silently shadows the other. Hence a distinct logical name, spelt
 * POSIX-style so the key is identical on Windows, where `join` would yield
 * `.claude\CLAUDE.md`.
 *
 * Order is load order and it is not incidental: `.claude/CLAUDE.md` sits after
 * `CLAUDE.md` and before `CLAUDE.local.md`, because `:155` says "Within each
 * directory, `CLAUDE.local.md` is appended after `CLAUDE.md`, so your personal
 * notes are the last thing Claude reads at that level." All four share
 * `scopeSpecificity('project')`, and `promptLayers.sort` is stable, so this
 * insertion order is what the model sees.
 *
 * `AGENTS.override.md` leads the list because the runtime that owns the
 * filename puts it first (`candidate_filenames`, codex `rust-v0.148.0`), and
 * {@link workingDirectoryInstructionFilesIn} — not this constant — is what the
 * cwd tier iterates, so its supersession of `AGENTS.md` is applied here too.
 */
export const WORKING_DIRECTORY_INSTRUCTION_FILES: ReadonlyArray<{
  readonly relativePath: string;
  readonly logicalName: string;
}> = [
  {
    relativePath: AGENTS_OVERRIDE_INSTRUCTION_FILE,
    logicalName: AGENTS_OVERRIDE_INSTRUCTION_FILE,
  },
  { relativePath: AGENTS_MD_INSTRUCTION_FILE, logicalName: AGENTS_MD_INSTRUCTION_FILE },
  { relativePath: 'CLAUDE.md', logicalName: 'CLAUDE.md' },
  {
    relativePath: join(CLAUDE_PROJECT_DIR, 'CLAUDE.md'),
    logicalName: `${CLAUDE_PROJECT_DIR}/CLAUDE.md`,
  },
  { relativePath: 'CLAUDE.local.md', logicalName: 'CLAUDE.local.md' },
];

/**
 * {@link WORKING_DIRECTORY_INSTRUCTION_FILES} with {@link agentsMdSupersededIn}
 * applied to the working directory — the path-bearing twin of
 * {@link projectInstructionFilesIn}.
 */
export function workingDirectoryInstructionFilesIn(
  directory: string,
): ReadonlyArray<{ readonly relativePath: string; readonly logicalName: string }> {
  return agentsMdSupersededIn(directory)
    ? WORKING_DIRECTORY_INSTRUCTION_FILES.filter(
      entry => entry.relativePath !== AGENTS_MD_INSTRUCTION_FILE,
    )
    : WORKING_DIRECTORY_INSTRUCTION_FILES;
}

/** Ancestors of `from` up to and including `root` (nearest-first). */
function ancestorsUpTo(from: string, root?: string): string[] {
  const chain: string[] = [];
  let current = from;
  const stop = root ?? from;
  while (true) {
    chain.push(current);
    if (current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Nested instruction files (BELOW the working directory)
// ---------------------------------------------------------------------------

/**
 * How many distinct nested instruction files one capability generation may
 * accumulate.
 *
 * `memory.md:157`: subdirectory instruction files are "included when Claude
 * reads files in those subdirectories" — so unlike the ancestor walk, this set
 * grows with what the session touches rather than with tree depth. In a
 * monorepo every package can hold one file per `PROJECT_INSTRUCTION_FILES`
 * entry, and a session that sweeps twenty packages would otherwise turn each
 * read into permanent context growth. The bound is the same 8 the ancestor walk
 * uses, for the same reason: these bodies are read in full and a single
 * `AGENTS.md` is routinely 10-15 KB. A new capability generation — any edit to
 * an instruction, rule or skill file — starts a fresh budget, and so does a
 * compaction (`memory.md:447`: nested files "reload the next time Claude reads
 * a file in that subdirectory").
 */
export const MAX_NESTED_INSTRUCTION_FILES = 8;

/**
 * Per-file truncation for a nested body, matching the legacy project-context
 * route's `MAX_CONTEXT_FILE_SIZE`. The pinned block is uncapped because its
 * membership is bounded by the ancestor walk; a nested file's membership is
 * bounded by what the model happens to read, so its SIZE is bounded instead.
 */
export const MAX_NESTED_INSTRUCTION_FILE_BYTES = 10 * 1024;

/** One instruction file a read under its directory just brought into scope. */
export interface NestedInstructionFile {
  /** Absolute path of the instruction file. */
  absolutePath: string;
  /** `AGENTS.override.md` | `AGENTS.md` | `CLAUDE.md` | `CLAUDE.local.md`. */
  fileName: string;
  /** File body, trimmed and truncated to {@link MAX_NESTED_INSTRUCTION_FILE_BYTES}. */
  content: string;
}

export interface NestedInstructionDiscoveryOptions {
  /** Absolute paths already loaded eagerly; never delivered a second time. */
  alreadyLoaded?: ReadonlySet<string>;
  /** `claudeMdExcludes` predicate over absolute paths. */
  isExcluded?: (absolutePath: string) => boolean;
  /** Remaining budget for this generation; defaults to the full cap. */
  limit?: number;
}

/**
 * Every instruction file strictly BETWEEN `triggerFilePath` and
 * `workingDirectory`, outermost first.
 *
 * `memory.md:157` whole: "Claude also discovers `CLAUDE.md` and
 * `CLAUDE.local.md` files in subdirectories under your current working
 * directory. Instead of loading them at launch, they are included when Claude
 * reads files in those subdirectories." The predicate is DIRECTORY CONTAINMENT,
 * not a glob: reading `packages/foo/src/x.ts` brings in
 * `packages/foo/src/AGENTS.md` and `packages/foo/AGENTS.md` alike.
 *
 * The working directory's own files and everything above it are excluded here
 * because they are already loaded eagerly (`buildNativeCapabilityInventory`'s
 * ancestor walk) — `memory.md:63`: files "in the directory hierarchy above the
 * working directory are loaded in full at launch. Files in subdirectories load
 * on demand."
 *
 * Ordering follows `memory.md:155` — "content is ordered from the filesystem
 * root down to your working directory", so the outermost nested file is
 * delivered first and the one nearest the read file lands last, where it wins
 * for a model reading top-to-bottom.
 *
 * Nothing here resolves `@path` imports, and that is now a DECISION rather than
 * the description of a pass that did not exist. R77 made the eager inventory
 * walk an instruction file's imports, so the sentence this comment used to make
 * ("import materialization belongs to the eager inventory pass") is finally
 * true for `promptLayers` — but a nested file is not part of that pass. It is
 * discovered by a file READ, delivered once, truncated to
 * {@link MAX_NESTED_INSTRUCTION_FILE_BYTES}, and never becomes a capability
 * record; expanding its imports would mean reading arbitrary further files
 * inside a tool call, with no record, no Sources entry the user can disable and
 * no `InstructionsLoaded` event — every property the eager path has. `memory.md`
 * does not say either way. Left unexpanded, and named here so the next reader
 * does not have to re-derive it.
 */
export function discoverNestedInstructionFiles(
  triggerFilePath: string,
  workingDirectory: string,
  options: NestedInstructionDiscoveryOptions = {},
): NestedInstructionFile[] {
  const limit = options.limit ?? MAX_NESTED_INSTRUCTION_FILES;
  if (limit <= 0) return [];

  const root = resolve(workingDirectory);
  const target = resolve(triggerFilePath);
  if (!isBelow(root, target)) return [];

  // Nearest-first chain of directories strictly below the working directory.
  const chain: string[] = [];
  let current = dirname(target);
  while (isBelow(root, current)) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const alreadyLoaded = options.alreadyLoaded;
  const isExcluded = options.isExcluded;
  const found: NestedInstructionFile[] = [];
  // Reversed: outermost directory first (memory.md:155's root-down ordering).
  for (const dir of chain.reverse()) {
    for (const fileName of projectInstructionFilesIn(dir)) {
      if (found.length >= limit) return found;
      const absolutePath = join(dir, fileName);
      if (alreadyLoaded?.has(absolutePath)) continue;
      if (isExcluded?.(absolutePath)) continue;
      const content = readNestedInstructionBody(absolutePath);
      if (content === undefined) continue;
      found.push({ absolutePath, fileName, content });
    }
  }
  return found;
}

/** Strictly below `root` — the root itself is not "a subdirectory under" it. */
function isBelow(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Read one nested instruction body, or `undefined` when there is nothing to add. */
function readNestedInstructionBody(absolutePath: string): string | undefined {
  let raw: string;
  try {
    if (!statSync(absolutePath).isFile()) return undefined;
    raw = readFileSync(absolutePath, 'utf-8');
  } catch {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= MAX_NESTED_INSTRUCTION_FILE_BYTES
    ? trimmed
    : `${trimmed.slice(0, MAX_NESTED_INSTRUCTION_FILE_BYTES)}\n\n... (truncated)`;
}

// ---------------------------------------------------------------------------
// Nested skill roots (BELOW the working directory)
// ---------------------------------------------------------------------------

/**
 * How many distinct nested skill DIRECTORIES one working directory may
 * accumulate over a session.
 *
 * `skills.md:154` whole: "Skills in nested `.claude/skills/` directories below
 * your starting directory aren't loaded at startup. They load the first time
 * Claude reads or edits a file inside that subdirectory, and stay available for
 * the rest of the session." Because the set never shrinks, the cost of every
 * root admitted here is paid on EVERY capability turn — the inventory is rebuilt
 * per turn (`storage-runtime.ts:buildCapabilityResolutionInputsV2`) and each root
 * costs two `readdirSync` calls plus one `SKILL.md` read per skill. Eight roots
 * is the same ceiling {@link MAX_NESTED_INSTRUCTION_FILES} uses, for the same
 * reason, and bounds the steady-state cost at 16 directory listings per turn.
 */
export const MAX_NESTED_SKILL_ROOTS = 8;

/**
 * How many directory levels between the touched file and the working directory
 * one activation may examine.
 *
 * This is NOT a tree walk: the scan only visits the chain of directories from
 * the trigger file up to the working directory, so its cost is O(depth), not
 * O(files). The cap exists so a pathological path (a generated tree, a symlink
 * farm) cannot turn one tool call into an unbounded run of `existsSync` probes.
 */
export const MAX_NESTED_SKILL_SCAN_DEPTH = 32;

/**
 * How many (workspace, project, working directory) buckets the process-local
 * registry keeps before evicting the oldest.
 *
 * The registry outlives a single turn by construction (see
 * {@link registerNestedSkillRoots}); this is what stops it outliving the process
 * budget too. Eviction is FIFO on insertion order, and losing a bucket costs
 * only a re-discovery on the next read under that subtree.
 */
export const MAX_NESTED_SKILL_ROOT_KEYS = 32;

/**
 * Directory names a nested scan refuses to look inside.
 *
 * A read under `node_modules/` or `dist/` is a read of somebody else's tree, and
 * `.agents/skills` inside one is not "a monorepo package providing its own
 * skills" (`skills.md:124`) — it is vendored content the user never authored. A
 * chain directory is skipped when ANY of its path segments below the working
 * directory is named here, so the exclusion covers everything under it too.
 */
const NESTED_SKILL_SCAN_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'target', 'coverage', 'vendor',
  '.next', '.nuxt', '.turbo', '.cache', '.venv', 'venv', '__pycache__',
]);

/** One directory below the working directory that owns its own skills. */
export interface NestedSkillRoot {
  /** Absolute path of the owning directory (NOT of the skills directory). */
  directory: string;
  /**
   * Working-directory-relative path of that directory, POSIX-separated —
   * `apps/web`. This is the `<dir>` half of `skills.md:128`'s directory-qualified
   * name `apps/web:deploy`, and the discriminator that keeps a nested record's
   * capability key distinct.
   *
   * Relative to the WORKING DIRECTORY, not to the project root. `skills.md` does
   * not say which (its only example, `apps/web:deploy`, has the two coincide),
   * and the working directory is what the page's own trigger sentence is written
   * against — ":154" says "below your starting directory" and ":124" says "below
   * your working directory".
   */
  qualifier: string;
}

export interface NestedSkillRootDiscoveryOptions {
  /** Qualifiers already registered; never returned a second time. */
  alreadyKnown?: ReadonlySet<string>;
  /** Remaining budget for this working directory; defaults to the full cap. */
  limit?: number;
}

/**
 * Every directory strictly BETWEEN `triggerFilePath` and `workingDirectory` that
 * owns a skills directory, outermost first.
 *
 * `skills.md:124` whole: "Skills also load from nested `.claude/skills/`
 * directories below your working directory. When Claude reads or edits a file in
 * a subdirectory, skills from that subdirectory's `.claude/skills/` become
 * available. This lets a monorepo package provide its own skills that apply when
 * working on that package, even if the session started at the repo root."
 *
 * The predicate is DIRECTORY CONTAINMENT, the same one
 * {@link discoverNestedInstructionFiles} uses — reading `apps/web/src/x.ts`
 * offers both `apps/web/src` and `apps/web` — and the walk is deliberately
 * modelled on that function rather than reimplemented, so the two lazy channels
 * cannot drift about what "below the working directory" means.
 *
 * THE DIRECTORY NAMES ARE THIS FORK'S, NOT THE PAGE'S. Nessy has never read
 * `.claude/skills` at any level; its own layers are `<dir>/.agents/skills` (the
 * portable compatibility tier) and `<dir>/.nessy-agent/skills` (the native one),
 * and both are offered here for the same reason both are read at the working
 * directory. Teaching the whole inventory to read `.claude/skills` is a separate,
 * rebrand-adjacent gap.
 *
 * A directory is returned ONLY when it actually holds one of those two
 * directories, so the registry never accumulates a root with nothing in it, and
 * the per-turn cost is paid only for roots that produce records.
 */
export function discoverNestedSkillRoots(
  triggerFilePath: string,
  workingDirectory: string,
  options: NestedSkillRootDiscoveryOptions = {},
): NestedSkillRoot[] {
  const limit = options.limit ?? MAX_NESTED_SKILL_ROOTS;
  if (limit <= 0) return [];

  const root = resolve(workingDirectory);
  const target = resolve(triggerFilePath);
  if (!isBelow(root, target)) return [];

  // Nearest-first chain of directories strictly below the working directory,
  // bounded by depth so one tool call can never fan out unboundedly.
  const chain: string[] = [];
  let current = dirname(target);
  while (isBelow(root, current) && chain.length < MAX_NESTED_SKILL_SCAN_DEPTH) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const alreadyKnown = options.alreadyKnown;
  const found: NestedSkillRoot[] = [];
  // Reversed: outermost directory first, so a truncated budget keeps the roots
  // nearest the repository layout the user is likeliest to have authored.
  for (const directory of chain.reverse()) {
    if (found.length >= limit) break;
    const qualifier = nestedSkillQualifier(root, directory);
    if (qualifier === undefined) continue;
    if (alreadyKnown?.has(qualifier)) continue;
    if (!nestedSkillDirectories(directory).some(dir => existsSync(dir))) continue;
    found.push({ directory, qualifier });
  }
  return found;
}

/**
 * The two skills directories a nested root may own, in the order their records
 * are emitted. One reader, so the scan's existence check and the inventory's
 * record emission can never disagree about which layers a root has.
 */
function nestedSkillDirectories(directory: string): [string, string] {
  return [
    join(directory, PROJECT_AGENT_SKILLS_DIR),
    join(directory, NESSY_AGENT_PROJECT_DIR, 'skills'),
  ];
}

/**
 * `apps/web` for a directory below `root`, or `undefined` when it cannot carry a
 * qualified name.
 *
 * Two rejections, both structural. A segment named in
 * {@link NESTED_SKILL_SCAN_SKIP_DIRS} disqualifies the directory and everything
 * under it. A segment containing `:` disqualifies it because `:` is the separator
 * in `skills.md:128`'s `apps/web:deploy` AND in the capability key built by
 * {@link qualifiedKey} — a directory named `a:b` would make both ambiguous, and
 * an ambiguous name is worse than an undiscovered skill.
 */
function nestedSkillQualifier(root: string, directory: string): string | undefined {
  const segments = relative(root, directory).split(sep);
  if (segments.length === 0 || segments.some(segment => segment === '')) return undefined;
  for (const segment of segments) {
    if (NESTED_SKILL_SCAN_SKIP_DIRS.has(segment)) return undefined;
    if (segment.includes(':')) return undefined;
  }
  return segments.join('/');
}

/**
 * Process-local accumulator for the nested roots a session has activated.
 *
 * WHY A REGISTRY AND NOT A PARAMETER. The activation happens in the agent
 * (`BaseAgent.activateNestedSkillRoots`, on the one lazy file-touch channel R28
 * built) and the scan happens here, and the only thing between them —
 * `WorkspacePolicyContext` — is assembled by the server bootstrap from a
 * `CapabilityContext` that carries no place to put them. Passing them as an
 * argument would mean a new field on that context plus a new thread through the
 * session layer; this keeps both halves inside the layer that owns discovery.
 *
 * KEYED BY (workspace, project, working directory), NOT BY SESSION, and that is
 * a deliberate deviation from `skills.md:154`'s "for the rest of the session".
 * `WorkspacePolicyContext` carries no session id at all, so a session key cannot
 * be recomputed on this side. The consequence is bounded and one-directional: a
 * second session on the SAME trusted project and the SAME working directory sees
 * a root its sibling activated without having touched that subtree itself. What
 * it sees is repository content it would have discovered on its own next read
 * there, still trust-gated and still containment-checked, so the deviation
 * widens WHEN a skill appears, never WHETHER it may.
 *
 * A working-directory change needs no explicit clear: the key changes with it.
 */
const nestedSkillRootRegistry = new Map<string, Set<string>>();

/**
 * The registry bucket for one working directory. Both halves must spell it the
 * same, and the end-to-end test in
 * `agent/__tests__/nested-skill-traversal.test.ts` is what proves they do — a
 * drift here makes the whole feature silently inert.
 *
 * Joined on a NUL written as a backslash-u escape, never as the byte itself: a
 * working directory may contain any printable character, so a printable
 * separator would let two different triples spell one key — while a literal NUL
 * in a source file makes plain `grep`/`rg` skip the whole file without saying so.
 */
export function nestedSkillRootRegistryKey(input: {
  workspaceId: string;
  projectKey?: string;
  workingDirectory: string;
}): string {
  return [input.workspaceId, input.projectKey ?? '-', resolve(input.workingDirectory)].join('\u0000');
}

/**
 * Add qualifiers to a bucket; returns the ones that were actually new.
 *
 * An empty return is the caller's signal that nothing changed, so it can skip
 * the capability invalidation rather than making every read in an
 * already-activated subtree re-resolve the snapshot.
 */
export function registerNestedSkillRoots(key: string, qualifiers: readonly string[]): string[] {
  let bucket = nestedSkillRootRegistry.get(key);
  if (!bucket) {
    // FIFO: `Map` preserves insertion order, so the first key is the oldest.
    while (nestedSkillRootRegistry.size >= MAX_NESTED_SKILL_ROOT_KEYS) {
      const oldest = nestedSkillRootRegistry.keys().next();
      if (oldest.done) break;
      nestedSkillRootRegistry.delete(oldest.value);
    }
    bucket = new Set<string>();
    nestedSkillRootRegistry.set(key, bucket);
  }
  const added: string[] = [];
  for (const qualifier of qualifiers) {
    if (bucket.size >= MAX_NESTED_SKILL_ROOTS) break;
    if (bucket.has(qualifier)) continue;
    bucket.add(qualifier);
    added.push(qualifier);
  }
  return added;
}

/** The activated qualifiers for one bucket, in a stable order. */
export function nestedSkillRootsFor(key: string): string[] {
  return [...(nestedSkillRootRegistry.get(key) ?? [])].sort();
}

/** Drop one bucket, or every bucket. Test seam and working-directory reset. */
export function clearNestedSkillRoots(key?: string): void {
  if (key === undefined) nestedSkillRootRegistry.clear();
  else nestedSkillRootRegistry.delete(key);
}

export function buildNativeCapabilityInventory(
  context: WorkspacePolicyContext,
  env: NativeSourcesEnv,
): NativeCapabilityInventory {
  const oversizeSkips: DroppedInstructionLayer[] = [];
  currentOversizeSkips = oversizeSkips;
  try {
    return buildNativeCapabilityInventoryPass(context, env, oversizeSkips);
  } finally {
    // Cleared on EVERY exit, including a throw: a leaked collector would
    // attribute this pass's skips to the next snapshot.
    currentOversizeSkips = null;
  }
}

function buildNativeCapabilityInventoryPass(
  context: WorkspacePolicyContext,
  env: NativeSourcesEnv,
  oversizeSkips: readonly DroppedInstructionLayer[],
): NativeCapabilityInventory {
  const configDir = env.configDir ?? CONFIG_DIR;
  const homeAgentsSkills = env.homeAgentsSkillsDir ?? GLOBAL_AGENT_SKILLS_DIR;
  // `claudeMdExcludes`: "Patterns are matched against absolute file paths using
  // glob syntax", and the documented example points at a rules directory, so the
  // one matcher covers instruction files and rule files alike.
  //
  // All four documented scopes, unioned — `large-codebases.md:155`, "You can set
  // `claudeMdExcludes` at any settings scope: user, project, local, or managed.
  // Arrays merge across scopes". The project/local legs are the ones the page's
  // own worked example uses, and they were unread until R31.
  const isExcluded = createInstructionExcludeMatcher(
    env.instructionExcludes ?? resolveInstructionExcludes({
      managed: env.managedInstructionExcludes,
      workingDirectory: context.workingDirectory ?? context.projectRoot,
      projectTrustState: context.projectTrustState,
      settingSources: context.settingSources,
    }),
  );
  // "Project rules are skipped if you exclude `project` from --setting-sources."
  const projectSourceEnabled = context.settingSources === undefined
    || context.settingSources.includes('project');
  const records: NativeCapabilitySourceRecord[] = [];
  const blockedLayers: BlockedCapabilityLayer[] = [];
  const mcpConfigSkips: McpConfigSkip[] = [];
  const droppedInstructionLayers: DroppedInstructionLayer[] = [];
  const refusedProjectImports: OutsideProjectImport[] = [];
  const seenMemoryFiles = new Set<string>();

  const globalScope: CapabilityScopeRef = { kind: 'global' };
  const workspaceScope: CapabilityScopeRef = { kind: 'workspace', workspaceId: context.workspaceId };
  const managedScope: CapabilityScopeRef = { kind: 'builtin' };

  // ── Managed (organization-wide system directory) ─────────────────────────
  // `memory.md:58`'s **Managed policy** row and `third-party-integrations.md:329`:
  // an org deploys `CLAUDE.md` to a system directory "for company-wide
  // standards". `memory.md:54` puts it first in load order — the table "lists
  // them in load order, from broadest scope to most specific, so a project
  // instruction appears in context after a user instruction" — which is exactly
  // what `scopeSpecificity('builtin') === 0`
  // delivers for `promptLayers`, so the tier only has to be PUSHED first for the
  // record array to agree with the sorted view.
  //
  // `builtin` rather than a fifth scope kind: `SafeCapabilityScopeKind` already
  // carries it, `instructionMemoryType('builtin')` already returns the
  // documented `'Managed'` memory_type, and the policy/trust stores already
  // normalize it — a new kind would cross the wire boundary to buy a label.
  // The `'managed'` discriminator is what keeps the key unambiguous at a scope
  // the built-in dp MCP set also occupies.
  //
  // ONE file, not `PROJECT_INSTRUCTION_FILES`: `memory.md:279`-`:281` and
  // `third-party-integrations.md:329` both name `CLAUDE.md` and nothing else,
  // and `CLAUDE.local.md` is documented as the personal, per-project tier
  // ("Personal project-specific preferences; add to `.gitignore`", `:61`) —
  // deploying it machine-wide and un-excludable would contradict its own row.
  const systemDir = env.systemDir ?? managedSystemDirForPlatform();
  if (systemDir) {
    const managedInstructionPath = join(systemDir, MANAGED_INSTRUCTION_FILE);
    // Un-excludable content needs a guard the excludable tiers do not; see
    // `managedFileTrustVerdict`. P3.331: the third verdict is neither "trusted"
    // nor "this file failed the checks" — it is "this platform has no check
    // implemented", which on win32 used to be spelled as trust. It is now a
    // withholding, and a withholding an operator cannot see is the same defect
    // one layer along, so it says so once per process.
    const managedTrust = managedFileTrustVerdict(managedInstructionPath);
    if (managedTrust === 'unverifiable-platform') noticeUnverifiableManagedTier('instruction', managedInstructionPath);
    if (managedTrust === 'trusted') {
      const managedInstructions = fileRecord(
        'instruction',
        managedInstructionPath,
        managedScope,
        MANAGED_INSTRUCTION_FILE,
        'managed',
      );
      if (managedInstructions) records.push({ ...managedInstructions, mutable: false });
    }

    // ── The administrator's SUBAGENTS (P6.239, denominator B20) ─────────────
    //
    // `sub-agents.md` § *Choose the subagent scope* ranks "Managed settings"
    // **1 (highest)** in its own table and spells the tier out verbatim:
    // "**Managed subagents** are deployed by organization administrators. Place
    // markdown files in `.claude/agents/` inside the managed settings
    // directory, using the same frontmatter format as project and user
    // subagents. Managed definitions take precedence over project and user
    // subagents with the same name." `markdownAgentRecords` was called at
    // global, workspace and project and NEVER here, so an administrator could
    // ship no subagent at all — the whole tier was absent, not mis-ranked.
    //
    // ## The root, and the one deviation from the page — B21's, restated
    //
    // `<systemDir>/agents`, without the page's `.claude/` segment: this fork
    // drops that segment at every tier, because here the config directory IS
    // the `.claude` equivalent. The managed instruction file above is
    // `<systemDir>/CLAUDE.md` and the managed output-style root this row landed
    // first is `<systemDir>/output-styles`, so this is their sibling. Stated
    // rather than chosen quietly, per AGENTS.md's rule for where the
    // documentation runs out.
    //
    // ## Why NOT `getAdminAgentSkillsDirs()`, which is the neighbouring tier
    //
    // Those roots are FOREIGN — codex's `/etc/codex/skills` and Claude's
    // managed `skills/` — and this file reads them because BOTH binaries read
    // them natively whatever home we hand them, so reading them here flattens a
    // divergence that already exists (P6.8). Subagents have no such tier: the
    // host materializes agent definitions for all three runtimes from ONE
    // source, handed to the SDK's own `agents` option by
    // `claude-runtime-agents.ts`, so there is nothing per-runtime to mirror and
    // an `/etc/codex/agents` would be a path codex has never defined. That is
    // the native-first answer for this row — step (2), the host supplies it
    // once, uniformly — and it is why this tier needs no second root list and
    // no second off switch: `env.systemDir` is already the one lever.
    //
    // ## The trust verdict, and why PER FILE
    //
    // The same reason the instruction file above carries one: un-excludable
    // prose entering a subagent's system prompt from a machine-wide root, so a
    // root any local account can rewrite is not the administrator's voice. Per
    // FILE and never on the directory — `managedFileTrustVerdict` demands
    // `isFile()`, so handing it the directory returns `untrusted` and would
    // disable the tier on every machine while reading like a check that passes.
    for (const record of markdownAgentRecords(join(systemDir, 'agents'), managedScope)) {
      const agentTrust = managedFileTrustVerdict(record.sourcePath);
      if (agentTrust === 'unverifiable-platform') noticeUnverifiableManagedTier('subagent', record.sourcePath);
      if (agentTrust !== 'trusted') continue;
      // Nothing in this tier is editable from inside the app; the tier is
      // defined by the user not being able to write it.
      records.push({ ...record, mutable: false });
    }
  }

  // ── Administrator-owned skills (the machine-wide managed tier) ────────────
  //
  // P2.449. P6.8 taught the AGENT-SIDE loader (`skills/storage.ts:loadAllSkills`)
  // to read the machine-wide, administrator-provisioned skill roots on all three
  // runtimes. This inventory — the one the renderer's list is built from — did
  // not, so an administrator skill loaded, ran, and OUTRANKED the user's own
  // same-slug skill while appearing nowhere the user could see it.
  //
  // ## The posture, decided here rather than left implicit
  //
  // Adding these roots makes an administrator skill selectable, mentionable and
  // revealable — a skill the user cannot delete becomes one they can invoke —
  // and that is the question P2.449 exists to answer. It is answered YES, on
  // three measured grounds:
  //
  // 1. **The exposure already happened, at P6.8.** The model can already invoke
  //    these skills on every runtime today. Leaving them out of the catalog does
  //    not withhold a capability; it withholds the EXPLANATION. The user meets a
  //    skill they did not install, cannot remove, and cannot find — which is the
  //    silent-divergence class this fork keeps re-shipping, not a safety margin.
  // 2. **Selectability is the ADMINISTRATOR's to decide, and the control already
  //    exists on both paths.** `user-invocable: false` and
  //    `disable-model-invocation: true` are read out of the same SKILL.md by the
  //    same parser (`readSkillInvocationControls`, shared with
  //    `skills/storage.ts`) and are carried through to the safe view as
  //    `skillUserInvocable` / `skillDisableModelInvocation`. So this does not
  //    hand the user an unconditional invoke; it hands them exactly what the
  //    administrator's own frontmatter allows.
  // 3. **Revealing is not granting.** `mutable: false` below, and the renderer's
  //    Delete is gated on `scope.kind === 'workspace'` — so the row is visible
  //    and still un-deletable, which is the state P2.439's *Managed by your
  //    administrator* sentence exists to name.
  //
  // The operator who disagrees has an off switch that turns the tier off for
  // BOTH loaders at once: `NESSY_ADMIN_SKILLS_DIR=''`. One lever, not two.
  //
  // ## Vocabulary — the trap P6.8 measured, restated so it is not re-introduced
  //
  // This tier is NOT "system". codex's `SkillScope::System` is the cache codex
  // preinstalls into the user's OWN home; the machine-wide administrator-owned
  // one is `SkillScope::Admin` (`openai/codex` `rust-v0.148.0`,
  // `ext/skills/src/host_roots.rs:114`). Naming this tier *system* anywhere the
  // user can read it says, to a codex user, the opposite of what it means.
  //
  // ## Why `builtin` scope
  //
  // The same reason the managed instruction file above uses it, and the
  // representation `skill-tier.ts` was written against:
  // `SafeCapabilityScopeKind` already carries `builtin`, the policy and trust
  // stores already normalize it, and a fifth scope kind would cross the wire
  // boundary to buy a label. It is also the ONE scope the
  // `strictPluginOnlyCustomization` filter in `storage-runtime.ts` deliberately
  // does not lock — `settings-reference.md#strictpluginonlycustomization`
  // blocks "skills, agents, hooks, and MCP servers from user and project
  // sources, so they can come only from plugins or managed settings", and this
  // is a managed source.
  //
  // The discriminator is the ROOT'S INDEX, never its path: two roots may hold
  // the same slug, the keys must differ, and a key is projected to the renderer
  // — so no absolute machine path may enter it. Hyphen rather than colon,
  // because `qualifiedKey` joins its parts with `::`.
  const adminSkillsDirs = env.adminSkillsDirs;
  adminSkillsDirs.forEach((adminSkillsDir, index) => {
    for (const record of skillRecords(adminSkillsDir, managedScope, `admin-${index}`)) {
      // Nothing in this tier is editable from inside the app; the tier is
      // defined by the user not being able to write it.
      records.push({ ...record, mutable: false });
    }
  });

  // ── Global (no project trust) ────────────────────────────────────────────
  records.push(...withTier(skillRecords(homeAgentsSkills, globalScope, 'home'), 'portable'));
  records.push(...withTier(skillRecords(join(configDir, 'skills'), globalScope, 'managed'), 'nessy'));
  records.push(...withTier(markdownAgentRecords(join(configDir, 'agents'), globalScope), 'nessy'));
  records.push(...withTier(mcpServerRecords(join(configDir, 'mcp.json'), globalScope, '', undefined, mcpConfigSkips), 'nessy'));
  const globalHooks = fileRecord('hook', join(configDir, 'hooks.json'), globalScope, 'hooks.json');
  if (globalHooks) records.push({ ...globalHooks, sourceTier: 'nessy' });
  records.push(...memoryFileRecords(
    join(configDir, 'MEMORY.md'),
    configDir,
    globalScope,
    'MEMORY.md',
    '',
    seenMemoryFiles,
  ));
  // User-tier rules (`~/.claude/rules/`'s equivalent): "Personal rules in
  // `~/.claude/rules/` apply to every project on your machine"; pushed BEFORE
  // the workspace and project tiers because "User-level rules are loaded before
  // project rules, giving project rules higher priority" (memory.md).
  records.push(...ruleMemoryRecords(
    join(configDir, 'rules'),
    configDir,
    globalScope,
    seenMemoryFiles,
  ));
  // `--add-dir` roots, and ONLY behind the opt-in env var. Never the
  // `additionalDirectories` setting, which is documented as never loading
  // memory files at all.
  if (additionalDirectoryRulesEnabled()) {
    // P3.339 — the opt-in is on, and it is THE gate: since the producer landed
    // (`storage-runtime.ts toWorkspacePolicyContext`, owner sitting §1.4 = A)
    // the roots are supplied unconditionally and this `if` is the only thing
    // deciding whether any of them is read. Deliberately not a second env read
    // at the producer.
    //
    // If the list is still empty, say so once: the operator set the env var and
    // named no directories, and a loop over nothing is indistinguishable from
    // "there were no rules".
    if (!context.additionalRuleDirectories?.length) noticeInertAdditionalDirectoryRules();
    for (const root of context.additionalRuleDirectories ?? []) {
      for (const [dir, discriminator] of [
        [join(root, CLAUDE_RULES_DIR), 'rules-adddir-claude'],
        [join(root, '.agents', 'rules'), 'rules-adddir'],
      ] as const) {
        records.push(...ruleMemoryRecords(dir, root, globalScope, seenMemoryFiles, discriminator));
      }
    }
  }
  const globalPermissions = fileRecord(
    'permission',
    join(configDir, 'permissions', 'default.json'),
    globalScope,
    'permissions/default.json',
  );
  if (globalPermissions) records.push(globalPermissions);

  // ── Workspace (no project trust) ─────────────────────────────────────────
  records.push(...skillRecords(join(context.workspaceRootPath, 'skills'), workspaceScope));
  records.push(...markdownAgentRecords(context.workspaceRootPath, workspaceScope));
  records.push(...workspaceSourceRecords(context.workspaceRootPath, workspaceScope, mcpConfigSkips));
  const workspacePermissions = fileRecord(
    'permission', join(context.workspaceRootPath, 'permissions.json'), workspaceScope, 'permissions.json',
  );
  if (workspacePermissions) records.push(workspacePermissions);
  const workspaceHooks = fileRecord(
    'hook', join(context.workspaceRootPath, 'hooks.json'), workspaceScope, 'hooks.json',
  );
  if (workspaceHooks) records.push(workspaceHooks);
  const workspaceAutomations = fileRecord(
    'automation', join(context.workspaceRootPath, 'automations.json'), workspaceScope, 'automations.json',
  );
  if (workspaceAutomations) records.push(workspaceAutomations);
  records.push(...ruleMemoryRecords(
    join(context.workspaceRootPath, '.agents', 'rules'),
    context.workspaceRootPath,
    workspaceScope,
    seenMemoryFiles,
  ));
  records.push(...ruleMemoryRecords(
    join(context.workspaceRootPath, CLAUDE_RULES_DIR),
    context.workspaceRootPath,
    workspaceScope,
    seenMemoryFiles,
    'rules-claude',
  ));
  if (context.sessionMemoryFilePath) {
    records.push(...memoryFileRecords(
      context.sessionMemoryFilePath,
      dirname(context.sessionMemoryFilePath),
      workspaceScope,
      'MEMORY.md',
      'session',
      seenMemoryFiles,
    ));
  }
  for (const name of projectInstructionFilesIn(context.workspaceRootPath)) {
    records.push(...instructionFileRecords(
      join(context.workspaceRootPath, name),
      context.workspaceRootPath,
      workspaceScope,
      name,
      '',
      seenMemoryFiles,
    ));
  }

  // ── Project (trusted cwd only) ───────────────────────────────────────────
  const workingDirectory = context.workingDirectory ?? context.projectRoot;
  if (workingDirectory) {
    if (context.projectTrustState === 'trusted') {
      const projectScope: CapabilityScopeRef = {
        kind: 'project',
        workspaceId: context.workspaceId,
        projectKey: context.projectKey,
      };

      // Every project resource must resolve inside the verified containment
      // root; symlink/traversal escapes are rejected before hashing.
      const projectContainmentRoot = context.projectRoot ?? workingDirectory;
      let projectRealRoot: string | undefined;
      try {
        projectRealRoot = realpathSync(projectContainmentRoot);
      } catch {
        projectRealRoot = undefined;
      }

      if (projectRealRoot) {
        const nessyAgentDir = join(workingDirectory, NESSY_AGENT_PROJECT_DIR);

        // Nessy-native project tier: `<project>/.nessy-agent/*`.
        records.push(...withTier(skillRecords(join(nessyAgentDir, 'skills'), projectScope, 'na', projectRealRoot), 'nessy'));
        records.push(...withTier(markdownAgentRecords(join(nessyAgentDir, 'agents'), projectScope, projectRealRoot), 'nessy'));
        // F1.730 — Claude's own project subagents, read BESIDE ours, never
        // instead: `sub-agents.md#choose-the-subagent-scope` ranks `.claude/agents/`
        // as the "Current project" location, the trust dialog already lists it
        // (`project-contribution-detect.ts`), and Pi answered `Unknown agent`
        // for such a file. Portable tier, so the resolver's same-scope rule
        // keeps a same-named `.nessy-agent/agents` file; its own key keeps the
        // loser addressable. F1.1085: every `.claude/agents` from the working
        // directory up to the project root, recursively — {@link claudeProjectAgentRecords}.
        // NOT registered on Claude (F1.1178): the SDK loads the same file
        // itself, frontmatter hooks and inline MCP servers included, and a
        // same-named programmatic copy would replace that load — see
        // {@link isClaudeProjectAgentCopyKey}, the test applied to this key.
        records.push(...withTier(claudeProjectAgentRecords(workingDirectory, context.projectRoot, projectScope, projectRealRoot), 'portable'));
        records.push(...withTier(mcpServerRecords(join(nessyAgentDir, 'mcp.json'), projectScope, 'na', projectRealRoot, mcpConfigSkips), 'nessy'));
        const projectHooks = fileRecord(
          'hook', join(nessyAgentDir, 'hooks.json'), projectScope, '.nessy-agent/hooks.json', '', projectRealRoot,
        );
        if (projectHooks) records.push({ ...projectHooks, sourceTier: 'nessy' });
        const projectPermissions = fileRecord(
          'permission', join(nessyAgentDir, 'permissions.json'), projectScope, '.nessy-agent/permissions.json', '', projectRealRoot,
        );
        if (projectPermissions) records.push({ ...projectPermissions, sourceTier: 'nessy' });
        records.push(...withTier(memoryFileRecords(
          join(nessyAgentDir, 'MEMORY.md'),
          projectContainmentRoot,
          projectScope,
          'MEMORY.md',
          'project-na',
          seenMemoryFiles,
          undefined,
          refusedProjectImports,
        ), 'nessy'));
        if (projectSourceEnabled) {
          records.push(...withTier(ruleMemoryRecords(
            join(nessyAgentDir, 'rules'),
            projectContainmentRoot,
            projectScope,
            seenMemoryFiles,
            'rules-na',
          ), 'nessy'));
        }

        // Claude's own permission files, read BESIDE ours — never instead.
        // permissions.md § Project allow rules and workspace trust makes
        // `.claude/settings.json` a project-scope rule source and
        // `.claude/settings.local.json` the local one; settings.md's scope
        // table orders Local above Project, which is the order they are pushed
        // in here (later layers win ties at equal action weight).
        for (const [name, logical] of [
          ['settings.json', '.claude/settings.json'],
          ['settings.local.json', '.claude/settings.local.json'],
        ] as const) {
          const claudeSettings = fileRecord(
            'permission', join(workingDirectory, CLAUDE_PROJECT_DIR, name), projectScope, logical, '', projectRealRoot,
          );
          if (claudeSettings) records.push({ ...claudeSettings, sourceTier: 'portable' });
        }

        // Portable compatibility tier beside `.nessy-agent`.
        // Nested `.agents/skills` layers from cwd up to the project root.
        const layers = ancestorsUpTo(workingDirectory, context.projectRoot);
        layers.forEach((dir, depth) => {
          records.push(...withTier(skillRecords(join(dir, PROJECT_AGENT_SKILLS_DIR), projectScope, `d${depth}`, projectRealRoot), 'portable'));
        });
        // Nested skill layers BELOW the working directory (`skills.md:124`).
        // Unlike every other layer here, membership is not a function of the
        // tree — it is what the session has read, accumulated by
        // `discoverNestedSkillRoots` on the agent's file-touch channel and
        // capped at MAX_NESTED_SKILL_ROOTS. The whole set is re-read on every
        // capability turn, which is what makes an edit to a nested SKILL.md show
        // up without a second watcher.
        //
        // The qualifier is re-validated here rather than trusted: it arrives
        // from a process-local registry, and `isBelow` plus `projectRealRoot`
        // containment are what keep `../../etc` and a symlinked package out even
        // if a future producer is less careful than this one.
        const nestedSkillRootQualifiers = (
          env.nestedSkillRoots
            ?? nestedSkillRootsFor(nestedSkillRootRegistryKey({
              workspaceId: context.workspaceId,
              ...(context.projectKey ? { projectKey: context.projectKey } : {}),
              workingDirectory,
            }))
        ).slice(0, MAX_NESTED_SKILL_ROOTS);
        for (const qualifier of nestedSkillRootQualifiers) {
          const nestedDir = resolve(workingDirectory, qualifier);
          if (!isBelow(resolve(workingDirectory), nestedDir)) continue;
          const [portableSkills, nessySkills] = nestedSkillDirectories(nestedDir);
          records.push(...withNestedSkillQualifier(
            withTier(skillRecords(portableSkills, projectScope, `nested:${qualifier}`, projectRealRoot), 'portable'),
            qualifier,
          ));
          records.push(...withNestedSkillQualifier(
            withTier(skillRecords(nessySkills, projectScope, `nested-na:${qualifier}`, projectRealRoot), 'nessy'),
            qualifier,
          ));
        }
        records.push(...withTier(mcpServerRecords(join(workingDirectory, '.mcp.json'), projectScope, '', projectRealRoot, mcpConfigSkips), 'portable'));
        // Instruction files from the project root DOWN to the working directory.
        // `ancestorsUpTo` is nearest-first, so it is reversed here: the root is
        // pushed first and the nearest file lands last in the pinned block, where
        // it wins for a model reading top-to-bottom. `projectRealRoot`
        // containment rejects anything that resolves outside the project even if
        // the chain ran past it, so the walk cannot reach a parent repository.
        //
        // ## The project-root bound is a DIVERGENCE, and it is refused by name
        //
        // `memory.md#how-claude-md-files-load` is explicit and we do not match
        // it: "Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from your
        // current working directory and every directory above it." We stop at
        // `context.projectRoot`. That is deliberate and it stays: walking above
        // the project root would read a PARENT repository's instructions into a
        // trusted project's context, which is the containment `projectRealRoot`
        // exists to enforce two lines up — a checkout nested inside another
        // checkout would silently inherit the outer one's contract. Refused
        // here rather than left unexplained (P6.388); a fix would need a trust
        // decision per ancestor, which is P6.387's approval machinery, not a
        // loop bound.
        const instructionAncestors = ancestorsUpTo(workingDirectory, context.projectRoot)
          .slice(1) // the working directory's own tier is added below
          .reverse()
          .flatMap((dir, depth) => projectInstructionFilesIn(dir).map(name => ({ dir, name, depth })));
        let ancestorInstructionLayers = 0;
        for (const { dir, name, depth } of instructionAncestors) {
          const capped = ancestorInstructionLayers >= MAX_INSTRUCTION_ANCESTOR_LAYERS;
          const ancestorInstruction = instructionFileRecords(
            join(dir, name), projectContainmentRoot, projectScope, name, `up${depth}`,
            // Past the cap this call is a PROBE, so it gets a throwaway `seen`
            // set. `importedFileRecords` adds every file it visits to that set,
            // and a dropped layer marked seen would suppress a LATER legitimate
            // load of the same file — a working-directory instruction file that
            // imports `@../CLAUDE.md` would silently lose it. Asking whether a
            // file exists must not consume it.
            capped ? new Set<string>() : seenMemoryFiles,
            // A capped layer is a PROBE and reports nothing: it is not being
            // loaded at all, so an import inside it was never refused.
            capped ? undefined : refusedProjectImports,
          );
          // Nothing there, or contained out: not a layer, and never reported as
          // one. `projectInstructionFilesIn` yields CANDIDATE names, so this
          // guard is what separates a file the cap cost from a name that was
          // never on disk.
          if (ancestorInstruction.length === 0) continue;
          if (capped) {
            // This used to be a bare `break` placed ABOVE the read. The layers
            // nearest the working directory vanished from the model's context
            // and NOTHING anywhere said so — a bound we invented, hiding its
            // own effect, which is indistinguishable from a defect (P6.388).
            //
            // The read now happens before the cap decides, which costs I/O for
            // the dropped files and no CONTEXT at all — and context cost is the
            // only thing the cap's docstring bounds. `continue`, not `break`,
            // so the record is the whole truth: every file the cap cost, not
            // the first one it reached.
            droppedInstructionLayers.push({
              path: join(dir, name),
              reason: 'ancestor-layer-cap',
              limit: MAX_INSTRUCTION_ANCESTOR_LAYERS,
            });
            continue;
          }
          records.push(...withTier(ancestorInstruction, 'portable'));
          // The cap counts LEVELS, which is what its docstring bounds — the
          // files an ancestor's own `@path` imports pull in are that level's
          // content, not an extra level of the walk.
          ancestorInstructionLayers += 1;
        }
        // The working directory is the ONE tier that also reads
        // `.claude/CLAUDE.md` (`memory.md:60`, `:69`) — see
        // `WORKING_DIRECTORY_INSTRUCTION_FILES` for why it is path-bearing and
        // why the walks above are not.
        for (const entry of workingDirectoryInstructionFilesIn(workingDirectory)) {
          records.push(...withTier(instructionFileRecords(
            join(workingDirectory, entry.relativePath),
            projectContainmentRoot,
            projectScope,
            entry.logicalName,
            '',
            seenMemoryFiles,
            refusedProjectImports,
          ), 'portable'));
        }
        records.push(...withTier(memoryFileRecords(
          join(workingDirectory, 'MEMORY.md'),
          projectContainmentRoot,
          projectScope,
          'MEMORY.md',
          'project',
          seenMemoryFiles,
          undefined,
          refusedProjectImports,
        ), 'portable'));
        if (projectSourceEnabled) {
          records.push(...withTier(ruleMemoryRecords(
            join(projectContainmentRoot, '.agents', 'rules'),
            projectContainmentRoot,
            projectScope,
            seenMemoryFiles,
          ), 'portable'));
          // Claude's own shape, read BESIDE ours — never instead of ours.
          records.push(...withTier(ruleMemoryRecords(
            join(projectContainmentRoot, CLAUDE_RULES_DIR),
            projectContainmentRoot,
            projectScope,
            seenMemoryFiles,
            'rules-claude',
          ), 'portable'));
        }
      }
    } else {
      // Untrusted project: no repository-owned content, one safe diagnostic.
      blockedLayers.push({
        scope: 'project',
        reason: 'untrusted-project',
        withheldKinds: [...PROJECT_WITHHELD_KINDS],
        projectKey: context.projectKey,
      });
    }
  }

  // One exclusion pass over the finished inventory: `claudeMdExcludes` "skips
  // every CLAUDE.md and rules file under that package", including the imports a
  // rule or instruction file pulled in.
  //
  // The managed tier is carved out, and the carve-out is the point of the tier:
  // `memory.md:336` — "Managed policy CLAUDE.md files cannot be excluded. This
  // ensures organization-wide instructions always apply regardless of individual
  // settings." `claudeMdExcludes` itself is settable at any layer INCLUDING
  // managed (`:334`), so without this a user-scope pattern would switch off the
  // one tier the user is not supposed to be able to switch off.
  const kept = records.filter(record => (
    (record.kind !== 'instruction' && record.kind !== 'memory')
    || record.scope.kind === 'builtin'
    || !isExcluded(record.sourcePath)
  ));

  return {
    records: kept,
    blockedLayers,
    mcpConfigSkips,
    // Both bounds ride one field and keep their own `reason`, so the resolver
    // can render our ancestor cap and the page's size rule as two different
    // sentences rather than one that is wrong about half its members.
    //
    // The size skips are deduplicated BY PATH, and the ancestor cap's are not,
    // deliberately: one file can be walked from two scopes (workspace root and
    // trusted project cwd are the same directory in the common case), and the
    // diagnostic counts FILES a user could go and shorten. Two lines for one
    // path would say the user has two problems.
    droppedInstructionLayers: [
      ...droppedInstructionLayers,
      ...[...new Map(oversizeSkips.map(skip => [skip.path, skip])).values()],
    ],
    refusedProjectImports,
  };
}

/**
 * Temporary compatibility helper: collapse the qualified inventory to the
 * current unqualified short-name result (last-write-wins by scope order).
 * Preserved only so pre-W8 consumers keep working; W8 replaces this with the
 * real alias policy.
 */
export function collapseToUnqualifiedNames(
  records: NativeCapabilitySourceRecord[],
  kind: NativeCapabilityKind,
): Map<string, NativeCapabilitySourceRecord> {
  const byName = new Map<string, NativeCapabilitySourceRecord>();
  for (const record of records) {
    if (record.kind !== kind) continue;
    byName.set(record.logicalName, record);
  }
  return byName;
}

/**
 * F1.1178 — the key discriminator of the host's copy of a trusted project's
 * `<cwd>/.claude/agents/*.md` (F1.730, the trusted-project block of
 * {@link buildNativeCapabilityInventory}), exported with its test so its
 * consumers read the key {@link qualifiedKey} mints rather than a second
 * spelling of it. There are two: the Claude translation
 * (`agent/claude-runtime-agents.ts`) skips the copy and, under F1.1203, drops
 * the bundled agent whose name the copy takes over; and the descriptor builder
 * (`agent/pi-harness/runtime-agent-definition.ts`) stamps `claudeAgentName`
 * (the frontmatter `name` Claude loads the file under) on that copy only.
 *
 * The Claude translation does NOT register the copy. The SDK already loads the
 * file itself —
 * `agent-sdk/claude-code-features.md`: "When you omit `settingSources`,
 * `query()` reads the same filesystem settings as the Claude Code CLI: user,
 * project, and local settings, CLAUDE.md files, and `.claude/` skills, agents,
 * and commands" — and `agent-sdk/subagents.md` says "Programmatically defined
 * agents take precedence over filesystem-based agents with the same name", so
 * registering the copy replaced Claude's own load with a translation that
 * carries neither the file's frontmatter hooks nor its inline MCP servers, and
 * put the file back into a session whose `settingSources` had left `project`
 * out. Pi and codex have no loader of their own for the folder; they keep it.
 */
export const CLAUDE_PROJECT_AGENT_KEY_DISCRIMINATOR = 'claude';

/** True for the key of the record {@link CLAUDE_PROJECT_AGENT_KEY_DISCRIMINATOR} describes. */
export function isClaudeProjectAgentCopyKey(key: string): boolean {
  // `qualifiedKey`'s layout: kind, scope kind, workspace, project, discriminator, logical name.
  const [kind, scopeKind, , , discriminator] = key.split('::');
  return kind === 'agent' && scopeKind === 'project'
    && (discriminator === CLAUDE_PROJECT_AGENT_KEY_DISCRIMINATOR
      || (discriminator?.startsWith(CLAUDE_PROJECT_AGENT_ANCESTOR_PREFIX) ?? false)); // F1.1085
}

/** F1.1085 — the discriminator prefix of a copy read from a folder ABOVE the working directory (`claude_up01`, …). */
const CLAUDE_PROJECT_AGENT_ANCESTOR_PREFIX = `${CLAUDE_PROJECT_AGENT_KEY_DISCRIMINATOR}_up`;

/** How deep below one `.claude/agents` folder the copy looks; a bound against a pathological tree. */
const CLAUDE_PROJECT_AGENT_SUBFOLDER_DEPTH = 8;

/**
 * F1.1085 (origin DN-038) — the host's copy of a trusted project's `.claude/agents` (F1.730; read by Pi and codex,
 * which have no loader of their own for the folder, and skipped on Claude, F1.1178) walks the folders Claude Code
 * walks: `sub-agents.md#choose-the-subagent-scope` — "Project subagents are discovered by walking up from the current
 * working directory, so every `.claude/agents/` between there and the repository root is scanned", "Claude Code uses
 * the definition closest to the working directory", and "Claude Code scans `.claude/agents/` … recursively".
 *
 * Bounded by `projectRoot`, the trusted root every other project layer of the inventory stays inside (the
 * `.agents/skills` walk above uses the same bound), so a folder the user did not trust is never read; a session
 * whose working directory IS the project root reads the one folder it read before.
 *
 * The nearest folder keeps the plain `claude` discriminator and a folder `n` levels up takes `claude_up0n`: the
 * resolver breaks a same-scope, same-tier tie on the lexical key, and `claude::` sorts before `claude_up01::`,
 * which sorts before `claude_up02::` — so the nearest definition is the one a bare name resolves to, as on Claude.
 * Inside one folder tree a name is kept once (the first in path order), since two files there would mint the same
 * key; Claude Code itself loads one of them "chosen by filesystem read order". Residue: the logical name is the
 * file name, not the frontmatter `name` Claude Code identifies an agent by (F1.730's rule, unchanged here).
 */
function claudeProjectAgentRecords(
  workingDirectory: string,
  projectRoot: string | undefined,
  scope: CapabilityScopeRef,
  containRealRoot: string,
): NativeCapabilitySourceRecord[] {
  const records: NativeCapabilitySourceRecord[] = [];
  ancestorsUpTo(workingDirectory, projectRoot).forEach((dir, up) => {
    if (!insideRealRoot(dir, containRealRoot)) return; // a working directory outside the root walks no further
    const discriminator = up === 0
      ? CLAUDE_PROJECT_AGENT_KEY_DISCRIMINATOR
      : `${CLAUDE_PROJECT_AGENT_ANCESTOR_PREFIX}${String(up).padStart(2, '0')}`;
    const seenKeys = new Set<string>();
    const visit = (agentsDir: string, depth: number): void => {
      for (const record of markdownAgentRecords(agentsDir, scope, containRealRoot, discriminator)) {
        if (seenKeys.has(record.key)) continue;
        seenKeys.add(record.key);
        records.push(record);
      }
      if (depth >= CLAUDE_PROJECT_AGENT_SUBFOLDER_DEPTH) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(agentsDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        const sub = join(agentsDir, entry.name);
        if (insideRealRoot(sub, containRealRoot)) visit(sub, depth + 1);
      }
    };
    visit(join(dir, CLAUDE_PROJECT_DIR, 'agents'), 0);
  });
  return records;
}
