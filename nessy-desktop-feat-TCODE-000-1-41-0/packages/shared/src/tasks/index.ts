/**
 * UA3.2 — copied from craft-agents-oss `v0.13.4:packages/shared/src/tasks/index.ts` (Apache-2.0), rebranded
 * (`@craft-agent` → `@nessy-agent`). This barrel re-exports Node (`fs`) code from `storage.ts`; the renderer takes
 * `@nessy-agent/shared/tasks/slug` instead.
 */
/**
 * @nessy-agent/shared/tasks
 *
 * task.yaml spec (schema + types), reference grammar, graph validation, and
 * filesystem persistence for the Tasks feature. The in-process Conductor lives
 * in packages/server-core/src/tasks/ and builds on these primitives.
 */
export * from './schema.ts';
export * from './slug.ts';
export * from './refs.ts';
export * from './validate.ts';
export * from './storage.ts';
export * from './generator-prompt.ts';
export * from './generate-limits.ts'; // UA4.5 — also `@nessy-agent/shared/tasks/generate-limits` (renderer-safe)
