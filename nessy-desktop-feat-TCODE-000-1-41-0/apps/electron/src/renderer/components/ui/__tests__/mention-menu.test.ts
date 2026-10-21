/**
 * Tests for mention menu @ trigger detection
 *
 * The isValidMentionTrigger function determines when typing @ should open
 * the mention menu vs when it's part of an email address or other text.
 */

import { describe, it, expect } from 'bun:test';

/*
 * P6.844 — the pdfjs carve-out that stood here is GONE, and with it the dynamic
 * import it forced. `mention-menu.tsx` reached the `@nessy-agent/ui` BARREL
 * through `SourceAvatar` -> `SourceStatusIndicator`, whose graph ends at the
 * Vite-only `pdfjs-dist/build/pdf.worker.min.mjs?url` specifier bun cannot
 * resolve; P6.837 gave the indicator the tooltip subpath and the last barrel
 * reach in this graph went with it, so the two `mock.module` stubs and the
 * `DOMMatrix` shim were replacing modules nothing here loads any more.
 *
 * The import is STATIC because the graph's load then happens at file load,
 * outside bun's 5 000 ms per-test timer. It was inside a `beforeAll` before,
 * which is why this file reported `0 pass / 1 fail` with a hook timeout and
 * ZERO of its cases executed.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  InlineMentionMenu,
  isValidMentionTrigger,
  mentionSearchResults,
  mcpResourceToMentionItem,
  buildMentionInsertText,
  quoteSessionMentionName,
  sharedSessionMentionNames,
} from '../mention-menu';

describe('isValidMentionTrigger', () => {
  describe('valid triggers (should open menu)', () => {
    it('returns true when @ is at the start of input', () => {
      expect(isValidMentionTrigger('@', 0)).toBe(true);
      expect(isValidMentionTrigger('@skill', 0)).toBe(true);
    });

    it('returns true when @ is preceded by a space', () => {
      expect(isValidMentionTrigger('hello @', 6)).toBe(true);
      expect(isValidMentionTrigger('hello @skill', 6)).toBe(true);
      expect(isValidMentionTrigger('use @mention here', 4)).toBe(true);
    });

    it('returns true when @ is preceded by a tab', () => {
      expect(isValidMentionTrigger('hello\t@', 6)).toBe(true);
      expect(isValidMentionTrigger('\t@skill', 1)).toBe(true);
    });

    it('returns true when @ is preceded by a newline', () => {
      expect(isValidMentionTrigger('hello\n@', 6)).toBe(true);
      expect(isValidMentionTrigger('line1\nline2\n@skill', 12)).toBe(true);
    });

    it('returns true when @ is preceded by carriage return', () => {
      expect(isValidMentionTrigger('hello\r@', 6)).toBe(true);
      expect(isValidMentionTrigger('hello\r\n@', 7)).toBe(true);
    });

    it('returns true when @ is preceded by multiple whitespace chars', () => {
      expect(isValidMentionTrigger('hello   @', 8)).toBe(true);
      expect(isValidMentionTrigger('hello\n\n@', 7)).toBe(true);
    });

    it('returns true when @ is preceded by opening parenthesis', () => {
      expect(isValidMentionTrigger('(@', 1)).toBe(true);
      expect(isValidMentionTrigger('use (@skill)', 5)).toBe(true);
      expect(isValidMentionTrigger('call(@mention', 5)).toBe(true);
    });

    it('returns true when @ is preceded by double quote', () => {
      expect(isValidMentionTrigger('"@', 1)).toBe(true);
      expect(isValidMentionTrigger('say "@skill"', 5)).toBe(true);
    });

    it('returns true when @ is preceded by single quote', () => {
      expect(isValidMentionTrigger("'@", 1)).toBe(true);
      expect(isValidMentionTrigger("use '@skill'", 5)).toBe(true);
    });
  });

  describe('invalid triggers (should NOT open menu)', () => {
    it('returns false for email addresses', () => {
      // test@example.com - @ at position 4
      expect(isValidMentionTrigger('test@', 4)).toBe(false);
      expect(isValidMentionTrigger('test@example', 4)).toBe(false);
      expect(isValidMentionTrigger('user@domain.com', 4)).toBe(false);
    });

    it('returns false when @ is preceded by letters', () => {
      expect(isValidMentionTrigger('hello@', 5)).toBe(false);
      expect(isValidMentionTrigger('contact@support', 7)).toBe(false);
    });

    it('returns false when @ is preceded by numbers', () => {
      expect(isValidMentionTrigger('user123@', 7)).toBe(false);
      expect(isValidMentionTrigger('99@bottles', 2)).toBe(false);
    });

    it('returns false when @ is preceded by other punctuation (not quotes/parens)', () => {
      expect(isValidMentionTrigger('hello.@', 6)).toBe(false);
      expect(isValidMentionTrigger('test-@user', 5)).toBe(false);
      expect(isValidMentionTrigger('foo_@bar', 4)).toBe(false);
      expect(isValidMentionTrigger('end)@start', 4)).toBe(false); // closing paren is not allowed
    });

    it('returns false for negative position', () => {
      expect(isValidMentionTrigger('test', -1)).toBe(false);
      expect(isValidMentionTrigger('@test', -1)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(isValidMentionTrigger('', 0)).toBe(true); // @ would be at start
      expect(isValidMentionTrigger('', -1)).toBe(false);
    });

    it('handles unicode whitespace', () => {
      // Non-breaking space (U+00A0) - treated as whitespace by \s
      expect(isValidMentionTrigger('hello\u00A0@', 6)).toBe(true);
    });

    it('handles position at end of string', () => {
      const text = 'hello ';
      expect(isValidMentionTrigger(text, text.length)).toBe(true); // space before
    });

    it('handles multiple @ symbols - checks specific position', () => {
      // "user@test @skill" - first @ is invalid (after 'r'), second is valid (after space)
      expect(isValidMentionTrigger('user@test @', 4)).toBe(false);  // first @
      expect(isValidMentionTrigger('user@test @', 10)).toBe(true); // second @
    });
  });
});

/**
 * `mcp.md` § Use MCP resources — "Type `@` in your prompt to see available
 * resources from all connected MCP servers. Resources appear alongside files in
 * the autocomplete menu", referenced as `@server:protocol://resource/path`.
 *
 * R5: both halves used to be unreachable on Pi, the shipped default. The RPC was
 * issued only on `codex-runtime`, and even there `response.resources` was never
 * read.
 */
