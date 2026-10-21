import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import {
  CUSTOM_SLASH_COMMAND_PREFIX,
  MAX_STACKED_SKILL_COMMANDS,
  findCustomSlashCommand,
  isCustomSlashCommandId,
  isSkillSlashCommandId,
  leadingSlashCommandTokens,
  listCustomSlashCommands,
  pluginPromptCommandId,
  pluginPromptCommandLabel,
  selectSkillSlashCommands,
  skillEndsCommandStack,
  skillSlashCommandBody,
  skillSlashCommandId,
  skillSlashCommandName,
  toCustomSlashCommandSummary,
} from './custom-commands.ts';

describe('listCustomSlashCommands', () => {
  function withTempWorkspace(fn: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), 'nessy-custom-slash-'));
    try {
      fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('discovers markdown commands from .nessy-agent and .agents command dirs', () => {
    withTempWorkspace((root) => {
      const nessyCommands = join(root, '.nessy-agent', 'commands');
      const agentsCommands = join(root, '.agents', 'commands');
      mkdirSync(nessyCommands, { recursive: true });
      mkdirSync(agentsCommands, { recursive: true });

      writeFileSync(join(nessyCommands, 'review-pr.md'), [
        '---',
        'description: Review this branch before handoff',
        'model: tgpt/reviewer',
        '---',
        'Review the current branch and list blocking issues first.',
      ].join('\n'));
      writeFileSync(join(agentsCommands, 'fix-tests.md'), 'Fix the failing tests and summarize the root cause.');

      const commands = listCustomSlashCommands({ workspaceRootPath: root });

      expect(commands.map(command => command.name)).toEqual(['fix-tests', 'review-pr']);
      expect(commands.find(command => command.name === 'review-pr')).toMatchObject({
        id: 'custom:review-pr',
        label: '/review-pr',
        description: 'Review this branch before handoff',
        model: 'tgpt/reviewer',
        source: 'nessy-agent',
      });
      expect(commands.find(command => command.name === 'fix-tests')?.body).toContain('Fix the failing tests');
    });
  });

  /**
   * P6.612 — the native arm of P6.406. `skills.md#frontmatter-reference`:
   * "`argument-hint` | No | Hint shown during autocomplete to indicate expected
   * arguments. Example: `[issue-number]` or `[filename] [format]`.", bound to
   * command files by the same page: "Files in `.claude/commands/` support the
   * same frontmatter, except `name` and `paths`, which Claude Code ignores in a
   * command file."
   *
   * Both directions in one case, because the field's contract is that ABSENCE
   * is meaningful: a command with no hint must omit the key rather than carry
   * an empty string, or the composer cannot tell the two apart.
   */
  it('parses argument-hint frontmatter and omits the field entirely when the file has none', () => {
    withTempWorkspace((root) => {
      const commandsDir = join(root, '.nessy-agent', 'commands');
      mkdirSync(commandsDir, { recursive: true });

      writeFileSync(join(commandsDir, 'triage.md'), [
        '---',
        'description: Triage one issue',
        'argument-hint: "[issue-number]"',
        '---',
        'Triage the issue.',
      ].join('\n'));
      writeFileSync(join(commandsDir, 'plain.md'), [
        '---',
        'description: No hint here',
        '---',
        'Do the thing.',
      ].join('\n'));
      // An empty value is a written key with nothing after it, which must read
      // as "no hint" rather than as a hint that renders as blank space.
      writeFileSync(join(commandsDir, 'blank.md'), [
        '---',
        'argument-hint: ""',
        '---',
        'Do the other thing.',
      ].join('\n'));

      const commands = listCustomSlashCommands({ workspaceRootPath: root });
      const byName = (name: string) => commands.find(command => command.name === name);

      expect(byName('triage')?.argumentHint).toBe('[issue-number]');
      expect(byName('plain')).not.toHaveProperty('argumentHint');
      expect(byName('blank')).not.toHaveProperty('argumentHint');

      // The composer projection is the step that actually reaches the menu, so
      // the field is asserted THERE too — parsing it and dropping it one line
      // later is the exact defect P6.406 found on the plugin side.
      expect(toCustomSlashCommandSummary(byName('triage')!).argumentHint).toBe('[issue-number]');
      expect(toCustomSlashCommandSummary(byName('plain')!)).not.toHaveProperty('argumentHint');
    });
  });

  it('ignores commands in a populated legacy .nessy directory', () => {
    withTempWorkspace((root) => {
      const legacyCommands = join(root, '.nessy', 'commands');
      mkdirSync(legacyCommands, { recursive: true });
      writeFileSync(join(legacyCommands, 'legacy.md'), 'Must never load');

      expect(listCustomSlashCommands({ workspaceRootPath: root })).toEqual([]);
    });
  });

  it('uses working directory commands before workspace commands with the same name', () => {
    withTempWorkspace((root) => {
      const projectRoot = join(root, 'packages', 'app');
      mkdirSync(join(root, '.nessy-agent', 'commands'), { recursive: true });
      mkdirSync(join(projectRoot, '.nessy-agent', 'commands'), { recursive: true });

      writeFileSync(join(root, '.nessy-agent', 'commands', 'ship.md'), 'Workspace ship command');
      writeFileSync(join(projectRoot, '.nessy-agent', 'commands', 'ship.md'), 'Project ship command');

      const commands = listCustomSlashCommands({
        workspaceRootPath: root,
        workingDirectory: projectRoot,
      });

      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        name: 'ship',
        body: 'Project ship command',
      });
    });
  });

  it('resolves only custom slash command ids', () => {
    const commands = [{
      id: 'custom:review' as const,
      name: 'review',
      label: '/review',
      body: 'Review',
      path: '/tmp/review.md',
      source: 'nessy-agent' as const,
    }];

    expect(isCustomSlashCommandId('custom:review')).toBe(true);
    expect(isCustomSlashCommandId('review')).toBe(false);
    expect(findCustomSlashCommand(commands, 'custom:review')?.name).toBe('review');
    expect(findCustomSlashCommand(commands, 'review')).toBeUndefined();
  });

  it('projects only safe composer metadata', () => {
    const summary = toCustomSlashCommandSummary({
      id: 'custom:review',
      name: 'review',
      label: '/review',
      description: 'Review the current branch',
      model: 'tgpt/reviewer',
      body: 'distinctive-private-command-body',
      path: '/private/project/.nessy-agent/commands/review.md',
      source: 'nessy-agent',
    });

    expect(summary).toEqual({
      id: 'custom:review',
      name: 'review',
      label: '/review',
      description: 'Review the current branch',
      model: 'tgpt/reviewer',
    });
    expect(JSON.stringify(summary)).not.toContain('distinctive-private-command-body');
    expect(JSON.stringify(summary)).not.toContain('/private/project');
  });
});

