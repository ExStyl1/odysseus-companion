/**
 * P4 — a skill's tool ceiling must survive a comma.
 *
 * Measured in the signed Nessy 1.25.0 build against the official
 * `claude-security` plugin (1.25.0 is OUR release, not a plugin version — the
 * plugin has never been 1.x): its stored capability carried
 * `disableModelInvocation: true` and NO `allowedTools`, although its `SKILL.md`
 * declares a 20-entry `allowed-tools:` YAML block list. The sibling boolean from
 * the SAME frontmatter block survived, so the file was found, opened and parsed
 * — only this one field was lost.
 *
 * RE-MEASURED 2026-08-25 (P2.146) against the `claude-security` bundle actually
 * STAGED ON DISK — `.claude-plugin/plugin.json` reads `"version": "0.10.0"`, and
 * the cache path segment decodes to the same. The fixture below is deliberately
 * NOT repinned to it: it is a hand-written trim of the SHAPE, not a copy of the
 * artifact, and the shape is what regresses. Version numbers are why. This
 * docstring said **0.10.2** for one day, taken from a copy fetched live from
 * `anthropics/claude-plugins-official` (21 entries — it adds one
 * `Bash(bash "${CLAUDE_PLUGIN_ROOT}/scripts/keep-waiting.sh" *)`); upstream
 * `main` answered **0.10.2.3** when re-fetched on 2026-08-25. The number a
 * reader can check is the one on disk, so that is the one cited: 0.10.0, whose
 * `SKILL.md` declares a **20**-entry `allowed-tools:` block list, and
 * `Bash(git diff:*)` below stays illustrative — the shipped list spells that
 * grant `Bash(git *)`.
 *
 * **Which seam is measured decides the answer, and this paragraph named the
 * wrong one for a day.** Measured through `normalizeClaudePluginBundle`, the
 * adapter-internal normalizer, the skill capability really is only
 * `{ id, kind: 'skill', skill: { slug, path } }`. But that function is never the
 * install path on its own: `acquisition.ts:263` calls `normalizePluginBundle`
 * (`format-adapters.ts:390`), which then runs `applyPluginSkillFrontmatter`
 * (`:418`) and folds the frontmatter back onto `capability.skill`. Measured
 * through THAT entry point on the on-disk 0.10.0 bundle, the stored capability
 * carries `disableModelInvocation: true` and all **20** `allowedTools`, with
 * `Agent(claude-security:scan-inventory, …, claude-security:explore)` intact as
 * ONE — the same values the installed `plugin.json` on disk holds. So the
 * defect's blast radius did not move away from this file: the stored copy IS
 * built out of `readPluginSkillFrontmatter` + `parseSkillToolList`, which is
 * exactly where every list case here asserts it.
 *
 * The stored copy is the DISPLAY and wire-name copy, not the enforced one:
 * `resolver.ts:1186` maps it to `skillAllowedTools` and `views.ts:226` shows it
 * to the user, while what governs a dispatch is re-read from disk
 * (`materializer.ts` `readText` → `readFileSync` + `verifyPlugin`, then the
 * frontmatter is re-split and re-tokenized). Both copies come through this
 * parser, so a regression here is visible in the UI and enforced in the turn.
 *
 * The cause was the hand-rolled frontmatter scanner in
 * `format-adapters/shared.ts`: it folded a block list into a comma-joined string
 * and ABORTED the whole list the moment any item contained a comma, writing `''`
 * for the key. `claude-security` declares
 * `Agent(claude-security:scan-inventory, claude-security:scan-researcher, …)` —
 * commas inside one item — so the ceiling vanished silently.
 *
 * Two layers have to hold, not one. Reporting the list correctly out of the
 * parser is useless if the consumer's tokenizer then re-splits
 * `Agent(a, b)` into `Agent(a` and `b)`, so every list case here is asserted
 * through `parseSkillToolList` — THE tokenizer of `allowed-tools` on every path
 * — as well as at the raw frontmatter map.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPluginSkillFrontmatter, splitMarkdownFrontmatter } from '../format-adapters/shared.ts';
import { parseSkillToolList } from '../../capabilities/runtime-skill-content.ts';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-frontmatter-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

function fenced(...lines: string[]): string {
  return `---\n${lines.join('\n')}\n---\n\nBody text.\n`;
}

describe('splitMarkdownFrontmatter', () => {
  it('keeps every item of a block list whose entry contains commas', () => {
    // The real `claude-security` SHAPE, trimmed to three entries (of 20 when
    // this was written, 21 at 0.10.2 — see the header: the count is not the
    // invariant, the comma-carrying block-list item is).
    const { frontmatter, body } = splitMarkdownFrontmatter(fenced(
      'name: claude-security',
      'description: Security review',
      'allowed-tools:',
      '  - Agent(claude-security:scan-inventory, claude-security:scan-researcher, claude-security:scan-reporter)',
      '  - Read',
      '  - Bash(git diff:*)',
      'disable-model-invocation: true',
    ));

    expect(frontmatter['allowed-tools']).toBeTruthy();
    // Layer two: the consumer's own tokenizer must not undo the parse.
    expect(parseSkillToolList(frontmatter['allowed-tools'])).toEqual([
      'Agent(claude-security:scan-inventory, claude-security:scan-researcher, claude-security:scan-reporter)',
      'Read',
      'Bash(git diff:*)',
    ]);
    // The internal control from the same block: it survived the defect, and it
    // has to keep surviving the fix.
    expect(frontmatter['disable-model-invocation']).toBe('true');
    expect(body).toBe('Body text.');
  });

  it('keeps a plain block list with no commas', () => {
    const { frontmatter } = splitMarkdownFrontmatter(fenced(
      'allowed-tools:',
      '  - Read',
      '  - Grep',
    ));

    expect(parseSkillToolList(frontmatter['allowed-tools'])).toEqual(['Read', 'Grep']);
  });

  it('keeps an inline flow list', () => {
    const { frontmatter } = splitMarkdownFrontmatter(fenced(
      'allowed-tools: [Read, Bash(a,b), "Grep(x,y)"]',
      'paths: [src/**/*.ts, docs/**/*.md]',
    ));

    // A comma IS a delimiter inside a YAML flow sequence — `Bash(a,b)` unquoted
    // there is genuinely two items to any conforming reader, and the quoted
    // sibling is the spelling that means one. The joined string plus the
    // paren-aware tokenizer still yields ONE rule per parameterized entry rather
    // than the `Bash(a` / `b)` pair a naive re-split would produce; the
    // unquoted one only loses the exact inner spacing. A block list (the shape
    // real plugins ship, and the case above) is a plain scalar per entry and
    // round-trips byte for byte.
    expect(parseSkillToolList(frontmatter['allowed-tools'])).toEqual([
      'Read',
      'Bash(a, b)',
      'Grep(x,y)',
    ]);
    // `normalizePathPatterns` splits `paths` on a bare comma and does NOT strip
    // brackets, so the raw `[a, b]` scalar the old scanner emitted produced
    // `['[src/**/*.ts', 'docs/**/*.md]']`. A parsed sequence has no brackets left
    // to leak.
    expect(frontmatter.paths).toBe('src/**/*.ts, docs/**/*.md');
  });

  it('keeps a quoted scalar containing a comma as one value', () => {
    const { frontmatter } = splitMarkdownFrontmatter(fenced(
      'description: "Reviews Python, TypeScript and Go"',
      'paths: "**/*.py, **/*.pyi"',
    ));

    expect(frontmatter.description).toBe('Reviews Python, TypeScript and Go');
    expect(frontmatter.paths).toBe('**/*.py, **/*.pyi');
  });

  it('leaves a nested mapping opaque and never promotes its fields', () => {
    // Several consumers test `'hooks' in frontmatter` for the DECLARATION and
    // re-read the block with a real YAML reader. Presence with an empty value is
    // the contract; a promoted `model` from a nested `modelConfig` would be a
    // silent widening.
    const { frontmatter } = splitMarkdownFrontmatter(fenced(
      'name: agent',
      'hooks:',
      '  PreToolUse:',
      '    - command: ./guard.sh',
      'modelConfig:',
      '  model: opus',
    ));

    expect('hooks' in frontmatter).toBe(true);
    expect(frontmatter.hooks).toBe('');
    expect(frontmatter.modelConfig).toBe('');
    expect(frontmatter.model).toBeUndefined();
    expect(frontmatter.command).toBeUndefined();
    expect(frontmatter.PreToolUse).toBeUndefined();
  });

  it('still reads a block list when the document is not valid YAML', () => {
    // `description: Use when the user says "x": y` is a real SKILL.md shape and
    // js-yaml rejects the whole document for it. The scanner fallback keeps the
    // file's other fields — and must not reintroduce the comma refusal.
    const { frontmatter } = splitMarkdownFrontmatter(fenced(
      'name: scoped',
      'description: Use when the user says "deploy": ship it',
      'allowed-tools:',
      '  - Agent(a, b)',
      '  - Read',
      'disable-model-invocation: true',
    ));

    expect(frontmatter.name).toBe('scoped');
    expect(parseSkillToolList(frontmatter['allowed-tools'])).toEqual(['Agent(a, b)', 'Read']);
    expect(frontmatter['disable-model-invocation']).toBe('true');
  });

  it('reports no frontmatter and the whole content as body without a fence', () => {
    const { frontmatter, body } = splitMarkdownFrontmatter('Just a body.\n');

    expect(frontmatter).toEqual({});
    expect(body).toBe('Just a body.');
  });
});