describe('MCP resource mentions', () => {
  const resource = { server: 'github', uri: 'issue://123', name: 'Flaky menu', description: 'Open issue #123' };
  const file = {
    root: '/repo', path: 'src/app.ts', match_type: 'file' as const,
    file_name: 'app.ts', score: 1, indices: null,
  };

  it('offers resources on a backend with no fuzzy file search', () => {
    // The Pi shape: the host answered from the session MCP pool, the agent
    // contributed no files.
    const outcome = mentionSearchResults(
      { files: [], resources: [resource] },
      { useCodexFuzzyFileSearch: false },
    );

    expect(outcome.resources).toEqual([{
      id: 'github:issue://123',
      type: 'resource',
      label: 'Flaky menu',
      description: 'Open issue #123',
      resource: { server: 'github', uri: 'issue://123' },
    }]);
    // `null` keeps the local filesystem search: only the backend that
    // implements the fuzzy file RPC may replace it.
    expect(outcome.files).toBeNull();
  });

  it('offers resources alongside the codex file rows', () => {
    const outcome = mentionSearchResults(
      { files: [file], resources: [resource] },
      { useCodexFuzzyFileSearch: true },
    );

    expect(outcome.resources).toHaveLength(1);
    expect(outcome.files?.map(item => item.id)).toEqual(['/repo/src/app.ts']);
  });

  it('degrades to the local search when the backend answers nothing', () => {
    // A backend without the RPC: `null` in, no resources and no file
    // replacement out — no throw, and the filesystem path still runs.
    const outcome = mentionSearchResults(null, { useCodexFuzzyFileSearch: true });

    expect(outcome.resources).toEqual([]);
    expect(outcome.files).toBeNull();
  });

  it('falls back to the uri when the server names nothing', () => {
    expect(mcpResourceToMentionItem({ server: 'docs', uri: 'file://api/auth' })).toEqual({
      id: 'docs:file://api/auth',
      type: 'resource',
      label: 'file://api/auth',
      description: 'file://api/auth',
      resource: { server: 'docs', uri: 'file://api/auth' },
    });
  });

  it('inserts the documented @server:uri reference, not a bracket mention', () => {
    // `resolveMcpResourceMentions` fetches and inlines exactly this shape before
    // the turn is built; a `[resource:...]` bracket would reach the model as
    // unresolved text.
    expect(buildMentionInsertText(mcpResourceToMentionItem(resource))).toBe('@github:issue://123 ');
    // The other row types keep the bracket syntax they always had.
    expect(buildMentionInsertText({ id: 'commit', type: 'skill', label: 'commit' })).toBe('[skill:commit] ');
    expect(buildMentionInsertText({
      id: '/repo/src/app.ts', type: 'file', label: 'app.ts',
      file: { path: '/repo/src/app.ts', type: 'file', relativePath: 'src/app.ts' },
    })).toBe('[file:src/app.ts] ');
  });
});

