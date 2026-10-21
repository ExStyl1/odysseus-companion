/**
 * The dialect measured against croner (R27b Task 1).
 *
 * This file exists in `shared` rather than beside `cron-dialect.ts` because
 * croner is a dependency of THIS package (Automations' `matchesCron` uses it)
 * and not of `session-tools-core`.
 *
 * It pins the two measurements the dialect module's design rests on:
 *
 * 1. croner ACCEPTS every extended token `scheduled-tasks.md:202` requires us
 *    to refuse. That is why a validating parser exists at all instead of the
 *    dialect being delegated to the scheduler this repo already ships.
 * 2. On the `:204` day rule croner already implements the OR reading, so an
 *    independent implementation agrees with ours — the strongest available
 *    check on the semantic most likely to be coded backwards.
 */

import { describe, expect, test } from 'bun:test'
import { Cron } from 'croner'
import { CronDialectError, nextCronRun, parseCronExpression } from '@nessy-agent/session-tools-core'

describe('croner as an oracle for the documented dialect', () => {
  test('croner accepts every token `:202` refuses, which is why we parse ourselves', () => {
    for (const expression of ['0 9 L * *', '0 9 1W * *', '0 9 ? * 1', '0 9 * * MON', '0 9 * JAN *', '0 9 * * 1#2']) {
      expect(() => new Cron(expression), `croner should accept ${expression}`).not.toThrow()
      expect(() => parseCronExpression(expression), `our dialect must refuse ${expression}`).toThrow(CronDialectError)
    }
  })

  test('croner agrees with the OR reading of DOM+DOW (`:204`)', () => {
    // March 2026: the 13th is a Friday and Mondays are the 2nd, 9th, 16th, 23rd
    // and 30th. Under AND this expression would never fire.
    const parsed = parseCronExpression('0 9 13 3 1')
    const oracle = new Cron('0 9 13 3 1')

    const ours: string[] = []
    let cursor: Date | null = new Date(2026, 2, 1, 0, 0, 0, 0)
    for (let index = 0; index < 6 && cursor; index += 1) {
      cursor = nextCronRun(parsed, cursor)
      if (cursor) ours.push(cursor.toISOString())
    }

    const theirs: string[] = []
    let oracleCursor: Date | null = new Date(2026, 2, 1, 0, 0, 0, 0)
    for (let index = 0; index < 6 && oracleCursor; index += 1) {
      oracleCursor = oracle.nextRun(oracleCursor)
      if (oracleCursor) theirs.push(oracleCursor.toISOString())
    }

    expect(ours).toHaveLength(6)
    expect(ours).toEqual(theirs)
  })

  test('croner and the dialect agree on the plain documented examples too', () => {
    for (const expression of ['*/5 * * * *', '0 * * * *', '7 * * * *', '0 9 * * *', '0 9 * * 1-5', '30 14 15 3 *']) {
      const parsed = parseCronExpression(expression)
      const oracle = new Cron(expression)
      const from = new Date(2026, 2, 15, 8, 43, 17)
      expect(nextCronRun(parsed, from)?.toISOString(), expression).toBe(oracle.nextRun(from)?.toISOString())
    }
  })
})