describe('plugin prompt-command namespacing', () => {
  it('namespaces the id as custom:plugin:<pluginKey>:<name> and the label as /<plugin-name>:<name>', () => {
    const pluginKey = 'bWFya2V0.cGx1Z2lu';
    expect(pluginPromptCommandId(pluginKey, 'summarize')).toBe(`custom:plugin:${pluginKey}:summarize`);
    expect(isCustomSlashCommandId(pluginPromptCommandId(pluginKey, 'summarize'))).toBe(true);
    expect(pluginPromptCommandLabel('Linear Helper', 'summarize')).toBe('/linear-helper:summarize');
  });

  it('never collides with a native command id/label for the same bare name', () => {
    const pluginKey = 'bWFya2V0.cGx1Z2lu';
    const pluginId = pluginPromptCommandId(pluginKey, 'review');
    const nativeId: string = `${CUSTOM_SLASH_COMMAND_PREFIX}review`;
    expect(pluginId).not.toBe(nativeId);
    expect(pluginPromptCommandLabel('Linear Helper', 'review')).not.toBe('/review');
  });
});

describe('skill-derived slash commands', () => {
  const skill = (logicalName: string, over: Record<string, unknown> = {}) => ({
    key: `skill:ws:${logicalName}`,
    logicalName,
    selectedAsUnqualifiedAlias: true,
    ...over,
  });

  it('registers a slash command per invocable skill', () => {
    const selected = selectSkillSlashCommands([skill('review'), skill('deploy')], []);

    expect(selected.map(entry => entry.id)).toEqual([
      skillSlashCommandId('deploy'),
      skillSlashCommandId('review'),
    ]);
    expect(skillSlashCommandId('review')).toBe('custom:skill:review');
    expect(isCustomSlashCommandId(skillSlashCommandId('review'))).toBe(true);
  });

  it('does not register one for a skill marked user-invocable: false', () => {
    const selected = selectSkillSlashCommands([skill('internal', { userInvocable: false })], []);

    expect(selected).toEqual([]);
  });

  it('drops a skillOverrides "off" skill, and ONLY that state, from the menu', () => {
    // skills.md:667-:672 — `off` is the one row whose "In `/` menu" column says
    // Hidden. `name-only` and `user-invocable-only` both stay listed, with their
    // descriptions: the table's other column governs the MODEL's listing, not
    // this one. `:676` widens the same `off` to the command lists advertised to
    // remote and SDK callers, which in this fork is the same single RPC.
    const selected = selectSkillSlashCommands([
      skill('hidden', { overrideState: 'off', description: 'hidden description' }),
      skill('trimmed', { overrideState: 'name-only', description: 'trimmed description' }),
      skill('useronly', { overrideState: 'user-invocable-only', description: 'useronly description' }),
      skill('plain', { overrideState: 'on', description: 'plain description' }),
    ], []);

    expect(selected.map(entry => entry.name)).toEqual(['plain', 'trimmed', 'useronly']);
    expect(selected.map(entry => entry.description)).toEqual([
      'plain description',
      'trimmed description',
      'useronly description',
    ]);
  });

  it('keeps the bare name against a command file, and yields it to a reserved name', () => {
    // R75 · f144 — this case used to assert the opposite, and the opposite is
    // what the docs forbid. `skills.md:122` / `slash-commands.md:122`, whole
    // line, end with "if a skill and a command share a name, the skill takes
    // precedence"; `claude-directory.md:293` repeats it. A command file's name
    // therefore never reaches this function any more — the caller filters the
    // command out of its own list instead.
    expect(selectSkillSlashCommands([skill('review'), skill('audit')], []).map(entry => entry.name))
      .toEqual(['audit', 'review']);

    // What DOES still reserve a name: a workflow recipe. No Claude page rules on
    // skill-vs-workflow either way, so the pre-existing behaviour stands rather
    // than a new rule being invented.
    expect(selectSkillSlashCommands([skill('review'), skill('audit')], ['review']).map(entry => entry.name))
      .toEqual(['audit']);
  });

  it('offers /review as an alias of /code-review, carrying the same body (w32.md:90)', () => {
    // `code-review.md:279`, whole line: "`/review` is an alias of
    // `/code-review`; before v2.1.223, it was a separate command that ran a
    // single-pass, read-only review of a GitHub pull request." The weekly
    // changelog line that binds us is `2026-w32.md:90`: "`/review` is now an
    // alias of `/code-review`, and `/code-review` with no effort level reuses
    // the level you typed last" — the SECOND half is out of scope here and is a
    // recorded deviation (conversation-scoped reuse, `review-tool.ts:435-441`).
    //
    // The alias is a COPY of the target's selected entry rather than a second
    // command: same `[skill:...]` body, so `/review 1234` expands byte-for-byte
    // to what `/code-review 1234` expands to and `$ARGUMENTS` carries the tail
    // verbatim through the one expansion both share.
    const selected = selectSkillSlashCommands([skill('code-review', { description: 'Review a diff' })], []);

    expect(selected.map(entry => entry.name)).toEqual(['code-review', 'review']);
    const target = selected.find(entry => entry.name === 'code-review')!;
    const alias = selected.find(entry => entry.name === 'review')!;
    expect(alias.body).toBe(target.body);
    expect(alias.body).toBe(skillSlashCommandBody('code-review'));
    expect(alias.description).toBe(target.description);
    expect(alias.label).toBe('/review');
    expect(alias.id).toBe(skillSlashCommandId('review'));
    expect(alias.id).not.toBe(target.id);
  });

  it('withholds the alias wherever the target itself is withheld', () => {
    // Minted from the SELECTED entry, so every rule that keeps `/code-review`
    // out of the menu keeps `/review` out with it: `user-invocable: false`, a
    // `skillOverrides` state of `off`, and the skill not being installed at
    // all. That is how the alias INHERITS the target's invocation policy
    // instead of restating it in a second place where the two could drift.
    expect(selectSkillSlashCommands([skill('code-review', { userInvocable: false })], [])).toEqual([]);
    expect(selectSkillSlashCommands([skill('code-review', { overrideState: 'off' })], [])).toEqual([]);
    expect(selectSkillSlashCommands([skill('deploy')], []).map(entry => entry.name)).toEqual(['deploy']);
  });

  it('yields /review to anything that already owns the bare name', () => {
    // Aliases are added in a second pass over the names nothing else claimed,
    // so a real skill called `review` and a reserved workflow recipe both keep
    // the name and no existing `/review` silently changes meaning.
    expect(selectSkillSlashCommands([skill('code-review'), skill('review')], []).map(entry => entry.body))
      .toEqual([skillSlashCommandBody('code-review'), skillSlashCommandBody('review')]);
    expect(selectSkillSlashCommands([skill('code-review')], ['review']).map(entry => entry.name))
      .toEqual(['code-review']);
  });

  it('addresses the skill through the user-invocation marker path', () => {
    // The body is the same `[skill:...]` marker a user would type, so the
    // existing pinned-materialization path runs it — no second implementation.
    expect(skillSlashCommandBody('review')).toContain('[skill:review]');
    expect(skillSlashCommandBody('review')).toContain('$ARGUMENTS');
  });

  it('addresses a shadowed skill by its qualified key', () => {
    const selected = selectSkillSlashCommands(
      [skill('honey', { key: 'plugin:pk:skill.honey', selectedAsUnqualifiedAlias: false })],
      [],
    );

    expect(selected[0]!.body).toContain('[skill:plugin:pk:skill.honey]');
  });

  it('never collides with a native or plugin command id for the same bare name', () => {
    const nativeId: string = `${CUSTOM_SLASH_COMMAND_PREFIX}review`;
    expect(skillSlashCommandId('review')).not.toBe(nativeId);
    expect(skillSlashCommandId('review')).not.toBe(pluginPromptCommandId('pk', 'review'));
  });

  it('offers a shadowed NESTED skill under /apps/web:deploy instead of dropping it', () => {
    // skills.md:132, whole line: "Typing `/deploy` runs the project-root skill.
    // Type the qualified name `/apps/web:deploy` to run the nested variant
    // explicitly." Before R79 the loser left the menu entirely and was reachable
    // only by typing its internal capability key.
    const selected = selectSkillSlashCommands([
      skill('deploy'),
      skill('deploy', {
        key: 'skill::project::nested:apps/web::deploy',
        selectedAsUnqualifiedAlias: false,
        directoryQualifier: 'apps/web',
      }),
    ], []);

    expect(selected.map(entry => entry.name)).toEqual(['apps/web:deploy', 'deploy']);
    expect(selected.map(entry => entry.label)).toEqual(['/apps/web:deploy', '/deploy']);
    // Both bodies must resolve: the bare alias for the root, the qualified name
    // for the nested one — never the raw key.
    expect(selected[0]!.body).toContain('[skill:apps/web:deploy]');
    expect(selected[1]!.body).toContain('[skill:deploy]');
    // Two nested variants of one slug must not share an id.
    expect(selected[0]!.id).not.toBe(selected[1]!.id);
    expect(selected[0]!.id).toBe(skillSlashCommandId('apps/web:deploy'));
  });

  it('keeps the bare name for a nested skill nobody contests', () => {
    const selected = selectSkillSlashCommands(
      [skill('lonely', { directoryQualifier: 'apps/web' })],
      [],
    );

    expect(selected.map(entry => entry.name)).toEqual(['lonely']);
    expect(selected[0]!.body).toContain('[skill:lonely]');
  });

  it('still lets a reserved name win the bare name', () => {
    // The qualified form must not become a way around `reservedNames`: the
    // nested variant takes its qualified name, and `/deploy` stays the workflow
    // recipe's. (The reservation used to be a command file's — inverted by
    // R75 · f144; the mechanism it guards is unchanged.)
    const selected = selectSkillSlashCommands([
      skill('deploy', {
        key: 'skill::project::nested:apps/web::deploy',
        selectedAsUnqualifiedAlias: false,
        directoryQualifier: 'apps/web',
      }),
      skill('deploy'),
    ], ['deploy']);

    expect(selected.map(entry => entry.name)).toEqual(['apps/web:deploy']);
  });
});

