/**
 * F1.566 (origin WJ-bf P-WJbf-1, 2026-09-24) — the ChatGPT (Codex) card's model
 * list, read from codex's own `model/list` once codex is signed in.
 *
 * ## Why this source, and only for this card
 *
 * The card was seeded with a static list: codex's bundled `models.json` at
 * `rust-v0.156.1`, the seven entries shown in the picker
 * (`CODEX_CHATGPT_SUBSCRIPTION_MODELS`). That list goes stale in two ways: a
 * codex lift can change `models.json`, and the account can offer models the
 * bundle does not know.
 *
 * P3.115 measured that `model/list` answers codex's OWN catalogue whatever
 * provider the config names. On every other codex card that is the wrong
 * catalogue, because the session talks to a different provider. On this card
 * codex's own `openai` provider IS the one in use. Once signed in, codex resolves
 * the list itself (`catalog_processor.rs` `list_models`,
 * `RefreshStrategy::OnlineIfUncached`, read at `rust-v0.156.1`). Nothing here
 * builds a catalogue; it copies codex's.
 *
 * ## What is copied, and what is not
 *
 * - `model` (the slug codex runs) becomes the id; `displayName` becomes the name
 *   and the short name; `description` is copied. Hidden entries are not asked
 *   for (`includeHidden: false`), and one marked hidden anyway is dropped.
 * - `model/list` publishes no context window (`generated/v2/Model.ts`). A model
 *   the seed knows keeps the seed's window. A model it does not know gets
 *   {@link CODEX_CHATGPT_UNLISTED_CONTEXT_WINDOW}, the one value every entry of
 *   codex's own `models.json` carries at the pinned tag. That is a stated
 *   default for the context meter's first turn, not a claim: codex reports the
 *   real window in `thread/tokenUsage/updated` after the first turn.
 * - F1.601 · `inputModalities` decides `supportsImages`. A model codex lists
 *   WITHOUT `image` is declared `supportsImages: false`, so the composer offers
 *   no image attachment for it and the send says the image was left out. Before
 *   this, codex took the image and replaced it with a placeholder on its own
 *   (`core/src/context_manager/normalize.rs`, `strip_images_when_unsupported`,
 *   `rust-v0.156.1`), without a word. A model that takes images stays
 *   UNDECLARED: `modelSupportsImages` already answers images-on for an
 *   undeclared codex model, and codex's own default when the field is absent is
 *   text and image (`default_input_modalities`), so a stored `true` would change
 *   nothing and would turn every first refresh into a write. A field codex did
 *   not publish declares nothing. Every other codex card is untouched: this
 *   module runs on this card alone.
 *
 * ## When nothing is written
 *
 * The stored list is replaced only when codex answered at least one usable
 * model and the list differs from what is stored. A failed read, an empty
 * answer and an identical list write nothing. A list the user curated
 * (`modelSelectionMode: 'userDefined3Tier'`) is not asked for at all: the same
 * rule the host's model-refresh service applies to user-owned lists.
 *
 * The stored default stays when codex still lists it. Otherwise it becomes
 * codex's own default (`isDefault`), then the first entry. The move is
 * returned, so the caller can say it.
 */
import type { LlmConnection } from '../../../config/llm-connections.ts';
import { CODEX_CHATGPT_SUBSCRIPTION_MODELS } from '../../../config/llm-connections.ts';
import type { ModelDefinition } from '../../../config/models.ts';

export const CODEX_MODEL_LIST_METHOD = 'model/list';

/**
 * The read's ceiling. The first read after sign-in may go online (the account's
 * list), so it is looser than the 10 s account reads; nothing waits on it.
 */
export const CODEX_MODEL_LIST_TIMEOUT_MS = 30_000;

/**
 * The context window given to a model the seed does not know: the value every
 * entry of codex's `models.json` carries at `rust-v0.156.1`. Stated, not
 * measured per model; codex reports the real one after the first turn.
 */
export const CODEX_CHATGPT_UNLISTED_CONTEXT_WINDOW = 272_000;

