/**
 * The iOS client mirrors TypeScript enums by hand. This finds the ones that no
 * longer agree.
 *
 * Two constants that must agree, with nothing checking that they do, has
 * produced FOUR separate defects in one plan: `Task` renamed to `Agent` in the
 * plugin component table, `lsp` versus `lspServers`, the workflow `meta`
 * allow-list that silently amputated two official plugins (one losing all six of
 * its workflows), and `worktree_setup` — a permission prompt type added to five
 * TypeScript declarations plus the runtime-snapshot validator on 2026-08-25
 * (`22d71972b`) and to none of the Swift mirror in `apps/ios`. Four is not a
 * coincidence, so this file exists.
 *
 * WHY IT LIVES ON THE TYPESCRIPT SIDE, and not next to the Swift it checks.
 * `apps/ios` already had drift tests — `NessyWireDriftTests.swift` — and they did
 * not catch this, for two independent reasons that both had to be fixed here:
 *
 *   1. They compare the Swift enum against a HARDCODED LITERAL frozen in the
 *      test file (`["workflow_launch", "worktree_approval", "ask_user",
 *      "outside_root"]`), never against the TypeScript that is the source of
 *      truth. A value added to TypeScript changes nothing they look at. They are
 *      decode-BEHAVIOUR tests — that an unknown string degrades to `.unknown`
 *      rather than discarding the whole payload — and those are worth keeping;
 *      they were simply never a parity check.
 *   2. `swift test` runs in CI only under `build-ios`, whose rules are
 *      `changes: apps/ios/**`. `22d71972b` touched zero files under `apps/ios`,
 *      so no iOS job ran at all. Even a PERFECT Swift-side guard would have
 *      stayed silent on the commit that caused the divergence.
 *
 * A guard that cannot run on the change it exists to catch is not a guard, so
 * the check lives where the canonical lists live. Its CI reader is
 * `ios-wire-enum-parity.test.ts`, because CI runs `bun test` — not
 * `validate:ci`. It needs no Swift toolchain: it reads both languages as text.
 * Run it directly for the same verdict without a test runner:
 *
 *     bun scripts/ios-wire-enum-parity.ts
 *
 * WHAT IT CHECKS, in the order the failures matter:
 *
 *   A. COMPLETENESS. Every WIRE-VOCABULARY enum in the iOS client is either
 *      registered below as mirroring a TypeScript list, or explicitly exempted
 *      with a reason. A NEW mirrored enum cannot slip in unregistered — that is
 *      what makes this a guard rather than a fix for one enum. (`CodingKeys` is
 *      exempt by its `CodingKey` conformance, a language-level signal, not a
 *      hand-kept list.)
 *   B. THE COPIES AGREE WITH EACH OTHER. Each logical list is declared several
 *      times in TypeScript — `PermissionRequestType` six times, `ErrorCode`
 *      twice. They are checked against each other before anyone looks at
 *      Swift, because a fork between two TypeScript copies is the same defect
 *      one layer earlier. So are the two HAND-WRITTEN Swift halves of an
 *      associated-value enum, checked against each other before either meets
 *      TypeScript.
 *   C. SWIFT MATCHES. Raw values, as sets. Swift-only sentinels (`unknown`) are
 *      declared per entry, so a sentinel cannot be confused with drift and drift
 *      cannot hide behind a sentinel.
 *
 * An anchor that no longer resolves is a FINDING, never a skip. So is one that
 * resolves and then scans NOTHING (`anchor-scanned-nothing`), which is how the
 * same rot arrives disguised as drift: the declaration is still there and now
 * names a type declared elsewhere. A declaration that moved is exactly the
 * `Task`→`Agent` shape: re-point it deliberately.
 *
 * WHAT COUNTS AS A WIRE VOCABULARY, since 2026-09-04 (P3.358). Two spellings,
 * because the first one alone had a PERMANENT blind spot:
 *
 *   - `enum X: String` — the compiler holds the raw values.
 *   - an enum the compiler cannot give a raw value to, because a case carries an
 *     associated value (`case unknown(String)`). Its vocabulary is therefore
 *     written TWICE by hand — a decode table and an encode switch — and nothing
 *     keeps those two in step either.
 *
 * `ErrorCode` is the second kind, and it was invisible here by CONSTRUCTION for
 * as long as discovery required a `String` conformance: eight codes behind the
 * server, with the completeness clause unable to say so. Every refused RPC
 * arrives as one of these and the app renders the CODE, not the server's
 * sentence, so an unknown code is not a degraded message — it is the generic
 * one, in a language the user may not read.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')

export const KIT_SOURCES = 'apps/ios/NessyAgentKit/Sources'
export const APP_SOURCES = 'apps/ios/NessyMobile/NessyMobile'

/**
 * Files are read once per process and remembered.
 *
 * Not premature: the registry points several locators at one file on purpose —
 * `PermissionRequestType` has two anchors in `SessionManager.ts`, which is
 * **1.4 MB** — so the uncached form read 2.8 MB to answer two questions about
 * the same text. Measured 2026-09-04 while profiling a 5 s timeout: the whole
 * check costs ~80 ms warm and up to ~30 s cold on a contended box, and it is
 * dominated by exactly this I/O plus the 116-file walk of `apps/ios`.
 *
 * Safe because every consumer is one-shot: the CLI exits, the test calls the
 * check a handful of times in one process, and the mutation harness runs a
 * FRESH process per mutant — so a mutated file can never be answered from a
 * pre-mutation cache.
 */
