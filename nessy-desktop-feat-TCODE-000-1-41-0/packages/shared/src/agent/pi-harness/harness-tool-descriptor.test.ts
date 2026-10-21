import { describe, expect, it } from 'bun:test'

import {
  HARNESS_TOOL_DESCRIPTORS,
  PI_TOOL_BINDINGS,
  getHarnessToolDescriptor,
  getPiToolBinding,
} from './harness-tool-descriptor.ts'

describe('H2 Pi harness tool registry', () => {
  it('owns every static model-visible name and explicit dispatch mapping', () => {
    const piNames = PI_TOOL_BINDINGS.map(binding => binding.piName)
    expect(new Set(piNames).size).toBe(piNames.length)
    expect(piNames).toContain('notebook_edit')
    expect(piNames).toContain('stop_task')
    expect(piNames).not.toContain('NotebookEdit')
    expect(piNames).not.toContain('stopTask')
    expect(piNames).toContain('get_subagent_result')
    expect(piNames).toContain('steer_subagent')
    expect(piNames).not.toContain('kill_task')
    expect(piNames).not.toContain('task_output')
    expect(piNames).not.toContain('child')
    expect(piNames).toContain('lsp')
    expect(getPiToolBinding('lsp')).toMatchObject({ bindingName: 'lsp', descriptorId: 'lsp' })

    expect(getPiToolBinding('notebook_edit')).toMatchObject({
      bindingName: 'NotebookEdit',
      handlerName: 'NotebookEdit',
    })
    expect(getPiToolBinding('stop_task')).toMatchObject({
      bindingName: 'stopTask',
      handlerName: 'stopTask',
      // permissions.md:158 + the tools-reference.md table row: the canonical
      // name a permission rule or hook matcher writes is `TaskStop`.
      permissionName: 'TaskStop',
    })
  })

  it('keeps policy metadata separate and classifies source_test as mutating', () => {
    expect(HARNESS_TOOL_DESCRIPTORS.length).toBeGreaterThan(0)
    for (const descriptor of HARNESS_TOOL_DESCRIPTORS) {
      expect(descriptor.schemaVersion).toBe(1)
      expect(descriptor).toHaveProperty('effect')
      expect(descriptor).toHaveProperty('risk')
      expect(descriptor).toHaveProperty('scheduling')
    }
    expect(getHarnessToolDescriptor('source_test')).toMatchObject({
      effect: 'workspaceMutation',
      scheduling: 'serialByScope',
    })
  })

  it('keeps one current permission name and no live alias surface', () => {
    const notebook = getPiToolBinding('notebook_edit')
    expect(notebook.permissionName).toBe('NotebookEdit')
    expect(notebook).not.toHaveProperty('legacyIngressAliases')
    expect(notebook).not.toHaveProperty('legacyPolicyNames')
    expect(PI_TOOL_BINDINGS.some(binding => binding.piName === 'NotebookEdit')).toBe(false)
  })

  it('registers the 4 plugin management tools with correct read vs external classification', () => {
    const readOnlyIds = ['plugin_plan_install', 'plugin_status']
    const mutatingIds = ['plugin_install', 'plugin_manage']

    for (const id of readOnlyIds) {
      const descriptor = getHarnessToolDescriptor(id)
      expect(descriptor.effect).toBe('read')
      expect(descriptor.schemaVersion).toBe(1)
    }
    for (const id of mutatingIds) {
      const descriptor = getHarnessToolDescriptor(id)
      expect(descriptor.effect).toBe('externalMutation')
      expect(descriptor.mutationScope).toBe('external')
    }

    for (const id of [...readOnlyIds, ...mutatingIds]) {
      const binding = getPiToolBinding(`mcp__session__${id}`)
      expect(binding).toMatchObject({
        descriptorId: id,
        bindingName: `mcp__session__${id}`,
        handlerName: id,
      })
    }
  })

  it('binds the server-owned Goal read/control pair with explicit effects', () => {
    expect(getHarnessToolDescriptor('goal_get')).toMatchObject({ effect: 'read', risk: 'low', sandboxProfile: 'none' })
    expect(getHarnessToolDescriptor('goal')).toMatchObject({ effect: 'externalMutation', mutationScope: 'session', scheduling: 'exclusive', sandboxProfile: 'none' })
    expect(getPiToolBinding('mcp__session__GoalGet')).toMatchObject({ descriptorId: 'goal_get', bindingName: 'mcp__session__GoalGet', handlerName: 'GoalGet' })
    expect(getPiToolBinding('mcp__session__Goal')).toMatchObject({ descriptorId: 'goal', bindingName: 'mcp__session__Goal', handlerName: 'Goal' })
  })

  it('throws on unknown plugin management descriptor/binding ids (getters fail closed)', () => {
    expect(() => getHarnessToolDescriptor('plugin_uninstall')).toThrow()
    expect(() => getPiToolBinding('mcp__session__plugin_uninstall')).toThrow()
  })

  // P6.803. `worktree_batch` shipped as a BINDING with no descriptor, and the
  // only thing that noticed was `live-manifest-contract.test.ts` throwing
  // `Unknown H2 harness tool descriptor: worktree_batch` out of
  // `finalizePiExecutionManifest` — three unrelated cases died with it. The
  // relation the registry actually asserts is stated here instead, so the next
  // half-added tool fails on its own name in its own file.
  it('every binding names a descriptor that exists', () => {
    const missing = PI_TOOL_BINDINGS
      .filter(value => !HARNESS_TOOL_DESCRIPTORS.some(descriptor => descriptor.id === value.descriptorId))
      .map(value => `${value.piName} -> ${value.descriptorId}`)
    expect(missing).toEqual([])
  })

  it('classifies worktree_batch as a workspace mutation that runs code, not a cwd move', () => {
    const descriptor = getHarnessToolDescriptor('worktree_batch')
    expect(descriptor.effect).toBe('externalMutation')
    expect(descriptor.risk).toBe('codeExecution')
    expect(descriptor.scheduling).toBe('exclusive')
    // Its two siblings move THIS session's directory and are therefore
    // `mutationScope: 'session'`; the batch creates other sessions instead.
    expect(descriptor.mutationScope).toBe('workspace')
    expect(getHarnessToolDescriptor('enter_worktree').mutationScope).toBe('session')
    expect(getPiToolBinding('mcp__session__WorktreeBatch').descriptorId).toBe('worktree_batch')
  })
})