describe('the FALLBACK scanner keeps a sequence element that is a mapping (P6.817)', () => {
  /** The documented inline `mcpServers` example, plus a reference AFTER it. */
  const LINES = [
    'name: db-admin',
    'DESCRIPTION_LINE',
    'mcpServers:',
    '  - playwright:',
    '      type: stdio',
    '      command: npx',
    '  - github',
  ];

  /**
   * One unrelated YAML error, and it is not hypothetical — this exact shape is
   * why the scanner exists (see `splitMarkdownFrontmatter`'s own docblock).
   * js-yaml refuses the WHOLE document for it, so everything below arrives
   * through the fallback.
   */
  const BROKEN_DESCRIPTION = 'description: Use when the user says "deploy": ship it';

  function split(description: string): Record<string, string> {
    return splitMarkdownFrontmatter(fenced(
      ...LINES.map(line => line === 'DESCRIPTION_LINE' ? description : line),
    )).frontmatter;
  }

  it('does not lose the reference listed after an inline entry', () => {
    const frontmatter = split(BROKEN_DESCRIPTION);

    // W9-ac's silent-drop control, asserted FIRST: the failure this row exists
    // for is not the inline entry going missing, it is the SIBLING going
    // missing with it. At HEAD the whole value was `''`.
    expect(frontmatter['mcpServers']).toContain('github');
    expect(JSON.parse(frontmatter['mcpServers'] ?? '')).toEqual([
      { playwright: { type: 'stdio', command: 'npx' } },
      'github',
    ]);
    // The unrelated field really did go through the scanner, not js-yaml.
    expect(frontmatter['description']).toBe('Use when the user says "deploy": ship it');
  });

  it('emits the same value js-yaml emits for the same list', () => {
    // The two paths have to speak one vocabulary: a reader must not be able to
    // tell which parser produced the value.
    expect(split(BROKEN_DESCRIPTION)['mcpServers'])
      .toBe(split('description: Database administration')['mcpServers']);
  });

  it('leaves a plain block list joined on a comma — the untouched common path', () => {
    const frontmatter = splitMarkdownFrontmatter(fenced(
      'description: Use when the user says "deploy": ship it',
      'tools:',
      '  - Read',
      '  - Grep',
    )).frontmatter;

    expect(frontmatter['tools']).toBe('Read, Grep');
  });

  it('still declines a nesting deeper than one mapping level', () => {
    // The boundary. Exactly one shape was added; a mapping whose field is
    // itself a mapping is still the opaque `''` this scanner has always given,
    // rather than a half-read structure a reader would act on.
    const frontmatter = splitMarkdownFrontmatter(fenced(
      'description: Use when the user says "deploy": ship it',
      'mcpServers:',
      '  - playwright:',
      '      env:',
      '        TOKEN: x',
    )).frontmatter;

    expect(frontmatter['mcpServers']).toBe('');
  });
});

