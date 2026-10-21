import { describe, expect, test } from 'bun:test'
import {
  computeSessionSettlementV1,
  type SessionSettlementInputsV1,
} from './session-settlement.ts'

const empty = (): SessionSettlementInputsV1 => ({
  activeForegroundModelTurns: 0,
  activeWorkflowEvaluators: 0,
  activeChildren: 0,
  activeProcesses: 0,
  pendingPermissions: 0,
  pendingAskUser: 0,
  dueImmediateTasks: 0,
})

describe('SessionSettlementV1', () => {
  test('settles only after every pending domain drains', () => {
    expect(computeSessionSettlementV1(empty())).toEqual({
      schemaVersion: 1,
      settled: true,
      pending: [],
    })

    const domains = [
      ['activeForegroundModelTurns', 'foreground_model_turn'],
      ['activeWorkflowEvaluators', 'workflow_evaluator'],
      ['activeChildren', 'child'],
      ['activeProcesses', 'process'],
      ['pendingPermissions', 'permission'],
      ['pendingAskUser', 'ask_user'],
      ['dueImmediateTasks', 'immediate_task'],
    ] as const
    for (const [field, domain] of domains) {
      expect(computeSessionSettlementV1({ ...empty(), [field]: 1 })).toEqual({
        schemaVersion: 1,
        settled: false,
        pending: [domain],
      })
    }
  })

  test('fails closed for invalid producer counts', () => {
    expect(() => computeSessionSettlementV1({ ...empty(), activeChildren: -1 }))
      .toThrow('session-settlement-invalid-count:activeChildren')
    expect(() => computeSessionSettlementV1({ ...empty(), activeProcesses: 0.5 }))
      .toThrow('session-settlement-invalid-count:activeProcesses')
  })
})
