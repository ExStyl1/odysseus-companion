/**
 * D1.434 — the workspace automation record, written with a PLAIN FILE WRITE.
 *
 * ## The row does NOT reproduce as written, and this file is the reading
 *
 * D1.434 was born from D1.429/D1.430's stated residue: `automation_create` is
 * now the narrow door, so "in `acceptEdits` a `Write` to
 * `<workspaceRoot>/automations.json` is auto-approved" and the record carries
 * `permissionMode`, which `SessionManager.executePromptAutomation` hands to
 * `createSession` where `options?.permissionMode` outranks the project default
 * and the workspace floor. **The FIRST link breaks.** `Write`, `Edit` and a
 * `Bash` redirect into that file are hard-BLOCKED before the mode is consulted
 * — by `getAutomationConfigMutationGuard`, which has been in this gate all
 * along — in every mode INCLUDING `bypassPermissions`, with a message naming
 * the supported door. So the write is never auto-approved and the tool ceiling
 * cannot be walked around that way.
 *
 * ## What the same probe DID measure, which is why the premise looked right
 *
 * The guard's coverage was narrower than the gate's own write path, in two
 * directions, and both walked past it in `acceptEdits` with no card at all
 * (measured 2026-09-20, before the fix):
 *
 *  - it read `CONFIG_WRITE_TOOLS` (`Write`, `Edit`) where the write path reads
 *    `FILE_WRITE_TOOLS` (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`), so
 *    `MultiEdit` and `NotebookEdit` on the same file answered `allow`.
 *    `NotebookEdit` is not hypothetical: it is a shipped Pi static tool
 *    (`PI_TOOL_BINDINGS`, `descriptorId: 'notebook_edit'`,
 *    `permissionName: 'NotebookEdit'`), and `config-guard-tool-spelling.test.ts`'s
 *    own pin filters to the `write`/`edit` descriptors, so it could never see it.
 *    That gap has TWO halves and closing one alone changes nothing: the guards'
 *    path reader `toolTargetPath` knew `file_path` and `path` where the gate's
 *    own `extractFileToolTargetPath` knows `file_path`, `notebook_path` and
 *    `path` — so a faithful `NotebookEdit {notebook_path}` call still read
 *    `undefined`, which is the very defect `toolTargetPath`'s docblock already
 *    records as having shipped once for Pi's `path`;
 *  - its shell arm tested `Bash` alone, so the identical redirect through
 *    `Monitor` answered `allow` where `Bash` answered `block`. The
 *    protected-path shell floor beside it already takes `Monitor`, on
 *    `tools-reference.md`'s "uses the same permission rules as Bash"
 *    (quoted in `findNonNegotiableFloors`), so the two halves of one gate
 *    disagreed about the same tool.
 *
 * The fix is those two reads and nothing else — a strict tightening of a guard
 * that already refused this file for the two dominant spellings, keeping
 * `pre-tool-use.ts` line-neutral (238 of its 276 doc line-citations sit below
 * the edit).
 *
 * ## Both config-dir shapes, because the cover on a default install is INCIDENTAL
 *
 * `workspaceRootPath` is `<CONFIG_DIR>/workspaces/<id>` and `CONFIG_DIR`
 * defaults to `~/.nessy-agent`, so on a default install every path under it
 * carries a `.nessy-agent` segment and the PROTECTED-PATH floor answers for any
 * file there. That cover comes from the directory's NAME, not from the record
 * being trusted configuration, and it disappears the moment an operator sets
 * `NESSY_CONFIG_DIR` — which `config/paths.ts` documents as a supported
 * multi-instance knob. Every arm below therefore runs under an OVERRIDDEN
 * config dir, with the default-install shape kept as its own control so the two
 * mechanisms cannot be confused for each other (the same pairing
 * `claude-accept-edits-session-cwd.test.ts` measured for the session store).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'

import { AUTOMATIONS_CONFIG_FILE } from '../../automations/constants.ts'
import { saveWorkspacePermissions } from '../permissions-config.ts'
import { runPreToolUseChecks, toolTargetPath, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts'
// A namespace read for F1.139's list: a named import of an export the gate did
// not yet carry would die at link time instead of failing an assertion.
import * as preToolUse from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'

const KEY = { workspaceId: 'ws-d1434', sessionId: 'session-d1434' }

let sandbox: string
/** A workspace root under a DEFAULT-shaped config dir: carries a `.nessy-agent` segment. */
let defaultInstallRoot: string
/** A workspace root under an OVERRIDDEN config dir: no protected segment anywhere. */
let overriddenRoot: string
/** An ordinary project directory, for the out-of-workspace boundary. */
let projectRoot: string

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-d1434-')))
  defaultInstallRoot = join(sandbox, '.nessy-agent', 'workspaces', KEY.workspaceId)
  overriddenRoot = join(sandbox, 'nessy-config', 'workspaces', KEY.workspaceId)
  projectRoot = join(sandbox, 'project')
  for (const dir of [defaultInstallRoot, overriddenRoot, projectRoot]) mkdirSync(dir, { recursive: true })
  for (const dir of [overriddenRoot, projectRoot]) {
    for (const name of [AUTOMATIONS_CONFIG_FILE, 'hooks.json', 'permissions.json']) {
      writeFileSync(join(dir, name), '{}')
    }
  }
})