describe('readPluginSkillFrontmatter', () => {
  it('carries a bundled skill\'s comma-bearing tool ceiling into the capability', async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'skills', 'claude-security'), { recursive: true });
    writeFileSync(join(root, 'skills', 'claude-security', 'SKILL.md'), fenced(
      'name: claude-security',
      'description: Security review',
      'allowed-tools:',
      '  - Agent(claude-security:scan-inventory, claude-security:scan-researcher)',
      '  - Read',
      'paths:',
      '  - src/**/*.ts',
      '  - "**/*.py, **/*.pyi"',
      'disable-model-invocation: true',
    ));

    const result = await readPluginSkillFrontmatter(root, 'skills/claude-security/SKILL.md');

    expect(result.allowedTools).toEqual([
      'Agent(claude-security:scan-inventory, claude-security:scan-researcher)',
      'Read',
    ]);
    expect(result.disableModelInvocation).toBe(true);
    expect(result.description).toBe('Security review');
    expect(result.paths).toEqual(['src/**/*.ts', '**/*.py', '**/*.pyi']);
  });

  it('keeps a block-list entry carrying an embedded double quote or an interpolation', async () => {
    // P2.12, on-disk 0.10.0. Two entry shapes the trimmed fixture above never
    // exercises, copied byte for byte out of the shipped
    // `skills/claude-security/SKILL.md`: one whose argument carries an embedded
    // double-quoted string, and one carrying `${CLAUDE_PLUGIN_ROOT}`. Both are
    // YAML PLAIN scalars — the `"` and the `${` are only special at the START of
    // a scalar — so both must round-trip whole.
    //
    // What a truncation costs, re-measured on HEAD 2026-08-25 (this comment
    // claimed "a silently narrowed ceiling", and both halves of that were
    // wrong). It is not a CEILING: since Q9 `allowed-tools` is a pre-approval
    // list, and `runtime-skill-content.ts` says so twelve lines from the
    // tokenizer — the list means "only that no tool skips its prompt, while
    // every tool remains callable". And it did not NARROW: the old tokenizer ate
    // the unbalanced paren, so `Bash(find . -maxdepth 1 -type d -name "` became
    // the bare name `Bash`, and a bare entry is the WIDEST grant there is
    // (`skillGrantAllows`: `if (!patterns) return true`) — one careful grant
    // silently became blanket prompt-free shell. `53007d740` closed that: the
    // same input now stays ONE entry with its paren, `parseSkillToolEntry`
    // yields `{ name: 'bash(find . -maxdepth 1 -type d -name ", read' }` — a
    // name no call can equal, so it grants nothing — the rest of the list is
    // swallowed with it, and the tokenizer's `warn` sink says so out loud. So a
    // truncation is now a LOST grant, loudly; the reason to pin these two shapes
    // is that losing one is still a plugin whose skill cannot do its job.
    const root = temporaryRoot();
    mkdirSync(join(root, 'skills', 'claude-security'), { recursive: true });
    writeFileSync(join(root, 'skills', 'claude-security', 'SKILL.md'), fenced(
      'name: claude-security',
      'description: Security review',
      'allowed-tools:',
      '  - Bash(find . -maxdepth 1 -type d -name "CLAUDE-SECURITY-2*")',
      '  - Bash(python3 "${CLAUDE_PLUGIN_ROOT}/scripts/render_report.py" *)',
      '  - Bash(GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git *)',
    ));

    const result = await readPluginSkillFrontmatter(root, 'skills/claude-security/SKILL.md');

    expect(result.allowedTools).toEqual([
      'Bash(find . -maxdepth 1 -type d -name "CLAUDE-SECURITY-2*")',
      'Bash(python3 "${CLAUDE_PLUGIN_ROOT}/scripts/render_report.py" *)',
      'Bash(GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git *)',
    ]);
    // The tokenizer is the second layer here too: none of the three may be
    // re-split on the commas and spaces inside their parentheses.
    expect(parseSkillToolList(result.allowedTools?.join('\n'))).toHaveLength(3);
  });
});

