/**
 * Shared slug utilities (browser-safe, pure)
 *
 * One kebab-and-collision implementation for workspace entities (Projects,
 * Pages, ...) instead of per-module copies. Callers supply the existing slug
 * set — no filesystem access here.
 *
 * UA1.6 — copied from craft-agents-oss `v0.13.4:packages/shared/src/utils/slug.ts`
 * (Apache-2.0), unchanged. Its consumers are the projects and pages storage
 * modules of later UA rows (UA5.x, UA6.x).
 */

/** Kebab-case a display name: lowercase, alphanumerics, single hyphens, max 50 chars. */
export function slugifyName(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);
  return slug || fallback;
}

/**
 * Kebab-case a name and de-collide against existing slugs by appending
 * `-2`, `-3`, … (matches the historical Projects behavior).
 */
export function generateUniqueSlug(
  name: string,
  existingSlugs: ReadonlySet<string>,
  fallback: string,
): string {
  const slug = slugifyName(name, fallback);
  if (!existingSlugs.has(slug)) return slug;

  let counter = 2;
  while (existingSlugs.has(`${slug}-${counter}`)) counter++;
  return `${slug}-${counter}`;
}
