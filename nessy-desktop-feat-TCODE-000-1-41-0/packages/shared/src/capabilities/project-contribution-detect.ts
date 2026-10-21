/**
 * Read-only project-contribution detection (Codex-parity, pre-trust consent).
 *
 * Answers "what would this project folder contribute if trusted?" WITHOUT
 * copying, migrating, or executing anything. Detection is deliberately:
 * - bounded: only a fixed set of well-known paths, no recursion beyond a
 *   single fixed level (a skill dir's `SKILL.md`);
 * - realpath-contained: every candidate must resolve inside the realpathed
 *   root, so a symlinked entry pointing outside the project is rejected;
 * - path-free: the report carries basenames / MCP server slugs and convention
 *   labels only — NEVER an absolute path, file content, or env value.
 *
 * This is the visibility half of the detect+consent model. Trust itself, and
 * the in-place ephemeral resolve of trusted config, stay owned by W6/W8
 * (`native-sources.ts`); this module only reports.
 *
 * ## D1.223 — this report is now also a DECISION, so its gaps matter twice
 *
 * `projectWouldContribute` below suppresses the folder-trust PROMPT while this
 * report is empty, so a source the trusted block reads and this module misses
 * is no longer only an under-stated dialog: it is a question the user is never
 * asked about a folder that does contribute. Seven were missing and are added
 * here — the whole `.nessy-agent` tier (`agents`, `mcp.json`, `hooks.json`,
 * `permissions.json`, `MEMORY.md`, `rules`) and the portable `.agents/skills`
 * layer.
 *
 * TWO residues remain, stated rather than hidden, and neither can make the
 * prompt disappear on a folder whose own root carries anything:
 *
 *  - **Ancestor layers.** `native-sources.ts` walks `.agents/skills` and the
 *    instruction files from the working directory UP to the project root; this
 *    report is root-scoped, so a project whose only layer sits between the two
 *    previews as empty ({@link detectRepositoryAncestorLayers} reads ABOVE the root).
 *  - **Nested skill roots.** Membership there is not a function of the tree at
 *    all — it is what the session has already read, accumulated on the agent's
 *    file-touch channel — so nothing on disk can be probed for it before a
 *    turn has happened.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parseMcpServersDocument } from '../mcp/project-config.ts';
import { projectInstructionFilesIn } from './native-sources.ts';
import type {
  ProjectContributionItem,
  ProjectContributionItemType,
  ProjectContributionReport,
} from '../protocol/capabilities.ts';

/** Hard cap on names surfaced per item; the rest is summarized by `count`. */
const MAX_NAMES = 20;
/** Upper bound for an MCP config file read during detection (1 MiB). */
const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
/** Defensive cap on a single surfaced name's length. */
const MAX_NAME_LENGTH = 100;

/** Stable display order for detected items (MCP files keep their file order). */
const ITEM_TYPE_ORDER: ProjectContributionItemType[] = [
  'AGENTS_MD',
  'MCP_SERVER_CONFIG',
  'SKILLS',
  'SUBAGENTS',
  'COMMANDS',
  'HOOKS',
  'CONFIG',
];

/** MCP config files a project may carry, in stable display order. */
const MCP_CONFIG_FILES: Array<{ relPath: string; label: string }> = [
  // D1.223 — the Nessy-native tier first, in the order `native-sources.ts`
  // pushes them under trust. It was absent, so a project whose only MCP config
  // was `.nessy-agent/mcp.json` was previewed as contributing nothing.
  { relPath: join('.nessy-agent', 'mcp.json'), label: 'project .nessy-agent/mcp.json' },
  { relPath: '.mcp.json', label: 'project .mcp.json' },
  { relPath: join('.cursor', 'mcp.json'), label: 'Cursor .cursor/mcp.json' },
  { relPath: join('.vscode', 'mcp.json'), label: 'VS Code .vscode/mcp.json' },
];

/** Claude-convention `.claude/settings*.json` files whose presence we report. */
const CLAUDE_SETTINGS_FILES = ['settings.json', 'settings.local.json'];