/**
 * P6.311 — an agent picked from the typeahead.
 *
 * The page describes TWO spellings and neither is the wire between this composer
 * and this host: the picker inserts `@"code-reviewer (agent)"` and the manual
 * form is `@agent-<name>`. Both are Claude Code's terminal composer talking to
 * Claude Code's own parser. Ours emits `[agent:id]`, the syntax every other row
 * here emits and `lib/mentions.ts` matches — and the assertion is written as an
 * EXACT string, so a later change to the page's form cannot be applied here
 * without also being applied to the parser that reads it.
 */
describe('an agent mention', () => {
  it('emits the house bracket syntax, with the scoped id verbatim', () => {
    expect(buildMentionInsertText({ id: 'code-reviewer', type: 'agent', label: 'code-reviewer' }))
      .toBe('[agent:code-reviewer] ');
    // A plugin subagent's identity is its SCOPED name — the page: "Subagents
    // provided by an enabled plugin appear in the typeahead under their scoped
    // name, such as `my-plugin:code-reviewer`". The colons survive untouched.
    expect(buildMentionInsertText({
      id: 'my-plugin:review:security', type: 'agent', label: 'security',
    })).toBe('[agent:my-plugin:review:security] ');
  });

  it('is not confused with a skill, which shares the bracket shape', () => {
    // Same id, different kind, different bracket. A switch that fell through to
    // the `bracket('skill', …)` default would silently invoke a skill.
    expect(buildMentionInsertText({ id: 'explore', type: 'agent', label: 'explore' }))
      .not.toBe(buildMentionInsertText({ id: 'explore', type: 'skill', label: 'explore' }));
  });
});

/**
 * C3.224 (= row D1.80 of the integrations plan, carried from P6.464) — a SESSION
 * row, and it is the one kind besides an MCP resource that does NOT use the
 * `[kind:value]` bracket syntax.
 *
 * `cross-session-messaging.md#message-another-session`, verbatim: *"Claude Code
 * inserts the mention, such as `@api-worker`, and tells Claude which session it
 * names, so Claude can message that session without listing your sessions
 * first."* The inserted text is read by the MODEL and handed to
 * `send_agent_message`, whose `sessionId` resolves a live NAME host-side — so
 * the bracket form, which speaks to our own mention parser, would address
 * nothing.
 */
