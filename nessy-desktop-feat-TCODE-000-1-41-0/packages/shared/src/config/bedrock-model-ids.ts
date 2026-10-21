/**
 * Bedrock model-id shapes: the ONE place a region prefix is derived and a
 * native inference-profile id is turned into a bare Anthropic id.
 *
 * ## Why this is its own leaf module
 *
 * The reverse mapping used to exist TWICE — `BEDROCK_REVERSE_MAP` in
 * `llm-connections.ts` and `BEDROCK_TO_BARE` in `models.ts`, the second one
 * carrying the comment *"Must stay in sync with BEDROCK_MODEL_MAP in
 * llm-connections.ts"* because `llm-connections` imports `models` and the
 * import cannot go back the other way. They drifted: `models.ts`'s copy was
 * missing every `claude-opus-5` form, so the seeded Bedrock default model
 * (`pi/eu.anthropic.claude-opus-5`) rendered in the UI as
 * *"Eu.anthropic.opus 5"* with no context window at all (P2.94, measured).
 *
 * Same failure and same fix as `claude-provider-routing-env.ts`, which
 * `llm-connections.ts` already extracted for exactly this reason: a leaf module
 * with no imports of its own, which both sides read. Nothing here may import
 * `models.ts` or `llm-connections.ts` — that import direction is the whole
 * reason the duplicate existed.
 *
 * ## Why the reverse direction is DERIVED, not a table
 *
 * A hand-maintained reverse table is a list that has to agree with another
 * list, and this plan has met that failure five times. The geography prefix and
 * the `-v1:N` suffix are pure syntax — every entry of the old table was exactly
 * "strip the prefix, strip the version suffix" — so a derivation covers
 * prefixes and models nobody has typed here yet. Measured against the shipped
 * Pi SDK Bedrock catalog (100 models, 41 of them Claude, 2026-08-25): it ships
 * `au.` and `jp.` profiles, which BOTH hand tables were missing, and 16 of
 * those 41 ids reverse-mapped to themselves.
 */

/**
 * The AWS region → inference-profile prefix table, verbatim from upstream.
 *
 * `code.claude.com/docs/en/amazon-bedrock.md` § "Cross-region inference profile
 * prefixes" (fetched 2026-08-25) introduces it with *"This table shows the
 * prefix Claude Code prefers for each resolved AWS region:"* and the rows are
 * `us-gov-*` (AWS GovCloud) → `us-gov.`, `us-*` → `us.`, `eu-*` → `eu.`,
 * `ap-*` → `apac.`, and *"All other regions"* → `global.`. The same page names
 * the complete set of accepted values: *"Valid values are `us`, `eu`, `apac`,
 * `jp`, `au`, and `global`."* — `jp`/`au` are reachable only by explicit
 * choice, never derived from a region, which is why they are absent here.
 *
 * Order matters: `us-gov-` must be tested before `us-`.
 */
const BEDROCK_REGION_PREFIX_RULES: ReadonlyArray<readonly [prefix: string, awsRegionPrefix: string]> = [
  ['us-gov', 'us-gov-'],
  ['us', 'us-'],
  ['eu', 'eu-'],
  ['apac', 'ap-'],
];

/**
 * Every prefix a native id may legitimately carry, for the reverse direction:
 * the four the table derives, `global` (its catch-all row), and the two the
 * page lists as choosable but never derives.
 */
export const BEDROCK_REGION_PREFIXES: readonly string[] = [
  'us-gov',
  'us',
  'eu',
  'apac',
  'jp',
  'au',
  'global',
];

/**
 * The prefix to prefer when no region is known at all.
 *
 * NOT `global`, even though the table's catch-all row is: an absent region
 * means the AWS SDK resolves one of its own (env, profile, config file), and
 * every pinning example on the upstream page spells its ids `us.`. The
 * catch-all row applies to a region we KNOW and cannot classify.
 */
export const DEFAULT_BEDROCK_REGION_PREFIX = 'us';

/**
 * The operator's override for the derived prefix (P6.375, K28).
 *
 * `amazon-bedrock.md#cross-region-inference-profile-prefixes`, whole sentence:
 * *"Set `ANTHROPIC_BEDROCK_REGION_PREFIX` to choose the prefix Claude Code
 * tries first; when Claude Code can check profile availability and finds no
 * matching profile for a model, it falls back as described in the resolution
 * order below. Valid values are `us`, `eu`, `apac`, `jp`, `au`, and `global`.
 * For example, set it to `global` when your account has `global.` profiles
 * enabled but Claude Code would derive a geography-specific one from your AWS
 * region."*
 *
 * **Native-first, and the answer was "the runtime has it and cannot reach it".**
 * The name is real in the vendored SDK (2 occurrences) and claude's own reader
 * would honour it — but the Bedrock provider toggle is stripped from every child
 * env by `CLAUDE_SDK_STRIPPED_ENV_KEYS`, so claude never selects Bedrock here and
 * its reader never runs. Pi has none, codex is n/a. That makes this the host's
 * job, once, for the one runtime that reaches Bedrock at all — which is the
 * uniform-seam half of the native-first rule rather than a per-runtime build.
 */
