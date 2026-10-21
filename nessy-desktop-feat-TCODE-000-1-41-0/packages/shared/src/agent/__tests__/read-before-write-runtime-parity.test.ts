/**
 * D1.332 `[host]` `[safety]` — the read-before-write rule, on the two runtimes
 * the host can gate, driven through the real classes.
 *
 * ## What RS-76 measured, and what this file pins
 *
 * One scratch workspace, one seeded file the session never read, one turn per
 * runtime asking for it to be REPLACED, plus a NEW file beside it as the
 * control that the workspace was writable and the session bound where the case
 * thought it was:
 *
 * | runtime | classification | seeded marker gone | control file created |
 * | --- | --- | --- | --- |
 * | pi | **refused** | no | yes |
 * | claude | `wrote-blind` | yes | yes |
 * | codex | `wrote-blind` | yes | yes |
 *
 * So the same instruction was refused on one runtime and performed on two, in
 * one profile, in one run — a switch-visible divergence on a SAFETY rule. This
 * suite drives the Pi arm (the control that moving the rule out of
 * `local-tools/runtime.ts` changed nothing) and the claude arm (the row), and
 * asserts the two refusals are the SAME STRING, so the divergence cannot come
 * back as a reworded message.
 *
 * **The codex arm is not here, and its absence is the finding rather than an
 * omission.** Its only enforcement point is the approval bridge, and with the
 * sandbox master switch off — this product's standing posture — codex raises no
 * approval for an ordinary command at all: `config-writer.ts`'s measured table
 * reads `danger-full-access` / `on-request` → **0 approvals, "SUCCEEDED — file
 * written to `$HOME`"**, `CODEX_UNBOUNDED_APPROVAL_NOTICE` says so to the
 * operator in as many words, and the owner ruled on that residue (QX4 = A,
 * 2026-09-11). RS-76's codex arm used `Bash` twice, which is exactly the class
 * that never reaches the bridge.
 *
 * ## The two ways this gate can be wrong are opposite, and both are asserted
 *
 * A gate that never fires is a safety feature that does nothing; a gate that
 * fires on a NEW file, on the agent's own output, or on a tool that writes
 * nothing is a fork-only refusal of what the page allows
 * (`tools-reference.md#write-tool-behavior`: *"This constraint doesn't apply to
 * new files."*).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, writeFile as writeFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ClaudeAgent } from '../claude-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { readBeforeWriteRefusal } from '../core/read-before-write.ts';
import { LocalToolRuntime, type LocalToolCall, type LocalToolRuntimeOptions } from '../local-tools/index.ts';

async function makeWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'd1332-ws-')));
}

// ── the Pi arm ─────────────────────────────────────────────────────────────

function makeRuntime(workspaceRootPath: string): LocalToolRuntime {
  return new LocalToolRuntime({
    filesystemScope: {
      session: { workspaceId: 'ws-d1332', sessionId: 'sess-d1332' },
      primaryRoot: workspaceRootPath,
      cwd: workspaceRootPath,
      additionalRoots: [],
      managedExclusions: [],
      generation: 'g-d1332',
    },
    permissionManager: { evaluateToolCall: () => ({ allowed: true }) },
    guardLargeResults: false,
  } as LocalToolRuntimeOptions);
}

function piCall(operation: LocalToolCall['operation'], toolName: string): LocalToolCall {
  return { id: `call-${toolName}`, displayName: toolName, operation, permission: { toolName, input: {} } };
}

// ── the claude arm ─────────────────────────────────────────────────────────

interface ClaudeInternals {
  applyReadBeforeWriteRule(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<string | undefined>;
  /** F1.96 — the viewer credit's own seam, on the PostToolUse side. */
  creditBashViewerRead(toolName: string, toolInput: unknown, toolResponse: unknown): void;
}

const agents: ClaudeAgent[] = [];
afterEach(() => { for (const agent of agents.splice(0)) agent.destroy(); });

/**
 * A real `ClaudeAgent`, bound to `root`, whose PreToolUse write seam is driven
 * directly.
 *
 * The producer that calls it lives inside the SDK query loop and cannot be
 * reached without a running child — the same constraint D1.291's suite records —
 * so the SEAM is driven with the exact two arguments `claude-agent.ts` hands it
 * (`input.tool_name` and the post-rewrite `exactToolInput`), and the method
 * under test is the real one.
 */
function claudeSeam(root: string): ClaudeInternals {
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-d1332', name: 'D1332', rootPath: root,
      workspaceRootPath: root, sessionRootPath: join(root, 'sessions'),
    } as never,
    session: { id: 'sess-d1332', createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root } as never,
  } as BackendConfig);
  agents.push(agent);
  return agent as unknown as ClaudeInternals;
}

describe('D1.332 — the Pi arm still refuses (the control that the move changed nothing)', () => {
  test('a seeded file nobody read is refused; a read clears it; a NEW file was never refused', async () => {
    const workspace = await makeWorkspace();
    await writeFileAsync(join(workspace, 'subject.txt'), 'seeded marker', 'utf-8');
    const runtime = makeRuntime(workspace);

    // POSITIVE CONTROL FIRST — a runtime that stopped writing at all would pass
    // every refusal assertion below.
    const created = await runtime.execute(
      piCall({ kind: 'write_file', path: 'control-new.txt', content: 'new' }, 'Write'),
    );
    expect(created.isError).toBeFalsy();

    const blind = await runtime.execute(
      piCall({ kind: 'write_file', path: 'subject.txt', content: 'clobbered' }, 'Write'),
    );
    expect(blind.isError).toBe(true);
    expect(blind.error).toBe(readBeforeWriteRefusal(join(workspace, 'subject.txt')));

    await runtime.execute(piCall({ kind: 'read_file', path: 'subject.txt' }, 'Read'));
    const afterRead = await runtime.execute(
      piCall({ kind: 'write_file', path: 'subject.txt', content: 'replaced' }, 'Write'),
    );
    expect(afterRead.isError).toBeFalsy();
  });
});