describe('stacked skill invocation', () => {
  it('recognises exactly the ids skillSlashCommandId mints, and recovers the bare name', () => {
    expect(isSkillSlashCommandId(skillSlashCommandId('review'))).toBe(true);
    expect(skillSlashCommandName(skillSlashCommandId('review'))).toBe('review');
    // A namespaced key keeps its colons — the name is everything after the prefix.
    expect(skillSlashCommandName(skillSlashCommandId('plugin:pk:honey'))).toBe('plugin:pk:honey');

    for (const foreign of [
      `${CUSTOM_SLASH_COMMAND_PREFIX}review`,
      pluginPromptCommandId('pk', 'review'),
      `${CUSTOM_SLASH_COMMAND_PREFIX}workflow:audit`,
      `${CUSTOM_SLASH_COMMAND_PREFIX}mcp:billing:invoice`,
      // The bare prefix names no skill.
      `${CUSTOM_SLASH_COMMAND_PREFIX}skill:`,
      'skill:review',
    ]) {
      expect(isSkillSlashCommandId(foreign)).toBe(false);
      expect(skillSlashCommandName(foreign)).toBeNull();
    }
  });

  it('caps a run at six, the first plus five more', () => {
    // `commands.md:13`: "Up to six skills can be chained." `skills.md:490`:
    // "Claude Code expands the first skill plus up to five more stacked after it."
    expect(MAX_STACKED_SKILL_COMMANDS).toBe(6);
  });

  it('ends a run at a skill whose own arguments may start with a slash command', () => {
    // `skills.md:490` names two run-enders. `/loop` is live here — `loop` is a
    // bundled skill and `/loop /babysit-prs` is its documented no-interval form,
    // so that `/babysit-prs` is loop's argument, not a sibling invocation.
    expect(skillEndsCommandStack('loop')).toBe(true);
    expect(skillEndsCommandStack('LOOP')).toBe(true);
    // The other run-ender is the forked-subagent mode, which this fork does not
    // have at all — so `code-review` is an ordinary inline skill and stacks,
    // exactly as the page says `/code-review` did before v2.1.218.
    expect(skillEndsCommandStack('code-review')).toBe(false);
    expect(skillEndsCommandStack('write-tests')).toBe(false);
  });

  it('peels the leading run of whitespace-delimited slash tokens and reports each remaining tail', () => {
    expect(leadingSlashCommandTokens('/skill-b /skill-c do XYZ', 5)).toEqual([
      { name: 'skill-b', rest: '/skill-c do XYZ' },
      { name: 'skill-c', rest: 'do XYZ' },
    ]);
    // No trailing text at all: the last token's rest is the empty string.
    expect(leadingSlashCommandTokens('/skill-b', 5)).toEqual([{ name: 'skill-b', rest: '' }]);
    // The run is LEADING only — a slash further along is argument text.
    expect(leadingSlashCommandTokens('do XYZ /skill-b', 5)).toEqual([]);
    expect(leadingSlashCommandTokens('', 5)).toEqual([]);
    // Delimited by whitespace, so a path is ONE token that names no skill rather
    // than three whose first happens to match one.
    expect(leadingSlashCommandTokens('/usr/bin/env python', 5)).toEqual([
      { name: 'usr/bin/env', rest: 'python' },
    ]);
    // A bare slash is not a token.
    expect(leadingSlashCommandTokens('/ skill-b', 5)).toEqual([]);
  });

  it('never reports more tokens than the limit allows', () => {
    const tail = '/one /two /three /four /five /six /seven tail';
    expect(leadingSlashCommandTokens(tail, MAX_STACKED_SKILL_COMMANDS - 1).map(token => token.name))
      .toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(leadingSlashCommandTokens(tail, 0)).toEqual([]);
  });
});