export const BEDROCK_REGION_PREFIX_ENV_VAR = 'ANTHROPIC_BEDROCK_REGION_PREFIX';

/**
 * The values the page enumerates for {@link BEDROCK_REGION_PREFIX_ENV_VAR}, in
 * its own order.
 *
 * **This is deliberately NOT {@link BEDROCK_REGION_PREFIXES}, and the difference
 * is `us-gov`.** `us-gov` is a real prefix — the same page says *"In AWS GovCloud
 * regions, use the `us-gov.` prefix"* — and it is derived from a `us-gov-*`
 * region by the table above, so a GovCloud operator already gets it without
 * setting anything. It is simply not in this key's published value list, and the
 * read-don't-invent rule says an enumeration in the contract is the contract:
 * widening it here would be us deciding what the key accepts. If an operator
 * ever needs `us-gov` explicitly, that is a row, not a silent superset.
 */
export const BEDROCK_REGION_PREFIX_OVERRIDE_VALUES: readonly string[] = [
  'us',
  'eu',
  'apac',
  'jp',
  'au',
  'global',
];

/** What {@link readBedrockRegionPrefixOverride} found in the environment. */
export type BedrockRegionPrefixOverride =
  | { kind: 'unset' }
  | { kind: 'accepted'; prefix: string }
  | { kind: 'rejected'; value: string };

/**
 * Read the override, without deciding what to do about a bad one.
 *
 * Split out from {@link deriveBedrockRegionPrefix} on purpose: this module is a
 * leaf with no imports (see the header — that is the whole reason it exists), so
 * it has no logger and must not grow one. The caller that HAS an operator-facing
 * surface names the rejection; the derivation just falls through to the region
 * table, which is the safe direction — a typo yields the prefix the operator
 * would have had anyway rather than an id nothing can invoke.
 */
export function readBedrockRegionPrefixOverride(
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): BedrockRegionPrefixOverride {
  const raw = env[BEDROCK_REGION_PREFIX_ENV_VAR];
  if (raw === undefined) return { kind: 'unset' };
  const value = raw.trim();
  if (value === '') return { kind: 'unset' };
  const normalized = value.toLowerCase();
  if (BEDROCK_REGION_PREFIX_OVERRIDE_VALUES.includes(normalized)) {
    return { kind: 'accepted', prefix: normalized };
  }
  return { kind: 'rejected', value };
}

/**
 * Derive the inference-profile prefix for an AWS region, per the table above —
 * unless the operator has chosen one, in which case theirs wins.
 *
 * Returns {@link DEFAULT_BEDROCK_REGION_PREFIX} when no region is given, and
 * `global` for a region the table does not classify — the row the old
 * two-branch implementation was missing: it answered `us` for `ap-*`, `ca-*`,
 * `sa-*`, `me-*` and every other geography, i.e. it handed a user outside
 * US/EU a cross-region profile id for a geography they are not in.
 *
 * The override is the page's *"tries first"*, and it is also the only way to
 * reach `jp` and `au`: the region table never derives them, which is why
 * {@link BEDROCK_REGION_PREFIX_RULES} has no row for either.
 */
export function deriveBedrockRegionPrefix(
  awsRegion?: string,
  env?: Record<string, string | undefined>,
): string {
  const override = readBedrockRegionPrefixOverride(env);
  if (override.kind === 'accepted') return override.prefix;
  const region = awsRegion?.trim().toLowerCase();
  if (!region) return DEFAULT_BEDROCK_REGION_PREFIX;
  for (const [prefix, awsRegionPrefix] of BEDROCK_REGION_PREFIX_RULES) {
    if (region.startsWith(awsRegionPrefix)) return prefix;
  }
  return 'global';
}

/**
 * Bare Anthropic model id → its Bedrock-native form WITHOUT a geography
 * prefix. The prefix is applied by {@link bareToBedrockNativeModelId}, so this
 * table carries only which ids exist and what version suffix each one has.
 *
 * Direct model ids (`anthropic.claude-*`, no geography) are rejected by Bedrock
 * with "Retry your request with the ID or ARN of an inference profile", so
 * nothing hands one of these out unprefixed.
 *
 * Source: the Pi SDK registry (`models.generated.js`). `claude-opus-5` is also
 * the upstream contract — `amazon-bedrock.md` (fetched 2026-08-25),
 * default-models table: *"Primary model | Opus 5, for example
 * `us.anthropic.claude-opus-5` in a `us-*` region"*.
 *
 * F1.1214 — Fable 5.1, Opus 5.5 and Sonnet 5.5 come from the models overview's
 * "Amazon Bedrock ID" row (`anthropic.claude-fable-5-1`,
 * `anthropic.claude-opus-5-5`, `anthropic.claude-sonnet-5-5`;
 * platform.claude.com/docs/en/models/overview.md), and `amazon-bedrock.md`
 * (re-read 2026-10-01) now names *"Opus 5.5, for example
 * `us.anthropic.claude-opus-5-5` in a `us-*` region"* as the primary model.
 */
