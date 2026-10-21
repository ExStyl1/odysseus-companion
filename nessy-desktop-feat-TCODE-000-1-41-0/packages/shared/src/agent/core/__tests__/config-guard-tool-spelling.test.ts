import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PI_TOOL_BINDINGS } from '../../pi-harness/harness-tool-descriptor.ts';
import { CONFIG_WRITE_TOOLS, normalizedEdits, toolTargetPath, validateConfigWrite } from '../pre-tool-use.ts';

/**
 * `runPreToolUseChecks` receives the RAW subprocess payload — `pi-agent.ts`
 * passes `input` straight through, and the `path`→`file_path` normalisation in
 * `backend/pi/event-adapter.ts:990` is a separate, display-facing path this gate
 * never sees. Both config guards read `input.file_path` only, so on the shipped
 * Pi backend they read `undefined` and returned "allow".
 *
 * These pin the gate against the payload it actually receives.
 */
describe('config guards read the payload the shipped backend sends', () => {
  const withWorkspace = (run: (root: string) => void): void => {
    const root = mkdtempSync(join(tmpdir(), 'config-guard-'));
    try {
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  // `statuses/config.json` relative to the workspace root — see
  // `config/validators.ts:2123`. Malformed JSON so the rejection cannot be
  // mistaken for a schema quirk.
  const STATUSES = 'statuses/config.json';
  const INVALID_STATUSES = '{ "statuses": [ ';

  it('blocks an invalid config Write addressed with Pi\'s `path`', () => {
    withWorkspace(root => {
      const result = validateConfigWrite(
        'Write',
        { path: join(root, STATUSES), content: INVALID_STATUSES },
        root,
      );
      expect(result.valid).toBe(false);
    });
  });

  it('blocks the same write addressed with Claude\'s `file_path`', () => {
    withWorkspace(root => {
      const result = validateConfigWrite(
        'Write',
        { file_path: join(root, STATUSES), content: INVALID_STATUSES },
        root,
      );
      expect(result.valid).toBe(false);
    });
  });

  it('refuses an Edit whose replacement shape it cannot read', () => {
    // The old code read `input.old_string` unconditionally; `undefined` handed to
    // String.replace returns the file unchanged, so the CURRENT valid content was
    // validated and a corrupting edit passed. Refusing is the fail-closed answer.
    withWorkspace(root => {
      const file = join(root, STATUSES);
      mkdirSync(join(root, 'statuses'), { recursive: true });
      writeFileSync(file, '{"statuses": []}');

      const result = validateConfigWrite('Edit', { path: file, mystery: 'shape' }, root);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('could not be read');
    });
  });

  it('applies every edit in a Pi `edits[]` array, not just the first', () => {
    withWorkspace(root => {
      const file = join(root, STATUSES);
      mkdirSync(join(root, 'statuses'), { recursive: true });
      writeFileSync(file, '{"statuses": [], "filler": "KEEP"}');

      // The first edit is harmless; the SECOND corrupts. Validating only the
      // first would let this through.
      const result = validateConfigWrite('Edit', {
        path: file,
        edits: [
          { oldText: 'KEEP', newText: 'STILL_FINE' },
          { oldText: '{"statuses"', newText: '{ BROKEN "statuses"' },
        ],
      }, root);

      expect(result.valid).toBe(false);
    });
  });

  it('leaves a non-config file alone in either spelling', () => {
    withWorkspace(root => {
      for (const key of ['path', 'file_path']) {
        const result = validateConfigWrite(
          'Write',
          { [key]: join(root, 'src', 'index.ts'), content: 'anything' },
          root,
        );
        expect(result.valid).toBe(true);
      }
    });
  });

  it('pins CONFIG_WRITE_TOOLS against the policy names the gate receives', () => {
    // The gate is keyed on the POLICY name — `PI_TOOL_BINDINGS`' `permissionName`.
    // A renamed or added write tool must fail here rather than quietly losing its
    // config guard, the way `FILE_PATH_TOOLS` lost `Find` and `Ls`.
    const writeDescriptors = new Set(['write', 'edit']);
    const missing = PI_TOOL_BINDINGS
      .filter(binding => writeDescriptors.has(binding.descriptorId))
      .filter(binding => !CONFIG_WRITE_TOOLS.has(binding.permissionName))
      .map(binding => `${binding.descriptorId} → ${binding.permissionName}`);
    expect(missing).toEqual([]);
  });
});

describe('the shared readers', () => {
  it('prefers file_path, falls back to path, and ignores blanks', () => {
    expect(toolTargetPath({ file_path: '/a', path: '/b' })).toBe('/a');
    expect(toolTargetPath({ path: '/b' })).toBe('/b');
    expect(toolTargetPath({ file_path: '   ' })).toBeUndefined();
    expect(toolTargetPath({})).toBeUndefined();
  });

  it('reads both edit spellings and refuses a shape it cannot parse', () => {
    expect(normalizedEdits({ old_string: 'a', new_string: 'b' }))
      .toEqual([{ oldString: 'a', newString: 'b' }]);
    expect(normalizedEdits({ edits: [{ oldText: 'a', newText: 'b' }] }))
      .toEqual([{ oldString: 'a', newString: 'b' }]);
    expect(normalizedEdits({ edits: [{ oldText: 'a' }] })).toBeUndefined();
    expect(normalizedEdits({ edits: [] })).toBeUndefined();
    expect(normalizedEdits({})).toBeUndefined();
  });
});
