/**
 * F1.557 — an MCP tool whose input schema has `anyOf`, `oneOf` or `allOf` at its
 * ROOT, made usable on claude-runtime by the rewrite Claude Code documents.
 *
 * ## The defect this closes (measured offline 2026-09-24, SDK 0.3.267)
 *
 * Every connected source reaches the claude child through
 * `createSourceProxyServers` (`claude-agent.ts`), which builds each tool's
 * parameters with `jsonSchemaToZodShape` — and that reads `schema.properties`
 * alone. A root combinator with no sibling `properties` therefore became an EMPTY
 * shape, and the damage was worse than the tool looking argument-less: the SDK
 * server parses a call's arguments with that empty object, so arguments the
 * model DID supply were stripped before the call reached the pool. The probe
 * listed `{"type":"object","properties":{}}` for a root anyOf, oneOf and allOf
 * tool alike, and a call carrying `{"id":"u1"}` arrived at the pool as `{}`. The
 * `z.object({}).catchall(z.unknown()).shape` spread beside the call restored
 * nothing: a catchall is not part of an object's shape, so it spread `{}`.
 *
 * ## Why the host does it, and not the runtime (native-first, asked first)
 *
 * The runtime HAS this mechanism — `mcp.md#tool-input-schemas-with-a-root-level-combinator`:
 * "Tools with a root-level combinator stay available. Before sending the tool to
 * the API, Claude Code flattens the schema into a single object and prepends a
 * sentence to the tool's description that tells Claude which parameter groups
 * belong together". It cannot reach our tools, twice over:
 *
 * - the in-process SDK server cannot carry a root combinator to the child at all.
 *   `tool()` accepts only a Zod RAW SHAPE (`AnyZodRawShape`), and the vendored
 *   `createSdkMcpServer` lists every tool through the MCP server's object
 *   normaliser, which answers a non-object schema with the empty object schema.
 *   The child never sees the combinator it would have flattened.
 * - the same page says the rewrite is skipped "on a deployment that doesn't
 *   receive the remote configuration that enables the rewrite", and then the
 *   tool is skipped. On the gateway card the child runs with
 *   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set (`startLocalAdapterRuntime`),
 *   so even a raw schema would most likely lose the tool there. The first
 *   reason is the decisive one; this one says the native path would not be a
 *   uniform answer across cards even if the seam could carry the schema.
 *
 * So the host applies the documented rewrite before the shape is built, which is
 * the page's own rule set:
 *
 * - "`allOf`: properties from every branch are merged, and each branch's
 *   `required` list still applies"
 * - "`anyOf` and `oneOf`: properties from every branch are merged, and each
 *   branch's `required` list is described in the tool description instead of
 *   enforced by the schema"
 * - "When Claude Code can't produce a schema the API accepts ... it skips that one
 *   tool, records the reason in the server's log, and leaves the server's other
 *   tools available."
 *
 * Three details the page does not spell out were read from the vendored 2.1.267
 * runtime's own rewrite and are REIMPLEMENTED here (paraphrase only, no text or
 * code copied): a branch that is a local `$ref` into `$defs`/`definitions` is
 * resolved against the root before its properties are read; a property already
 * seen (the root's first, then earlier branches) keeps its first definition
 * (narrowed by F1.610 below, where branches disagree); and
 * a property name the API would refuse (`mcp.md#tools-with-invalid-input-schemas`:
 * "1 to 64 characters long and use only ASCII letters and digits, `_`, `.`, and
 * `-`") is left out rather than allowed to cost the whole tool. The note wording
 * is this module's own.
 *
 * Nested combinators (inside `properties`) are NOT touched: the page says the API
 * accepts them and `jsonPropToZod` already turns them into unions.
 *
 * ## F1.610 — branches that disagree about a property (a deliberate deviation)
 *
 * "First definition wins" is safe in Claude Code because its flattened schema only
 * shapes what the model is offered. Here the same schema is ALSO the validator:
 * `createSourceProxyServers` builds the tool's Zod shape from it, and the SDK
 * server parses every call with that shape before the call reaches the pool. A
 * oneOf discriminated by an enum (`kind: user` in one branch, `kind: team` in the
 * other) or by differing types therefore refused every call for the other
 * branches. The page is silent on repeated properties, and the seam cannot carry
 * a second, looser validator (`tool()` takes one shape), so the merged definition
 * itself must accept what any branch accepts:
 *
 * - a definition that ALWAYS applies — the root's own, or an allOf branch's — is
 *   kept, as before: every valid call satisfies it, so it refuses nothing a
 *   branch allows. (A root oneOf/anyOf branch no longer beats a later allOf
 *   branch here, which is the one ordering change.)
 * - a property only anyOf/oneOf branches define keeps its first definition while
 *   the branches agree (differences in `description`, `title`, `examples`,
 *   `default` or `$comment` alone are agreement);
 * - branches that disagree only in their string `enum` (or `const`) values get
 *   ONE enum of every value, in first-seen order — what the discriminated case
 *   needs, and a truer offer to the model than the first branch's single value;
 * - any other disagreement is offered as an `anyOf` of the distinct definitions,
 *   which `jsonPropToZod` turns into a union that accepts each of them.
 *
 * Non-string enum values are not merged into one enum; they fall to the `anyOf`,
 * whose numeric enums `jsonPropToZod` builds as z.literal lists (F1.998). The MCP server itself stays the
 * validator of the real combinator; the host only stops refusing what it allows.
 */