const BEDROCK_BASE_BY_BARE: Record<string, string> = {
  'claude-opus-5-5': 'anthropic.claude-opus-5-5',
  'claude-sonnet-5-5': 'anthropic.claude-sonnet-5-5',
  // UB7.14 — the models overview's Bedrock ID for Haiku 5.5 (curled 2026-10-14
  // by B2; `anthropic.claude-haiku-5-5`, same shape as its 5-5 siblings).
  'claude-haiku-5-5': 'anthropic.claude-haiku-5-5',
  'claude-fable-5-1': 'anthropic.claude-fable-5-1',
  'claude-opus-5': 'anthropic.claude-opus-5',
  'claude-opus-4-8': 'anthropic.claude-opus-4-8',
  'claude-opus-4-7': 'anthropic.claude-opus-4-7',
  'claude-fable-5': 'anthropic.claude-fable-5',
  'claude-sonnet-5': 'anthropic.claude-sonnet-5',
  'claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  // Older supported model IDs, all present in the shipped Pi catalog.
  'claude-opus-4-5-20251101': 'anthropic.claude-opus-4-5-20251101-v1:0',
  'claude-sonnet-4-5-20250929': 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'claude-opus-4-1-20250805': 'anthropic.claude-opus-4-1-20250805-v1:0',
};

/** Matches `<geo>.anthropic.<model>` and `anthropic.<model>`, capturing both parts. */
const BEDROCK_NATIVE_ID_RE = /^(?:([a-z][a-z0-9-]*)\.)?(anthropic\.[a-z0-9][a-z0-9.:-]*)$/i;

/**
 * Split a native id into its geography prefix and its `anthropic.`-prefixed
 * base, or `undefined` when it is not a Bedrock-native Anthropic id at all.
 * An unrecognized prefix (`xx.anthropic.…`) is not native either — treating it
 * as one would strip a segment that means something else.
 */
export function splitBedrockNativeModelId(
  modelId: string,
): { regionPrefix?: string; baseId: string } | undefined {
  const match = BEDROCK_NATIVE_ID_RE.exec(modelId);
  if (!match) return undefined;
  const regionPrefix = match[1]?.toLowerCase();
  const baseId = match[2];
  if (!baseId) return undefined;
  if (regionPrefix !== undefined && !BEDROCK_REGION_PREFIXES.includes(regionPrefix)) {
    return undefined;
  }
  return regionPrefix === undefined ? { baseId } : { regionPrefix, baseId };
}

/**
 * Native Bedrock id → bare Anthropic id. Pass-through for anything that is not
 * a Bedrock-native Anthropic id (bare ids, `openai.gpt-*`, `amazon.nova-*`, an
 * inference-profile ARN, a model from a catalog we have never listed).
 *
 * Deliberately NOT a lookup table — see the module header. A model that arrives
 * from a catalog update maps correctly without an edit here.
 */
export function bedrockNativeToBareModelId(modelId: string): string {
  const split = splitBedrockNativeModelId(modelId);
  if (!split) return modelId;
  return split.baseId
    .replace(/^anthropic\./i, '')
    // `-v1:0` is Bedrock's version suffix; `-v1` alone is a shape an earlier
    // release of this file wrote, and both mean the same model.
    .replace(/-v1(:\d+)?$/i, '');
}

/**
 * Bare Anthropic id → native inference-profile id at `regionPrefix`.
 *
 * Also RE-PREFIXES an id that is already native, which is the half the seeded
 * Bedrock default needed: the setup path calls this with the connection's
 * configured region, and a stored `eu.anthropic.claude-opus-5` used to sail
 * through unchanged because the forward table had no key for a native id
 * (P2.95a). Passing no `regionPrefix` still leaves a native id's geography
 * alone — a caller that names no region is asking for a mapping, not a move.
 *
 * The result is always the CANONICAL base for the model, so a `-v1` shape from
 * an older release is normalized on the way through. Pass-through for a model
 * id this table has never heard of.
 */
export function bareToBedrockNativeModelId(modelId: string, regionPrefix?: string): string {
  const prefix = regionPrefix?.trim().toLowerCase();
  const native = splitBedrockNativeModelId(modelId);
  const bareId = native ? bedrockNativeToBareModelId(modelId) : modelId;
  const baseId = BEDROCK_BASE_BY_BARE[bareId];
  if (!baseId) return modelId;
  if (native?.regionPrefix !== undefined && !prefix) return modelId;
  return `${prefix ?? DEFAULT_BEDROCK_REGION_PREFIX}.${baseId}`;
}

/** The bare ids this module knows a Bedrock-native form for. */
export function knownBedrockBareModelIds(): string[] {
  return Object.keys(BEDROCK_BASE_BY_BARE);
}
