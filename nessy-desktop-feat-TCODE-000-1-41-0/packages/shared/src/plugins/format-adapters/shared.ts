/**
 * Format-adapter-agnostic string/record helpers (A4 extraction).
 *
 * These helpers have no Codex- or Claude-specific behavior: they read plain
 * string/array/record fields off an untyped external manifest object. Moved
 * out of the flat `format-adapters.ts` so per-ecosystem adapters
 * (`format-adapters/codex.ts`, and A5's `format-adapters/claude.ts`) and the
 * legacy Nessy-extension normalizer that remains in `format-adapters.ts` can
 * share one implementation instead of diverging copies.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import { readSkillInvocationControls } from '../../skills/storage.ts';
import { pluginDiagnostic } from '../schema.ts';
import type {
  NessyPluginManifest,
  PluginCapability,
  PluginCompatibilityReport,
  PluginDiagnostic,
} from '../types.ts';

export type UnknownRecord = Record<string, unknown>;

const IMPORTED_RUNTIME_KINDS = new Set<PluginCapability['kind']>([
  'agent',
  'command',
  'hook',
  'lsp',
  'monitor',
  'mcp',
]);

/** External manifests cannot self-authorize executable or network runtimes. */
export function requireImportedRuntimeTrust(capability: PluginCapability): PluginCapability {
  if (!IMPORTED_RUNTIME_KINDS.has(capability.kind)) return capability;
  const { trust: _untrusted, ...definition } = capability;
  return {
    ...definition,
    trust: {
      required: true,
      reason: 'Imported executable or network capability requires explicit trust.',
      executableHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    },
  } as PluginCapability;
}

/**
 * Retain declarations that lack a complete provider-neutral product consumer.
 * This helper is shared by direct adapter entrypoints and the outer native /
 * legacy normalization path so every public normalization API reports the same
 * honest runtime compatibility.
 */
export function deferUnavailablePluginSurfaces(
  manifest: NessyPluginManifest,
  inputDiagnostics: PluginDiagnostic[],
  inputCompatibility: PluginCompatibilityReport | undefined,
  adapterId: string,
): {
  value: NessyPluginManifest;
  diagnostics: PluginDiagnostic[];
  compatibility?: PluginCompatibilityReport;
} {
  const diagnostics = [...inputDiagnostics];
  const deferredEntries: PluginCompatibilityReport['deferred'] = [];
  const format = inputCompatibility?.format
    ?? (adapterId.includes('codex') ? 'codex' : adapterId.includes('claude') ? 'claude' : 'nessy');
  let changed = false;
  const capabilities = manifest.capabilities.map((capability): PluginCapability => {
    if (capability.kind !== 'command' && capability.kind !== 'asset') {
      return capability;
    }
    changed = true;
    const externalKind = capability.kind;
    const logicalName = capability.kind === 'command'
        ? capability.command.command
        : capability.asset.path;
    const reasonCode = `plugin.deferred.${format}_${externalKind}_runtime_unavailable`;
    const sourcePath = `${externalKind}.${logicalName}`;
    diagnostics.push(pluginDiagnostic(
      'warning',
      `plugin.format.${externalKind}_runtime_unavailable`,
      `${externalKind === 'command'
          ? 'Extension command'
          : 'Plugin asset'} "${logicalName}" is retained but unavailable until Nessy provides a complete product consumer for it.`,
      sourcePath,
      capability.kind === 'command' ? {
            kind: externalKind,
            command: capability.command.command,
            ...(capability.command.args ? { args: capability.command.args } : {}),
          } : {
            kind: externalKind,
            path: capability.asset.path,
            ...(capability.asset.mediaType ? { mediaType: capability.asset.mediaType } : {}),
          },
    ));
    deferredEntries.push({ externalKind, reasonCode, sourcePath });
    return {
      id: capability.id,
      kind: 'unsupported',
      ...(capability.displayName ? { displayName: capability.displayName } : {}),
      ...(capability.description ? { description: capability.description } : {}),
      unsupported: {
        externalKind,
        reasonCode,
        sourcePath,
        executable: capability.kind === 'command',
      },
    };
  });

  const compatibility = inputCompatibility && deferredEntries.length
    ? {
        ...inputCompatibility,
        state: inputCompatibility.state === 'blocked' ? 'blocked' as const : 'partial' as const,
        supportedKinds: inputCompatibility.supportedKinds.filter(kind => {
          const deferredKinds = new Set(deferredEntries.map(entry => entry.externalKind));
          if (!deferredKinds.has(kind)) return true;
          // Claude calls prompt-command support "command" in its external
          // vocabulary. Deferring an executable command must not erase that
          // independent, actually materialized prompt-command surface.
          return kind === 'command'
            && inputCompatibility.format === 'claude'
            && capabilities.some(capability => capability.kind === 'prompt-command');
        }),
        deferred: [
          ...inputCompatibility.deferred,
          ...deferredEntries.filter(entry => !inputCompatibility.deferred.some(existing => (
            existing.externalKind === entry.externalKind
            && existing.reasonCode === entry.reasonCode
            && existing.sourcePath === entry.sourcePath
          ))),
        ],
      }
    : inputCompatibility;
  const value = changed ? { ...manifest, capabilities } : manifest;
  if (changed && value.compatibility?.adapter) {
    value.compatibility = {
      ...value.compatibility,
      adapter: {
        ...value.compatibility.adapter,
        warnings: diagnostics.filter((diagnostic): diagnostic is PluginDiagnostic & { severity: 'warning' } => (
          diagnostic.severity === 'warning'
        )),
      },
    };
  }

  return {
    value,
    diagnostics,
    ...(compatibility ? { compatibility } : {}),
  };
}

