import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import {
  MEMORY_LOAD_LINE_LIMIT,
  memoryIndexLoadedContent,
  stampMemoryModified,
} from '@nessy-agent/session-tools-core';
import { CONFIG_DIR, getAutoMemoryDirectory, getMemoryEnabled } from '../../config/storage.ts';
import { getSessionDataPath } from '../../sessions/storage.ts';
import { discoverRuleFiles } from './rule-discovery.ts';
import type { SessionMemoryScope } from './session-memory-scope.ts';
import {
  expandMemoryImports,
  resolveMemoryImportPath,
  stripBlockHtmlComments,
} from './memory-imports.ts';

export const MEMORY_FILE_NAME = 'MEMORY.md';

/**
 * The auto-memory index contract MOVED to
 * `@nessy-agent/session-tools-core/memory-index.ts` and is re-exported here so
 * every existing importer is unchanged.
 *
 * It had to move, and only one direction was legal: the model-facing writer is
 * `session-tools-core`'s `remember` handler, that package has NO dependency on
 * `@nessy-agent/shared`, and `memory.md:386` requires the write to be measured
 * against the same limits the load applies. A second copy of the caps in the
 * leaf package is exactly the "keep in sync" drift the auto-memory marker
 * constant already demonstrates below.
 *
 * Only the names this module already published are re-exported; the rest of the
 * contract (the measurement, the two message builders, the frontmatter strip)
 * is imported from `@nessy-agent/session-tools-core` at the point of use.
 */
export {
  capMemoryIndexLoad,
  MEMORY_LOAD_BYTE_LIMIT,
  MEMORY_LOAD_LINE_LIMIT,
} from '@nessy-agent/session-tools-core';

export const MEMORY_RULES_DIR = join('.agents', 'rules');

/**
 * How many import hops a memory file may chain.
 *
 * `memory.md:97` — "Both relative and absolute paths are allowed. Relative paths
 * resolve relative to the file containing the import, not the working directory.
 * Imported files can recursively import other files, with a maximum depth of
 * four hops." The root file is depth 0, so a file reached at depth 4 is the
 * fourth hop and is loaded; its own imports are not followed.
 */
export const MEMORY_IMPORT_DEPTH_LIMIT = 4;

export function getMemoryFilePathFromDataPath(dataPath: string): string {
  return join(dataPath, MEMORY_FILE_NAME);
}

export function getProjectMemoryFilePath(workingDirectory: string): string {
  return join(workingDirectory, MEMORY_FILE_NAME);
}

/**
 * The directory the USER-scope memory index lives in — `CONFIG_DIR`, or the
 * operator's own `autoMemoryDirectory` when one is set (P6.390(2)).
 *
 * A config that cannot be read decides nothing: `getAutoMemoryDirectory` reads
 * the stored config, which throws on an unsupported storage layout, and a memory
 * load must not fail because of it. The catch falls back to the fixed path,
 * which is where the file already is.
 */
export function getUserMemoryRoot(): string {
  try {
    return getAutoMemoryDirectory() ?? CONFIG_DIR;
  } catch {
    return CONFIG_DIR;
  }
}

/**
 * An EXPLICIT `configDir` still wins, unchanged: that is this function's
 * existing contract and the two callers that pass one (the RPC handler and the
 * cleanup pass) are naming a directory on purpose.
 */
export function getUserMemoryFilePath(configDir?: string): string {
  return join(configDir ?? getUserMemoryRoot(), MEMORY_FILE_NAME);
}

export function getSessionMemoryFilePath(workspaceId: string, sessionId: string): string {
  return getMemoryFilePathFromDataPath(getSessionDataPath(workspaceId, sessionId));
}