describe('a fence is a fence only at column 0 (P2.149/F7)', () => {
  const WITH_RULE = [
    '---',
    'name: deploy',
    'description: |',
    '  Run the deploy checklist.',
    '  ---',
    '  Then report.',
    'disallowed-tools: Bash(rm *), Write',
    'allowed-tools: Read',
    '---',
    '',
    '# Body',
  ].join('\n');

  // POSITIVE CONTROL: byte-identical except for the one indented `---`.
  const WITHOUT_RULE = WITH_RULE.replace('  ---\n', '');

  it('does not let a --- inside a block scalar end the frontmatter', () => {
    // Measured 2026-08-26: with the closer on `line.trim() === '---'` this file
    // yielded keys ["name","description"] only. `disallowed-tools` — a deny that
    // outranks `bypassPermissions` — was discarded INTO THE BODY, where it
    // became model-visible prose instead of a permission. Reverting the closer
    // to `.trim()` is the mutation this kills.
    const withRule = splitMarkdownFrontmatter(WITH_RULE);
    const control = splitMarkdownFrontmatter(WITHOUT_RULE);

    expect(Object.keys(withRule.frontmatter))
      .toEqual(['name', 'description', 'disallowed-tools', 'allowed-tools']);
    expect(withRule.body).toBe('# Body');
    // Both layers, on both fields.
    expect(parseSkillToolList(withRule.frontmatter['allowed-tools'])).toEqual(['Read']);
    expect(parseSkillToolList(withRule.frontmatter['disallowed-tools']))
      .toEqual(['Bash(rm *)', 'Write']);
    // The control differs only in the rule line, so the control's answer IS the
    // expected answer.
    expect(Object.keys(withRule.frontmatter)).toEqual(Object.keys(control.frontmatter));
    expect(withRule.frontmatter['disallowed-tools']).toBe(control.frontmatter['disallowed-tools']);
    // And the rule itself survived inside the scalar it belongs to.
    expect(withRule.frontmatter.description).toContain('---');
  });

  it('still treats an unterminated fence as no frontmatter at all', () => {
    // BOUNDARY: refusing an indented closer must not turn "unterminated" into
    // "swallow the whole file as frontmatter". Kills a pattern that matches
    // anything, and the removal of the `endIndex === -1` guard.
    const { frontmatter, body } = splitMarkdownFrontmatter([
      '---',
      'name: n',
      'allowed-tools: Read',
      '  ---',
      'trailing prose',
    ].join('\n'));

    expect(frontmatter).toEqual({});
    expect(body).toContain('allowed-tools: Read');
  });

  it('still closes on a fence carrying trailing whitespace', () => {
    // BOUNDARY the other way: trailing spaces are invisible to the author, so
    // `--- ` must still close. Kills tightening the pattern to /^---$/.
    const { frontmatter, body } = splitMarkdownFrontmatter('---\nname: n\n--- \nbody\n');
    expect(frontmatter).toEqual({ name: 'n' });
    expect(body).toBe('body');
  });

  it('does not accept an indented opener either', () => {
    // The two fences agree about what column means. Kills leaving the opener on
    // `.trim()` while fixing only the closer.
    const { frontmatter, body } = splitMarkdownFrontmatter('  ---\nname: n\n---\nbody\n');
    expect(frontmatter).toEqual({});
    expect(body).toContain('name: n');
  });
});

