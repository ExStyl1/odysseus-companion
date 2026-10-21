/**
 * The one per-platform system directory an organization deploys machine-wide
 * Nessy configuration into.
 *
 * `third-party-integrations.md:329`: "**Organization-wide**: Deploy to system
 * directories such as `/Library/Application Support/ClaudeCode/CLAUDE.md`
 * (macOS), `/etc/claude-code/CLAUDE.md` (Linux and WSL), or
 * `C:\Program Files\ClaudeCode\CLAUDE.md` (Windows) for company-wide standards".
 * `memory.md:279`-`:281` repeats the same three locations as the Steps block of
 * "Deploy organization-wide CLAUDE.md".
 *
 * This fork already resolved these three paths ONCE, for `managed-policy.json`
 * (`server-core/src/pi-harness/managed-policy-loader.ts`). Spelling them a
 * second time for the managed CLAUDE.md is how the two drift: an org deploys
 * both files to the directory its policy demonstrably reaches, and only one of
 * them is read. So the directory is resolved here and both readers join their
 * own filename onto it.
 *
 * Nessy-branded rather than `ClaudeCode`/`claude-code`, matching the existing
 * managed-policy paths — this is our product's machine-wide directory, not a
 * Claude Code installation's.
 *
 * ## The Windows path is the DOCUMENTED one now — P6.235, and the migration cost
 * turned out to be zero
 *
 * It used to join `%ProgramData%` while the header quoted
 * `C:\Program Files\ClaudeCode\`, and P3.331 recorded that as a product
 * decision rather than a fix: *"Changing it here MIGRATES every org that has
 * already deployed into `%ProgramData%\Nessy`."* **Measured, that migration is
 * empty.** Since P3.331 both win32 tiers refuse everything at the old location —
 * `loadManagedPiPolicyWithDiagnostics` drops the whole tier before reading a
 * byte, and {@link managedFileTrustVerdict} answers `unverifiable-platform` — so
 * no Windows organization has a managed file being honoured today, and nothing
 * that works is being moved. What changes is where an administrator DEPLOYS,
 * and a policy still sitting at the old path is refused with a drop that names
 * the new one rather than in silence (see the loader's win32 arm).
 *
 * The page is the reason for the destination, not our preference:
 * `managed-settings.md#where-each-mechanism-stores-the-policy` names the same
 * three directories and adds, verbatim, "Claude Code doesn't read the legacy
 * Windows path `C:\ProgramData\ClaudeCode\managed-settings.json`."
 * `%ProgramData%` is world-writable by default on Windows and
 * `C:\Program Files` is not, which is why the upstream moved and why the
 * location is itself the control: the page's own words for it are "admin ACL by
 * default".
 *
 * **`ProgramFiles`, not `ProgramW6432`.** A 32-bit process on 64-bit Windows
 * reads `C:\Program Files (x86)` from this variable. Nessy Desktop ships x64
 * and arm64 builds only, so the two agree here; a future 32-bit build would need
 * `ProgramW6432` and would otherwise read a directory an administrator never
 * deployed to. Named rather than defended against, because guarding for a build
 * we do not ship is a control this repo would state and not have.
 *
 * **What this is NOT: an ACL read.** Nothing here asks Windows who owns the
 * directory. The control is the location's default ACL plus the loader's
 * symlink/reparse and containment checks, which is the same control the page
 * relies on. A real ACL check (`icacls`) or the
 * `HKLM\SOFTWARE\Policies\…` registry route stays the stronger answer and
 * stays parked with the Windows evidence day, P3.7. **No Windows rig exists, so
 * every claim about this path is unit-tested through the loader's injected
 * platform/filesystem seams and NONE is a live measurement.**
 *
 * The instruction tier is deliberately NOT moved with it:
 * {@link managedFileTrustVerdict} still answers `unverifiable-platform` on
 * win32, so a managed `CLAUDE.md` there is still refused. One tier at a time,
 * and that tier is the un-excludable one — `memory.md`: "Managed policy
 * CLAUDE.md files cannot be excluded" — so it waits for the stronger control
 * rather than inheriting a location-based one.
 */

import { lstatSync, type Stats } from 'node:fs';
import { dirname, win32 } from 'node:path';

/**
 * The system directory for `platform`, or `undefined` where there is none.
 *
 * `undefined` rather than a throw: the capability inventory runs on every turn
 * and an unsupported platform must simply contribute no managed tier. The
 * policy loader, which must fail closed, converts the `undefined` itself.
 */
export function managedSystemDirForPlatform(
  platform: NodeJS.Platform = process.platform,
  programFiles = process.env.ProgramFiles,
): string | undefined {
  if (platform === 'darwin') return '/Library/Application Support/Nessy';
  if (platform === 'linux') return '/etc/nessy';
  if (platform === 'win32' && programFiles) return win32.join(programFiles, 'Nessy');
  return undefined;
}

/**
 * The win32 directory this product USED to read, so a refusal can name it.
 *
 * `undefined` on every other platform: nothing moved there, and a caller that
 * gets a path back is being told "this machine may have a policy at the old
 * location". Its only job is the loader's migration diagnostic — never a read.
 */
export function legacyManagedSystemDirForPlatform(
  platform: NodeJS.Platform = process.platform,
  programData = process.env.ProgramData,
): string | undefined {
  return platform === 'win32' && programData ? win32.join(programData, 'Nessy') : undefined;
}

/** The managed instruction file's name. `memory.md:279`-`:281` names only this one. */
export const MANAGED_INSTRUCTION_FILE = 'CLAUDE.md';

function writableByOthers(stat: Stats): boolean {
  return (stat.mode & 0o022) !== 0;
}