/**
 * The documented ceiling above which a whole instruction or memory file is
 * SKIPPED rather than loaded in part (P6.389).
 *
 * `memory.md`, verbatim, fetched 2026-09-06: *"This limit applies only to
 * `MEMORY.md`. Claude Code loads a CLAUDE.md file of up to 4 MiB in full and
 * skips a larger file. Shorter files produce better adherence."* — and again in
 * §*Keep memory files short*: *"Claude Code skips a file over 4 MiB."*
 *
 * ## DOC DRIFT, corrected here rather than left standing
 *
 * The docblock below used to quote this same paragraph as *"CLAUDE.md files are
 * loaded in full regardless of length, though shorter files produce better
 * adherence"* and cited it as the reason there could be NO byte bound at all.
 * That sentence is gone from the page. The paragraph in its place says the
 * opposite thing about the same file family: there is a bound, it is 4 MiB, and
 * crossing it means SKIP, not truncate. So the reason we had for having no
 * limit was retired by the page, and the quote is re-fetched rather than
 * re-typed.
 *
 * MiB, not MB: the page's own unit. 4 * 1024 * 1024.
 */
export const INSTRUCTION_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Whether this file is over {@link INSTRUCTION_FILE_MAX_BYTES} and must be
 * skipped whole.
 *
 * Measured with `statSync`, never by reading: the whole point of the skip is
 * that a 4 MiB file never enters memory, and a predicate that read the file to
 * decide would defeat the bound it enforces. A file that cannot be stat'd is
 * NOT over the limit — "could not look" is not "looked and found it too big",
 * and the readers below already handle a missing file.
 */
export function instructionFileOverSizeLimit(filePath: string): boolean {
  try {
    return statSync(filePath).size > INSTRUCTION_FILE_MAX_BYTES;
  } catch {
    return false;
  }
}

/**
 * Line-capped read with the documented byte SKIP in front of it.
 *
 * The line cap stays line-only for the reason it always had: this is not the
 * index-load seam ({@link memoryIndexLoadedContent} is, with its cap half
 * `capMemoryIndexLoad`), and two callers must not see a byte cap that
 * TRUNCATES — the `@import` discovery scan in `capabilities/native-sources.ts`
 * (a byte cut there changes which files become `memory` capability RECORDS,
 * hence the snapshot generation, hence the Sources surface) and the rule-file
 * reader below.
 *
 * The 4 MiB rule is a different rule and does not conflict with either: it is
 * all-or-nothing. A file over it contributes NOTHING, so no caller gets a
 * partial body and no record is built from half a file — which is exactly the
 * distinction P6.389 exists to draw. See {@link INSTRUCTION_FILE_MAX_BYTES} for
 * the sentence, and for the sentence it replaced.
 */
export function readMemoryFile(filePath: string, maxLines = MEMORY_LOAD_LINE_LIMIT): string {
  if (!existsSync(filePath)) return '';
  if (instructionFileOverSizeLimit(filePath)) return '';
  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/).slice(0, maxLines);
  return lines.join('\n').trim();
}

/**
 * Whether a `view.memory` capability layer IS the auto-memory index — the only
 * file the 200-line / 25 KB caps are spelled for.
 *
 * Three exclusions, each doc-backed:
 * - `format === 'rule'` — a `.agents/rules` / `.claude/rules` file. `memory.md:390`
 *   scopes the cap to `MEMORY.md`; a rule body has its own path-scoped load
 *   semantics and must not be truncated here.
 * - an IMPORTED layer (`importParentPath` set) — a topic file pulled in by an
 *   `@path` line. The caps are the index's budget, not each topic file's.
 * - anything not named `MEMORY.md`. Redundant with the two above for every
 *   entry point that exists today (`native-sources.ts` registers non-rule memory
 *   roots only at the four `MEMORY.md` paths), and kept so a future entry point
 *   cannot inherit the cap by accident.
 *
 * A layer with no `absolutePath` is not an index — every production memory layer
 * is a `NativeResourceRef` and carries one, so the guard exists so this predicate
 * can never be the thing that throws on a turn.
 */
export function isMemoryIndexLayer(layer: {
  format?: 'rule';
  importParentPath?: string;
  resource: { absolutePath?: string };
}): boolean {
  if (layer.format === 'rule' || layer.importParentPath !== undefined) return false;
  const absolutePath = layer.resource.absolutePath;
  return typeof absolutePath === 'string' && absolutePath.length > 0
    && basename(absolutePath) === MEMORY_FILE_NAME;
}

