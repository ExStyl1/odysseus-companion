/**
 * P6.209, denominator entries A44 and A45 — the auto-mode judge's own rules had
 * no surface anywhere.
 *
 * The row's evidence: `git grep -ain autoMode -- apps/electron/src packages/ui
 * packages/shared/src/i18n/locales/en.json` returned **0**, against 18 hits in
 * `managed-policy.ts`. The block itself has been sent on every Claude session
 * since P3.94, so this deployment has been instructing a second model about what
 * is normal and what is forbidden while the person it protects could not read a
 * word of it.
 *
 * Source-matched, as its siblings on this page are: `bun test` has no DOM here,
 * and importing the section would drag in the `@nessy-agent/ui` barrel and its
 * pdfjs `?url` chain — measured at 186 s and a hard failure by
 * `permissions-cross-scope.test.ts` before its derivation was lifted to a leaf.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol/channels'
import { channelLocality } from '@nessy-agent/shared/protocol/routing'
import {
  buildClaudeAutoModeEnvironmentRules,
  buildClaudeAutoModeHardDenyRules,
  buildClaudeAutoModeSoftDenyRules,
  CLAUDE_AUTO_MODE_DEFAULTS_SPLICE,
} from '@nessy-agent/shared/agent/claude-auto-mode-policy'

const section = readFileSync(
  fileURLToPath(new URL('../AutoModeJudgeRulesSection.tsx', import.meta.url)),
  'utf8',
)
const page = readFileSync(
  fileURLToPath(new URL('../PermissionsSettingsPage.tsx', import.meta.url)),
  'utf8',
)

const JUDGE_KEYS = [
  'settings.permissions.judgeRules.title',
  'settings.permissions.judgeRules.description',
  'settings.permissions.judgeRules.scopeNote',
  'settings.permissions.judgeRules.environment',
  'settings.permissions.judgeRules.gatewayEnvironment',
  'settings.permissions.judgeRules.hardDeny',
  'settings.permissions.judgeRules.softDeny',
  'settings.permissions.judgeRules.classifyAllShell',
  'settings.permissions.judgeRules.allowWithheld',
  'settings.permissions.judgeRules.defaultsSplice',
  'settings.permissions.judgeRules.unavailable',
] as const

describe('auto-mode judge rules surface', () => {
  it('exists at all, which is the whole of A44', () => {
    expect(section).toContain('getAutoModePolicy()')
    expect(page).toContain('<AutoModeJudgeRulesSection />')
  })

  it('renders every band the runtime accepts except the one we never send', () => {
    // The four arrays of the block, minus `allow`. A band silently dropped from
    // the JSX would leave rules in force that nobody can read, which is exactly
    // the state this row found.
    for (const band of ['hardDeny', 'softDeny', 'environment', 'gatewayEnvironment']) {
      expect(section).toContain(`policy.${band}`)
    }
    // `allow` is never sent — a floor narrows and never grants — so the absence
    // is explained rather than left as a blank section.
    expect(section).not.toContain('policy.allow')
    expect(section).toContain("t('settings.permissions.judgeRules.allowWithheld')")
  })

  it('is read-only, and the channel has no setter to reach for', () => {
    // The open owner question is whether an operator may EDIT these lists. The
    // viewer is correct under either answer, and there is nothing to write with.
    expect(Object.values(RPC_CHANNELS.permissions).filter(c => c.includes('AutoModePolicy')))
      .toEqual([RPC_CHANNELS.permissions.GET_AUTO_MODE_POLICY])
    expect(section).not.toContain('setAutoModePolicy')
  })

  it('turns the $defaults literal into the sentence it means', () => {
    // `$defaults` is an instruction to the runtime — *"Include the literal string
    // `$defaults` to inherit the built-in rules at that position"* — and every
    // band this deployment sends carries it. Rendered raw it reads as debris;
    // dropped silently it hides that Anthropic's own rules still apply.
    expect(section).toContain("const DEFAULTS_SPLICE = '$defaults'")
    expect(section).toContain("t('settings.permissions.judgeRules.defaultsSplice')")
    // Pinned against the real builders, so a band that stopped splicing the
    // defaults would fail here rather than silently changing what the judge is
    // told.
    for (const rules of [
      buildClaudeAutoModeHardDenyRules(),
      buildClaudeAutoModeSoftDenyRules(),
      buildClaudeAutoModeEnvironmentRules({ gatewayUpstream: false }),
    ]) {
      expect(rules).toContain(CLAUDE_AUTO_MODE_DEFAULTS_SPLICE)
    }
  })

  it('splits the gateway band, because that sentence is session-scoped', () => {
    // The measurement the split exists for: the gateway sentence is emitted only
    // for a session whose adapter resolved the `nestor` upstream, and a settings
    // page has no session. If these two ever became equal the split would be
    // decoration — and the page would be claiming a condition that does not
    // exist.
    const plain = buildClaudeAutoModeEnvironmentRules({ gatewayUpstream: false })
    const onGateway = buildClaudeAutoModeEnvironmentRules({ gatewayUpstream: true })
    expect(onGateway.length).toBeGreaterThan(plain.length)
    for (const rule of plain) expect(onGateway).toContain(rule)
  })

  it('states the two limits that stop it over-promising, in every locale', () => {
    for (const [name, bundle] of Object.entries({
      en: en as Record<string, string>,
      ru: ru as Record<string, string>,
    })) {
      for (const key of JUDGE_KEYS) {
        expect(`${name}:${key}:${(bundle[key] ?? '').length > 0}`).toBe(`${name}:${key}:true`)
      }
    }
    const scope = (en as Record<string, string>)['settings.permissions.judgeRules.scopeNote'] ?? ''
    // One runtime only — Pi and codex have their own and read none of this.
    expect(scope).toContain('Claude Code')
    // And P3.93's measured ceiling: our own allow silences the classifier, so
    // these rules are not a net under everything.
    expect(scope).toContain('never reaches the judge')
  })

  it('routes locally, because the block is composed from THIS host policy floor', () => {
    const channel = RPC_CHANNELS.permissions.GET_AUTO_MODE_POLICY
    expect(`${channel}:${channelLocality(channel)}`).toBe(`${channel}:local`)
  })
})