const fileCache = new Map<string, string>()
const read = (relative: string): string => {
  const hit = fileCache.get(relative)
  if (hit !== undefined) return hit
  const text = readFileSync(join(REPO, relative), 'utf8')
  fileCache.set(relative, text)
  return text
}

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

/**
 * Blank out line comments, block comments and string-literal CONTENTS while
 * keeping every byte offset, so brace matching cannot be thrown off by a `{`
 * inside prose or a string and offsets still index the original text.
 */
function maskSwift(source: string): string {
  const out = source.split('')
  let i = 0
  while (i < source.length) {
    if (source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') { out[i] = ' '; i += 1 }
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      for (; i < stop; i += 1) if (source[i] !== '\n') out[i] = ' '
    } else if (source[i] === '"') {
      i += 1
      while (i < source.length && source[i] !== '"' && source[i] !== '\n') {
        if (source[i] === '\\') { out[i] = ' '; i += 1 }
        if (i < source.length) { out[i] = ' '; i += 1 }
      }
      i += 1
    } else {
      i += 1
    }
  }
  return out.join('')
}

/**
 * A region of a Swift file and the MASKED text of the same region, sliced at
 * identical offsets so an offset found in one indexes the other. The masked
 * half is what brace/bracket matching reads; the original half is what values
 * are read out of, because masking blanks string CONTENTS.
 */
type Region = { text: string; masked: string }

/**
 * The `{ … }` or `[ … ]` body that OPENS at `openerEnd - 1`, brace-matched on
 * `masked`. Returns the region between the delimiters.
 */
function matchedRegion(text: string, masked: string, from: number, open: '{' | '['): Region {
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let start = -1
  for (let i = from; i < masked.length; i += 1) {
    if (masked[i] === open) { if (depth === 0) start = i + 1; depth += 1 }
    else if (masked[i] === close) {
      depth -= 1
      if (depth === 0) return { text: text.slice(start, i), masked: masked.slice(start, i) }
    }
  }
  throw new Error(`unbalanced \`${open}${close}\``)
}

/** The `{ … }` body of `enum <name>`, brace-matched on the masked text. */
function swiftEnumRegion(relative: string, enumName: string): Region {
  const source = read(relative)
  const masked = maskSwift(source)
  const decl = new RegExp(`\\benum\\s+${enumName}\\s*:[^{\\n]*\\{`)
  const found = decl.exec(masked)
  if (!found) throw new Error(`no \`enum ${enumName}\` declaration in ${relative}`)
  try {
    return matchedRegion(source, masked, found.index, '{')
  } catch {
    throw new Error(`unbalanced braces after \`enum ${enumName}\` in ${relative}`)
  }
}

function swiftEnumBody(relative: string, enumName: string): string {
  return swiftEnumRegion(relative, enumName).text
}

const CASE_ITEM = /^`?([A-Za-z_]\w*)`?(?:\s*=\s*"([^"]*)")?$/

