import { describe, expect, it } from 'bun:test'

import {
  runPreToolUseChecks,
  shouldPromptInAutoMode,
  type PermissionManagerLike,
  type PreToolUseCheckResult,
} from '../core/pre-tool-use.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import {
  autoClassifierBandRemedy,
  describeAutoClassifierBand,
  findAutoClassifierBand,
  findBackgroundJob,
  findSuspiciousWindowsPath,
} from './auto-classifier-bands.ts'

/**
 * The same stub shape `requires-user-interaction.test.ts` uses: the two arms
 * below are about the PROMPT COPY, so nothing here should depend on a real
 * permission manager's rules.
 */
const stubPermissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

describe('findBackgroundJob', () => {
  const positives: Array<[string, string]> = [
    ['npm run dev &', '&'],
    ['sleep 60 & echo started', '&'],
    ['foo $(bar &)', '&'],
    ['nohup npm start', 'nohup'],
    ['setsid ./daemon.sh', 'setsid'],
    ['/usr/bin/nohup ./server', 'nohup'],
    ['sudo -E nohup ./server', 'nohup'],
    ['NODE_ENV=production nohup ./server', 'nohup'],
    ['start /b server.exe', 'start'],
    ['powershell -Command "Start-Process notepad"', 'start-process'],
  ]
  for (const [command, evidence] of positives) {
    it(`matches ${command}`, () => {
      expect(findBackgroundJob(command)).toEqual({ kind: 'backgroundJob', evidence })
    })
  }

  const negatives = [
    'echo a && echo b',
    'ls -la 2>&1',
    'build.sh &> out.log',
    'cat a |& true',
    "grep '&' notes.txt",
    'curl "https://example.com/?a=1&b=2"',
    'echo one\\&two',
    'git log --oneline',
    // A wrapper name is only a wrapper at the command head — otherwise every
    // `npm start` in every repo would go in front of the judge.
    'npm start',
    'yarn start --port 3000',
    './scripts/start-server.sh',
    'bun run start:dev',
  ]
  for (const command of negatives) {
    it(`does not match ${command}`, () => {
      expect(findBackgroundJob(command)).toBeNull()
    })
  }

  it('reads the Bash tool parameter even when the text carries no operator', () => {
    expect(findBackgroundJob('npm run dev', { run_in_background: true }))
      .toEqual({ kind: 'backgroundJob', evidence: 'run_in_background: true' })
  })

  it('a false-y parameter does not match on its own', () => {
    expect(findBackgroundJob('npm run dev', { run_in_background: false })).toBeNull()
  })
})

describe('findSuspiciousWindowsPath', () => {
  const positives = [
    'copy payload.exe C:\\Windows\\System32\\payload.exe',
    'del D:/Windows/win.ini',
    'icacls "C:\\Program Files\\App" /grant Everyone:F',
    'xcopy build\\* C:\\ProgramData\\App\\',
    'echo hi > %SystemRoot%\\Temp\\note.txt',
    'reg add %windir%\\notepad.exe',
    'powershell -Command "Copy-Item ./a.exe $env:SystemRoot"',
    'copy a.exe \\\\fileserver\\share\\a.exe',
    'fsutil file createnew \\\\?\\C:\\x 1',
    'copy run.lnk "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\run.lnk"',
  ]
  for (const command of positives) {
    it(`matches ${command}`, () => {
      expect(findSuspiciousWindowsPath(command)?.kind).toBe('suspiciousWindowsPath')
    })
  }

  const negatives = [
    'mkdir -p packages/shared/src/windows',
    'cat apps/electron/scripts/build-win.ps1',
    'echo "windows and doors"',
    'node scripts/system32-report.mjs',
    'cp dist/app.js /Users/me/program files',
    'git commit -m "fix the windows build"',
  ]
  for (const command of negatives) {
    it(`does not match ${command}`, () => {
      expect(findSuspiciousWindowsPath(command)).toBeNull()
    })
  }
})

describe('findAutoClassifierBand', () => {
  it('returns null for an ordinary command', () => {
    expect(findAutoClassifierBand('npm run build')).toBeNull()
  })

  it('prefers the background class when a command is both', () => {
    expect(findAutoClassifierBand('copy a.exe C:\\Windows\\a.exe &')?.kind).toBe('backgroundJob')
  })

  it('describes each class in a line that names WHY the prompt appeared', () => {
    expect(describeAutoClassifierBand({ kind: 'backgroundJob', evidence: '&' }))
      .toContain('outlives this call')
    const path = findSuspiciousWindowsPath('copy a.exe C:\\Windows\\System32\\a.exe')!
    expect(describeAutoClassifierBand(path, 'copy'))
      .toBe(
        'Names the Windows directory (C:\\Windows\\). '
        + 'Auto mode never touches a Windows system path unreviewed. '
        + 'An allow rule clears it without a prompt: Bash(copy:*).',
      )
  })
})

