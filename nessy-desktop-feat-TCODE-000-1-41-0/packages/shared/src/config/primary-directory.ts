import { isAbsolute, resolve, sep } from 'node:path';

/**
 * C3.178 — WHICH attached folder is primary, as a user CHOICE rather than a
 * derivation.
 *
 * ## What "primary" is here, and what it deliberately is NOT
 *
 * A session has one primary root and a list of other roots. Until this module
 * the primary one was DERIVED and never chosen — `packages/server-core/src/sessions/SessionManager.ts`
 * symbol `getPiHarnessRuntimeSnapshot` computes it as
 * `projectKey ? workingDirectory : workspace.rootPath` — and added roots were
 * accepted in configured order with no primary flag at all.
 *
 * **P6.929 already answered the half this row must not build.** It closed by
 * record on 2026-09-10 with option (b): *the primary folder is a DISPLAY and
 * ORDERING choice; discovery stays on the project root.* So nothing here may
 * reach instruction discovery — `AGENTS.md`, skills, `config.toml` and the
 * project-root markers keep resolving from the project root exactly as they did
 * — and nothing here may reach the filesystem AUTHORITY either.
 *
 * That second constraint is why {@link resolveSessionPrimaryRoot} takes the
 * already-attached roots as an argument and refuses anything outside them: the
 * choice can only REORDER a set the user already granted, so no value of this
 * setting can widen what a session may read or write. Widening a root stays
 * what it already is — the explicit `additionalDirectories` setting, or the
 * outside-root approval flow — and this key is not a second way in.
 *
 * ## Why a top-level key and not a workspace default
 *
 * `additionalDirectories` — the list this choice picks from — is itself a
 * top-level key of `config.json` read by `agent/additional-directories.ts` out
 * of `loadStoredConfig()`, with no workspace or project layer by construction.
 * A primary flag that lived somewhere else could name a folder the list does not
 * contain. Declared in BOTH envelopes in `config/validators.ts` in the same
 * commit as this file, because `StoredConfigTopLevelSchema` is `.strict()` and
 * an undeclared top-level key does not get ignored — it refuses the whole
 * `config.json` and costs the user every OTHER setting in it.
 */
export const PRIMARY_DIRECTORY_SETTING_KEY = 'primaryDirectory';

/** Where the effective primary root came from. */
export type PrimaryRootSourceV1 = 'derived' | 'chosen';

/**
 * Why a stored choice was not applied. Always accompanied by the DERIVED root,
 * so a refusal degrades to today's behaviour and never to no behaviour.
 */
export type PrimaryRootRefusalV1 =
  /** Not an absolute path — a relative primary has nothing stable to resolve against. */
  | 'primary-directory-not-absolute'
  /** Names a folder this session has not attached; see the authority note above. */
  | 'primary-directory-not-attached';

export interface PrimaryRootResolutionV1 {
  /** The root to display first and order by. Never wider than the input set. */
  readonly primaryRoot: string;
  readonly source: PrimaryRootSourceV1;
  readonly refusal?: PrimaryRootRefusalV1;
}

/**
 * Path-normalised comparison: `resolve()` plus a stripped trailing separator.
 *
 * Deliberately NOT `realpathSync` and not `canonicalizeForDecision`. This is a
 * display choice over paths the user typed, and a symlinked spelling of the
 * same folder is their own spelling; resolving it would also put a filesystem
 * read on a purely presentational comparison. Nothing security-relevant rests
 * on it — the result is constrained to the input set either way.
 */
function normalizeForChoice(value: string): string {
  const resolved = resolve(value.trim());
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

/**
 * The effective primary root for one session.
 *
 * With no stored choice the answer is byte-identical to the derivation, which is
 * the row's positive control: an install that never opens the control behaves
 * exactly as it did before this key existed.
 */
export function resolveSessionPrimaryRoot(input: {
  /** `projectKey ? workingDirectory : workspace.rootPath` — today's value. */
  derivedPrimaryRoot: string;
  /** The folders this session has already attached, in configured order. */
  attachedRoots?: readonly string[] | undefined;
  /** The stored `primaryDirectory`, when the user has made a choice. */
  choice?: string | undefined;
}): PrimaryRootResolutionV1 {
  const derived = input.derivedPrimaryRoot;
  const choice = typeof input.choice === 'string' ? input.choice.trim() : '';
  if (choice.length === 0) return { primaryRoot: derived, source: 'derived' };
  if (!isAbsolute(choice)) {
    return { primaryRoot: derived, source: 'derived', refusal: 'primary-directory-not-absolute' };
  }
  const wanted = normalizeForChoice(choice);
  // The derived root is itself a legal choice: it is what the user is choosing
  // to KEEP, and storing it explicitly is what lets the control show a settled
  // answer rather than an empty one.
  const candidates = [derived, ...(input.attachedRoots ?? [])];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue;
    if (normalizeForChoice(candidate) !== wanted) continue;
    return { primaryRoot: candidate, source: 'chosen' };
  }
  return { primaryRoot: derived, source: 'derived', refusal: 'primary-directory-not-attached' };
}