export function stringField(record: UnknownRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The subset of a plugin skill's own `SKILL.md` frontmatter the runtime honours. */
export interface PluginSkillFrontmatter {
  description?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
  paths?: string[];
  /**
   * Frontmatter grant fields whose declared LIST was malformed — the refusal
   * channel {@link flattenFrontmatterValue} documents, on the skill path where
   * it did not exist (P2.149/F8, measured 2026-08-26).
   *
   * The flat map cannot carry a type, so a sequence with a non-string item keeps
   * its JSON text, and `flattenFrontmatterValue`'s own doc names the reader that
   * listens: `optionalToolList` routes a JSON-array-shaped value to
   * `optionalStringList`, which throws `Invalid <key>.tools[1]` and costs that
   * ONE agent definition. No skill reader listened. Measured end to end,
   * `allowed-tools: [Read, 1]` reached the capability as
   * `['Read', '1']` — a pre-approval for a tool literally NAMED "1" — and
   * `- Bash: true` as `['Read', '{"Bash":true}"]`. A grant nobody can read is
   * not a grant, and the author was told nothing.
   *
   * So the field is refused rather than degraded: {@link allowedTools} comes
   * back EMPTY, which is "declared and pre-approves nothing" (the distinction
   * `parseSkillToolList` keeps and `collectSkillToolGrants` contracts for), and
   * this list names the field so the caller can say so out loud.
   */
  malformedGrantFields?: string[];
}

/**
 * A flat frontmatter value that is the JSON form {@link flattenFrontmatterValue}
 * emits for a malformed sequence, rather than a list the author wrote.
 *
 * A YAML flow sequence (`[Read, Grep]`) is NOT this: it survives the splitter as
 * a raw scalar with bare words inside, which `JSON.parse` refuses. Only a
 * sequence that parsed AND carried a non-string item round-trips as valid JSON
 * whose items are not all non-empty strings — which is exactly the shape with no
 * honest tokenization.
 */
function isMalformedListValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  return Array.isArray(parsed)
    && !parsed.every(item => typeof item === 'string' && item.trim().length > 0);
}

