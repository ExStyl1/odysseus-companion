/**
 * Admin-pushed version floor and ceiling —
 * `settings-reference.md#requiredmaximumversion` and `#requiredminimumversion`.
 *
 * Both were cited by LINE NUMBER on the settings page until 2026-08-28 — the
 * old anchor is named in words here rather than spelled, because spelling it
 * would re-create the citation the correction repairs. That page has since
 * SPLIT: it is now scope/precedence/how-to-edit, and the key-by-key reference
 * moved to `settings-reference.md` — so those anchors were dead at the PAGE
 * level and renumbering could not have fixed them. Both entries were also
 * REWRITTEN, so the block quotes below are today's, and the superseded wording
 * ("Managed settings only. Maximum Claude Code version allowed to start …") is
 * recorded here rather than silently replaced.
 *
 * > Set the newest Claude Code version your organization allows to start. When
 * > the running version is newer, Claude Code exits at startup and tells the
 * > user to install an approved version through your organization's approved
 * > method; `claude install <version>` may also work.
 *
 * > Set the oldest Claude Code version your organization allows to start. When
 * > the running version is older, Claude Code exits at startup and tells the
 * > user to update through your organization's approved method. The check runs
 * > at startup only, so a session that's already running continues.
 *
 * The `minimumVersion` contrast survives, now stated from the other entry:
 * "Unlike `minimumVersion`, which only prevents downgrades, this key blocks
 * startup."
 *
 * ## The other two version keys, and why neither is carried — P6.243
 *
 * `minimumVersion` and `autoUpdatesChannel` are documented managed keys and are
 * in no schema here. Both are recorded **`n/a` for a single-channel product**,
 * with the measurement, rather than left as an unexplained absence:
 *
 * **`autoUpdatesChannel`** — `settings-reference.md#autoupdateschannel`: "Choose
 * which release channel background auto-updates and `claude update` follow."
 * This product has **no runtime channel to choose**. The channel is baked into
 * the artifact at build time: `apps/electron/electron-builder.yml` writes
 * `publish.channel: "${env.NESSY_DESKTOP_UPDATE_CHANNEL}"` beside
 * `publish.url: "${env.NESSY_DESKTOP_UPDATE_URL}"`, so channel and feed are one
 * decision made by the release job, and a built app has exactly one feed. An
 * administrator cannot move an installed build between channels, so there is
 * nothing for the key to enforce.
 *
 * **`minimumVersion`** — `settings-reference.md#minimumversion`: "Keep
 * background auto-updates and `claude update` from installing any version below
 * this one, **so moving to the `\"stable\"` channel doesn't downgrade you from a
 * newer `\"latest\"` build**." Its stated purpose is the channel switch above,
 * which does not exist here; and the protection it provides is already in force
 * natively. `electron-updater`'s `allowDowngrade` defaults to `false` and
 * `AppUpdater.isUpdateAvailable` ends `return this.allowDowngrade &&
 * isLatestVersionOlder`, so a feed offering an older build than the running one
 * is refused. Measured at HEAD: `allowDowngrade` occurs in **0** tracked files
 * under `packages/**` and `apps/**` (positive control on the same globs:
 * `autoDownload`, which the updater and its test do set), so nothing here
 * overrides that default. Native-first step 1: the mechanism is the runtime's
 * own and is already on.
 *
 * **The coupling to check before implementing either.** `allowDowngrade` is not
 * independent of the channel: `AppUpdater`'s channel SETTER assigns
 * `this.allowDowngrade = true` — its own doc says so ("`allowDowngrade` will be
 * automatically set to `true`. If this behavior is not suitable for you, simple
 * set `allowDowngrade` explicitly after"). So the day `autoUpdatesChannel` is
 * implemented by setting `autoUpdater.channel`, downgrade protection turns
 * itself OFF and `minimumVersion` stops being redundant. **The two keys are one
 * commit or neither**, and `__tests__/managed-version-gate.test.ts` pins the
 * absence in both directions so this cannot happen quietly.
 *
 * ## Fail open, in three places
 *
 * `managed-settings.md#keys-that-fail-closed` — "`requiredMinimumVersion` and
 * `requiredMaximumVersion` fail open by design: an invalid value is dropped
 * rather than enforced, so a bad policy push can't prevent Claude Code from
 * starting." (Two words moved under the old citation: "dropped", not
 * "stripped"; "can't", not "cannot". The rule is unchanged.)
 *
 * That rule is honoured at every point where this gate could be wrong:
 *
 * 1. **An invalid BOUND** is stripped by the policy parser before it reaches
 *    here, so an unparseable value never becomes a refusal.
 * 2. **An unparseable RUNNING version** resolves to `allowed`. Refusing to
 *    start because we could not read our own version string is the exact
 *    failure :202 exists to prevent, and it would be self-inflicted.
 * 3. **A bound with no comparable segments** — `"latest"`, `""` — is treated as
 *    absent for the same reason.
 *
 * ## Why the comparison is deliberately small
 *
 * Versions here are `major.minor.patch` with an optional suffix; the repo's own
 * versions (`apps/electron/package.json`, root `package.json`) are exactly that
 * shape. Only the numeric dot-separated head is compared, and a prerelease
 * suffix is IGNORED rather than ordered: `2.1.150-beta.1` is treated as
 * `2.1.150`. Full semver precedence would make `2.1.150-beta.1` sort BELOW
 * `2.1.150`, so an org that pinned `requiredMinimumVersion: "2.1.150"` would
 * refuse to start a build it had itself approved — a refusal invented by
 * ordering rules the admin never wrote. Fail-open governs the ambiguous case.
 */

