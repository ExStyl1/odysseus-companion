/**
 * P6.688 — the second route `tools-reference.md#enable-the-powershell-tool`
 * names: *"Set `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` in your environment or in
 * `settings.json`"*.
 *
 * P6.530 closed the environment route. This file covers the settings route, and
 * it pins the measurement that decides HOW it can be closed: an `env` block
 * cannot ride the SDK managed tier, so the obvious fix would have been a silent
 * no-op, and a deny rule is the one thing that tier can carry to the question.
 *
 * Nothing here spawns a child or executes a command; the rule string is matcher
 * data and the SDK read is a byte scan of a vendored file.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  CLAUDE_POWERSHELL_TOOL_DENY_RULE,
  claudePowerShellToolDenyFloor,
  mapManagedPolicyToClaudeSettings,
} from '../claude-managed-settings.ts';
import { parseClaudeRuleString } from '../pi-harness/claude-permission-rules.ts';

describe('P6.688 — the settings route to the PowerShell tool', () => {
  test('the floor denies the WHOLE tool, and the grammar reads it as one', () => {
    // The positive case. A bare tool name is a whole-tool rule, which is the
    // subject: `tools-reference.md#configure-tools-with-permission-rules-and-hooks`
    // gives `Bash(npm run *)` and `PowerShell(Get-ChildItem *)` two separate
    // rows of one table, so the `Bash(...)` deny surface we advertise does not
    // bind to a PowerShell call and a pattern rule would leave the rest open.
    expect(claudePowerShellToolDenyFloor()).toEqual({
      permissions: { deny: ['PowerShell'] },
    });
    expect(parseClaudeRuleString(CLAUDE_POWERSHELL_TOOL_DENY_RULE, 'deny')).toEqual({
      rule: { action: 'deny', match: { kind: 'tool', semanticId: 'PowerShell' } },
    });
  });

  test('it is a CONTRIBUTOR, so the mapper still sends nothing for a policy that says nothing', () => {
    // The negative/boundary case, and it is the one that guards the mapper's
    // root invariant: an unconditional emission moved back inside
    // `mapManagedPolicyToClaudeSettings` would make it answer for a policy
    // nobody wrote. Both the absent-policy and the empty-policy arms.
    expect(mapManagedPolicyToClaudeSettings(undefined).settings).toBeUndefined();
    const empty = mapManagedPolicyToClaudeSettings({ version: 1 } as never);
    expect(empty.settings?.permissions).toBeUndefined();
    expect(empty.mapped).not.toContain('claudeRules');
  });

  test('an `env` block cannot ride the SDK managed tier — the measurement, not a memory', () => {
    // WHY this row is not closed by pinning the vendor's own key. The SDK's
    // restrictive managed-settings filter copies a fixed list, and `env` is not
    // on it, so an `env` entry emitted from this pair would look like
    // enforcement and do nothing. Read out of the vendored bundle rather than
    // restated, so the day the SDK adds `env` this goes red instead of leaving
    // the row closed on a stale reading.
    // Located through the package's own `package.json`, the recipe
    // `claude-auto-mode-policy.test.ts` already uses: the SDK's export map does
    // not publish `sdk.mjs` as a subpath, so resolving the file name directly
    // throws.
    const require_ = createRequire(import.meta.url);
    const sdkRoot = dirname(require_.resolve('@anthropic-ai/claude-agent-sdk/package.json'));
    const sdk = readFileSync(join(sdkRoot, 'sdk.mjs'), 'utf8');
    // It is an ARRAY of `{path:[...],restrictive:...}` rows, not a function
    // body; the comment here once said "function" and that mattered, see below.
    // F1.255 (0.3.267): it used to sit right after the predicate
    // `parentSettingsBehavior==="merge"`, which now occurs TWICE and no longer
    // precedes it, so the table is anchored by its OWN first row — a content
    // string that occurs exactly once in 0.3.251 and in 0.3.267 alike (the
    // table: 60 rows / 3 275 characters then, 65 / 3 564 now, no `env` in either).
    const anchor = '{path:["allowManagedPermissionRulesOnly"],restrictive:';
    const at = sdk.indexOf(anchor);
    expect(at).toBeGreaterThan(-1);
    expect(sdk.indexOf(anchor, at + 1)).toBe(-1);
    // The row is the table's FIRST element: its `[` is the character before it.
    expect(sdk[at - 1]).toBe('[');
    // D1.111 — the array's OWN brackets, not a 2 000-character window. Measured
    // 2026-09-17 at SDK `0.3.247`: the table is 3 315 characters, so the window
    // read 60 % of it and an `env` row appended in the last third would have
    // been missed — the silent direction. The minified name (`uQ` at 0.3.251,
    // `fh` at 0.3.267) rots with every SDK build, so the bound is the table's
    // own `[` rather than the name.
    const open = at - 1;
    let depth = 0;
    let close = -1;
    for (let index = open; index < sdk.length; index += 1) {
      if (sdk[index] === '[') depth += 1;
      else if (sdk[index] === ']') {
        depth -= 1;
        if (depth === 0) { close = index; break; }
      }
    }
    expect(close).toBeGreaterThan(open);
    const restrictiveTable = sdk.slice(open, close + 1);
    // BOUNDARY CONTROL: the region really is the table and not the rest of the
    // bundle, which is 1.4 MB and contains `env` everywhere.
    expect(restrictiveTable.endsWith(']')).toBe(true);
    expect(restrictiveTable.length).toBeLessThan(20_000);

    // The positive controls: two keys the list demonstrably DOES carry, one of
    // them the very key this floor rides. Without these a table that failed to
    // load would make the assertion below vacuously true.
    expect(restrictiveTable).toContain('permissions');
    expect(restrictiveTable).toContain('allowManagedHooksOnly');
    // ...and the finding, in the spelling the table can actually carry. This
    // was `not.toContain('.env')` and that needle is one the table could never
    // hold: every path segment here is a double-quoted string (`["sandbox",
    // "enabled"]`), so an `env` row reads `["env"]` and no dotted form exists.
    // The bundle spells `.env` 219 times ELSEWHERE, which is what made the
    // needle look plausible. Measured: zero occurrences of the bare substring
    // `env` anywhere in the 3 315-character table.
    expect(restrictiveTable).not.toContain('"env"');
    expect(restrictiveTable).not.toContain('env');
  });
});
