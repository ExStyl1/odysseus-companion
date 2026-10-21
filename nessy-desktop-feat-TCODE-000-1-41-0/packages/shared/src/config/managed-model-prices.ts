/**
 * The managed model price table — P6.537, owner decision D11 = option A.
 *
 * ## Why a host table at all
 *
 * Nothing on this fork prices a gateway or BYO model, so its cost reads as
 * `$0.00` and any USD ceiling over it is inert. Option B (keep "Not reported"
 * and cap in tokens) was refused for exactly that: no USD ceiling can then bite
 * on a gateway model on any runtime.
 *
 * **Native mechanism, measured rather than assumed — and the measurement CHANGED
 * under this paragraph (P7.16, 2026-09-11).** claude documents this key —
 * `settings-reference.md#modelpricing`, *"Report spend at the rates your
 * organization pays instead of list price"* — and the same entry said
 * *"Requires Claude Code v2.1.242 or later"*. That version clause is what this
 * note used to rest on: the vendored SDK self-reported **2.1.233** and
 * `grep -aoF modelPricing sdk.mjs` scored **0**. The lift to `0.3.247`
 * (self-reporting `2.1.247`) settles it: the same probe with the same controls
 * now scores **10** (`Cookie` → 5, `git-subdir` → 4, `nessyNotARealSdkKey` → 0),
 * and `sdk.d.ts` declares the key with its own gloss.
 *
 * The verdict survives on the clause that always mattered, which is
 * REACHABILITY, not version: the vendor honors `modelPricing` *"Only … from
 * managed settings … ignored in user, project, local and --settings sources"*,
 * the restrictive managed filter does not copy it, and the one remaining seam is
 * gated on an env flag that also strips an administrator's managed model pins.
 * `agent/claude-managed-settings.ts`'s `modelPricing` note carries the whole
 * measurement. Pi and codex have no price table of any kind, and codex reports
 * tokens and never USD. Host-side for all three, by measurement.
 *
 * ## The shape is READ, not invented
 *
 * It is claude's published shape, key for key —
 * `settings-reference.md#modelpricing`: *"object with an optional `multiplier`
 * and an optional `overrides` map"*, with each override carrying `input`,
 * `output`, `cacheRead` and `cacheWrite`. Copying it is not deference, and the
 * bet has already paid: the vendored bundle DOES read this key now (P7.16), and
 * a table an operator deployed against this shape is the shape that bundle
 * parses, so nobody has to rewrite a deployed policy the day a seam opens. Rates are
 * dollars per MILLION tokens, the unit the page's own worked example uses.
 *
 * ## What we do NOT do
 *
 * **We ship no table.** Not one price is bundled, and there is no default. The
 * page is explicit about why that is the right posture — *"You supply the
 * rates: Claude Code doesn't read them from your contract or the Claude
 * Console"* — and the owner bought the same cost knowingly: the operator
 * maintains the list, and a wrong entry produces a confidently wrong figure and
 * a cap that fires at the wrong moment. That is why the BASIS LABEL is part of
 * this row and not a follow-up: every managed figure is visibly a managed
 * figure, so a wrong number is attributable rather than mysterious.
 *
 * ## Zero imports, deliberately
 *
 * Same constraint as `managed-model-allowlist.ts` beside it, for the same
 * measured reason: the reader is the renderer's cost surface, and a transitive
 * `node:` import breaks the Vite renderer build. Keep it that way.
 */

/** One model's contracted rates, in dollars per MILLION tokens. */
export interface ManagedModelRates {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The operator's whole table. Both halves optional, exactly as documented. */
export interface ManagedModelPricing {
  /**
   * A flat factor applied to EVERY figure, *"the Sonnet row included"* — so a
   * multiplier alone re-bases a runtime's list price without naming a model.
   */
  multiplier?: number;
  /** Per-model contracted rates, keyed by model id. */
  overrides?: Record<string, ManagedModelRates>;
}

/** Why a candidate table, or one of its entries, was not used. */
export interface ManagedModelPricingRejection {
  /** `multiplier`, or `overrides.<model>.<field>`. */
  path: string;
  reason: 'not-an-object' | 'not-a-finite-number' | 'negative';
  value: unknown;
}

export interface ParsedManagedModelPricing {
  pricing: ManagedModelPricing | undefined;
  rejected: ManagedModelPricingRejection[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

/**
 * Parse an operator-supplied table, dropping what it cannot use and SAYING SO.
 *
 * Every rejection is returned rather than thrown. A price table is deployed by
 * an administrator who will not see a stack trace, and the failure that matters
 * is the quiet one: a mistyped rate that silently reverts one model to list
 * price while every other row says "managed". The rejection list is what a
 * `/doctor`-class surface prints.
 *
 * A negative rate is rejected rather than clamped. There is no reading of a
 * negative price that is a price.
 */
export function parseManagedModelPricing(raw: unknown): ParsedManagedModelPricing {
  const rejected: ManagedModelPricingRejection[] = [];
  if (raw === undefined || raw === null) return { pricing: undefined, rejected };
  if (!isRecord(raw)) {
    rejected.push({ path: 'modelPricing', reason: 'not-an-object', value: raw });
    return { pricing: undefined, rejected };
  }

  const readRate = (value: unknown, path: string): number | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      rejected.push({ path, reason: 'not-a-finite-number', value });
      return undefined;
    }
    if (value < 0) {
      rejected.push({ path, reason: 'negative', value });
      return undefined;
    }
    return value;
  };

