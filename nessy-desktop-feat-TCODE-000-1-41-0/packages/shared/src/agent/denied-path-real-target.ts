/**
 * F1.711 (origin WJ-crit-q P-WJcritq-4) — where a file-tool or search target
 * REALLY is, so the `deniedPaths` floor can judge the file a symlink reaches and
 * not only the link's own name.
 *
 * ## What went wrong
 *
 * `getDeniedPathViolation` (`mode-manager.ts`) compared the path it was given,
 * lexically. A workspace link to a denied file or directory — `notes.txt` to a
 * `.env`, `cloud/` to `~/.aws/` — matched no pattern, so `Read` (and `Write`,
 * `Edit`, `Grep`, …) of the link passed the floor in every mode, while the same
 * file named directly was refused. F1.694's `call_llm` attachment reader
 * already judged an attachment a second time at its `realpathSync`; the named
 * file tools did not. Measured by DN-115 on 2026-09-26 with an in-process rig
 * (`denied-path-real-target.test.ts`): the link arms were ALLOWED at HEAD.
 *
 * ## The contract
 *
 * Claude's own rule, `permissions.md#read-and-edit`: "When Claude accesses a
 * symlink, permission rules check two paths: the symlink itself and the file it
 * resolves to." and "Deny rules: apply when either the symlink path or its
 * target matches. A symlink that points to a denied file is itself denied."
 * Since v2.1.268 the same page also has Claude apply a deny pattern written
 * through a symlinked folder at the folder's real location (the row's
 * `/etc/**` on macOS, where `/etc` is a link to `private/etc`) — behaviour the
 * shipped SDK (2.1.274) already carries for its own settings rules. Pi has no
 * permission mechanism of its own and follows Claude's pages; this host floor
 * is the one gate all three runtimes reach, so the rule lands here once.
 *
 * ## What this does
 *
 * For an ABSOLUTE path (after the caller's `~`/`$HOME` expansion) it returns the
 * real path when that differs from the path given, else nothing. A path that
 * does not exist yet (a `Write` of a new file) is resolved at its nearest
 * existing ancestor with the missing segments re-appended — the walk
 * `isPathWithinDirectory` in `mode-manager.ts` already does on the GRANT side, so
 * a new file written through a linked directory is judged where it will land.
 * F1.1120 adds three arms, every one an extra DENY candidate, so each can only
 * refuse more, never grant:
 *
 * - **a dangling link** is judged at the target its link NAMES, resolved at the
 *   target's own nearest existing ancestor — `realpathSync` fails for it, but
 *   the link itself still says where a read or write would land. The climb arm
 *   (the link's own name at its real parent) stays in the answer, so nothing
 *   F1.711 denied is lost. Link cycles are depth-bounded, not trusted to ELOOP.
 * - **a relative path with a known base** (`deniedPathRealCandidates`) is
 *   resolved against the SESSION working directory before the real-path step —
 *   the same posture `core/pre-tool-use.ts` states for rule targets (a relative
 *   Pi path is the session folder's, not this host process's cwd). Without a
 *   base the floor declines to resolve rather than inventing `process.cwd()`,
 *   exactly like the read fence one screen up in `mode-manager.ts`.
 * - **a pattern written through a symlinked folder**
 *   (`deniedPathsWithRealAnchors`) is re-anchored at the real location of its
 *   literal prefix: `/etc/**` on macOS also compiles a `/private/etc/**` arm,
 *   beside the original spelling. Both arms report under the pattern the
 *   operator actually wrote.
 *
 * RESIDUE, stated rather than left to be found: a relative path WITHOUT a base
 * is still judged lexically (at the host process's cwd, the matcher's own
 * resolve — declined, not invented); a `~`-anchored pattern's own home is not
 * re-anchored when the home sits behind a symlinked folder (the expansion is
 * absolute, but the anchor walk here judges only patterns whose expanded
 * prefix realpath differs); the PowerShell write-target guesses stay name-only
 * (they are guesses, and guessing a realpath judges a file nobody opens); and
 * a `Bash` token is judged at its real path only when one exists to resolve —
 * the shell's own variable expansion is still the matcher's business (P6.673).
 */
import { readlinkSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, resolve } from 'path';

/** A link cycle must not recurse forever — eight hops is past any real chain. */
const MAX_LINK_HOPS = 8;

export function deniedPathRealTargets(expandedPath: string, depth = 0): string[] {
  if (!isAbsolute(expandedPath)) return [];
  // F1.711's contract: an already-real path contributes nothing — the filter
  // runs HERE only, once; the walk below pushes its raw results so the
  // recursion for a link TARGET is not silenced by its own input.
  return deniedPathRealTargetsWalk(expandedPath, depth).filter((p) => p !== expandedPath);
}