afterEach(() => { cleanupModeState(KEY) })

afterAll(() => {
  cleanupModeState(KEY)
  rmSync(sandbox, { recursive: true, force: true })
})

/**
 * The gate as every runtime calls it. The mode is read from the mode-state
 * singleton rather than from `ctx.permissionMode`, so it is initialized per arm.
 */
function check(
  workspaceRootPath: string,
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
  workingDirectory = workspaceRootPath,
) {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const ctx: PreToolUseInput = {
    toolName,
    input,
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath,
    workspaceId: KEY.workspaceId,
    workingDirectory,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
  }
  const result = runPreToolUseChecks(ctx)
  // Read every field into a local BEFORE asserting a shape: an asymmetric
  // matcher handed to `toMatchObject` overwrites the field it matched.
  return {
    type: result.type,
    blocked: result.type === 'block' && /are blocked/.test(result.reason),
    floor: result.type === 'prompt' ? result.nonNegotiable : undefined,
  }
}

/** The block reason verbatim, for the arms that assert WHICH route the message names. */
function blockReason(
  workspaceRootPath: string,
  toolName: string,
  input: Record<string, unknown>,
  mode: PermissionMode,
): string | undefined {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input,
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath,
    workspaceId: KEY.workspaceId,
    workingDirectory: workspaceRootPath,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
  })
  return result.type === 'block' ? result.reason : undefined
}

/** The same write target, in each tool's own spelling. */
function writeCalls(filePath: string): Array<[string, Record<string, unknown>]> {
  return [
    ['Write', { file_path: filePath, content: '{}' }],
    // Pi addresses the same call with `path`; the gate sees the raw payload.
    ['Write', { path: filePath, content: '{}' }],
    ['Edit', { file_path: filePath, old_string: '{}', new_string: '{"a":1}' }],
    ['MultiEdit', { file_path: filePath, edits: [{ oldText: '{}', newText: '{"a":1}' }] }],
    // `notebook_path` ALONE, which is the only key a real NotebookEdit call
    // carries. Passing `file_path` beside it would make this arm pass on the
    // tool-set half of D1.434 while the reader half stayed open.
    ['NotebookEdit', { notebook_path: filePath, new_source: 'x' }],
  ]
}