interface MemoryImportState {
  depth: number;
  seen: Set<string>;
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * The FALLBACK composer's expander — see {@link loadMemoryPromptBlock} for what
 * "fallback" means here and why it is kept.
 *
 * It shares ONE recogniser with the two live deliveries
 * (`scanMemoryImports` / `expandMemoryImports` in `memory-imports.ts`) and one
 * rendering rule, so a file cannot mean different things on the two routes. The
 * only difference is where an import's body comes from: this route has no
 * capability view, so it reads the target from disk directly, bounded by
 * {@link MEMORY_IMPORT_DEPTH_LIMIT} and by the `seen` set.
 */
function readMemoryFileWithImports(
  filePath: string,
  options: { maxLines?: number; applyIndexLimits?: boolean } = {},
  state: MemoryImportState = { depth: 0, seen: new Set<string>() },
): string {
  if (!existsSync(filePath)) return '';

  const resolvedFilePath = resolve(filePath);
  if (state.seen.has(resolvedFilePath)) return '';
  state.seen.add(resolvedFilePath);

  const maxLines = options.maxLines ?? MEMORY_LOAD_LINE_LIMIT;
  // YAML frontmatter and block-level HTML comments come off BEFORE the caps are
  // measured (`memory.md:388`), and the caps are measured BEFORE expansion — the
  // byte cap applies to the INDEX only and to the file as written, so an import
  // past the cut is not followed and an imported topic file is not charged to
  // the index's budget. `applyIndexLimits` is deliberately not threaded into the
  // recursion.
  //
  // The FRONTMATTER strip rides `applyIndexLimits` and nothing else, for the
  // same reason the caps do: this function also reads `.agents/rules` files
  // (`loadUnscopedRuleMemories` below), whose `paths:` globs live in
  // frontmatter. Stripping it there would turn every path-scoped rule into an
  // unconditional one.
  const file = readMemoryFile(resolvedFilePath, maxLines);
  const raw = options.applyIndexLimits
    ? memoryIndexLoadedContent(file, maxLines)
    : stripBlockHtmlComments(file);
  if (!raw || state.depth >= MEMORY_IMPORT_DEPTH_LIMIT) return raw;

  return expandMemoryImports(raw, resolvedFilePath, (importerFilePath, token) => {
    const target = resolveMemoryImportPath(importerFilePath, token.path);
    try {
      if (!statSync(target).isFile()) return null;
    } catch {
      return null;
    }
    const body = readMemoryFileWithImports(target, { maxLines }, {
      depth: state.depth + 1,
      seen: state.seen,
    });
    return body ? { path: target, body } : null;
  }).trim();
}

function formatMemoryFile(existing: string, memory: string): string {
  const trimmed = memory.trim();
  if (!trimmed) return existing;
  const entry = `- ${trimmed.replace(/\r?\n/g, '\n  ')}`;
  if (!existing.trim()) {
    return `# Memory\n\n${entry}\n`;
  }
  return `${existing.trimEnd()}\n\n${entry}\n`;
}

/**
 * The UI/RPC writer (Save-to-memory), the sibling of `session-tools-core`'s
 * model-facing `remember` handler.
 *
 * It STAMPS but does not MEASURE, and both halves are decisions:
 * - stamp, because `memory.md:398` binds the file format rather than the caller
 *   ("Any file that has frontmatter gets the field the next time Claude writes
 *   it"), and a file whose timestamp depended on which of the two writers
 *   touched it would be worse than no timestamp at all. The doc's negative half
 *   still holds: `formatMemoryFile` seeds a new file as `# Memory`, and
 *   `stampMemoryModified` never synthesizes a block.
 * - do not measure, because `errors.md:1551` puts the over-limit signal in front
 *   of the MODEL — "Claude Code delivers the error to Claude after the write
 *   rather than printing it as a banner in your terminal". Surfacing it here
 *   would need a new field on `MemoryAppendResult`, which is an RPC/IPC wire
 *   change and a risk trigger; no doc sentence asks for it.
 */
export function appendMemoryFile(filePath: string, memory: string): void {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  const formatted = formatMemoryFile(existing, memory);
  // Stamp AFTER the no-op guard, never before: `formatMemoryFile` returns its
  // input unchanged for an empty `memory`, and stamping first would rewrite the
  // file with a fresh timestamp for no recorded fact.
  if (formatted === existing) return;
  const next = stampMemoryModified(formatted);

  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, next, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tempPath, filePath);
  chmodSync(filePath, 0o600);
}

