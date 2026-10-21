import { describe, expect, it } from 'bun:test';
import { normalizeMermaidSource, validateMermaidSyntax, validateSkillContent } from './validation.ts';

describe('Mermaid validation helpers', () => {
  it('normalizes YAML frontmatter before diagram syntax', () => {
    expect(normalizeMermaidSource('---\ntitle: Demo\n---\ngraph LR\nA-->B')).toBe('graph LR\nA-->B');
  });

  it('accepts xychart-beta as a Mermaid diagram type', () => {
    expect(validateMermaidSyntax('xychart-beta\n  x-axis [Jan, Feb]\n  bar [10, 20]').valid).toBe(true);
  });

  it('accepts YAML frontmatter before a supported diagram type', () => {
    expect(validateMermaidSyntax('---\ntitle: Demo\n---\nsequenceDiagram\nA->>B: hello').valid).toBe(true);
  });

  it('still rejects unknown diagram types', () => {
    const result = validateMermaidSyntax('unknownDiagram\nA-->B');
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain('Unknown diagram type');
  });
});

/**
 * R30a Task 5 — `skill_validate` used to be `.passthrough()` with a four-field
 * schema, so a misspelled key or an unclosed `Bash(` validated clean. That was
 * harmless while `allowed-tools` was inert; since R17b it is an enforced grant,
 * so a rule that can never match is a permission bug the author never sees.
 */
describe('validateSkillContent frontmatter checks', () => {
  const skill = (...lines: string[]) =>
    validateSkillContent(['---', 'name: Demo', 'description: A demo skill', ...lines, '---', '', 'Body.'].join('\n'), 'demo');

  it('accepts every documented field', () => {
    const result = skill(
      'argument-hint: "[issue-number]"',
      'arguments: [issue, branch]',
      'allowed-tools: Read Grep',
      'disallowed-tools: Bash',
      'disable-model-invocation: yes',
      'user-invocable: off',
      'model: inherit',
      'effort: xhigh',
      'paths: "**/*.py"',
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('warns on an unknown key rather than failing the file', () => {
    // A skill written for a newer client must still load, so this is a warning.
    const result = skill('allowed-tool: Read');
    expect(result.valid).toBe(true);
    expect(result.warnings.map(warning => warning.path)).toEqual(['allowed-tool']);
    expect(result.warnings[0]?.message).toContain('will be ignored');
  });

  it('warns on a documented field this runtime ignores, and says which', () => {
    // These validated CLEAN before U-E, which told the author the key was
    // supported. Their neighbour `agent` is enforced, which is why they looked
    // it. The warning names the field as documented, not as a typo.
    for (const line of ['hooks: {}', 'shell: powershell']) {
      const key = line.split(':')[0]!;
      const result = skill(line);
      expect(result.valid).toBe(true);
      expect(result.warnings.map(warning => warning.path)).toEqual([key]);
      expect(result.warnings[0]?.message).toContain('documented field this runtime does not implement');
      expect(result.warnings[0]?.message).not.toContain('Unknown');
    }
    // `agent` IS enforced, so it must stay silent.
    expect(skill('agent: reviewer').warnings).toEqual([]);
  });

  it('stops warning about context/background now that R69b dispatches them', () => {
    // The pair moves out of the ignored list TOGETHER: `background` "only
    // applies with `context: fork`" (`skills.md:269`), so a build that read one
    // and warned about the other would be reporting its own half-support.
    expect(skill('context: fork').warnings).toEqual([]);
    expect(skill('context: fork\nbackground: false').warnings).toEqual([]);
    // `:267` — `fork` is the only documented value, so anything else is an
    // error the author can act on rather than a silently inert field.
    const wrong = skill('context: inline');
    expect(wrong.valid).toBe(false);
    expect(wrong.errors.map(error => error.path)).toContain('context');
  });

  it('rejects an unclosed tool pattern and an undocumented effort level', () => {
    const unclosed = skill('allowed-tools: Bash(git');
    expect(unclosed.valid).toBe(false);
    expect(unclosed.errors.map(error => error.path)).toContain('allowed-tools');

    const badEffort = skill('effort: xhi');
    expect(badEffort.valid).toBe(false);
    expect(badEffort.errors[0]?.message).toContain('low, medium, high, xhigh, max');
  });
});