function deniedPathRealTargetsWalk(expandedPath: string, depth: number): string[] {
  const found: string[] = [];
  const missing: string[] = [];
  let current = expandedPath;
  while (true) {
    try {
      const real = join(realpathSync.native(current), ...missing);
      found.push(real);
      break;
    } catch {
      // F1.1120 — a DANGLING link names a file that does not exist yet; the
      // link itself still says where that file will land. Judge the target at
      // ITS nearest existing ancestor, BESIDE the climb below (which keeps the
      // link's own name at its real parent, as F1.711 answered).
      if (depth < MAX_LINK_HOPS) {
        try {
          const target = readlinkSync(current);
          const absoluteTarget = isAbsolute(target) ? target : join(dirname(current), target);
          found.push(...deniedPathRealTargetsWalk(absoluteTarget, depth + 1));
        } catch {
          // Absent plain name, or not a symlink: the climb below continues.
        }
      }
      // Absent, or not a directory on the way: climb to the nearest ancestor that exists.
    }
    const parent = dirname(current);
    if (parent === current) break;
    missing.unshift(basename(current));
    current = parent;
  }
  return found;
}

/**
 * F1.1120 — every DENY candidate a path yields: its real targets when absolute
 * (F1.711's arm), and — when the path is RELATIVE and the caller knows the
 * session's working directory — the session-resolved spelling plus ITS real
 * targets. Callers push the raw spelling themselves, so this only ever adds.
 *
 * UB12.60 — `base` may name SEVERAL directories (the told working directory and
 * where the runtime's tools really run, which differ for a session with no
 * project): a relative path is resolved at each distinct one, still only adding.
 */
export function deniedPathRealCandidates(
  rawPath: string,
  expandHomeFn: (path: string) => string,
  base?: string | readonly (string | undefined)[],
): string[] {
  const expanded = expandHomeFn(rawPath);
  if (isAbsolute(expanded)) return deniedPathRealTargets(expanded);
  const bases = new Set<string>();
  for (const entry of typeof base === 'string' ? [base] : base ?? []) {
    const workingDirectory = entry?.trim();
    if (workingDirectory) bases.add(resolve(workingDirectory));
  }
  return [...bases].flatMap(workingDirectory => {
    const sessionPath = resolve(workingDirectory, expanded);
    return sessionPath === expanded ? deniedPathRealTargets(sessionPath) : [sessionPath, ...deniedPathRealTargets(sessionPath)];
  });
}

/**
 * The real location of a deny pattern's LITERAL prefix — the re-anchoring
 * Claude Code has applied to its own deny rules since v2.1.268. `/etc/**`
 * written on macOS (where `/etc` links to `private/etc`) yields
 * `/private/etc/**`, so a tool that reaches the same file at its real path is
 * denied by the pattern written through the link. `null` when the pattern has
 * no absolute literal prefix, or that prefix is already at its real location.
 *
 * Memoized per expanded pattern: symlink topology does not move under a
 * running process, and the matcher sits on the hot gate path — the cache turns
 * one `realpathSync` per pattern per PROCESS into one per pattern per CALL.
 * A stale cache could only miss a deny (never manufacture one), and only in
 * the window where an operator re-links a folder mid-session.
 */
const realPatternAnchors = new Map<string, string | null>();

function realAnchorOfPattern(expandedPattern: string): string | null {
  const cached = realPatternAnchors.get(expandedPattern);
  if (cached !== undefined) return cached;
  let computed: string | null = null;
  const cut = expandedPattern.search(/[*?]/);
  const literal = cut === -1 ? expandedPattern : expandedPattern.slice(0, cut);
  if (isAbsolute(literal)) {
    // `path.dirname` IGNORES trailing separators, so `/etc/` would dirname to
    // `/` and the anchor subject would climb one level too far. A literal that
    // ENDS with a separator names its directory as the subject; otherwise the
    // subject is the literal's directory. A bare root-level entry (`/etc`,
    // subject `/`) has no anchor — stated residue.
    const trimmed = literal.replace(/[\\/]+$/, '');
    const subject = trimmed.length > 0 && trimmed.length < literal.length ? trimmed : dirname(literal);
    try {
      const real = realpathSync.native(subject);
      if (real !== subject) computed = real + expandedPattern.slice(subject.length);
    } catch {
      computed = null;
    }
  }
  realPatternAnchors.set(expandedPattern, computed);
  return computed;
}

/**
 * F1.1120 — the deny loop's pattern list with each entry's REAL-LOCATION
 * spelling alongside it. `pattern` is always the line the operator wrote (the
 * refusal must name it); `anchored` is the spelling the loop compiles — the
 * expanded original for the primary entry, the re-anchored form as a second
 * entry when the pattern's literal prefix sits behind a symlinked folder.
 * `primary` gates the matcher's unreadable-token heuristic, which must run
 * once per operator entry, not once per spelling of it.
 */
export interface DeniedPathAnchorPair {
  readonly pattern: string;
  readonly anchored: string;
  readonly primary: boolean;
}

export function deniedPathsWithRealAnchors(
  patterns: readonly string[],
  expandHomeFn: (pattern: string) => string,
): DeniedPathAnchorPair[] {
  const pairs: DeniedPathAnchorPair[] = [];
  for (const pattern of patterns) {
    const expanded = expandHomeFn(pattern);
    pairs.push({ pattern, anchored: expanded, primary: true });
    const anchored = realAnchorOfPattern(expanded);
    if (anchored) pairs.push({ pattern, anchored, primary: false });
  }
  return pairs;
}
