/**
 * @license
 * Copyright 2025 Nessy
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { processToolCallText, ToolCallStreamParser } from './index.js';

describe('toolCallParser', () => {
  describe('processToolCallText', () => {
    describe('malformed tool call tags', () => {
      it('parses malformed tool call with duplicate opening tag instead of closing', () => {
        const input = `Теперь проверю...
<tool_call>
{"name": "glob", "arguments": {"pattern": "**/*memory*", "path": "/some/path"}}
<tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('glob');
        expect(result.functionCalls[0].args).toEqual({
          pattern: '**/*memory*',
          path: '/some/path',
        });
        expect(result.content).toContain('Теперь проверю...');
      });

      it('parses tool call with single opening tag and no closing', () => {
        const input = `Some text before
<tool_call>
{"name": "read_file", "arguments": {"file_path": "/test/file.ts"}}`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('read_file');
        expect(result.functionCalls[0].args).toEqual({
          file_path: '/test/file.ts',
        });
        expect(result.content).toContain('Some text before');
      });

      it('parses multiple malformed tool calls with duplicate opening tags', () => {
        const input = `First action:
<tool_call>
{"name": "glob", "arguments": {"pattern": "*.ts"}}
<tool_call>
{"name": "grep", "arguments": {"pattern": "TODO"}}
<tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(2);
        expect(result.functionCalls[0].name).toBe('glob');
        expect(result.functionCalls[1].name).toBe('grep');
      });

      it('handles empty payload between malformed tags', () => {
        const input = `<tool_call>
<tool_call>
{"name": "bash", "arguments": {"command": "ls"}}
<tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('bash');
      });

      it('still prefers proper closing tags when available', () => {
        const input = `<tool_call>
{"name": "read_file", "arguments": {"file_path": "/test.ts"}}
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('read_file');
      });
    });

    describe('broken JSON with extra closing braces', () => {
      it('parses tool call with extra closing brace in JSON', () => {
        const input = `Now let me check how the draft data is loaded and processed:
<tool_call>
{"name": "glob", "pattern": "**/draft*/*Loader*"}}
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('glob');
        expect(result.functionCalls[0].args).toEqual({
          pattern: '**/draft*/*Loader*',
        });
      });

      it('parses tool call with double extra closing braces', () => {
        const input = `<tool_call>
{"name": "read_file", "arguments": {"file_path": "/test/file.ts"}}}}
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('read_file');
      });

      it('parses tool call with arguments key and extra brace', () => {
        const input = `<tool_call>
{"name": "grep", "arguments": {"pattern": "TODO", "path": "/src"}}}}
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('grep');
      });
    });

    describe('properly formatted tool calls', () => {
      it('sanitizes polluted OpenAI-style function names', () => {
        const parser = new ToolCallStreamParser();
        const input = JSON.stringify({
          tool_calls: [
            {
              id: 'call_ae12825a063e42a382951430',
              type: 'function',
              function: {
                name: 'agent\n</parameter',
                arguments: JSON.stringify({
                  description: 'Create parallel postmortem analysis workflow',
                  prompt: 'Create a comprehensive parallel agent workflow',
                  subagent_type: 'general-purpose',
                }),
              },
            },
          ],
        });

        const result = parser.parseChunk(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('agent');
        expect(result.functionCalls[0].args).toEqual({
          description: 'Create parallel postmortem analysis workflow',
          prompt: 'Create a comprehensive parallel agent workflow',
          subagent_type: 'general-purpose',
        });
      });

      it('parses standard tool call with proper closing tag', () => {
        const input = `<tool_call>
{"name": "glob", "arguments": {"pattern": "**/*.ts"}}
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('glob');
      });

      it('parses tool call with content before and after', () => {
        const input = `Let me check the files.
<tool_call>
{"name": "glob", "arguments": {"pattern": "src/**/*.ts"}}
</tool_call>
After the tool call.`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.content).toContain('Let me check the files.');
        expect(result.content).toContain('After the tool call.');
      });

      it('parses multiple tool calls with proper tags', () => {
        const input = `<tool_call>
{"name": "glob", "arguments": {"pattern": "*.ts"}}
</tool_call>
<tool_call>
{"name": "grep", "arguments": {"pattern": "function"}}
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(2);
        expect(result.functionCalls[0].name).toBe('glob');
        expect(result.functionCalls[1].name).toBe('grep');
      });
    });

    describe('broken mixed XML/JSON tool call payloads', () => {
      it('parses broken {"name="tool_name> with <parameter=key> args', () => {
        const input = `<tool_call>
{"name="mcp__fs__get_file_info>
<parameter=path>
C:\\Users\\username\\workspace\\Analisys\\package.json
</parameter>
</function>
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('mcp__fs__get_file_info');
        expect(result.functionCalls[0].args).toEqual({
          path: 'C:\\Users\\username\\workspace\\Analisys\\package.json',
        });
      });

      it('parses broken format with multiple parameters', () => {
        const input = `<tool_call>
{"name="mcp__fs__write_file>
<parameter=path>/tmp/out.txt</parameter>
<parameter=content>hello world</parameter>
</function>
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('mcp__fs__write_file');
        expect(result.functionCalls[0].args).toEqual({
          path: '/tmp/out.txt',
          content: 'hello world',
        });
      });

      it('preserves content before a broken tool call', () => {
        const input = `Some text before.
<tool_call>
{"name="mcp__fs__get_file_info>
<parameter=path>/some/file</parameter>
</function>
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('mcp__fs__get_file_info');
        expect(result.content).toContain('Some text before.');
      });
    });

    describe('plain text without tool calls', () => {
      it('returns text as content when no tool tags present', () => {
        const input = 'Just some plain text without any tool calls.';
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(0);
        expect(result.content).toBe(input);
      });

      it('handles empty string', () => {
        const result = processToolCallText('');
        expect(result.functionCalls).toHaveLength(0);
        expect(result.content).toBe('');
      });
    });

    describe('named tag tool calls (<tool_name>{json}</tool_name>)', () => {
      it('parses single named tag with JSON body', () => {
        const input = `<todo_write>{"todos": [{"id": "t1", "subject": "Fix bug", "status": "pending"}]}</todo_write>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('todo_write');
        expect(result.functionCalls[0].args).toEqual({
          todos: [{ id: 't1', subject: 'Fix bug', status: 'pending' }],
        });
      });

      it('parses read_file named tag', () => {
        const input = `<read_file>{"path": "/src/index.ts"}</read_file>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('read_file');
        expect(result.functionCalls[0].args).toEqual({ path: '/src/index.ts' });
      });

      it('parses named tag with text before and after', () => {
        const input = `Let me write the todos now.
<todo_write>{"todos": [{"id": "1", "subject": "Test"}]}</todo_write>
Done with the update.`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('todo_write');
        expect(result.content).toContain('Let me write the todos now.');
        expect(result.content).toContain('Done with the update.');
      });

      it('parses multiple named tags in one response', () => {
        const input = `<glob>{"pattern": "**/*.ts"}</glob>
<grep>{"pattern": "TODO", "path": "/src"}</grep>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(2);
        expect(result.functionCalls[0].name).toBe('glob');
        expect(result.functionCalls[1].name).toBe('grep');
      });

      it('does not crash on malformed JSON inside named tag', () => {
        const input = `<todo_write>{malformed json here}</todo_write>`;
        const result = processToolCallText(input);
        // safeJsonParse with jsonrepair may or may not recover this;
        // the important thing is it doesn't throw
        expect(result).toBeDefined();
      });

      it('ignores named tags with non-JSON body', () => {
        const input = `<div>Some HTML content here</div>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(0);
        expect(result.content).toBe(input);
      });

      it('parses named tag with whitespace around JSON body', () => {
        const input = `<bash>
  { "command": "ls -la" }
</bash>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('bash');
        expect(result.functionCalls[0].args).toEqual({ command: 'ls -la' });
      });
    });

    describe('equals-sign instead of colon in name field', () => {
      it('parses tool call with "name=" instead of "name":', () => {
        const input = `<tool_call>
{"name="mcp__time__send-message","arguments":{"peer":"v.n.gusev","text":"Это пробное сообщение."}}
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('mcp__time__send-message');
        expect(result.functionCalls[0].args).toEqual({
          peer: 'v.n.gusev',
          text: 'Это пробное сообщение.',
        });
      });

      it('parses malformed name= with no closing tool_call tag', () => {
        const input = `<tool_call>
{"name="glob","arguments":{"pattern":"**/*.ts"}}`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('glob');
        expect(result.functionCalls[0].args).toEqual({ pattern: '**/*.ts' });
      });

      it('extracts content before tool_call with equals-sign name', () => {
        const input = `Отправляю сообщение.
<tool_call>
{"name="mcp__send","arguments":{"text":"hello"}}
</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('mcp__send');
        expect(result.content).toContain('Отправляю сообщение.');
      });

      it('parses hybrid: equals-sign name with parameter tags', () => {
        const input = `<tool_call>\n{"name="mcp__time__send-message"}\n<parameter=peer>\nv.n.gusev\n</parameter>\n<parameter=text>\nПробное сообщение от Nessy CLI.\n</parameter>\n</function>\n</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('mcp__time__send-message');
        expect(result.functionCalls[0].args).toEqual({
          peer: 'v.n.gusev',
          text: 'Пробное сообщение от Nessy CLI.',
        });
      });
    });

    describe('broken function= with parameter tags', () => {
      it('parses <function=tool_name,"arguments":{...}> inline arguments', () => {
        const input =
          '<tool_call>\n<function=skill,"arguments":{"skill":"my-t-autoreview"}}\n</tool_call>';
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('skill');
        expect(result.functionCalls[0].args).toEqual({
          skill: 'my-t-autoreview',
        });
      });

      it('parses {"function=tool_name> with parameter tags', () => {
        const input = `<tool_call>\n{"function=run_shell_command>\n<parameter=command>\ncd rowi-ui && git reset HEAD~1 && git status\n</parameter>\n<parameter=description>\nReset submodule commit\n</parameter>\n<parameter=is_background>\nFalse\n</parameter>\n</function>\n</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('run_shell_command');
        expect(result.functionCalls[0].args).toEqual({
          command: 'cd rowi-ui && git reset HEAD~1 && git status',
          description: 'Reset submodule commit',
          is_background: 'False',
        });
      });

      it('parses {"function=tool_name> without closing </tool_call>', () => {
        const input = `<tool_call>\n{"function=read_file>\n<parameter=path>\n/some/file.ts\n</parameter>\n</function>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('read_file');
        expect(result.functionCalls[0].args).toEqual({
          path: '/some/file.ts',
        });
      });

      it('extracts content before broken function= tool call', () => {
        const input = `Выполняю команду.\n<tool_call>\n{"function=bash>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('bash');
        expect(result.content).toContain('Выполняю команду.');
      });
    });

    describe('broken name:value> with parameter tags', () => {
      it('parses {"name":"read_file> with quoted parameter keys', () => {
        const input = `<tool_call>\n{"name":"read_file>\n<parameter="file_path">/Users/v.osovskiy/WebstormProjects/crypto-terminal/CLAUDE.md\n</parameter></function>\n</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('read_file');
        expect(result.functionCalls[0].args).toEqual({
          file_path:
            '/Users/v.osovskiy/WebstormProjects/crypto-terminal/CLAUDE.md',
        });
      });

      it('parses {"name":"glob> with unquoted parameter keys', () => {
        const input = `<tool_call>\n{"name":"glob>\n<parameter=pattern>**/*.ts\n</parameter></function>\n</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('glob');
        expect(result.functionCalls[0].args).toEqual({
          pattern: '**/*.ts',
        });
      });

      it('parses with content before the tool call', () => {
        const input = `Читаю файл.\n<tool_call>\n{"name":"read_file>\n<parameter="file_path">/tmp/test.md\n</parameter></function>\n</tool_call>`;
        const result = processToolCallText(input);
        expect(result.functionCalls).toHaveLength(1);
        expect(result.functionCalls[0].name).toBe('read_file');
        expect(result.content).toContain('Читаю файл.');
      });
    });
  });
});
