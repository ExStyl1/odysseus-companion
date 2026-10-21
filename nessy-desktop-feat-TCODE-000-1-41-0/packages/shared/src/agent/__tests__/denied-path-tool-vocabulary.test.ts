/**
 * The `deniedPaths` floor must speak BOTH backends' vocabularies.
 *
 * `credential-read-floor.test.ts` proves WHICH paths are denied. This file
 * proves the floor is reachable AT ALL from the names and argument keys each
 * backend actually sends — the axis on which it was silently inert.
 *
 * ## What was MEASURED at HEAD before this file existed (2026-08-28, darwin)
 *
 * Through the real `shouldAllowToolInMode`, mode `default`, one run:
 *   DENIED (Claude spelling)  `Read {file_path: '~/.aws/credentials'}`,
 *     `Edit {file_path: …}`, `Write {file_path: …}`,
 *     `Glob {path: '~/.ssh'}`, `Grep {path: '~/.aws'}`
 *   OPEN   (Pi spelling — THE DEFECT)
 *     `Read {path: '~/.aws/credentials'}`, `Read {path: '~/.ssh/id_rsa'}`,
 *     `Read {path: '<proj>/.env'}`, `Edit {path: …}`, `Write {path: …}`,
 *     `Find {path: '~/.ssh'}`, `Ls {path: '~/.aws'}`
 * Identical in `bypassPermissions`, which is the mode that matters: the floor is
 * documented as holding in every mode, so "OPEN under bypass" is not a softer
 * finding than "OPEN under default".
 *
 * ## The two spellings, and why each was wrong
 *
 * 1. **Argument key.** Claude sends `file_path`; Pi's `read`/`edit`/`write`
 *    send `path` (`local-tools/runtime-backed-tools.ts`), and
 *    `requestPiPermissionReceipt` forwards the model's raw arguments, which
 *    `handlePreToolUseRequest` passes through untouched. So a floor reading only
 *    `file_path` read `undefined` for the entire Pi backend.
 * 2. **Tool name.** Pi reaches the gate under `PI_TOOL_BINDINGS`'
 *    `permissionName`: `Find` for the glob tool, `Ls` for the listing. Neither
 *    had a branch, so P3.104's container fix — a `<dir>/**` entry must deny
 *    `<dir>` itself — covered `Glob` and missed the two Pi tools that actually
 *    take a directory.
 *
 * `FILE_PATH_TOOLS` had already been widened for `Find`/`Ls` and
 * `extractFileToolTargetPath` had already been written for the `path` spelling;
 * neither reached `getDeniedPathViolation`. Pinning the floor against those two
 * existing sources of truth is the point of this file: the drift has now
 * happened twice, and a third occurrence should fail here rather than ship.
 *
 * SAFETY: every path here is DATA handed to a glob matcher. Nothing in this
 * file opens, creates or deletes a file.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { FILE_PATH_TOOLS } from '../core/pre-tool-use.ts';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { PERMISSION_MODE_ORDER } from '../mode-types.ts';
import { PI_TOOL_BINDINGS } from '../pi-harness/harness-tool-descriptor.ts';

// Same value and reason as `credential-read-floor.test.ts`: `mode-manager.ts`
// is a heavy import and bun's 5s default sits close to its resting cost.
setDefaultTimeout(30_000);

const HOME = homedir();
const PROJECT = '/tmp/nessy-denied-path-vocabulary-project';

/** A denied FILE, and an ordinary one, for the read/write/edit tools. */
const DENIED_FILE = join(HOME, '.aws', 'credentials');
const ORDINARY_FILE = join(PROJECT, 'src', 'index.ts');
/** A denied DIRECTORY, and an ordinary one, for the search/discovery tools. */
const DENIED_DIR = join(HOME, '.ssh');
const ORDINARY_DIR = join(PROJECT, 'src');

/** The argument key each tool's path arrives under, per backend. */
const FILE_TOOLS: string[] = ['Read', 'Write', 'Edit', 'MultiEdit'];
const SEARCH_TOOLS: string[] = ['Glob', 'Grep', 'Find', 'Ls'];