import { debug } from '../../../utils/debug.ts';

type JsonRecord = Record<string, unknown>;

/** The three keywords the page names, in the order a note prefers them. */
export const ROOT_COMBINATOR_KEYWORDS = ['oneOf', 'anyOf', 'allOf'] as const;
type RootCombinator = (typeof ROOT_COMBINATOR_KEYWORDS)[number];

/** `mcp.md#tools-with-invalid-input-schemas` — a top-level property name the API accepts. */
const API_PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export type RootCombinatorOutcome =
  | { outcome: 'unchanged' }
  | { outcome: 'flattened'; schema: JsonRecord; note: string; combinators: RootCombinator[] }
  | { outcome: 'skipped'; reason: string };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A branch that is `{ "$ref": "#/$defs/X" }` (or `#/definitions/X`) read through to X. */
function resolveLocalRef(branch: JsonRecord, root: JsonRecord): JsonRecord {
  const ref = branch.$ref;
  if (typeof ref !== 'string') return branch;
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref);
  if (!match) return branch;
  const table = root[match[1]!];
  if (!isRecord(table)) return branch;
  const target = table[match[2]!];
  return isRecord(target) ? target : branch;
}

/** F1.610 — keys that describe a definition without constraining a value. */
const ANNOTATION_KEYS: ReadonlySet<string> = new Set(['description', 'title', 'examples', 'default', '$comment']);
const VALUE_LIST_KEYS: ReadonlySet<string> = new Set(['enum', 'const']);

function withoutKeys(definition: JsonRecord, ...keySets: ReadonlySet<string>[]): JsonRecord {
  return Object.fromEntries(Object.entries(definition).filter(([key]) => !keySets.some(keys => keys.has(key))));
}

/** A spelling of a JSON value with object keys sorted, so two definitions compare by content. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The string values a definition allows through `enum` or `const`, else null. */
function stringValueList(definition: JsonRecord): string[] | null {
  const values = Array.isArray(definition.enum) ? definition.enum : 'const' in definition ? [definition.const] : null;
  return values !== null && values.length > 0 && values.every(value => typeof value === 'string') ? values : null;
}

/**
 * F1.610 — one definition for a property that only anyOf/oneOf branches define,
 * accepting what every branch accepts (the rules are in the module header).
 */
function mergeAlternativeDefinitions(definitions: JsonRecord[]): JsonRecord {
  const distinct: JsonRecord[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    const key = canonicalJson(withoutKeys(definition, ANNOTATION_KEYS));
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(definition);
  }
  if (distinct.length === 1) return distinct[0]!;
  const valueLists = distinct.map(stringValueList);
  const rests = new Set(distinct.map(definition => canonicalJson(withoutKeys(definition, ANNOTATION_KEYS, VALUE_LIST_KEYS))));
  if (rests.size === 1 && valueLists.every(values => values !== null)) {
    return { ...withoutKeys(distinct[0]!, VALUE_LIST_KEYS), enum: [...new Set(valueLists.flat() as string[])] };
  }
  return { anyOf: distinct };
}

/** A branch's group, as the model is told it: its required names, else its property names. */
function branchGroup(branch: JsonRecord): string | null {
  const required = branch.required;
  if (Array.isArray(required) && required.length > 0 && required.every(name => typeof name === 'string')) {
    return required.join(', ');
  }
  if (isRecord(branch.properties)) {
    const names = Object.keys(branch.properties);
    if (names.length > 0) return names.join(', ');
  }
  return null;
}

/**
 * The documented rewrite of ONE tool's root schema. `unchanged` for every schema
 * with no root combinator, which is what keeps a plain tool byte-identical.
 */
