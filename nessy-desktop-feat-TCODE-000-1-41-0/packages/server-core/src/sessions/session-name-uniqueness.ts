/**
 * C3.224 (= row D1.80 of the integrations plan, carried from P6.464) — two live
 * sessions may not quietly hold one name.
 *
 * ## The contract
 *
 * `sessions.md#name-your-sessions`, verbatim: *"When you start or resume an
 * interactive session with a name that another live session on this machine
 * already uses, or rename a session into such a name, Claude Code leaves the
 * name with the session that already has it, renames yours to a variant with a
 * two-word suffix, such as `auth-refactor-graceful-unicorn`, and tells you. Run
 * `/rename` with a new name if you'd rather pick one yourself."*
 *
 * `cross-session-messaging.md#see-which-sessions-claude-can-reach` says why it
 * is load-bearing rather than cosmetic: *"One session answers to the name:
 * Claude Code delivers the message on the name alone."* Without uniqueness, "a
 * bare name matching exactly one live session" is unsatisfiable and addressing
 * is silently ambiguous — which is the denominator's own reason for landing N5
 * with N4 rather than after it.
 *
 * ## What is NOT checked, and it is the page's own list
 *
 * `sessions.md#name-your-sessions` names three cases where the duplicate is
 * deliberately left alone, *"so you can still see two sessions with the same
 * name in listings"*, and the first is the one that governs this fork: *"It
 * doesn't check AI-generated titles or default display names."* Most sessions
 * here are named by `generateTitle`, not by a person. That is why this helper is
 * called from `renameSession` and from nowhere else: that method's own docblock
 * already records that *"every caller of this method is an EXPLICIT naming —
 * `/rename`, the sidebar, or a hook's `sessionTitle`"*, and it is the method
 * that sets `titleSetExplicitly`. Hooking the automatic writers instead would
 * implement the opposite of the page.
 *
 * ## The word list is OURS, and that is recorded rather than hidden
 *
 * The page publishes the SHAPE (`<name>-<word>-<word>`) and one example
 * (`graceful-unicorn`); no page publishes the vocabulary Claude Code draws from,
 * and the vendored binary is closed. Searched: `graceful-unicorn` appears in the
 * corpus only as that one example. So the two lists below are invented, which is
 * the last rung of the read-don't-invent ladder and is recorded here with its
 * reason — the alternative was to invent a DIFFERENT SHAPE, which would diverge
 * from the documented one for no gain. Nothing reads the vocabulary except this
 * file; a variant is matched by structure, never by word.
 */

/** 16 x 16 = 256 distinct suffixes, which is far past the number of live sessions a machine holds. */
const VARIANT_ADJECTIVES: readonly string[] = [
  'graceful', 'brave', 'calm', 'clever', 'eager', 'gentle', 'jolly', 'keen',
  'lively', 'merry', 'noble', 'quiet', 'swift', 'tidy', 'warm', 'witty',
]

const VARIANT_NOUNS: readonly string[] = [
  'unicorn', 'otter', 'falcon', 'heron', 'ibex', 'lynx', 'marten', 'osprey',
  'puffin', 'quokka', 'raven', 'salmon', 'tapir', 'vervet', 'walrus', 'zebra',
]

/**
 * How many random suffixes are tried before the deterministic fallback.
 *
 * A bounded loop rather than an exhaustive walk of all 256: the walk would be
 * the same answer at 256 times the cost, and the fallback below is correct for
 * the case the loop cannot reach.
 */
const VARIANT_ATTEMPTS = 32

/**
 * The half of a session row this module needs to answer "is this name taken".
 *
 * A structural subset of `ManagedSession` rather than the type itself: the rule
 * is about names and liveness, and depending on the 100-field session record
 * would make it untestable without building one.
 */
