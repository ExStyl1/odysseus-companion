import { isIP } from 'node:net';
import { isAbsolute, dirname, join, resolve } from 'node:path';
import { latchedHomeDir } from './home-latch.ts';
import { STRICT_DROP_SINK, toleratedList, sanitizeSettingsDiagnostic, type ManagedDropSink } from './managed-drops.ts';

/**
 * Sandbox settings for supervised process execution.
 *
 * ## What the `filesystem` keys here do and do NOT do
 *
 * **No isolation profile is a read boundary.** Every backend grants ambient
 * whole-filesystem read and scopes only *writes*: darwin emits
 * `(allow file-read*)`, linux binds `--ro-bind / /`, and win32 writes
 * `":root" = "read"`. The backend strings say so literally
 * (`…:host-read:write-workspace+scratch`).
 *
 * So `additionalWritableRoots` WIDENS write scope, and `deniedReadRoots` is an
 * explicit deny carved out of that default-allow read posture. Anything not named
 * in `deniedReadRoots` remains readable.
 *
 * A read ALLOWLIST is the pair of `deniedReadRoots` and
 * {@link SandboxFilesystemSettingsV1.allowRead}, exactly as
 * `sandboxing.md#configure-sandboxing` writes it: `"denyRead": ["~/"]` with
 * `"allowRead": ["~/projects"]` — "`~/projects` is readable and the rest of the
 * home directory is blocked". (This comment previously wrote the pair as
 * `"allowRead": ["."]` in quotation marks; that example is not on the page.) `allowRead` alone
 * grants nothing, because reads are already ambient. It is enforceable on darwin
 * only; the other two backends refuse the spawn rather than drop it.
 *
 * ## Merge semantics
 *
 * Layers are ordered least- to most-specific (managed → user → project → local).
 * List keys concat-and-dedupe across layers, preserving first-seen order; they
 * never replace. `allowUnsandboxedCommands` is boolean-AND across layers, so a
 * layer that locks strict sandbox mode cannot be re-opened by a more specific
 * one. `enabled` is a third, distinct mode — not concat, not boolean-AND: a
 * managed value wins OUTRIGHT in either direction, else the most specific
 * layer that sets it, else {@link SANDBOX_ENABLED_DEFAULT}. See
 * {@link resolveSandboxEnabled}.
 *
 * Citation provenance for this file, stated per PAGE rather than as one claim
 * over all of them.
 *
 * - `sandboxing.md`: every citation below names the page's own SECTION ANCHOR and
 *   every quote was re-measured verbatim against the 2026-08-25 fetch
 *   (`curl -s https://code.claude.com/docs/en/sandboxing.md`, HTTP 200, 677 lines,
 *   md5 `3538c3dd04b83d8bbaa35d0fad0ccb88`). Line numbers are gone because this
 *   page's have moved on three consecutive fetches — the whole "Protected paths"
 *   section shifted up 14 lines between the 2026-08-23 and 2026-08-25 fetches.
 * - `settings.md`: the citations in this file are NOT re-measured and are known
 *   DEAD AT THE PAGE LEVEL, not merely at the line level. `settings.md` was split
 *   upstream: on the 2026-08-25 fetch it is 804 lines of "Claude Code settings"
 *   (scope, precedence, how to edit) whose first ~460 lines are a React
 *   component, and the key-by-key reference this file quotes now lives at
 *   `settings-reference.md` (5474 lines) — the page `sandboxing.md` itself links
 *   to as `/docs/en/settings-reference#sandbox-settings`. Every `settings.md:<n>`
 *   here lands on that component's JavaScript or on a `<span id=… />` marker, and
 *   the quoted strings ("Additional paths where sandboxed commands can write",
 *   "Paths where sandboxed commands cannot write", "Arrays are merged across all
 *   settings", "combined, not replaced") are on NEITHER page today. The keys are
 *   still documented — `settings-reference.md#sandbox-filesystem-allowwrite` now
 *   reads "Add paths where sandboxed commands can write, beyond the working
 *   directory and the session temp directory." — so the claims stand and the
 *   citations do not. Re-hanging 20 anchors onto a 5474-line page is its own
 *   measurement and was deliberately not folded in here.
 * - `sandbox-environments.md`: one citation, replaced below by a `sandboxing.md`
 *   sentence that says the same thing verbatim.
 */
export interface SandboxSettingsV1 {
  /**
   * The master switch for every OS-level isolation wrap this product applies
   * — seatbelt / bwrap / firejail / the Windows restricted-token profile,
   * behind `ProcessSupervisor` — and, indirectly, the legacy
   * `macosSeatbeltBashSandboxEnabled` approved-Bash seatbelt, which keeps its
   * meaning only while this stays on. Governs nothing about `script_sandbox`,
   * whose own isolation is unconditional (T1's one documented exception —
   * category string `script-sandbox-keeps-isolation`).
   *
   * `sandboxing.md`: "To enable the sandbox across all of your projects, set
   * `sandbox.enabled` to `true` in your user settings at
   * `~/.claude/settings.json`." `settings.md` sandbox table: `enabled` —
   * "Enable bash sandboxing (macOS, Linux, and WSL2). Default: false".
   *
   * **Composition is NOT the boolean-AND {@link allowUnsandboxedCommands}
   * uses.** `sandboxing.md`: "For boolean keys such as `enabled` and
   * `failIfUnavailable`, Claude Code uses the managed value and ignores
   * anything a developer sets locally." The managed layer wins OUTRIGHT with
   * EITHER value when it sets the key; otherwise the most specific layer that
   * sets it; otherwise {@link SANDBOX_ENABLED_DEFAULT}. See
   * {@link resolveSandboxEnabled}, the one helper this composition lives in
   * (hazard 10 — never a second hand-rolled copy of the rule).
   *
   * Owner decision 2026-08-12 (category string
   * `sandbox-default-off-until-agent-stabilization`): defaults OFF — this
   * fork's stricter-than-Claude always-on choice is retracted — until the
   * agent loop is proven stable running unwrapped. Re-enable per-host with
   * `sandbox.enabled: true` in user or managed settings (the managed value
   * always wins outright), or fleet-wide by flipping
   * {@link SANDBOX_ENABLED_DEFAULT}.
   */
  enabled?: boolean;
  /**
   * Command glob patterns permitted to run OUTSIDE isolation.
   *
   * The escape hatch for commands that are permanently incompatible with the
   * sandbox (docker, some Go tooling, watchman) and have no supported
   * workaround. Every match is recorded on the execution receipt as a
   * downgrade; nothing about it is silent. Governed by
   * {@link SandboxSettingsV1.allowUnsandboxedCommands} only in so far as that
   * key locks the *other* escape hatch — an excluded command still runs when
   * strict mode is on, which is what makes strict mode usable at all.
   */
  excludedCommands?: readonly string[];
  /**
   * Paths a sandboxed command must never read, on top of the host-seeded
   * credential floor. Additive only — see the `floor` option on
   * {@link resolveSandboxSettings}.
   *
   * **Pre-doc ALIAS of {@link SandboxFilesystemSettingsV1.denyRead}.** The
   * documented spelling is nested; this flat one stays accepted because
   * `foldSandboxRuleRoots` and `pi-agent.ts` produce it internally and on-disk
   * configs already carry it. Both spellings concat-dedupe, neither replaces
   * the other (`settings-reference.md#sandbox-filesystem-denyread` — "Claude
   * Code merges entries across every settings scope the session loads, and adds
   * the paths from your `Read(...)` deny permission rules.").
   */
  deniedReadRoots?: readonly string[];
  /**
   * Paths a sandboxed command must never WRITE to, while reads stay permitted.
   * Additive like {@link SandboxSettingsV1.deniedReadRoots}.
   *
   * `sandboxing.md#permission-rules` — `sandbox.filesystem.denyWrite` and
   * `sandbox.filesystem.denyRead` "Block subprocess access to specific paths";
   * `settings-reference.md#sandbox-filesystem-denywrite` makes this the merge
   * target for `Edit(...)` deny permission rules — "Claude Code merges entries
   * across every settings scope the session loads, and adds the paths from your
   * `Edit(...)` deny permission rules" — while
   * `settings-reference.md#sandbox-filesystem-denyread` keeps `Read(...)` denies
   * on `deniedReadRoots`. They are separate keys in the contract because an edit
   * deny is not a read deny.
   *
   * **Pre-doc ALIAS of {@link SandboxFilesystemSettingsV1.denyWrite}**, kept for
   * the same reason as {@link SandboxSettingsV1.deniedReadRoots}.
   */
  deniedWriteRoots?: readonly string[];
  /**
   * Host-owned roots a sandboxed command may additionally WRITE to.
   *
   * **Pre-doc ALIAS of {@link SandboxFilesystemSettingsV1.allowWrite}**, kept
   * for the same reason as {@link SandboxSettingsV1.deniedReadRoots}.
   */
  additionalWritableRoots?: readonly string[];
  /**
   * Whether a caller may pass `dangerouslyDisableSandbox` to run one command
   * outside isolation.
   *
   * Default true, so behaviour is unchanged for anyone who never sets it. When
   * false ("strict sandbox mode") the `dangerouslyDisableSandbox` escape hatch
   * is refused outright — not prompted, not downgraded-and-recorded.
   * `excludedCommands` still applies. Boolean-AND across layers and against the
   * floor: once any layer locks it, nothing can unlock it.
   */
  allowUnsandboxedCommands?: boolean;
  /**
   * Outbound network policy for host-side watch targets (Monitor's ws source
   * today; R19 extends this with the egress proxy and request-level policy).
   *
   * Composition follows the same three shapes as the filesystem keys above:
   * - `deniedDomains` RESTRICTS, so the floor is a minimum and layers only add.
   * - `allowedDomains` GRANTS, so a floor that names it caps the list. Without
   *   that, an admin could lock {@link SandboxNetworkSettingsV1.allowManagedDomainsOnly}
   *   and a user layer could widen the allowlist straight back through it.
   * - `allowManagedDomainsOnly` restricts, so it is boolean-OR — the opposite
   *   direction from `allowUnsandboxedCommands`, which grants and is AND. Both
   *   rules are "the tighter side wins" applied to a boolean.
   */
  network?: SandboxNetworkSettingsV1;
  /**
   * The filesystem layer itself, and the CANONICAL home of every path key.
   *
   * `settings-reference.md#sandbox-filesystem` nests all six — "**Type**:
   * object with `allowWrite`, `denyWrite`, `denyRead`, and `allowRead` arrays,
   * plus the `allowManagedReadPathsOnly` and `disabled` Booleans" — so a
   * conforming settings file writes them nested and they must be ACCEPTED.
   * The three flat siblings above are pre-doc aliases we keep rather than
   * canonical spellings; a document may use either or both.
   */
  filesystem?: SandboxFilesystemSettingsV1;
}

