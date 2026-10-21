const LSP_POSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['line', 'character'],
  properties: {
    line: { type: 'integer', minimum: 0 },
    character: { type: 'integer', minimum: 0 },
  },
} as const

const LSP_RANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: {
    start: LSP_POSITION_SCHEMA,
    end: LSP_POSITION_SCHEMA,
  },
} as const

export const PI_LSP_INPUT_SCHEMA = Object.freeze({
  oneOf: [
    ...(['definition', 'references', 'hover'] as const).map(operation => ({
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'path', 'line', 'character'],
      properties: {
        operation: { const: operation },
        path: { type: 'string', minLength: 1 },
        line: { type: 'integer', minimum: 0 },
        character: { type: 'integer', minimum: 0 },
        language: { type: 'string', minLength: 1 },
      },
    })),
    ...(['document_symbols', 'diagnostics'] as const).map(operation => ({
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'path'],
      properties: {
        operation: { const: operation },
        path: { type: 'string', minLength: 1 },
        language: { type: 'string', minLength: 1 },
      },
    })),
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'query'],
      properties: {
        operation: { const: 'workspace_symbols' },
        query: { type: 'string', maxLength: 256 },
        language: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'path'],
      properties: {
        operation: { const: 'formatting' },
        path: { type: 'string', minLength: 1 },
        options: { type: 'object' },
        language: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'path', 'range'],
      properties: {
        operation: { const: 'range_formatting' },
        path: { type: 'string', minLength: 1 },
        range: LSP_RANGE_SCHEMA,
        options: { type: 'object' },
        language: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'path', 'range'],
      properties: {
        operation: { const: 'code_action' },
        path: { type: 'string', minLength: 1 },
        range: LSP_RANGE_SCHEMA,
        context: { type: 'object' },
        language: { type: 'string', minLength: 1 },
      },
    },
  ],
} as const)

export type PiLspRange = {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export type PiLspRequest =
  | { operation: 'definition' | 'references' | 'hover'; path: string; line: number; character: number; language?: string }
  | { operation: 'document_symbols' | 'diagnostics'; path: string; language?: string }
  | { operation: 'workspace_symbols'; query: string; language?: string }
  | { operation: 'formatting'; path: string; options?: Record<string, unknown>; language?: string }
  | { operation: 'range_formatting'; path: string; range: PiLspRange; options?: Record<string, unknown>; language?: string }
  | { operation: 'code_action'; path: string; range: PiLspRange; context?: Record<string, unknown>; language?: string }

/** A pushed `textDocument/publishDiagnostics` notification, surfaced fail-soft. */
export type PiLspDiagnosticsNotification = { uri: string; diagnostics: unknown[] }

export type PiLspHealth =
  | { status: 'unavailable' | 'connecting'; reason?: string }
  | { status: 'ready' }
  | { status: 'failed'; reason: string }

export interface PiLspPort {
  health(): PiLspHealth
  request(input: PiLspRequest, signal: AbortSignal): Promise<unknown>
  /**
   * Optional subscription to pushed `textDocument/publishDiagnostics`
   * notifications. Present when the host owner buffers pushed diagnostics; the
   * buffered set is also merged into the `diagnostics` pull operation so a port
   * without this member still surfaces pushed diagnostics on the next pull.
   */
  onDiagnostics?(listener: (notification: PiLspDiagnosticsNotification) => void): () => void
}

export function projectReadyPiLspTool(port: PiLspPort | undefined): {
  name: 'lsp'
  description: string
  inputSchema: typeof PI_LSP_INPUT_SCHEMA
} | undefined {
  if (port?.health().status !== 'ready') return undefined
  return {
    name: 'lsp',
    description: 'Query the ready workspace language server for bounded code intelligence: definition, references, hover, document_symbols, workspace_symbols, diagnostics, formatting, range_formatting, and code_action.',
    inputSchema: PI_LSP_INPUT_SCHEMA,
  }
}
