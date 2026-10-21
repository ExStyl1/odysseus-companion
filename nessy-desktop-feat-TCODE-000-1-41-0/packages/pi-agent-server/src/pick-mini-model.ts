import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';
import { resolvePiModel, isDeniedMiniModelId } from './model-resolution.ts';
import {
  PI_MINI_PREFERRED_DEFAULTS,
  PI_PREFERRED_DEFAULTS,
  isSmallClassModelId,
} from '../../shared/src/config/llm-connections.ts';

/**
 * Pick an auth-provider-appropriate default mini model.
 *
 * `getDefaultSummarizationModel()` returns `claude-haiku-4-5`, which only resolves
 * under `anthropic` auth. For `openai` / `openai-codex` / `google` /
 * `github-copilot` / `amazon-bedrock` we need a model from that provider's
 * preferred list — otherwise the ephemeral session ends up with no explicit
 * model and Pi SDK's internal default (post-0.70.0 an openai model) is used,
 * surfacing as a misleading "No API key found for openai" error when the user
 * is authenticated under a different provider.
 *
 * ## P2.97 — SMALL-FIRST, AND LOUD WHEN IT CANNOT BE
 *
 * This walked `PI_PREFERRED_DEFAULTS`, which is ordered most-capable-first
 * because it answers a different question (what the connection should TALK to).
 * The first resolvable entry of that list is the most expensive model the
 * provider offers, and background tasks — session titles, summaries — were
 * billed at it. Upstream's Bedrock page is explicit that this slot is the
 * "small/fast model" and that an unpinned deployment "is billed at the Opus
 * rate"; the per-provider small-first table lives next to the other one in
 * `llm-connections.ts` with those sentences quoted.
 *
 * Two failures this also closes, both measured against the shipped Pi catalog
 * (2026-08-25) rather than a mock: `github-copilot` and `amazon-bedrock` had NO
 * resolvable candidate at all — copilot spells its Claude ids with dots, and
 * Bedrock's catalog carries only prefixed inference-profile ids — so the pick
 * returned `undefined` and the caller fell back to a Haiku id that resolves
 * under neither.
 *
 * Nothing here is silent any more: a pick that is not small-class, and a
 * provider with no resolvable candidate at all, both say so on stderr, because
 * "the background model is an Opus" is a cost fact the user is entitled to and
 * the previous behaviour was to change it without a word.
 *
 * ## P2.309 — a PIN THAT STOPPED EXISTING is now loud
 *
 * The third silence, and the one that made P2.97's own fix perishable: the walk
 * skipped an unresolvable candidate without a word, so the day a pinned id is
 * retired from the provider's catalogue the mini path just stops being what it
 * claims. That is not hypothetical — `gpt-5.4-mini` retires from Codex for
 * ChatGPT sign-in on 2026-08-31, and until this row it was the ONLY entry for
 * `openai-codex`. Widening the list fixes this instance; the warning below is
 * what makes the NEXT retirement announce itself instead of being found by a
 * user.
 *
 * `resolvePiModel` returning `undefined` means precisely "this id is not in the
 * catalogue we fetched for this provider" — it never narrows on anything else
 * (`preferCustomEndpoint` only adds a place to look). So a skipped candidate IS
 * a dead pin, and it is named on stderr.
 *
 * Deduped per `(provider, id)` for the process lifetime because this runs once
 * per background query (`index.ts`'s `queryLlm`), not once at startup — a line
 * repeated on every session title is a line nobody reads. Denied candidates are
 * NOT reported: `isDeniedMiniModelId` is a deliberate exclusion, not an absence.
 *
 * Returns `undefined` when there is no resolvable candidate; callers should
 * fall back to `getDefaultSummarizationModel()` in that case.
 */
export function pickProviderAppropriateMiniModel(
  authProvider: string,
  modelRegistry: PiModelRegistry,
  preferCustomEndpoint: boolean,
): string | undefined {
  // The mini table is the authority where it has an entry; the primary-model
  // list is the fallback so a provider added to one table and not the other
  // keeps working (with a warning, since its head is a large model).
  const preferred = PI_MINI_PREFERRED_DEFAULTS[authProvider] ?? PI_PREFERRED_DEFAULTS[authProvider];
  if (!preferred || preferred.length === 0) return undefined;
  for (const candidate of preferred) {
    if (isDeniedMiniModelId(candidate, authProvider)) continue;
    const resolved = resolvePiModel(modelRegistry, candidate, authProvider, preferCustomEndpoint);
    if (!resolved) {
      warnMissingPin(authProvider, candidate);
      continue;
    }
    if (!isSmallClassModelId(candidate)) {
      warnMiniModel(
        `no small/fast model resolved for auth provider "${authProvider}"; background tasks`
        + ` (titles, summaries) will run on "${candidate}" and are billed at that model's rate`,
      );
    }
    return candidate;
  }
  warnMiniModel(
    `no mini-model candidate resolved for auth provider "${authProvider}" (tried`
    + ` ${preferred.length}); background tasks fall back to the default summarization`
    + ' model, which may not resolve under this provider',
  );
  return undefined;
}

/**
 * P2.309 — `${provider}:${id}` pairs already reported as missing, so the line is
 * said once per process rather than once per background query.
 */
const warnedMissingPins = new Set<string>();

/**
 * P2.309 — a pinned candidate is absent from the catalogue we fetched for this
 * provider. Names the id, because "which one" is the entire content of the
 * message: without it the reader learns only that something changed.
 */
function warnMissingPin(authProvider: string, candidate: string): void {
  const key = `${authProvider}:${candidate}`;
  if (warnedMissingPins.has(key)) return;
  warnedMissingPins.add(key);
  warnMiniModel(
    `pinned mini-model "${candidate}" is no longer in the fetched catalogue for auth`
    + ` provider "${authProvider}" — it was probably retired upstream; falling through to`
    + ' the next preferred candidate. Update PI_MINI_PREFERRED_DEFAULTS.',
  );
}

/**
 * Test seam for {@link warnedMissingPins}. The dedupe is process-wide by design,
 * which makes the warning invisible to any test that runs after another test has
 * already tripped the same pair — so the suite clears it explicitly rather than
 * depending on file order.
 */
export function __resetMissingPinWarningsForTest(): void {
  warnedMissingPins.clear();
}

/**
 * Stderr, with the same `[pi-server]` prefix `index.ts`'s own `debugLog` uses —
 * stdout carries the JSONL protocol and must not be written to. Kept local so
 * this module stays importable by its test without dragging in the server
 * entrypoint.
 */
function warnMiniModel(message: string): void {
  process.stderr.write(`[pi-server] [mini-model] ${message}\n`);
}