export interface SandboxFilesystemSettingsV1 {
  /**
   * Turn the filesystem layer off entirely, keeping network isolation.
   *
   * **This surrenders the settings-file write protection.**
   * `sandboxing.md#protected-paths` — the sandbox denies writes to "the files
   * Claude Code loads configuration and code from", and "The only way to turn the
   * protection off is `filesystem.disabled`, which turns off filesystem isolation
   * for every path." (The wording this comment used to quote — "can't modify its
   * own policy unless you disable filesystem isolation, which turns these deny
   * rules off" — is not on the 2026-08-25 page.) The coupling is not incidental: the deny rules are
   * expressed as filesystem rules, so there is no way to keep them once the
   * layer is gone. A user who sets this key is choosing to let a sandboxed
   * command rewrite the policy that governs the next one, along with every
   * other write and read deny — see
   * {@link resolveSandboxFilesystemConsequences}, which names each one.
   */
  disabled?: boolean;
  /**
   * Absolute paths re-opened for READ inside a `deniedReadRoots` region.
   *
   * `settings-reference.md#sandbox-filesystem-allowread` — "Re-open reading for
   * specific paths inside a region that `denyRead` blocks, to build
   * workspace-only read access. An exact or wildcard `denyRead` entry stays
   * blocked inside a broader `allowRead`, as the overlap table shows." (The
   * older wording this quoted — "Paths to re-allow reading within `denyRead`
   * regions … Use this to create workspace-only read access patterns" — is a
   * survivor with its words re-ordered, not an absence: the rule is the same.)
   *
   * GRANTS, so it composes like `excludedCommands`:
   * `sandboxing.md#keep-developers-from-widening-the-policy` — "For
   * array keys such as `excludedCommands` and `allowRead`, Claude Code merges
   * entries from every scope, so a developer can append entries that widen the
   * policy" — unless
   * {@link SandboxFilesystemSettingsV1.allowManagedReadPathsOnly} locks it.
   *
   * Written here rather than as a flat sibling of `deniedReadRoots` because
   * `sandbox.filesystem.allowRead` is the documented path, and a conforming
   * settings file must be ACCEPTED — the same reason `disabled` is nested.
   */
  allowRead?: readonly string[];
  /**
   * Honour only the FLOOR's {@link SandboxFilesystemSettingsV1.allowRead}.
   *
   * `sandboxing.md#keep-developers-from-widening-the-policy` — "Set
   * `allowManagedReadPathsOnly` to `true` in managed
   * settings so that only `allowRead` entries from managed settings are honored.
   * User, project, and local `allowRead` entries are ignored. This prevents
   * developers from widening read access beyond the organization-approved paths."
   * `settings-reference.md#sandbox-filesystem-allowmanagedreadpathsonly` adds
   * "Claude Code still merges `denyRead` entries from every settings scope the
   * session loads", which is why only the granting half is capped.
   *
   * Composed from ANY layer, like `allowManagedDomainsOnly`: the key only ever
   * restricts, so the tighter side winning is the same rule applied to a boolean.
   */
  allowManagedReadPathsOnly?: boolean;
  /**
   * Paths a sandboxed command may additionally WRITE to.
   *
   * `settings-reference.md#sandbox-filesystem-allowwrite` — "Claude Code merges
   * entries across every settings scope the session loads: user, project,
   * local, and managed paths combine rather than replace each other, and Claude
   * Code adds the paths from your `Edit(...)` allow permission rules."
   *
   * GRANTS, so a floor that names it (under either spelling) caps the list —
   * see {@link resolveSandboxSettings}. Folded into
   * {@link ResolvedSandboxSettings.additionalWritableRoots}, which keeps the
   * flat name every consumer already reads.
   */
  allowWrite?: readonly string[];
  /**
   * Paths a sandboxed command must never WRITE to.
   *
   * `settings-reference.md#sandbox-filesystem-denywrite` — "Block sandboxed
   * commands from writing to specific paths, including paths inside a directory
   * that is otherwise writable", and "Claude Code merges entries across every
   * settings scope the session loads, and adds the paths from your `Edit(...)`
   * deny permission rules." RESTRICTS, so it is additive and a
   * floor entry can never be subtracted. Folded into
   * {@link ResolvedSandboxSettings.deniedWriteRoots}.
   */
  denyWrite?: readonly string[];
  /**
   * Paths a sandboxed command must never READ.
   *
   * `settings-reference.md#sandbox-filesystem-denyread` — "Block sandboxed
   * commands from reading specific paths, such as credential files that the
   * default read policy would otherwise expose", and "Claude Code merges
   * entries across every settings scope the session loads, and adds the paths
   * from your `Read(...)` deny permission rules." RESTRICTS like
   * {@link SandboxFilesystemSettingsV1.denyWrite}. Folded into
   * {@link ResolvedSandboxSettings.deniedReadRoots}.
   */
  denyRead?: readonly string[];
}

/**
 * What a `./`-prefixed, bare or `~/`-prefixed sandbox path resolves against.
 *
 * `settings-reference.md#sandbox-path-prefixes` — "`./` or no prefix …
 * Relative to the project root for project settings, or to `~/.claude` for user
 * settings". Each settings TIER
 * therefore anchors its own paths, which is why this rides the per-tier parse
 * and not {@link resolveSandboxSettings}: by the time layers are composed the
 * declaring scope is gone.
 */
export interface SandboxPathScopeV1 {
  /** Home for `~/` entries. Defaults to the session's latched home (P3.143). */
  home?: string;
  /**
   * The declaring settings scope's directory, for `./` and bare entries.
   *
   * Absent for a managed policy: it can be delivered over the wire
   * (`config/managed-delivery.ts`) and has no file on this machine to anchor
   * to. An unanchored entry is then refused by name
   * (`sandbox-<key>-no-scope-root`) rather than resolved against a directory
   * the administrator never wrote — the posture
   * `sandbox-permission-rules.ts` already takes for source-anchored rules.
   */
  root?: string;
}

export interface SandboxNetworkSettingsV1 {
  /** Hosts (and their subdomains) that must never be connected to. */
  deniedDomains?: readonly string[];
  /**
   * The managed allowlist {@link SandboxNetworkSettingsV1.allowManagedDomainsOnly}
   * names. Meaningless on its own — with the flag off, everything not denied is
   * already allowed.
   */
  allowedDomains?: readonly string[];
  /**
   * Deny every host outside {@link SandboxNetworkSettingsV1.allowedDomains}.
   * With no allowlist this denies everything, which is the fail-closed reading:
   * the flag never widens access.
   */
  allowManagedDomainsOnly?: boolean;
}

/** Every key `resolveSandboxSettings` accepts. Anything else is an error. */
const SANDBOX_SETTING_KEYS = [
  'enabled',
  'excludedCommands',
  'deniedReadRoots',
  'deniedWriteRoots',
  'additionalWritableRoots',
  'allowUnsandboxedCommands',
  'network',
  'filesystem',
] as const;

const SANDBOX_NETWORK_KEYS = ['deniedDomains', 'allowedDomains', 'allowManagedDomainsOnly'] as const;
const SANDBOX_FILESYSTEM_KEYS = [
  'disabled',
  'allowRead',
  'allowManagedReadPathsOnly',
  // `settings-reference.md#sandbox-filesystem-allowwrite`,
  // `#sandbox-filesystem-denywrite` and `#sandbox-filesystem-denyread`. The
  // three flat siblings in SANDBOX_SETTING_KEYS are the pre-doc aliases of
  // these; both spellings are accepted and neither replaces the other.
  'allowWrite',
  'denyWrite',
  'denyRead',
] as const;

/**
 * Sandbox keys `settings-reference.md` documents and this product deliberately
 * does not carry — P6.233.
 *
 * **The row's premise is undercounted, and this list is the correction.** It
 * said *seven* documented keys are rejected. Measured 2026-09-06 against the
 * live page (`curl -s https://code.claude.com/docs/en/settings-reference.md`,
 * HTTP 200): its settings index carries **37** `sandbox.*` rows, of which this
 * parser accepts **14** and rejects **23** — the names below. Regenerate rather
 * than trusting that number, which is a reading with a date:
 *
 * ```sh
 * curl -s https://code.claude.com/docs/en/settings-reference.md \
 *  | grep -oE '^\| \[`sandbox\.[^`]*`\]' | sed 's/^| \[`//; s/`\]$//' | sort -u
 * ```
 *
 * **Why refused rather than parsed.** Every one of the 23 configures the OS
 * isolation layer, and this product's isolation is OFF by standing owner
 * decision (2026-08-12/13, reaffirmed as sitting §1.1 option B on 2026-09-05:
 * the sandbox stays off and the `(allow default)` seatbelt wildcard stays). The
 * wrapper here is ours, not the SDK's, so even with `enabled: true` there is no
 * layer for these keys to reach — parsing them would be a control that guards
 * nothing, which is the shape the "simplest integration, least code" rule
 * (owner 2026-09-05) exists to refuse.
 *
 * **What this list DOES buy** is the half that is correct under either posture:
 * an operator who writes a documented key gets a sentence that distinguishes a
 * decided refusal from a typo. Before this, `sandbox.failIfUnavailable` and
 * `sandbox.failIfUnavailabl` produced byte-identical messages, so an
 * administrator reading the page read our posture as their own spelling
 * mistake — the same defect P6.240 closed for `claudeMd`, in a second parser.
 *
 * Add a name here only to record a DECIDED refusal. A key that gains a carrier
 * moves into `SANDBOX_SETTING_KEYS`, and one whose posture is still open stays
 * out of both, where it keeps the generic message.
 *
 * ## P6.253 is SUPERSEDED by this list, measured 2026-09-06
 *
 * That row asks for the eight `sandbox.network` TRANSPORT keys —
 * `strictAllowlist`, `tlsTerminate`, the HTTP and SOCKS proxy ports,
 * `allowUnixSockets`, `allowAllUnixSockets`, `allowLocalBinding`,
 * `allowMachLookup` — to *"reach the claude child instead of throwing"*. All
 * eight are in this list, so they no longer throw a typo sentence at an
 * administrator, and carrying them is refused for the same reason the other
 * fifteen are: the standing owner decision, not an oversight.
 *
 * The row's `done_means` is also unreachable through the tier it names, and
 * that half is a fact about the SDK rather than a posture: of the eight, the
 * restrictive managed-settings filter re-extracted from the shipped binary
 * copies exactly ONE — `strictAllowlist`, inside its `sandbox.network` branch.
 * A projection of the other seven would be dropped inside the SDK without a
 * word, which is the silent-drop shape `agent/claude-managed-settings.ts`
 * exists to avoid, so "reaches the claude child" could not be satisfied for
 * them even under a posture that wanted it.
 *
 * Do not re-open one of the eight in isolation: `__tests__/sandbox-settings.test.ts`
 * asserts the whole set is here, so removing a name is a decision that shows.
 */