describe('a session mention (C3.224)', () => {
  it('inserts the name, not an id and not a bracket', () => {
    expect(buildMentionInsertText({
      id: 'sess-1',
      type: 'session',
      label: 'api-worker',
      session: { id: 'sess-1', name: 'api-worker' },
    })).toBe('@api-worker ');
  });

  /**
   * The page's own rule: *"A name with a space or other characters outside
   * letters, digits, hyphens, and underscores: type it in double quotes, such as
   * `@"release notes"`. When you pick the session from the typeahead, Claude
   * Code inserts the quotes for you."*
   */
  it('quotes a name the page says needs quoting, and only such a name', () => {
    expect(quoteSessionMentionName('api-worker')).toBe('api-worker');
    expect(quoteSessionMentionName('api_worker-2')).toBe('api_worker-2');
    expect(quoteSessionMentionName('release notes')).toBe('"release notes"');
    // "other characters outside letters, digits, hyphens, and underscores" —
    // a dot and a slash are outside that set as surely as a space is.
    expect(quoteSessionMentionName('v1.2')).toBe('"v1.2"');
    expect(quoteSessionMentionName('team/ops')).toBe('"team/ops"');
  });

  it('escapes a quote inside the name rather than letting it end the mention', () => {
    // The page does not say. A mention that silently ended mid-name would
    // address the WRONG session, which is the one outcome this row prevents.
    expect(quoteSessionMentionName('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteSessionMentionName('back\\slash')).toBe('"back\\\\slash"');
  });

  it('carries the quoting into the inserted text', () => {
    expect(buildMentionInsertText({
      id: 'sess-2',
      type: 'session',
      label: 'release notes',
      session: { id: 'sess-2', name: 'release notes' },
    })).toBe('@"release notes" ');
  });

  it('leaves the other kinds on the bracket syntax', () => {
    // The control: a session is the exception, not a new house style.
    expect(buildMentionInsertText({ id: 'reviewer', type: 'agent', label: 'reviewer' }))
      .toBe('[agent:reviewer] ');
    expect(buildMentionInsertText({ id: 'vault', type: 'skill', label: 'vault' }))
      .toBe('[skill:vault] ');
  });
});

/**
 * C3.316 — the typeahead can offer two rows that insert the same mention.
 *
 * The page's uniqueness rule runs on the EXPLICIT naming path only and excludes,
 * in its own words, "AI-generated titles or default display names" — which is
 * how most sessions here get their name. So two live sessions CAN answer to one
 * name, both appear in the menu, and both insert the same `@name`. The host then
 * refuses and Claude asks which one is meant, which is what the page describes;
 * what the composer owes is the warning BEFORE that round trip.
 */
describe('sharedSessionMentionNames (C3.316)', () => {
  it('names only the names more than one session answers to', () => {
    expect([...sharedSessionMentionNames([
      { name: 'api-worker' },
      { name: 'api-worker' },
      { name: 'docs' },
    ])]).toEqual(['api-worker']);
  });

  it('is EMPTY when every name is its own — the control the warning must not fire on', () => {
    expect(sharedSessionMentionNames([{ name: 'a' }, { name: 'b' }, { name: 'c' }]).size).toBe(0);
    expect(sharedSessionMentionNames([]).size).toBe(0);
    expect(sharedSessionMentionNames([{ name: 'only' }]).size).toBe(0);
  });

  it('reports a name once however many sessions answer to it', () => {
    // A Set, not a list: three rows share one name and the menu must say so on
    // each of them without the rule counting the name three times.
    expect([...sharedSessionMentionNames([
      { name: 'dup' }, { name: 'dup' }, { name: 'dup' },
    ])]).toEqual(['dup']);
  });

  it('compares the RAW name, because that is what the mention inserts', () => {
    // Case and spacing are part of the string `resolveCrossSessionTarget`
    // matches on host-side. A looser rule here would warn about a pair the host
    // resolves fine, and the warning would stop meaning anything.
    expect(sharedSessionMentionNames([{ name: 'API' }, { name: 'api' }]).size).toBe(0);
    expect(sharedSessionMentionNames([{ name: 'api ' }, { name: 'api' }]).size).toBe(0);
  });
});

/**
 * UB14.21 — the @ menu on upstream v0.15.0's floating material
 * (`inline-menu-styles.ts`), with OUR sectioned rows and `max-h-[40dvh]` kept.
 * Rendered in place (no DOM ships here, so there is no portal target).
 */
describe('UB14.21 — InlineMentionMenu wears the floating menu material', () => {
  const render = (open: boolean) => renderToStaticMarkup(createElement(InlineMentionMenu, {
    open,
    onOpenChange: () => {},
    onSelect: () => {},
    position: { x: 0, y: 0 },
    sections: [{
      id: 'files',
      label: 'Files',
      items: [{ id: '/repo/src/app.ts', type: 'file', label: 'app.ts', description: 'src/app.ts', file: { path: '/repo/src/app.ts', type: 'file', relativePath: 'src/app.ts' } }],
    }],
  }));

  it('positive — popover-styled growing from the caret corner, tertiary section label, our list cap', () => {
    const html = render(true);
    const tag = html.match(/<div[^>]*data-inline-menu[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('popover-styled');
    expect(tag).toContain('origin-bottom-left');
    expect(html).toContain('max-h-[40dvh]');
    expect(html).toContain('text-label-sm font-medium text-tertiary');
    expect(html).toContain('>app.ts<');
  });

  it('negative — no composer-radius coupling or ad-hoc opacity roles; a closed menu renders nothing', () => {
    const html = render(true);
    expect(html).not.toContain('composer-radius');
    expect(html).not.toContain('text-foreground/45');
    expect(html).not.toContain('text-muted-foreground');
    expect(render(false)).toBe('');
  });
});
