/**
 * UA4.2 — the Task editor's permission-mode hint (`kanban/TaskModeHint.tsx`): the ceiling line, the block hint and
 * the Auto judge named per runtime of the task's own sessions.
 *
 * Positive: Auto names exactly the judges of the runtimes the task runs on; Manual / Plan / Accept edits carry the
 * block hint; the editor mounts the hint under its mode picker.
 * Negative: no judge line outside Auto; no block hint in Auto, Don't ask or Bypass; a runtime the task does not use
 * is not named; a runtime no node can run on (`nestor-cloud-agent`) is never named.
 */
import { createElement } from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionMode } from '@nessy-agent/shared/agent/modes'
import { TaskModeHint, taskJudgeRuntimes, taskModeHintKind, type JudgeRuntime } from '../TaskModeHint'

const KANBAN_DIR = join(import.meta.dir, '..')
const LOCALES_DIR = join(KANBAN_DIR, '..', '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8')) as Record<string, string>
const ru = JSON.parse(readFileSync(join(LOCALES_DIR, 'ru.json'), 'utf8')) as Record<string, string>

const KEYS = ['tasks.modeHint.autoJudge', 'tasks.modeHint.blocks', 'tasks.modeHint.ceiling', 'tasks.modeHint.judgeClaude', 'tasks.modeHint.judgeCodex', 'tasks.modeHint.judgePi', 'tasks.modeHint.noPrompts']
const JUDGE = { pi: 'tasks.modeHint.judgePi', anthropic: 'tasks.modeHint.judgeClaude', 'codex-runtime': 'tasks.modeHint.judgeCodex' } as const

let i18n: I18nInstance
beforeAll(async () => {
  i18n = createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } })
})

const render = (mode: PermissionMode, runtimes: JudgeRuntime[]) =>
  renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(TaskModeHint, { mode, runtimes })))

const GROUPS = [
  { connectionSlug: 'gateway-pi', runtime: 'pi' as const },
  { connectionSlug: 'claude-gw', runtime: 'anthropic' as const },
  { connectionSlug: 'codex', runtime: 'codex-runtime' as const },
  { connectionSlug: 'cloud', runtime: 'nestor-cloud-agent' as const },
]
const MODEL_TO_CONNECTION = new Map([['coder', 'gateway-pi'], ['claude-sonnet-4-6', 'claude-gw'], ['gpt-5-codex', 'codex'], ['cloud-model', 'cloud']])

describe('UA4.2 — TaskModeHint', () => {
  it('every hint key exists in en and ru, translated', () => {
    for (const key of KEYS) {
      expect(en[key]).toBeTruthy()
      expect(ru[key]).toBeTruthy()
      expect(ru[key]).not.toBe(en[key])
    }
  })

  it('POSITIVE — Auto names exactly the judges of the task\'s runtimes, under the ceiling line', () => {
    const html = render('auto', ['pi', 'codex-runtime'])
    expect(html).toContain(en['tasks.modeHint.ceiling'])
    expect(html).toContain(en['tasks.modeHint.autoJudge'])
    expect(html).toContain(en[JUDGE.pi])
    expect(html).toContain(en[JUDGE['codex-runtime']])
    expect(html).not.toContain(en[JUDGE.anthropic])
    expect(html).not.toContain(en['tasks.modeHint.blocks'])
  })

  it('POSITIVE — Manual, Plan and Accept edits carry the block hint and name no judge', () => {
    for (const mode of ['default', 'plan', 'acceptEdits'] as PermissionMode[]) {
      expect(taskModeHintKind(mode)).toBe('blocks')
      const html = render(mode, ['pi', 'anthropic', 'codex-runtime'])
      expect(html).toContain(en['tasks.modeHint.ceiling'])
      expect(html).toContain(en['tasks.modeHint.blocks'])
      expect(html).not.toContain(en['tasks.modeHint.autoJudge'])
      for (const key of Object.values(JUDGE)) expect(html).not.toContain(en[key])
    }
  })

  it('NEGATIVE — Don\'t ask says it refuses instead; Bypass adds nothing under the ceiling line', () => {
    const dontAsk = render('dontAsk', ['pi'])
    expect(dontAsk).toContain(en['tasks.modeHint.noPrompts'])
    expect(dontAsk).not.toContain(en['tasks.modeHint.blocks'])
    const bypass = render('bypassPermissions', ['pi'])
    expect(bypass).toContain(en['tasks.modeHint.ceiling'])
    for (const key of ['tasks.modeHint.blocks', 'tasks.modeHint.noPrompts', 'tasks.modeHint.autoJudge', JUDGE.pi]) expect(bypass).not.toContain(en[key])
  })

  it('taskJudgeRuntimes: the orchestrator\'s connection and each subtask\'s (own, else its model\'s, else the orchestrator\'s)', () => {
    // Orchestrator on the Pi gateway; one subtask routed to codex by its model; one inheriting the orchestrator.
    expect(taskJudgeRuntimes(GROUPS, MODEL_TO_CONNECTION, { model: 'coder' }, [{ model: 'gpt-5-codex' }, {}])).toEqual(['pi', 'codex-runtime'])
    // An explicit connection wins over the model's.
    expect(taskJudgeRuntimes(GROUPS, MODEL_TO_CONNECTION, { model: 'coder', llmConnection: 'claude-gw' }, [])).toEqual(['anthropic'])
  })

  it('NEGATIVE — a runtime no node can run on is never named; nothing resolvable names all three judges', () => {
    expect(taskJudgeRuntimes(GROUPS, MODEL_TO_CONNECTION, { model: 'cloud-model' }, [{ model: 'coder' }])).toEqual(['pi'])
    expect(taskJudgeRuntimes(GROUPS, MODEL_TO_CONNECTION, { model: 'unknown-model' }, [])).toEqual(['pi', 'anthropic', 'codex-runtime'])
    expect(taskJudgeRuntimes([], new Map(), {}, [{}])).toEqual(['pi', 'anthropic', 'codex-runtime'])
  })

  it('POSITIVE — the editor mounts the hint under its permission-mode picker, fed the task\'s runtimes (source pin, as task-editor.test.tsx)', () => {
    const editor = readFileSync(join(KANBAN_DIR, 'TaskEditor.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const picker = editor.indexOf("t('tasks.permissionMode')")
    const hint = editor.indexOf('<TaskModeHint mode={permissionMode} runtimes={judgeRuntimes} />')
    expect(picker).toBeGreaterThan(0)
    expect(hint).toBeGreaterThan(picker)
    expect(editor).toContain('taskJudgeRuntimes(groups, modelToConnection, { model: orchModel, llmConnection: orchConnection }, subtasks)')
  })
})
