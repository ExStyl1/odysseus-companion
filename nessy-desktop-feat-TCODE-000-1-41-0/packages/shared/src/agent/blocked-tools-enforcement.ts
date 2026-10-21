/**
 * Which `blockedTools` declarations the runtime actually honours — and which
 * branch decides instead when it does not.
 *
 * ## The claim this exists to stop
 *
 * `permissions.json`'s `blockedTools` is EXACT tool names tested against a Set,
 * and that test is the LAST branch of `shouldAllowToolInMode`. Four earlier
 * returns make a declared name inert, and until this module there was no
 * predicate anywhere: the Permissions page rendered every declared name as a
 * BLOCKED row, so a user who wrote `blockedTools: ["Bash"]` read a safety claim
 * the runtime never made. The schema's own docblock
 * ({@link import('./mode-types.ts').PermissionsConfigSchema}) records the same
 * three causes in prose; this is the executable form.
 *
 * ## Measured, not read (2026-09-04, P3.351)
 *
 * Driven through the real gate with two workspaces — one declaring the name,
 * one not — in explore AND plan, the verdict was IDENTICAL for every name this
 * module classifies as pre-empted:
 *
 * ```
 * WebFetch WebSearch Read TodoWrite              declared=allowed  undeclared=allowed
 * mcp__session__read_mcp_resource anything__Read declared=allowed  undeclared=allowed
 * browser_tool mcp__session__browser_tool
 *   browser_snapshot                             declared=allowed  undeclared=allowed
 * Bash {command:"ls -la"} (pattern-allowed)      declared=allowed  undeclared=allowed
 * SomeRealTool                                   declared=BLOCKED  undeclared=allowed
 * ```
 *
 * Only the last line is the `blockedTools` branch doing anything.
 *
 * ## The two impostors a naive verdict probe scores green
 *
 * Asking only "is the call denied?" mislabels two names as enforced:
 *
 *   - **`Bash`** is decided by the read-only command classifier, which runs
 *     BEFORE this list. A non-read-only command is refused — so a probe that
 *     drives `rm -rf` sees a block and concludes the declaration worked. It did
 *     not: the identical refusal happens with no declaration at all, and a
 *     read-only command RUNS with `Bash` declared. This is why the classifier
 *     below is keyed on the branch that decides, not on the verdict.
 *   - **`Write`/`Edit`/`MultiEdit`/`NotebookEdit`** reach a path-containment
 *     branch first, which can refuse with its own "target not in allowed
 *     folders" message. They are NOT reported here, because they are the
 *     hardcoded default four and the `blockedTools` branch does still refuse
 *     them when the path branch falls through — the user-facing BLOCKED claim
 *     is true for them, only the reason differs.
 *
 * ## Why the always-allowed set is a PARAMETER
 *
 * There must be exactly one copy of it, and this module is not it: the source
 * of truth is `ALWAYS_ALLOWED_TOOLS` in `mode-manager.ts`, the same constant
 * `shouldAllowToolInMode` consults. This module does not import it, because
 * `mode-manager.ts` reaches 193 node-builtin import edges across 274 files
 * (measured 2026-09-04) and this predicate has to stay reachable from the
 * renderer, where a `fs`/`os` edge is not free. A required parameter leaves
 * nowhere for a second copy to hide, and
 * `__tests__/blocked-tools-enforcement.test.ts` pins every classification
 * against the real constant so the two cannot drift.
 *
 * The renderer obtains that one copy through `agent/always-allowed-tools.ts`,
 * a leaf holding the NAMES with no imports of its own, which `mode-manager.ts`
 * builds its Set from (P3.351's wiring, 2026-09-04). So a caller has no excuse
 * to pass a literal: the real list is importable from anywhere.
 *
 * The suffix rule is WIDER than the documentation's phrasing: the gate matches
 * any name ending `__<always-allowed-name>`, not only `mcp__…__` spellings, so
 * `anything__Read` is pre-empted too (measured above).
 */

import { isBrowserToolNameOrAlias } from './browser-tool-names.ts';

/** Which earlier branch of `shouldAllowToolInMode` decides instead of the list. */
export type BlockedToolPreemption =
  /** The name is itself an always-allowed read-only tool. */
  | { kind: 'always-allowed'; matched: string }
  /** The name ends `__<always-allowed-name>`; `matched` is that name. */
  | { kind: 'always-allowed-suffix'; matched: string }
  /** Any browser-tool spelling — decided on the browser COMMAND, not the name. */
  | { kind: 'browser-tool' }
  /** `Bash` — decided by the read-only command classifier. */
  | { kind: 'bash-classifier' };

/** Every `kind` this module can report, for exhaustive rendering and tests. */
export const BLOCKED_TOOL_PREEMPTION_KINDS = [
  'always-allowed',
  'always-allowed-suffix',
  'browser-tool',
  'bash-classifier',
] as const satisfies readonly BlockedToolPreemption['kind'][];

/**
 * Classify one declared `blockedTools` entry.
 *
 * Returns `null` when the declaration reaches the `blockedTools` branch and is
 * honoured in the read-only modes; otherwise the branch that pre-empts it.
 *
 * The order below MIRRORS `shouldAllowToolInMode`'s and must keep mirroring it:
 * exact always-allowed, then the `__<name>` suffix, then the browser tool, then
 * `Bash`. A name matching two rules is reported under the one that fires first
 * in the gate, because that is the branch a user has to argue with.
 *
 * @param toolName the exact name as written in `permissions.json`
 * @param alwaysAllowedTools `ALWAYS_ALLOWED_TOOLS` from `mode-manager.ts` — see
 *   the module docblock for why this is passed in rather than imported
 */
export function classifyBlockedToolDeclaration(
  toolName: string,
  alwaysAllowedTools: Iterable<string>,
): BlockedToolPreemption | null {
  const allowed = alwaysAllowedTools instanceof Set
    ? alwaysAllowedTools as ReadonlySet<string>
    : new Set(alwaysAllowedTools);

  if (allowed.has(toolName)) return { kind: 'always-allowed', matched: toolName };

  for (const allowedTool of allowed) {
    if (toolName.endsWith(`__${allowedTool}`)) {
      return { kind: 'always-allowed-suffix', matched: allowedTool };
    }
  }

  if (isBrowserToolNameOrAlias(toolName)) return { kind: 'browser-tool' };

  if (toolName === 'Bash') return { kind: 'bash-classifier' };

  return null;
}

/** One declared entry the runtime never consults, with the branch that won. */
export interface UnenforceableBlockedTool {
  tool: string;
  preemption: BlockedToolPreemption;
}

/**
 * Split a declared `blockedTools` list into the entries the runtime honours and
 * the entries something earlier already decided.
 *
 * Order within each side is the declaration order, so a surface can render the
 * user's own file back to them without reshuffling it.
 */
export function partitionBlockedToolDeclarations(
  toolNames: readonly string[],
  alwaysAllowedTools: Iterable<string>,
): { enforced: string[]; unenforceable: UnenforceableBlockedTool[] } {
  const allowed = new Set(alwaysAllowedTools);
  const enforced: string[] = [];
  const unenforceable: UnenforceableBlockedTool[] = [];
  for (const tool of toolNames) {
    const preemption = classifyBlockedToolDeclaration(tool, allowed);
    if (preemption) unenforceable.push({ tool, preemption });
    else enforced.push(tool);
  }
  return { enforced, unenforceable };
}
