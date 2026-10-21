/**
 * P6.395 — the claude preset-prompt pin, and the marker that proves the binary
 * still reads it.
 *
 * The row has two halves and only this one was real. The other half — "no reader
 * on pi or claude" for an output style's `keep-coding-instructions` — is
 * REFUTED at HEAD and pinned by `prompts/__tests__/output-styles.test.ts`; see
 * the sibling assertions at the bottom of this file for the call-site half of
 * that refutation.
 */
import { describe, expect, it, setDefaultTimeout } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CLAUDE_FULL_SYSTEM_PROMPT_VALUE,
  CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR,
  buildClaudeSimpleSystemPromptEnv,
} from '../claude-simple-system-prompt.ts';

const NATIVE_BINARY = (() => {
  const sdkEntry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
  const nodeModules = sdkEntry.slice(0, sdkEntry.lastIndexOf('/@anthropic-ai/'));
  return `${nodeModules}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
})();

const inBinary = (marker: string): boolean =>
  Bun.spawnSync(['grep', '-a', '-q', '-F', '-e', marker, NATIVE_BINARY]).exitCode === 0;

const haveBinary = (): boolean => {
  try {
    return Bun.file(NATIVE_BINARY).size > 0;
  } catch {
    return false;
  }
};

/**
 * The budget belongs to the FILE, not to a case. `inBinary` scans the vendored
 * native `claude`, which is **233 073 008 bytes** at SDK `0.3.247` /
 * `claudeCodeVersion 2.1.247`, and the NEGATIVE control is the expensive half by
 * construction: a positive `grep -a -q` stops at the first hit, an absence proof
 * reads every byte. Measured 2026-09-11 on this rig (ugrep 7.8.4): the fabricated
 * spelling costs `real 4.34 / user 3.84 / sys 0.10` — CPU-bound, unlike the
 * `storage.ts` children elsewhere in this directory — and the case pays it beside
 * a positive scan and the module load, so bun's 5 s default sits INSIDE the cost
 * of the one assertion that makes the absence finding worth anything. It timed out
 * at 5002 ms with zero assertion failures while its cohort sibling, whose grep hits
 * early, passed in the same run. The budget is what keeps the negative control
 * affordable; deleting the control instead would leave a `grep` over a 233 MB
 * binary asserting almost nothing.
 */
setDefaultTimeout(120_000);

describe('buildClaudeSimpleSystemPromptEnv', () => {
  it('pins the FULL preset when the launch environment says nothing', () => {
    expect(buildClaudeSimpleSystemPromptEnv({}))
      .toEqual({ [CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR]: CLAUDE_FULL_SYSTEM_PROMPT_VALUE });
    // `'0'`, not `''`: the binary's explicitly-falsy arm is what returns "not
    // simple", and an empty string is not what that arm tests.
    expect(CLAUDE_FULL_SYSTEM_PROMPT_VALUE).toBe('0');
  });

  it('respects an operator who set either pole, and treats an empty string as unset', () => {
    // The pin is a DEFAULT. An administrator who wants the short preset gets it.
    expect(buildClaudeSimpleSystemPromptEnv({ [CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR]: '1' })).toEqual({});
    expect(buildClaudeSimpleSystemPromptEnv({ [CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR]: 'false' })).toEqual({});
    // An empty value is not a declaration — it would land on the binary's
    // `if(!e)` path rather than on either pin.
    expect(buildClaudeSimpleSystemPromptEnv({ [CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR]: '' }))
      .toEqual({ [CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR]: CLAUDE_FULL_SYSTEM_PROMPT_VALUE });
  });
});

describe('the shipped binary still reads the variable this pin sets', () => {
  it.skipIf(!haveBinary())('carries the name, and a fabricated spelling scores nothing', () => {
    // Without the positive control an absence finding here would be worthless,
    // and without the negative control a `grep -a` over a 100 MB binary can
    // match almost anything.
    expect(inBinary(CLAUDE_SIMPLE_SYSTEM_PROMPT_ENV_VAR)).toBe(true);
    expect(inBinary('CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT_LENGTH')).toBe(false);
  });

  it.skipIf(!haveBinary())('still decides by cohort when the variable is absent — the reason the pin exists', () => {
    // The decision function measured 2026-09-05 at `claudeCodeVersion 2.1.233`
    // ends `return Pad("simple_system_prompt",zo(e))`, i.e. a cohort lookup. If
    // this marker ever disappears the pin may have become unnecessary — read the
    // function again rather than assuming either way.
    expect(inBinary('simple_system_prompt')).toBe(true);
  });
});

describe('P6.395 — the OTHER half of the row is refuted: both backends do read the style flag', () => {
  const SHARED = fileURLToPath(new URL('../../prompts/system.ts', import.meta.url));
  const PI = fileURLToPath(new URL('../../agent/pi-agent.ts', import.meta.url));
  const CLAUDE = fileURLToPath(new URL('../../agent/claude-agent.ts', import.meta.url));

  /**
   * The row's evidence was `grep -arn keepCodingInstructions packages/shared/src/agent`
   * returning only `codex-agent.ts`. True, and the wrong directory: the reader
   * is one layer up, in the prompt builder BOTH backends call. These assertions
   * pin the two hops so the refutation cannot rot back into a claim.
   */
  it('the shared builder forwards the style flag into the coding-guidance filter', () => {
    const shared = readFileSync(SHARED, 'utf-8');
    expect(shared).toContain('outputStyle.keepCodingInstructions');
    expect(shared).toContain('getSafetyAndEngineeringSections(backendName, { includeCodingInstructions })');
  });

  it.each([['pi', PI], ['claude', CLAUDE]])('the %s backend composes through it with the turn\'s style id', (_name, path) => {
    const source = readFileSync(path, 'utf-8');
    expect(source).toContain('getSystemPrompt(');
    // Passing the id is what makes the flag reachable at all: `getSystemPrompt`
    // resolves `NO_OUTPUT_STYLE_COMPOSITION` without one, which keeps the
    // guidance unconditionally.
    expect(source).toContain('turnOutputStyleId');
  });
});