export function getMemoryFileMode(filePath: string): number | null {
  if (!existsSync(filePath)) return null;
  return statSync(filePath).mode & 0o777;
}

export function formatMemoryPromptBlock(memory: string): string {
  const trimmed = memory.trim();
  return trimmed ? `\n\n<memory>\n${trimmed}\n</memory>` : '';
}

function isMemoryEnabled(): boolean {
  try {
    return getMemoryEnabled();
  } catch {
    return true;
  }
}

/**
 * **PRODUCT POSTURE, owner decision 2026-09-11 (QL4): this host will not build
 * background distillation of finished chats, on any runtime.**
 *
 * Written here because this is the file a lane would edit to build it — the
 * host's own memory store, whose every entry today exists because the MODEL
 * called a tool, marked as such by {@link AUTO_MEMORY_MARKER_REGEX_SOURCE}
 * below.
 *
 * The refusal is a posture, not a capability gap, and the reason is the whole
 * of it: **a finished chat must not become a durable model input with no user
 * action.** Distillation reads a transcript the user has stopped watching,
 * decides by itself what is worth keeping, and writes it where every later
 * session loads it — three steps, none of which the user asked for, on content
 * they may never have expected to outlive the chat. The controls that make
 * memory arguable today all sit on the near side of that line: the per-chat
 * memory scope (`session-memory-scope.ts`), the global switch (`getMemoryEnabled`),
 * and the fact that a memory exists because a tool call created it, in view,
 * during a turn.
 *
 * What is NOT refused, so the line is legible: the model-invoked `remember`
 * path stays; each runtime's OWN memory mechanism stays the runtime's business
 * (claude's auto memory is the SDK's and is on unless our switch closes it —
 * see `claude-auto-memory.ts`); and the refusal is revisitable by the owner,
 * not by a lane, because it is a product decision rather than a technical one.
 *
 * Codex's native equivalent was measured rather than assumed — it exists in
 * full (a twelve-field `[memories]` table at `rust-v0.150.1`, stage `stable`,
 * `defaultEnabled: false`) and what it costs us to open is written down in
 * `docs/superpowers/specs/2026-09-11-codex-durable-home-price.md`.
 */

/**
 * Machine marker the agent-facing `remember` tool appends to entries it writes
 * (`packages/session-tools-core/src/handlers/remember.ts` — keep the format in
 * sync). It is stripped at load BEFORE dedup so marked/unmarked duplicates
 * still collapse and the marker never reaches the prompt. The scheduled
 * cleanup pass (`memory-cleanup.ts`) rewrites ONLY marked entries.
 */
export const AUTO_MEMORY_MARKER_REGEX_SOURCE = '<!-- nessy:auto:(\\d{4}-\\d{2}-\\d{2}) -->';

export function stripAutoMemoryMarkers(text: string): string {
  return text.replace(new RegExp(`[ \\t]*${AUTO_MEMORY_MARKER_REGEX_SOURCE}`, 'g'), '');
}

function mergeMemoryContents(memories: string[]): string {
  const seenLines = new Set<string>();
  const mergedLines: string[] = [];

  for (const memory of memories) {
    for (const line of memory.split(/\r?\n/)) {
      // Strip auto-memory markers before dedup so a marked entry and its
      // unmarked (human) duplicate collapse to one prompt line.
      const stripped = stripAutoMemoryMarkers(line);
      const normalized = stripped.trim();
      if (!normalized || normalized.toLowerCase() === '# memory') continue;
      if (seenLines.has(normalized)) continue;
      seenLines.add(normalized);
      mergedLines.push(stripped);
    }
  }

  return mergedLines.join('\n');
}

