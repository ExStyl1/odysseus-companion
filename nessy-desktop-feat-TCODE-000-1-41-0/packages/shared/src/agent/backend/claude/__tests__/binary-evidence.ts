/**
 * P3.171 — telling *"the artefact CONTAINS this name"* apart from *"the
 * artefact ACTS ON this name"*, as a reusable instrument rather than a habit.
 *
 * ## Why a membership count is not a verdict
 *
 * Two rows in this plan reasoned from a name's presence in a vendored artefact
 * and had to be walked back. P3.134 found the cached-settings reader in
 * `sdk.mjs` to be a stub and warned that the 89-name withhold array is
 * MEMBERSHIP evidence, not proof the filter runs. P3.145 then measured the
 * native binary's copy of that filter to be a real body — so the same array
 * means different things in two files we ship together.
 *
 * ## The correction this file exists to carry (measured 2026-09-01, load 9.93)
 *
 * **The stub is a property of the ARTEFACT, not of the name, and "the shipped
 * binary" names two different artefacts.** We ship both
 * `@anthropic-ai/claude-agent-sdk/sdk.mjs` (1 264 122 bytes) and
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (272 553 824 bytes), and
 * they do not agree about what is read. Counted with one instrument on one rig,
 * `python3` regex over the whole file:
 *
 * | artefact | `NAME:()=>accessor` entries | distinct names read as `process.env.NAME` | both |
 * | --- | --- | --- | --- |
 * | `sdk.mjs` | 834 | 89 | 81 |
 * | native `claude` | 1247 | 579 | 428 |
 *
 * So in `sdk.mjs` **753 of 834 declared names have no reader in that file at
 * all**. P3.134's stub is not an exception there; it is the rule, and an
 * accessor-existence probe run against that file cannot separate any name from
 * any other. Every accessor in `sdk.mjs` has exactly two references — its
 * declaration and its export-registry entry — including `CLAUDE_CONFIG_DIR`,
 * which the same file reads six times DIRECTLY through `process.env`.
 *
 * **And P3.171's own headline is half wrong.** Its second stub — the
 * remote-settings path — is unread in `sdk.mjs` and has a REAL BODY in the
 * native binary, quoted from it verbatim:
 *
 *   `let t=RFe();if(t)return C(\`Remote settings: Using override file ${t}`
 *   `(CLAUDE_CODE_REMOTE_SETTINGS_PATH), skipping API fetch\`),`
 *   `{settings:sct(),fetchSucceeded:!0};`
 *
 * A message that names the variable and describes an effect — the API fetch is
 * skipped — is not a stub. Its sibling `CLAUDE_CODE_MOCK_REMOTE_SETTINGS` has
 * no such body in either artefact, and P3.145's zero for it reproduces.
 *
 * ## The two facts that make a shape usable, and why one control is not enough
 *
 * The sibling instrument (P2.442, P2.467) probes for **the shape a reader would
 * have** — the name followed by `:` or `=` — against a live sibling control and
 * a nonsense zero. That is the right idea and it is not yet enough, because
 * those two controls only establish that the probe is not matching noise. A
 * shape also has to be able to SAY NO. Measured on the native binary:
 *
 * | name | occurrences | `env-read` | `key-or-assign` |
 * | --- | --- | --- | --- |
 * | `CLAUDE_CONFIG_DIR` (read) | 45 | 15 | 9 |
 * | `CLAUDE_CODE_HOST_CREDS_FILE` (read — the binary logs "ignoring … with group/other-readable mode or wrong owner") | 34 | **0** | 4 |
 * | `CLAUDE_CODE_REMOTE_SETTINGS_PATH` (read, via a helper) | 6 | **0** | 1 |
 * | `CLAUDE_CODE_MOCK_REMOTE_SETTINGS` (unread) | 4 | 0 | 1 |
 * | a nonsense name | 0 | 0 | 0 |
 *
 * `env-read` has no SENSITIVITY there: two names the binary demonstrably acts on
 * score zero, because it reads them through helpers rather than inline.
 * `key-or-assign` has no SPECIFICITY there: the unread name scores as well as
 * the read ones, because every name gets a registry entry. **Either failure
 * turns a zero into no information, and both are invisible unless you carry a
 * control of each polarity.** So this instrument requires three controls, not
 * two: a name known to be READ, a name known to be MENTIONED AND UNREAD, and a
 * nonsense name. The two stubs P3.171 enumerates are what make the middle one
 * available at all — that is the enumeration's real use.
 *
 * ## What it can and cannot conclude
 *
 * A shape hit is SUFFICIENT for "reads" and a shape zero is never sufficient for
 * "does not read": the strongest honest negative is `unread-on-this-shape`, and
 * a claim of absence needs agreement from every usable shape plus the reason the
 * remaining ones were discarded. `AGENTS.md`'s rule that an absence finding needs
 * a positive control on the same rig is the floor here, not the ceiling.
 *
 * Counting is deliberately reported two ways, because this tree has already
 * recorded one number as if it were the other: `grep -c` counts LINES and
 * `grep -o | wc -l` counts MATCHES, and on these artefacts they differ
 * systematically — every user-visible string is carried twice, once in a string
 * table and once in embedded JS. A count with no instrument named is unusable.
 */

