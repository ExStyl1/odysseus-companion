import { describe, expect, test } from 'bun:test';

import {
  MCP_OUTPUT_TOKEN_LIMIT_DEFAULT,
  MCP_OUTPUT_TOKENS_COMPAT_ENV,
  MCP_OUTPUT_TOKENS_ENV,
  MCP_OUTPUT_WARN_TOKENS,
  mcpOutputTokenLimit,
} from '../mcp-output-settings.ts';
import { resetNumericSettingReports } from '../numeric-setting.ts';

describe('mcpOutputTokenLimit', () => {
  // `mcp.md:1040` — "the default maximum is 25,000 tokens", raised (never
  // removed) via the env var.
  //
  // The spelling rule is `env-vars.md#variables`: "Numeric variables such as
  // timeouts, token budgets, and retry counts accept scientific notation and
  // digit-separator spellings in addition to plain digits, except where a
  // variable's row notes it takes plain digits only." The
  // `MAX_MCP_OUTPUT_TOKENS` row notes NO such restriction, so the general rule
  // governs here — unlike the subagent-depth knob, whose row does note it, and
  // which is why these two no longer share one reader.
  test.each([
    [undefined, MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
    ['50000', 50_000],
    [' 50000 ', 50_000],
    ['1', 1],
    // No disable value: 0 and negatives fall back, never mean "unlimited".
    ['0', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
    ['-1', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
    // Scientific notation and separators RESOLVE — "Claude Code reads `2e3` as
    // 2000 and `64_000` as 64000".
    ['5e4', 50_000],
    ['50_000', 50_000],
    ['2.5e4', 25_000], // a float spelling whose value is a whole number
    // Hex, signs and a non-integer float stay refused: the page's example set
    // is scientific notation and separators, and widening past it is inventing.
    ['0x20', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
    ['2.5', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
    ['+3', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
    ['1__0', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT], // doubled separator
    ['_1000', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT], // leading separator
    ['1000_', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT], // trailing separator
    ['abc', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
    ['', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
    ['  ', MCP_OUTPUT_TOKEN_LIMIT_DEFAULT],
  ])('NESSY_MCP_OUTPUT_TOKENS=%p -> %p', (value, expected) => {
    const env = value === undefined ? {} : { [MCP_OUTPUT_TOKENS_ENV]: value };
    // Silent sink: the table exercises the VALUES, and the default sink is
    // `console.warn`, which would print thirty lines on every green run.
    expect(mcpOutputTokenLimit(env, () => {})).toBe(expected);
  });

  test('accepts the documented Claude spelling MAX_MCP_OUTPUT_TOKENS as a compat alias', () => {
    expect(mcpOutputTokenLimit({ [MCP_OUTPUT_TOKENS_COMPAT_ENV]: '40000' })).toBe(40_000);
  });

  test('the Nessy spelling wins when both are set, even when it is invalid', () => {
    expect(mcpOutputTokenLimit({
      [MCP_OUTPUT_TOKENS_ENV]: '30000',
      [MCP_OUTPUT_TOKENS_COMPAT_ENV]: '40000',
    })).toBe(30_000);
    // Defined-but-malformed Nessy value shadows the alias and falls back to the
    // default — the subagent-spawn-depth aliased-pair discipline.
    expect(mcpOutputTokenLimit({
      [MCP_OUTPUT_TOKENS_ENV]: 'nope',
      [MCP_OUTPUT_TOKENS_COMPAT_ENV]: '40000',
    }, () => {})).toBe(MCP_OUTPUT_TOKEN_LIMIT_DEFAULT);
  });

  test('a refused value is SAID, not swallowed — and said once', () => {
    resetNumericSettingReports();
    const said: string[] = [];
    expect(mcpOutputTokenLimit({ [MCP_OUTPUT_TOKENS_ENV]: '0x20' }, m => { said.push(m); }))
      .toBe(MCP_OUTPUT_TOKEN_LIMIT_DEFAULT);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(MCP_OUTPUT_TOKENS_ENV);
    expect(said[0]).toContain('0x20');
    expect(said[0]).toContain(String(MCP_OUTPUT_TOKEN_LIMIT_DEFAULT));
    // Read on a per-tool-call path: the same complaint a thousand times is
    // noise, not a report.
    mcpOutputTokenLimit({ [MCP_OUTPUT_TOKENS_ENV]: '0x20' }, m => { said.push(m); });
    expect(said).toHaveLength(1);
  });

  test('an unset or empty value is not a mistake and says nothing', () => {
    resetNumericSettingReports();
    const said: string[] = [];
    mcpOutputTokenLimit({}, m => { said.push(m); });
    mcpOutputTokenLimit({ [MCP_OUTPUT_TOKENS_ENV]: '' }, m => { said.push(m); });
    mcpOutputTokenLimit({ [MCP_OUTPUT_TOKENS_ENV]: '   ' }, m => { said.push(m); });
    expect(said).toEqual([]);
  });

  test('documented constants: 25,000-token default and a FIXED 10,000-token warning', () => {
    expect(MCP_OUTPUT_TOKEN_LIMIT_DEFAULT).toBe(25_000);
    // `mcp.md:246` — "the warning threshold is fixed". No env spelling moves it.
    expect(MCP_OUTPUT_WARN_TOKENS).toBe(10_000);
    expect(mcpOutputTokenLimit({ NESSY_MCP_OUTPUT_WARN_TOKENS: '1' })).toBe(MCP_OUTPUT_TOKEN_LIMIT_DEFAULT);
  });
});
