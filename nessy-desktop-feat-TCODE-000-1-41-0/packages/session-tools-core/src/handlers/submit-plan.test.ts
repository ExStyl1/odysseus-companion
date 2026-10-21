import { describe, expect, test } from 'bun:test'
import { handleSubmitPlan } from './submit-plan.ts'

function context(overrides: Record<string, unknown> = {}): any {
  return {
    fs: { exists: () => true, readFile: () => '# Plan' },
    callbacks: { onPlanSubmitted: () => {} },
    ...overrides,
  }
}

describe('SubmitPlan handler', () => {
  test('uses the Pi host PlanMode port as the sole submit owner', async () => {
    const submitted: string[] = []
    let fallback = 0
    const result = await handleSubmitPlan(context({
      callbacks: { onPlanSubmitted: () => { fallback += 1 } },
      planModePort: { submit: async ({ planPath }: { planPath: string }) => { submitted.push(planPath) } },
    }), { planPath: '/session/plan.md' })
    expect(result.isError).toBeFalsy()
    expect(submitted).toEqual(['/session/plan.md'])
    expect(fallback).toBe(0)
  })

  test('preserves the adjacent callback fallback', async () => {
    const submitted: string[] = []
    const result = await handleSubmitPlan(context({
      callbacks: { onPlanSubmitted: (planPath: string) => { submitted.push(planPath) } },
    }), { planPath: '/session/plan.md' })
    expect(result.isError).toBeFalsy()
    expect(submitted).toEqual(['/session/plan.md'])
  })
})
