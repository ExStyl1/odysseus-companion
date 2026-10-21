import { readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import {
  createReadToolDefinition,
  type AgentToolResult,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

interface NotebookCell {
  cell_type?: unknown;
  source?: unknown;
  outputs?: unknown;
  [key: string]: unknown;
}

interface NotebookDocument {
  cells: NotebookCell[];
  [key: string]: unknown;
}

interface NotebookEditInput {
  notebook_path?: string;
  cell_index?: number;
  source?: string;
}

export interface NotebookEditDetails {
  notebookPath?: string;
  cellIndex?: number;
  cellType?: string;
  isError?: boolean;
  error?: string;
}

function resolveNotebookPath(cwd: string, path: string): string {
  const absolutePath = isAbsolute(path) ? path : resolve(cwd, path);
  if (extname(absolutePath).toLowerCase() !== '.ipynb') {
    throw new Error('NotebookEdit only supports .ipynb files.');
  }
  return absolutePath;
}

function isNotebookDocument(value: unknown): value is NotebookDocument {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as { cells?: unknown }).cells);
}

async function readNotebook(path: string): Promise<NotebookDocument> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (!isNotebookDocument(parsed)) {
    throw new Error('Invalid notebook: expected a JSON object with a cells array.');
  }
  return parsed;
}

function sourceToText(source: unknown): string {
  if (Array.isArray(source)) {
    return source.map(part => typeof part === 'string' ? part : String(part)).join('');
  }
  if (typeof source === 'string') return source;
  if (source === undefined || source === null) return '';
  return String(source);
}

function splitSourceLines(source: string): string[] {
  if (source.length === 0) return [];
  return source.match(/[^\n]*\n|[^\n]+/g) ?? [source];
}

function sourceForExistingCell(existingSource: unknown, source: string): string | string[] {
  return Array.isArray(existingSource) ? splitSourceLines(source) : source;
}

function formatNotebookCells(path: string, notebook: NotebookDocument): string {
  const lines = [
    `Notebook: ${path}`,
    `Notebook cells: ${notebook.cells.length}`,
  ];

  notebook.cells.forEach((cell, index) => {
    const cellType = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown';
    const source = sourceToText(cell.source).trimEnd();
    lines.push('', `[${index}] ${cellType}`, source || '(empty)');

    if (Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      lines.push(`outputs: ${cell.outputs.length}`);
    }
  });

  return lines.join('\n');
}

function applyLineWindow(text: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return text;

  const lines = text.split('\n');
  const start = offset === undefined ? 0 : Math.max(0, Math.floor(offset) - 1);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + Math.max(0, Math.floor(limit)));
  return lines.slice(start, end).join('\n');
}

function textResult(text: string, details: NotebookEditDetails = {}): AgentToolResult<NotebookEditDetails> {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function errorResult(message: string): AgentToolResult<NotebookEditDetails> {
  return textResult(message, {
    isError: true,
    error: message,
  });
}

export function createNotebookAwareReadToolDefinition(cwd: string): ToolDefinition<any, any> {
  const base = createReadToolDefinition(cwd) as ToolDefinition<any, any>;

  return {
    ...base,
    description: `${base.description} For .ipynb notebooks, returns a cell-indexed view instead of raw JSON.`,
    promptSnippet: `${base.promptSnippet}; for .ipynb files, shows notebook cells by index`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { path?: unknown; offset?: number; limit?: number };
      if (typeof input.path !== 'string' || extname(input.path).toLowerCase() !== '.ipynb') {
        return base.execute(toolCallId, params, signal, onUpdate, ctx);
      }

      if (signal?.aborted) {
        throw new Error('Operation aborted');
      }

      const absolutePath = resolveNotebookPath(cwd, input.path);
      const notebook = await readNotebook(absolutePath);
      const text = applyLineWindow(formatNotebookCells(input.path, notebook), input.offset, input.limit);
      return {
        content: [{ type: 'text', text }],
        details: undefined,
      };
    },
  };
}

export function createNotebookEditTool(cwd: string): ToolDefinition<NotebookEditInput, NotebookEditDetails> {
  return {
    name: 'NotebookEdit',
    label: 'NotebookEdit',
    description: 'Edit the source of an existing Jupyter notebook cell by zero-based index.',
    promptSnippet: 'Use NotebookEdit to modify one existing .ipynb cell by zero-based cell_index. Pass notebook_path, cell_index, and source.',
    promptGuidelines: [
      'Read the notebook first to inspect cell indexes.',
      'Use source for the complete replacement content of that cell.',
    ],
    parameters: {
      type: 'object',
      required: ['notebook_path', 'cell_index', 'source'],
      additionalProperties: false,
      properties: {
        notebook_path: {
          type: 'string',
          description: 'Path to the .ipynb notebook file.',
        },
        cell_index: {
          type: 'integer',
          minimum: 0,
          description: 'Zero-based index of the cell to replace.',
        },
        source: {
          type: 'string',
          description: 'Complete replacement source for the target cell.',
        },
      },
    } as any,
    prepareArguments: args => args as NotebookEditInput,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<NotebookEditDetails>> {
      try {
        const input = params as NotebookEditInput;
        if (signal?.aborted) {
          return errorResult('NotebookEdit was aborted before start.');
        }

        const notebookPath = typeof input.notebook_path === 'string' ? input.notebook_path.trim() : '';
        const cellIndex: number = typeof input.cell_index === 'number' && Number.isInteger(input.cell_index)
          ? input.cell_index
          : -1;
        const source = typeof input.source === 'string' ? input.source : '';

        if (!notebookPath) {
          return errorResult('NotebookEdit requires notebook_path.');
        }
        if (cellIndex < 0) {
          return errorResult('NotebookEdit requires a non-negative integer cell_index.');
        }

        const absolutePath = resolveNotebookPath(cwd, notebookPath);
        const notebook = await readNotebook(absolutePath);
        const cell = notebook.cells[cellIndex];
        if (!cell) {
          return errorResult(`NotebookEdit cell_index ${cellIndex} is out of range (${notebook.cells.length} cells).`);
        }

        cell.source = sourceForExistingCell(cell.source, source);
        await writeFile(absolutePath, `${JSON.stringify(notebook, null, 2)}\n`, 'utf-8');

        const cellType = typeof cell.cell_type === 'string' ? cell.cell_type : 'unknown';
        return textResult(`Updated cell ${cellIndex} in ${notebookPath}.`, {
          notebookPath,
          cellIndex,
          cellType,
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