export const DOCUMENTED_UNCARRIED_SANDBOX_KEYS: ReadonlySet<string> = new Set([
  'sandbox.allowAppleEvents',
  'sandbox.autoAllowBashIfSandboxed',
  'sandbox.bwrapPath',
  'sandbox.credentials',
  'sandbox.credentials.allowPlaintextInject',
  'sandbox.credentials.awsPairs',
  'sandbox.credentials.envVars',
  'sandbox.credentials.files',
  'sandbox.credentials.sigv4',
  'sandbox.enableWeakerNestedSandbox',
  'sandbox.enableWeakerNetworkIsolation',
  'sandbox.failIfUnavailable',
  'sandbox.ignoreViolations',
  'sandbox.network.allowAllUnixSockets',
  'sandbox.network.allowLocalBinding',
  'sandbox.network.allowMachLookup',
  'sandbox.network.allowUnixSockets',
  'sandbox.network.httpProxyPort',
  'sandbox.network.socksProxyPort',
  'sandbox.network.strictAllowlist',
  'sandbox.network.tlsTerminate',
  'sandbox.ripgrep',
  'sandbox.socatPath',
]);

/** True for a TOP-LEVEL `sandbox` key Claude Code documents and we do not carry. */
function isDocumentedUncarriedSandboxKey(key: string): boolean {
  return DOCUMENTED_UNCARRIED_SANDBOX_KEYS.has(`sandbox.${key}`);
}

/**
 * The documented-but-uncarried keys a RAW sandbox layer carries — P6.233.
 *
 * The naming half of accept-and-name. `assertKnownKeys` stopped throwing for
 * these so that one documented key no longer costs the operator every other key
 * in the same block; silence in its place would be worse than the throw, so the
 * composition site (`server-core/src/bootstrap/host-sandbox-settings.ts`) asks
 * this and puts each one on its diagnostic channel — the one
 * `debug-your-config.md` requires the terminal doctor to be able to print
 * without starting a session.
 *
 * Reads the RAW layer, before the parse strips them, and descends into the
 * three documented sub-blocks so `sandbox.network.strictAllowlist` is named as
 * itself rather than as `network`. Dotted, exactly as an operator writes it.
 * Sorted, so a report does not reorder itself between runs.
 *
 * PROJECTS NOTHING, deliberately. The sandbox is off by standing owner decision
 * (2026-08-12/13), so a `failIfUnavailable` reader would guard nothing and an
 * `allowAppleEvents` reader would widen a profile that is not emitted. This row
 * stops at the parser and the honest surface.
 */
export function documentedUncarriedSandboxKeys(value: unknown): readonly string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const found = new Set<string>();
  for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
    if (DOCUMENTED_UNCARRIED_SANDBOX_KEYS.has(`sandbox.${key}`)) found.add(`sandbox.${key}`);
    if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) continue;
    for (const nested of Object.keys(sub as Record<string, unknown>)) {
      const dotted = `sandbox.${key}.${nested}`;
      if (DOCUMENTED_UNCARRIED_SANDBOX_KEYS.has(dotted)) found.add(dotted);
    }
  }
  return Object.freeze([...found].sort());
}

/**
 * The message for a key this parser does not accept, with the refusal note
 * appended when the key is a documented one.
 *
 * Appended, never substituted: the existing message is what every caller and
 * six tests match on, and a rendering that replaced it would break the
 * `invalid sandbox setting: <key>` contract `assertKnownKeys` is identified by.
 */
function unknownSandboxKeyReason(base: string, dotted: string, key: string): string {
  const message = `${base}: ${key}`;
  return DOCUMENTED_UNCARRIED_SANDBOX_KEYS.has(dotted)
    ? `${message} — documented by Claude Code and deliberately not carried here: `
      + `this product's OS isolation is off by owner decision and its wrapper is its own, `
      + 'so the key has no layer to reach'
    : message;
}

const MAX_LIST_ENTRIES = 128;
const MAX_ENTRY_LENGTH = 512;

/**
 * T1 owner decision (2026-08-12): sandbox off by default until the agent loop
 * is proven stable running unwrapped (category string
 * `sandbox-default-off-until-agent-stabilization`). Flip this ONE constant to
 * `true` to restore always-on behaviour fleet-wide; a per-host operator sets
 * `sandbox.enabled: true` in user or managed settings instead — see
 * {@link resolveSandboxEnabled}.
 *
 * ## WHAT TURNING THIS ON COSTS CODEX, measured rather than assumed (P3.45)
 *
 * This switch reaches codex through `CodexAgent.sandboxGloballyEnabled()`
 * (contour e), and codex is the runtime where it changes the most: the codex
 * app-server is spawned directly, never through `ProcessSupervisor`, so this is
 * the ONLY sandboxing layer its shell executions get.
 *
 * **The row that opened this said the codex shell has no network in ANY shipped
 * configuration. That is REFUTED for the shipped default, and the refutation is
 * this constant.** With the switch OFF — the value below —
 * `codexSandboxConfigForMode` emits `danger-full-access`, there is no OS wrap,
 * and the shell has network like any other process. The claim holds only once
 * an operator or an org policy turns the switch ON, which puts codex into
 * `read-only` or `workspace-write`.
 *
 * In THAT state the shell loses network, and it loses it silently:
 *
 *  - We configure no network knob at all. Measured 2026-08-29 over
 *    `codex-responses-adapter`, `codex-agent-server`, `shared` and
 *    `server-core`: `network_access` 0 files, `sandbox_workspace_write` 0,
 *    `writable_roots` 0 — with live controls on the same scan, `sandbox_mode`
 *    10 files and `approval_policy` 11. We write the mode and the policy and
 *    nothing about egress.
 *  - Codex's default for the knob we never write is off. The shipped
 *    `darwin-arm64/codex-app-server` says so in its own words: "In
 *    `workspace-write`, network access still depends on your Codex
 *    configuration (for example `[sandbox_workspace_write] network_access =
 *    true`)."
 *  - The seatbelt profile in that same binary is why the failure MISREADS as a
 *    name-resolution problem rather than as "no network". It is `(deny
 *    default)` plus a short allowlist, and two of the entries are
 *    `(allow network-outbound (remote ip "*:53"))` and
 *    `(allow network-outbound (remote ip "localhost:*"))` — DNS and loopback
 *    survive while everything else is denied. The unrestricted
 *    `(allow network-outbound)` exists as a separate string, so the profile is
 *    built conditionally. The child also carries
 *    `CODEX_SANDBOX_NETWORK_DISABLED=1` (5 occurrences; a made-up name scores
 *    0 on the same scan).
 *
 * **Do not close this by writing `network_access = true`.** That is the
 * page-shaped fix, it widens every sandboxed session on a runtime whose sandbox
 * an operator deliberately turned on, and on this plan a page-shaped fix has
 * destroyed working behaviour three times. Codex 0.148 already has its own
 * mechanism for the case — a network APPROVAL path
 * (`core/src/tools/network_approval.rs`, `CODEX_NETWORK_PROXY_ACTIVE`, and the
 * `networkAccess` variant of `GuardianApprovalReviewAction` in our own
 * generated protocol) — and we consume it in ZERO files, against controls of 4
 * and 7 for two sibling variants of that same union. Native-first says ask what
 * enabling that costs before building anything beside it.
 */
export const SANDBOX_ENABLED_DEFAULT = false;

export interface ResolvedSandboxSettings {
  /** The resolved master switch — see {@link resolveSandboxEnabled}. */
  enabled: boolean;
  excludedCommands: readonly string[];
  deniedReadRoots: readonly string[];
  deniedWriteRoots: readonly string[];
  additionalWritableRoots: readonly string[];
  allowUnsandboxedCommands: boolean;
  network: ResolvedSandboxNetworkSettings;
  filesystem: ResolvedSandboxFilesystemSettings;
}

export interface ResolvedSandboxFilesystemSettings {
  /** True when the filesystem layer is off and only network isolation remains. */
  disabled: boolean;
  /**
   * The composed `allowRead` list. Empty means no allowlist was configured,
   * which is the ambient-read posture every default install has.
   */
  allowedReadRoots: readonly string[];
  /** True when only the floor's `allowRead` entries were honoured. */
  allowManagedReadPathsOnly: boolean;
}

export interface ResolvedSandboxNetworkSettings {
  deniedDomains: readonly string[];
  allowedDomains: readonly string[];
  allowManagedDomainsOnly: boolean;
}

function assertKnownKeys(layer: SandboxSettingsV1): void {
  const allowed = new Set<string>(SANDBOX_SETTING_KEYS);
  for (const key of Object.keys(layer)) {
    if (allowed.has(key)) continue;
    // P6.233 — ACCEPT-AND-NAME for a key Claude Code documents and this product
    // deliberately does not carry. Throwing here costs the operator EVERY OTHER
    // key in the same block, because the strict path's one caller
    // (`getUserSandboxSettings`) catches the throw and returns an empty layer —
    // so one documented key silently disabled a whole hand-written sandbox
    // block. `managed-settings.md#invalid-entries-in-managed-settings` describes
    // the opposite shape and the tolerant path already implements it: it "drops
    // any top-level key whose value still fails and keeps enforcing every
    // remaining valid key". This makes the two paths agree.
    //
    // A key that is NOT documented still throws: that is a typo, and strictness
    // is the right answer to a typo. The naming half is
    // {@link documentedUncarriedSandboxKeys}, read at the composition site.
    if (isDocumentedUncarriedSandboxKey(key)) continue;
    throw new Error(unknownSandboxKeyReason('invalid sandbox setting', `sandbox.${key}`, key));
  }
}

/**
 * A domain list. Deliberately NOT a hostname validator: the guard normalizes
 * and matches, and rejecting an unusual-but-harmless entry here would only make
 * a security setting fail to load.
 */
function domainList(value: unknown, key: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    throw new Error(`invalid sandbox network ${key}`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.length > MAX_ENTRY_LENGTH) {
      throw new Error(`invalid sandbox network ${key}`);
    }
  }
  return value as readonly string[];
}

