/**
 * UA4.10 — the board guidance reaches the model on all three slots exactly when `create_board_task` is offered there,
 * and it now names the board guide (`DOC_REFS.board` → `apps/electron/resources/docs/board.md`): Pi and Claude through
 * `getSystemPrompt` ("Session Self-Management" → "Board tasks", plus the Task Board row of the Configuration
 * Documentation table; the tool is offered there unconditionally), codex through `codexDeveloperInstructions`'
 * `sections.board` (codex never calls `getSystemPrompt`), only when the spawn has the host-callback bridge — the same
 * predicate that offers the tool (UA3.5).
 *
 * No `mock.module`: the compositions are pure functions, and the codex offer predicate is driven on the prototype with
 * a planted `buildSessionMcpSpec` (the one collaborator it reads), with the un-planted arms (no port, no spec) beside it.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionToolNames } from '@nessy-agent/session-tools-core';
import { CodexAgent, codexDeveloperInstructions, type CodexDeveloperSections } from '../codex-agent.ts';
import { CREATE_BOARD_TASK_GUIDANCE, getSystemPrompt } from '../../prompts/system.ts';
import { DOC_REFS } from '../../docs/index.ts';

const developerSections = (spec: unknown, port: number | undefined): CodexDeveloperSections | undefined =>
  (CodexAgent.prototype as unknown as { developerSections(this: unknown, port: number | undefined): CodexDeveloperSections | undefined })
    .developerSections.call({ buildSessionMcpSpec: () => spec }, port);

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const GUIDE = join(REPO, 'apps', 'electron', 'resources', 'docs', 'board.md');
// Assembled at runtime so this file never carries the Craft host it forbids (UA6.6's guard scans packages/).
const CRAFT_HOST = ['thecraft', 'agents'].join('');

/** The Claude slot: `claude-agent.ts` passes no preset and no backend name. */
const claudeSlot = (): string => getSystemPrompt(undefined, undefined, undefined, undefined, undefined, undefined);
/** The Pi slot: `pi-agent.ts` passes its configured preset (default) and the backend name 'Nessy Backend'. */
const piSlot = (): string => getSystemPrompt(undefined, undefined, undefined, undefined, 'default', 'Nessy Backend');
/** The codex slot for a spawn WITH the host-callback bridge (a port and a session MCP spec). */
const codexSlot = (): string => codexDeveloperInstructions(undefined, developerSections({ command: 'node' }, 4711));
const ROW = `| Task Board | \`${DOC_REFS.board}\` | When the user asks about the task board, tasks or subtasks |`;

describe('positive — the board section names the guide on all three slots when the tool is offered', () => {
  it('Pi, Claude and bridged codex carry the guidance with the guide; Pi and Claude carry the table row', () => {
    expect(CREATE_BOARD_TASK_GUIDANCE).toContain(`\`${DOC_REFS.board}\``);
    for (const [slot, text] of [['claude', claudeSlot()], ['pi', piSlot()], ['codex', codexSlot()]] as const) {
      expect([slot, text.includes(CREATE_BOARD_TASK_GUIDANCE)]).toEqual([slot, true]);
      expect([slot, text.includes(DOC_REFS.board)]).toEqual([slot, true]);
    }
    for (const [slot, text] of [['claude', claudeSlot()], ['pi', piSlot()]] as const) {
      expect([slot, text.includes(ROW)]).toEqual([slot, true]);
      // The row sits in the Configuration Documentation table, right after Statuses.
      expect([slot, text.includes(`workflow states |\n${ROW}`)]).toEqual([slot, true]);
    }
    expect(codexSlot()).toContain('## Board Tasks');
  });

  it('the tool IS offered on Pi and Claude', () => {
    expect(getSessionToolNames({ projection: 'pi' }).has('create_board_task')).toBe(true);
    expect(getSessionToolNames({}).has('create_board_task')).toBe(true);
  });

  it('DOC_REFS.board points at the installed copy of a guide that ships, and the guide says the agent never runs or closes a task', () => {
    expect(DOC_REFS.board).toBe(`${DOC_REFS.appRoot}/docs/board.md`);
    expect(existsSync(GUIDE)).toBe(true);
    const guide = readFileSync(GUIDE, 'utf-8');
    expect(guide).toContain('create_board_task');
    expect(guide).toContain('**never runs it**');
    expect(guide).toContain('Close a card');
    expect(guide).toContain('${nodes.<id>.output}');
  });
});

