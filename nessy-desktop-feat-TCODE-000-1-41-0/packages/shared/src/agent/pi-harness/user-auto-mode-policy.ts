/**
 * The USER scope's `autoMode` block — P6.493's reader half.
 *
 * `resolveAutoMode` has accepted a `user` scope and narrowed it to
 * `hard_deny`/`soft_deny` since `e473ec877` (delegated decision Q-den 2 = C:
 * a developer may TIGHTEN the safety judge and may never loosen it). Nothing
 * built such a block, so the narrowing guarded a path no document could reach:
 * the one production caller, `SessionManager`, passes `managed` alone. This
 * module is what reads the block; the trust boundary stays exactly where it
 * was, inside `resolveAutoMode`, so there is still one place it is decided.
 *
 * The file is the one the page names for this scope.
 * `auto-mode-config.md#where-the-classifier-reads-configuration` lists the user
 * scope and then concedes the consequence of the vendor's own additive rule:
 * *"Because allow rules act as exceptions to soft block rules inside the
 * classifier, a developer-added `allow` entry can override an organization
 * `soft_deny` entry: the combination is additive, not a hard policy boundary."*
 * That sentence is the argument for the narrowing, and it is why this reader
 * hands back the refused keys BY NAME rather than dropping them in silence:
 * entries that simply do not apply, with nothing said, are the defect the row
 * exists to fix.
 *
 * NOT read here, on purpose:
 *   - `project` and `local`. Both live in the repository, so a checked-in file
 *     or a build step could otherwise steer the judge. `resolveAutoMode` takes
 *     a `project` scope and discards it for the same reason; this reader does
 *     not even open the files.
 *   - `classifyAllShell`. It is a BAND control — it changes which actions reach
 *     the judge, not what the judge is told — and `SessionManager` resolves it
 *     from the managed scope alone. Parsing it here and never handing it on
 *     would be a promise this module does not keep, so
 *     {@link readUserScopeAutoModePolicy} strips it and names it among the
 *     refused keys.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parsePermissionJsonc } from './permission-dsl.ts';
import {
  MANAGED_ONLY_AUTO_MODE_KEYS,
  parseUserScopeAutoModePolicyV1,
  refusedUserAutoModeKeys,
  type ManagedAutoModePolicyV1,
} from './managed-policy.ts';

/** `~/.claude/settings.json` — the file `settings-reference.md#scopes` calls `User`. */
const CLAUDE_USER_SETTINGS_FILE = 'settings.json';

/** A settings file this size is not a settings file; refuse to read it. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

/**
 * `~/.claude`, or wherever `CLAUDE_CONFIG_DIR` moved it — `env-vars.md#variables`:
 * "Override the configuration directory (default: `~/.claude`). All settings,
 * session history, and plugins are stored under this path".
 *
 * Same derivation `agent/memory/instruction-excludes.ts` makes for the same
 * scope, and it carries the same residue: a Workspace redirects the CHILD's
 * config dir, and this default follows only when the host's own environment
 * carries the value. A caller that knows the workspace passes the directory.
 */
function defaultClaudeConfigDirectory(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.claude');
}

export interface UserScopeAutoModeReadV1 {
  /**
   * What survives the read, ready to hand to `resolveAutoMode` as its `user`
   * scope. `undefined` when the file is absent, carries no `autoMode`, or was
   * refused — all three contribute nothing, which is the safe direction for a
   * scope that may only narrow.
   */
  readonly policy?: ManagedAutoModePolicyV1;
  /**
   * Keys the block carried that this fork keeps administrator-only, in page
   * order. Non-empty means the caller OWES the developer a diagnostic naming
   * the key and naming managed settings as its only home.
   *
   * A key present but EMPTY counts: writing `"allow": []` is a statement about
   * the allow set, and answering it with silence is the same defect.
   */
  readonly refusedKeys: readonly string[];
  /** The file consulted, so a diagnostic can name it. */
  readonly path: string;
  /**
   * Set when the block was refused WHOLESALE — the strict posture this parser
   * records for the user tier. The message never carries file content, only the
   * parser's own reason.
   */
  readonly invalidReason?: string;
}

/**
 * Read the user scope's `autoMode` block, or report why nothing was read.
 *
 * Never throws: an unreadable or malformed user settings file must not take a
 * session start down with it, which is the same posture
 * `resolveManagedPiPolicyFloor` takes for the managed document.
 */
export function readUserScopeAutoModePolicy(
  options?: { readonly claudeConfigDirectory?: string },
): UserScopeAutoModeReadV1 {
  const path = join(
    options?.claudeConfigDirectory ?? defaultClaudeConfigDirectory(),
    CLAUDE_USER_SETTINGS_FILE,
  );

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    // Absent is the ordinary case, not a fault: most developers write no
    // `autoMode` block at all.
    return { refusedKeys: [], path };
  }
  if (raw.length > MAX_SETTINGS_FILE_BYTES) {
    return { refusedKeys: [], path, invalidReason: 'settings file is too large to read' };
  }

  let document: unknown;
  try {
    document = parsePermissionJsonc(raw);
  } catch {
    return { refusedKeys: [], path, invalidReason: 'settings file is not valid JSON' };
  }

  const block = (document as { autoMode?: unknown } | null)?.autoMode;
  if (block === undefined || block === null) return { refusedKeys: [], path };

  let parsed: ManagedAutoModePolicyV1 | undefined;
  try {
    parsed = parseUserScopeAutoModePolicyV1(block);
  } catch {
    // Strict, per the parser's own recorded posture for this tier. The whole
    // block contributes nothing, and the caller can say so.
    return { refusedKeys: [], path, invalidReason: 'autoMode block is not valid' };
  }
  if (!parsed) return { refusedKeys: [], path };

  const refusedKeys = [
    ...refusedUserAutoModeKeys(parsed),
    ...(parsed.classifyAllShell === undefined ? [] : ['classifyAllShell']),
  ];

  // Hand on ONLY what `resolveAutoMode` will accept from this scope. The
  // narrowing there is the boundary; stripping here as well is not a second
  // guard to keep in sync but the same list read once — without it this module
  // would hand `resolveAutoMode` keys it silently drops, and the two halves of
  // the answer (what applies, what was refused) would disagree.
  const narrowed: Record<string, unknown> = { ...parsed };
  for (const key of [...MANAGED_ONLY_AUTO_MODE_KEYS, 'classifyAllShell']) delete narrowed[key];

  return {
    ...(Object.keys(narrowed).length > 0
      ? { policy: Object.freeze(narrowed) as ManagedAutoModePolicyV1 }
      : {}),
    refusedKeys: Object.freeze(refusedKeys),
    path,
  };
}

/**
 * The sentence a caller owes the developer when {@link UserScopeAutoModeReadV1.refusedKeys}
 * is non-empty — one place, so the doctor and the session say the same thing.
 *
 * Names the key and names managed settings as its only home. It does not
 * apologise for the asymmetry: tightening travels from a user's own settings
 * file, loosening does not, and that is the whole decision.
 */
export function describeRefusedUserAutoModeKeys(read: UserScopeAutoModeReadV1): string | undefined {
  if (read.refusedKeys.length === 0) return undefined;
  return `autoMode.${read.refusedKeys.join(', autoMode.')} in ${read.path} `
    + 'was not applied: only hard_deny and soft_deny travel from user settings, '
    + 'because a user scope may narrow the safety judge and never widen it. '
    + 'Managed settings are the only home for these keys.';
}
