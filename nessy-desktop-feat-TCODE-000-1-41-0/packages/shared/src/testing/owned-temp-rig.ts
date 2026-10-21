/**
 * F1.850 — the ONE owned temp folder for suites whose rigs the project
 * contribution detector walks ABOVE, and the probe that proves nothing up there
 * is read.
 *
 * Since F1.844 and F1.847, `detectProjectContributions` does not stop at the
 * folder it is given: it climbs to the nearest `.git` (the repository root,
 * through `outputStyleProjectRootFor`) and past it, reading the CLAUDE.md chain,
 * `.claude/` and `.mcp.json` of every parent, up to the filesystem root for a
 * folder outside the home directory and to just below the home directory for one
 * under it. A suite that builds its rigs in `os.tmpdir()` therefore reads every
 * directory above `$TMPDIR` too. A `.git` there turns the "outside a repository"
 * cases into repository cases, and a stray `CLAUDE.md` or `.mcp.json` there
 * reddens the "empty folder" cases, each as an assertion diff that names neither
 * cause. Neither exists on macOS `/var/folders` or on Linux CI `/tmp` today; the
 * guard is for the machine where one does.
 *
 * {@link createOwnedRigBase} makes one folder under `os.tmpdir()` for a suite's
 * rigs and refuses, by name, when anything above it carries a marker. It does not
 * skip: a suite that silently skipped on such a machine would report coverage it
 * did not run. {@link rigAncestorMarkers} is exported so the absence it asserts
 * has its positive control (`__tests__/owned-temp-rig.test.ts`).
 *
 * Callers: `capabilities/__tests__/project-contribution-detect.test.ts` and
 * `apps/electron/src/renderer/lib/__tests__/project-trust-gate.test.ts`.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

/**
 * What the detector reads in a directory ABOVE a rig: the repository marker, the
 * CLAUDE.md chain, the `.claude/` directory (its CLAUDE.md, rules, skills, agents,
 * commands and local settings) and `.mcp.json`. AGENTS.md and `.codex/` are read
 * above a folder only inside a repository, so the `.git` entry covers them.
 */
export const RIG_ANCESTOR_MARKERS = ['.git', 'CLAUDE.md', 'CLAUDE.local.md', '.claude', '.mcp.json'] as const;

/**
 * Every marker in the directories strictly above `dir` (walked on its real
 * path, as the detector walks), nearest first, as absolute paths.
 *
 * `home`, when given, mirrors the detector's default home stop: for a `dir`
 * under it, the home directory and everything above it are checked for `.git`
 * only (the repository walk has no home stop; the claude walk does). Omit it for
 * a suite that also passes its own home seam, whose walks run past the real
 * home directory to the filesystem root.
 */
export function rigAncestorMarkers(dir: string, home?: string): string[] {
  const real = realpathSync(dir);
  let realHome: string | undefined;
  if (home !== undefined) {
    try {
      realHome = realpathSync(home);
    } catch {
      realHome = home;
    }
  }
  const underHome = realHome !== undefined && real.startsWith(realHome + sep);
  const found: string[] = [];
  let current = real;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return found;
    current = parent;
    const claudeReadsHere = !underHome || current.startsWith(`${realHome}${sep}`);
    for (const marker of RIG_ANCESTOR_MARKERS) {
      if (marker !== '.git' && !claudeReadsHere) continue;
      if (existsSync(join(current, marker))) found.push(join(current, marker));
    }
  }
}

/**
 * A fresh folder under `os.tmpdir()` for one suite's rigs (spelled as `mkdtemp`
 * returned it, not realpathed), after checking that no directory above it
 * carries a {@link RIG_ANCESTOR_MARKERS} entry; throws, naming each one found,
 * when any does. Call it from `beforeAll` and remove the folder in `afterAll`.
 */
export function createOwnedRigBase(prefix: string, home?: string): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const found = rigAncestorMarkers(base, home);
  if (found.length === 0) return base;
  rmSync(base, { recursive: true, force: true });
  throw new Error(
    `F1.850: ${found.join(', ')} sits above the temp directory ${tmpdir()}, and the project `
    + 'contribution detector walks into it from every rig this suite builds there, so its '
    + '"outside a repository" and "empty folder" cases would fail for a reason they do not name. '
    + `Point TMPDIR at a folder whose parents carry none of ${RIG_ANCESTOR_MARKERS.join(', ')}.`,
  );
}