describe('D1.434 · the workspace automation record refuses every file-write tool', () => {
  it('reads the notebook spelling — the reader half, which fails on its own', () => {
    // The unit form of the second half. At HEAD `toolTargetPath` listed
    // `file_path` and `path` only and answered `undefined` here, so widening the
    // guard's TOOL set alone would have left a faithful NotebookEdit call
    // walking past it with nothing to see. The three existing pins in
    // `core/__tests__/config-guard-tool-spelling.test.ts` § "the shared readers"
    // are the controls that the precedence and the blank handling are unchanged.
    expect(toolTargetPath({ notebook_path: '/n.ipynb' })).toBe('/n.ipynb')
    expect(toolTargetPath({ file_path: '/f', notebook_path: '/n' })).toBe('/f')
  })

  it('is the POSITIVE CONTROL first: acceptEdits really does auto-approve an ordinary file in the workspace root', () => {
    // Without this arm every refusal below is indistinguishable from a gate that
    // refuses everything, and the row would close on a dead harness.
    expect(check(overriddenRoot, 'Write', { file_path: join(overriddenRoot, 'notes.txt'), content: 'x' }, 'acceptEdits'))
      .toEqual({ type: 'allow', blocked: false, floor: undefined })
  })

  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    it(`blocks every file-write spelling of automations.json in ${mode}`, () => {
      const target = join(overriddenRoot, AUTOMATIONS_CONFIG_FILE)
      const verdicts = writeCalls(target).map(([tool, input]) =>
        `${tool}:${JSON.stringify(check(overriddenRoot, tool, input, mode))}`)
      const blocked = `{"type":"block","blocked":true}`
      expect(verdicts).toEqual([
        `Write:${blocked}`,
        `Write:${blocked}`,
        `Edit:${blocked}`,
        `MultiEdit:${blocked}`,
        `NotebookEdit:${blocked}`,
      ])
    })
  }

  it('blocks a Monitor redirect into the record, exactly as Bash already did', () => {
    // Before D1.434 `Bash` blocked and `Monitor` — which `tools-reference.md`
    // says "uses the same permission rules as Bash", and which the
    // protected-path shell floor beside this one already takes — answered
    // `allow` on the identical command.
    const target = join(overriddenRoot, AUTOMATIONS_CONFIG_FILE)
    const command = `cat > ${target} << 'EOF'\n{}\nEOF`
    const bash = check(overriddenRoot, 'Bash', { command }, 'acceptEdits')
    const monitor = check(overriddenRoot, 'Monitor', { command }, 'acceptEdits')
    expect({ bash, monitor }).toEqual({
      bash: { type: 'block', blocked: true, floor: undefined },
      monitor: { type: 'block', blocked: true, floor: undefined },
    })
  })

  it('gives the two shell tools the SAME answer on a read-shaped command, whatever it is', () => {
    // The guard's token scan is read/write blind — it matches any token that
    // resolves to the record — and that is INHERITED from the `Bash` arm this
    // widening copies, not introduced by it. Asserted as an EQUALITY rather
    // than against a fixed verdict, so this arm pins the property D1.434 adds
    // (one answer for two tools); the blindness itself is F1.124's, decided in
    // the arm below.
    const command = `cat ${join(overriddenRoot, AUTOMATIONS_CONFIG_FILE)}`
    const bash = check(overriddenRoot, 'Bash', { command }, 'acceptEdits')
    const monitor = check(overriddenRoot, 'Monitor', { command }, 'acceptEdits')
    expect(monitor).toEqual(bash)
  })

  /**
   * F1.124 (origin WI-bz) — the read/write blindness is ACCEPTED, and said.
   *
   * DECIDED (WJ-w, 2026-09-23, the row's own second option): the over-block
   * stays. This guard is a floor that binds EVERY mode including
   * `bypassPermissions`, and telling a read from a write in a shell command is
   * a write-detector — one that would have to know `tee`, `cp`, `mv`, `dd`,
   * `sed -i`, `perl -i`, an interpreter's `-c`, and every spelling after them
   * — so any gap in it is a gap in a floor nothing else backs. Re-using the
   * Explore classifier instead would make the floor answer to
   * `allowedBashPatterns`, which a workspace's own `permissions.json` extends.
   * What the model loses is only the SHELL spelling of a read, and the record
   * has a door for that: `automation_list`. So the message now names it, and a
   * read-shaped command meets a refusal that says where to go instead of one
   * naming only the write tools. RED before: the reason named
   * `automation_create`/`automation_update` and no read door.
   */
  it('F1.124 — a read-shaped command is refused like a redirect, and the refusal names the read door', () => {
    const read = `cat ${join(overriddenRoot, AUTOMATIONS_CONFIG_FILE)}`
    const redirect = `cat > ${join(overriddenRoot, AUTOMATIONS_CONFIG_FILE)} << 'EOF'\n{}\nEOF`
    const readReason = blockReason(overriddenRoot, 'Bash', { command: read }, 'bypassPermissions') ?? ''
    const monitorReason = blockReason(overriddenRoot, 'Monitor', { command: read }, 'acceptEdits') ?? ''
    const redirectReason = blockReason(overriddenRoot, 'Bash', { command: redirect }, 'acceptEdits') ?? ''
    expect({
      readBlocked: readReason.includes('are blocked'),
      readNamesReadDoor: readReason.includes('`automation_list`'),
      monitorNamesReadDoor: monitorReason.includes('`automation_list`'),
      // CONTROL: the write spelling is refused exactly as before, and still names the write doors.
      redirectBlocked: redirectReason.includes('are blocked'),
      redirectNamesWriteDoor: redirectReason.includes('`automation_update`'),
    }).toEqual({
      readBlocked: true,
      readNamesReadDoor: true,
      monitorNamesReadDoor: true,
      redirectBlocked: true,
      redirectNamesWriteDoor: true,
    })
  })

  it('covers the history file the guard has always named beside the record', () => {
    expect(check(
      overriddenRoot,
      'NotebookEdit',
      { notebook_path: join(overriddenRoot, 'automations-history.jsonl'), new_source: 'x' },
      'acceptEdits',
    )).toEqual({ type: 'block', blocked: true, floor: undefined })
  })

  it('is the BOUNDARY: the same basename OUTSIDE the workspace root is untouched', () => {
    // The guard resolves against the workspace root and returns null for
    // anything outside it, so a project of the user's own that happens to carry
    // an `automations.json` keeps behaving exactly as any other file — which is
    // why this close needs no basename list and no provenance field.
    const verdicts = writeCalls(join(projectRoot, AUTOMATIONS_CONFIG_FILE))
      .map(([tool, input]) => check(overriddenRoot, tool, input, 'acceptEdits', projectRoot).type)
    expect(verdicts).toEqual(['allow', 'allow', 'allow', 'allow', 'allow'])
  })

  it('is the OTHER BOUNDARY: the default install is covered by the directory NAME, not by the record', () => {
    // A file the automation guard does NOT name, under each config-dir shape.
    // One protected-path floor, one plain auto-approval — the two mechanisms the
    // row's premise conflated, separated so neither can stand in for the other.
    const defaultInstall = check(
      defaultInstallRoot, 'Write', { file_path: join(defaultInstallRoot, 'notes.txt'), content: 'x' }, 'acceptEdits',
    )
    const overridden = check(
      overriddenRoot, 'Write', { file_path: join(overriddenRoot, 'notes.txt'), content: 'x' }, 'acceptEdits',
    )
    expect({ defaultInstall, overridden }).toEqual({
      defaultInstall: { type: 'prompt', blocked: false, floor: 'protectedPath' },
      overridden: { type: 'allow', blocked: false, floor: undefined },
    })
  })

  it('the RESIDUE PIN went red on purpose — `hooks.json` now ASKS (F1.123, below)', () => {
    // Until 2026-09-23 this arm was a dated RECORDING: `hooks.json` was the one
    // sibling record `acceptEdits` still auto-approved (`allow`), and its own
    // instruction was "WHEN THIS ARM GOES RED the residue has been closed". It
    // went red with F1.123 — not by moving the record to the BLOCKED side, which
    // the arm anticipated, but to the ASK side the controller decided; see the
    // F1.123 describe below for the decision and every mode.
    const hooks = check(overriddenRoot, 'Write', { file_path: join(overriddenRoot, 'hooks.json'), content: '{}' }, 'acceptEdits')
    expect(hooks).toEqual({ type: 'prompt', blocked: false, floor: 'protectedPath' })
  })
})