function networkSection(value: unknown): SandboxNetworkSettingsV1 {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid sandbox network settings');
  }
  const allowed = new Set<string>(SANDBOX_NETWORK_KEYS);
  const section = value as Record<string, unknown>;
  for (const key of Object.keys(section)) {
    if (!allowed.has(key)) {
      // P6.233 asked for accept-and-name here too, and it stops at this block:
      // the eight `sandbox.network` transport keys are P6.253's DECIDED
      // refusals, and that row's own test drives this throw to prove "removing
      // one has to be a visible decision". Turning them into acceptances is
      // P6.253's call, not this row's — the finding (one documented key costs
      // the operator every other sandbox key, the same collateral the top-level
      // loop just stopped) is recorded for it rather than acted on here.
      throw new Error(
        unknownSandboxKeyReason('invalid sandbox network setting', `sandbox.network.${key}`, key),
      );
    }
  }
  domainList(section.deniedDomains, 'deniedDomains');
  domainList(section.allowedDomains, 'allowedDomains');
  if (section.allowManagedDomainsOnly !== undefined && typeof section.allowManagedDomainsOnly !== 'boolean') {
    throw new Error('invalid sandbox network allowManagedDomainsOnly');
  }
  return section as SandboxNetworkSettingsV1;
}

function filesystemSection(
  value: unknown,
  scope: SandboxPathScopeV1 = {},
): SandboxFilesystemSettingsV1 {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid sandbox filesystem settings');
  }
  const allowed = new Set<string>(SANDBOX_FILESYSTEM_KEYS);
  const section = value as Record<string, unknown>;
  for (const key of Object.keys(section)) {
    if (!allowed.has(key)) {
      throw new Error(
        unknownSandboxKeyReason('invalid sandbox filesystem setting', `sandbox.filesystem.${key}`, key),
      );
    }
  }
  if (section.disabled !== undefined && typeof section.disabled !== 'boolean') {
    throw new Error('invalid sandbox filesystem disabled');
  }
  if (section.allowManagedReadPathsOnly !== undefined
    && typeof section.allowManagedReadPathsOnly !== 'boolean') {
    throw new Error('invalid sandbox filesystem allowManagedReadPathsOnly');
  }
  // The expanded lists are RETURNED, not merely validated: this used to call
  // `filesystemRoots` for its throw and hand `section` back untouched, which is
  // where a resolved `~/` entry would have been discarded.
  return {
    ...(section as SandboxFilesystemSettingsV1),
    ...(section.allowRead === undefined
      ? {} : { allowRead: filesystemRoots(section.allowRead, 'allowRead', scope) }),
    ...(section.allowWrite === undefined
      ? {} : { allowWrite: filesystemRoots(section.allowWrite, 'allowWrite', scope) }),
    ...(section.denyWrite === undefined
      ? {} : { denyWrite: filesystemRoots(section.denyWrite, 'denyWrite', scope) }),
    ...(section.denyRead === undefined
      ? {} : { denyRead: filesystemRoots(section.denyRead, 'denyRead', scope) }),
  };
}

function commandPatterns(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    throw new Error('invalid sandbox excludedCommands');
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_ENTRY_LENGTH) {
      throw new Error('invalid sandbox excludedCommands');
    }
  }
  return value as readonly string[];
}

/**
 * Expand one sandbox path prefix, per
 * `settings-reference.md#sandbox-path-prefixes`, which binds the rule to the
 * same keys we parse: "Paths in `allowWrite`, `denyWrite`, `denyRead`,
 * `allowRead`, and `credentials.files` resolve by their prefix".
 *
 * | Prefix | Meaning |
 * | --- | --- |
 * | `/` | "Absolute path from filesystem root" — `/tmp/build` stays `/tmp/build` |
 * | `~/` | "Relative to home directory" — `~/.kube` becomes `$HOME/.kube` |
 * | `./` or no prefix | "Relative to the project root for project settings, or to `~/.claude` for user settings" |
 *
 * Same section — "The `//path` prefix for absolute paths also works", and
 * `resolve()` normalizes it to `/path` so the two forms dedupe instead of
 * surviving as separate entries. (It read "The older `//path` prefix … still
 * works" when this comment was written; the rule is unchanged.)
 *
 * **`/x` is NOT project-relative here**, which is the trap this function exists
 * to avoid. Same section again — "This syntax differs from Read and Edit
 * permission rules, which use `//path` for absolute and `/path` for
 * project-relative: sandbox filesystem paths use standard conventions, so
 * `/tmp/build` is an absolute path." Copying the permission-rule anchoring into
 * this parser would silently re-root every absolute deny.
 */
function expandSandboxPath(entry: string, key: string, scope: SandboxPathScopeV1): string {
  // `latchedHomeDir()` and not `homedir()`: P3.143. `deniedReadRoots` (and its
  // `filesystem.denyRead` spelling) is P3.76's read-side credential floor and
  // `~/.nessy` is what it denies, so a confirmed managed `HOME` that moved this
  // anchor mid-session would expand the deny somewhere harmless and leave the
  // real creds file readable — the floor would still be present, still be
  // reported, and protect nothing.
  if (entry === '~' || entry.startsWith('~/')) return join(scope.home ?? latchedHomeDir(), entry.slice(1));
  if (entry.startsWith('/')) return resolve(entry);
  // No declaring directory to anchor to. Refused by name rather than resolved
  // against something the author never wrote; the tolerant sink turns this into
  // a per-entry drop whose reason says why.
  if (scope.root === undefined) throw new Error(`sandbox-${key}-no-scope-root`);
  return join(scope.root, entry);
}

/**
 * Expand one list of sandbox paths, then validate each the same two ways
 * `canonicalDeniedReadRoot` already does at the isolation boundary: absolute,
 * and not a filesystem root.
 *
 * Expansion runs FIRST and the guards apply to the RESOLVED path, so a prefix
 * is never a way around either refusal — `~/` against a home of `/` is still
 * `sandbox-<key>-too-broad`.
 *
 * Otherwise deliberately lexical. This runs at config-resolution time, where the
 * paths may not exist yet and `realpath` would be both wrong and a filesystem
 * dependency; the isolation boundary canonicalizes them for real. A settings
 * surface must not be a way around either refusal, so both are re-checked here
 * rather than deferred.
 *
 * Idempotent on its own output, which is what lets {@link resolveSandboxSettings}
 * re-validate already-parsed layers with no scope at all.
 */
function filesystemRoots(
  value: unknown,
  key: string,
  scope: SandboxPathScopeV1 = {},
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) {
    throw new Error(`invalid sandbox ${key}`);
  }
  const expanded: string[] = [];
  for (const entry of value) {
    // The length cap is on the AUTHORED string: a long home or config directory
    // must not push an otherwise-conforming entry over a settings-hygiene bound.
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MAX_ENTRY_LENGTH) {
      throw new Error(`invalid sandbox ${key}`);
    }
    const root = expandSandboxPath(entry, key, scope);
    if (!isAbsolute(root)) throw new Error(`sandbox-${key}-not-absolute`);
    if (dirname(root) === root) throw new Error(`sandbox-${key}-too-broad`);
    expanded.push(root);
  }
  return expanded;
}

/**
 * The `network` sub-block under the managed tier's tolerance.
 *
 * This is the `sandbox.credentials` row of
 * `managed-settings.md#keys-that-fail-closed` applied to the sub-block we
 * actually have: "A recoverable invalid entry is degraded to `mode: \"deny\"`
 * with a warning; an unrecoverable one is stripped; valid entries stay
 * enforced." The whole-key half is the section's own lead rule at
 * `managed-settings.md#find-entries-claude-code-dropped`: Claude Code "drops any
 * top-level key whose value still fails and keeps enforcing every remaining
 * valid key". Returning `undefined` for a wholly invalid `network` is what
 * makes the rest of `sandbox` still apply.
 */
function toleratedNetworkSection(
  value: unknown,
  sink: ManagedDropSink,
  at: string,
): SandboxNetworkSettingsV1 | undefined {
  if (!sink.tolerant) return networkSection(value);
  const section = value === null || typeof value !== 'object' || Array.isArray(value)
    ? null
    : value as Record<string, unknown>;
  if (!section) {
    sink.drop(at, 'invalid sandbox network settings', 'stripped');
    return undefined;
  }
  const known = new Set<string>(SANDBOX_NETWORK_KEYS);
  for (const key of Object.keys(section)) {
    if (known.has(key)) continue;
    sink.drop(`${at}.${key}`,
      unknownSandboxKeyReason('invalid sandbox network setting', `sandbox.network.${key}`, key),
      'stripped');
  }
  const deniedDomains = section.deniedDomains === undefined
    ? undefined
    : toleratedList(sink, `${at}.deniedDomains`, section.deniedDomains,
      entries => domainList(entries, 'deniedDomains'), 'restrict');
  const allowedDomains = section.allowedDomains === undefined
    ? undefined
    : toleratedList(sink, `${at}.allowedDomains`, section.allowedDomains,
      entries => domainList(entries, 'allowedDomains'), 'grant');
  let allowManagedDomainsOnly = section.allowManagedDomainsOnly as boolean | undefined;
  if (allowManagedDomainsOnly !== undefined && typeof allowManagedDomainsOnly !== 'boolean') {
    // The enforcing pole, exactly as `managed-settings.md#keys-that-fail-closed`
    // reads an invalid `allowManagedMcpServersOnly`: "Treated as `true`."
    sink.drop(`${at}.allowManagedDomainsOnly`, 'invalid sandbox network allowManagedDomainsOnly', 'tightened');
    allowManagedDomainsOnly = true;
  }
  return {
    ...(deniedDomains === undefined ? {} : { deniedDomains }),
    ...(allowedDomains === undefined ? {} : { allowedDomains }),
    ...(allowManagedDomainsOnly === undefined ? {} : { allowManagedDomainsOnly }),
  };
}

/**
 * Parser for a sandbox layer arriving from an untrusted-shape source (the
 * host-owned managed policy file).
 *
 * STRICT by default: with no `sink`, unknown keys and bad entries throw exactly
 * as before. `managed-settings.md#keys-that-fail-closed` is why that is the
 * default — "This tolerance applies only to managed settings. User, project,
 * and local settings files remain strict: a file whose JSON or top-level shape
 * fails validation is rejected as a whole and reported, and an individual entry
 * that fails, such as a malformed permission rule, is skipped with a warning
 * while the rest of the file applies." A helper reached from a user, project or
 * local settings file must not inherit the managed tier's tolerance. The
 * managed call site passes a tolerant sink and gets that section's fail-closed
 * table instead.
 *
 * `scope` is where the documented path prefixes resolve (see
 * {@link SandboxPathScopeV1}). Expansion belongs HERE, at the per-tier parse,
 * because only the tier knows what a bare path is relative to.
 */
