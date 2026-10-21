/**
 * F1.468 — `looksLikePowerShell` reads a Verb-Noun as a cmdlet only where PowerShell would
 * run it: in COMMAND position.
 *
 * The cmdlet pattern matched `\b(Get|Set|…|Pop)-\w+` ANYWHERE, so an ordinary sh command
 * whose ARGUMENT happens to be spelled like one — `kubectl config get-contexts`,
 * `npm run test-unit` — was classified PowerShell. With `pwsh` installed that sends it to
 * the PowerShell AST validator (`mode-manager.ts`'s `getBashRejectionReason`, the
 * `isPsCommand && isPowerShellAvailable()` branch), which spawns the parser with P2.240's
 * deliberate 10 s ceiling: measured on this host at HEAD, `kubectl config get-contexts` under
 * a kubectl read-only pattern took 10 010 ms and came back a `parse_error` REFUSAL, where the
 * bash path allows it at once.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { looksLikePowerShell } from './claude-powershell-rule.ts'
import { getBashRejectionReason } from '../mode-manager.ts'
import { getPowerShellValidatorRoot, setPowerShellValidatorRoot } from '../powershell-validator.ts'

describe('F1.468 · a Verb-Noun is a cmdlet only in command position', () => {
  it('an sh command whose ARGUMENT is spelled like a cmdlet is not PowerShell', () => {
    expect(looksLikePowerShell('kubectl config get-contexts')).toBe(false)
    expect(looksLikePowerShell('npm run test-unit')).toBe(false)
    expect(looksLikePowerShell('git checkout -b remove-legacy')).toBe(false)
    expect(looksLikePowerShell('echo "Get-Date"')).toBe(false)
  })

  it('a cmdlet at the head, or after a separator PowerShell runs a command after, still is', () => {
    expect(looksLikePowerShell('Get-ChildItem')).toBe(true)
    expect(looksLikePowerShell('Get-ChildItem -Force')).toBe(true)
    expect(looksLikePowerShell('get-process')).toBe(true)
    expect(looksLikePowerShell('  Get-Content guide.md')).toBe(true)
    expect(looksLikePowerShell('cd src; Get-ChildItem')).toBe(true)
    expect(looksLikePowerShell('ls | Out-File list.txt')).toBe(true)
    expect(looksLikePowerShell('npm test && Remove-Item build')).toBe(true)
    expect(looksLikePowerShell('(Get-Item x).Length')).toBe(true)
    expect(looksLikePowerShell('$files = Get-ChildItem')).toBe(true)
    expect(looksLikePowerShell('& "Remove-Item" x')).toBe(true)
    expect(looksLikePowerShell('if ($x) { Remove-Item y }')).toBe(true)
    expect(looksLikePowerShell('cd src\nGet-ChildItem')).toBe(true)
  })

  // F1.499 (2) — F1.468's named residue, DECIDED: a Linux command whose own NAME is
  // Verb-Noun-shaped sits in command position too, so position alone cannot tell it from a
  // cmdlet. Two shapes can, and neither is a list of names: a cmdlet name is ONE Verb-Noun pair
  // (`start-stop-daemon` has a second hyphenated segment), and a cmdlet takes `-Param`
  // parameters, never a GNU `--long` option (`update-alternatives --config java`).
  it('a Linux command NAMED like a Verb-Noun is not PowerShell when its shape says sh', () => {
    expect(looksLikePowerShell('update-alternatives --config java')).toBe(false)
    expect(looksLikePowerShell('sudo update-alternatives --config java')).toBe(false)
    expect(looksLikePowerShell('cd /etc; update-alternatives --display editor')).toBe(false)
    expect(looksLikePowerShell('start-stop-daemon --start --exec /usr/bin/x')).toBe(false)
    expect(looksLikePowerShell('start-stop-daemon')).toBe(false)
  })

  it('CONTROL — cmdlets with PowerShell parameters, or none, are still PowerShell', () => {
    expect(looksLikePowerShell('Get-ChildItem')).toBe(true)
    expect(looksLikePowerShell('get-process')).toBe(true)
    expect(looksLikePowerShell('Get-ChildItem -Force')).toBe(true)
    expect(looksLikePowerShell('Update-Help -Force')).toBe(true)
    expect(looksLikePowerShell('Start-Process notepad')).toBe(true)
    // The stop-parsing token `--%` is PowerShell's own, not a GNU long option.
    expect(looksLikePowerShell('Start-Process --% /c dir')).toBe(true)
  })

  it('the command reaches the bash validator, never the PowerShell parser', () => {
    // A parser root with no parser script in it makes the PowerShell path a deterministic
    // REFUSAL ("parser script not found", `parseCommand`) that never spawns the parser — so
    // on a host with pwsh, a command routed there is refused, and one routed to the bash
    // validator is answered by the allowlist. Measured at HEAD on this host (pwsh at
    // /opt/homebrew/bin/pwsh): the kubectl read below came back refused. On a host without
    // pwsh both routes are the bash validator, and the detector arm above is the one that
    // discriminates.
    const savedRoot = getPowerShellValidatorRoot()
    const emptyRoot = mkdtempSync(join(tmpdir(), 'f1468-no-parser-'))
    setPowerShellValidatorRoot(emptyRoot)
    try {
      const config = {
        blockedTools: new Set(['Write', 'Edit']),
        readOnlyBashPatterns: [
          { regex: /^kubectl\s+(?:get|config\s+get-contexts)\b/, source: '^kubectl\\s+(?:get|config\\s+get-contexts)\\b', comment: 'kubectl read' },
        ],
        readOnlyMcpPatterns: [],
        allowedApiEndpoints: [],
        allowedWritePaths: [],
        displayName: 'Test',
        shortcutHint: 'SHIFT+TAB',
      } as unknown as Parameters<typeof getBashRejectionReason>[1]
      expect(getBashRejectionReason('kubectl config get-contexts', config)).toBeNull()
      // Negative control on the same config: a kubectl WRITE is still refused, so the null
      // above is the allowlist answering and not a validator that allows everything.
      expect(getBashRejectionReason('kubectl delete pod x', config)).not.toBeNull()
    } finally {
      setPowerShellValidatorRoot(savedRoot)
      rmSync(emptyRoot, { recursive: true, force: true })
    }
  })
})
