/**
 * The paths `git status --porcelain -z` names — one parser for every gate that
 * decides which files to read from DISK rather than as their index blob.
 *
 * F1.195 wrote it for `check-comment-globs.ts`; F1.271 moved it here so
 * `check-nul-bytes.ts` reads the same fields the same way, and F1.452 routed
 * `check-shape-pointer-reasons.ts` through it too. The NUL gate parsed the
 * porcelain WITHOUT `-z`, and without `-z` git C-quotes a path carrying a
 * space, a quote or a non-ASCII byte (` M "with space.ts"`, a Cyrillic name as
 * octal escapes): the slice kept the quotes, matched no enumerated file, and
 * the gate read the STALE index blob — a NUL byte added in the working tree
 * went unreported. With `-z` a path is printed verbatim and NUL-terminated.
 *
 * A rename or copy entry carries its ORIGIN as the NEXT field — in EITHER
 * status column: `git status`'s own table lists `R`/`C` for the index (X) and
 * for the work tree (Y), and says ORIG_PATH "is only shown when the entry is
 * renamed or copied". The origin is skipped, never parsed as an entry. F1.454:
 * this tested X only, so a work-tree rename — git's rename detection pairs an
 * intent-to-add (`git add -N`) file with a deleted one as ` R new\0old` — had
 * its origin read as an entry, and an origin beginning with R or C then
 * swallowed the NEXT real entry, which every caller read as its stale blob. An
 * untracked `??` path is named too and harmless: the callers enumerate with
 * `git ls-files`, which never lists it.
 *
 * Residue every caller shares, stated rather than hidden:
 *  - a file marked assume-unchanged or skip-worktree is never reported dirty by
 *    `git status`, so it is read as its blob (0 such files in this tree when
 *    F1.271 landed);
 *
 * F1.488 (2) closed the second bullet this list used to carry: the ORIGIN of a
 * WORK-TREE rename (` R new\0old`) is still in the index and gone from the
 * disk — exactly a ` D` — but arrived as an origin, so it was never named and
 * every caller read it as its stale index blob. It is now named dirty (and still
 * never parsed as an entry), so a caller's loader skips it as the pending
 * deletion it is. Only the work-tree column: an INDEX rename's origin has left
 * the index too, so no caller enumerating with `git ls-files` can meet it, and a
 * copy's origin is still on disk, where reading it reads the same bytes.
 */
export function parsePorcelainZ(raw: string): Set<string> {
  const fields = raw.split('\0')
  const dirty = new Set<string>()
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!
    if (entry.length < 4) continue
    dirty.add(entry.slice(3))
    if (entry[1] === 'R' && fields[i + 1]) dirty.add(fields[i + 1]!) // F1.488 (2) — a work-tree rename's origin: a pending deletion
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i++
  }
  return dirty
}