export function parseManagedSandboxSettingsV1(
  value: unknown,
  options?: { scope?: SandboxPathScopeV1 },
): SandboxSettingsV1;
export function parseManagedSandboxSettingsV1(
  value: unknown,
  options: { sink: ManagedDropSink; field?: string; scope?: SandboxPathScopeV1 },
): SandboxSettingsV1 | undefined;
export function parseManagedSandboxSettingsV1(
  value: unknown,
  options: { sink?: ManagedDropSink; field?: string; scope?: SandboxPathScopeV1 } = {},
): SandboxSettingsV1 | undefined {
  const sink = options.sink ?? STRICT_DROP_SINK;
  const at = options.field ?? 'sandbox';
  const scope = options.scope ?? {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    sink.drop(at, 'invalid sandbox settings', 'stripped');
    return undefined;
  }
  const layer = value as Record<string, unknown>;
  const known = new Set<string>(SANDBOX_SETTING_KEYS);
  for (const key of Object.keys(layer)) {
    if (known.has(key)) continue;
    // P6.233 — the strict sink THROWS on `drop`, which is why the documented
    // keys are skipped here and named at the composition site instead: on the
    // strict path one documented key used to cost the operator the whole block.
    // The tolerant (managed) path is unchanged and still reports each key with
    // its own note, because there a drop is a report rather than a throw.
    if (!sink.tolerant && isDocumentedUncarriedSandboxKey(key)) continue;
    sink.drop(`${at}.${key}`,
      unknownSandboxKeyReason('invalid sandbox setting', `sandbox.${key}`, key),
      'stripped');
  }
  // `excludedCommands` and `additionalWritableRoots` GRANT, and an empty list
  // is the tighter reading for both: `resolveSandboxSettings` treats a floor
  // that names either key as the COMPLETE list, so `[]` caps every later layer
  // at nothing. `deniedReadRoots` RESTRICTS and is additive, so an empty list
  // is the same as an absent one and the field is dropped instead.
  const excludedCommands = layer.excludedCommands === undefined
    ? undefined
    : toleratedList(sink, `${at}.excludedCommands`, layer.excludedCommands, commandPatterns, 'grant');
  const deniedReadRoots = layer.deniedReadRoots === undefined
    ? undefined
    : toleratedList(sink, `${at}.deniedReadRoots`, layer.deniedReadRoots,
      entries => filesystemRoots(entries, 'deniedReadRoots', scope), 'restrict');
  const deniedWriteRoots = layer.deniedWriteRoots === undefined
    ? undefined
    : toleratedList(sink, `${at}.deniedWriteRoots`, layer.deniedWriteRoots,
      entries => filesystemRoots(entries, 'deniedWriteRoots', scope), 'restrict');
  const additionalWritableRoots = layer.additionalWritableRoots === undefined
    ? undefined
    : toleratedList(sink, `${at}.additionalWritableRoots`, layer.additionalWritableRoots,
      entries => filesystemRoots(entries, 'additionalWritableRoots', scope), 'grant');
  let allowUnsandboxedCommands = layer.allowUnsandboxedCommands as boolean | undefined;
  if (allowUnsandboxedCommands !== undefined && typeof allowUnsandboxedCommands !== 'boolean') {
    // Strict sandbox mode is the enforcing pole of this switch.
    sink.drop(`${at}.allowUnsandboxedCommands`, 'invalid sandbox allowUnsandboxedCommands', 'tightened');
    allowUnsandboxedCommands = false;
  }
  // T1 (2026-08-12): the master kill switch. `true` is the enforcing pole — it
  // turns wrapping ON — the same rule `allowManagedReadPathsOnly` and
  // `disabled` already take for their own booleans.
  let enabled = layer.enabled as boolean | undefined;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    sink.drop(`${at}.enabled`, 'invalid sandbox enabled', 'tightened');
    enabled = true;
  }
  const network = layer.network === undefined
    ? undefined
    : toleratedNetworkSection(layer.network, sink, `${at}.network`);
  // `managed-settings.md#find-entries-claude-code-dropped` applied to
  // `filesystem` — Claude Code "drops any top-level key whose value still fails
  // and keeps enforcing every remaining valid key" — so a wholly invalid value
  // is dropped with a warning while the rest of `sandbox` still
  // applies, and a malformed `disabled` is read at its ENFORCING pole — which
  // for this key is `false`, because `true` is the permissive direction that
  // turns the settings-file deny rules off.
  let filesystem: SandboxFilesystemSettingsV1 | undefined;
  if (layer.filesystem !== undefined) {
    if (!sink.tolerant) {
      filesystem = filesystemSection(layer.filesystem, scope);
    } else if (layer.filesystem === null
      || typeof layer.filesystem !== 'object'
      || Array.isArray(layer.filesystem)) {
      sink.drop(`${at}.filesystem`, 'invalid sandbox filesystem settings', 'stripped');
    } else {
      const section = layer.filesystem as Record<string, unknown>;
      const known = new Set<string>(SANDBOX_FILESYSTEM_KEYS);
      for (const key of Object.keys(section)) {
        if (known.has(key)) continue;
        sink.drop(`${at}.filesystem.${key}`,
          unknownSandboxKeyReason('invalid sandbox filesystem setting', `sandbox.filesystem.${key}`, key),
          'stripped');
      }
      let disabled = section.disabled as boolean | undefined;
      if (disabled !== undefined && typeof disabled !== 'boolean') {
        sink.drop(`${at}.filesystem.disabled`, 'invalid sandbox filesystem disabled', 'tightened');
        disabled = false;
      }
      const allowRead = section.allowRead === undefined
        ? undefined
        : toleratedList(sink, `${at}.filesystem.allowRead`, section.allowRead,
          entries => filesystemRoots(entries, 'allowRead', scope), 'grant');
      // The composition kind is the thing to get right here, and it is the
      // OPPOSITE for the two directions: `allowWrite` GRANTS, so a wholly
      // invalid value is enforced as an empty allowlist; `denyWrite` and
      // `denyRead` RESTRICT, so a wholly invalid value is dropped rather than
      // becoming a deny the policy never named. Both poles are rows of
      // `managed-settings.md#keys-that-fail-closed`: the granting one reads
      // "Enforced as an empty allowlist until the value is fixed", the
      // restricting one "A wholly invalid value is dropped with a warning,
      // since denying every server would block servers the policy never named."
      const allowWrite = section.allowWrite === undefined
        ? undefined
        : toleratedList(sink, `${at}.filesystem.allowWrite`, section.allowWrite,
          entries => filesystemRoots(entries, 'allowWrite', scope), 'grant');
      const denyWrite = section.denyWrite === undefined
        ? undefined
        : toleratedList(sink, `${at}.filesystem.denyWrite`, section.denyWrite,
          entries => filesystemRoots(entries, 'denyWrite', scope), 'restrict');
      const denyRead = section.denyRead === undefined
        ? undefined
        : toleratedList(sink, `${at}.filesystem.denyRead`, section.denyRead,
          entries => filesystemRoots(entries, 'denyRead', scope), 'restrict');
      // The enforcing pole again: `allowManagedReadPathsOnly` only ever narrows
      // which `allowRead` entries are honoured, so a malformed value reads
      // `true`, matching the `allowManagedMcpServersOnly` row of
      // `managed-settings.md#keys-that-fail-closed`: "Treated as `true`."
      let allowManagedReadPathsOnly = section.allowManagedReadPathsOnly as boolean | undefined;
      if (allowManagedReadPathsOnly !== undefined && typeof allowManagedReadPathsOnly !== 'boolean') {
        sink.drop(`${at}.filesystem.allowManagedReadPathsOnly`,
          'invalid sandbox filesystem allowManagedReadPathsOnly', 'tightened');
        allowManagedReadPathsOnly = true;
      }
      filesystem = {
        ...(disabled === undefined ? {} : { disabled }),
        ...(allowRead === undefined ? {} : { allowRead }),
        ...(allowManagedReadPathsOnly === undefined ? {} : { allowManagedReadPathsOnly }),
        ...(allowWrite === undefined ? {} : { allowWrite }),
        ...(denyWrite === undefined ? {} : { denyWrite }),
        ...(denyRead === undefined ? {} : { denyRead }),
      };
    }
  }
  return Object.freeze({
    ...(enabled === undefined ? {} : { enabled }),
    ...(excludedCommands === undefined ? {} : { excludedCommands: Object.freeze([...excludedCommands]) }),
    ...(deniedReadRoots === undefined ? {} : { deniedReadRoots: Object.freeze([...deniedReadRoots]) }),
    ...(deniedWriteRoots === undefined ? {} : { deniedWriteRoots: Object.freeze([...deniedWriteRoots]) }),
    ...(additionalWritableRoots === undefined
      ? {}
      : { additionalWritableRoots: Object.freeze([...additionalWritableRoots]) }),
    ...(allowUnsandboxedCommands === undefined ? {} : { allowUnsandboxedCommands }),
    ...(filesystem === undefined
      ? {}
      : {
          filesystem: Object.freeze({
            ...(filesystem.disabled === undefined ? {} : { disabled: filesystem.disabled }),
            ...(filesystem.allowRead === undefined
              ? {}
              : { allowRead: Object.freeze([...filesystem.allowRead]) }),
            ...(filesystem.allowManagedReadPathsOnly === undefined
              ? {}
              : { allowManagedReadPathsOnly: filesystem.allowManagedReadPathsOnly }),
            ...(filesystem.allowWrite === undefined
              ? {}
              : { allowWrite: Object.freeze([...filesystem.allowWrite]) }),
            ...(filesystem.denyWrite === undefined
              ? {}
              : { denyWrite: Object.freeze([...filesystem.denyWrite]) }),
            ...(filesystem.denyRead === undefined
              ? {}
              : { denyRead: Object.freeze([...filesystem.denyRead]) }),
          }),
        }),
    ...(network === undefined
      ? {}
      : {
          network: Object.freeze({
            ...(network.deniedDomains === undefined ? {} : { deniedDomains: Object.freeze([...network.deniedDomains]) }),
            ...(network.allowedDomains === undefined ? {} : { allowedDomains: Object.freeze([...network.allowedDomains]) }),
            ...(network.allowManagedDomainsOnly === undefined
              ? {}
              : { allowManagedDomainsOnly: network.allowManagedDomainsOnly }),
          }),
        }),
  });
}