/** True when `path` resolves inside the already-realpathed root. */
function insideRealRoot(path: string, realRoot: string): boolean {
  try {
    const real = realpathSync(path);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

/** Path-free basename guard: reject separators / traversal / control chars. */
function isSafeName(name: string): boolean {
  if (!name || name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

/** Read directory entries once; empty on any failure (missing dir, EACCES). */
function readEntriesSafe(dir: string): import('node:fs').Dirent[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Sort + de-dup names, drop unsafe ones, then bound to `MAX_NAMES`. */
function boundNames(names: string[]): { names: string[]; count: number; truncated: boolean } {
  const unique = [...new Set(names.filter(isSafeName))].sort((a, b) => a.localeCompare(b));
  const count = unique.length;
  const truncated = count > MAX_NAMES;
  return { names: truncated ? unique.slice(0, MAX_NAMES) : unique, count, truncated };
}

function makeItem(
  itemType: ProjectContributionItemType,
  sourceLabel: string,
  names: string[],
): ProjectContributionItem | null {
  const bounded = boundNames(names);
  if (bounded.count === 0) return null;
  return {
    itemType,
    sourceLabel,
    count: bounded.count,
    names: bounded.names,
    ...(bounded.truncated ? { truncated: true } : {}),
  };
}

/** MCP server slugs from one config file (keys only — never url/command/env). */
function detectMcpServers(root: string, realRoot: string, relPath: string): string[] {
  const configPath = join(root, relPath);
  if (!existsSync(configPath)) return [];
  if (!insideRealRoot(configPath, realRoot)) return [];
  // Hardening (review 2026-07-20): the detection runs PRE-trust and the RPC is
  // remote-eligible, so never block on a non-regular file (a FIFO here would
  // hang the synchronous read indefinitely) and cap the read size.
  try {
    const stat = statSync(configPath);
    if (!stat.isFile() || stat.size > MAX_MCP_CONFIG_BYTES) return [];
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return [];
  }
  // parseMcpServersDocument validates shape; we surface ONLY the slug keys.
  return Object.keys(parseMcpServersDocument(parsed, undefined, relPath));
}

/**
 * Contained instruction files present at the project root
 * (`AGENTS.override.md`/`AGENTS.md`/`CLAUDE*`).
 *
 * Through {@link projectInstructionFilesIn}, so the pre-trust preview names the
 * same files the session will actually load: a root carrying
 * `AGENTS.override.md` lists the override and not the `AGENTS.md` it supersedes,
 * which is what codex does with that root and what our collector now does too.
 */
function detectInstructions(root: string, realRoot: string): string[] {
  return projectInstructionFilesIn(root).filter(name => {
    const path = join(root, name);
    return existsSync(path) && insideRealRoot(path, realRoot);
  });
}

/** The project instruction file at the `.claude/` alternative location. */
function detectClaudeDirInstructions(root: string, realRoot: string): string[] {
  const path = join(root, '.claude', 'CLAUDE.md');
  return existsSync(path) && insideRealRoot(path, realRoot) ? ['CLAUDE.md'] : [];
}

/** Skill directory names under `.nessy-agent/skills` (each with a `SKILL.md`). */
function detectSkills(root: string, realRoot: string): string[] {
  return detectSkillDirectories(join(root, '.nessy-agent', 'skills'), realRoot);
}

/** Skill directory names directly inside `skillsDir` (each with a `SKILL.md`). */
function detectSkillDirectories(skillsDir: string, realRoot: string): string[] {
  const names: string[] = [];
  for (const entry of readEntriesSafe(skillsDir)) {
    if (!entry.isDirectory() || !isSafeName(entry.name)) continue;
    const skillFile = join(skillsDir, entry.name, 'SKILL.md');
    if (existsSync(skillFile) && insideRealRoot(skillFile, realRoot)) {
      names.push(entry.name);
    }
  }
  return names;
}

/** Markdown file basenames (sans `.md`) under a `.claude/*` directory. */
function detectClaudeMarkdown(root: string, realRoot: string, subdir: string): string[] {
  return detectMarkdownDirectory(join(root, '.claude', subdir), realRoot);
}

/** Markdown file basenames (sans `.md`) directly inside `dir`. */
function detectMarkdownDirectory(dir: string, realRoot: string): string[] {
  const names: string[] = [];
  for (const entry of readEntriesSafe(dir)) {
    if (!entry.isFile() || !isSafeName(entry.name)) continue;
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    if (!insideRealRoot(join(dir, entry.name), realRoot)) continue;
    names.push(entry.name.replace(/\.md$/i, ''));
  }
  return names;
}

/** Hook contributions: `.claude/hooks.json` presence + `.claude/hooks/*` files. */
function detectHooks(root: string, realRoot: string): string[] {
  const names: string[] = [];
  const hooksJson = join(root, '.claude', 'hooks.json');
  if (existsSync(hooksJson) && insideRealRoot(hooksJson, realRoot)) {
    names.push('hooks.json');
  }
  const hooksDir = join(root, '.claude', 'hooks');
  for (const entry of readEntriesSafe(hooksDir)) {
    if (!entry.isFile() || !isSafeName(entry.name)) continue;
    if (insideRealRoot(join(hooksDir, entry.name), realRoot)) names.push(entry.name);
  }
  return names;
}

/**
 * D1.223 — the Nessy-native project files `native-sources.ts` reads under trust
 * and this module did not report. Presence only: their content is a contract,
 * not a list of names, and this report is path-free and bounded by design.
 */
function detectPresence(root: string, realRoot: string, relPath: string, name: string): string[] {
  const path = join(root, relPath);
  return existsSync(path) && insideRealRoot(path, realRoot) ? [name] : [];
}

/** Presence of `.claude/settings*.json`. */
function detectClaudeSettings(root: string, realRoot: string): string[] {
  return CLAUDE_SETTINGS_FILES.filter(name => {
    const path = join(root, '.claude', name);
    return existsSync(path) && insideRealRoot(path, realRoot);
  });
}

/**
 * Detect what `root` would contribute if trusted. Read-only and fail-soft: any
 * unreadable root (missing, EACCES, non-realpathable) yields an empty report.
 */
export function detectProjectContributions(root: string): ProjectContributionReport {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { items: [] };
  }

  const items: ProjectContributionItem[] = [];

  const instructions = makeItem('AGENTS_MD', 'project instructions', detectInstructions(root, realRoot));
  if (instructions) items.push(instructions);

  // `memory.md:69` — "A project CLAUDE.md can be stored in either `./CLAUDE.md`
  // or `./.claude/CLAUDE.md`." A trusted project now loads the second location
  // too, so the pre-trust dialog has to name it, or the user approves a project
  // whose instruction content the dialog never mentioned.
  //
  // Its own item rather than another entry in `detectInstructions`: `boundNames`
  // filters through `isSafeName`, which rejects any name containing `/`, so a
  // `.claude/CLAUDE.md` entry there would be dropped SILENTLY and the change
  // would look like it worked. `sourceLabel` is free-form and already carries
  // values of this shape (`.claude/agents`, `.claude/settings.json`), so the
  // path lives there and the name stays a bare basename.
  const claudeDirInstructions = makeItem(
    'AGENTS_MD',
    '.claude/CLAUDE.md',
    detectClaudeDirInstructions(root, realRoot),
  );
  if (claudeDirInstructions) items.push(claudeDirInstructions);

  for (const { relPath, label } of MCP_CONFIG_FILES) {
    const mcp = makeItem('MCP_SERVER_CONFIG', label, detectMcpServers(root, realRoot, relPath));
    if (mcp) items.push(mcp);
  }

  // D1.223 — `.nessy-agent/MEMORY.md` and `.nessy-agent/rules` are instruction
  // content a trusted project loads (`native-sources.ts` pushes both into the
  // project scope), so a preview that omits them under-states what approval
  // buys. `rules` is a directory of markdown; MEMORY.md is presence.
  const nessyMemory = makeItem(
    'AGENTS_MD', '.nessy-agent/MEMORY.md',
    detectPresence(root, realRoot, join('.nessy-agent', 'MEMORY.md'), 'MEMORY.md'),
  );
  if (nessyMemory) items.push(nessyMemory);

  // F1.846 — Pi reads `.nessy-agent/rules` recursively (`discoverRuleFiles`), so a
  // directory holding only subdirectories is not empty: the same one-level-of-
  // subdirectories reader `.claude/rules` uses.
  const nessyRules = makeItem(
    'AGENTS_MD', '.nessy-agent/rules',
    detectRuleDirectory(join(root, '.nessy-agent', 'rules'), realRoot),
  );
  if (nessyRules) items.push(nessyRules);

  // F1.846 — the two more instruction layers Pi's trusted project scope loads
  // (`native-sources.ts`): the root `MEMORY.md` and the portable `.agents/rules`.
  const rootMemory = makeItem('AGENTS_MD', 'MEMORY.md', detectPresence(root, realRoot, 'MEMORY.md', 'MEMORY.md'));
  if (rootMemory) items.push(rootMemory);
  const portableRules = makeItem('AGENTS_MD', '.agents/rules', detectRuleDirectory(join(root, '.agents', 'rules'), realRoot));
  if (portableRules) items.push(portableRules);

  // F1.846 — project output styles come only with trust: claude's `project`
  // source since F1.768, and ours (`listOutputStyles`' `projectTrusted` gate).
  const claudeOutputStyles = makeItem('AGENTS_MD', '.claude/output-styles', detectClaudeMarkdown(root, realRoot, 'output-styles'));
  if (claudeOutputStyles) items.push(claudeOutputStyles);

  // F1.839 — see the block above `detectCodexProjectLayer` at the end of this file.
  const claudeRules = makeItem('AGENTS_MD', '.claude/rules', detectRuleDirectory(join(root, '.claude', 'rules'), realRoot));
  if (claudeRules) items.push(claudeRules);

  const skills = makeItem('SKILLS', '.nessy-agent/skills', detectSkills(root, realRoot));
  if (skills) items.push(skills);

  // The portable skills layer at the working directory. `native-sources.ts`
  // walks `.agents/skills` from the cwd up to the project root; this preview is
  // root-scoped, so it reports the layer AT the root and the residue is stated
  // in this module's header.
  const portableSkills = makeItem(
    'SKILLS', '.agents/skills',
    detectSkillDirectories(join(root, '.agents', 'skills'), realRoot),
  );
  if (portableSkills) items.push(portableSkills);

  const claudeSkills = makeItem(
    'SKILLS', '.claude/skills',
    detectSkillDirectories(join(root, '.claude', 'skills'), realRoot),
  );
  if (claudeSkills) items.push(claudeSkills);

  const nessySubagents = makeItem(
    'SUBAGENTS', '.nessy-agent/agents',
    detectMarkdownDirectory(join(root, '.nessy-agent', 'agents'), realRoot),
  );
  if (nessySubagents) items.push(nessySubagents);

  const subagents = makeItem('SUBAGENTS', '.claude/agents', detectClaudeMarkdown(root, realRoot, 'agents'));
  if (subagents) items.push(subagents);

  const commands = makeItem('COMMANDS', '.claude/commands', detectClaudeMarkdown(root, realRoot, 'commands'));
  if (commands) items.push(commands);

  // F1.866 — a saved claude workflow, `.claude/workflows/<name>.js`, runs as `/<name>` (see {@link detectWorkflowScripts}).
  const workflows = makeItem('COMMANDS', '.claude/workflows', detectWorkflowScripts(join(root, '.claude', 'workflows'), realRoot));
  if (workflows) items.push(workflows);

  const nessyHooks = makeItem(
    'HOOKS', '.nessy-agent/hooks.json',
    detectPresence(root, realRoot, join('.nessy-agent', 'hooks.json'), 'hooks.json'),
  );
  if (nessyHooks) items.push(nessyHooks);

  const hooks = makeItem('HOOKS', '.claude/hooks', detectHooks(root, realRoot));
  if (hooks) items.push(hooks);

  const nessyPermissions = makeItem(
    'CONFIG', '.nessy-agent/permissions.json',
    detectPresence(root, realRoot, join('.nessy-agent', 'permissions.json'), 'permissions.json'),
  );
  if (nessyPermissions) items.push(nessyPermissions);

  const settings = makeItem('CONFIG', '.claude/settings.json', detectClaudeSettings(root, realRoot));
  if (settings) items.push(settings);

  items.push(...detectCodexProjectLayer(root, realRoot));
  // F1.846 — and the MCP servers that `config.toml` would start, named like the `.mcp.json` rows.
  const codexMcp = makeItem('MCP_SERVER_CONFIG', '.codex/config.toml', detectCodexMcpServers(root, realRoot));
  if (codexMcp) items.push(codexMcp);

  // F1.844 — see the block above `detectRepositoryAncestorLayers` at the end of this file.
  items.push(...detectRepositoryAncestorLayers(realRoot));
  // F1.847 — see the block above `detectClaudeParentLayers` at the end of this file.
  items.push(...detectClaudeParentLayers(realRoot));
  // F1.849 — see the block above `detectLinkedWorktreeMainCheckoutLayers` at the end of this file.
  items.push(...detectLinkedWorktreeMainCheckoutLayers(realRoot));

  // Stable display order; MCP files retain their fixed insertion order.
  items.sort((a, b) => ITEM_TYPE_ORDER.indexOf(a.itemType) - ITEM_TYPE_ORDER.indexOf(b.itemType));
  return { items };
}

/*
 * F1.839 — the layers codex and claude load ONLY for a trusted project.
 *
 * Since F1.750 the host writes codex's own trust entry, `untrusted` for every
 * project the user did not trust (a never-asked one included), and codex keeps
 * such a project's `.codex/` layer out. Its source (`rust-v0.156.1`,
 * `config/src/loader/mod.rs`) disables every non-trusted project layer, naming
 * what that withholds as "project-local config, hooks, and exec policies": the
 * layer's `config.toml` (its MCP servers among it), its `hooks.json` (read from
 * enabled layers only, `hooks/src/engine/discovery.rs`) and its `rules/*.rules`
 * (`core/src/exec_policy.rs`); `agent-roles/src/loader.rs` reads `agents/*.toml`
 * from enabled layers only too. Since F1.768 the claude child gets
 * `settingSources: ['user']` unless the project is trusted, and the SDK's
 * `project` source is, verbatim, "Project `settings.json` and hooks; project
 * CLAUDE.md and `.claude/rules/*.md`; project skills, commands, and subagents".
 *
 * Before this plan both runtimes loaded those layers whatever the host decided;
 * now they come only with trust. And `projectWouldContribute` suppresses the
 * prompt while this report is empty, so a folder carrying one of them alone was
 * never asked about on the re-prompt path and its layer silently stopped
 * loading. Each is reported here under the item type whose existing label the
 * trust dialog renders, so no new locale key.
 *
 * NOT reported, deliberately: `.codex/skills`. Codex reads it from EVERY project
 * layer, disabled ones included (`ext/skills/src/host_roots.rs` walks
 * `all_layers_high_to_low()`), so trust does not decide it and naming it would
 * overstate what approval buys.
 *
 * Residues, stated: a `.codex/` in a directory between the working directory
 * and the project root is F1.844's (`detectRepositoryAncestorLayers` below calls
 * this with a relative label prefix); `.codex/agents` is read one level deep here,
 * where codex walks it recursively; `.claude/rules` is read to one level of
 * subdirectories, where claude walks it recursively and follows symlinks out of
 * the project — this report keeps its bounded, realpath-contained shape.
 */
function detectCodexProjectLayer(root: string, realRoot: string, labelPrefix = ''): ProjectContributionItem[] {
  const codexDir = join(root, '.codex');
  return [
    makeItem('CONFIG', `${labelPrefix}.codex/config.toml`, detectPresence(root, realRoot, join('.codex', 'config.toml'), 'config.toml')),
    makeItem('CONFIG', `${labelPrefix}.codex/rules`, detectFilesWithExtension(join(codexDir, 'rules'), realRoot, '.rules')),
    makeItem('HOOKS', `${labelPrefix}.codex/hooks.json`, detectPresence(root, realRoot, join('.codex', 'hooks.json'), 'hooks.json')),
    makeItem('SUBAGENTS', `${labelPrefix}.codex/agents`, detectFilesWithExtension(join(codexDir, 'agents'), realRoot, '.toml')),
  ].filter(isItem);
}

function isItem(item: ProjectContributionItem | null): item is ProjectContributionItem {
  return item !== null;
}

/** File basenames (sans `extension`) directly inside `dir`, realpath-contained. */
function detectFilesWithExtension(dir: string, realRoot: string, extension: string): string[] {
  const names: string[] = [];
  for (const entry of readEntriesSafe(dir)) {
    if (!entry.isFile() || !isSafeName(entry.name)) continue;
    if (!entry.name.toLowerCase().endsWith(extension)) continue;
    if (!insideRealRoot(join(dir, entry.name), realRoot)) continue;
    names.push(entry.name.slice(0, -extension.length));
  }
  return names;
}

/**
 * Markdown rule basenames in a `.claude/rules`-shaped directory: its own files
 * plus one level of subdirectories (memory.md, 'Set up rules': "All `.md` files
 * are discovered recursively, so you can organize rules into subdirectories like
 * `frontend/` or `backend/`"). A symlinked subdirectory is not followed — the
 * pre-trust report stays bounded and inside the project.
 */
function detectRuleDirectory(dir: string, realRoot: string): string[] {
  const names = detectMarkdownDirectory(dir, realRoot);
  for (const entry of readEntriesSafe(dir)) {
    if (!entry.isDirectory() || !isSafeName(entry.name)) continue;
    names.push(...detectMarkdownDirectory(join(dir, entry.name), realRoot));
  }
  return names;
}

/*
 * F1.844 — the layers the runtimes read ABOVE the selected folder.
 *
 * The report above is root-scoped, and both runtimes read past that root — only
 * under trust since F1.750/F1.768. Measured on the shipped binaries with the
 * selected folder a subfolder (`packages/app`) of a git repository whose ROOT
 * carried the layer (`work/wjcritpp/`): before this plan codex (0.156.1) started
 * the root `.codex/config.toml`'s MCP server, applied its `rules/` and sent the
 * root AGENTS.md to the model, and claude (2.1.267) loaded the root CLAUDE.md,
 * CLAUDE.local.md, `.claude/CLAUDE.md`, `.claude/rules` (nested too), its skills,
 * agents and commands, started the root `.mcp.json` server and ran the root
 * `settings.local.json` hook. For a folder nobody decided about, neither loads any
 * of it now, and this report named none of it — so the folder previewed empty and
 * the re-prompt gate never asked. Trusting the folder loads all of it again on
 * both (codex's `trusted` entry is keyed on the repository root,
 * `codexProjectTrustOptionsFor`; claude gets its default sources), so the fix is
 * the question, never the trust.
 *
 * What is read, per directory from the selected folder's parent UP TO AND
 * INCLUDING its repository root — the nearest `.git`, through the host's own
 * walk (`outputStyleProjectRootFor`), which is F1.750's trusted key and the
 * `project_root_markers = [".git"]` the host pins for codex — and nothing above:
 *
 *  - codex: that directory's `.codex/` rows (`detectCodexProjectLayer`, labelled
 *    relative to the selected folder) and the AGENTS.md chain.
 *    `config/src/loader/mod.rs` `discover_project_layers` (`rust-v0.156.1`) reads
 *    a `.codex/` in every directory from the cwd up to the project root, and
 *    outside a repository the project root IS the cwd (measured: a non-repository
 *    parent's `.codex/` never loaded).
 *  - claude: the CLAUDE.md chain, `.claude/CLAUDE.md`, `.claude/rules` and
 *    `.mcp.json` (read from every parent: memory.md, "How CLAUDE.md files load";
 *    in the binary the `.mcp.json` walk too); `.claude/skills`, `.claude/agents`
 *    and `.claude/commands` (skills.md, "in every parent directory up to the
 *    repository root"; sub-agents.md, "every `.claude/agents/` between there and
 *    the repository root is scanned"), except in the home directory, where the
 *    binary's walk stops before it pushes that directory; and the repository
 *    root's `.claude/settings.local.json` (settings.md, "it reads and writes that
 *    file at the repository root"), except where that page keeps it beside
 *    `settings.json` instead (a home-directory repository root, Windows).
 *  - NOT `.claude/settings.json` (read from the working directory only — measured:
 *    the root's hook ran with the root selected and not from the subfolder), not
 *    `.codex/skills` or `.agents/skills` (codex reads them whatever the trust,
 *    F1.839's note), and nothing Pi reads: Pi bounds every walk at the project
 *    root, which is the selected folder itself (`native-sources.ts`, P6.388) —
 *    which is also why the header's "Ancestor layers" residue, a Pi walk, is not
 *    this one.
 *
 * Bounded and contained like the rest: the same helpers, containment in the
 * repository root, relative labels (`../..`, `../.claude/skills`) and never an
 * absolute path.
 *
 * Residues, stated: claude reads the CLAUDE.md chain, `.claude/rules` and
 * `.mcp.json` from EVERY parent up to the filesystem root, and outside a
 * repository its skills, agents and commands up to the home directory (measured);
 * this walk stops at the repository root and does not start outside one, and
 * F1.847's {@link detectClaudeParentLayers} below reads the rest up to the home
 * directory, exclusive — whose `.claude/CLAUDE.md` and `.claude/rules` the child
 * reads as PROJECT memory (each workspace has its own `CLAUDE_CONFIG_DIR`); that
 * carve-out is a posture, stated there. A linked worktree's main-checkout layers
 * claude reads are F1.849's {@link detectLinkedWorktreeMainCheckoutLayers}. Not
 * modelled (F1.849, each LOW, none measured as a harm): a `.git` directory without
 * `HEAD` (codex skips it and walks on to a higher root, this walk stops there — a
 * `.codex/` above it goes unnamed); codex's main-checkout hooks in a linked
 * worktree (`load_root_checkout_hooks`, not measured here); a folder reached
 * through a symlink (walked on its real path, as codex does, where claude walks
 * the working directory as spelled — the report may name a layer claude does not
 * read, the safe direction); and claude keeping `settings.local.json` beside
 * `settings.json` when the repository root or its `.git` or `.claude` entry is not
 * owned by the user (settings.md#where-claude-code-looks-for-each-file) — named
 * at the root here, again the safe direction.
 */
import { homedir } from 'node:os';
import { outputStyleProjectRootFor } from '../prompts/output-styles.ts';

/**
 * The trust-gated layers of every directory above `realRoot` (already realpathed)
 * up to its repository root, nearest first; `[]` when `realRoot` is not inside a
 * repository or is its root. `home` is a seam for the home-directory carve-outs.
 */
export function detectRepositoryAncestorLayers(realRoot: string, home: string = homedir()): ProjectContributionItem[] {
  const repositoryRoot = outputStyleProjectRootFor(realRoot);
  if (!repositoryRoot || repositoryRoot === realRoot) return [];
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // Unresolvable: compared as spelled.
  }
  const items: ProjectContributionItem[] = [];
  let dir = realRoot;
  let prefix = '';
  while (dir !== repositoryRoot) {
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
    prefix += '../';
    items.push(...detectAncestorLayer(dir, repositoryRoot, prefix, {
      repositoryRoot: dir === repositoryRoot,
      home: dir === realHome,
    }));
  }
  return items;
}

/** One ancestor directory's rows, labelled relative to the selected folder. */
function detectAncestorLayer(
  dir: string,
  realRepositoryRoot: string,
  prefix: string,
  at: { repositoryRoot: boolean; home: boolean },
): ProjectContributionItem[] {
  const claudeDir = join(dir, '.claude');
  const claudeWalk = !at.home;
  const claudeLocalSettings = at.repositoryRoot && !at.home && process.platform !== 'win32';
  return [
    makeItem('AGENTS_MD', prefix.slice(0, -1), detectInstructions(dir, realRepositoryRoot)),
    makeItem('AGENTS_MD', `${prefix}.claude/CLAUDE.md`, detectClaudeDirInstructions(dir, realRepositoryRoot)),
    makeItem('AGENTS_MD', `${prefix}.claude/rules`, detectRuleDirectory(join(claudeDir, 'rules'), realRepositoryRoot)),
    makeItem('MCP_SERVER_CONFIG', `${prefix}.mcp.json`, detectMcpServers(dir, realRepositoryRoot, '.mcp.json')),
    claudeWalk ? makeItem('SKILLS', `${prefix}.claude/skills`, detectSkillDirectories(join(claudeDir, 'skills'), realRepositoryRoot)) : null,
    claudeWalk ? makeItem('SUBAGENTS', `${prefix}.claude/agents`, detectMarkdownDirectory(join(claudeDir, 'agents'), realRepositoryRoot)) : null,
    claudeWalk ? makeItem('COMMANDS', `${prefix}.claude/commands`, detectMarkdownDirectory(join(claudeDir, 'commands'), realRepositoryRoot)) : null,
    claudeWalk ? makeItem('COMMANDS', `${prefix}.claude/workflows`, detectWorkflowScripts(join(claudeDir, 'workflows'), realRepositoryRoot)) : null, // F1.866
    claudeLocalSettings
      ? makeItem('CONFIG', `${prefix}.claude/settings.local.json`, detectPresence(dir, realRepositoryRoot, join('.claude', 'settings.local.json'), 'settings.local.json'))
      : null,
    ...detectCodexProjectLayer(dir, realRepositoryRoot, prefix),
  ].filter(isItem);
}

/*
 * F1.847 — the layers claude reads ABOVE a repository root, and from the parents of
 * a folder that is in no repository: past the end of F1.844's walk.
 *
 * Measured on the vendored 2.1.267 (`work/wjcritqq/`, the F1.844 rig, the selected
 * folder empty): with `P/proj` selected and `P` in no repository, claude before this
 * plan loaded `P`'s CLAUDE.md, CLAUDE.local.md, `.claude/CLAUDE.md`, `.claude/rules`
 * (nested too), `.claude/skills`, `.claude/agents` and `.claude/commands` and started
 * `P/.mcp.json`'s server; with `Q/R/packages/app` selected and `Q/R` a repository, it
 * loaded `Q`'s CLAUDE.md, CLAUDE.local.md, `.claude/CLAUDE.md` and `.claude/rules` and
 * started `Q/.mcp.json`'s server, but none of `Q`'s skills, agents or commands. The
 * pages agree: memory.md#how-claude-md-files-load, "Claude Code loads `CLAUDE.md` and
 * `CLAUDE.local.md` from your current working directory and every directory above it";
 * skills.md#discovery-from-parent-and-nested-directories, skills from "every parent
 * directory up to the repository root". In the binary the skills, agents and commands
 * walk (`getProjectDirsUpToHome`) ends at the repository root and, outside one, stops
 * before it pushes the home directory — and runs to the filesystem root for a folder
 * outside the home directory. Since F1.768 a folder nobody decided about gets
 * `['user']` and none of it loads (measured), while this report named none of it,
 * so the folder previewed empty and the re-prompt gate never asked. Trusted, all of
 * it loads again (measured), so the fix is the question, never the trust.
 *
 * What is read, per directory, nearest first: above the repository root, when the
 * folder is in one (the host's `.git` walk, as in F1.844, the repository root itself
 * selected included), the CLAUDE.md chain (CLAUDE.md and CLAUDE.local.md — not
 * AGENTS.md: measured, claude 2.1.267 did not read a parent's AGENTS.md, and codex
 * reads no parent there), `.claude/CLAUDE.md`, `.claude/rules` and `.mcp.json`
 * (server slugs only); outside any repository, from the folder's parent, the same
 * plus `.claude/skills`, `.claude/agents` and `.claude/commands`. Nothing codex or Pi
 * reads (F1.844's measurement: neither reads a parent there), and neither settings
 * file (outside a repository both are read from the working directory — measured,
 * the parent's local hook did not run). Each directory's reads are realpath-contained
 * in that directory; labels are relative to the folder (`..`, `../../../.mcp.json`).
 *
 * Where the walk stops: for a folder at or under the home directory, just below it;
 * otherwise at the filesystem root, inclusive. The home directory's own level
 * (`~/CLAUDE.md`, `~/.claude/*`, `~/.mcp.json`) and everything above it are NOT
 * reported, although claude reads them — measured with HOME set to the parent, its
 * CLAUDE.md, CLAUDE.local.md, `.claude/CLAUDE.md`, `.claude/rules` and `.mcp.json`
 * loaded as project layers before this plan and not at all for a folder nobody
 * decided about — because that is the user's personal Claude Code setup and naming
 * it would ask about every project for anyone who has one; since F1.768 it reaches a
 * Nessy claude session only in a trusted project (a controller's posture call, F1.847).
 */
import { dirname, parse, relative } from 'node:path';

/**
 * claude's trust-gated layers in the directories above `realRoot` (already
 * realpathed) that {@link detectRepositoryAncestorLayers} does not walk, nearest
 * first: above its repository root when it is in one, from its parent otherwise; up
 * to the home directory (exclusive) for a folder at or under it, to the filesystem
 * root otherwise. `home` is a seam for the home-directory stop.
 */
export function detectClaudeParentLayers(realRoot: string, home: string = homedir()): ProjectContributionItem[] {
  const repositoryRoot = outputStyleProjectRootFor(realRoot);
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // Unresolvable: compared as spelled.
  }
  const underHome = realRoot === realHome || realRoot.startsWith(realHome + sep);
  const start = repositoryRoot ?? realRoot;
  let prefix = relative(start, realRoot).split(sep).filter(Boolean).map(() => '../').join('');
  const items: ProjectContributionItem[] = [];
  let dir = start;
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    prefix += '../';
    if (underHome && !dir.startsWith(realHome + sep)) break;
    items.push(...detectClaudeParentLayer(dir, prefix, repositoryRoot === undefined));
  }
  return items;
}

/** One parent directory's claude rows, labelled relative to the selected folder. */
function detectClaudeParentLayer(dir: string, prefix: string, outsideRepository: boolean): ProjectContributionItem[] {
  // Contained in `dir` itself; a filesystem root drops its trailing separator so the
  // shared `insideRealRoot` prefix test (`<root> + sep`) still matches beneath it.
  const containment = dir === parse(dir).root ? dir.slice(0, -1) : dir;
  const claudeDir = join(dir, '.claude');
  const chain = detectInstructions(dir, containment).filter(name => name === 'CLAUDE.md' || name === 'CLAUDE.local.md');
  return [
    makeItem('AGENTS_MD', prefix.slice(0, -1), chain),
    makeItem('AGENTS_MD', `${prefix}.claude/CLAUDE.md`, detectClaudeDirInstructions(dir, containment)),
    makeItem('AGENTS_MD', `${prefix}.claude/rules`, detectRuleDirectory(join(claudeDir, 'rules'), containment)),
    makeItem('MCP_SERVER_CONFIG', `${prefix}.mcp.json`, detectMcpServers(dir, containment, '.mcp.json')),
    outsideRepository ? makeItem('SKILLS', `${prefix}.claude/skills`, detectSkillDirectories(join(claudeDir, 'skills'), containment)) : null,
    outsideRepository ? makeItem('SUBAGENTS', `${prefix}.claude/agents`, detectMarkdownDirectory(join(claudeDir, 'agents'), containment)) : null,
    outsideRepository ? makeItem('COMMANDS', `${prefix}.claude/commands`, detectMarkdownDirectory(join(claudeDir, 'commands'), containment)) : null,
  ].filter(isItem);
}

/*
 * F1.809 — the one thing trust starts that no file in the folder names: on Pi, the
 * host provisions every enabled plugin language server, plus the post-edit checks,
 * ONLY for a trusted project (`isPiLspProvisioningAllowed` in `SessionManager.ts`).
 * An ordinary code folder carries none of the files above, so since D1.223 it was
 * never asked about and the language server could never start there.
 *
 * Owner decision 2026-09-26, option A (decisions analysis, F1.809): the report
 * counts that launch as a contribution. Neither runtime has a mechanism to adopt:
 * claude's SDK has no LSP seam (`PLUGIN_LSP_SUPPORT`), codex ships none, and Pi's
 * own trust (`docs/security.md`) covers its resources only. The input is the
 * capability view the session path itself iterates (`toAgentRuntime(...)
 * .lspServers`), so the dialog names exactly the servers that would start — the
 * resolver already withholds them for a session on a runtime that runs none.
 *
 * Residues, stated: a report asked for a folder with no session (the trust
 * dialog's and the sources panel's refs — the chat's gate names its chat since
 * F1.1133, so a Claude or codex chat is no longer asked) cannot know the runtime,
 * so it names the servers for "Pi sessions"; the host starts every enabled server
 * whatever the project's file extensions, so no extension filter is applied here;
 * and a folder whose only consequence would be the post-edit checks (a
 * `tsconfig.json`, no enabled language server) is not counted — whether those
 * markers count is the owner's open word, recorded with the row.
 */
import type { RuntimeLspRegistration } from './resolver.ts';

/** The language servers trusting this folder would start on Pi, or `null` when none. */
export function piLanguageServerContribution(
  lspServers: readonly Pick<RuntimeLspRegistration, 'lspId'>[],
): ProjectContributionItem | null {
  return makeItem('LANGUAGE_SERVERS', 'enabled plugins, Pi sessions', lspServers.map(server => server.lspId));
}

/*
 * F1.849 — the MAIN checkout's layers claude reads from a LINKED git worktree.
 *
 * Measured on the vendored 2.1.274 (`work/bk-2/f1849-worktree-probe.ts`, the
 * F1.844 rig on a real `git worktree add`, the main checkout's `.claude/`
 * gitignored and populated): before this plan the worktree session ran the main
 * checkout's `.claude/settings.local.json` hook and loaded its `.claude/agents` and
 * `.claude/commands`; for a worktree nobody decided about it loads none of them
 * now (`['user']`, F1.768); trusted, all of them load again — while this report
 * named none of them, so the worktree previewed empty and was never asked about.
 * worktrees.md#what-worktrees-share-with-the-main-checkout says so too: approvals
 * are saved to "the main checkout's `.claude/settings.local.json`", and "when the
 * worktree checkout has no `.claude/skills` directory at its root ... Claude Code
 * loads the main checkout's project skills ... The same read-through covers
 * `.claude/agents` and `.claude/commands`. For skills, the read-through requires
 * Claude Code v2.1.277 or later." Measured per directory: a worktree with its own
 * `.claude/agents` kept that copy alone and still loaded the main checkout's
 * commands. Trust stays per directory (`resolveLinkedWorktreeMainCheckoutPath`'s
 * docblock), so the fix is the question, never inherited trust.
 *
 * What is read: in the main checkout's root, `.claude/agents` and
 * `.claude/commands` when the worktree root has no directory of that name, and
 * `.claude/settings.local.json` except where settings.md keeps it with the
 * worktree (a home-directory main checkout, Windows). Labels are relative to the
 * selected folder (`../main/.claude/commands`), reads contained in the main
 * checkout. The main checkout is the one `resolveLinkedWorktreeMainCheckoutPath`
 * accepts — git's own back-link, so a hand-written `.git` file reads nothing.
 *
 * Residues, stated: the main checkout's skills (v2.1.277+, above the vendored
 * 2.1.274 — measured not loaded) are not named until the SDK lift; the worktree's
 * own `settings.local.json`, which claude does not read in a worktree, is still
 * named by the root report and F1.844's walk (the safe direction); codex's
 * main-checkout reads are not modelled (see F1.844's residues).
 */
import { resolveLinkedWorktreeMainCheckoutPath } from '../projects/project-identity.ts';

/**
 * The main checkout's claude layers a linked-worktree session reads, for a folder
 * (already realpathed) inside such a worktree; `[]` everywhere else.
 */
export function detectLinkedWorktreeMainCheckoutLayers(realRoot: string, home: string = homedir()): ProjectContributionItem[] {
  const worktreeRoot = outputStyleProjectRootFor(realRoot);
  if (!worktreeRoot) return [];
  const mainCheckout = resolveLinkedWorktreeMainCheckoutPath(worktreeRoot);
  if (!mainCheckout || mainCheckout === worktreeRoot) return [];
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // Unresolvable: compared as spelled.
  }
  const prefix = `${relative(realRoot, mainCheckout).split(sep).join('/')}/`;
  const ownDir = (name: string) => existsSync(join(worktreeRoot, '.claude', name));
  const claudeDir = join(mainCheckout, '.claude');
  const localSettings = mainCheckout !== realHome && process.platform !== 'win32';
  return [
    ownDir('agents') ? null : makeItem('SUBAGENTS', `${prefix}.claude/agents`, detectMarkdownDirectory(join(claudeDir, 'agents'), mainCheckout)),
    ownDir('commands') ? null : makeItem('COMMANDS', `${prefix}.claude/commands`, detectMarkdownDirectory(join(claudeDir, 'commands'), mainCheckout)),
    localSettings
      ? makeItem('CONFIG', `${prefix}.claude/settings.local.json`, detectPresence(mainCheckout, mainCheckout, join('.claude', 'settings.local.json'), 'settings.local.json'))
      : null,
  ].filter(isItem);
}