/**
 * Read a bundled skill's declared metadata and invocation restrictions.
 *
 * The control field names come from `readSkillInvocationControls`, which is the
 * single reader of their accepted spellings — a second hand-rolled reader here
 * would be exactly the drift that export exists to prevent.
 *
 * `allowed-tools` USED to be dropped here, on the rationale that nothing
 * enforced it. R17b made it a real grant, which turned that rationale inside
 * out: an imported Claude plugin skill was enforced at invocation while the
 * capability view reported no restriction at all. It now travels, as does
 * `paths` (`skills.md:267`), which gates the same skill's automatic activation.
 *
 * Restrictions only, still. Nothing read here can widen what a skill may do —
 * these are the limits its own author wrote down.
 *
 * Lenient by contract: a file with no frontmatter, unreadable content or a
 * containment failure yields no metadata rather than dropping the skill.
 */
export async function readPluginSkillFrontmatter(
  rootDirectory: string,
  skillPath: string,
): Promise<PluginSkillFrontmatter> {
  const absolutePath = resolve(rootDirectory, skillPath);
  const containRoot = resolve(rootDirectory);
  if (absolutePath !== containRoot && !absolutePath.startsWith(containRoot + sep)) return {};
  let content: string;
  try {
    content = await readFile(absolutePath, 'utf-8');
  } catch {
    return {};
  }
  const { frontmatter } = splitMarkdownFrontmatter(content);
  const controls = readSkillInvocationControls(frontmatter);
  const description = stringField(frontmatter, 'description');
  // The one grant field this shape carries. `disallowed-tools` is NOT read here
  // and never has been, so there is no degraded deny to refuse.
  const malformedGrantFields = ['allowed-tools', 'allowedTools']
    .filter(field => isMalformedListValue(frontmatter[field]));
  return {
    ...(description ? { description } : {}),
    ...(controls.disableModelInvocation === undefined
      ? {}
      : { disableModelInvocation: controls.disableModelInvocation }),
    ...(controls.userInvocable === undefined ? {} : { userInvocable: controls.userInvocable }),
    // Refused, not degraded: an empty grant pre-approves nothing, which is the
    // fail-closed reading of a ceiling nobody could parse.
    ...(malformedGrantFields.length > 0
      ? { allowedTools: [], malformedGrantFields }
      : controls.allowedTools ? { allowedTools: controls.allowedTools } : {}),
    ...(controls.paths ? { paths: controls.paths } : {}),
  };
}

export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return entries.length > 0 ? entries : undefined;
}

/**
 * A hook's declared timeout, normalized to milliseconds.
 *
 * hooks.md § Common fields spells it `timeout`, in SECONDS, on every hook type.
 * Codex's own generated types spell the same field `timeoutSec`
 * (`packages/codex-protocol/generated/v2/HookMetadata.ts`), also seconds. Nessy's
 * native `nessy-plugin.json` spelling is `timeoutMs`, which round-trips through
 * `schema.ts`, so it is accepted here too and wins when both are present —
 * otherwise re-importing a normalized bundle would divide the value by 1000.
 *
 * A non-positive or non-finite value is no declaration at all: the caller
 * applies the documented default rather than spawning with a zero budget.
 */
export function readExternalHookTimeoutMs(record: UnknownRecord): number | undefined {
  const milliseconds = record.timeoutMs;
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds > 0) {
    return milliseconds;
  }
  const seconds = typeof record.timeout === 'number' ? record.timeout : record.timeoutSec;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }
  return undefined;
}

/** LSP routes only on exact, declared language ids; malformed arrays are unavailable. */
export function readRequiredUniqueStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const values = value.map(entry => typeof entry === 'string' ? entry.trim() : '');
  return values.some(value => !value) || new Set(values).size !== values.length ? undefined : values;
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value as UnknownRecord).every(entry => typeof entry === 'string');
}