export interface ParsedRule {
  patterns: string[];
  body: string;
  /**
   * Did the file WRITE a `paths` key (any of its four spellings)?
   *
   * P2.185 — the distinction every member of the empty-means-absent family
   * loses, kept here because this is the only layer that can still see it. An
   * ABSENT `paths` and an authored-but-EMPTY one both leave `patterns` at zero
   * length, and `patterns.length === 0` is the readers' test for "unscoped",
   * so the fumbled list used to inherit the widest state there is (measured:
   * `paths: ,` selected 5321 of 5321 tracked files, byte-identical to omitting
   * the key). `memory.md` grants the unconditional load to the absent field
   * alone — "Rules WITHOUT a `paths` field are loaded unconditionally and apply
   * to all files" (fetched 2026-08-26) — and says nothing about an empty one,
   * so reading the empty one as unconditional was an inference, not the page.
   */
  pathsDeclared: boolean;
}

/**
 * Split a `paths` frontmatter value on the commas that SEPARATE patterns, and
 * only those.
 *
 * P2.150 — the shape-sibling of the tool-grant tokenizer `53007d740` fixed: a
 * delimiter scan that ignores the structure of the thing it is scanning. The
 * whitespace half of that shape was never here (`src/my docs/**` always
 * survived intact, measured), but the comma half was, and a glob owns commas:
 *
 * - **The dominant direction is NARROWER, silently.** `src/**` + `/*.{ts,tsx}`
 *   became `src/**\/*.{ts` plus `tsx}`, and `compileRuleGlob` escapes an
 *   unbalanced brace, so the commonest multi-extension glob there is compiled
 *   to a regex matching no real file and the rule NEVER FIRED. The same split
 *   also made {@link import('./rule-matching.ts').expandRulePatterns}'s whole
 *   brace-alternation budget unreachable from this parser — in the inline form
 *   and the `- ` block form alike, no `{…,…}` group could ever reach it.
 * - **But it could also WIDEN, and that is why this is a defect rather than a
 *   cosmetic loss.** `53007d740`'s rule is that truncation must never widen.
 *   For an unterminated group the fragment after the comma is a pattern in its
 *   own right: `paths: docs/{a,**` yielded `**`, which matched EVERY file (30
 *   of 30 in the differential corpus) — a rule its author scoped to `docs/`
 *   fired on every read — and `paths: config/{dev,prod` yielded `prod`, which
 *   matched a root file the rule never named.
 *
 * So the scan tracks what a glob is allowed to contain and separates only at
 * the top level: `{…}` groups (nested, exactly as `splitAlternatives` already
 * assumes), `[…]` bracket expressions, `'`/`"` quoting and `\` escapes. Like
 * that tokenizer it decides only WHERE patterns separate and never edits a
 * pattern's characters. An unterminated `{` or `[` therefore keeps the rest of
 * the value as ONE pattern, which `compileRuleGlob` then refuses — matching
 * nothing, which is failing closed and is strictly narrower than the fragments
 * the old split handed it.
 *
 * The surrounding `[…]` of a YAML flow list is stripped only as a PAIR. The old
 * unpaired `^\[` strip mangled a value that legitimately begins with a bracket
 * expression (`[ab]/x.ts` became `ab]/x.ts`, a close with no open, which
 * `compileSegment` refuses).
 */
