/**
 * `/config` — read and change a setting from the prompt (P6.410, denominator L73).
 *
 * ## Why the host, and why an allowlist
 *
 * Native-first, asked and answered: claude's own `/config` lives inside the
 * closed binary behind its own settings store, which we deliberately do not
 * delegate to (we own settings composition — L1); codex has no prompt-level
 * settings verb in `packages/codex-protocol` at all. So this is case 2 — ONE
 * host command over the settings store we already own, identical on all three
 * runtimes.
 *
 * The keys are an ALLOWLIST, and that is a product decision stated rather than
 * queued (owner rule 2026-08-28, transparent and simple). `/config` is typed
 * into the same composer a model can be asked to summarise, so a `/config`
 * that could reach every setter would be a prompt-adjacent path to
 * `bypassPermissionsAcknowledged`, `allowRemoteEvaluate`, the sandbox toggle
 * and the proxy configuration. None of those belong to a chat message. The
 * refusal names the whole allowlist, so a user who tries a key that is not here
 * learns what IS reachable instead of meeting silence — and everything else
 * stays where it already is, in the settings UI.
 *
 * ## Shape
 *
 *  - `/config`            — list every reachable key with its current value
 *  - `/config <key>`      — read one
 *  - `/config <key>=<v>`  — write one, then report what it now reads
 *
 * There is no `/config reset` and no nested path syntax: the smallest honest
 * thing, with the residue stated instead of half-built.
 */
import {
  getDefaultThinkingLevel, setDefaultThinkingLevel,
  getMemoryEnabled, setMemoryEnabled,
  getRichToolDescriptions, setRichToolDescriptions,
  getNotificationsEnabled, setNotificationsEnabled,
  getOutputStyleId, setOutputStyleId,
  getCrossSessionInbound,
  CROSS_SESSION_INBOUND_ENV_NAME,
  CROSS_SESSION_INBOUND_SETTINGS,
} from '../config/storage.ts';
import { THINKING_LEVEL_IDS, type ThinkingLevel } from '../agent/thinking-levels.ts';

/**
 * One prompt-reachable setting: how to read it, how to write it, what it
 * accepts. Exported so {@link runSessionConfigCommand} can be driven over a
 * substitute table — the real one writes to the user's `config.json`, and a test
 * that had to build a valid v2 storage tree to assert a refusal message would be
 * measuring the storage layout instead of this command.
 */
export interface SessionConfigKey {
  /** The name typed after `/config`. Deliberately short, not the storage field name. */
  key: string;
  /** Human-readable accepted values, shown in the listing and in a refusal. */
  accepts: string;
  read: () => string;
  /** `null` means the value was rejected; the caller reports `accepts`. */
  write: (raw: string) => boolean | null;
  /**
   * P6.182 clause (i) — why this row is not offered right now, or `undefined`
   * when it is.
   *
   * `cross-session-messaging.md#control-inbound-messages`, verbatim: the row
   * *"doesn't appear while managed settings or the `--settings` flag sets the
   * key, since a user-settings value wouldn't apply then."* A row that writes a
   * value something else outranks is worse than no row: it reports success and
   * changes nothing.
   *
   * The reason is a SENTENCE rather than a boolean because a row that silently
   * vanishes and a row that says why are different products, and the second one
   * is the one a user can act on.
   */
  unavailable?: () => string | undefined;
  /**
   * P6.182 clause (i) — refuse the `key=value` form for this key, with this
   * message.
   *
   * The page, verbatim: *"Claude Code rejects the `/config
   * crossSessionInbound=value` shorthand for this key."* The reason transfers
   * exactly: the shorthand is a one-line write typed into a chat composer, and
   * this key's value is subject to a precedence chain the composer cannot show —
   * so a shorthand that appeared to work would be the same "wrote it and it does
   * not apply" defect the {@link SessionConfigKey.unavailable} gate exists to
   * prevent, arriving through the one path that gate does not cover.
   */
  rejectsInlineWrite?: string;
}

function parseBoolean(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'on' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'off' || normalized === '0') return false;
  return null;
}

function booleanKey(
  key: string,
  read: () => boolean,
  write: (value: boolean) => boolean,
): SessionConfigKey {
  return {
    key,
    accepts: 'true | false',
    read: () => String(read()),
    write: raw => {
      const parsed = parseBoolean(raw);
      return parsed === null ? null : write(parsed);
    },
  };
}

/**
 * Every setting `/config` can reach. Five, chosen because each is a
 * per-preference switch a user plausibly changes mid-conversation and NONE of
 * them can widen a permission, expose a credential or change an egress path.
 * Adding a key here is a deliberate act: read this module's header first.
 */