  const pricing: ManagedModelPricing = {};
  const multiplier = readRate(raw.multiplier, 'modelPricing.multiplier');
  if (multiplier !== undefined) pricing.multiplier = multiplier;

  if (raw.overrides !== undefined) {
    if (!isRecord(raw.overrides)) {
      rejected.push({ path: 'modelPricing.overrides', reason: 'not-an-object', value: raw.overrides });
    } else {
      const overrides: Record<string, ManagedModelRates> = {};
      for (const [model, entry] of Object.entries(raw.overrides)) {
        if (!isRecord(entry)) {
          rejected.push({ path: `modelPricing.overrides.${model}`, reason: 'not-an-object', value: entry });
          continue;
        }
        const rates: ManagedModelRates = {};
        for (const field of RATE_FIELDS) {
          const rate = readRate(entry[field], `modelPricing.overrides.${model}.${field}`);
          if (rate !== undefined) rates[field] = rate;
        }
        // An override that survived with no usable rate would report `managed`
        // over a figure nothing managed. Drop it and let the row say `unknown`.
        if (Object.keys(rates).length > 0) overrides[model] = rates;
      }
      if (Object.keys(overrides).length > 0) pricing.overrides = overrides;
    }
  }

  const usable = pricing.multiplier !== undefined || pricing.overrides !== undefined;
  return { pricing: usable ? pricing : undefined, rejected };
}

/**
 * `pi/` is OUR routing prefix, not part of a model id — the same normalisation
 * `managed-model-allowlist.ts` performs, and for the same reason: an
 * administrator writes the id the provider documents.
 */
function bareModelId(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value;
}

/** The operator's rates for one model, or `undefined`. Exact id match only. */
export function managedRatesFor(
  pricing: ManagedModelPricing | undefined,
  modelId: string,
): ManagedModelRates | undefined {
  const overrides = pricing?.overrides;
  if (!overrides) return undefined;
  const direct = overrides[modelId];
  if (direct) return direct;
  const bare = bareModelId(modelId);
  if (bare !== modelId && overrides[bare]) return overrides[bare];
  // A version-prefix or family match is DELIBERATELY not implemented: the
  // allowlist could afford a prefix rule because widening a permit list is the
  // only direction that matters there, whereas a prefix here would silently
  // price a model the operator never named. Exact ids, and `unknown` otherwise.
  return undefined;
}

export interface ManagedPricedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Tokens are counted per million; the table's rates are dollars per million. */
const TOKENS_PER_PRICED_UNIT = 1_000_000;

/**
 * What the operator's table says this usage cost, or `undefined` when it says
 * nothing about it.
 *
 * Two ways to answer, and the page defines both:
 *
 * 1. **An override** prices the tokens directly.
 * 2. **A multiplier with no override** re-bases a figure the RUNTIME already
 *    established — *"reduces every figure, the Sonnet row included, by 15%"* —
 *    so `listCostUsd` is the second input rather than a fallback.
 *
 * `undefined` when neither applies, which is what keeps `unknown` honest: a
 * model absent from the table is visibly unpriced, never free.
 */
export function priceUsageWithManagedTable(
  pricing: ManagedModelPricing | undefined,
  modelId: string,
  usage: ManagedPricedUsage,
  listCostUsd?: number | null,
): number | undefined {
  if (!pricing) return undefined;
  const multiplier = pricing.multiplier ?? 1;
  const rates = managedRatesFor(pricing, modelId);

  if (rates) {
    const priced = (tokens: number | undefined, rate: number | undefined): number =>
      tokens && rate ? (tokens / TOKENS_PER_PRICED_UNIT) * rate : 0;
    const total = priced(usage.inputTokens, rates.input)
      + priced(usage.outputTokens, rates.output)
      + priced(usage.cacheReadTokens, rates.cacheRead)
      + priced(usage.cacheWriteTokens, rates.cacheWrite);
    return total * multiplier;
  }

  if (pricing.multiplier !== undefined && typeof listCostUsd === 'number') {
    return listCostUsd * multiplier;
  }

  return undefined;
}

/**
 * The table in force for THIS process.
 *
 * A process-scoped registry for the identical reason `managedModelAllowlist`
 * keeps one: the managed policy is a property of the host process, composed
 * once at bootstrap, while the reader — the cost readout — is a pure formatter
 * far below the layer that owns the composition.
 *
 * Nothing recomposes after bootstrap, so a table delivered mid-run takes effect
 * at the next start. That is the conservative direction: a session's figures
 * cannot change basis underneath the person reading them.
 */
let activePricing: ManagedModelPricing | undefined;

export function setManagedModelPricing(pricing: ManagedModelPricing | undefined): void {
  activePricing = pricing;
}

export function managedModelPricing(): ManagedModelPricing | undefined {
  return activePricing;
}