/**
 * F1.123 (origin WI-bz, D1.434's residue) — the workspace HOOK record asks.
 *
 * `<workspaceRoot>/hooks.json` was auto-approved by `acceptEdits`/`auto` for
 * every file-write tool. It cannot carry D1.434's `permissionMode` chain and,
 * after D1.429, a COMMAND hook written there raises the Bash card when it fires
 * — but a webhook or event-log action could still be written with no card.
 *
 * DECISION (controller, 2026-09-23, under the owner's standing delegation):
 * ALWAYS ASK, never block. The file is documented in this tree as
 * HAND-AUTHORED, so a refusal (D1.438's posture for `automations.json` and
 * `permissions.json`) would take away a legitimate request; a silent write is
 * the hole. The mechanism is the one Claude Code uses for its OWN configuration
 * — `permission-modes.md#protected-paths`: "Writes to a small set of paths are
 * never auto-approved, except in `bypassPermissions` mode", with the per-mode
 * table `default`/`acceptEdits` Prompted, `dontAsk` Denied,
 * `bypassPermissions` Allowed — so the record joins the protected-path floor
 * (`protectedPathOutcome`'s table, unchanged) for this one file, keyed on the
 * WORKSPACE ROOT rather than on a directory name. That is also what makes the
 * overridden-config-dir install agree with the default one, where the
 * `.nessy-agent` segment already raised this very floor (the OTHER BOUNDARY
 * arm above).
 */