function concatDedupe(lists: readonly (readonly string[])[]): readonly string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      merged.push(entry);
    }
  }
  return Object.freeze(merged);
}

/**
 * The ONE composition for `sandbox.enabled` (hazard 10 — never a second
 * hand-rolled copy of this rule).
 *
 * `sandboxing.md`: "For boolean keys such as `enabled` and `failIfUnavailable`,
 * Claude Code uses the managed value and ignores anything a developer sets
 * locally." So the managed `floor` WINS OUTRIGHT the moment it names the key,
 * in EITHER direction — this is not the boolean-AND
 * {@link SandboxSettingsV1.allowUnsandboxedCommands} composes with, where a
 * floor only ever locks and a `true` grants nothing.
 *
 * Without a floor decision, the most specific layer that names the key wins
 * (`layers` is ordered least- to most-specific, matching every other key in
 * this module); with nothing set anywhere, {@link SANDBOX_ENABLED_DEFAULT}.
 *
 * `resolveSandboxSettings` calls this for the settings-resolution path.
 * `getMacosSeatbeltBashSandboxEnabled` (contour b's convenience reader in
 * `storage.ts`) calls it too — and it DOES supply a floor
 * (`resolveManagedSandboxEnabledFloor()`), so the managed decision reaches the
 * legacy seatbelt reader exactly as it reaches contour (a).
 *
 * This paragraph said the opposite until P3.330: "that in-agent-process reader
 * has no managed floor of its own to supply … so it resolves user-layer-only".
 * That was true of an earlier revision and was left behind when `storage.ts`
 * was fixed; its own call-site comment already records the gap and the fix. The
 * stale sentence mattered because it made the seatbelt wrapper look
 * user-opt-in-only, i.e. unreachable in a managed deployment — which is the
 * reachability argument the `SEATBELT_TESTING_WILDCARD` decision turns on.
 */
export function resolveSandboxEnabled(
  layers: readonly SandboxSettingsV1[],
  floor?: SandboxSettingsV1,
): boolean {
  if (floor?.enabled !== undefined) return floor.enabled;
  for (let i = layers.length - 1; i >= 0; i--) {
    const value = layers[i]?.enabled;
    if (value !== undefined) return value;
  }
  return SANDBOX_ENABLED_DEFAULT;
}

/**
 * Resolve sandbox settings from ordered layers, least- to most-specific.
 *
 * `floor` is host-owned and is the security boundary. It is not "another layer
 * that happens to go first": for every key it wins in whichever direction is
 * TIGHTER, because the whole point is that a settings layer cannot loosen it.
 *
 * - **Restricting keys** — `deniedReadRoots`, `deniedWriteRoots`. The floor is a MINIMUM: layers add
 *   to it and can never remove an entry. These are the credential denies the
 *   runtime seeds (`credentialDenyRoots`); a layer able to drop one would
 *   re-open, through config, the exposure they exist to close.
 * - **Granting keys** — `excludedCommands`, `additionalWritableRoots`. When the
 *   floor names one, the floor's list is the COMPLETE list and no layer may add
 *   to it. Otherwise layers concat freely. Without this, an admin could lock
 *   strict sandbox mode and a user could still escape by adding their own
 *   `excludedCommands` entry — the escape hatch would have a lock that does not
 *   hold.
 * - **Boolean lock** — `allowUnsandboxedCommands`. Boolean-AND across the floor
 *   and every layer, so any `false` anywhere is terminal. A floor `true` grants
 *   nothing; it just does not lock.
 *
 * The documented NESTED path keys fold into their flat counterparts here, so
 * `ResolvedSandboxSettings` keeps the field names every consumer already reads
 * and a document may write either spelling — or both, which concat-dedupe
 * (`settings-reference.md#sandbox-filesystem-allowwrite`: "user, project,
 * local, and managed paths combine rather than replace each other").
 */
export function resolveSandboxSettings(
  layers: readonly SandboxSettingsV1[],
  options: { floor?: SandboxSettingsV1 } = {},
): ResolvedSandboxSettings {
  const floor = options.floor;
  const all = floor ? [floor, ...layers] : [...layers];
  for (const layer of all) assertKnownKeys(layer);

  const granting = (key: 'excludedCommands' | 'additionalWritableRoots'): readonly string[] => {
    const read = (layer: SandboxSettingsV1) => key === 'excludedCommands'
      ? commandPatterns(layer.excludedCommands)
      : concatDedupe([
          filesystemRoots(layer.additionalWritableRoots, key),
          filesystemRoots(layer.filesystem?.allowWrite, 'allowWrite'),
        ]);
    // The cap must fire on EITHER spelling. Reading only the flat key here would
    // hand an administrator who wrote the documented `filesystem.allowWrite` a
    // floor that caps nothing, and the grant lock is the whole point of the key.
    const floorNamesKey = key === 'excludedCommands'
      ? floor?.excludedCommands !== undefined
      : floor?.additionalWritableRoots !== undefined || floor?.filesystem?.allowWrite !== undefined;
    if (floorNamesKey && floor !== undefined) {
      // Validate every layer anyway, so a malformed value is still an error
      // rather than something the cap silently hides.
      for (const layer of layers) read(layer);
      return concatDedupe([read(floor)]);
    }
    return concatDedupe(all.map(read));
  };

  // Same three shapes as above, applied to the network section. Every layer is
  // validated even when the floor caps the granting list, so a malformed value
  // is still an error rather than something the cap hides.
  for (const layer of all) networkSection(layer.network);
  // `filesystem.disabled` GRANTS — `true` removes protection — so it is the
  // mirror image of `allowUnsandboxedCommands`: an explicit `false` anywhere,
  // floor included, is terminal and LOCKS the layer on; otherwise any `true`
  // turns it off; absent everywhere means on. Without the lock an
  // administrator could pin every deny root and a user layer could delete all
  // of them with one key, which is exactly the escape
  // `sandboxing.md#protected-paths` documents and exactly the one a managed tier must be able to refuse.
  const filesystemDisabledValues = all.map(layer => filesystemSection(layer.filesystem).disabled);
  // `allowRead` GRANTS, so it takes the same three shapes as `excludedCommands`
  // — except the cap has its own documented switch rather than being implied by
  // the floor naming the key.
  // `sandboxing.md#keep-developers-from-widening-the-policy`: with
  // `allowManagedReadPathsOnly` set, "User, project, and local `allowRead`
  // entries are ignored". Every layer is still validated when the cap applies,
  // so a malformed value is an error rather than something the cap hides.
  const allowManagedReadPathsOnly = all
    .some(layer => layer.filesystem?.allowManagedReadPathsOnly === true);
  const readAllowLayers = all.map(layer =>
    filesystemRoots(filesystemSection(layer.filesystem).allowRead, 'allowRead'));
  const filesystem = Object.freeze({
    disabled: !filesystemDisabledValues.includes(false)
      && filesystemDisabledValues.includes(true),
    allowedReadRoots: allowManagedReadPathsOnly
      ? concatDedupe([filesystemRoots(floor?.filesystem?.allowRead, 'allowRead')])
      : concatDedupe(readAllowLayers),
    allowManagedReadPathsOnly,
  });
  const floorAllowedDomains = floor?.network?.allowedDomains;
  const network = Object.freeze({
    deniedDomains: concatDedupe(all.map(layer => domainList(layer.network?.deniedDomains, 'deniedDomains'))),
    allowedDomains: floorAllowedDomains !== undefined
      ? concatDedupe([domainList(floorAllowedDomains, 'allowedDomains')])
      : concatDedupe(all.map(layer => domainList(layer.network?.allowedDomains, 'allowedDomains'))),
    allowManagedDomainsOnly: all.some(layer => layer.network?.allowManagedDomainsOnly === true),
  });

  return Object.freeze({
    enabled: resolveSandboxEnabled(layers, floor),
    excludedCommands: granting('excludedCommands'),
    deniedReadRoots: concatDedupe(all.flatMap(layer => [
      filesystemRoots(layer.deniedReadRoots, 'deniedReadRoots'),
      filesystemRoots(layer.filesystem?.denyRead, 'denyRead'),
    ])),
    deniedWriteRoots: concatDedupe(all.flatMap(layer => [
      filesystemRoots(layer.deniedWriteRoots, 'deniedWriteRoots'),
      filesystemRoots(layer.filesystem?.denyWrite, 'denyWrite'),
    ])),
    additionalWritableRoots: granting('additionalWritableRoots'),
    allowUnsandboxedCommands: all.every(layer => layer.allowUnsandboxedCommands !== false),
    network,
    filesystem,
  });
}

/**
 * The one platform whose isolation backend can express a read allowlist.
 *
 * `sandboxing.md#configure-sandboxing` needs a rule that re-opens a subtree
 * inside a denied one — "`"denyRead": ["~/"]` with `"allowRead":
 * ["~/projects"]`".
 * Seatbelt has it — last-match-wins over `(allow file-read* (subpath …))`. bwrap
 * does not: its read scope is the `--ro-bind / /` it starts from and a masked
 * tree stays masked. firejail's `--whitelist` is a write scope. The Windows
 * restricted-token profile takes one value per path out of `write`/`read`/`deny`
 * with no re-allow. This is a platform fact, not a gap in our wiring.
 */
const READ_ALLOWLIST_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(['darwin']);

export interface SandboxReadAllowlistEnforcementV1 {
  /** The composed `allowRead` list, as configured. */
  allowedReadRoots: readonly string[];
  /** Whether this platform's isolation backend can bind an allowlist at all. */
  platformCanEnforce: boolean;
  /**
   * Whether a configured allowlist actually restricts anything. False when no
   * `deniedReadRoots` region exists for it to re-open — reads are ambient, so an
   * `allowRead` with nothing denied grants what was already granted.
   */
  restrictsReads: boolean;
  /**
   * One line per configured entry that does NOT do what its author expects,
   * ready to print. Never silently empty: whatever is listed here is a rule an
   * administrator wrote and the sandboxed shell does not obey.
   */
  unenforceable: readonly string[];
}

/**
 * What the host will actually do about `sandbox.filesystem.allowRead`.
 *
 * Three answers, in the order they get asked: is an allowlist configured, can
 * this platform bind one, and does the configuration restrict anything. The
 * third exists because the honest failure here is silent: `allowRead` on its own
 * is a no-op — `sandboxing.md#configure-sandboxing` pairs it with
 * `"denyRead": ["~/"]` — and an
 * administrator who writes only the allow half gets whole-filesystem read with a
 * setting in their file that says otherwise.
 *
 * Pure, and unchanged for anyone who never writes the key: with no `allowRead`
 * at all this reports nothing to act on.
 */
