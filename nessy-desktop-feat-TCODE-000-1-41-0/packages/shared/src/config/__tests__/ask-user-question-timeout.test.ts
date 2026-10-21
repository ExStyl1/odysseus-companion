/**
 * `askUserQuestionTimeout` (R7 Task 3) — settings.md:
 * "Default: `never`. Idle time before an unanswered AskUserQuestion dialog
 * auto-continues with whatever options you'd already selected. Accepts `60s`,
 * `5m`, `10m`, or `never`. … writes this key to user settings. Not read from
 * project or local settings."
 *
 * The last clause is a settings-precedence boundary: a checked-in repo must
 * not be able to auto-answer a user's questions. These tests pin (a) the
 * strict stored-config envelope accepts the key (the R4 brick class — only a
 * disk round-trip through the production loader proves it), (b) the default
 * and value mapping, and (c) that the project config layer cannot carry it.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

import {
  ASK_USER_QUESTION_TIMEOUT_VALUES,
  askUserQuestionTimeoutToMs,
  parseAskUserQuestionTimeout,
} from '../storage.ts'
import { parseProjectNessyAgentConfig } from '../../plugins/project-config.ts'

const storageModule = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

/**
 * The budget belongs to the FILE, not to a case. Each `runWithConfig` pays for one
 * bun process importing `storage.ts`'s whole module graph, and that cost is a
 * PAGE-CACHE LOTTERY rather than work — measured 2026-09-11 on the same bytes, the
 * same child printing the correct `["5m",300000]`: `real 48.74` at load 8.26, then
 * `real 38.28` at load 8.49, then **0.29 / 0.34 / 0.35** at load 7.62 once the
 * graph was warm. CPU is flat at ~0.5 s user + 0.2 s sys across all five, i.e.
 * 1.7 % of the slow wall: blocked on reads, not descheduled, and a 140x spread that
 * straddles the 5 s default. Against that default all three envelope cases died at
 * `expect(run.exitCode).toBe(0)` with `null` — the child killed mid-import — which
 * reads exactly like the bricked loader this file exists to catch and is its
 * opposite. Sized like the siblings paying the same cost
 * (`review-effort-memory.test.ts`, `workflow-settings.test.ts`); on the warm path
 * it costs nothing.
 */
setDefaultTimeout(300_000)

function runWithConfig(config: Record<string, unknown> | undefined, expression: string) {
  const configDir = mkdtempSync(join(tmpdir(), 'nessy-ask-timeout-'))
  if (config) {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({
      storageLayoutVersion: 2,
      workspaceRefs: [{ id: 'ws-1', lastAccessedAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      ...config,
    }), 'utf-8')
  }
  return Bun.spawnSync([
    process.execPath,
    '--eval',
    `import * as S from '${storageModule}'; ${expression}`,
  ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
}

describe('askUserQuestionTimeout stored-config envelope (R4 brick class)', () => {
  it('loads a config.json that sets askUserQuestionTimeout through the production loader', () => {
    const run = runWithConfig({ askUserQuestionTimeout: '5m' },
      `S.loadStoredConfig(); console.log(JSON.stringify([S.getAskUserQuestionTimeout(), S.getAskUserQuestionTimeoutMs()]))`)
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    expect(JSON.parse(run.stdout.toString().trim())).toEqual(['5m', 5 * 60 * 1000])
  })

  it('defaults to never (no timer) when the key is absent', () => {
    const run = runWithConfig({},
      `S.loadStoredConfig(); console.log(JSON.stringify([S.getAskUserQuestionTimeout(), S.getAskUserQuestionTimeoutMs() ?? null]))`)
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    expect(JSON.parse(run.stdout.toString().trim())).toEqual(['never', null])
  })

  it('treats an invalid value as never instead of bricking the load', () => {
    const run = runWithConfig({ askUserQuestionTimeout: 'ten-minutes' },
      `S.loadStoredConfig(); console.log(JSON.stringify([S.getAskUserQuestionTimeout(), S.getAskUserQuestionTimeoutMs() ?? null]))`)
    expect(run.exitCode, run.stderr.toString()).toBe(0)
    expect(JSON.parse(run.stdout.toString().trim())).toEqual(['never', null])
  })
})

describe('askUserQuestionTimeout value mapping', () => {
  it('accepts exactly the documented values', () => {
    expect([...ASK_USER_QUESTION_TIMEOUT_VALUES]).toEqual(['60s', '5m', '10m', 'never'])
    expect(parseAskUserQuestionTimeout('60s')).toBe('60s')
    expect(parseAskUserQuestionTimeout('5m')).toBe('5m')
    expect(parseAskUserQuestionTimeout('10m')).toBe('10m')
    expect(parseAskUserQuestionTimeout('never')).toBe('never')
    expect(parseAskUserQuestionTimeout(undefined)).toBe('never')
    expect(parseAskUserQuestionTimeout(60)).toBe('never')
    expect(parseAskUserQuestionTimeout('1h')).toBe('never')
  })

  it('maps values to milliseconds with never producing no timer', () => {
    expect(askUserQuestionTimeoutToMs('60s')).toBe(60_000)
    expect(askUserQuestionTimeoutToMs('5m')).toBe(300_000)
    expect(askUserQuestionTimeoutToMs('10m')).toBe(600_000)
    expect(askUserQuestionTimeoutToMs('never')).toBeUndefined()
  })
})

describe('askUserQuestionTimeout is user-settings only', () => {
  it('is a forbidden project-config [defaults] key — a repo cannot auto-answer questions', () => {
    const parsed = parseProjectNessyAgentConfig([
      '[defaults]',
      'ask_user_question_timeout = "60s"',
    ].join('\n'))
    expect(Object.values(parsed.defaults)).not.toContain('60s')
    expect(JSON.stringify(parsed.defaults)).not.toContain('60s')
  })

  it('a project config carrying the key surfaces a forbidden-key error diagnostic', () => {
    const diagnostics: Array<{ severity: string; code: string; message: string }> = []
    parseProjectNessyAgentConfig([
      '[defaults]',
      'ask_user_question_timeout = "60s"',
    ].join('\n'), 'fixture-config.toml', diagnostics as never)
    const forbidden = diagnostics.find(diagnostic => diagnostic.code === 'plugin.project_config.forbidden_key')
    expect(forbidden, JSON.stringify(diagnostics)).toBeDefined()
    expect(forbidden!.message).toContain('ask_user_question_timeout')
  })
})