/**
 * THE tokenizer for a TOOL-GRANT list field — re-exported, not defined here.
 *
 * It used to be defined in this module, because this module produces the string
 * its readers consume ({@link splitMarkdownFrontmatter} joins a YAML sequence on
 * `', '`) and because every reader already imported from here. The SIXTH reader
 * (`agents/definitions.ts`, a user's own hand-written `agents/*.md`) falsified
 * that: this module reaches `agents/definitions.ts` in five import hops, so the
 * edge would have been a cycle, and this module's 292-module closure would have
 * landed in a 7-module leaf that the Pi orchestrator imports directly.
 *
 * The one implementation therefore lives in a zero-import leaf all six readers
 * can share, `utils/tool-grant-list.ts`, which carries the contract and the
 * measurement. This re-export keeps readers 1-5 importing the name from here.
 */
export { splitToolGrantList } from '../../utils/tool-grant-list.ts';

export interface ParsedMarkdownFrontmatter {
  /** Raw frontmatter fields, keyed by their literal YAML-ish key (e.g. "argument-hint"). */
  frontmatter: Record<string, string>;
  body: string;
}

/** Only a literal top-level key is metadata; the shape predates the YAML reader. */
const FRONTMATTER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * A frontmatter fence: `---` at COLUMN 0, trailing whitespace tolerated.
 *
 * Used for BOTH fences, deliberately. An indented opener is not frontmatter
 * either, and accepting one while refusing an indented closer would leave a file
 * whose fences disagree about what column means.
 */
const FRONTMATTER_FENCE_PATTERN = /^---[ \t]*$/;

/**
 * Split `---\n...\n---` frontmatter into a flat `Record<string, string>` map and
 * the body.
 *
 * The map's values are STRINGS, and a sequence is a comma-joined one, because
 * that is what every agent format adapter, the Pi runtime materializer and the
 * skill/agent readers consume. Widening the value type would touch every one of
 * them; the fix below is the parser, not the shape.
 *
 * Two invariants the readers depend on and that survive here:
 *
 * - A nested mapping stays OPAQUE — the key is present with an empty value and
 *   its fields are never promoted. `modelConfig.model` must not silently become
 *   an agent's `model`, and `'hooks' in frontmatter` is the declaration test for
 *   a block that `parseSubagentFrontmatterHooks` / `parseSkillFrontmatterHooks`
 *   re-read from the raw file with a real YAML reader.
 * - A file with no leading `---` fence, or an unterminated one, has empty
 *   frontmatter and its full content as `body`.
 * - A fence is a fence only at COLUMN 0. Measured 2026-08-26 (P2.149/F7): the
 *   closer used to be `line.trim() === '---'`, so a `---` INSIDE a block scalar
 *   ended the frontmatter and every key after it was discarded — silently, into
 *   the body. On a real `description: |` whose text contains a horizontal rule
 *   that cost the file its `allowed-tools` AND its `disallowed-tools`, i.e. a
 *   deny that outranks `bypassPermissions` became model-visible prose. YAML
 *   cannot put a document marker there: a block scalar's content must be
 *   indented past its key, and a top-level key sits at column 0, so an indented
 *   `---` is always payload and never a terminator. Trailing whitespace is
 *   still allowed, because that is invisible to the author.
 *
 * **Why this used to be hand-rolled, and why it no longer is.** The scanner was
 * written as a deliberately small non-YAML reader, and it folded a block list
 * into a joined string by REFUSING the whole list whenever an item contained a
 * comma — "reject rather than misrepresent a complex scalar this intentionally
 * small parser cannot round-trip safely". The refusal wrote `''` and said
 * nothing. Measured on the signed 1.25.0 against the official `claude-security`
 * plugin, whose `allowed-tools:` block list contains
 * `Agent(claude-security:scan-inventory, claude-security:scan-researcher, …)`:
 * the twenty-entry ceiling was stored as no ceiling at all, while
 * `disable-model-invocation` from the same block survived. The premise was also
 * wrong — `parseSkillToolList` is paren-aware (`Bash(a,b)` is one rule), so the
 * joined string round-trips exactly the items the scanner was refusing.
 *
 * `js-yaml` now does the parse (it is already the reader on the invocation path,
 * `capabilities/runtime-skill-content.ts`). `JSON_SCHEMA` deliberately, not the
 * default: bundle frontmatter is untrusted input, and the JSON schema resolves
 * only null/bool/int/float/str — no timestamp type turning `version: 2024-01-01`
 * into a `Date`, and no room for a custom or `!!js/*` type. (js-yaml 4 dropped
 * the code-executing types from the package entirely, so this is depth, not the
 * only guard.) `json: true` keeps a duplicated key last-wins instead of throwing,
 * which is what the scanner did.
 *
 * The scanner survives as the FALLBACK for a document js-yaml rejects, and that
 * is not hypothetical: `description: Use when the user says "deploy": ship it`
 * is a real SKILL.md shape and js-yaml refuses the whole document for it. Being
 * lenient with malformed frontmatter is a documented contract here — a skill
 * loads with empty metadata rather than vanishing — so a throw must not cost the
 * file its other fields.
 */