export const SESSION_CONFIG_KEYS: readonly SessionConfigKey[] = [
  {
    key: 'thinking',
    accepts: THINKING_LEVEL_IDS.join(' | '),
    read: () => getDefaultThinkingLevel(),
    write: raw => {
      const normalized = raw.trim().toLowerCase();
      return (THINKING_LEVEL_IDS as readonly string[]).includes(normalized)
        ? setDefaultThinkingLevel(normalized as ThinkingLevel)
        : null;
    },
  },
  {
    key: 'outputStyle',
    accepts: 'an installed output-style id',
    read: () => getOutputStyleId(),
    write: raw => (raw.trim() ? setOutputStyleId(raw.trim()) : null),
  },
  booleanKey('memory', getMemoryEnabled, setMemoryEnabled),
  booleanKey('richToolDescriptions', getRichToolDescriptions, setRichToolDescriptions),
  booleanKey('notifications', getNotificationsEnabled, setNotificationsEnabled),
  {
    /**
     * P6.182 clause (i) — the page's own `/config` row, under the page's own
     * name.
     *
     * `cross-session-messaging.md#control-inbound-messages`: *"Beyond editing a
     * settings file, you can select the value in the `/config` row **Messages
     * from your other sessions**. Claude Code writes the value you select to
     * your user settings."*
     *
     * IT IS READ-ONLY FROM THE PROMPT, and that is the page's design rather than
     * a shortfall: the row is a SELECTOR, and the same sentence rejects the
     * shorthand that would be its keyboard equivalent. The write path is
     * `setCrossSessionInbound`, for a settings surface that can show the
     * precedence the value is subject to. Reading it here still answers the
     * question a user types `/config` to ask, and the refusal below says where
     * the value is chosen instead of leaving them at a wall.
     *
     * The allowlist header asks that adding a key be deliberate: this one can
     * neither widen a permission nor expose anything. Its whole range is how
     * strictly THIS session treats text arriving from the user's own other
     * sessions, and every value it can hold is at least as strict as `accept`.
     */
    key: 'crossSessionInbound',
    accepts: CROSS_SESSION_INBOUND_SETTINGS.join(' | '),
    read: () => getCrossSessionInbound()
      ?? 'unset (the two sessions\' permission modes decide per message)',
    write: () => null,
    unavailable: () => (process.env[CROSS_SESSION_INBOUND_ENV_NAME]?.trim()
      ? `${CROSS_SESSION_INBOUND_ENV_NAME} sets this key, so a user-settings value would not apply.`
      : undefined),
    rejectsInlineWrite: 'This value is chosen in Settings, not from the prompt, because it is '
      + 'subject to a precedence chain a one-line write cannot show you: an operator value '
      + 'outranks it, and a stricter .claude/settings.json or .claude/settings.local.json '
      + 'tightens whatever wins.',
  },
];

function findKey(name: string, keys: readonly SessionConfigKey[]): SessionConfigKey | undefined {
  const normalized = name.trim().toLowerCase();
  return keys.find(entry => entry.key.toLowerCase() === normalized);
}

/** Every reachable key with its current value — the `/config` bare form. */
export function formatSessionConfigListing(keys: readonly SessionConfigKey[] = SESSION_CONFIG_KEYS): string {
  const rows = keys
    // P6.182 (i) — a row something else outranks is not listed, per the page.
    .filter(entry => entry.unavailable?.() === undefined)
    .map(entry => `  ${entry.key} = ${entry.read()}   (${entry.accepts})`)
    .join('\n');
  return `Settings reachable from the prompt:\n${rows}\n\n`
    + 'Change one with /config <key>=<value>. Everything else — permissions, sandboxing, '
    + 'credentials, proxies — is deliberately not reachable from a chat message and lives in Settings.';
}

/**
 * Answer one `/config` invocation. Pure with respect to its arguments: the only
 * side effect is the settings write, which is the point.
 */
export function runSessionConfigCommand(
  key?: string,
  value?: string,
  keys: readonly SessionConfigKey[] = SESSION_CONFIG_KEYS,
): string {
  if (!key) return formatSessionConfigListing(keys);

  const entry = findKey(key, keys);
  if (!entry) {
    return `"${key}" is not reachable from the prompt.\n\n${formatSessionConfigListing(keys)}`;
  }

  // P6.182 (i) — named explicitly, a hidden row SAYS why rather than pretending
  // not to exist: the listing omits it, and anybody who knows the name learns
  // what outranks it. Checked before the read as well as before the write,
  // because reporting a user value that does not apply is the same lie.
  const unavailable = entry.unavailable?.();
  if (unavailable) return `${entry.key} is not settable here. ${unavailable}`;

  if (value === undefined) {
    return `${entry.key} = ${entry.read()}   (${entry.accepts})`;
  }

  if (entry.rejectsInlineWrite) {
    return `${entry.key} cannot be set with ${entry.key}=<value>. ${entry.rejectsInlineWrite}`;
  }

  const written = entry.write(value);
  if (written === null) {
    return `"${value}" is not a valid value for ${entry.key}. Accepts: ${entry.accepts}.`;
  }
  if (!written) {
    return `${entry.key} could not be saved — the settings file was not writable.`;
  }
  return `${entry.key} = ${entry.read()}`;
}