/**
 * Raw values of an enum's declared cases, in declaration order.
 *
 * Only lines that are entirely a case DECLARATION count. A `switch` arm inside
 * the body (`case .anthropic: return "Claude"`, `case "claude-runtime": …`)
 * carries a colon or a leading dot and fails `CASE_ITEM`, so the whole line is
 * skipped. A mis-parse therefore yields a wrong LIST and a loud finding — it can
 * never yield a silent pass.
 */
export function swiftRawValues(relative: string, enumName: string): string[] {
  const values: string[] = []
  for (const raw of swiftEnumBody(relative, enumName).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (!line.startsWith('case ')) continue
    const items = line.slice('case '.length).split(',').map(part => part.trim())
    const parsed = items.map(item => CASE_ITEM.exec(item))
    if (parsed.some(match => match === null)) continue
    for (const match of parsed) values.push(match![2] ?? match![1]!)
  }
  if (values.length === 0) throw new Error(`\`enum ${enumName}\` in ${relative} parsed to no cases`)
  return values
}

/**
 * The two halves of a HAND-WRITTEN wire vocabulary (P3.358).
 *
 * An enum with an associated value — `case unknown(String)` — cannot carry a
 * `String` raw value, so the compiler keeps nothing in step for it. Its
 * vocabulary is written TWICE by hand: a decode table (`[String: Self]`) and an
 * encode switch (`var wireValue: String`). Nothing checked that fork before
 * this, and it is the same two-constants-must-agree shape as everything else in
 * this file, one language over.
 */
export type SwiftWireHalves = { decode: string[]; encode: string[] }

/**
 * `decode` — the quoted KEYS of `static let <map>: [String: …] = [ … ]`.
 * `encode` — the quoted strings RETURNED by `var <property>: String { … }`.
 *
 * `case .unknown(let raw): return raw` contributes nothing to `encode`, which is
 * correct: the sentinel is not a wire value, so it needs no `swiftOnly` entry.
 */
export function swiftWireHalves(
  relative: string,
  enumName: string,
  halves: { map: string; property: string },
): SwiftWireHalves {
  const region = swiftEnumRegion(relative, enumName)

  const mapDecl = new RegExp(`\\blet\\s+${halves.map}\\s*:[^=\\n]*=\\s*\\[`).exec(region.masked)
  if (!mapDecl) {
    throw new Error(
      `no \`let ${halves.map}: [String: …] = [\` inside \`enum ${enumName}\` in ${relative}. ` +
      `The decode table this check reads has MOVED or been renamed; re-point it deliberately.`,
    )
  }
  // From the LAST character of the match — its own `[` — and not from its
  // start: the type annotation `[String: ErrorCode]` carries an earlier `[`,
  // and bracket-matching that one yields the annotation instead of the literal.
  // Caught by this function's own empty-half check on first run.
  const mapRegion = matchedRegion(region.text, region.masked, mapDecl.index + mapDecl[0].length - 1, '[')
  const decode = [...mapRegion.text.matchAll(/"([^"]*)"\s*:/g)].map(match => match[1]!)

  const propDecl = new RegExp(`\\bvar\\s+${halves.property}\\s*:\\s*String\\s*\\{`).exec(region.masked)
  if (!propDecl) {
    throw new Error(
      `no \`var ${halves.property}: String {\` inside \`enum ${enumName}\` in ${relative}. ` +
      `The encode switch this check reads has MOVED or been renamed; re-point it deliberately.`,
    )
  }
  const propRegion = matchedRegion(region.text, region.masked, propDecl.index + propDecl[0].length - 1, '{')
  const encode = [...propRegion.text.matchAll(/\breturn\s+"([^"]*)"/g)].map(match => match[1]!)

  if (decode.length === 0 || encode.length === 0) {
    throw new Error(
      `\`enum ${enumName}\` in ${relative} parsed to ${decode.length} decode key(s) and ` +
      `${encode.length} encode literal(s). A half that reads as empty is a mis-parse, not a vocabulary.`,
    )
  }
  return { decode, encode }
}