/**
 * The ORDERING half of P6.929's answer: the primary folder first, every other
 * attached folder after it in its configured order.
 *
 * A pure reordering of the SAME set — never a filter and never an addition — so
 * a caller that feeds it a permission-relevant list cannot change what that list
 * permits. Duplicates (a folder listed twice, or one that equals the primary)
 * collapse to the single first occurrence, which is what a list rendered to a
 * user should show.
 *
 * ## C3.305 — it has NO CONSUMER, and that is a measured finding rather than an
 * omission. Read this before wiring one.
 *
 * The row that went looking for the consumer W17-h proposed
 * (`codexAdditionalWritableRoots`, *"no authority change, but it touches the
 * codex config writer's bytes"*) **refuted that premise on the rig**. Every
 * candidate reader of the configured-roots ORDER, and why each one is refused:
 *
 * 1. **codex's `writablePaths` — the order never reaches the file.**
 *    `resolveCodexRuntimePathPolicy`
 *    (`packages/codex-responses-adapter/src/config-writer-permissions.ts`) builds
 *    its `filesystem` map from `normalizeRuntimePaths`, which ends in `.sort()`.
 *    Measured 2026-09-12: the same three roots handed in as
 *    `[zulu, middle, alpha]` and as `[alpha, middle, zulu]` both produce
 *    `["…/alpha","…/middle","…/zulu"]`, and the emitted config text is identical
 *    (pinned in `agent/__tests__/codex-additional-directories.test.ts`). A
 *    reordering applied upstream of that sort is dead code. Its two other
 *    consumers sort as well: the re-fork override `.sort()`s the union because
 *    `codexThreadConfigSignature` HASHES that object, so a display choice must
 *    not re-fork a live thread, and `codexSkillExtraRoots` sorts its own output.
 * 2. **claude's `additionalDirectories` — the order is load-bearing, so a
 *    DISPLAY choice must not touch it.** `buildClaudeAdditionalDirectoriesOptions`
 *    (`agent/claude-agent.ts`) says in its own docblock that *"two added roots
 *    defining the same command name are resolved by order and a reorder is a
 *    real change"*, and `claudeLiveSessionSignature` hashes the option unsorted
 *    for that reason. Reordering it would change which root wins a duplicate
 *    command name — a discovery effect P6.929 option (b) rules out — and would
 *    respawn the live session every time the setting changed.
 * 3. **`additionalRuleDirectories` (`server-core/src/bootstrap/storage-runtime.ts`)
 *    and the MCP pool's `roots/list`
 *    (`server-core/src/mcp/workspace-mcp-pool-registry.ts`) — discovery, again.**
 *    The first decides where instruction files are read from; the second reports
 *    the roots to every MCP server in a pool SHARED across sessions, with the
 *    workspace root first, and a server that treats the first root as the project
 *    would then look somewhere else.
 * 4. **The primary-folder picker itself
 *    (`server-core/src/handlers/rpc/settings.ts`, `primaryDirectory.GET`) — the
 *    right kind of surface, the wrong kind of control.** Its candidates render
 *    as `SettingsSelect` options, and moving the current selection to the top of
 *    a select is not what a select does.
 *
 * **The one honest consumer is not reachable from here.** The only place a user
 * meets this list in configured order today is the permission gate's refusal
 * text — `agent/mode-manager.ts`, the `Additional:` block and the
 * `Additional directory:` hints — which is display with zero authority reach.
 * The gate has no primary root in scope and its list arrives pre-built from
 * `SessionManager.sessionAdditionalDirectories`, so ordering it is a caller
 * change in the host rather than an argument this module can be handed. Recorded
 * as a proposed row by W18-d instead of half-built here.
 *
 * So this function is kept, unwired, on purpose: it is the expression of an
 * owner-recorded decision (P6.929 option (b)) and its own suite pins that it can
 * never become a filter. **A wiring that does not appear in the list above is
 * either the host caller named in the paragraph above, or a claim that one of
 * those four readings has changed — re-measure it and say which.**
 */
export function orderAttachedRoots(
  roots: readonly string[],
  primaryRoot: string,
): string[] {
  const wanted = normalizeForChoice(primaryRoot);
  const seen = new Set<string>();
  const primaryFirst: string[] = [];
  const rest: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string' || root.trim().length === 0) continue;
    const key = normalizeForChoice(root);
    if (seen.has(key)) continue;
    seen.add(key);
    (key === wanted ? primaryFirst : rest).push(root);
  }
  return [...primaryFirst, ...rest];
}
