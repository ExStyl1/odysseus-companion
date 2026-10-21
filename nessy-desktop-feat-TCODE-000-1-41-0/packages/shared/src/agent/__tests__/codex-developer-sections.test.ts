/**
 * UA3.5 — `codexDeveloperInstructions(outputStylePrompt?, sections?)`: codex never calls `getSystemPrompt`, so the
 * `create_board_task` guidance Pi and Claude read in "Session Self-Management" reaches codex as `sections.board`, and
 * only when the spawn OFFERS the tool (the session MCP server is spawned with the host-callback bridge).
 *
 * No `mock.module`: the composition is a pure function, and the offer predicate is driven on the prototype with a
 * planted `buildSessionMcpSpec` (the one collaborator it reads), with the un-planted arm (no spec) beside it.
 */
import { describe, expect, it } from 'bun:test';
import { CodexAgent, codexDeveloperInstructions, type CodexDeveloperSections } from '../codex-agent.ts';
import { boardTaskDeveloperSection, CREATE_BOARD_TASK_GUIDANCE, getSystemPrompt, gitAttributionSection, pagesPromptSection } from '../../prompts/system.ts';
import { resolveGitAttribution } from '../../config/preferences.ts';

const developerSections = (spec: unknown, port: number | undefined): CodexDeveloperSections | undefined =>
  (CodexAgent.prototype as unknown as { developerSections(this: unknown, port: number | undefined): CodexDeveloperSections | undefined })
    .developerSections.call({ buildSessionMcpSpec: () => spec }, port);

describe('UA3.5 — the board guidance on codex\'s one prose channel', () => {
  it('positive: sections.board lands after the operating guidance and before the style', () => {
    const composed = codexDeveloperInstructions('## Output Style: Haiku\nAnswer in haiku.', { board: boardTaskDeveloperSection() });
    const git = gitAttributionSection(resolveGitAttribution()).trim();
    const board = composed.indexOf(CREATE_BOARD_TASK_GUIDANCE);
    expect(board).toBeGreaterThan(-1);
    expect(composed.indexOf('## Board Tasks')).toBeGreaterThan(composed.indexOf(git));
    expect(board).toBeLessThan(composed.indexOf('## Output Style: Haiku'));
  });

  it('negative: without sections the composition is byte-identical to the one-argument call and names no board tool', () => {
    expect(codexDeveloperInstructions(undefined, undefined)).toBe(codexDeveloperInstructions());
    expect(codexDeveloperInstructions(undefined, {})).toBe(codexDeveloperInstructions());
    expect(codexDeveloperInstructions()).not.toContain('create_board_task');
  });

  it('the offer predicate: board only when the spawn has the bridge port AND a session MCP spec', () => {
    // UA6.5 — the Pages section rides the same predicate (the six page tools are bridged too).
    expect(developerSections({ command: 'node' }, 4711)).toEqual({ board: boardTaskDeveloperSection(), pages: pagesPromptSection() });
    // A codex spawn without the host-callback bridge does not offer the tool, so it gets no guidance for it.
    expect(developerSections({ command: 'node' }, undefined)).toBeUndefined();
    // No session MCP server at all (no packaged session server path): nothing is offered.
    expect(developerSections(undefined, 4711)).toBeUndefined();
  });

  it('one text on every slot: the Pi/Claude paragraph is the codex section\'s body, naming no checklist tool', () => {
    // The Pi and Claude slot: the same paragraph under "Session Self-Management".
    const prompt = getSystemPrompt();
    expect(prompt).toContain(`**Board tasks:**\n${CREATE_BOARD_TASK_GUIDANCE}`);
    expect(prompt.indexOf(CREATE_BOARD_TASK_GUIDANCE)).toBeGreaterThan(prompt.indexOf('## Session Self-Management'));
    expect(boardTaskDeveloperSection()).toBe(`## Board Tasks\n\n${CREATE_BOARD_TASK_GUIDANCE}`);
    expect(CREATE_BOARD_TASK_GUIDANCE).toContain('your in-session checklist or plan tool');
    for (const tool of ['TodoWrite', 'update_plan', 'TaskCreate']) expect(CREATE_BOARD_TASK_GUIDANCE).not.toContain(tool);
  });
});
