/**
 * The mach services a sandboxed command may look up by name, and nothing else.
 *
 * ## Why this file exists
 *
 * Both darwin seatbelt profiles used to emit a bare `(allow mach-lookup)`. That
 * rule has no filter, so it grants EVERY registered mach service by name, and it
 * was emitted for `read-only`, `workspace`, `networked` and `plugin-mcp` alike.
 * The probe that proved it: `sandbox-exec -p '<profile>' /usr/bin/pbpaste`
 * returned 0 — a sandboxed command read the user's pasteboard, which is whatever
 * they last copied. The same grant reached `com.apple.CoreServices.coreservicesd`
 * and `com.apple.lsd.mapdb`, i.e. LaunchServices, which is how `open` launches an
 * arbitrary application outside the sandbox.
 *
 * A filtered `(allow mach-lookup (global-name …) …)` denies every name not listed.
 *
 * ## Why the list is not empty
 *
 * Deleting the grant instead of narrowing it is the tempting move and the wrong
 * one: a profile that denies every mach service degrades ordinary commands, and a
 * sandbox that breaks `git` gets switched off, after which it protects nothing.
 * Every name below was requested by a real command in the probe battery, read out
 * of the kernel's own sandbox log (`log show --predicate 'eventMessage CONTAINS
 * "deny(1) mach-lookup"'`) while the grant was absent, and each one is here
 * because removing it produces the named symptom.
 *
 * ## What is deliberately NOT here
 *
 * `com.apple.pasteboard.1` (the finding), the three LaunchServices names
 * (`com.apple.CoreServices.coreservicesd`, `com.apple.lsd.mapdb`,
 * `com.apple.lsd.modifydb`), `com.apple.DiskArbitration.diskarbitrationd`,
 * `com.apple.analyticsd`, and the keychain (`com.apple.SecurityServer`) — a
 * sandboxed command that can ask the keychain for a secret defeats the credential
 * deny roots this package already emits. None of them were needed by any command
 * in the battery.
 *
 * ## Per-platform
 *
 * Mach is a darwin concept and has no counterpart on the other two backends, so
 * there is nothing to narrow there rather than a parity gap to close: Linux
 * bubblewrap/firejail confine the mount namespace and expose no name-based IPC
 * broker, and the Windows sandbox profile has no IPC section at all. A sandboxed
 * Linux command reaches D-Bus only through the socket in the filesystem, which the
 * mount policy already governs.
 */

/**
 * Requested by every command in the battery, in every profile.
 *
 * - `com.apple.system.opendirectoryd.libinfo` — `getpwuid`/`getgrgid`. Without it
 *   `id -un` and `whoami` print the raw uid (`503`) instead of the user name, and
 *   every `~user` expansion and `getpwnam` caller sees no record.
 * - `com.apple.system.opendirectoryd.membership` — group membership. Empirically
 *   it also serves the `_dirhelper` path below; both names were observed as
 *   separate denials from one `git` invocation.
 * - `com.apple.bsd.dirhelper` — `confstr(_CS_DARWIN_USER_TEMP_DIR)`. Without it
 *   every `/usr/bin/git` and `/usr/bin/python3` call (the xcrun shims) prints
 *   `confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR` and
 *   then fails to write its cache into the `/tmp` it falls back to.
 * - `com.apple.system.notification_center` and `com.apple.logd` — `notify_*` and
 *   `os_log`, requested by literally every process including `/bin/echo`. Neither
 *   carries user data, and leaving them out buys nothing but a kernel denial
 *   report per command in the user's system log.
 */
export const SANDBOX_MACH_SERVICES: readonly string[] = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.bsd.dirhelper',
  'com.apple.system.notification_center',
  'com.apple.logd',
];

/**
 * Additional names for the network-capable profiles (`networked`, `plugin-mcp`)
 * only — the ones that reach DNS and TLS.
 *
 * - `com.apple.SystemConfiguration.configd` — the resolver configuration
 *   `getaddrinfo` reads. Observed as a `curl` denial on a name lookup.
 * - `com.apple.TrustEvaluationAgent` and `com.apple.trustd.agent` — X.509 trust
 *   evaluation. Observed as denials from `curl` mid-handshake and from
 *   `security verify-cert` respectively, against a purely local TLS fixture.
 * - `com.apple.trustd` is the one name in this file that no probe requested. It is
 *   the system-scope endpoint of the same daemon as `com.apple.trustd.agent`, and
 *   it is kept because the case that needs it — validating a chain that terminates
 *   in the system trust store, i.e. every real HTTPS endpoint an MCP CLI talks to
 *   — cannot be probed without reaching an external host. Recorded as such in
 *   `docs/superpowers/plans/2026-07-30-sandbox-mach-and-protected-paths.md` § 5.
 *
 * None of the four grants access to user data; they grant name resolution and
 * certificate-chain evaluation. A network profile that cannot do either is the
 * failure the network branch exists to prevent.
 */
export const NETWORK_SANDBOX_MACH_SERVICES: readonly string[] = [
  'com.apple.SystemConfiguration.configd',
  'com.apple.TrustEvaluationAgent',
  'com.apple.trustd',
  'com.apple.trustd.agent',
];

/**
 * One filtered `mach-lookup` allow. Every name not listed stays denied by the
 * profile's `(deny default)`.
 *
 * Throws on an empty list rather than emitting `(allow mach-lookup)`: seatbelt
 * reads a filterless rule as "every service", so a bug that emptied the list
 * would silently restore the unfiltered grant this module exists to remove.
 */
export function machLookupRule(services: readonly string[]): string {
  if (services.length === 0) throw new Error('mach-lookup-allowlist-empty');
  const names = services.map(service => `(global-name "${service}")`).join(' ');
  return `(allow mach-lookup ${names})`;
}