function ownedByHostOrSelf(stat: Stats): boolean {
  if (stat.uid === 0) return true;
  const self = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return self !== undefined && stat.uid === self;
}

/**
 * Why a caller may not use the managed file — richer than a boolean so the
 * inventory can SAY which of the two "no"s it got (P3.331).
 *
 * - `trusted` — the checks below passed.
 * - `untrusted` — they ran and failed: the file is absent, is a symlink, is
 *   group/world-writable, or belongs to another account.
 * - `unverifiable-platform` — they could not run at all. This is the win32 case
 *   and it used to be spelled `return true`, i.e. a trust guard that answered
 *   "trusted" precisely where it had checked nothing.
 */
export type ManagedFileTrustVerdict = 'trusted' | 'untrusted' | 'unverifiable-platform';

/**
 * Whether `path` is a managed file this machine's administrator actually owns,
 * as a three-way verdict. {@link isHostOwnedManagedFile} is the boolean view.
 *
 * ## win32 FAILS CLOSED, and that is a posture change (P3.331, 2026-09-04)
 *
 * This guard opened with `if (platform === 'win32') return true` — before the
 * ownership and mode checks, so on Windows the un-excludable managed
 * instruction tier was granted to whatever file happened to sit at the path.
 * Three facts make that more than theoretical, and all three are measurable
 * off the Windows host we do not have:
 *
 *  1. **P6.235 UPDATE, 2026-09-06 — this clause has changed and the verdict has
 *     not.** It read: *"The directory is `%ProgramData%\Nessy`, the location the
 *     upstream calls legacy and stopped reading; `%ProgramData%` is writable by
 *     ordinary accounts by default."* {@link managedSystemDirForPlatform} now
 *     returns `%ProgramFiles%\Nessy`, whose default ACL is administrator-only,
 *     so the location argument that made this urgent is spent. What is left is
 *     the argument that was always the load-bearing one, clause 3.
 *  2. Nothing in this repository ever CREATES that directory with an
 *     administrator ACL — the installer is `perMachine: false` and no build
 *     script touches either system directory — so on a machine where the
 *     directory does not already exist, whichever account creates it first
 *     authors the tier. Under `%ProgramFiles%` that account has to be an
 *     administrator; that is a default, not a check, and this function performs
 *     no check.
 *  3. `memory.md`: "Managed policy CLAUDE.md files cannot be excluded." The
 *     tier a user cannot turn off is the one whose provenance must be checked
 *     hardest — which is why the policy loader may rest on the location's
 *     default ACL (P6.235) and this tier still does not.
 *
 * The obvious repair — delete the early return and let the POSIX checks run —
 * is WRONG on Windows and darwin CI cannot see it: Node derives the win32
 * `mode` from the read-only attribute, so `mode & 0o022` is non-zero for
 * essentially every ordinary file and the guard would refuse every legitimate
 * policy while looking correct. So the honest answer is neither `true` nor the
 * POSIX regime: it is "this platform has no implemented check", said out loud,
 * with the tier withheld until a Windows host proves a real one (ACL-based, or
 * the `HKLM\SOFTWARE\Policies\…` registry route the page prescribes — the
 * native-first candidate). The Windows evidence day is parked with P3.7.
 *
 * Cost of the posture, stated because it is real: a Windows organization that
 * deploys a managed `CLAUDE.md` today has it silently applied, and after this
 * change it is not applied and the inventory says so. That is the direction
 * that cannot be exploited.
 *
 * ## What the POSIX regime checks, unchanged
 *
 * Both the file and its containing directory must be regular nodes (never a
 * symlink, so a link planted in a writable directory cannot redirect the read),
 * unwritable by group and other, and owned by root or by the current user.
 *
 * Deviation from `managed-policy-loader.ts`'s stricter regime, deliberately:
 * that loader demands `uid === 0` and `realpath(path) === path`. Both are right
 * for a policy file that ships permission rules, and both make the tier
 * untestable without root — `realpath` in particular fails for every macOS
 * temporary directory, since `/var` is itself a symlink. Accepting the current
 * user as an owner keeps the property that matters (no OTHER unprivileged
 * account can plant the file) while leaving the guard exercisable by a test
 * that only needs `chmod`.
 */
export function managedFileTrustVerdict(
  path: string,
  platform: NodeJS.Platform = process.platform,
): ManagedFileTrustVerdict {
  if (platform === 'win32') return 'unverifiable-platform';
  let fileStat: Stats;
  let dirStat: Stats;
  try {
    fileStat = lstatSync(path);
    dirStat = lstatSync(dirname(path));
  } catch {
    return 'untrusted';
  }
  if (!fileStat.isFile() || !dirStat.isDirectory()) return 'untrusted';
  if (writableByOthers(fileStat) || writableByOthers(dirStat)) return 'untrusted';
  return ownedByHostOrSelf(fileStat) && ownedByHostOrSelf(dirStat) ? 'trusted' : 'untrusted';
}

/**
 * Whether `path` is a managed file this machine's administrator actually owns.
 *
 * The managed tier CANNOT be turned off by the user — `memory.md:336`: "Managed
 * policy CLAUDE.md files cannot be excluded. This ensures organization-wide
 * instructions always apply regardless of individual settings." That is exactly
 * why the read needs a guard the excludable tiers do not: a group- or
 * world-writable `/etc/nessy` would otherwise be an un-excludable
 * instruction-injection channel for any other account on the box.
 *
 * See {@link managedFileTrustVerdict} for the win32 posture and the reason the
 * verdict is three-valued underneath this boolean.
 */
export function isHostOwnedManagedFile(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return managedFileTrustVerdict(path, platform) === 'trusted';
}
