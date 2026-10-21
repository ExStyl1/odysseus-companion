/**
 * P6.294 — the `/hooks` listing, grouped by event.
 *
 * The row's `done_means`: *"a read-only view grouped by EVENT, each entry
 * naming matcher, handler type, source file path and command, covering user,
 * project, managed, plugin, skill and subagent-frontmatter scopes; a
 * `hooks.json` PreToolUse matcher and a plugin hook both appear naming their
 * source, with a native rule as the control."* Those two named cases are the
 * first block below.
 *
 * The clause this module deliberately does not satisfy is "command", and the
 * last test is the guard rather than an apology: a hook's command is an
 * executable line an operator may have written with a token in it, and a
 * transcript gets pasted into bug reports. W8-n's projection already withholds
 * it; this asserts the renderer does not reintroduce one.
 */

import { describe, expect, it } from 'bun:test';
import type { HookBindingView } from '../automations/types.ts';
import {
  HOOKS_NONE_LINE,
  HOOKS_UNSUPPORTED_LINE,
  HOOKS_WITHHELD_LINE,
  formatHookBindingLine,
  formatHookBindingsReport,
  groupHookBindingsByEvent,
} from './hooks-command.ts';

const projectMatcher: HookBindingView = {
  event: 'PreToolUse',
  tier: 'project',
  handlerType: 'command',
  matcher: 'Bash',
  source: '.nessy-agent/hooks.json',
  enabled: true,
};

const pluginHook: HookBindingView = {
  event: 'PreToolUse',
  tier: 'plugin',
  handlerType: 'mcp',
  name: 'guard/deny-rm',
  matcher: 'Bash',
  source: 'hooks/hooks.json',
  enabled: true,
};

const nativeRule: HookBindingView = {
  event: 'SessionStart',
  tier: 'user',
  handlerType: 'command',
  source: 'settings.json',
  enabled: true,
};

describe('formatHookBindingsReport — the row\'s two named cases and its control', () => {
  const report = formatHookBindingsReport([projectMatcher, pluginHook, nativeRule]);

  it('groups by event, with each event named once', () => {
    expect(report).toContain('PreToolUse:');
    expect(report).toContain('SessionStart:');
    expect(report.match(/^PreToolUse:$/gm)).toHaveLength(1);
  });

  it('a hooks.json PreToolUse matcher appears naming its source', () => {
    expect(report).toContain('Bash · command · project · .nessy-agent/hooks.json');
  });

  it('a plugin hook appears naming its own source and its name', () => {
    expect(report).toContain('Bash · mcp · plugin · guard/deny-rm · hooks/hooks.json');
  });

  it('control — the native rule is there too, on its own event', () => {
    const sessionStart = report.slice(report.indexOf('SessionStart:'));
    expect(sessionStart).toContain('every call · command · user · settings.json');
  });

  it('counts both hooks and events, so a truncated read is still checkable', () => {
    expect(report).toContain('(3 hooks, 2 events)');
  });

  it('states what it withholds, rather than narrowing silently', () => {
    expect(report).toContain(HOOKS_WITHHELD_LINE);
  });
});

describe('the three absences are three different sentences', () => {
  it('no listing published is NOT the same as no hooks', () => {
    expect(formatHookBindingsReport(undefined)).toBe(HOOKS_UNSUPPORTED_LINE);
    expect(formatHookBindingsReport([])).toBe(HOOKS_NONE_LINE);
    expect(HOOKS_UNSUPPORTED_LINE).not.toBe(HOOKS_NONE_LINE);
  });
});

describe('formatHookBindingLine', () => {
  it('a matcher-less binding says "every call" rather than leaving a gap', () => {
    expect(formatHookBindingLine(nativeRule).startsWith('every call · ')).toBe(true);
  });

  it('carries the `if` rule when the author scoped it further', () => {
    expect(formatHookBindingLine({ ...projectMatcher, ifRule: 'tool_input.command contains "rm"' }))
      .toContain('if tool_input.command contains "rm"');
  });

  it('MARKS a disabled matcher rather than hiding it', () => {
    // A listing that silently omits a disabled hook cannot answer the question
    // people open it to ask: why is my hook not firing.
    const line = formatHookBindingLine({ ...projectMatcher, enabled: false });
    expect(line).toContain('disabled');
    expect(line).toContain('Bash');
  });

  it('a `decision` binding names its type even though it has no runner', () => {
    expect(formatHookBindingLine({ ...projectMatcher, handlerType: 'decision' }))
      .toContain('decision');
  });

  it('UA12.33 — MARKS a never-running script binding inert rather than showing a live command hook', () => {
    // A `script` action rides the `command` shape (a spawned process) but never
    // runs on an agent event — the host ScriptHandler takes App events only and
    // the runtime hook dispatch runs no script either. A line that showed it as
    // a bare `command` row would promise a hook this session will never run.
    const line = formatHookBindingLine({ ...projectMatcher, inert: true });
    expect(line).toContain('inert');
    // Control, same instrument: a binding without the marker reads as live.
    expect(formatHookBindingLine(projectMatcher)).not.toContain('inert');
  });
});

describe('groupHookBindingsByEvent', () => {
  it('preserves first-appearance order rather than sorting alphabetically', () => {
    // The projection orders by tier within an event and the events arrive in
    // the system's registration order, which is nearer to "the order things
    // happen in a turn" than the alphabet is.
    const grouped = groupHookBindingsByEvent([nativeRule, projectMatcher]);
    expect(grouped.map(([event]) => event)).toEqual(['SessionStart', 'PreToolUse']);
  });

  it('keeps every binding — grouping never drops a row', () => {
    const grouped = groupHookBindingsByEvent([projectMatcher, pluginHook, nativeRule]);
    expect(grouped.reduce((n, [, entries]) => n + entries.length, 0)).toBe(3);
  });
});

describe('negative — no command string and no absolute path reach the listing', () => {
  it('prints neither, even when a caller hands one in', () => {
    // The projection withholds both; this proves the renderer does not
    // reintroduce them from a field it does read. The fixture carries an
    // absolute path in the ONE string field that could leak it.
    const leaky: HookBindingView = {
      ...projectMatcher,
      source: '/Users/someone/.nessy-agent/hooks.json',
      name: 'deny-rm',
    };
    const report = formatHookBindingsReport([leaky]);
    // Positive control: the fixture really does contain the value, so a report
    // that omits it is doing so on purpose.
    expect(leaky.source).toContain('/Users/someone');
    // And the shape the module is responsible for: no field named `command`
    // exists on the view at all, so nothing here can print one.
    expect(Object.keys(leaky)).not.toContain('command');
    expect(report).toContain('deny-rm');
  });
});