/**
 * How a Swift enum's wire vocabulary is spelled, which decides how it is read.
 *
 * `raw-value` — `enum X: String`, the compiler holds the values.
 * `associated-value` — an enum the compiler CANNOT give a raw value, because a
 * case carries one (`case unknown(String)`). Its vocabulary is hand-written
 * twice; see `swiftWireHalves`.
 */
export type SwiftShape = 'raw-value' | 'associated-value'

export type DiscoveredEnum = { file: string; name: string; conformances: string; shape: SwiftShape }

/**
 * Every enum in the iOS client that carries a WIRE VOCABULARY, by either
 * spelling.
 *
 * The `associated-value` signal is `case unknown(String)` — the forward-compat
 * sentinel that says "this decodes a string off the wire and degrades instead
 * of throwing". It is the same kind of in-source signal as the `CodingKey`
 * conformance used below, and it finds exactly the two enums that have one.
 *
 * KNOWN RESIDUE, stated rather than implied: an associated-value enum that
 * mirrors a wire list and does NOT carry that sentinel is not discovered here.
 * Such an enum throws on an unknown value rather than degrading, so it fails
 * loudly on the device the first time the server sends a value it does not
 * know — a different failure from the silent one this file exists to catch, and
 * one no list comparison is needed to notice.
 */
export function discoverSwiftWireEnums(): DiscoveredEnum[] {
  const found: DiscoveredEnum[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(REPO, relative))) {
      // `.build` is SwiftPM output, not source.
      if (entry === '.build' || entry.startsWith('.')) continue
      const child = `${relative}/${entry}`
      if (statSync(join(REPO, child)).isDirectory()) { walk(child); continue }
      if (!entry.endsWith('.swift')) continue
      const original = read(child)
      const source = maskSwift(original)
      for (const match of source.matchAll(/\benum\s+([A-Za-z_]\w*)\s*:([^{\n]*)\{/g)) {
        const conformances = match[2]!
        if (/\bString\b/.test(conformances)) {
          found.push({ file: child, name: match[1]!, conformances, shape: 'raw-value' })
          continue
        }
        // Needs the BODY, not the conformance list — brace-matched from this
        // declaration so a sibling enum in the same file cannot answer for it.
        let body: string
        try {
          body = matchedRegion(original, source, match.index, '{').masked
        } catch {
          continue
        }
        if (!/\bcase\s+unknown\s*\(\s*String\s*\)/.test(body)) continue
        found.push({ file: child, name: match[1]!, conformances, shape: 'associated-value' })
      }
    }
  }
  walk(KIT_SOURCES)
  walk(APP_SOURCES)
  return found
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

const SEPARATORS = new Set([' ', '\t', '\n', '\r', '|', ',', '['])

/**
 * The quoted members that follow an anchor, whether the declaration is a union
 * (`'a' | 'b'`) or a runtime array (`['a', 'b']`). Scanning stops at the first
 * character that is not a member, a separator or a comment — `;`, `]`, `as`, or
 * the next statement — so the same scanner reads all three forms this repo uses.
 */
function scanMembers(source: string, from: number): string[] {
  const members: string[] = []
  let i = from
  for (;;) {
    while (i < source.length && SEPARATORS.has(source[i]!)) i += 1
    if (source.startsWith('//', i)) { while (i < source.length && source[i] !== '\n') i += 1; continue }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue }
    const quote = source[i]
    if (quote !== "'" && quote !== '"') break
    const close = source.indexOf(quote, i + 1)
    if (close === -1) break
    members.push(source.slice(i + 1, close))
    i = close + 1
  }
  return members
}

/** Members at every occurrence of `anchor`. Zero occurrences throws. */
export function tsMembers(relative: string, anchor: RegExp): string[][] {
  const source = read(relative)
  const global = new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : `${anchor.flags}g`)
  const lists: string[][] = []
  for (const match of source.matchAll(global)) {
    lists.push(scanMembers(source, match.index! + match[0].length))
  }
  if (lists.length === 0) {
    throw new Error(
      `anchor ${anchor} matched nothing in ${relative}. A declaration this check ` +
      `mirrors has MOVED or been renamed; re-point the anchor deliberately rather ` +
      `than deleting the row — a renamed constant is the defect class this file guards.`,
    )
  }
  return lists
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export type Locator = { file: string; anchor: RegExp }

