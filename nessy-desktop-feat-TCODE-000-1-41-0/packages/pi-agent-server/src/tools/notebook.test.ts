import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNotebookAwareReadToolDefinition,
  createNotebookEditTool,
} from './notebook.ts';
import { textPartAt } from '../__tests__/support/tool-result-text.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nessy-notebook-'));
  tempDirs.push(dir);
  return dir;
}

function writeNotebook(path: string): void {
  writeFileSync(path, JSON.stringify({
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: ['# Title\n'],
      },
      {
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: ['print("old")\n'],
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2));
}

describe('NotebookEdit tool', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('edits a notebook cell by zero-based index', async () => {
    const cwd = makeTempDir();
    const notebookPath = join(cwd, 'analysis.ipynb');
    writeNotebook(notebookPath);

    const tool = createNotebookEditTool(cwd);
    const result = await tool.execute('toolu_notebook_edit', {
      notebook_path: 'analysis.ipynb',
      cell_index: 1,
      source: 'print("new")\n',
    }, new AbortController().signal, undefined, {} as any);

    expect(textPartAt(result.content)).toContain('Updated cell 1');
    const updated = JSON.parse(readFileSync(notebookPath, 'utf-8'));
    expect(updated.cells[1].source).toEqual(['print("new")\n']);
  });

  it('formats notebook cells when read is called on an ipynb file', async () => {
    const cwd = makeTempDir();
    writeNotebook(join(cwd, 'analysis.ipynb'));

    const readTool = createNotebookAwareReadToolDefinition(cwd);
    const result = await readTool.execute('toolu_read_notebook', {
      path: 'analysis.ipynb',
    }, new AbortController().signal, undefined, {} as any);

    const text = result.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map(part => part.text)
      .join('\n');

    expect(text).toContain('Notebook cells: 2');
    expect(text).toContain('[0] markdown');
    expect(text).toContain('# Title');
    expect(text).toContain('[1] code');
    expect(text).toContain('print("old")');
  });
});