export interface SessionNameHolderV1 {
  readonly id: string
  /**
   * Optional, matching `ManagedSession`: a session can exist before anything has
   * named it. An unnamed row holds no name and therefore displaces nobody.
   */
  readonly name?: string | undefined
  readonly hidden?: boolean | undefined
  readonly isArchived?: boolean | undefined
}

/**
 * Whether another LIVE session already answers to `candidate`.
 *
 * Archived and hidden rows are excluded for the same reason
 * `markAllSessionsRead` excludes them: they are not sessions anyone can address,
 * and holding a name against one would displace a name nobody can reach.
 *
 * `exceptSessionId` is the session being named — without it, a rename to the
 * name a session already has would displace it from itself, which is the one
 * case where the answer must be "free".
 */
export function isSessionNameTaken(
  candidate: string,
  holders: Iterable<SessionNameHolderV1>,
  exceptSessionId: string,
): boolean {
  for (const holder of holders) {
    if (holder.id === exceptSessionId) continue
    if (holder.hidden || holder.isArchived) continue
    if (holder.name && holder.name === candidate) return true
  }
  return false
}

export interface SessionNameResolutionV1 {
  /** The name to assign. Equal to the requested name when nothing else held it. */
  readonly name: string
  /**
   * The name that was requested and could not be taken, present ONLY when a
   * variant was assigned. Its presence is what tells the caller to tell the
   * user — the page's *"and tells you"* — so a caller cannot report a rename it
   * did not make by comparing two strings itself.
   */
  readonly displacedFrom?: string
}

/**
 * The name this session may take, given who already holds what.
 *
 * `isTaken` answers for LIVE sessions other than this one; deciding which
 * sessions are live is the caller's, because only it knows about archived,
 * hidden and other-workspace rows. `pick` is injectable so a test reads a
 * deterministic suffix without stubbing `Math.random` for the whole process.
 *
 * An empty or whitespace-only request is returned unchanged: refusing a blank
 * name is `renameSession`'s own question, and answering it here would put two
 * different refusals on one path.
 */
export function resolveUniqueSessionName(
  requested: string,
  isTaken: (candidate: string) => boolean,
  pick: (bound: number) => number = (bound) => Math.floor(Math.random() * bound),
): SessionNameResolutionV1 {
  if (!requested.trim()) return { name: requested }
  if (!isTaken(requested)) return { name: requested }

  for (let attempt = 0; attempt < VARIANT_ATTEMPTS; attempt += 1) {
    const adjective = VARIANT_ADJECTIVES[pick(VARIANT_ADJECTIVES.length) % VARIANT_ADJECTIVES.length]
    const noun = VARIANT_NOUNS[pick(VARIANT_NOUNS.length) % VARIANT_NOUNS.length]
    const candidate = `${requested}-${adjective}-${noun}`
    if (!isTaken(candidate)) return { name: candidate, displacedFrom: requested }
  }

  // Unreachable with 256 suffixes and any realistic number of live sessions, and
  // still written: a loop that can end without an answer would return the taken
  // name, which is the silent duplicate this whole module exists to prevent.
  for (let ordinal = 2; ; ordinal += 1) {
    const candidate = `${requested}-${ordinal}`
    if (!isTaken(candidate)) return { name: candidate, displacedFrom: requested }
  }
}

/**
 * Whether a name is the variant shape this module assigns for `requested`.
 *
 * Exported for the tests and for any surface that wants to say "this is the
 * variant of that": matched by STRUCTURE — the requested name, a hyphen, a word
 * from each list — so the vocabulary above stays a private detail that can grow
 * without breaking a reader.
 */
export function isSessionNameVariantOf(candidate: string, requested: string): boolean {
  if (!candidate.startsWith(`${requested}-`)) return false
  const suffix = candidate.slice(requested.length + 1).split('-')
  if (suffix.length !== 2) return false
  const [adjective, noun] = suffix
  return VARIANT_ADJECTIVES.includes(adjective ?? '') && VARIANT_NOUNS.includes(noun ?? '')
}