export function splitMarkdownFrontmatter(content: string): ParsedMarkdownFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (!FRONTMATTER_FENCE_PATTERN.test(lines[0] ?? '')) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE_PATTERN.test(line));
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterLines = lines.slice(1, endIndex);
  const body = lines.slice(endIndex + 1).join('\n').trim();
  return { frontmatter: readFrontmatterBlock(frontmatterLines), body };
}

function readFrontmatterBlock(frontmatterLines: string[]): Record<string, string> {
  let document: unknown;
  try {
    document = loadYaml(frontmatterLines.join('\n'), { schema: JSON_SCHEMA, json: true });
  } catch {
    return scanFrontmatterBlock(frontmatterLines);
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return scanFrontmatterBlock(frontmatterLines);
  }
  const frontmatter: Record<string, string> = {};
  for (const [key, value] of Object.entries(document as UnknownRecord)) {
    // Also the guard that keeps `__proto__` out of a plain-object write.
    if (!FRONTMATTER_KEY_PATTERN.test(key)) continue;
    frontmatter[key] = flattenFrontmatterValue(value);
  }
  return frontmatter;
}

/**
 * One parsed YAML value in the flat map's string vocabulary.
 *
 * A sequence of STRINGS joins on `', '` — the delimiter `parseSkillToolList`,
 * `normalizePathPatterns` and the agent readers already tokenize. A top-level
 * mapping is the key with an empty value: present, opaque, never promoted.
 *
 * A sequence with any non-string item keeps its JSON form instead, and that is
 * the whole point of this function rather than an afterthought. The flat map
 * cannot carry a type, so a malformed list has exactly one channel left to
 * report itself through: its own text. The readers already listen on it —
 * `optionalToolList` routes a JSON-array-shaped value to `optionalStringList`,
 * whose per-entry check throws `Invalid <key>.tools[1]` and costs that ONE
 * definition (A1), which is the contract for `tools: ["Read", 1]`.
 *
 * Both halves of that were reachable before this parser was a YAML parser and
 * neither was after, because a scalar-ish flatten erases the type error two
 * different ways: `1` stringified to a tool literally NAMED "1", and a mapping
 * item collapsed the list to `''` — an empty list, which every reader here
 * reads as "omitted", i.e. inherit every tool. Widening a malformed ceiling to
 * no ceiling is the worse of the two. Emitting the JSON keeps this a
 * `Record<string, string>` and leaves the refusal where it already lives.
 *
 * An EMPTY sequence still joins to `''` — `tools: []` is a valid declaration
 * that parses as omitted (`sub-agents.md:279`), not a malformed one — and a
 * top-level number or boolean still stringifies, because `background: true` and
 * `maxTurns: 3` are scalars the readers parse out of their text.
 */
function flattenFrontmatterValue(value: unknown): string {
  const scalar = frontmatterScalar(value);
  if (scalar !== undefined) return scalar;
  if (!Array.isArray(value)) return '';
  const items = value.map(item => typeof item === 'string' && item.trim().length > 0 ? item : undefined);
  return items.every((item): item is string => item !== undefined)
    ? items.join(', ')
    : JSON.stringify(value);
}

function frontmatterScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * One item of a block list: a plain scalar, or a dash that opens a mapping.
 *
 * The second form exists because a sequence element that is a MAPPING is the
 * documented inline `mcpServers` shape (`sub-agents.md#scope-mcp-servers-to-a-subagent`),
 * and it is the one shape the scanner used to lose whole.
 */
type BlockListItem = string | { name: string; fields: Record<string, string> };

/**
 * Line scanner for frontmatter js-yaml refuses to parse at all.
 *
 * Same output vocabulary as the parsed path, including the opaque nested
 * mapping. It no longer refuses a comma-bearing block-list item: dropping a
 * declared ceiling silently is worse than joining an item the consumer's
 * paren-aware tokenizer puts back together.
 *
 * P6.817: a sequence element that is a MAPPING keeps its JSON here too, so the
 * two paths speak one vocabulary. Measured at HEAD on the documented inline
 * `mcpServers` example with one unrelated YAML error elsewhere in the block
 * (`description: Use when the user says "deploy": ship it`, a real SKILL.md
 * shape js-yaml refuses): the js-yaml path emitted
 * `[{"playwright":{…}},"github"]` while this scanner emitted `''` — not the
 * mapping-plus-dropped-references the row predicted, but the WHOLE list gone,
 * reference siblings included. That is the worse of the two failures
 * {@link flattenFrontmatterValue} names: `''` reads as "omitted" to every reader
 * here, so the same collapse on a `tools:` block widens a declared ceiling to no
 * ceiling at all.
 *
 * Exactly ONE shape is added — a dash item whose text is a bare `key:` followed
 * by more-indented `k: v` scalars. Anything deeper still yields `''`, unchanged.
 * A field's VALUE stays a string even where js-yaml would have typed it (a
 * `port: 8080` arrives as `"8080"`): this scanner's whole vocabulary is strings,
 * and inventing a scalar typer for a document YAML already refused would be a
 * second parser. A mapping that collects no fields serialises as `null`, which
 * is what js-yaml gives for `- name:` — so the readers' refusal lands the same
 * way on both paths.
 */
function scanFrontmatterBlock(frontmatterLines: string[]): Record<string, string> {
  const frontmatter: Record<string, string> = {};
  for (let index = 0; index < frontmatterLines.length; index += 1) {
    const rawLine = frontmatterLines[index] ?? '';
    // Only literal top-level keys are metadata. In particular, a nested
    // `modelConfig.model` must never silently become the agent's `model`.
    if (/^[ \t]/.test(rawLine)) continue;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = (match[2] ?? '').trim();
    if (!key) continue;
    if (value) {
      frontmatter[key] = stripMatchingQuotes(value);
      continue;
    }

    const blockList: BlockListItem[] = [];
    let simpleBlockList = true;
    /** The mapping the most recent dash item opened, and the dash's indent. */
    let openMapping: { indent: number; fields: Record<string, string> } | undefined;
    for (let cursor = index + 1; cursor < frontmatterLines.length; cursor += 1) {
      const nestedRawLine = frontmatterLines[cursor] ?? '';
      const nestedLine = nestedRawLine.trim();
      if (!nestedLine || nestedLine.startsWith('#')) continue;
      if (!/^[ \t]/.test(nestedRawLine)) break;
      const itemMatch = nestedRawLine.match(/^([ \t]+)-\s+(.+?)\s*$/);
      if (itemMatch) {
        const item = stripMatchingQuotes((itemMatch[2] ?? '').trim());
        if (!item) {
          simpleBlockList = false;
          break;
        }
        const opener = item.match(/^([A-Za-z][A-Za-z0-9_.-]*):$/);
        if (opener) {
          const fields: Record<string, string> = {};
          openMapping = { indent: (itemMatch[1] ?? '').length, fields };
          blockList.push({ name: opener[1] as string, fields });
          continue;
        }
        openMapping = undefined;
        blockList.push(item);
        continue;
      }
      // Not a dash. The only line kept is a `k: v` scalar indented deeper than
      // the dash that opened a mapping directly above it; everything else is
      // the nesting this scanner has always declined to read.
      const fieldMatch = nestedRawLine.match(/^([ \t]+)([A-Za-z][A-Za-z0-9_-]*):[ \t]+(.+?)\s*$/);
      if (
        openMapping === undefined || fieldMatch === null
        || (fieldMatch[1] ?? '').length <= openMapping.indent
      ) {
        simpleBlockList = false;
        break;
      }
      openMapping.fields[fieldMatch[2] as string] = stripMatchingQuotes((fieldMatch[3] ?? '').trim());
    }
    frontmatter[key] = simpleBlockList && blockList.length > 0
      ? flattenBlockList(blockList)
      : '';
  }
  return frontmatter;
}

