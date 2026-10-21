/**
 * P6.148 — the declarations moved to `@nessy-agent/shared`'s web-search module
 * so the host session tool, the codex subprocess and Pi all speak one result
 * shape. Re-exported here because every provider in this directory imports them
 * by this path; reached by relative path, the route the other shared readers in
 * this directory already travel (this package does not declare
 * `@nessy-agent/shared` as a dependency).
 */
export type {
  WebSearchProvider,
  WebSearchResult,
} from '../../../../shared/src/tools/web-search/types.ts';