function splitPatternList(value: string): string[] {
  const trimmed = value.trim();
  const normalized = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!normalized) return [];

  const parts: string[] = [];
  let current = '';
  let brace = 0;
  let bracket = 0;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === '\\') {
      // The documented escape (`memory.md`: `photos \[2024/**`). Carried through
      // verbatim, pair intact, so an escaped comma is not a separator either.
      current += char + (normalized[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '{') brace += 1;
    else if (char === '}' && brace > 0) brace -= 1;
    else if (char === '[') bracket += 1;
    else if (char === ']' && bracket > 0) bracket -= 1;
    else if (char === ',' && brace === 0 && bracket === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);

  return parts.map(part => stripWrappingQuotes(part.trim())).filter(Boolean);
}

/**
 * Parse one rule file into its `paths` patterns and its body.
 *
 * A rule WITHOUT frontmatter — or with frontmatter that declares no `paths` —
 * is a valid unscoped rule, not a parse failure: `memory.md` says such a rule is
 * "loaded at launch with the same priority as `.claude/CLAUDE.md`" and applies
 * "unconditionally... to all files". Returning `null` for it, as this parser
 * used to, dropped every unscoped rule on the floor. `null` now means only
 * "there is no rule here" (empty body).
 *
 * `patterns.length === 0` is therefore the caller's test for "unscoped": those
 * rules join the pinned capability context at launch, while `paths:` rules wait
 * for a matching file read.
 *
 * An AUTHORED-but-empty `paths` is neither (P2.185). It reports
 * `pathsDeclared: true` with zero patterns, and {@link unscopedRuleBody}
 * withholds it from the launch block: the author wrote a scope and gave it the
 * empty set, so the rule is scoped to nothing and fires on nothing. That is the
 * same direction `memory.md` takes for every other `paths` value it cannot
 * honour — a budget-busting brace group's "literal braces match no files", an
 * unreadable bracket expression that "matches nothing, and the rule's other
 * patterns keep working" (fetched 2026-08-26) — and the direction `53007d740`
 * fixed the tool-grant tokenizer to: truncation must never widen.
 */
export function parseRuleFile(raw: string): ParsedRule | null {
  const normalized = raw.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  const endIndex = lines[0]?.trim() === '---'
    ? lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    : -1;

  if (endIndex === -1) {
    // No frontmatter block (absent, or opened and never closed): the whole file
    // is the body of an unscoped rule.
    const wholeBody = normalized.trim();
    return wholeBody ? { patterns: [], body: wholeBody, pathsDeclared: false } : null;
  }

  const patterns: string[] = [];
  let pathsDeclared = false;
  let collectingPaths = false;

  for (const line of lines.slice(1, endIndex)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (collectingPaths && trimmed.startsWith('-')) {
      patterns.push(...splitPatternList(trimmed.slice(1)));
      continue;
    }

    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) {
      collectingPaths = false;
      continue;
    }

    const key = match[1]!.toLowerCase();
    const value = match[2] ?? '';
    if (key === 'path' || key === 'paths' || key === 'glob' || key === 'globs') {
      // The KEY was written. Whether it yields any pattern is a separate
      // question, and `pathsDeclared` is the only place the two stay apart.
      pathsDeclared = true;
      patterns.push(...splitPatternList(value));
      collectingPaths = !value.trim();
    } else {
      collectingPaths = false;
    }
  }

  const body = lines.slice(endIndex + 1).join('\n').trim();
  if (!body) {
    return null;
  }

  return { patterns, body, pathsDeclared };
}

/**
 * The body of a rule that loads UNCONDITIONALLY at launch, or `undefined` when
 * the file declares `paths` (it fires per matching file read instead) or holds
 * no body at all. The single seam every launch-time composer uses, so "unscoped"
 * cannot drift between the pinned capability context and any other consumer.
 *
 * A DECLARED `paths` withholds the rule from this block whether or not it
 * yielded a pattern (P2.185). With patterns, the rule waits for a matching read;
 * with none, it waits for a read that can never match — and in neither case did
 * its author ask for the launch block. Reading it off `pathsDeclared` rather
 * than off `patterns.length` is the whole fix: those two used to be the same
 * test, and that is what made a fumbled list the widest rule in the workspace.
 */
export function unscopedRuleBody(raw: string): string | undefined {
  const parsed = parseRuleFile(raw);
  if (!parsed || parsed.pathsDeclared) return undefined;
  return parsed.body;
}

/**
 * Legacy (pre-capability-runtime) memory prompt block: the UNSCOPED rules of
 * `<workspaceRoot>/.agents/rules`, discovered recursively.
 *
 * There is deliberately no path matching left here. A `paths` glob describes
 * the FILE the rule fires on, so it can only be evaluated at read time — the
 * old working-directory compile (`getWorkingDirectoryMatchPath` +
 * `parseMatchingRuleFile`), which matched those globs against `.` or
 * `packages/api` and therefore never fired, is gone. The live route is the
 * capability runtime: unscoped rules in the pinned block, `paths:` rules
 * through the pre-tool-use trigger. This block is only the fallback for turns
 * that run without that runtime.
 */
