import { describe, expect, test } from 'bun:test'
import {
  formatManagedPolicyDrop,
  formatManagedPolicyDropSummary,
  managedKeyRefusalNote,
  reportManagedPolicyDrops,
  type ManagedPolicyDropV1,
} from '../managed-drops.ts'
import { MANAGED_INSTRUCTION_FILE } from '../managed-system-paths.ts'

const drop = (over: Partial<ManagedPolicyDropV1> = {}): ManagedPolicyDropV1 => Object.freeze({
  source: '/etc/nessy/managed-policy.json',
  field: 'sandbox.network.allowedDomains[1]',
  reason: 'invalid sandbox network allowedDomains',
  disposition: 'stripped' as const,
  ...over,
})

describe('the drop list has a reader (managed-settings.md#invalid-entries-in-managed-settings)', () => {
  test('a drop renders with its source and field first, plus what actually happened', () => {
    // `managed-settings.md#invalid-entries-in-managed-settings` — "[`claude
    // doctor`](/docs/en/debug-your-config) lists each invalid entry with its
    // source and field." (The heading there now reads *Find entries Claude Code
    // dropped*; the anchor is the explicit span the rename left behind.) This
    // line is that listing's unit, so both fields lead it.
    expect(formatManagedPolicyDrop(drop())).toBe(
      '/etc/nessy/managed-policy.json: sandbox.network.allowedDomains[1] — '
      + 'invalid sandbox network allowedDomains [ignored]',
    )
    // The other two dispositions come from the per-field table under
    // `managed-settings.md#keys-that-fail-closed` — "A few enforcement keys
    // aren't dropped when invalid. Claude Code enforces a stricter fallback
    // until the value is fixed" — where the entry is REINTERPRETED rather than
    // removed. An admin who
    // reads "ignored" for an emptied allowlist would draw the opposite
    // conclusion about what the policy now enforces.
    expect(formatManagedPolicyDrop(drop({ field: 'allowedMcpServers', disposition: 'emptied' })))
      .toContain('[enforced as an empty allowlist]')
    expect(formatManagedPolicyDrop(drop({ field: 'allowPluginHooks', disposition: 'tightened' })))
      .toContain('[read at its enforcing value]')
    // A whole-document refusal carries no field; it must still say so.
    expect(formatManagedPolicyDrop(drop({ field: '' }))).toContain('(whole document)')
  })

  test('control characters and unbounded text never reach the terminal', () => {
    // `field` is an arbitrary document key and `reason` can quote a 2048-char
    // rule string, so both are attacker-influenced text on a path that ends at
    // stderr. A drop that could emit an ANSI escape or a newline would let a
    // policy file forge a second log line.
    const hostile = formatManagedPolicyDrop(drop({
      field: 'a\u001b[2Jb\nc',
      reason: `x\u0000y ${'r'.repeat(4000)}`,
      source: '/etc/nessy/managed-policy.json',
    }))
    expect(hostile).not.toContain('\u001b')
    expect(hostile).not.toContain('\n')
    expect(hostile).not.toContain('\u0000')
    expect(hostile.split('\n')).toHaveLength(1)
    expect(hostile.length).toBeLessThan(600)
  })

  test('the summary counts the entries and is absent when there are none', () => {
    expect(formatManagedPolicyDropSummary([])).toBeUndefined()
    expect(formatManagedPolicyDropSummary([drop()])).toContain(
      '1 managed settings entry was not applied:',
    )
    const two = formatManagedPolicyDropSummary([drop(), drop({ field: 'workflow' })])!
    expect(two).toContain('2 managed settings entries were not applied:')
    expect(two.split('\n')).toHaveLength(3)
  })

  test('reporting writes one tagged block and reports nothing when clean', () => {
    const written: string[] = []
    expect(reportManagedPolicyDrops([], { write: message => written.push(message) })).toBe(0)
    expect(written).toEqual([])

    expect(reportManagedPolicyDrops([drop(), drop({ field: 'workflow' })], {
      write: message => written.push(message),
    })).toBe(2)
    expect(written).toHaveLength(1)
    expect(written[0]!.startsWith('[managed-settings] ')).toBe(true)
    expect(written[0]).toContain('sandbox.network.allowedDomains[1]')
  })
})

describe('a key refused BY DESIGN says so, and says what to do instead (P6.240)', () => {
  test('the `claudeMd` drop names the supported route; an unknown key is untouched', () => {
    // The defect was never that `claudeMd` vanished without a name — the drop
    // already carried `{field: 'claudeMd', reason: 'invalid managed Pi policy
    // key: claudeMd'}`. It is that the sentence is BYTE-IDENTICAL to a typo's,
    // so an administrator following `memory.md`'s managed-instruction section
    // reads a settled posture as their own spelling mistake.
    const refused = formatManagedPolicyDrop(drop({
      field: 'claudeMd',
      reason: 'invalid managed Pi policy key: claudeMd',
    }))
    expect(refused).toContain('invalid managed Pi policy key: claudeMd')
    expect(refused).toContain('refused by design')
    // The alternative must be the filename the loader actually reads, which is
    // why the note interpolates the constant rather than spelling it again.
    expect(refused).toContain(MANAGED_INSTRUCTION_FILE)
    expect(refused.endsWith('[ignored]')).toBe(true)

    // The control, and it is the whole point of the row: a genuine unknown key
    // renders exactly as before. If this ever picks up a note, the table has
    // stopped being a table of DECIDED postures.
    const typo = formatManagedPolicyDrop(drop({
      field: 'totallyUnknownKey',
      reason: 'invalid managed Pi policy key: totallyUnknownKey',
    }))
    expect(typo).toBe(
      '/etc/nessy/managed-policy.json: totallyUnknownKey — '
      + 'invalid managed Pi policy key: totallyUnknownKey [ignored]',
    )
    // `hooks` is deliberately NOT in the table — its posture is a live question
    // in this plan, and a "refused by design" note would pre-empt it.
    expect(managedKeyRefusalNote('hooks')).toBeUndefined()
  })

  test('a nested spelling and an empty field are answered the same way', () => {
    // Unknown-key drops are top-level today; matching the first path segment
    // costs nothing and cannot silently miss if the parser ever reports deeper.
    expect(managedKeyRefusalNote('claudeMd.content')).toBe(managedKeyRefusalNote('claudeMd'))
    expect(managedKeyRefusalNote('claudeMd[0]')).toBe(managedKeyRefusalNote('claudeMd'))
    expect(managedKeyRefusalNote('')).toBeUndefined()
    // A whole-document refusal carries no field and must not gain a note.
    expect(formatManagedPolicyDrop(drop({ field: '' }))).not.toContain('refused by design')
  })
})
