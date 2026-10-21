/**
 * Source connection-timing settings (T10, plugin-install plan § 9b).
 *
 * Owner decision § 0b-4 makes Claude's contract ours by default: "At session
 * startup, Claude Code connects the servers for enabled plugins automatically"
 * (`mcp.md`). The bank's former connect-by-intent posture is PRESERVED as a
 * setting: `sources.connectOnStartup` in `config.json` (default `true`), with
 * a managed-policy key (`connectSourcesOnStartup`) so a strict deployment
 * restores connect-by-intent fleet-wide.
 *
 * Composition matches `autoCompactEnabled`: every layer can only narrow —
 * `false` at either layer is terminal, and neither layer can force the other
 * back on. With the resolved value `false` the session-start connect path is
 * never entered at all, which is what keeps that posture byte-identical to
 * the pre-T10 behaviour.
 */

/** The `sources` block of `config.json` — the USER layer. */
export interface SourceStartupSettingsV1 {
  /** Connect enabled servers at session start (default: true). */
  readonly connectOnStartup?: boolean;
}

/**
 * Tolerant parse of the user `sources` layer: only a literal boolean is read;
 * anything else is ignored so a bad edit falls back to the default rather
 * than wedging session start.
 */
export function parseSourceStartupSettingsV1(value: unknown): SourceStartupSettingsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return typeof record.connectOnStartup === 'boolean'
    ? { connectOnStartup: record.connectOnStartup }
    : {};
}

/**
 * Resolve whether servers connect at session start. `false` at either layer
 * is terminal; unset means the Claude-parity default (on).
 */
export function resolveConnectSourcesOnStartup(input: {
  userEnabled?: boolean | undefined;
  managedEnabled?: boolean | undefined;
} = {}): boolean {
  return input.userEnabled !== false && input.managedEnabled !== false;
}