export function resolveSandboxReadAllowlist(
  settings: ResolvedSandboxSettings,
  options: {
    platform?: NodeJS.Platform;
    /**
     * The host-seeded credential denies, when the caller holds them.
     *
     * Optional because this module must not import them: the runtime seeds them
     * from `@nessy-agent/session-tools-core` and `shared` is upstream of that
     * package, never downstream. Supplied, it turns the ordering rule below into
     * a named line per conflicting entry; omitted, the rule still holds at the
     * isolation boundary and simply is not itemised here.
     */
    credentialFloor?: readonly string[];
  } = {},
): SandboxReadAllowlistEnforcementV1 {
  const entry = (value: string): string => sanitizeSettingsDiagnostic(value, MAX_ENTRY_LENGTH);
  const platform = options.platform ?? process.platform;
  const allowedReadRoots = settings.filesystem.allowedReadRoots;
  const platformCanEnforce = READ_ALLOWLIST_PLATFORMS.has(platform);
  const restrictsReads = allowedReadRoots.length > 0 && settings.deniedReadRoots.length > 0;
  if (allowedReadRoots.length === 0) {
    return Object.freeze({
      allowedReadRoots,
      platformCanEnforce,
      restrictsReads: false,
      unenforceable: Object.freeze([]),
    });
  }
  const unenforceable: string[] = [];
  if (!platformCanEnforce) {
    unenforceable.push(
      `sandbox.filesystem.allowRead is configured with ${allowedReadRoots.length} entr`
      + `${allowedReadRoots.length === 1 ? 'y' : 'ies'} and no isolation backend on ${platform} can`
      + ' enforce it. Every supervised process on this host is REFUSED rather than run under a read'
      + ' boundary that would not bind (process-isolation-unavailable:…:read-allowlist).',
    );
  }
  if (!restrictsReads) {
    unenforceable.push(
      'sandbox.filesystem.allowRead is set with no sandbox.deniedReadRoots region to re-open, so it'
      + ' restricts nothing: reads are ambient by default and an allow grants what is already'
      + ' granted. sandboxing.md#configure-sandboxing pairs it with a denyRead'
      + ' covering the region to close.',
    );
  }
  if (settings.filesystem.disabled) {
    unenforceable.push(
      'sandbox.filesystem.allowRead does not bind while sandbox.filesystem.disabled is true: the'
      + ' read boundary is a filesystem rule and the filesystem layer is off.',
    );
  }
  for (const root of allowedReadRoots) {
    for (const denied of options.credentialFloor ?? []) {
      if (root !== denied && !root.startsWith(`${denied}/`)) continue;
      unenforceable.push(
        `sandbox.filesystem.allowRead "${entry(root)}" does not re-open "${entry(denied)}": the`
        + ' host credential floor is emitted after every configured read rule, so a deny it carries'
        + ' outranks an allow that names the same path. sandboxing.md#configure-sandboxing — the'
        + ' deny holds inside a wider allow.',
      );
    }
  }
  return Object.freeze({
    allowedReadRoots,
    platformCanEnforce,
    restrictsReads,
    unenforceable: Object.freeze(unenforceable),
  });
}

/**
 * What the filesystem layer is doing on this host, in the words a diagnostics
 * surface prints. Empty on a default install; a line for anything an
 * administrator configured that does not do what its name suggests.
 *
 * Two causes today. The first is `sandbox.filesystem.disabled: true`, whose cost
 * is not obvious from its name: `sandboxing.md#disable-filesystem-isolation`
 * sells it as "skip filesystem isolation while keeping network isolation", and
 * `#protected-paths` is where the price is stated — the settings-file deny rules
 * exist only as filesystem rules, so "The only way to turn the protection off is
 * `filesystem.disabled`, which turns off filesystem isolation for every path." There is no partial
 * form of this key. The second is `sandbox.filesystem.allowRead`, whose posture
 * this is the one place an administrator can read back.
 *
 * Never silently empty when either is configured: whatever is listed here is a
 * protection the administrator or the runtime configured and a sandboxed
 * command will no longer be stopped by, or a rule that does not bind at all.
 *
 * **This has to agree with `resolveProcessIsolation`, and now does.** The list
 * was written against the intended behaviour while the funnel still composed
 * every deny root unconditionally; the funnel now skips the layer, and the one
 * rule it keeps — the host credential floor — is named as retained here rather
 * than reported as surrendered.
 *
 * The `platform` parameter defaults rather than being required so the existing
 * caller keeps compiling and keeps reporting the host it is running on.
 */
export function resolveSandboxFilesystemConsequences(
  settings: ResolvedSandboxSettings,
  platform: NodeJS.Platform = process.platform,
  options: {
    /**
     * The host-seeded credential denies, when the caller holds them.
     *
     * Optional for the same reason as on {@link resolveSandboxReadAllowlist}:
     * this module is upstream of the package that owns them. Supplied, the roots
     * the floor covers are kept OUT of the surrendered list — they are the one
     * filesystem rule that survives the key. Omitted, the retention is still
     * stated, and the per-root lines simply are not filtered.
     */
    credentialFloor?: readonly string[];
  } = {},
): readonly string[] {
  const entry = (value: string): string => sanitizeSettingsDiagnostic(value, MAX_ENTRY_LENGTH);
  const allowlist = resolveSandboxReadAllowlist(settings, { platform });
  const readAllowlistLines = allowlist.allowedReadRoots.length === 0
    ? []
    : [
        `sandbox.filesystem.allowRead: ${allowlist.allowedReadRoots.length} entr`
        + `${allowlist.allowedReadRoots.length === 1 ? 'y' : 'ies'}`
        + `${settings.filesystem.allowManagedReadPathsOnly ? ', managed entries only' : ''}`
        + `, ${allowlist.platformCanEnforce ? 'enforced' : 'NOT enforceable'} on ${platform}`
        + `${allowlist.restrictsReads ? '' : ', restricting nothing'}.`
        + ' The host credential deny floor is emitted after every entry here, so an allowRead'
        + ' naming a credential path does not re-open it.',
        ...allowlist.allowedReadRoots.map(root => `  allowRead "${entry(root)}"`),
        ...allowlist.unenforceable,
      ];
  if (!settings.filesystem.disabled) return Object.freeze(readAllowlistLines);
  const lines: string[] = [
    'sandbox.filesystem.disabled is true: the filesystem layer is OFF. Network isolation still'
    + ' applies, and so does the host credential deny floor named at the end of this section;'
    + ' every write and read restriction listed between them does not.',
    'Self-config protection is SURRENDERED (sandboxing.md#protected-paths): a sandboxed command may'
    + ' now write'
    + " Nessy's settings files at every scope and the managed settings directory, so it can change"
    + ' the policy that governs the next command.',
    'The linked-worktree carve-outs go with it: `.git/hooks` and `.git/config` in a shared git'
    + ' directory (sandboxing.md#filesystem-isolation) are writable again.',
  ];
  for (const root of settings.deniedWriteRoots) {
    lines.push(`sandbox.deniedWriteRoots "${entry(root)}" is NOT enforced while the filesystem layer is off.`);
  }
  const credentialFloor = new Set(options.credentialFloor ?? []);
  for (const root of settings.deniedReadRoots) {
    if (credentialFloor.has(root)) continue;
    lines.push(`sandbox.deniedReadRoots "${entry(root)}" is NOT enforced while the filesystem layer is off.`);
  }
  // The one filesystem rule that outlives the key, stated even when the caller
  // supplied no floor to filter by. `sandboxing.md#protected-paths` names exactly
  // what the key turns off — the deny rules a settings file wrote — and is silent
  // on a credential floor because Claude ships none
  // (`#protect-credentials`: "There is no built-in credential deny list, so only
  // the files and variables you list are restricted."). Ours is composed in the isolation funnel rather than
  // from a settings file, and `filesystem.disabled` is settable at user scope, so
  // releasing it here would let one boolean in a user file hand over ~/.ssh,
  // ~/.aws and the gateway token under ~/.nessy.
  lines.push(
    'The host credential deny floor is RETAINED with the layer off: it is composed in the isolation'
    + ' funnel, not from a settings file, so no settings layer releases it. The credential read denies'
    + ' still bind, and ~/.gitconfig stays unwritable.',
  );
  return Object.freeze([...lines, ...readAllowlistLines]);
}

/**
 * What the host isolation primitive will actually do about outbound traffic.
 *
 * `open` leaves the profile's network dimension exactly as the isolation
 * profile chose it — which for our foreground shell is `(allow network*)`, the
 * owner decision of 2026-07-28. `denied` cuts every outbound connection for
 * every sandboxed command, whatever profile it asked for.
 *
 * There is no third value, and that is a platform fact rather than a design
 * preference. See {@link resolveSandboxNetworkEnforcement}.
 */
export type SandboxEgressDecisionV1 = 'open' | 'denied';

export interface SandboxNetworkEnforcementV1 {
  /** The decision the isolation backend applies. */
  egress: SandboxEgressDecisionV1;
  /** Which setting produced {@link egress}, for a diagnostics surface. */
  source: 'default' | 'allowManagedDomainsOnly';
  /**
   * One line per configured domain rule that NO backend can express, ready to
   * print. Never silently empty: whatever is listed here is a rule the
   * administrator wrote and the sandboxed shell does not obey.
   */
  unenforceable: readonly string[];
}

/**
 * The reason every entry in {@link SandboxNetworkEnforcementV1.unenforceable}
 * exists, stated once so both readers print the same sentence.
 *
 * `sandboxing.md#network-isolation` — "Network access is controlled through a
 * proxy server running outside the sandbox" — and `#set-up-linux-and-wsl2` names
 * `socat` as "the relay used to route network traffic through the sandbox proxy".
 * Upstream's domain filtering is a PROXY, not a sandbox rule, precisely because
 * the OS primitives `#os-level-enforcement` names cannot express a hostname:
 * "**macOS**: uses Seatbelt for sandbox enforcement", "**Linux**: uses bubblewrap
 * for isolation", "**WSL2**: uses bubblewrap, same as Linux". (That last claim
 * was previously hung on `sandbox-environments.md:69` with a quoted sentence —
 * "Seatbelt, the built-in macOS sandbox, and bubblewrap on Linux and WSL2" — that
 * is not on the 2026-08-25 fetch of that 178-line page.)
 *
 * Measured, not assumed. Seatbelt's own compiler refuses every domain form:
 * `(remote ip "github.com:443")` and `(remote tcp "github.com:443")` both fail
 * with `host must be * or localhost in network address`, and `(remote host …)`
 * / `(remote domain …)` are not filters at all ("unbound variable"). The same
 * refusal covers an IP literal — `(remote ip "140.82.121.4:443")` is rejected
 * with the identical message — so "resolve the domain and pin the address" is
 * not an available fallback either, and would in any case be a rule that any
 * DNS change or CDN rotation quietly voids. `unshare -n` and
 * `firejail --net=none` are whole-namespace switches, and the Windows
 * restricted-token profile carries a single `network.enabled` boolean.
 *
 * So on every backend we have, outbound network is one bit. The per-domain
 * layer is the egress proxy (R19), deliberately parked.
 */
