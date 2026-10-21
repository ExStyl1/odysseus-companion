import { describe, it, expect, afterEach, jest } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseAutomationsConfig } from '../types'
import { computeNextRuns } from '../utils'
// UB14.49 — the scheduler itself, so "the list and the scheduler agree on the hour" is measured, not assumed.
import { matchesCron } from '../../../../../../../packages/shared/src/automations/cron-matcher.ts'

describe('parseAutomationsConfig', () => {
  it('returns [] for null input', () => {
    expect(parseAutomationsConfig(null)).toEqual([])
  })

  it('returns [] for undefined input', () => {
    expect(parseAutomationsConfig(undefined)).toEqual([])
  })

  it('returns [] for non-object input', () => {
    expect(parseAutomationsConfig('string')).toEqual([])
    expect(parseAutomationsConfig(42)).toEqual([])
    expect(parseAutomationsConfig(true)).toEqual([])
  })

  it('returns [] for { automations: {} } (empty automations)', () => {
    expect(parseAutomationsConfig({ version: 2, automations: {} })).toEqual([])
  })

  it('returns [] for missing automations key', () => {
    expect(parseAutomationsConfig({ version: 2 })).toEqual([])
  })

  it('parses single event with one matcher', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [{
          cron: '0 9 * * 1-5',
          actions: [{ type: 'prompt', prompt: 'echo hello' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items).toHaveLength(1)
    expect(items[0].event).toBe('SchedulerTick')
    expect(items[0].matcherIndex).toBe(0)
    expect(items[0].cron).toBe('0 9 * * 1-5')
    expect(items[0].actions).toHaveLength(1)
    expect(items[0].actions[0].type).toBe('prompt')
  })

  it('parses multiple events with multiple matchers', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [
          { cron: '0 9 * * *', actions: [{ type: 'prompt', prompt: 'Run backup' }] },
          { cron: '0 18 * * *', actions: [{ type: 'prompt', prompt: 'Run cleanup' }] },
        ],
        LabelAdd: [
          { matcher: 'urgent', actions: [{ type: 'prompt', prompt: 'Handle urgent' }] },
        ],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items).toHaveLength(3)
    expect(items[0].event).toBe('SchedulerTick')
    expect(items[0].matcherIndex).toBe(0)
    expect(items[1].event).toBe('SchedulerTick')
    expect(items[1].matcherIndex).toBe(1)
    expect(items[2].event).toBe('LabelAdd')
    expect(items[2].matcherIndex).toBe(0)
  })

  it('derives name from name field when present', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [{
          name: 'Morning Backup',
          actions: [{ type: 'prompt', prompt: 'Run the morning backup' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].name).toBe('Morning Backup')
  })

  it('derives name from @mention in prompt', () => {
    const config = {
      version: 2,
      automations: {
        UserPromptSubmit: [{
          actions: [{ type: 'prompt', prompt: 'Run @daily-standup task' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].name).toBe('daily-standup prompt')
  })

  it('derives name from prompt when no name field', () => {
    const config = {
      version: 2,
      automations: {
        SessionStart: [{
          actions: [{ type: 'prompt', prompt: 'echo "hello world"' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].name).toBe('echo "hello world"')
  })

  it('truncates long names to 40 chars with ellipsis', () => {
    const longPrompt = 'a'.repeat(50)
    const config = {
      version: 2,
      automations: {
        SessionStart: [{
          actions: [{ type: 'prompt', prompt: longPrompt }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].name).toBe('a'.repeat(40) + '...')
  })

  it('sets enabled: true when field is missing (default)', () => {
    const config = {
      version: 2,
      automations: {
        SessionStart: [{
          actions: [{ type: 'prompt', prompt: 'Run test' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].enabled).toBe(true)
  })

  it('sets enabled: false when explicitly set', () => {
    const config = {
      version: 2,
      automations: {
        SessionStart: [{
          enabled: false,
          actions: [{ type: 'prompt', prompt: 'Run test' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].enabled).toBe(false)
  })

  it('skips matchers with empty actions array', () => {
    const config = {
      version: 2,
      automations: {
        SessionStart: [
          { actions: [] },
          { actions: [{ type: 'prompt', prompt: 'valid' }] },
        ],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('valid')
  })

  it('generates correct matcherIndex per event', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [
          { actions: [{ type: 'prompt', prompt: 'a' }] },
          { actions: [{ type: 'prompt', prompt: 'b' }] },
          { actions: [{ type: 'prompt', prompt: 'c' }] },
        ],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].matcherIndex).toBe(0)
    expect(items[1].matcherIndex).toBe(1)
    expect(items[2].matcherIndex).toBe(2)
  })

  it('generates unique IDs across events', () => {
    const config = {
      version: 2,
      automations: {
        SchedulerTick: [{ actions: [{ type: 'prompt', prompt: 'a' }] }],
        LabelAdd: [{ actions: [{ type: 'prompt', prompt: 'b' }] }],
        SessionStart: [{ actions: [{ type: 'prompt', prompt: 'c' }] }],
      },
    }
    const items = parseAutomationsConfig(config)
    const ids = items.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('preserves optional fields (matcher, cron, timezone, permissionMode, labels)', () => {
    const config = {
      version: 2,
      automations: {
        LabelAdd: [{
          matcher: 'urgent',
          permissionMode: 'ask',
          labels: ['important'],
          actions: [{ type: 'prompt', prompt: 'Handle it' }],
        }],
      },
    }
    const items = parseAutomationsConfig(config)
    expect(items[0].matcher).toBe('urgent')
    expect(items[0].permissionMode).toBe('default')
    expect(items[0].labels).toEqual(['important'])
  })

  it('accepts a renderer-safe webhook action without saved execution data', () => {
    const items = parseAutomationsConfig({
      version: 2,
      automations: {
        LabelAdd: [{
          actions: [{
            type: 'webhook',
            url: 'https://example.test/hook',
            method: 'POST',
            bodyFormat: 'json',
            captureResponse: true,
          }],
        }],
      },
    })

    expect(items[0].actions[0]).toEqual({
      type: 'webhook',
      url: 'https://example.test/hook',
      method: 'POST',
      bodyFormat: 'json',
      captureResponse: true,
    })
  })
})

// F1.795 — automations:get's managedLocalAutomationDisabled marks every automation the policy keeps from running.
describe('parseAutomationsConfig — the managed local-automation policy (F1.795)', () => {
  const config = (flag?: true) => ({
    version: 2,
    ...(flag ? { managedLocalAutomationDisabled: flag } : {}),
    automations: { SchedulerTick: [{ id: 'a1b2c3', cron: '* * * * *', actions: [{ type: 'prompt', prompt: 'ping' }] }] },
  })

  it('marks each automation when the policy is on', () => {
    expect(parseAutomationsConfig(config(true)).map(item => item.managedDisabled)).toEqual([true])
  })

  it('NEGATIVE — no mark without the flag', () => {
    expect(parseAutomationsConfig(config()).map(item => item.managedDisabled)).toEqual([undefined])
  })
})

// UB14.49 (v0.15.0 "Automation next run in the right timezone") — this describe is copied from
// v0.15.1:apps/electron/src/renderer/components/automations/__tests__/types.test.ts.
describe('cron next-run timezone', () => {
  // A zone that is never the machine's own, so the test fails if the cron is evaluated in the local zone.
  const tz = 'Pacific/Kiritimati'

  it('computes next runs in the automation timezone, like the scheduler', () => {
    const [next] = computeNextRuns('0 9 * * *', 1, tz)
    expect(next).toBeDefined()
    const hour = next!.toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz })
    expect(Number(hour)).toBe(9)
  })

  it('shows the next run of a zoned automation at its own wall-clock time', () => {
    const [item] = parseAutomationsConfig({
      version: 2,
      automations: {
        SchedulerTick: [{ cron: '30 9 * * *', timezone: tz, actions: [{ type: 'prompt', prompt: 'standup' }] }],
      },
    })
    expect(item!.summary).toContain('9:30 AM')
    expect(item!.summary).toContain('(Kiritimati)')
  })
})

// UB14.49 — the scheduler (`matchesCron`, packages/shared/src/automations/cron-matcher.ts) fires at the
// instant the list and the info page compute, with and without a timezone.
describe('cron next-run timezone — agreement with the scheduler (UB14.49)', () => {
  const tz = 'Pacific/Kiritimati'
  afterEach(() => {
    jest.useRealTimers()
  })

  it('the scheduler fires at the zoned next run', () => {
    const [next] = computeNextRuns('30 9 * * *', 1, tz)
    expect(next).toBeDefined()
    jest.useFakeTimers(); jest.setSystemTime(next!)
    expect(matchesCron('30 9 * * *', tz)).toBe(true)
  })

  it('NEGATIVE (control) — no timezone: the system zone, as the scheduler', () => {
    // `bun test` runs in UTC unless TZ is exported, so here this arm cannot tell the system zone from a
    // hard-coded UTC default; any other default (measured: 'Asia/Tokyo') turns it red, and so does a TZ=<zone> run.
    const [next] = computeNextRuns('30 9 * * *', 1)
    expect(next).toBeDefined()
    expect([next!.getHours(), next!.getMinutes()]).toEqual([9, 30])
    jest.useFakeTimers(); jest.setSystemTime(next!)
    expect(matchesCron('30 9 * * *')).toBe(true)
    // The zoned scheduler does not fire at the system zone's 9:30 (the machine is never on Kiritimati).
    expect(matchesCron('30 9 * * *', tz)).toBe(false)
    jest.useRealTimers()

    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const systemCity = systemTz.split('/').pop()!.replace(/_/g, ' ')
    const [item] = parseAutomationsConfig({
      version: 2,
      automations: { SchedulerTick: [{ cron: '30 9 * * *', actions: [{ type: 'prompt', prompt: 'standup' }] }] },
    })
    expect(item!.summary).toContain('9:30 AM')
    expect(item!.summary).toContain(`(${systemCity})`)
  })

  it('the info page computes AND formats its next runs in the automation zone (read from source)', () => {
    // Read from source: the page needs the AppShell context this runner does not mount (script-action-row.test.tsx).
    const page = readFileSync(join(import.meta.dir, '..', 'AutomationInfoPage.tsx'), 'utf8')
    expect(page).toContain('computeNextRuns(automation.cron, 3, automation.timezone)')
    expect(page.split('timeZone: automation.timezone').length - 1).toBe(2)
    // Negative needle: the zone-less call (the pre-UB14.49 shape) is gone.
    expect(page).not.toContain('computeNextRuns(automation.cron)')
  })
})
