import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applySystemPromptOverride } from './system-prompt-override.ts';

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'fixtures') continue;
      files.push(...productionTypeScriptFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('applySystemPromptOverride', () => {
  it('updates only the adapter-owned public prompt controller', () => {
    const prompts: string[] = [];
    applySystemPromptOverride({ setSystemPrompt: prompt => prompts.push(prompt) }, 'FIRST');
    applySystemPromptOverride({ setSystemPrompt: prompt => prompts.push(prompt) }, 'SECOND');
    expect(prompts).toEqual(['FIRST', 'SECOND']);
  });

  it('contains no private Pi prompt fields anywhere in production pi-agent-server source', () => {
    const srcRoot = dirname(fileURLToPath(import.meta.url));
    const offenders = productionTypeScriptFiles(srcRoot).flatMap(path => {
      const source = readFileSync(path, 'utf8');
      return ['_baseSystemPrompt', '_rebuildSystemPrompt', 'agent.state.systemPrompt']
        .filter(marker => source.includes(marker))
        .map(marker => `${path}:${marker}`);
    });
    expect(offenders).toEqual([]);
  });
});