/** The comparable head of a version string: its leading numeric segments. */
function numericSegments(value: string): number[] | undefined {
  const head = value.trim().split(/[-+]/, 1)[0] ?? ''
  if (head.length === 0) return undefined
  const parts = head.split('.')
  const segments: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break
    segments.push(Number(part))
  }
  return segments.length > 0 ? segments : undefined
}

/**
 * `-1`, `0`, `1`, or `undefined` when either side has no comparable head.
 * Missing trailing segments read as `0`, so `2.1` and `2.1.0` are equal.
 */
export function compareManagedVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = numericSegments(a)
  const right = numericSegments(b)
  if (!left || !right) return undefined
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const one = left[index] ?? 0
    const two = right[index] ?? 0
    if (one < two) return -1
    if (one > two) return 1
  }
  return 0
}

/** A version string an admin could have meant. Bounded; digits, dots, suffix. */
export const MANAGED_VERSION_PATTERN = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]{1,32})?$/

export type ManagedVersionGateOutcomeV1 = 'allowed' | 'below-minimum' | 'above-maximum'

export interface ManagedVersionGateDecisionV1 {
  readonly outcome: ManagedVersionGateOutcomeV1
  /** Admin-facing cause. Carries version strings only, never a payload. */
  readonly reason?: string
  /**
   * What the user can do about it — `#requiredmaximumversion`'s "your
   * organization's approved method".
   */
  readonly recovery?: string
}

const ALLOWED: ManagedVersionGateDecisionV1 = Object.freeze({ outcome: 'allowed' as const })

export interface ManagedVersionGateOptions {
  /** The running version. */
  version: string
  requiredMinimumVersion?: string | undefined
  requiredMaximumVersion?: string | undefined
}

/**
 * Decide whether this build may start.
 *
 * Returns a decision; it never exits, because "how to refuse" differs between
 * the desktop shell (an error dialog then quit) and the headless server (stderr
 * then a non-zero exit) — the same split `managed-refresh-gate.ts` makes.
 */
export function enforceManagedVersionGate(
  options: ManagedVersionGateOptions,
): ManagedVersionGateDecisionV1 {
  const { version, requiredMinimumVersion, requiredMaximumVersion } = options
  if (requiredMinimumVersion) {
    const comparison = compareManagedVersions(version, requiredMinimumVersion)
    if (comparison === -1) {
      return Object.freeze({
        outcome: 'below-minimum' as const,
        reason: `running version ${version} is below the required minimum ${requiredMinimumVersion}`,
        recovery: `This organization requires Nessy Desktop ${requiredMinimumVersion} or newer. `
          + 'Update through your organization\'s approved method, then start Nessy Desktop again.',
      })
    }
  }
  if (requiredMaximumVersion) {
    const comparison = compareManagedVersions(version, requiredMaximumVersion)
    if (comparison === 1) {
      return Object.freeze({
        outcome: 'above-maximum' as const,
        reason: `running version ${version} is above the allowed maximum ${requiredMaximumVersion}`,
        recovery: `This organization allows Nessy Desktop up to ${requiredMaximumVersion}. `
          + 'Install an approved version through your organization\'s approved method, '
          + 'then start Nessy Desktop again.',
      })
    }
  }
  // Includes every `undefined` comparison: an unparseable running version or an
  // uncomparable bound fails OPEN (`managed-settings.md#keys-that-fail-closed`).
  return ALLOWED
}