describe('F1.123 · the workspace hook record asks and is never blocked', () => {
  const target = () => join(overriddenRoot, 'hooks.json')

  it('asks for every file-write spelling in acceptEdits — the non-negotiable protected-path card', () => {
    const verdicts = writeCalls(target()).map(([tool, input]) =>
      `${tool}:${JSON.stringify(check(overriddenRoot, tool, input, 'acceptEdits'))}`)
    const asked = `{"type":"prompt","blocked":false,"floor":"protectedPath"}`
    expect(verdicts).toEqual([
      `Write:${asked}`,
      `Write:${asked}`,
      `Edit:${asked}`,
      `MultiEdit:${asked}`,
      `NotebookEdit:${asked}`,
    ])
  })

  it('follows the documented per-mode table: default and auto ask, dontAsk denies, bypassPermissions allows', () => {
    const write = (mode: PermissionMode) =>
      check(overriddenRoot, 'Write', { file_path: target(), content: '{}' }, mode)
    const dontAsk = write('dontAsk')
    expect({
      default: write('default'),
      auto: write('auto'),
      dontAsk: { type: dontAsk.type, floor: dontAsk.floor },
      bypassPermissions: write('bypassPermissions'),
    }).toEqual({
      default: { type: 'prompt', blocked: false, floor: 'protectedPath' },
      auto: { type: 'prompt', blocked: false, floor: 'protectedPath' },
      // `dontAsk` refuses what would prompt; the reason is the mode's own
      // sentence, not the record guard's "are blocked" (it is not BLOCKED).
      dontAsk: { type: 'block', floor: undefined },
      bypassPermissions: { type: 'allow', blocked: false, floor: undefined },
    })
  })

  it('is never the record guard\'s BLOCK, in any mode — the file stays writable with a card', () => {
    // The decision's other half: `hooks.json` must not join
    // `GUARDED_WORKSPACE_RECORDS`, whose answer is a refusal naming another door.
    for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
      expect({ mode, reason: blockReason(overriddenRoot, 'Write', { file_path: target(), content: '{}' }, mode) })
        .toEqual({ mode, reason: undefined })
    }
  })

  it('CONTROLS: an ordinary workspace file still writes with no card, and the same basename outside the root is untouched', () => {
    expect(check(overriddenRoot, 'Write', { file_path: join(overriddenRoot, 'notes.txt'), content: 'x' }, 'acceptEdits'))
      .toEqual({ type: 'allow', blocked: false, floor: undefined })
    const outside = writeCalls(join(projectRoot, 'hooks.json'))
      .map(([tool, input]) => check(overriddenRoot, tool, input, 'acceptEdits', projectRoot).type)
    expect(outside).toEqual(['allow', 'allow', 'allow', 'allow', 'allow'])
  })

  it('CONTROLS: the D1.438 records keep their refusal beside it', () => {
    for (const name of [AUTOMATIONS_CONFIG_FILE, 'permissions.json']) {
      expect({ name, verdict: check(overriddenRoot, 'Write', { file_path: join(overriddenRoot, name), content: '{}' }, 'acceptEdits') })
        .toEqual({ name, verdict: { type: 'block', blocked: true, floor: undefined } })
    }
  })
})