// ============================================================
// P2.111 — the moved-class prompt names its own remedy
// ============================================================
//
// On claude and codex these two classes PROMPT where Pi's guardian clears them
// silently, and the remedy already works (an allow rule returns null above the
// band check). The defect was that nothing said so. The two arms below are the
// two halves the row asks for: the moved-class prompt CARRIES the hint, and a
// non-negotiable floor's prompt does NOT — a floor has no remedy by design, so
// the same sentence there would be an offer the product then refuses.

describe('P2.111 · the remedy is named for the two moved classes and nowhere else', () => {
  it('names the rule a user would actually write, for both classes', () => {
    // MUTATION KILLED: dropping the remedy from either arm of
    // `describeAutoClassifierBand`. Both classes are asserted because a fix
    // applied to one branch is exactly what a partial edit here looks like.
    const background = describeAutoClassifierBand({ kind: 'backgroundJob', evidence: '&' }, 'npm')
    const windowsPath = describeAutoClassifierBand(
      { kind: 'suspiciousWindowsPath', evidence: 'C:\\Windows\\', label: 'the Windows directory' },
      'copy',
    )
    expect(background).toContain('Bash(npm:*)')
    expect(windowsPath).toContain('Bash(copy:*)')
    for (const line of [background, windowsPath]) {
      expect(line).toContain('An allow rule clears it without a prompt')
    }
  })

  it('falls back to the rule SHAPE when the head is unknown, never to `Bash(:*)`', () => {
    // `getBaseCommand` is typed `string` and returns '' for a command the parser
    // cannot head (the risky filter tests `!baseCommand`), so the blank arm is
    // reachable. The rule FORM is the half a user does not know, so a hint is
    // still better than none — but a rule that would match nothing is not.
    for (const head of [undefined, '', '   ']) {
      const line = autoClassifierBandRemedy(head)
      expect(line).toBe('An allow rule clears it without a prompt: Bash(<command>:*).')
      expect(line).not.toContain('Bash(:*)')
    }
  })

  it('A FLOOR PROMPT CARRIES NO REMEDY: the removal breaker is not offered one', () => {
    // MUTATION KILLED: moving the remedy onto the shared prompt instead of the
    // band description. `nonNegotiable` prompts are refused by an allow rule, a
    // remembered click and a PreToolUse hook `allow` alike
    // (`promptIsNonNegotiable`), so advertising a rule there would send the user
    // to write one that cannot work — the failure mode this row's scope note
    // forbids, and the reason the sentence lives on the band and not the prompt.
    const sessionKey = { workspaceId: 'ws-p2111', sessionId: 'session-p2111-floor' }
    cleanupModeState(sessionKey)
    initializeModeState(sessionKey, 'auto')
    try {
      const floor = runPreToolUseChecks({
        toolName: 'Bash',
        input: { command: 'rm -rf ~' },
        sessionId: sessionKey.sessionId,
        sessionKey,
        permissionMode: 'auto',
        workspaceRootPath: '/fixture/workspace',
        workspaceId: sessionKey.workspaceId,
        activeSourceSlugs: [],
        allSourceSlugs: [],
        hasSourceActivation: false,
        permissionManager: stubPermissionManager,
      })
      // Positive control on the same rig: this really is the floor branch, so a
      // green run cannot come from a command that never reached one.
      expect(floor.type).toBe('prompt')
      const prompt = floor as Extract<PreToolUseCheckResult, { type: 'prompt' }>
      expect(prompt.nonNegotiable).toBeDefined()
      expect(prompt.impact ?? '').not.toContain('An allow rule clears it')
    } finally {
      cleanupModeState(sessionKey)
    }
  })

  it('AND NEITHER DOES AN ORDINARY RISKY-BAND PROMPT, which is where the band is not consulted', () => {
    // The second half of the scope, driven through the production function
    // rather than asserted about it: a command the risky filter keeps returns
    // its prompt UNCHANGED, above the band check, so only the two moved classes
    // ever get the sentence.
    const risky = shouldPromptInAutoMode(
      'Bash',
      { command: 'rm -rf /tmp/p2111-scratch' },
      { ...stubPermissionManager, isDangerousCommand: () => true },
      { workspaceRootPath: '/fixture/workspace' },
      undefined,
      undefined,
      { adjudicateMovedCheckClasses: true },
    )
    expect(risky).not.toBeNull()
    expect(risky?.impact ?? '').not.toContain('An allow rule clears it')
  })
})