const NO_DOMAIN_FILTER =
  'no supported isolation backend can filter by domain (sandboxing.md#network-isolation uses a'
  + ' proxy for this;'
  + ' Seatbelt rejects any host but * or localhost, unshare/firejail toggle the whole namespace,'
  + ' and the Windows profile has one network.enabled boolean)';

/**
 * Turn resolved network settings into the one decision a backend can apply.
 *
 * Two rules, both fail-closed:
 *
 * 1. `allowManagedDomainsOnly` DENIES EGRESS OUTRIGHT.
 *    `sandboxing.md#network-isolation` — "non-allowed domains are blocked
 *    automatically instead of prompting" —
 *    points in the restrict direction, and with no way to express the allowlist
 *    the only faithful over-approximation is to allow nothing. Denying more than
 *    the administrator asked is visible and recoverable; allowing everything
 *    they locked is the silent void this unit exists to remove. Every
 *    `allowedDomains` entry is then reported as unenforceable, because the
 *    administrator expected those hosts to stay REACHABLE.
 * 2. `deniedDomains` without the lock cannot be enforced at all. It is a
 *    carve-out inside an otherwise open egress, and there is no hook for one.
 *    Denying everything instead would block the whole internet in answer to a
 *    three-entry deny list, so the honest outcome is an unchanged profile and a
 *    diagnostic. `settings-reference.md#sandbox-network-denieddomains` keeps
 *    these merged from every source regardless of the lock — "Claude Code
 *    merges this list from every settings source the session loads even when
 *    `allowManagedDomainsOnly` is set, so a developer can always tighten the
 *    deny list" — which {@link resolveSandboxSettings} already does;
 *    the Monitor websocket guard still applies them to its own targets.
 *
 * Pure, and unchanged for anyone who never writes the keys: with no
 * `sandbox.network` at all this returns `open` with nothing to report, so the
 * foreground shell keeps the profile it has today.
 */

/**
 * Why a `sandbox.network` domain entry can match NO host at all, or `null` when
 * it can match something — P6.326 half (b).
 *
 * The one consumer that still enforces these lists is the Monitor websocket
 * guard (`config/network-address-guard.ts`), and it compares a URL's HOSTNAME:
 * brackets stripped, lowercased, no port, no scheme. So an entry carrying a port
 * or a scheme is compared against a value that can never contain one, and the
 * administrator's rule is dead on arrival — silently, because a rule that never
 * fires produces no evidence.
 *
 * **The row's rule is corrected here by measurement.** It asked for "two or more
 * unbracketed colons"; driven against the real guard, that is both too narrow
 * and too wide. Each entry below was given to `isDeniedNetworkTarget` against
 * the hosts `example.com`, `api.example.com`, `2606:4700::1111` and
 * `[2606:4700::1111]`:
 *
 * | entry | matches | colons |
 * | --- | --- | --- |
 * | `example.com` | both names | 0 |
 * | `*.example.com` | both names | 0 |
 * | `example.com:443` | NOTHING | 1 — under the row's rule this escapes |
 * | `https://example.com` | NOTHING | 1 — escapes too, and it is the common typo |
 * | `ex:am:ple.com` | NOTHING | 2 |
 * | `[2606:4700::1111]` | the address, both spellings | 3, bracketed |
 * | `2606:4700::1111` | the address, both spellings | 3 — the row's rule would flag a WORKING entry |
 * | `[2606:4700::1111]:443` | NOTHING | 4 |
 *
 * The separating property is not the colon count: it is whether what remains
 * after normalisation is a valid IPv6 literal. An unbracketed IPv6 works and
 * must not be flagged; a one-colon `host:port` does not work and must be.
 *
 * A bare `*` and an empty entry are the same silent void from a different
 * spelling — `matchesDomain` refuses both on purpose, so that both an allowlist
 * cannot become "allow all" from one typo and nothing is matched by accident —
 * and an administrator who wrote one deserves to be told rather than to infer it.
 */
export function unmatchableDomainReason(value: string): string | null {
  const trimmed = value.trim();
  const withoutWildcard = trimmed.startsWith('*.') ? trimmed.slice(2) : trimmed;
  const normalized = withoutWildcard.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (normalized.length === 0) return 'the entry is empty';
  if (normalized === '*') {
    return 'a bare "*" is refused on purpose, so that one typo cannot turn a list into "match everything";'
      + ' write the domains, or *.example.com for a subtree';
  }
  if (!normalized.includes(':')) return null;
  if (isIP(normalized) === 6) return null;
  return 'it carries a port or a scheme, and the host guard compares a bare hostname'
    + ' (brackets stripped, lowercased, no port, no scheme), so no target can ever equal it';
}

export function resolveSandboxNetworkEnforcement(
  network: ResolvedSandboxNetworkSettings,
): SandboxNetworkEnforcementV1 {
  const entry = (value: string): string => sanitizeSettingsDiagnostic(value, MAX_ENTRY_LENGTH);
  // The spelling line comes FIRST and replaces the key's own line, because the
  // two say incompatible things. `deniedDomains`'s line ends "It still applies
  // to Monitor websocket targets" — true for every well-formed entry and FALSE
  // for one that can match no host, which is exactly the reader who most needs
  // to be told. Appending would leave an administrator two sentences and no way
  // to know which one governs.
  const spelling = (key: string, domain: string): string | null => {
    const reason = unmatchableDomainReason(domain);
    return reason === null
      ? null
      : `sandbox.network.${key} "${entry(domain)}" matches NO host at all: ${reason}.`
        + ' It is enforced nowhere — not by a sandboxed command, and not by the Monitor'
        + ' websocket guard that still applies the well-formed entries.';
  };
  if (network.allowManagedDomainsOnly) {
    return Object.freeze({
      egress: 'denied' as const,
      source: 'allowManagedDomainsOnly' as const,
      unenforceable: Object.freeze(network.allowedDomains.map(domain =>
        spelling('allowedDomains', domain)
        ?? `sandbox.network.allowedDomains "${entry(domain)}" is NOT reachable from a sandboxed command:`
          + ` allowManagedDomainsOnly is enforced as a total egress deny because ${NO_DOMAIN_FILTER}.`)),
    });
  }
  return Object.freeze({
    egress: 'open' as const,
    source: 'default' as const,
    unenforceable: Object.freeze(network.deniedDomains.map(domain =>
      spelling('deniedDomains', domain)
      ?? `sandbox.network.deniedDomains "${entry(domain)}" is NOT enforced for sandboxed commands:`
        + ` ${NO_DOMAIN_FILTER}. It still applies to Monitor websocket targets.`
        + ' Set sandbox.network.allowManagedDomainsOnly to deny sandboxed egress outright.')),
  });
}

/**
 * Whether `command` is permitted to run outside isolation by an
 * `excludedCommands` pattern, and which pattern matched.
 *
 * Patterns are shell-style globs matched against the WHOLE command string
 * (`docker *` matches `docker ps`, not `sudo docker ps`). A command matching
 * nothing is not excluded, which is what keeps isolation failing closed by
 * default.
 */
export function matchExcludedCommand(
  command: string,
  excludedCommands: readonly string[],
): string | undefined {
  for (const pattern of excludedCommands) {
    if (globMatches(pattern, command)) return pattern;
  }
  return undefined;
}

/**
 * Anchored `*`/`?` glob. No `**`, no character classes, no path semantics.
 *
 * ## GRANT-GLOB-NEWLINE — the missing `s` flag is a DECISION, not an omission
 *
 * `.` without the `s` flag refuses all four JavaScript line terminators (LF, CR,
 * U+2028, U+2029), so `*` here does NOT cross a newline. Three sibling compilers
 * carried the identical gap on DENY paths, where it was a bypass, and one `s`
 * closed it. **This one keeps the gap on purpose. Adding `s` here is an owner
 * call, not a tidy-up**, because the two callers point in opposite directions:
 *
 * - `ProcessSupervisor.resolveIsolationDowngrade` — a match runs the command
 *   **outside the sandbox**. Measured: with `s`, the entry `docker *` unsandboxes
 *   `docker ps<LF>rm -rf $HOME`. One glob, two commands, no isolation.
 * - `pre-tool-use.ts` — a match forces the risky band, so there `s` would
 *   *tighten*. Same function, opposite directions; neither caller decides alone.
 *
 * The documentation settles the direction rather than leaving it to taste.
 * `settings-reference.md#sandbox-excludedcommands`: "Each entry uses the same
 * syntax as the content of a `Bash(...)` permission rule: an exact command, a
 * prefix such as `docker *`, or a wildcard pattern." And `permissions.md#bash`:
 * "The recognized command separators are `&&`, `||`, `;`, `|`, `|&`, `&`, and
 * newlines. A rule must match each subcommand independently." A newline in this
 * string is therefore a documented SEPARATOR, and a `*` crossing it would
 * approve text on both sides of a separator it never inspected — the thing that
 * sentence forbids.
 *
 * The same answer applies to the other grant compilers carrying this omission.
 * `config/__tests__/grant-glob-newline-policy.test.ts` states it once and pins
 * them, and is where a future `s`-flag sweep should arrive.
 *
 * A load-bearing consequence lives two files away: `automations/hook-env-file.ts`
 * joins its Bash preamble with `;`/space rather than a newline BECAUSE of this,
 * or every `*docker*`-style exclusion would stop matching the moment a hook wrote
 * an env var. `automations/hook-env-file.test.ts` pins that join.
 */
function globMatches(pattern: string, value: string): boolean {
  const expression = pattern.replace(/[.*+?^${}()|[\]\\]/g, match => (
    match === '*' ? '.*' : match === '?' ? '.' : `\\${match}`
  ));
  return new RegExp(`^${expression}$`).test(value);
}
