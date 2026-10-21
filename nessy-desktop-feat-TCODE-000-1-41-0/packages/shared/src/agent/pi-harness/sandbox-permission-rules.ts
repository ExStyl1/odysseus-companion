import { latchedHomeDir } from '../../config/home-latch.ts';
import { dirname, isAbsolute, join } from 'node:path';
import type { SandboxSettingsV1 } from '../../config/sandbox-settings.ts';
import { parseClaudeRuleString } from './claude-permission-rules.ts';

/**
 * The three Read/Edit permission-rule forms the sandbox boundary consumes.
 *
 * `sandboxing.md:372` — "Paths from both `sandbox.filesystem` settings and
 * permission rules are merged together into the final sandbox configuration."
 * The per-key mapping has one section per key on `settings-reference.md`:
 *
 * | key | anchor | doc sentence |
 * | --- | --- | --- |
 * | `filesystem.allowWrite` | `#sandbox-filesystem-allowwrite` | "Claude Code merges entries across every settings scope the session loads: user, project, local, and managed paths combine rather than replace each other, and Claude Code adds the paths from your `Edit(...)` allow permission rules." |
 * | `filesystem.denyWrite`  | `#sandbox-filesystem-denywrite`  | "Claude Code merges entries across every settings scope the session loads, and adds the paths from your `Edit(...)` deny permission rules." |
 * | `filesystem.denyRead`   | `#sandbox-filesystem-denyread`   | "Claude Code merges entries across every settings scope the session loads, and adds the paths from your `Read(...)` deny permission rules." |
 *
 * and `sandboxing.md:366`–`:367` restates it as behaviour: `Edit` allow rules
 * "Grant write access to specific paths, the same way
 * `sandbox.filesystem.allowWrite` does"; `Read` and `Edit` deny rules "Block
 * access to specific files or directories".
 */
export interface SandboxRootsFromRules {
  /** `Edit(...)` allow → `sandbox.filesystem.allowWrite`. */
  additionalWritableRoots: readonly string[];
  /** `Edit(...)` deny → `sandbox.filesystem.denyWrite`. */
  deniedWriteRoots: readonly string[];
  /** `Read(...)` deny → `sandbox.filesystem.denyRead`. */
  deniedReadRoots: readonly string[];
  /** One line per rule that named a path the boundary cannot represent. */
  diagnostics: readonly string[];
}

/** Claude's three rule lists, in the shape a managed policy stores them. */
export interface ClaudeRuleLists {
  readonly allow?: readonly string[];
  readonly ask?: readonly string[];
  readonly deny?: readonly string[];
}