/** The one method the refresh needs from the app-server client. */
export interface CodexModelListRequester {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

/** Where the card's connection is read and written. `CodexAgent` hands it the config store. */
export interface CodexChatGptModelStore {
  get(slug: string): LlmConnection | null;
  update(slug: string, updates: Partial<Omit<LlmConnection, 'slug'>>): boolean;
}

export type CodexChatGptModelRefresh =
  | { kind: 'replaced'; count: number; defaultMoved?: { from: string | undefined; to: string } }
  | { kind: 'unchanged' }
  /** codex answered, with no model this card could list. */
  | { kind: 'empty' }
  /** The user curated this list; background refresh never overwrites it. */
  | { kind: 'user-owned' }
  | { kind: 'no-connection' }
  | { kind: 'unreadable'; reason: string };

interface ListedModel { id: string; name: string; description: string; isDefault: boolean; textOnly: boolean }

function readListedModels(answer: unknown): ListedModel[] | null {
  const data = (answer as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const seen = new Set<string>();
  const models: ListedModel[] = [];
  for (const entry of data) {
    const raw = entry as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || raw.hidden === true) continue;
    const id = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : id;
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    // F1.601 · text-only only when codex PUBLISHED the modalities and left `image` out.
    const textOnly = Array.isArray(raw.inputModalities) && !raw.inputModalities.includes('image');
    models.push({ id, name, description, isDefault: raw.isDefault === true, textOnly });
  }
  return models;
}

/**
 * F1.625 — codex's answer is MERGED into the stored entry, the keyed merge the
 * host's model-refresh service does (`server-core` `mergeModelMetadata`): the
 * stored entry is spread and only the fields this refresh owns are written, so
 * any other per-model field survives. Owned: id, names, description (a stored
 * `descriptionKey` would show in its place, so it goes), provider, window, and
 * `supportsImages` per F1.601 — a stamp-less value is re-derived from codex's
 * modalities every time, so a `false` codex no longer publishes goes. The one
 * exception is a LEARNED refusal (`supportsImagesLearnedFrom` beside it, written
 * only from the endpoint's own words by `learnImageRefusal`): it is evidence
 * about this model, and it is kept until the user reverses it.
 */
function toDefinition(model: ListedModel, known: readonly ModelDefinition[]): ModelDefinition {
  const stored = known.find(entry => entry.id === model.id);
  const previous = stored ?? CODEX_CHATGPT_SUBSCRIPTION_MODELS.find(entry => entry.id === model.id);
  const { descriptionKey: _key, supportsImages: _images, supportsImagesLearnedFrom: learnedFrom, ...kept }: Partial<ModelDefinition> = stored ?? {};
  const images = learnedFrom !== undefined
    ? { supportsImages: false, supportsImagesLearnedFrom: learnedFrom }
    : model.textOnly ? { supportsImages: false } : {};
  return {
    ...kept,
    id: model.id,
    name: model.name,
    shortName: model.name,
    description: model.description,
    provider: 'codex-runtime',
    contextWindow: previous?.contextWindow ?? CODEX_CHATGPT_UNLISTED_CONTEXT_WINDOW,
    ...images,
  };
}

const sameList = (a: readonly ModelDefinition[], b: readonly ModelDefinition[]): boolean =>
  a.length === b.length && a.every((model, i) => {
    const other = b[i]!;
    return model.id === other.id && model.name === other.name && model.shortName === other.shortName
      && model.description === other.description && model.contextWindow === other.contextWindow
      && model.supportsImages === other.supportsImages;
  });

/**
 * Read codex's list and, when it is usable and new, write it to the card.
 * Never throws: a failure is `unreadable`, carrying codex's reason.
 */
export async function refreshCodexChatGptSubscriptionModels(
  client: CodexModelListRequester,
  slug: string,
  store: CodexChatGptModelStore,
  now: () => number = Date.now,
): Promise<CodexChatGptModelRefresh> {
  const connection = store.get(slug);
  if (!connection) return { kind: 'no-connection' };
  if (connection.modelSelectionMode === 'userDefined3Tier') return { kind: 'user-owned' };
  let answer: unknown;
  try {
    answer = await client.request(CODEX_MODEL_LIST_METHOD, { includeHidden: false }, { timeoutMs: CODEX_MODEL_LIST_TIMEOUT_MS });
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  const listed = readListedModels(answer);
  if (!listed) return { kind: 'unreadable', reason: 'model/list answered without a data array' };
  if (listed.length === 0) return { kind: 'empty' };
  const known = (connection.models ?? []).filter((model): model is ModelDefinition => typeof model !== 'string');
  const models = listed.map(model => toDefinition(model, known));
  if (sameList(models, known)) return { kind: 'unchanged' };
  const current = connection.defaultModel;
  const keep = !!current && models.some(model => model.id === current);
  const next = keep ? current! : (listed.find(model => model.isDefault) ?? listed[0]!).id;
  store.update(slug, {
    models,
    catalogueRefreshedAt: now(),
    ...(keep ? {} : { defaultModel: next }),
  });
  return keep
    ? { kind: 'replaced', count: models.length }
    : { kind: 'replaced', count: models.length, defaultMoved: { from: current, to: next } };
}

/** One line for the session's debug channel; names no token (there is none here). */
export function describeCodexChatGptModelRefresh(outcome: CodexChatGptModelRefresh): string {
  switch (outcome.kind) {
    case 'replaced':
      return `[ChatGPT subscription] model list: ${outcome.count} model(s) from codex's model/list replaced the stored list`
        + (outcome.defaultMoved ? `; the default moved from ${outcome.defaultMoved.from ?? '(none)'} to ${outcome.defaultMoved.to}, which codex no longer lists` : '');
    case 'unchanged': return '[ChatGPT subscription] model list: codex\'s model/list matches the stored list';
    case 'empty': return '[ChatGPT subscription] model list: codex listed no usable model; the stored list stays';
    case 'user-owned': return '[ChatGPT subscription] model list: the user curated this list, so it is not refreshed';
    case 'no-connection': return '[ChatGPT subscription] model list: the connection is gone; nothing to refresh';
    case 'unreadable': return `[ChatGPT subscription] model list: codex did not answer model/list (${outcome.reason.replace(/\s+/g, ' ').slice(0, 200)}); the stored list stays`;
  }
}