/**
 * A scanned block list in the flat map's string vocabulary.
 *
 * All-strings joins on `', '`, exactly as before. Any mapping element makes the
 * whole list JSON — the same channel {@link flattenFrontmatterValue} uses on the
 * js-yaml path, so a reader cannot tell which parser produced the value.
 */
function flattenBlockList(items: readonly BlockListItem[]): string {
  if (items.every((item): item is string => typeof item === 'string')) return items.join(', ');
  return JSON.stringify(items.map(item => typeof item === 'string'
    ? item
    : { [item.name]: Object.keys(item.fields).length > 0 ? item.fields : null }));
}

function stripMatchingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Where a Codex bundle keeps its manifest — and it lives HERE, in a module whose
 * header says it holds nothing format-specific, for a measured reason rather
 * than a tidy one (P6.671). It is DATA, not behaviour, and no helper above
 * reads it; what put it here is which modules already import this file.
 *
 * It used to be exported from `format-adapters/codex.ts`, which the barrel
 * `format-adapters.ts` imports while `codex.ts` imports `mapExternalHookEventName`
 * back OUT of that barrel. That cycle is not itself the defect: `claude.ts` and
 * `mcpb.ts` sit in exactly the same shape and both import standalone without
 * complaint (measured 2026-09-07 — `claude.ts` alone resolves 5 exports). What
 * made the Codex one CRASH is that the barrel read this binding at MODULE-INIT
 * time, in a top-level `const` array of manifest candidates, so entering the
 * graph through `codex.ts` first hit the temporal dead zone:
 *
 *   ReferenceError: Cannot access 'CODEX_MANIFEST_RELATIVE_PATH' before
 *   initialization   at format-adapters.ts
 *
 * Inert in production only because every entry point happens to load the barrel
 * first — and two test files already carry hand-written comments routing their
 * imports around it, which is how a defect survives a year of green runs. Moving
 * the one binding the barrel needs at init time into a leaf both sides already
 * reach removes the dead zone; `codex.ts` re-exports the name so nothing that
 * reads it has to move.
 *
 * ## Why THIS leaf and not `manifest-paths.ts`, which reads like the better home
 *
 * Because the choice was measured, and the semantically tidier one cost real
 * time. `manifest-paths.ts` is not currently imported by `format-adapters.ts`,
 * so putting the constant there adds a module edge to the barrel — and with that
 * edge, `codex-contract-fields.test.ts`'s D3 case crossed bun's 5s default and
 * timed out. Controlled: at load 7.5 and the same ~65s file-load cost, the tree
 * WITHOUT the change passed and the tree WITH it failed at 5013ms, twice. This
 * file is already imported by BOTH sides, so it adds no edge at all and the case
 * stays green — which is also exactly what the row asked for ("whichever is
 * already imported by both").
 *
 * The two SIBLING constants (`CLAUDE_MANIFEST_RELATIVE_PATH`,
 * `MCPB_MANIFEST_PATH`) deliberately stay in their own adapters: nothing reads
 * either at barrel-init time, so moving them would be churn without a defect.
 * What keeps that true is `format-adapters-standalone-import.test.ts`, which
 * imports all three adapters FIRST rather than only the one that broke.
 */
export const CODEX_MANIFEST_RELATIVE_PATH = '.codex-plugin/plugin.json';