/**
 * F1.846 — the MCP server names a project `.codex/config.toml` declares, from its
 * `[mcp_servers.<name>]` table headers: names only, never a command, URL or env
 * (the sub-tables `[mcp_servers.<name>.env]` do not match). A bounded read of a
 * regular file inside the root, like {@link detectMcpServers}; no TOML parser,
 * so the inline-table spelling (`mcp_servers = { … }`) is not named — the
 * `config.toml` presence row still raises the prompt for it. The root layer
 * only; an ancestor's `.codex/config.toml` keeps its presence row alone.
 */
const CODEX_MCP_TABLE_HEADER = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/;

function detectCodexMcpServers(root: string, realRoot: string): string[] {
  const configPath = join(root, '.codex', 'config.toml');
  if (!existsSync(configPath) || !insideRealRoot(configPath, realRoot)) return [];
  let text: string;
  try {
    const stat = statSync(configPath);
    if (!stat.isFile() || stat.size > MAX_MCP_CONFIG_BYTES) return [];
    text = readFileSync(configPath, 'utf-8');
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = CODEX_MCP_TABLE_HEADER.exec(line);
    const name = match?.[1] ?? match?.[2] ?? match?.[3];
    if (name) names.push(name);
  }
  return names;
}

/**
 * F1.866 (origin WJ-crit-qq P-1) — the saved claude workflows directly inside `dir`, by name (sans `.js`).
 *
 * workflows.md#save-the-workflow-for-reuse: a saved workflow is a `.js` script in `.claude/workflows/` ("edit its
 * `.js` file") that "runs as `/<name>` in future sessions", and "Project workflows also load from every
 * `.claude/workflows/` along that path" — the working directory up to the repository root, the walk
 * {@link detectRepositoryAncestorLayers} reads. Claude loads it with the `project` setting source, which this host
 * passes only for a trusted project, so it is a COMMANDS contribution like `.claude/commands`.
 *
 * MEASURED and left out, with what was found: `.claude/routines`. routines.md names no project routines folder (it
 * describes cloud agents created through `/schedule`), and the vendored 2.1.274 binary names
 * `.claude/routines` only in its sandbox protected-path list beside `.claude/workflows`, in a config-directory list,
 * and as excluded runtime state under `.claude/routines/.state/` — no loader reading project routines was found.
 * `.claude/output-styles` is F1.846's (above). Residue: the main-checkout walk of a linked worktree and the
 * layers above a repository read commands and agents only; a workflow there is not reported.
 */
function detectWorkflowScripts(dir: string, realRoot: string): string[] {
  const names: string[] = [];
  for (const entry of readEntriesSafe(dir)) {
    if (!entry.isFile() || !isSafeName(entry.name) || !/\.js$/i.test(entry.name)) continue;
    if (!insideRealRoot(join(dir, entry.name), realRoot)) continue;
    names.push(entry.name.replace(/\.js$/i, ''));
  }
  return names;
}