describe('D1.332 — the claude arm now refuses the same write', () => {
  test('a seeded file nobody read is refused, with the SAME sentence Pi uses', async () => {
    const workspace = await makeWorkspace();
    const subject = join(workspace, 'subject.txt');
    await writeFileAsync(subject, 'seeded marker', 'utf-8');
    const seam = claudeSeam(workspace);

    // POSITIVE CONTROL FIRST, twice over: a gate that refused everything would
    // pass the refusal below, and a gate that refused nothing would pass these.
    expect(await seam.applyReadBeforeWriteRule('Write', { file_path: join(workspace, 'control-new.txt') }))
      .toBeUndefined();
    expect(await seam.applyReadBeforeWriteRule('Grep', { path: subject })).toBeUndefined();

    expect(await seam.applyReadBeforeWriteRule('Write', { file_path: subject }))
      .toBe(readBeforeWriteRefusal(subject));
    expect(await seam.applyReadBeforeWriteRule('Edit', { file_path: subject }))
      .toBe(readBeforeWriteRefusal(subject));
    expect(await seam.applyReadBeforeWriteRule('MultiEdit', { file_path: subject }))
      .toBe(readBeforeWriteRefusal(subject));
    // `NotebookEdit` carries its path under a third spelling; a gate reading
    // only `file_path` answers `undefined` there, and a gate that answers
    // `undefined` ALLOWS.
    expect(await seam.applyReadBeforeWriteRule('NotebookEdit', { notebook_path: subject }))
      .toBe(readBeforeWriteRefusal(subject));
  });

  test('a Read clears it, and a bare Bash viewer clears it exactly as on Pi — AFTER it ran', async () => {
    const workspace = await makeWorkspace();
    const subject = join(workspace, 'subject.txt');
    const viewed = join(workspace, 'viewed.txt');
    await writeFileAsync(subject, 'seeded marker', 'utf-8');
    await writeFileAsync(viewed, 'seeded marker', 'utf-8');
    const seam = claudeSeam(workspace);

    await seam.applyReadBeforeWriteRule('Read', { file_path: subject });
    expect(await seam.applyReadBeforeWriteRule('Write', { file_path: subject })).toBeUndefined();

    // `cat <one file>` is one of the four the page's eleven viewers reduce to;
    // `head -n 5 f` is NOT credited on either runtime, which is the boundary.
    expect(await seam.applyReadBeforeWriteRule('Write', { file_path: viewed }))
      .toBe(readBeforeWriteRefusal(viewed));

    // F1.96 — WHEN changed, and this pair is the parity claim. The PreToolUse
    // seam credits NOTHING for a viewer now: it runs before the gate has decided
    // and before the child executes, so a denied or failing viewer used to
    // unlock this very write. Pi credits after the command on exit 0; claude
    // credits from the PostToolUse hook, which `hooks.md`'s event table defines
    // as "After a tool call succeeds".
    await seam.applyReadBeforeWriteRule('Bash', { command: `cat ${viewed}` });
    expect(await seam.applyReadBeforeWriteRule('Write', { file_path: viewed }))
      .toBe(readBeforeWriteRefusal(viewed));

    seam.creditBashViewerRead('Bash', { command: `cat ${viewed}` }, { stdout: 'seeded marker' });
    expect(await seam.applyReadBeforeWriteRule('Write', { file_path: viewed })).toBeUndefined();
  });

  test('a file this session created may be written again — Pi decision 2, one layer up', async () => {
    const workspace = await makeWorkspace();
    const fresh = join(workspace, 'authored.txt');
    const seam = claudeSeam(workspace);

    // The first write is a NEW file, which the page exempts. The gate runs
    // BEFORE the write, so nothing exists on disk yet — and the second write,
    // after the model has authored those bytes, must not be refused.
    expect(await seam.applyReadBeforeWriteRule('Write', { file_path: fresh })).toBeUndefined();
    await writeFileAsync(fresh, 'authored by the agent', 'utf-8');
    expect(await seam.applyReadBeforeWriteRule('Write', { file_path: fresh })).toBeUndefined();
  });

  test('the ledger is per session: a second agent does not inherit the first one\'s reads', async () => {
    const workspace = await makeWorkspace();
    const subject = join(workspace, 'subject.txt');
    await writeFileAsync(subject, 'seeded marker', 'utf-8');

    const first = claudeSeam(workspace);
    await first.applyReadBeforeWriteRule('Read', { file_path: subject });
    expect(await first.applyReadBeforeWriteRule('Write', { file_path: subject })).toBeUndefined();

    const second = claudeSeam(workspace);
    expect(await second.applyReadBeforeWriteRule('Write', { file_path: subject }))
      .toBe(readBeforeWriteRefusal(subject));
  });
});