describe('a malformed grant list refuses itself on the skill path (P2.149/F8)', () => {
  it('returns an EMPTY grant and names the field instead of tokenizing JSON text', async () => {
    // Measured 2026-08-26 before this pass: `allowedTools: ['Read', '1']` — a
    // pre-approval for a tool literally named "1" — and nothing said so. The
    // mutation this kills is exactly that degradation (dropping the refusal and
    // letting `controls.allowedTools` through).
    const root = temporaryRoot();
    mkdirSync(join(root, 'skills', 's'), { recursive: true });
    writeFileSync(join(root, 'skills', 's', 'SKILL.md'), fenced(
      'name: s',
      'description: d',
      'allowed-tools:',
      '  - Read',
      '  - 1',
    ));

    const result = await readPluginSkillFrontmatter(root, 'skills/s/SKILL.md');

    expect(result.allowedTools).toEqual([]);
    expect(result.malformedGrantFields).toEqual(['allowed-tools']);
    // The rest of the frontmatter is unaffected: one bad field costs that field.
    expect(result.description).toBe('d');
  });

  it('refuses a mapping item the same way', async () => {
    const root = temporaryRoot();
    mkdirSync(join(root, 'skills', 's'), { recursive: true });
    writeFileSync(join(root, 'skills', 's', 'SKILL.md'), fenced(
      'name: s',
      'description: d',
      'allowed-tools:',
      '  - Read',
      '  - Bash: true',
    ));

    const result = await readPluginSkillFrontmatter(root, 'skills/s/SKILL.md');

    expect(result.allowedTools).toEqual([]);
    expect(result.malformedGrantFields).toEqual(['allowed-tools']);
  });

  it('leaves a YAML FLOW sequence alone — brackets are not the malformed shape', async () => {
    // BOUNDARY, and the one that matters most: `[Read, Grep]` is a legal flow
    // sequence the splitter hands over as a raw bracketed scalar, and the skill
    // path has always read it. Treating every `[`-leading value as malformed
    // would silently empty a working plugin's ceiling — the exact widening this
    // subsystem keeps producing. Kills dropping the `JSON.parse` test.
    const root = temporaryRoot();
    mkdirSync(join(root, 'skills', 's'), { recursive: true });
    writeFileSync(join(root, 'skills', 's', 'SKILL.md'), fenced(
      'name: s',
      'description: d',
      'allowed-tools: [Read, Grep]',
    ));

    const result = await readPluginSkillFrontmatter(root, 'skills/s/SKILL.md');

    expect(result.allowedTools).toEqual(['Read', 'Grep']);
    expect(result.malformedGrantFields).toBeUndefined();
  });

  it('leaves a well-formed JSON list of strings alone', async () => {
    // BOUNDARY: `["Read","Grep"]` parses as JSON AND every item is a non-empty
    // string, so there is nothing to refuse. Kills refusing on "parses as JSON".
    const root = temporaryRoot();
    mkdirSync(join(root, 'skills', 's'), { recursive: true });
    writeFileSync(join(root, 'skills', 's', 'SKILL.md'), fenced(
      'name: s',
      'description: d',
      'allowed-tools: ["Read", "Grep"]',
    ));

    const result = await readPluginSkillFrontmatter(root, 'skills/s/SKILL.md');

    expect(result.allowedTools).toEqual(['Read', 'Grep']);
    expect(result.malformedGrantFields).toBeUndefined();
  });
});
