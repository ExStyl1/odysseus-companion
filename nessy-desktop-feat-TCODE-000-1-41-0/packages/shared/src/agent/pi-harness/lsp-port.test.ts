import { expect, test } from 'bun:test'
import { PI_LSP_INPUT_SCHEMA, projectReadyPiLspTool, type PiLspPort } from './lsp-port.ts'

const port = (status: ReturnType<PiLspPort['health']>['status']): PiLspPort => ({
  health: () => status === 'failed' ? { status, reason: 'broken' } : status === 'ready' ? { status } : { status },
  request: async () => ({}),
})

test('projects lsp only for an initialized ready host port', () => {
  expect(projectReadyPiLspTool(port('ready'))?.name).toBe('lsp')
  expect(projectReadyPiLspTool(port('unavailable'))).toBeUndefined()
  expect(projectReadyPiLspTool(port('connecting'))).toBeUndefined()
  expect(projectReadyPiLspTool(port('failed'))).toBeUndefined()
})

type LspSchemaBranch = {
  required: readonly string[]
  additionalProperties: boolean
  properties: Record<string, unknown> & { operation: { const: string } }
}

const branches = PI_LSP_INPUT_SCHEMA.oneOf as readonly LspSchemaBranch[]

function branchFor(operation: string): LspSchemaBranch {
  const branch = branches.find(candidate => candidate.properties.operation.const === operation)
  if (!branch) throw new Error(`missing schema branch for ${operation}`)
  return branch
}

test('input schema advertises the full operation set including the new breadth ops', () => {
  expect(branches.map(branch => branch.properties.operation.const)).toEqual([
    'definition', 'references', 'hover',
    'document_symbols', 'diagnostics',
    'workspace_symbols',
    'formatting', 'range_formatting', 'code_action',
  ])
})

test('input schema accepts the new op shapes with their required fields', () => {
  const formatting = branchFor('formatting')
  expect(formatting.required).toEqual(['operation', 'path'])
  expect(Object.keys(formatting.properties)).toContain('options')

  const rangeFormatting = branchFor('range_formatting')
  expect(rangeFormatting.required).toEqual(['operation', 'path', 'range'])
  expect((rangeFormatting.properties.range as { required: string[] }).required).toEqual(['start', 'end'])

  const codeAction = branchFor('code_action')
  expect(codeAction.required).toEqual(['operation', 'path', 'range'])
  expect(Object.keys(codeAction.properties)).toContain('context')

  // No stray free-form keys leak in — each branch stays closed.
  for (const branch of branches) {
    expect(branch.additionalProperties).toBe(false)
    expect(Object.keys(branch.properties)).toContain('language')
  }
})
