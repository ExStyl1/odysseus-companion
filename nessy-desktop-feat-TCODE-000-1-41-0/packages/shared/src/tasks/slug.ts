/**
 * UA3.2 — adapted from craft-agents-oss `v0.13.4:packages/shared/src/tasks/slug.ts` (Apache-2.0).
 *
 * ONE stated divergence — the non-Latin fallback in {@link slugify} (spec §10 "Slugs", upstream defect 13 in
 * spec §19): upstream's ASCII-only `slugify` maps every Cyrillic title to `''`, so the editor saved every one of
 * them as `untitled-task` and a second save overwrote the first. Here a title whose letters are ALL outside ASCII
 * (Cyrillic, CJK, Greek, …) slugs to `task-<6 hex>`, the hex being a 24-bit FNV-1a digest of the trimmed,
 * lowercased title over its code points — DETERMINISTIC on purpose: the editor re-derives the slug from the title
 * on every build of the spec (`task-spec-form.ts` `buildSpec`), so a random suffix would fork a new folder on each
 * save. A title with at least one ASCII letter, or with no letters at all (`'!!!'`, `'2026'`), slugs exactly as
 * upstream does (the CONTROL arm in `slug.test.ts`); collisions of the digest are handled where upstream handles
 * collisions — {@link uniqueTaskSlug} and the create-mode `task-slug-taken` refusal (UA3.4).
 *
 * Renderer-safe: this module imports nothing (no `fs`, no `crypto`), and `./tasks/slug` is its own export so the
 * renderer can take it without the barrel's Node code (`storage.ts`).
 *
 * NOTE: the kanban TaskEditor keeps its own `slugify` copy in
 * `apps/electron/src/renderer/components/app-shell/kanban/task-spec-form.ts` (UA3.6) — the renderer deliberately
 * does not import `@nessy-agent/shared/tasks` because this barrel re-exports Node (fs) code from storage.ts. Keep
 * the two implementations byte-identical (the copy carries the pointer back here).
 */

/**
 * Kebab-case a title into a task/node slug (max 48 chars). A title whose letters are all non-ASCII falls back to
 * `task-<6 hex>`, deterministic per title (see the module header).
 */
export const slugify = (s: string): string => {
  const ascii = s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!/\p{L}/u.test(s) || /[a-zA-Z]/.test(s)) return ascii;
  let h = 0x811c9dc5;
  for (const ch of s.trim().toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `task-${(h >>> 8).toString(16).padStart(6, '0')}`;
};

/**
 * First free slug derived from a title: `base`, `base-2`, `base-3`, …
 * Used by agent-driven task creation, which must never overwrite an existing
 * task (unlike the TaskEditor, where re-saving the same slug IS the edit flow).
 */
export function uniqueTaskSlug(title: string, taken: ReadonlySet<string>): string {
  const base = slugify(title) || 'task';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 48 - `-${n}`.length)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
