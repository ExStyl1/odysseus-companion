/**
 * Pure helpers for the endpoint model catalog.
 *
 * Separate from `ModelCatalogPicker.tsx` on purpose: importing the component
 * drags the renderer chain (and with it `pdfjs-dist`, which takes bun's module
 * loader down), so the logic worth testing lives where a test can reach it.
 */

/**
 * Group key for a model id. llm-proxy ids are family-prefixed (`tgpt/…`,
 * `openrouter/google/…`, `anthropic/…`) and the prefix is what the API's
 * `owned_by` reports — so grouping needs no extra field on ModelDefinition.
 * A flat id (a local model, say) stays ungrouped rather than inventing a family.
 */
export function modelGroupKey(id: string): string {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : ''
}