function denied(toolName: string, input: Record<string, unknown>, mode = 'default'): boolean {
  const result = shouldAllowToolInMode(toolName, input, mode as never);
  return result.allowed === false && result.denyPathBlocked === true;
}

describe('the floor reads both backends\' argument keys', () => {
  it.each(FILE_TOOLS)('%s denies a credential file sent as file_path (Claude)', toolName => {
    expect(denied(toolName, { file_path: DENIED_FILE })).toBe(true);
  });

  it.each(FILE_TOOLS)('%s denies a credential file sent as path (Pi)', toolName => {
    expect(denied(toolName, { path: DENIED_FILE })).toBe(true);
  });

  it('NotebookEdit denies under both notebook_path and path', () => {
    const notebook = join(HOME, '.aws', 'credentials');
    expect(denied('NotebookEdit', { notebook_path: notebook })).toBe(true);
    expect(denied('NotebookEdit', { path: notebook })).toBe(true);
  });

  it.each(FILE_TOOLS)('%s leaves an ordinary file open in BOTH spellings', toolName => {
    // Negative control for the two rows above: a floor that denied every path
    // argument would satisfy them and break every real edit.
    expect(denied(toolName, { file_path: ORDINARY_FILE })).toBe(false);
    expect(denied(toolName, { path: ORDINARY_FILE })).toBe(false);
  });
});

describe('the floor reads both backends\' tool names', () => {
  it.each(SEARCH_TOOLS)('%s cannot be rooted at a denied directory', toolName => {
    expect(denied(toolName, { pattern: '**/*', path: DENIED_DIR })).toBe(true);
  });

  it.each(SEARCH_TOOLS)('%s still searches an ordinary directory', toolName => {
    expect(denied(toolName, { pattern: '**/*', path: ORDINARY_DIR })).toBe(false);
  });
});

describe('the floor holds in every permission mode, in the Pi spelling too', () => {
  // The floor's own contract is "in ANY permission mode", and every measurement
  // that established it used the Claude spelling. bypassPermissions is the row
  // that matters: it is the mode an operator reaches for when a floor is in the
  // way, and it is exactly where a non-overridable floor must still hold.
  it.each(PERMISSION_MODE_ORDER)('denies the Pi spellings in %s', mode => {
    expect(denied('Read', { path: DENIED_FILE }, mode)).toBe(true);
    expect(denied('Write', { path: DENIED_FILE }, mode)).toBe(true);
    expect(denied('Find', { path: DENIED_DIR }, mode)).toBe(true);
    expect(denied('Ls', { path: DENIED_DIR }, mode)).toBe(true);
  });

  it('still allows ordinary work in every mode', () => {
    for (const mode of PERMISSION_MODE_ORDER) {
      expect(denied('Read', { path: ORDINARY_FILE }, mode)).toBe(false);
      expect(denied('Find', { path: ORDINARY_DIR }, mode)).toBe(false);
    }
  });
});

describe('the floor covers the same names the gate already routes', () => {
  /**
   * `FILE_PATH_TOOLS` is the set `pre-tool-use.ts` uses to decide which tools
   * carry a file path at all. A name in that set with no branch in
   * `getDeniedPathViolation` is precisely the `Find`/`Ls` defect, and pinning
   * the two together is what stops it recurring a third time.
   */
  it.each([...FILE_PATH_TOOLS] as string[])('%s is judged by the floor', toolName => {
    const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'path';
    expect(denied(toolName, { [key]: DENIED_FILE })).toBe(true);
  });

  /** Pi descriptor ids whose input carries a file path — same list as `pre-tool-use-file-tools.test.ts`. */
  const FILE_DESCRIPTOR_IDS = new Set(['read', 'write', 'edit', 'grep', 'find', 'ls', 'notebook_edit']);

  it('covers the policy name of every file-path Pi tool', () => {
    const uncovered = PI_TOOL_BINDINGS
      .filter(binding => FILE_DESCRIPTOR_IDS.has(binding.descriptorId))
      .filter(binding => {
        const key = binding.permissionName === 'NotebookEdit' ? 'notebook_path' : 'path';
        return !denied(binding.permissionName, { [key]: DENIED_FILE });
      })
      .map(binding => `${binding.descriptorId} → ${binding.permissionName}`);
    expect(uncovered).toEqual([]);
  });
});