/** Both instruments, always reported together — a bare count names neither. */
export interface EvidenceCounts {
  /** Lines containing the name at least once, the `grep -c` reading. */
  readonly lines: number;
  /** Total matches, the `grep -o | wc -l` reading. */
  readonly occurrences: number;
}

/**
 * The shapes measured so far. `occurrence` is membership and is never evidence
 * of behaviour; the others are candidate reader shapes whose usability has to be
 * established per artefact by the controls, never assumed.
 */
export type EvidenceShape = 'occurrence' | 'env-read' | 'key-or-assign' | 'accessor-hop';

export type BinaryEvidenceVerdict =
  /** A usable shape found the name in a position only a reader occupies. */
  | 'reads'
  /** A usable shape found nothing. The strongest honest negative for one shape. */
  | 'unread-on-this-shape'
  /** The name is not in the artefact at all, on a rig proven able to find things. */
  | 'absent'
  /** The shape cannot separate read from mentioned here; its zero means nothing. */
  | 'shape-unusable'
  /** The nonsense control matched. The probe is matching noise; discard the run. */
  | 'rig-dead';

export interface BinaryEvidenceControls {
  /** A name this artefact demonstrably ACTS on. Establishes sensitivity. */
  readonly read: string;
  /** A name this artefact mentions and does NOT act on. Establishes specificity. */
  readonly mentionedUnread: string;
  /** A name that cannot occur. Establishes the probe is not matching noise. */
  readonly absent: string;
}

export interface BinaryEvidenceReport {
  readonly verdict: BinaryEvidenceVerdict;
  readonly shape: EvidenceShape;
  readonly target: EvidenceCounts;
  readonly controls: { readonly read: number; readonly mentionedUnread: number; readonly absent: number };
  /** Why a `shape-unusable` or `rig-dead` verdict was reached, for the record. */
  readonly reason?: string;
}

const IDENTIFIER_BOUNDARY = '[^A-Za-z0-9_$]';

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The regular expression one shape uses for one name. */
export function shapePattern(shape: EvidenceShape, name: string): RegExp {
  const escaped = escapeForRegExp(name);
  switch (shape) {
    case 'occurrence':
      return new RegExp(escaped, 'g');
    case 'env-read':
      // `process.env.NAME`, `env.NAME`, `env["NAME"]` — an inline read.
      return new RegExp(`(?:process\\.)?env(?:\\.|\\[")${escaped}`, 'g');
    case 'key-or-assign':
      // P2.442's shape: an object key or an assignment target.
      return new RegExp(`${escaped}\\s*[:=]`, 'g');
    case 'accessor-hop':
      // A minified export registry entry `NAME:()=>ident`. Counting THIS is
      // membership again; `accessorReferences` below is the hop that matters.
      return new RegExp(`${escaped}:\\(\\)=>[A-Za-z0-9_$]+`, 'g');
  }
}