describe('negative — absent where the tool is not offered; tasks still means automations; no Craft host', () => {
  it('a codex spawn WITHOUT the host-callback bridge (or with no session MCP server) gets no board section and no guide', () => {
    expect(developerSections({ command: 'node' }, undefined)).toBeUndefined();
    expect(developerSections(undefined, 4711)).toBeUndefined();
    const bare = codexDeveloperInstructions(undefined, developerSections({ command: 'node' }, undefined));
    expect(bare).not.toContain('## Board Tasks');
    expect(bare).not.toContain('create_board_task');
    expect(bare).not.toContain(DOC_REFS.board);
  });

  it('DOC_REFS.tasks still points at automations.md (upstream\'s key keeps its meaning; the board guide is its own key)', () => {
    expect(DOC_REFS.tasks).toBe(`${DOC_REFS.appRoot}/docs/automations.md`);
    expect(DOC_REFS.tasks).not.toBe(DOC_REFS.board);
  });

  it('no Craft host in the guide or the guidance (with a planted CONTROL)', () => {
    const guide = readFileSync(GUIDE, 'utf-8');
    expect(`see ${CRAFT_HOST}.com`.includes(CRAFT_HOST)).toBe(true); // CONTROL: the needle can match
    for (const text of [guide, CREATE_BOARD_TASK_GUIDANCE]) expect(text.toLowerCase()).not.toContain(CRAFT_HOST);
  });
});

/**
 * UA4.10 follow-up — the guide's "## Permission mode" section is model-facing (every slot that offers `create_board_task`
 * points at it), so it must describe the ceiling UA4.2 committed (e424b9e77, `SessionManager.clampChildPermissionModeToParent`)
 * and not the spec's stronger reading: the ceiling binds the nodes the Conductor dispatches (keyed on `taskNodeId`), at
 * dispatch and at every later mode change; lowering the orchestrator caps a node's NEXT change and NEXT dispatch, not a
 * running node; a quick-add subtask (**Add subtask**: a `parentSessionId` and no node) and a node whose orchestrator is gone
 * have no ceiling.
 */
describe('Permission mode — the guide describes the ceiling the host enforces, residues included', () => {
  const section = (guide: string): string => {
    const start = guide.indexOf('## Permission mode');
    const end = guide.indexOf('\n## ', start + 1);
    return guide.slice(start, end < 0 ? undefined : end);
  };
  // The 39fa70bdc sentence: promised a re-clamp of running nodes and a cap on every subtask.
  const OVER_PROMISE = "The task's permission mode is a ceiling: no subtask ever runs above its orchestrator's mode, also when the orchestrator's mode is lowered later.";
  const NEEDLES = ['no subtask ever runs above', "also when the orchestrator's mode is lowered later"];

  it('positive — names the nodes, the next-change/next-dispatch timing, the running-node residue and both exemptions', () => {
    const text = section(readFileSync(GUIDE, 'utf-8'));
    expect(text.startsWith('## Permission mode')).toBe(true);
    for (const needle of [
      'the subtasks the orchestrator dispatches',
      "next mode change and its next dispatch",
      'already running keeps its mode',
      '**Add subtask** is the user\'s own session',
      'whose orchestrator is gone',
    ]) expect([needle, text.includes(needle)]).toEqual([needle, true]);
  });

  it('negative — the over-promise is absent (with a CONTROL: the needles match the sentence UA4.10 first shipped)', () => {
    for (const needle of NEEDLES) expect([needle, OVER_PROMISE.includes(needle)]).toEqual([needle, true]); // CONTROL
    const guide = readFileSync(GUIDE, 'utf-8');
    for (const needle of NEEDLES) expect([needle, guide.includes(needle)]).toEqual([needle, false]);
  });
});

/**
 * UA5.2 follow-up — the host closure (`server-core/src/tasks/create-board-task.ts`, f7a2b68f4) accepts a project
 * whose folder carries the caller's STABLE projectKey (spec §10), so the guidance every slot carries and the guide it
 * points at name that project instead of "your own project; anything wider is refused".
 */
describe('UA5.2 — the guidance and the guide name the project bound to your own folder', () => {
  const GUIDE_LINE = (guide: string): string => guide.split('\n').find(line => line.startsWith('- The task stays in your own working folder')) ?? '';

  it('positive — both name the folder-bound project and still say anything wider is refused', () => {
    expect(CREATE_BOARD_TASK_GUIDANCE).toContain('your own project or one bound to your own folder');
    expect(CREATE_BOARD_TASK_GUIDANCE).toContain('anything wider is refused');
    const line = GUIDE_LINE(readFileSync(GUIDE, 'utf-8'));
    expect(line).toContain('or another project bound to the same folder');
    expect(line).toContain('Anything wider is refused');
  });

  it('negative — the f7a2b68f4 wording (folder, project and connection as one "own" set) is gone (with a CONTROL)', () => {
    const STALE = 'The task stays in your own working folder, project and connection';
    expect(`${STALE}, takes your permission mode`.includes(STALE)).toBe(true); // CONTROL
    expect(CREATE_BOARD_TASK_GUIDANCE).not.toContain(STALE);
    expect(readFileSync(GUIDE, 'utf-8')).not.toContain(STALE);
  });
});