/**
 * D1.438 — the workspace permission DSL joins the automation record.
 *
 * `<workspaceRoot>/permissions.json` is ADDITIVE by `permissions-config.ts`'s own
 * header — *"Rules are additive - custom configs extend the defaults (more
 * permissive)"* — and `capabilities/native-sources.ts` files it as a
 * workspace-scope `permission` record. Measured by D1.434's probe: in
 * `acceptEdits` a `Write` of it answered `allow` while the same call at
 * `automations.json` answered `block`, in the same run. That is the same
 * self-granting door D1.429/D1.430 closed, one file over: a model could write
 * its own allow rules with no card.
 *
 * The posture is the controller's, stated rather than quiet: BLOCK, exactly as
 * the automation record is blocked, because that is this tree's own precedent
 * for a record the model must not rewrite — not a second posture invented
 * beside it. The message names the route the USER takes instead, which is the
 * half that keeps a block from reading as a defect.
 */
describe('D1.438 · the workspace permission DSL refuses a direct model write', () => {
  for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions'] as const) {
    it(`blocks every file-write spelling of permissions.json in ${mode}`, () => {
      const verdicts = writeCalls(join(overriddenRoot, 'permissions.json')).map(([tool, input]) =>
        `${tool}:${JSON.stringify(check(overriddenRoot, tool, input, mode))}`)
      const blocked = `{"type":"block","blocked":true}`
      expect(verdicts).toEqual([
        `Write:${blocked}`,
        `Write:${blocked}`,
        `Edit:${blocked}`,
        `MultiEdit:${blocked}`,
        `NotebookEdit:${blocked}`,
      ])
    })
  }

  it('blocks the shell redirect through both shell tools', () => {
    const command = `cat > ${join(overriddenRoot, 'permissions.json')} << 'EOF'\n{}\nEOF`
    const bash = check(overriddenRoot, 'Bash', { command }, 'acceptEdits')
    const monitor = check(overriddenRoot, 'Monitor', { command }, 'acceptEdits')
    expect({ bash, monitor }).toEqual({
      bash: { type: 'block', blocked: true, floor: undefined },
      monitor: { type: 'block', blocked: true, floor: undefined },
    })
  })

  it('names the USER route, and does NOT tell the model to use the automation tools', () => {
    // A block whose message points at the wrong door is worse than no message:
    // the model would call `automation_create` and meet a second refusal. Both
    // halves are asserted, and the automation record's own message is read in
    // the same arm as the control that the two records really do differ.
    const permissions = blockReason(
      overriddenRoot, 'Write', { file_path: join(overriddenRoot, 'permissions.json'), content: '{}' }, 'acceptEdits',
    )
    const automations = blockReason(
      overriddenRoot, 'Write', { file_path: join(overriddenRoot, AUTOMATIONS_CONFIG_FILE), content: '{}' }, 'acceptEdits',
    )
    expect(permissions).toContain('permissions.json are blocked')
    expect(permissions).toContain('Settings > Permissions')
    expect(permissions).not.toContain('automation_create')
    expect(automations).toContain('automation_create')
    expect(automations).not.toContain('Settings > Permissions')
  })

  it('is the BOUNDARY: a permissions.json OUTSIDE the workspace root is untouched', () => {
    const verdicts = writeCalls(join(projectRoot, 'permissions.json'))
      .map(([tool, input]) => check(overriddenRoot, tool, input, 'acceptEdits', projectRoot).type)
    expect(verdicts).toEqual(['allow', 'allow', 'allow', 'allow', 'allow'])
  })

  it('leaves the USER\'s own writer alone — the gate is the tool path, not the filesystem', () => {
    // The control the row asks for, driven rather than described: the Settings
    // page and codex's Always-Allow persistence both land through
    // `saveWorkspacePermissions`, a plain fs write that never passes
    // `runPreToolUseChecks`. Blocking the model's tool call must not touch it.
    const before = readFileSync(join(overriddenRoot, 'permissions.json'), 'utf-8')
    saveWorkspacePermissions(overriddenRoot, { version: '2026-09-20', allowedBashPatterns: ['^ls\\b'] })
    const after = readFileSync(join(overriddenRoot, 'permissions.json'), 'utf-8')
    expect({ changed: after !== before, hasRule: after.includes('^ls') }).toEqual({ changed: true, hasRule: true })
  })
})