export function countShape(haystack: string, shape: EvidenceShape, name: string): EvidenceCounts {
  const pattern = shapePattern(shape, name);
  const occurrences = haystack.match(pattern)?.length ?? 0;
  if (occurrences === 0) return { lines: 0, occurrences: 0 };
  let lines = 0;
  for (const line of haystack.split('\n')) {
    if (shapePattern(shape, name).test(line)) lines += 1;
  }
  return { lines, occurrences };
}

/**
 * Follow one hop: `NAME:()=>ident`, then how many times `ident` appears anywhere
 * else. This is what P3.145 did by hand, and the number it returns is the count
 * BEYOND the two sites every registered accessor has — its declaration and its
 * registry entry. Zero means nothing in this artefact consumes the accessor.
 *
 * Read it against the `read` control, always: in `sdk.mjs` this returns zero for
 * every name including ones the file reads directly, so there the hop is dead
 * and its zero is not a finding.
 */
export function accessorReferences(haystack: string, name: string): { accessor: string | null; extra: number } {
  const declaration = new RegExp(`${escapeForRegExp(name)}:\\(\\)=>([A-Za-z0-9_$]+)`).exec(haystack);
  const accessor = declaration?.[1] ?? null;
  if (!accessor) return { accessor: null, extra: 0 };
  const references = haystack.match(
    new RegExp(`(?:^|${IDENTIFIER_BOUNDARY})${escapeForRegExp(accessor)}(?:${IDENTIFIER_BOUNDARY}|$)`, 'g'),
  )?.length ?? 0;
  // Its own declaration and its registry entry are not readers.
  return { accessor, extra: Math.max(0, references - 2) };
}

/**
 * Classify one name on one shape, with all three controls applied first.
 *
 * The control order is the point: a rig that matches noise invalidates
 * everything, an insensitive shape cannot produce a negative, and an
 * unspecific shape cannot produce a positive. Only once all three pass does the
 * target's own count mean anything.
 */
export function classifyBinaryEvidence(args: {
  haystack: string;
  name: string;
  shape: EvidenceShape;
  controls: BinaryEvidenceControls;
}): BinaryEvidenceReport {
  const { haystack, name, shape, controls } = args;
  const target = countShape(haystack, shape, name);
  const read = countShape(haystack, shape, controls.read).occurrences;
  const mentionedUnread = countShape(haystack, shape, controls.mentionedUnread).occurrences;
  const absent = countShape(haystack, shape, controls.absent).occurrences;
  const counted = { read, mentionedUnread, absent };

  if (absent > 0) {
    return {
      verdict: 'rig-dead',
      shape,
      target,
      controls: counted,
      reason: `the nonsense control ${controls.absent} matched ${absent} times`,
    };
  }
  if (read === 0) {
    return {
      verdict: 'shape-unusable',
      shape,
      target,
      controls: counted,
      reason: `no sensitivity: ${controls.read} is acted on by this artefact and scores 0 on this shape`,
    };
  }
  if (shape !== 'occurrence' && mentionedUnread > 0) {
    return {
      verdict: 'shape-unusable',
      shape,
      target,
      controls: counted,
      reason: `no specificity: ${controls.mentionedUnread} is mentioned and unread yet scores ${mentionedUnread}`,
    };
  }
  if (target.occurrences > 0) return { verdict: 'reads', shape, target, controls: counted };
  const present = countShape(haystack, 'occurrence', name).occurrences;
  return { verdict: present > 0 ? 'unread-on-this-shape' : 'absent', shape, target, controls: counted };
}

/**
 * Names measured to be MENTIONED AND UNREAD, which is what makes them usable as
 * the specificity control. Each carries the artefact it was measured on, because
 * that is the axis the two earlier rows crossed without noticing.
 *
 * Add to this rather than to a row note: the next lane needs a name of this
 * polarity before it can trust any zero, and there is nowhere else to get one.
 */
export const MENTIONED_UNREAD_CONTROLS = {
  /**
   * P3.145, reproduced here. Four occurrences in the native binary — the env
   * name table, the 89-name withhold array, its registry entry and a symbol
   * blob — and no body in either artefact.
   */
  CLAUDE_CODE_MOCK_REMOTE_SETTINGS: ['sdk.mjs', 'native claude'],
} as const satisfies Record<string, readonly string[]>;