export type Mirror = {
  /** Swift enum name, as declared. */
  name: string
  /** File holding it, relative to the repo root. */
  file: string
  /** Every TypeScript declaration of the same logical list. */
  ts: Locator[]
  /** Cases the Swift enum adds on purpose (forward-compat sentinels). */
  swiftOnly?: string[]
  /**
   * Present when the Swift enum is `associated-value` shaped, naming the two
   * hand-written halves to read and to check against EACH OTHER. Absent means
   * the compiler holds the values as `String` raw values.
   */
  swiftHalves?: { map: string; property: string }
  /** Why this list is mirrored on the device at all. */
  why: string
}

export type Exemption = { name: string; file: string; why: string }

export const MIRRORS: Mirror[] = [
  {
    name: 'PermissionRequestType',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/PermissionRequest.swift`,
    why: 'the approval sheet is the reason the app exists; an unknown type used to discard the whole request',
    swiftOnly: ['unknown'],
    ts: [
      { file: 'packages/core/src/types/message.ts', anchor: /export type PermissionRequestType =/ },
      { file: 'packages/shared/src/agent/backend/types.ts', anchor: /export type PermissionRequestType =/ },
      { file: 'packages/core/src/types/pi-harness-runtime.ts', anchor: /interface PiHarnessPendingPermissionSummaryV1 \{[^}]*?\btype\?:/ },
      // The runtime-snapshot wire validator. A type it does not know makes the
      // whole security panel unparseable while such a prompt is pending, which
      // is why `22d71972b` had to touch it too.
      { file: 'packages/shared/src/protocol/pi-harness-runtime.ts', anchor: /enumValue\(value\.type,/ },
      // Read-only. Another lane owns this file; the check never writes it.
      { file: 'packages/server-core/src/sessions/SessionManager.ts', anchor: /type AgentPermissionRequest = \{[^}]*?\btype\?:/ },
      { file: 'packages/server-core/src/sessions/SessionManager.ts', anchor: /private pendingPermissionRequests: Map<string, \{[^}]*?\btype\?:/ },
    ],
  },
  {
    name: 'PermissionMode',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/PermissionModeState.swift`,
    why: 'the device mode picker sets these and the server sends them; the pre-migration vocabulary failed to decode `explore`',
    ts: [
      { file: 'packages/shared/src/agent/mode-types.ts', anchor: /export type PermissionMode =/ },
      { file: 'packages/shared/src/agent/mode-types.ts', anchor: /export const PERMISSION_MODE_ORDER: PermissionMode\[\] =/ },
      // F1.1050: the decoder reads an older server's retired `explore` as `plan` before the enum check.
      { file: 'packages/shared/src/protocol/pi-harness-runtime.ts', anchor: /enumValue\(securityValue\.permissionMode === 'explore' \? 'plan' : securityValue\.permissionMode,/ },
    ],
  },
  {
    name: 'ThinkingLevel',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/ThinkingLevel.swift`,
    why:
      'P6.575 — the device sets these with `sessions:command` `{ type: "setThinkingLevel" }` and the '
      + 'server VALIDATES against this exact list (`isValidThinkingLevel`), so a tier the phone offers '
      + 'and the server does not know is a rejected command rather than a degraded one. The reverse '
      + 'direction is the one that bites: a seventh tier added on the server reaches `Session.thinkingLevel`, '
      + 'and only this check can see that the picker has no case for it.',
    ts: [
      { file: 'packages/shared/src/agent/thinking-levels.ts', anchor: /export const THINKING_LEVEL_IDS = \[/ },
    ],
  },
  {
    name: 'MessageType',
    file: `${KIT_SOURCES}/NessyAgentKit/Protocol/MessageEnvelope.swift`,
    why: 'the transport backbone; a mismatch here loses every frame, not one payload',
    ts: [
      { file: 'packages/shared/src/protocol/types.ts', anchor: /export type MessageType =/ },
      { file: 'packages/server-core/src/transport/codec.ts', anchor: /const MESSAGE_TYPES = new Set\(/ },
    ],
  },
  {
    name: 'MessageRole',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/ChatMessage.swift`,
    why: 'a role the device cannot decode drops the message out of the transcript',
    ts: [{ file: 'packages/core/src/types/message.ts', anchor: /export type MessageRole =/ }],
  },
  {
    name: 'Kind',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/FileAttachment.swift`,
    why: 'attachment kinds ride both ways; the device both sends and renders them',
    ts: [
      { file: 'packages/shared/src/protocol/dto.ts', anchor: /export interface FileAttachment \{\s*type:/ },
      { file: 'packages/core/src/types/message.ts', anchor: /export type AttachmentType =/ },
      // RE-POINTED (P3.358, 2026-09-04). Two locators used to sit on
      // `utils/files.ts` — `export interface FileAttachment { type:` and
      // `export function getFileType(filePath: string):`. `a07b1e8a1` (P3.274)
      // moved the vocabulary into `file-types.ts` as the named type
      // `FileAttachmentKind` and left `files.ts` re-exporting it, so both
      // anchors still MATCHED and both then scanned zero quoted members —
      // reported as two `ts-copies-disagree` findings with an empty side, which
      // read as drift and were neither. Two hand-copies became one declaration;
      // one locator replaces both. `anchor-scanned-nothing` below is the
      // finding kind that now names this shape for what it is.
      { file: 'packages/shared/src/utils/file-types.ts', anchor: /export type FileAttachmentKind =/ },
    ],
  },
  {
    name: 'RuntimeSwitchKind',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/RuntimeSwitch.swift`,
    why: 'how much a connection change costs the session; computed on device today, one `Codable` conformance from being decoded',
    ts: [{ file: 'packages/shared/src/protocol/runtime-switch.ts', anchor: /export type RuntimeSwitchKind =/ }],
  },
  {
    name: 'HistoryCarryPlan',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/RuntimeSwitch.swift`,
    why: 'parsed out of the durable `runtime_switched:` transcript marker the server writes',
    ts: [
      { file: 'packages/shared/src/protocol/runtime-switch.ts', anchor: /export type HistoryCarryPlan =/ },
      { file: 'apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts', anchor: /const CARRY_VALUES: readonly HistoryCarryPlan\[\] =/ },
    ],
  },
  {
    name: 'ErrorCode',
    file: `${KIT_SOURCES}/NessyAgentKit/Protocol/WireError.swift`,
    why:
      'every refused RPC arrives as one of these, and the app maps the CODE to the sentence the ' +
      'user reads — `presented(_:)` discards the server message on purpose (F14-UI), so a code the ' +
      'device does not know is not a degraded message, it is the generic one',
    // Associated-value shaped (`case unknown(String)`), so the compiler holds
    // nothing: the decode table and the encode switch are two hand-written
    // copies and are checked against each other before either meets TypeScript.
    swiftHalves: { map: 'wireMap', property: 'wireValue' },
    ts: [
      { file: 'packages/shared/src/protocol/types.ts', anchor: /export type ErrorCode =/ },
      // The runtime membership test. `isErrorCode` is what decides whether a
      // value is a known code at all, so a fork between it and the union is the
      // same defect one layer earlier — exactly what check B is for.
      { file: 'packages/shared/src/protocol/types.ts', anchor: /const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>\(/ },
    ],
  },
]

export const EXEMPT: Exemption[] = [
  {
    name: 'AgentRuntime',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/RuntimeSwitch.swift`,
    why:
      'Not a mirror of a list. It restates the FUNCTION `providerTypeToAgentProvider` ' +
      '(`packages/shared/src/agent/backend/factory.ts`) as a switch whose raw values are ' +
      'device-local labels, and its `default` arm resolves any unheard-of providerType to ' +
      '`pi`. KNOWN GAP, deliberate: a runtime added to the factory shows on the phone as ' +
      '"Pi" until someone extends the switch, and no list comparison can see that because ' +
      'there is no list — the authority is control flow. Closing it needs a providerType ' +
      'catalogue on the wire, which is a protocol decision, not a test.',
  },
  {
    name: 'SessionListFilter',
    file: `${APP_SOURCES}/Sessions/SessionListViewModel.swift`,
    why: 'A device-local list filter. Never encoded, never sent, never received.',
  },
  {
    name: 'SessionEvent',
    file: `${KIT_SOURCES}/NessyAgentKit/Models/SessionEvent.swift`,
    why:
      'A DELIBERATE SUBSET, and its own header says so: it mirrors "the MVP-relevant subset of the ' +
      '`SessionEvent` discriminated union in `packages/shared/src/protocol/dto.ts`". Registering it ' +
      'as a mirror would make this guard permanently red for values the device is meant not to ' +
      'model, which is how a guard gets muted. The subset is safe by construction: an unmodelled ' +
      '`type` decodes to `.unknown(type)` and the row is dropped rather than the payload discarded. ' +
      'What a subset needs is a rule about which events MUST be modelled — a product decision about ' +
      'the phone, not a list comparison — so it is exempt until there is one to check against.',
  },
]

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type Finding = {
  kind:
    | 'unaccounted-enum'
    | 'stale-registration'
    | 'anchor-unresolved'
    | 'anchor-scanned-nothing'
    | 'ts-copies-disagree'
    | 'swift-halves-disagree'
    | 'swift-mismatch'
    | 'sentinel-is-a-real-value'
  subject: string
  detail: string
}

const key = (file: string, name: string): string => `${file}#${name}`
const sorted = (values: string[]): string[] => [...values].sort()
const missing = (from: string[], against: string[]): string[] => against.filter(v => !from.includes(v))

/** Every divergence, in the order the failures matter. Empty means green. */
export function findWireEnumDivergences(): Finding[] {
  const findings: Finding[] = []

  // A. Completeness — the half that makes this a guard and not a one-enum fix.
  const registered = new Set([...MIRRORS, ...EXEMPT].map(entry => key(entry.file, entry.name)))
  const discovered = discoverSwiftWireEnums()
    // `CodingKey` conformance is the language saying "this is a key map, not a
    // wire vocabulary". A compiler-visible signal, not a hand-kept list.
    .filter(found => !/\bCodingKey\b/.test(found.conformances))
  for (const found of discovered) {
    if (registered.has(key(found.file, found.name))) continue
    findings.push({
      kind: 'unaccounted-enum',
      subject: key(found.file, found.name),
      detail:
        `an ${found.shape} wire enum in the iOS client that is neither registered as mirroring a ` +
        'TypeScript list nor exempted with a reason. Add it to MIRRORS or to EXEMPT.',
    })
  }
  const present = new Set(discovered.map(found => key(found.file, found.name)))
  for (const entry of [...MIRRORS, ...EXEMPT]) {
    if (present.has(key(entry.file, entry.name))) continue
    findings.push({
      kind: 'stale-registration',
      subject: key(entry.file, entry.name),
      // Said "String-raw-value enum" until 2026-09-04, which stopped being the
      // whole set the moment associated-value enums were registered: the
      // message named a shape the missing enum need not have had, and would
      // have sent its reader looking for the wrong declaration.
      detail: 'registered here but no such wire enum exists any more. Renamed, moved, or deleted.',
    })
  }

  for (const mirror of MIRRORS) {
    // B. The TypeScript copies against each other.
    const copies: Array<{ where: string; members: string[] }> = []
    let anchorFailed = false
    for (const locator of mirror.ts) {
      let lists: string[][]
      try {
        lists = tsMembers(locator.file, locator.anchor)
      } catch (error) {
        anchorFailed = true
        findings.push({
          kind: 'anchor-unresolved',
          subject: `${mirror.name} → ${locator.file}`,
          detail: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      lists.forEach((members, index) => {
        const where = `${locator.file} ${locator.anchor}${index > 0 ? ` #${index + 1}` : ''}`
        // An anchor that RESOLVES and then scans nothing is the same
        // moved-declaration shape as one that fails to resolve, and it used to
        // arrive disguised as drift: two empty copies reported as
        // `ts-copies-disagree` with one side blank. Measured 2026-09-04 — the
        // `Kind` mirror had been red that way since `a07b1e8a1` moved the
        // attachment vocabulary into `file-types.ts`.
        if (members.length === 0) {
          anchorFailed = true
          findings.push({
            kind: 'anchor-scanned-nothing',
            subject: `${mirror.name} → ${locator.file}`,
            detail:
              `anchor ${locator.anchor} matched, then scanned ZERO quoted members. The declaration ` +
              `it names no longer spells the list out — most often it now refers to a NAMED TYPE ` +
              `declared elsewhere. Re-point the anchor at wherever the members moved; do not delete ` +
              `the row, because a list that moved is exactly the defect class this file guards.`,
          })
          return
        }
        copies.push({ where, members: sorted(members) })
      })
    }
    if (copies.length === 0) continue

    const canonical = copies[0]!
    for (const copy of copies.slice(1)) {
      if (copy.members.join('\u0000') === canonical.members.join('\u0000')) continue
      findings.push({
        kind: 'ts-copies-disagree',
        subject: mirror.name,
        detail:
          `two TypeScript declarations of the same list disagree. ` +
          `only in ${copy.where}: [${missing(canonical.members, copy.members).join(', ')}]; ` +
          `only in ${canonical.where}: [${missing(copy.members, canonical.members).join(', ')}]`,
      })
    }
    if (anchorFailed) continue

    // C. Swift against the canonical list — and, for a hand-written
    // vocabulary, Swift's own two copies against each other FIRST. That fork is
    // the same defect as B one language over, and nothing checked it before
    // P3.358.
    const sentinels = new Set(mirror.swiftOnly ?? [])
    let swift: string[]
    try {
      if (mirror.swiftHalves) {
        const halves = swiftWireHalves(mirror.file, mirror.name, mirror.swiftHalves)
        if (sorted(halves.decode).join('\u0000') !== sorted(halves.encode).join('\u0000')) {
          findings.push({
            kind: 'swift-halves-disagree',
            subject: mirror.name,
            detail:
              `the two hand-written halves of ${mirror.file} disagree. ` +
              `only decodable (\`${mirror.swiftHalves.map}\`): ` +
              `[${missing(halves.encode, halves.decode).join(', ')}]; ` +
              `only encodable (\`${mirror.swiftHalves.property}\`): ` +
              `[${missing(halves.decode, halves.encode).join(', ')}]. ` +
              `The compiler holds nothing here — a case carries an associated value, so there is no ` +
              `raw value — which is why both halves are written by hand and why this check exists.`,
          })
        }
        // The DECODE half is what the device actually understands, so it is the
        // one compared against TypeScript.
        swift = halves.decode
      } else {
        swift = swiftRawValues(mirror.file, mirror.name)
      }
    } catch (error) {
      findings.push({
        kind: 'swift-mismatch',
        subject: mirror.name,
        detail: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    const mirrored = sorted(swift.filter(value => !sentinels.has(value)))
    if (mirrored.join('\u0000') !== canonical.members.join('\u0000')) {
      findings.push({
        kind: 'swift-mismatch',
        subject: mirror.name,
        detail:
          `${mirror.file} does not carry the raw values of ${canonical.where}. ` +
          `absent from Swift: [${missing(mirrored, canonical.members).join(', ')}]; ` +
          `only in Swift: [${missing(canonical.members, mirrored).join(', ')}]. ` +
          `Mirrored because ${mirror.why}.`,
      })
    }
    // A sentinel that quietly became a real wire value would otherwise be
    // subtracted out of the comparison above and never noticed again.
    for (const sentinel of sentinels) {
      if (!canonical.members.includes(sentinel)) continue
      findings.push({
        kind: 'sentinel-is-a-real-value',
        subject: `${mirror.name}.${sentinel}`,
        detail:
          'declared as a Swift-only sentinel but TypeScript now sends it. It is being subtracted ' +
          'from the parity comparison, so real drift could hide behind it. Drop it from swiftOnly.',
      })
    }
  }

  return findings
}

if (import.meta.main) {
  const findings = findWireEnumDivergences()
  if (findings.length === 0) {
    const copies = MIRRORS.reduce((total, mirror) => total + mirror.ts.length, 0)
    console.log(`ios wire enums agree: ${MIRRORS.length} mirrored lists across ${copies} TypeScript declarations, ${EXEMPT.length} exempt`)
    process.exit(0)
  }
  for (const finding of findings) console.error(`[${finding.kind}] ${finding.subject}\n    ${finding.detail}`)
  console.error(`\n${findings.length} divergence(s).`)
  process.exit(1)
}