/**
 * F1.139 (origin SIT-10 P-SIT10-2) — WHICH floor answers a `NotebookEdit` of a
 * guarded record, per runtime. A READING, pinned; no behaviour changes.
 *
 * SIT-10 measured, on claude-runtime, a `NotebookEdit` of `<ws>/automations.json`
 * refused by the SDK's own extension check ("File must be a Jupyter notebook
 * (.ipynb file)…") and never by D1.438's sentence, while a `Write` of the same
 * file DID return D1.438's sentence — so the guard reaches that runtime and was
 * simply second in line. That order is DOCUMENTED, not an accident:
 * `hooks.md#posttoolusefailure` — "Validation rejections are returned as
 * `tool_use_error` results and happen before hooks run, so they fire neither
 * `PreToolUse` nor `PostToolUseFailure`", and this gate reaches claude as a
 * `PreToolUse` hook. So:
 *
 *  - on CLAUDE the load-bearing floor for a `NotebookEdit` of a guarded record is
 *    the SDK's tool-specific validation (every record below is not an `.ipynb`),
 *    and this gate is the SECOND floor;
 *  - on PI the order is the reverse: this gate answers first (it runs on the
 *    `pre_tool_use_request`, before the tool executes), and Pi's own
 *    `NotebookEdit` refuses a non-`.ipynb` path second
 *    (`pi-agent-server/src/tools/notebook.ts`, `resolveNotebookPath`: "NotebookEdit
 *    only supports .ipynb files.").
 *
 * Neither runtime depends on one floor alone, and nothing is written either way,
 * which is why this is a reading and not a hole. The pins make both halves fail
 * loudly if they stop being true: a guarded record that ever ENDS in `.ipynb`
 * would leave claude with the gate alone, and a gate that stopped reading
 * `notebook_path` would leave pi with the tool's check alone.
 */
describe('F1.139 · NotebookEdit of a guarded record: two floors on each runtime, in documented order', () => {
  // Read lazily, inside each arm: a missing export fails an assertion rather than
  // the file's collection.
  const guarded = (): string[] => [...(preToolUse.GUARDED_WORKSPACE_RECORDS?.keys() ?? [])]

  it('reads the guard\'s own record list, not a copy of it', () => {
    // Positive control that the list is the live one (D1.438's three names; UA1.10's host ledger fourth).
    expect(guarded()).toEqual(['automations.json', 'automations-history.jsonl', 'permissions.json', 'host-approvals.json'])
  })

  it('no guarded record — nor the hook record F1.123 asks for — is an .ipynb, so the SDK\'s validation refuses it first on claude', () => {
    const notebooks = [...guarded(), 'hooks.json'].filter(name => extname(name).toLowerCase() === '.ipynb')
    expect(notebooks).toEqual([])
  })

  it('the gate still refuses each one on the notebook_path spelling, so pi (gate first) and claude (gate second) both hold', () => {
    const verdicts = guarded().map(name =>
      `${name}:${check(overriddenRoot, 'NotebookEdit', { notebook_path: join(overriddenRoot, name), new_source: 'x' }, 'acceptEdits').type}`)
    expect(verdicts).toEqual(['automations.json:block', 'automations-history.jsonl:block', 'permissions.json:block', 'host-approvals.json:block'])
  })

  it('CONTROL: an ordinary notebook in the workspace root is NOT refused — the gate is not blocking NotebookEdit wholesale', () => {
    expect(check(overriddenRoot, 'NotebookEdit', { notebook_path: join(overriddenRoot, 'analysis.ipynb'), new_source: 'x' }, 'acceptEdits'))
      .toEqual({ type: 'allow', blocked: false, floor: undefined })
  })
})