export function flattenRootCombinatorSchema(schema: unknown): RootCombinatorOutcome {
  if (!isRecord(schema)) return { outcome: 'unchanged' };
  const combinators = ROOT_COMBINATOR_KEYWORDS.filter(keyword => keyword in schema);
  if (combinators.length === 0) return { outcome: 'unchanged' };

  // F1.610 — per property, in first-seen order: the first definition that always
  // applies (the root's, or an allOf branch's) and every anyOf/oneOf branch's.
  // `name in Object.prototype` keeps out what the former `name in properties`
  // check kept out (`__proto__` would rewrite the Zod shape's prototype).
  const definitionsOf = new Map<string, { always?: JsonRecord; alternatives: JsonRecord[] }>();
  const addProperties = (source: unknown, always: boolean): void => {
    if (!isRecord(source)) return;
    for (const [name, definition] of Object.entries(source)) {
      if (!API_PROPERTY_NAME.test(name) || name in Object.prototype || !isRecord(definition)) continue;
      const entry = definitionsOf.get(name) ?? { alternatives: [] };
      if (always) entry.always ??= definition;
      else entry.alternatives.push(definition);
      definitionsOf.set(name, entry);
    }
  };
  addProperties(schema.properties, true);
  const branchesOf: Partial<Record<RootCombinator, JsonRecord[]>> = {};
  for (const keyword of combinators) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      return { outcome: 'skipped', reason: `input schema has a root-level ${keyword} that is not an array` };
    }
    branchesOf[keyword] = branches.filter(isRecord).map(branch => resolveLocalRef(branch, schema));
    for (const branch of branchesOf[keyword]!) addProperties(branch.properties, keyword === 'allOf');
  }
  const properties: JsonRecord = {};
  for (const [name, { always, alternatives }] of definitionsOf) {
    properties[name] = always ?? mergeAlternativeDefinitions(alternatives);
  }

  // Root `required` always applies; an allOf branch's `required` still applies;
  // an anyOf/oneOf branch's `required` is described, never enforced.
  const required: string[] = [];
  const addRequired = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const name of list) {
      if (typeof name === 'string' && name in properties && !required.includes(name)) required.push(name);
    }
  };
  addRequired(schema.required);
  for (const branch of branchesOf.allOf ?? []) addRequired(branch.required);

  return {
    outcome: 'flattened',
    schema: { type: 'object', properties, required },
    note: combinatorNote(combinators, branchesOf),
    combinators,
  };
}

function combinatorNote(
  combinators: RootCombinator[],
  branchesOf: Partial<Record<RootCombinator, JsonRecord[]>>,
): string {
  const union = combinators.find((keyword): keyword is 'oneOf' | 'anyOf' => keyword !== 'allOf');
  if (!union) {
    return 'Argument groups (this tool\'s schema is a root-level allOf, merged into one object): every listed argument applies together.';
  }
  const groups = [...new Set((branchesOf[union] ?? []).map(branchGroup).filter((group): group is string => group !== null))];
  const howMany = union === 'oneOf' ? 'exactly one' : 'at least one';
  const listed = groups.length > 0 ? groups.map(group => `(${group})`).join(' | ') : 'the groups this tool documents';
  return `Argument groups (this tool's schema is a root-level ${union}, merged into one object): pass ${howMany} of ${listed}.`;
}

/** What one proxied MCP tool is registered with on the claude side. */
export interface ClaudeProxyToolInput {
  description: string;
  inputSchema: JsonRecord;
}

/**
 * The description and input schema `createSourceProxyServers` hands `tool()`, or
 * `null` when the tool is skipped — the page's "skips that one tool, records the
 * reason in the server's log". A tool with no root combinator gets exactly what it
 * got before this row: its own description (or the `Tool from <slug>` fallback)
 * and its own schema.
 *
 * F1.1091 — the `null` arm is not on `/mcp`'s skip line, and need not be: its one cause
 * (a root `anyOf`/`oneOf`/`allOf` that is not an array) fails the pool's own per-tool
 * compile first (`partitionListedTools`, F1.644), which skips the tool on every runtime
 * and names it there. Measured 2026-10-09: `{ anyOf: 'nope' }`, `{ oneOf: {…} }` and
 * `{ allOf: 3 }` each pool-skipped with "… value must be [\"array\"]"; an array control kept.
 * A pool client that bypasses that partition would reach this arm silently.
 */
export function claudeProxyToolInput(
  slug: string,
  mcpTool: { name: string; description?: string; inputSchema?: unknown },
  log: (message: string) => void = debug,
): ClaudeProxyToolInput | null {
  const description = mcpTool.description || `Tool from ${slug}`;
  const inputSchema = isRecord(mcpTool.inputSchema) ? mcpTool.inputSchema : {};
  const rewrite = flattenRootCombinatorSchema(inputSchema);
  if (rewrite.outcome === 'unchanged') return { description, inputSchema };
  if (rewrite.outcome === 'skipped') {
    log(`[claude-agent] F1.557: MCP tool "${mcpTool.name}" of source "${slug}" is not offered on claude-runtime — ${rewrite.reason}`);
    return null;
  }
  return { description: `${rewrite.note}\n\n${description}`, inputSchema: rewrite.schema };
}