function loadUnscopedRuleMemories(workspaceRootPath?: string): string[] {
  if (!workspaceRootPath) return [];

  const rules: string[] = [];
  for (const file of discoverRuleFiles(join(workspaceRootPath, MEMORY_RULES_DIR))) {
    try {
      const body = unscopedRuleBody(readMemoryFileWithImports(file.path));
      if (body) rules.push(body);
    } catch {
      continue;
    }
  }
  return rules;
}

export interface LoadMemoryPromptBlockOptions {
  workingDirectory?: string;
  userConfigDir?: string;
  /** Immutable Workspace ID — required to resolve the ID-first session memory file. */
  workspaceId?: string;
  /**
   * Whether the project `workingDirectory` is explicitly trusted (W6). The
   * repository-owned project `MEMORY.md` is read only when true; user and
   * session memory (managed storage) always load. Defaults to fail-closed.
   */
  projectTrusted?: boolean;
  /**
   * P6.390(1) — this CHAT's resolved memory scope. When present its `read` axis
   * replaces the global switch for this call; when absent the global switch
   * decides, which is exactly today's behaviour for every caller that does not
   * pass one.
   *
   * Only the READ axis is consulted here: `write` governs whether the chat may
   * FEED memory, which is a tool grant rather than a load, and is enforced where
   * the `remember` tool is granted. Resolving both axes in one place and reading
   * one of them here is deliberate — a second resolver beside this one is the
   * drift this module's header warns about for the caps.
   */
  memoryScope?: SessionMemoryScope;
}

/**
 * The FALLBACK memory prompt block, for turns that run WITHOUT a capability
 * runtime.
 *
 * Its one production caller is `prompts/system.ts`, gated on
 * `capabilityContextPinned ? '' : loadMemoryPromptBlock(…)`, and both backends
 * pass `capabilityTurnRuntime !== null` for that flag — true on every normal
 * turn. So nothing here reaches a user on the shipping route; what does is
 * `BaseAgent.composePinnedCapabilityContext` and `materializePiContextResources`.
 *
 * R55 decision (2026-08-07): KEPT rather than deleted, and rewired onto the one
 * shared recogniser instead of being "fixed" in place. Deleting it means
 * deleting the no-capability-runtime fallback itself and changing
 * `getSystemPrompt`'s contract, which is a separate decision from import
 * recognition; leaving it on a second recogniser is the exact divergence this
 * unit exists to remove. It now shares `scanMemoryImports` /
 * `expandMemoryImports` / `stripBlockHtmlComments` and the same
 * comments → caps → expansion order with both live deliveries.
 */
export function loadMemoryPromptBlock(
  workspaceRootPath?: string,
  sessionId?: string,
  options: LoadMemoryPromptBlockOptions = {}
): string {
  // P6.390(1): the chat's own scope outranks the global switch in either
  // direction (`settings-reference.md#automemoryenabled` — the per-session
  // override "takes precedence over this key for one session, in either
  // direction"). No scope passed ⇒ the global switch alone, unchanged.
  if (!(options.memoryScope ? options.memoryScope.read : isMemoryEnabled())) return '';

  // `applyIndexLimits` on the three MEMORY.md reads and NOT on the rules:
  // `memory.md:390` scopes the caps to the index. The live route applies the
  // same helper at `BaseAgent.composePinnedCapabilityContext`, so this fallback
  // composer and the pinned block agree on what loads instead of being the only
  // place either cap is enforced.
  const memories = [
    options.projectTrusted && options.workingDirectory
      ? readMemoryFileWithImports(getProjectMemoryFilePath(options.workingDirectory), { applyIndexLimits: true })
      : '',
    ...loadUnscopedRuleMemories(workspaceRootPath),
    readMemoryFileWithImports(getUserMemoryFilePath(options.userConfigDir), { applyIndexLimits: true }),
    options.workspaceId && sessionId
      ? readMemoryFileWithImports(getSessionMemoryFilePath(options.workspaceId, sessionId), { applyIndexLimits: true })
      : '',
  ].filter(Boolean);

  return formatMemoryPromptBlock(mergeMemoryContents(memories));
}
