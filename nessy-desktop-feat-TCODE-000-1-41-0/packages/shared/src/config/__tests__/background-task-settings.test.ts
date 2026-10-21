import { describe, expect, test } from 'bun:test';

import {
  backgroundTasksDisabled,
  commandRunsGit,
  isSleepPrefixedCommand,
  isUnparseableCompoundCommand,
  MCP_AUTO_BACKGROUND_DEFAULT_MS,
  mcpAutoBackgroundDelayMs,
  resolveBashTimeoutBehavior,
} from '../background-task-settings.ts';

describe('backgroundTasksDisabled', () => {
  test.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    [' 1 ', true],
    ['0', false],
    ['false', false],
    ['', false],
    [undefined, false],
  ])('NESSY_DISABLE_BACKGROUND_TASKS=%p -> %p', (value, expected) => {
    const env = value === undefined ? {} : { NESSY_DISABLE_BACKGROUND_TASKS: value };
    expect(backgroundTasksDisabled(env)).toBe(expected);
  });
});

describe('isSleepPrefixedCommand', () => {
  test.each([
    ['sleep 60', true],
    ['  sleep 60', true],
    ['sleep 5 && echo done', true],
    ['sleep', true],
    ['sleep60', false],
    ['sleeper 5', false],
    ['echo sleep', false],
    ['', false],
  ])('%p -> %p', (command, expected) => {
    expect(isSleepPrefixedCommand(command)).toBe(expected);
  });
});

describe('mcpAutoBackgroundDelayMs', () => {
  test('main conversation, interactive, no env -> the documented 120000 default', () => {
    expect(mcpAutoBackgroundDelayMs({ env: {} })).toBe(120_000);
    expect(MCP_AUTO_BACKGROUND_DEFAULT_MS).toBe(120_000);
  });

  test('NESSY_MCP_AUTO_BACKGROUND_MS overrides the threshold', () => {
    expect(mcpAutoBackgroundDelayMs({ env: { NESSY_MCP_AUTO_BACKGROUND_MS: '1000' } })).toBe(1_000);
  });

  test('0 turns automatic backgrounding off', () => {
    expect(mcpAutoBackgroundDelayMs({ env: { NESSY_MCP_AUTO_BACKGROUND_MS: '0' } })).toBeNull();
  });

  test('the disable switch turns it off regardless of the threshold', () => {
    expect(mcpAutoBackgroundDelayMs({
      env: { NESSY_DISABLE_BACKGROUND_TASKS: '1', NESSY_MCP_AUTO_BACKGROUND_MS: '1000' },
    })).toBeNull();
  });

  test('subagent sessions never detach', () => {
    expect(mcpAutoBackgroundDelayMs({ sessionDepth: 1, env: {} })).toBeNull();
    expect(mcpAutoBackgroundDelayMs({ sessionDepth: 2, env: {} })).toBeNull();
  });

  test('headless is off by default and on with NESSY_AUTO_BACKGROUND_TASKS=1', () => {
    expect(mcpAutoBackgroundDelayMs({ isHeadless: true, env: {} })).toBeNull();
    expect(mcpAutoBackgroundDelayMs({ isHeadless: true, env: { NESSY_AUTO_BACKGROUND_TASKS: '1' } }))
      .toBe(120_000);
  });

  test('a malformed threshold falls back to the default', () => {
    expect(mcpAutoBackgroundDelayMs({ env: { NESSY_MCP_AUTO_BACKGROUND_MS: 'soon' } })).toBe(120_000);
    expect(mcpAutoBackgroundDelayMs({ env: { NESSY_MCP_AUTO_BACKGROUND_MS: '-5' } })).toBe(120_000);
  });
});

describe('resolveBashTimeoutBehavior', () => {
  test('an ordinary bash command auto-backgrounds on timeout', () => {
    expect(resolveBashTimeoutBehavior({ semanticId: 'bash', command: 'bun run build', env: {} }))
      .toBe('background');
  });

  test('a sleep-prefixed command is never auto-backgrounded', () => {
    expect(resolveBashTimeoutBehavior({ semanticId: 'bash', command: 'sleep 60', env: {} }))
      .toBe('kill');
  });

  test('the disable switch forces the kill path', () => {
    expect(resolveBashTimeoutBehavior({
      semanticId: 'bash',
      command: 'bun run build',
      env: { NESSY_DISABLE_BACKGROUND_TASKS: '1' },
    })).toBe('kill');
  });

  test('only the bash tool transitions - other supervised commands keep the kill path', () => {
    for (const semanticId of ['grep', 'find', 'read', 'monitor', undefined]) {
      expect(resolveBashTimeoutBehavior({ semanticId, command: 'rg pattern', env: {} })).toBe('kill');
    }
  });

  // `tools-reference.md#background-commands`: "Claude Code never auto-backgrounds
  // three kinds of command. It stops them at the timeout instead:" — the second
  // and third bullets, which had no implementation before 2026-08-28.
  test('a command that runs git anywhere in it is never auto-backgrounded', () => {
    for (const command of ['git clone https://x/y', 'cd repo && git fetch --all', 'ls | git hash-object --stdin']) {
      expect(resolveBashTimeoutBehavior({ semanticId: 'bash', command, env: {} })).toBe('kill');
    }
  });

  test('a compound command we cannot parse into simple commands is never auto-backgrounded', () => {
    for (const command of ['for f in *.ts; do tsc $f; done', 'bun run build $(date +%s)', '(cd app && make)']) {
      expect(resolveBashTimeoutBehavior({ semanticId: 'bash', command, env: {} })).toBe('kill');
    }
  });
});

describe('commandRunsGit', () => {
  test.each([
    ['git status', true],
    ['cd repo && git fetch', true],
    ['/usr/bin/git clone x', true],
    ['rm -rf .git', true],
    // Word boundaries: `git` abutting a word character is a different word.
    ['rg -v digit', false],
    ['cargo build --features gitlab', false],
    ['cat .gitignore', false],
    ['bun run build', false],
    ['', false],
  ])('%p -> %p', (command, expected) => {
    expect(commandRunsGit(command)).toBe(expected);
  });
});

describe('isUnparseableCompoundCommand', () => {
  test.each([
    // Lists of simple commands ARE parseable — these must stay backgroundable.
    ['bun run build', false],
    ['cd app && bun run build', false],
    ['npm run dev | tee dev.log', false],
    ['bun test 2>&1 > out.txt', false],
    ['docker compose up; echo ok', false],
    ['bun run build && echo done', false],
    ["rg -n 'a b' src", false],
    // Nesting a command inside a construct is not a list of simple commands.
    ['bun run build $(date)', true],
    ['echo `hostname`', true],
    ['(cd app && make)', true],
    ['{ echo a; echo b; }', true],
    ['diff <(ls a) <(ls b)', true],
    ['cat <<EOF', true],
    ['for f in *; do echo $f; done', true],
    ['if test -f x; then echo y; fi', true],
    ['while read l; do echo $l; done', true],
    ['bun run dev &', true],
    ["echo 'unterminated", true],
    ['echo \\', true],
  ])('%p -> %p', (command, expected) => {
    expect(isUnparseableCompoundCommand(command)).toBe(expected);
  });
});