const EMPTY: SandboxRootsFromRules = Object.freeze({
  additionalWritableRoots: Object.freeze([]),
  deniedWriteRoots: Object.freeze([]),
  deniedReadRoots: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

/** `Tool(specifier)` — the tool half only; the specifier is the parser's job. */
const RULE_TOOL = /^([A-Za-z][A-Za-z0-9_-]*)\s*\(/;

/**
 * The literal directory a `pathGlob` pattern names, or `undefined`.
 *
 * Deliberately narrow: a bare literal (`etc/shadow`) and a whole-subtree glob
 * (`tmp/build/**`) are the only two forms accepted, because they are the only
 * two that convert to an OS subpath boundary EXACTLY. Every backend expresses
 * a filesystem rule as "this path and everything under it"
 * (`(subpath …)`, `--bind`, `":path" = …`), so `tmp/build/**` is that boundary
 * verbatim while `tmp/*` + '/'+ `secret` is not: reducing it to its literal
 * prefix would grant or deny `/tmp` entirely. A rule the boundary cannot state
 * exactly is skipped with a diagnostic rather than approximated — an
 * approximation in the allow direction is a silent widening, and one in the
 * deny direction blocks paths the administrator never named.
 *
 * The permission layer still enforces the skipped rule in full; only the OS
 * boundary declines to restate it.
 */
function literalRootPattern(pattern: string): string | undefined {
  const literal = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
  if (literal.length === 0) return undefined;
  if (/[*?[\]]/.test(literal)) return undefined;
  return literal;
}

/**
 * Convert one settings scope's Claude permission rules into sandbox roots.
 *
 * Anchors follow `permissions.md`'s four Read/Edit forms, of which only two
 * resolve without a request: `//abs` and `~/home`. A `/source`-anchored rule
 * needs the declaring settings source's root (a managed policy has none, and
 * `parseManagedClaudeRulesV1` already refuses it upstream) and a relative rule
 * needs the request cwd, which a process-lifetime boundary does not have. Both
 * are skipped with a diagnostic.
 *
 * Pure and never throws: a rule list that fails to convert must not stop the
 * host from resolving a sandbox at all.
 */
export function sandboxRootsFromClaudeRules(
  rules: ClaudeRuleLists | undefined,
  options: { home?: string } = {},
): SandboxRootsFromRules {
  if (!rules) return EMPTY;
  // `latchedHomeDir()` and not `homedir()` — P3.168. The `~/` anchor here
  // expands the deny/allow roots this file hands the sandbox, and a confirmed
  // managed `HOME` moves `os.homedir()` mid-session on Node. An explicit
  // `options.home` still wins: callers that know the boundary's home pass it.
  const home = options.home ?? latchedHomeDir();
  const additionalWritableRoots: string[] = [];
  const deniedWriteRoots: string[] = [];
  const deniedReadRoots: string[] = [];
  const diagnostics: string[] = [];

  const convert = (action: 'allow' | 'deny', entries: readonly string[] | undefined): void => {
    for (const entry of entries ?? []) {
      const tool = RULE_TOOL.exec(entry.trim())?.[1];
      if (tool !== 'Read' && tool !== 'Edit') continue;
      // `Read` allow rules have no sandbox target: reads are ambient-allowed by
      // every isolation profile, so there is nothing for an allow to open.
      if (tool === 'Read' && action === 'allow') continue;
      const parsed = parseClaudeRuleString(entry, action);
      const match = parsed.rule?.match;
      if (!match || match.kind !== 'pathGlob' || typeof match.pattern !== 'string') continue;
      if (match.anchor !== 'absolute' && match.anchor !== 'home') {
        diagnostics.push(
          `Permission ${action} rule "${entry}" is anchored to a settings source or the working directory,`
          + ' which the process-lifetime sandbox boundary cannot resolve; the permission layer still enforces it.',
        );
        continue;
      }
      const literal = literalRootPattern(match.pattern);
      if (literal === undefined) {
        diagnostics.push(
          `Permission ${action} rule "${entry}" names a partial glob, which has no exact filesystem-subpath`
          + ' equivalent; the permission layer still enforces it.',
        );
        continue;
      }
      const root = match.anchor === 'home' ? join(home, literal) : join('/', literal);
      // The same two refusals every other sandbox-root producer makes: a
      // non-absolute or filesystem-root entry never reaches a backend.
      if (!isAbsolute(root) || dirname(root) === root) {
        diagnostics.push(
          `Permission ${action} rule "${entry}" resolves to the filesystem root and is refused as a sandbox root.`,
        );
        continue;
      }
      if (action === 'deny') (tool === 'Read' ? deniedReadRoots : deniedWriteRoots).push(root);
      else additionalWritableRoots.push(root);
    }
  };

  // `ask` is deliberately absent: the sandbox boundary has no "prompt" state,
  // and an ask rule is enforced by the permission layer alone.
  convert('allow', rules.allow);
  convert('deny', rules.deny);

  return Object.freeze({
    additionalWritableRoots: Object.freeze([...new Set(additionalWritableRoots)]),
    deniedWriteRoots: Object.freeze([...new Set(deniedWriteRoots)]),
    deniedReadRoots: Object.freeze([...new Set(deniedReadRoots)]),
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * Fold rule-derived roots into a host sandbox FLOOR and the layer list.
 *
 * The two directions compose differently, and getting it wrong is how a merge
 * that is supposed to widen ends up narrowing:
 *
 * - Denies RESTRICT, so they always ride the floor: `resolveSandboxSettings`
 *   treats a floor deny as a minimum every layer adds to.
 * - Grants are CAPPED by the floor — a floor that names `additionalWritableRoots`
 *   makes its list the complete one. So a rule-derived grant joins the floor
 *   only when the administrator already capped grants (they authored both);
 *   otherwise it becomes an ordinary extra LAYER, which concatenates and
 *   leaves the user's own `allowWrite` entries intact.
 */
export function foldSandboxRuleRoots(
  floor: SandboxSettingsV1,
  roots: SandboxRootsFromRules,
): { floor: SandboxSettingsV1; layers: readonly SandboxSettingsV1[] } {
  // BOTH spellings of the grant list cap grants.
  // `settings-reference.md#sandbox-filesystem` merges rule-derived paths with
  // `filesystem.allowWrite` — "Claude Code adds your permission rules to the
  // same lists: `Edit` allow and deny rules to `allowWrite` and `denyWrite`,
  // `Read` deny rules to `denyRead`" — and a floor written in the
  // documented nested spelling is still a cap — reading only the flat alias sends
  // the rule-derived grant to a LAYER that the floor then caps away, losing it
  // silently. The merge writes back into whichever key the floor actually used, so
  // the two spellings produce the same list in the same order rather than one
  // capped list split across two keys.
  const flatCaps = floor.additionalWritableRoots !== undefined;
  const nestedCaps = floor.filesystem?.allowWrite !== undefined;
  const floorCapsGrants = flatCaps || nestedCaps;
  const grantsMerge = floorCapsGrants && roots.additionalWritableRoots.length > 0;
  const mergedFloor: SandboxSettingsV1 = {
    ...floor,
    ...(roots.deniedReadRoots.length
      ? { deniedReadRoots: [...(floor.deniedReadRoots ?? []), ...roots.deniedReadRoots] }
      : {}),
    ...(roots.deniedWriteRoots.length
      ? { deniedWriteRoots: [...(floor.deniedWriteRoots ?? []), ...roots.deniedWriteRoots] }
      : {}),
    ...(grantsMerge && flatCaps
      ? { additionalWritableRoots: [...(floor.additionalWritableRoots ?? []), ...roots.additionalWritableRoots] }
      : {}),
    ...(grantsMerge && !flatCaps
      ? {
        filesystem: {
          ...floor.filesystem,
          allowWrite: [...(floor.filesystem?.allowWrite ?? []), ...roots.additionalWritableRoots],
        },
      }
      : {}),
  };
  const layers = !floorCapsGrants && roots.additionalWritableRoots.length
    ? [{ additionalWritableRoots: roots.additionalWritableRoots }]
    : [];
  return { floor: mergedFloor, layers };
}

/**
 * Convert this product's own `permissions.deniedPaths` globs into sandbox read
 * denials — F1.107 (origin `D1.432`).
 *
 * The sibling above converts CLAUDE's `Read(...)`/`Edit(...)` rule strings;
 * this one converts the list `shouldAllowToolInMode` enforces per tool
 * (`mode-manager.ts` symbol `matchesDeniedPath`). They are separate
 * vocabularies with separate readers, and only the first had a sandbox
 * projection: a path an administrator denied was refused to `Read`/`Grep`/`Glob`
 * and readable to any script `script_sandbox` ran, because that tool's input
 * carries no path for the per-tool gate to look at.
 *
 * ## Only the two exactly-convertible forms, for the sibling's reason
 *
 * `literalRootPattern`'s rule is reused verbatim rather than restated: every
 * backend expresses a filesystem rule as "this path and everything under it",
 * so a home-anchored whole-subtree entry converts EXACTLY and an any-depth
 * dotenv pattern does not — reducing
 * that to a prefix would deny the filesystem root. A pattern the boundary
 * cannot state exactly is skipped with a diagnostic and stays enforced by the
 * permission layer, which is where it was already enforced.
 *
 * **So this is deliberately a SUBSET, and the shipped floor is mostly outside
 * it**: of `SAFE_MODE_CONFIG.deniedPaths`' entries, every home-anchored one
 * converts and every any-depth one does not — the dotenv pair and the in-repo
 * glab credential store are all written any-depth-first (their spellings are
 * left to the constant, because a star-slash inside a block comment closes it).
 * That is not a regression — those patterns
 * reached the sandbox not at all before — and the converted ones are worth
 * having on their own: they are exactly the entries an operator adds when they
 * name a directory of theirs.
 *
 * Anchors follow the `deniedPaths` vocabulary, which is the one
 * `claude-denied-path-rules.ts` symbol `translatePattern` reads from: a tilde
 * and a slash is home, a single leading slash is absolute, a leading
 * double-star is any-depth, and anything else is unanchored. Pure and never
 * throws, for the sibling's reason.
 */
export function sandboxRootsFromDeniedPaths(
  deniedPaths: readonly string[] | undefined,
  options: { home?: string } = {},
): { readonly roots: readonly string[]; readonly diagnostics: readonly string[] } {
  const home = options.home ?? latchedHomeDir();
  const roots: string[] = [];
  const diagnostics: string[] = [];

  for (const raw of deniedPaths ?? []) {
    const pattern = raw.trim();
    if (pattern.length === 0) continue;
    const homeAnchored = pattern.startsWith('~/');
    const absolute = pattern.startsWith('/');
    if (!homeAnchored && !absolute) {
      diagnostics.push(
        `deniedPaths entry "${pattern}" is not anchored to the home directory or the filesystem root,`
        + ' so the process-lifetime sandbox boundary cannot resolve it; the permission layer still enforces it.',
      );
      continue;
    }
    const literal = literalRootPattern(homeAnchored ? pattern.slice(2) : pattern.slice(1));
    if (literal === undefined) {
      diagnostics.push(
        `deniedPaths entry "${pattern}" names a partial glob, which has no exact filesystem-subpath`
        + ' equivalent; the permission layer still enforces it.',
      );
      continue;
    }
    const root = homeAnchored ? join(home, literal) : join('/', literal);
    if (!isAbsolute(root) || dirname(root) === root) {
      diagnostics.push(
        `deniedPaths entry "${pattern}" resolves to the filesystem root and is refused as a sandbox root.`,
      );
      continue;
    }
    roots.push(root);
  }

  return { roots: [...new Set(roots)], diagnostics };
}
