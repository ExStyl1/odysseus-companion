import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import { backgroundTasksDisabled } from '../../config/background-task-settings.ts';
import { applyBashOutputLimits } from '../../config/bash-output-limits.ts';
import { splitCompoundCommand } from '../pi-harness/claude-bash-rule.ts';
import { GLOB_TIMEOUT_SECONDS_ENV, globTimeoutSeconds } from '../../config/glob-timeout.ts';
import { fileReadOutputTokenLimit } from '../../config/file-read-output-limit.ts';
import { mcpOutputTokenLimit } from '../../config/mcp-output-settings.ts';
import { estimateTokensDensityAware, guardLargeResult, resolveResultTokenLimit } from '../../utils/large-response.ts';
import {
  appendWithheldNotice,
  withholdDeniedEntries,
  withholdDeniedMatchLines,
} from './denied-result-filter.ts';
import { bareFileViewerOperand, SessionFileReadLedger } from '../core/read-before-write.ts';
import { LocalToolPermissionGate } from './permission-gate.ts';
import { OutsideRootError, resolveScopedPath } from './path-scope.ts';
import type {
  LocalToolCall,
  LocalToolExecutionResult,
  LocalToolOperation,
  LocalToolRuntimeOptions,
  LocalToolTextEdit,
} from './types.ts';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  isolationProfile?: string;
  /** Present only when the command ran outside isolation by policy. */
  isolationDowngrade?: { reason: string; pattern?: string; decisionId?: string };
  environmentProfile?: string;
  environmentDigest?: string;
  /** Present when the command is now a background task (R10). */
  backgrounded?: {
    taskId: string;
    outputFile: string;
    timedOut: boolean;
    timeoutMs: number;
  };
}

interface TextReplacement {
  start: number;
  end: number;
  newText: string;
}

export class LocalToolRuntime {
  private readonly permissionGate: LocalToolPermissionGate;

  /**
   * P6.558 (the safety half of the Pi read notice) — the canonical paths whose
   * content this session has already seen.
   *
   * The runtime is constructed once per Pi session (`createRuntime`,
   * `pi-agent-server/src/index.ts`, one call site), so its lifetime IS "the
   * current conversation" the page's rule is written against. It is a set of
   * canonical absolute paths, so two spellings of one file are one entry.
   *
   * @see requireFileSeenBeforeMutation for the rule, its citation and the one
   * clause of it that has no subject on this runtime yet.
   */
  private readonly filesSeenThisSession = new SessionFileReadLedger();

  constructor(private readonly options: LocalToolRuntimeOptions) {
    this.permissionGate = new LocalToolPermissionGate(options);
  }

  async execute(call: LocalToolCall): Promise<LocalToolExecutionResult> {
    const permission = await this.permissionGate.check(call);
    if (!permission.allowed) {
      return result(permission.reason ?? 'Permission denied', true);
    }

    return this.executeAuthorized(call);
  }

  async executeAuthorized(call: LocalToolCall): Promise<LocalToolExecutionResult> {
    try {
      const executionResult = await this.executeAllowed(call);
      return this.guardResult(call, executionResult);
    } catch (error) {
      return result(error instanceof Error ? error.message : String(error), true);
    }
  }

  respondToPermission(requestId: string, allowed: boolean): void {
    this.permissionGate.respondToPermission(requestId, allowed);
  }

  private async executeAllowed(call: LocalToolCall): Promise<LocalToolExecutionResult> {
    switch (call.operation.kind) {
      case 'read_file':
        return result(await this.readFile(call.operation, call.abortSignal));
      case 'list_files':
        return result(await this.listFiles(call.operation, call.abortSignal));
      case 'search_files':
        return this.searchFiles(call.operation, call.abortSignal);
      case 'write_file':
        return this.writeFile(call, call.operation);
      case 'replace_in_file':
        return this.replaceInFile(call, call.operation);
      case 'edit_file':
        return this.editFile(call, call.operation);
      case 'grep':
        return this.grep(call.operation, call.abortSignal);
      case 'find':
        return this.find(call.operation, call.abortSignal);
      case 'ls':
        return result(await this.ls(call.operation, call.abortSignal));
      case 'bash':
        return this.bash(call, call.operation);
      case 'mcp':
        return this.mcp(call.operation, call.abortSignal);
    }
  }

  private async readFile(operation: Extract<LocalToolOperation, { kind: 'read_file' }>, signal?: AbortSignal): Promise<string> {
    const path = await this.scopedPath(requireString(operation.path, 'path'), 'read', signal);
    const tokenLimit = this.fileReadTokenLimit();
    // P6.742 — the bound is applied WHILE the file is read, not after it is in
    // memory. `windowed` also decides how far the reader is allowed to go: an
    // explicit range stops the moment it cannot fit ("without loading the rest
    // of the range"), while a whole-file read has to reach the end anyway
    // because its notice quotes the file's own line count.
    const windowed = operation.offset !== undefined || operation.limit !== undefined;
    const view = await readBoundedLineWindow(
      path,
      operation.offset,
      operation.limit,
      tokenLimit * MAX_CHARS_PER_TOKEN + 1,
      !windowed,
    );
    // P6.767 — the two reads that come back with nothing in them, and the page
    // gives each its own notice. `tools-reference.md#read-tool-behavior`,
    // verbatim: "Reading an empty file returns a notice that the file exists but
    // its contents are empty, and an `offset` past the last line returns a
    // notice giving the file's line count. Before v2.1.208, reading an empty
    // file returned the past-the-end notice instead."
    //
    // That last sentence is also what settles the ORDER: the two conditions
    // overlap (an empty file has no line an offset could be inside), and the
    // page records which of them wins by naming the other as the old defect.
    //
    // The gate verdicts differ, and the difference is the reason this row is a
    // safety row rather than a wording row. Both branches used to fall through
    // to the success path below and RECORD the path, so a read that saw none of
    // a file's lines satisfied `requireFileSeenBeforeMutation`.
    //
    // - **An empty read counts as a read.** The page's only disqualifier is
    //   `#edit-tool-behavior`'s "a read cut short with a `PARTIAL view` notice
    //   doesn't count", and this is not that: the reader returned the WHOLE of
    //   the file's contents. The gate's own refusal names the harm it prevents —
    //   an overwrite destroying "content the conversation never saw" — and an
    //   empty file has none, which is also why decision 1 there already exempts
    //   a file that does not exist at all. Refusing here would be a fork-only
    //   refusal of something the page allows.
    // - **A past-the-end read does not.** The reader saw none of the file's
    //   lines. The page is silent on this one — searched `#read-tool-behavior`,
    //   `#edit-tool-behavior` and `#write-tool-behavior`, which name only the
    //   `PARTIAL view` disqualifier — so the safer half of the choice is taken
    //   and written down rather than inherited by accident.
    if (view.totalChars === 0) {
      this.filesSeenThisSession.add(path);
      return `${path} exists but its contents are empty.`;
    }
    if (view.pastEnd) {
      const lines = `${view.totalLines} line${view.totalLines === 1 ? '' : 's'}`;
      return `Read of ${path} started past the last line: the file has ${lines} and offset `
        + `${operation.offset} is past the end. Nothing was read, so this does not count as having read the `
        + `file. Read it with an offset between 1 and ${view.totalLines}.`;
    }
    if (view.overBudget || estimateTokensDensityAware(view.text) > tokenLimit) {
      // `tools-reference.md#read-tool-behavior`, second sentence of the pair:
      // "A read that passes an explicit `offset` or `limit` and still exceeds
      // the token limit returns an error." Thrown, so `executeAuthorized`
      // returns it as the tool's error result; the path is NOT recorded, which
      // is the same rule as the notice branch below. The remedies are the
      // page's own, from the paragraph below that pair: "The error tells Claude
      // to use a smaller `limit`, or to search for specific content with Grep
      // instead when a single line is that large."
      if (windowed) {
        throw new Error(
          `Read of ${path} with an explicit offset/limit still exceeds the ${tokenLimit}-token result limit, `
          + 'so the rest of the range was not loaded. Use a smaller limit, drop offset and limit to receive the '
          + 'first page with a PARTIAL view notice, or search the file with Grep when a single line is that large.',
        );
      }
      // The whole-file branch: "Read returns the first page with a `PARTIAL
      // view` notice". Deliberately NOT recorded in `filesSeenThisSession` —
      // this is the clause `requireFileSeenBeforeMutation` was written to
      // enforce and had no subject for until now.
      return partialFileView(view, tokenLimit);
    }
    // P6.558 — the read that satisfies a later write. Recorded AFTER the read
    // succeeded, so a failed read (missing file, permission) grants nothing.
    this.filesSeenThisSession.add(path);
    return view.text;
  }

  /**
   * P6.558 — the token ceiling a file read is measured against, computed the
   * SAME way the Pi tool-result transformer computes it
   * (`pi-agent-server/src/local-tools/tool-wrapper.ts`): the documented operator
   * key when set, else the model-aware threshold.
   *
   * Computing it identically is the point. This bound now lands FIRST, so the
   * result the wrapper sees is already inside the wrapper's own budget and its
   * save-to-disk tier no longer fires for a read — which is what makes the
   * page's notice the answer a large read gets, rather than a second, differently
   * worded truncation on top of the first.
   */
  private fileReadTokenLimit(): number {
    return resolveResultTokenLimit(
      this.options.contextWindow,
      fileReadOutputTokenLimit(process.env, message => this.options.onDebug?.(message)),
    );
  }

  /**
   * P6.558 — read-before-write, the safety half of the Pi read notice.
   *
   * `tools-reference.md#edit-tool-behavior`, verbatim: *"**Read-before-edit**:
   * Claude reads the file in the current conversation before editing it, and a
   * read cut short with a `PARTIAL view` notice doesn't count. Claude Opus 4.6,
   * Claude Haiku 4.5, and older models always require the read. Newer models can
   * edit an unread file when reading it wouldn't need a permission prompt and
   * the Read tool is available."* And `#write-tool-behavior`, on the same rule
   * for overwrites: *"This constraint doesn't apply to new files."*
   *
   * Before this row a `write_file` / `edit_file` / `replace_in_file` on this
   * runtime never asked whether the file had been read at all, so an agent could
   * overwrite a file it had never looked at. That is the harm; the gate is the
   * whole of the fix.
   *
   * Four decisions, each with its reason, because the page does not settle all
   * four and an undocumented choice nobody can see is indistinguishable from a
   * defect:
   *
   * 1. **A new file is exempt**, quoted above. Implemented as "the path does not
   *    exist on disk", which is the only thing this layer can ask.
   * 2. **A file this session WROTE counts as seen.** The page is silent. The
   *    agent authored those bytes, so the conversation knows the content exactly
   *    as a read would make it known, and the alternative — refusing an edit to
   *    the file you just created — is absurd rather than safe.
   * 3. **A windowed read (`offset`/`limit`) counts as seen.** The page's
   *    disqualifier is specifically a read *"cut short with a `PARTIAL view`
   *    notice"*, and `#read-tool-behavior` scopes that notice to a WHOLE-file
   *    read that exceeds the token limit — an explicit `offset`/`limit` read
   *    either succeeds or errors, and a successful one is a normal read.
   * 4. **The page's `PARTIAL view` clause now HAS a subject, and this gate
   *    enforces it.** It did not when the gate landed: Pi constructs the runtime
   *    with `guardLargeResults: false` and `applyLineWindow` is the identity when
   *    both bounds are absent, so a whole-file read here was never cut short. The
   *    notice half (see {@link partialFileView}) is what created the subject — a
   *    whole-file read over the token limit returns the first page with the
   *    page's notice and **does not add its path to `filesSeenThisSession`**, so
   *    a write that follows it is refused here with no further change. The
   *    windowed sibling never reaches this branch at all: the page makes an
   *    over-limit explicit range an ERROR, and an error records nothing either.
   *
   * The refusal names the remedy, because the reader is a model that can act on
   * it in the next tool call.
   *
   * D1.332 — the rule itself (the two exemptions and the sentence) now lives in
   * {@link SessionFileReadLedger}, because RS-76 measured the same overwrite
   * refused here and PERFORMED on claude and codex, and a safety rule a user
   * loses by switching runtimes is worse than one nobody has. The four decisions
   * above stay here: they are about how THIS runtime records a read, which is
   * runtime-shaped. The seams that now share the rule are the claude PreToolUse
   * write path (`claude-agent.ts`) and the codex approval answer path
   * (`CodexAgent.handleServerRequest`).
   */
  private async requireFileSeenBeforeMutation(path: string): Promise<string | undefined> {
    return this.filesSeenThisSession.refuseUnseenWrite(path);
  }

  private async listFiles(operation: Extract<LocalToolOperation, { kind: 'list_files' }>, signal?: AbortSignal): Promise<string> {
    const root = await this.scopedPath(operation.path ?? '.', 'read', signal);
    const recursive = operation.recursive === true;
    const entries: string[] = [];

    const walk = async (dir: string) => {
      const items = await readdir(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = join(dir, item.name);
        entries.push(relative(root, fullPath) || item.name);
        if (recursive && item.isDirectory()) {
          await walk(fullPath);
        }
      }
    };

    await walk(root);
    // P3.105 — file DISCOVERY is the first of the contract's three promises, so
    // a denied file is withheld from a listing exactly as from a search.
    const filtered = await withholdDeniedEntries(
      entries.sort(),
      entry => join(root, entry),
      this.options.filterDeniedResultPaths,
    );
    return appendWithheldNotice(filtered.entries.join('\n'), filtered.withheldFiles);
  }

  private async searchFiles(operation: Extract<LocalToolOperation, { kind: 'search_files' }>, signal?: AbortSignal): Promise<LocalToolExecutionResult> {
    const pattern = requireString(operation.pattern, 'pattern');
    const path = await this.scopedPath(operation.path ?? '.', 'read', signal);
    const command = `rg --line-number --fixed-strings ${shellQuote(pattern)} ${shellQuote(path)}`;
    const commandResult = await this.runCommand(command, this.options.filesystemScope.cwd, {
      semanticId: 'read',
      isolationProfile: 'read-only',
    });
    const missingTool = toolNotFoundResult('rg', commandResult);
    if (missingTool) return missingTool;
    // P3.105 — filtered here, before `guardResult` can persist the text into the
    // session directory: a withheld line must never reach a file on disk either.
    // Only stdout is filtered; stderr carries ripgrep's own diagnostics, which
    // are not results and name no matched file.
    const filtered = await withholdDeniedMatchLines(
      commandResult.stdout,
      path,
      this.options.filterDeniedResultPaths,
    );
    return {
      ...result(appendWithheldNotice(filtered.text || commandResult.stderr, filtered.withheldFiles)),
      ...processBinding(commandResult),
    };
  }

  private async writeFile(
    call: LocalToolCall,
    operation: Extract<LocalToolOperation, { kind: 'write_file' }>,
  ): Promise<LocalToolExecutionResult> {
    const content = requireString(operation.content, 'content');
    const path = await this.scopedPath(requireString(operation.path, 'path'), 'write', call.abortSignal);
    // P6.558 — refused BEFORE `onFileMutationAuthorized`, so a refused write
    // leaves no checkpoint intent behind for a mutation that never happened.
    const unread = await this.requireFileSeenBeforeMutation(path);
    if (unread) return result(unread, true);
    await this.options.onFileMutationAuthorized?.({ call, canonicalPath: path });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
    this.filesSeenThisSession.add(path);
    return result(`Wrote ${path}`);
  }

  private async replaceInFile(
    call: LocalToolCall,
    operation: Extract<LocalToolOperation, { kind: 'replace_in_file' }>,
  ): Promise<LocalToolExecutionResult> {
    const oldString = requireString(operation.oldString, 'oldString');
    const newString = requireString(operation.newString, 'newString');
    const path = await this.scopedPath(requireString(operation.path, 'path'), 'write', call.abortSignal);
    // P6.558 — `replace_in_file` is `edit_file` under another name, so it takes
    // the same gate. Leaving it out would make the gate one rename wide.
    const unread = await this.requireFileSeenBeforeMutation(path);
    if (unread) return result(unread, true);
    await this.options.onFileMutationAuthorized?.({ call, canonicalPath: path });
    const current = await readFile(path, 'utf-8');
    if (!current.includes(oldString)) {
      return result(`Could not find text to replace in ${path}`, true);
    }
    await writeFile(path, current.replace(oldString, newString), 'utf-8');
    this.filesSeenThisSession.add(path);
    return result(`Updated ${path}`);
  }

  private async editFile(
    call: LocalToolCall,
    operation: Extract<LocalToolOperation, { kind: 'edit_file' }>,
  ): Promise<LocalToolExecutionResult> {
    if (!Array.isArray(operation.edits)) {
      throw new Error('Missing edits array');
    }

    const path = await this.scopedPath(requireString(operation.path, 'path'), 'write', call.abortSignal);
    const unread = await this.requireFileSeenBeforeMutation(path);
    if (unread) return result(unread, true);
    await this.options.onFileMutationAuthorized?.({ call, canonicalPath: path });
    const current = await readFile(path, 'utf-8');
    const replacements = buildTextReplacements(current, operation.edits);
    await writeFile(path, applyTextReplacements(current, replacements), 'utf-8');
    this.filesSeenThisSession.add(path);
    return result(`Updated ${path}`);
  }

  private async grep(operation: Extract<LocalToolOperation, { kind: 'grep' }>, signal?: AbortSignal): Promise<LocalToolExecutionResult> {
    const pattern = requireString(operation.pattern, 'pattern');
    const path = await this.scopedPath(operation.path ?? '.', 'read', signal);
    const args = ['rg', '--line-number'];
    if (operation.ignoreCase === true) args.push('--ignore-case');
    if (operation.literal === true) args.push('--fixed-strings');
    if (typeof operation.context === 'number') args.push('--context', String(Math.max(0, Math.floor(operation.context))));
    if (typeof operation.glob === 'string' && operation.glob.length > 0) args.push('--glob', operation.glob);
    args.push(pattern, path);

    const commandResult = await this.runCommand(args.map(shellQuote).join(' '), this.options.filesystemScope.cwd, {
      semanticId: 'grep',
      isolationProfile: 'read-only',
    });
    const missingTool = toolNotFoundResult('rg', commandResult);
    if (missingTool) return missingTool;
    // P3.105 — withheld BEFORE the caller's `limit` is applied, so the limit
    // counts results the reader can actually see rather than being spent on
    // rows that are then removed.
    const filtered = await withholdDeniedMatchLines(
      commandResult.stdout,
      path,
      this.options.filterDeniedResultPaths,
    );
    return {
      ...result(appendWithheldNotice(
        limitLines(filtered.text || commandResult.stderr, operation.limit),
        filtered.withheldFiles,
      )),
      ...processBinding(commandResult),
    };
  }

  /**
   * Glob (our `find`), and its DISCOVERY BUDGET — P6.692.
   *
   * ## The transition, decided before the timeout was wired
   *
   * A Glob timeout ENDS THE CALL with a named terminal reason. It is never a
   * background hand-off: a background task is a handle the model comes back to,
   * and a half-finished file listing is not something to come back to — it is
   * a wrong answer that looks like a right one. The bash path transitions
   * because a long-running shell command has a real result to collect later;
   * a search does not.
   *
   * That decision is already what the code does, and this is the measurement
   * rather than an assumption: `resolveBashTimeoutBehavior`
   * (`config/background-task-settings.ts`) opens `if (input.semanticId !==
   * 'bash') return 'kill'`, and this call passes `semanticId: 'find'`, so the
   * supervisor is never asked to background it. The `backgrounded` branch below
   * is therefore unreachable today and is written anyway, because "unreachable
   * for a reason living in another module" is exactly the accidental safety
   * this plan keeps finding — and because the failure it would otherwise
   * produce is the silent one: `stdout` is empty on a transition, so the model
   * would be handed AN EMPTY FILE LIST as if the search had succeeded.
   *
   * ## Why the timeout is ours and not the command's
   *
   * The budget is enforced with our own `AbortController` beside the
   * `timeout` we pass, because `CommandResult` carries no "timed out" flag on
   * the kill path: a killed `rg` comes back with a non-zero exit and PARTIAL
   * stdout, which `rg` also produces for an ordinary no-match run. Only the
   * caller that set the deadline can tell those apart.
   */
  private async find(operation: Extract<LocalToolOperation, { kind: 'find' }>, signal?: AbortSignal): Promise<LocalToolExecutionResult> {
    const matchesPattern = compileFindPattern(requireString(operation.pattern, 'pattern'));
    const root = await this.scopedPath(operation.path ?? '.', 'read', signal);
    const args = ['rg', '--files', '--hidden', '--glob', '!**/.git/**', root];
    const budgetSeconds = globTimeoutSeconds(process.env, this.options.onDebug);
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, budgetSeconds * 1000);
    let commandResult: CommandResult;
    try {
      commandResult = await this.runCommand(args.map(shellQuote).join(' '), this.options.filesystemScope.cwd, {
        semanticId: 'find',
        isolationProfile: 'read-only',
        timeout: budgetSeconds * 1000,
        signal: deadline.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      return result(
        `File discovery timed out after ${budgetSeconds}s and returned no results. `
        + `Narrow the search path or the pattern, or raise ${GLOB_TIMEOUT_SECONDS_ENV}.`,
        true,
      );
    }
    if (commandResult.backgrounded) {
      // See the docblock: unreachable at HEAD, and a wrong answer if it ever is.
      return result(
        `File discovery exceeded its ${budgetSeconds}s budget. A search is not handed off to a `
        + 'background task, so no results were returned.',
        true,
      );
    }
    // Checked BEFORE the split/filter below, which is what silently turned a
    // missing binary into an empty file list.
    const missingTool = toolNotFoundResult('rg', commandResult);
    if (missingTool) return missingTool;
    const entries = (commandResult.stdout || commandResult.stderr)
      .split(/\r?\n/)
      .map(path => relativeToRoot(root, path.trim()))
      .filter(path => path.length > 0);
    const matches = entries
      .filter(path => matchesPattern(root, path))
      .sort();
    // P3.105 — `--files` IS file discovery, the first clause of the contract.
    const filtered = await withholdDeniedEntries(
      matches,
      entry => join(root, entry),
      this.options.filterDeniedResultPaths,
    );
    return {
      ...result(appendWithheldNotice(
        applyLimit(filtered.entries, operation.limit).join('\n'),
        filtered.withheldFiles,
      )),
      ...processBinding(commandResult),
    };
  }

  private async ls(operation: Extract<LocalToolOperation, { kind: 'ls' }>, signal?: AbortSignal): Promise<string> {
    const root = await this.scopedPath(operation.path ?? '.', 'read', signal);
    const items = await readdir(root, { withFileTypes: true });
    const entries = items
      .map(item => item.isDirectory() ? `${item.name}/` : item.name)
      .sort();
    // P3.105 — the trailing `/` this listing adds to a directory is display
    // spelling, not part of the path; the deny list is asked about the name.
    const filtered = await withholdDeniedEntries(
      entries,
      entry => join(root, entry.endsWith('/') ? entry.slice(0, -1) : entry),
      this.options.filterDeniedResultPaths,
    );
    return appendWithheldNotice(
      applyLimit(filtered.entries, operation.limit).join('\n'),
      filtered.withheldFiles,
    );
  }

  private async bash(
    call: LocalToolCall,
    operation: Extract<LocalToolOperation, { kind: 'bash' }>,
  ): Promise<LocalToolExecutionResult> {
    const command = requireString(operation.command, 'command');
    const cwd = await this.scopedPath(operation.cwd ?? this.options.filesystemScope.cwd, 'read', call.abortSignal);
    const runInBackground = operation.runInBackground === true;
    if (runInBackground && backgroundTasksDisabled()) {
      return result(
        'run_in_background is unavailable: background tasks are disabled (NESSY_DISABLE_BACKGROUND_TASKS=1).',
        true,
      );
    }
    const commandResult = await this.runCommand(command, cwd, {
      timeout: operation.timeout,
      signal: call.abortSignal,
      semanticId: 'bash',
      // Owner decision 2026-07-28: shell commands run with outbound network
      // allowed. `networked` carries the IDENTICAL writable root as
      // `workspace` (see isolation/darwin.ts and isolation/linux.ts, where the
      // two profiles share `writableRoot` and differ only in whether the
      // network deny is applied), so filesystem containment is unchanged and
      // only egress opens. The per-domain egress layer that would narrow this
      // again is parity row R19, deliberately parked.
      isolationProfile: 'networked',
      ...(runInBackground ? { background: true } : {}),
      executionId: call.id,
    });
    if (commandResult.backgrounded) {
      return {
        ...result(formatBackgroundedBashResult(commandResult.backgrounded, this.options.filesystemScope.cwd)),
        ...processBinding(commandResult),
      };
    }
    // P6.558 — `tools-reference.md#edit-tool-behavior`, verbatim: *"Viewing a
    // file with Bash also satisfies the read-before-edit requirement when the
    // command is `cat`, `nl`, `bat`, `batcat`, `head`, `tail`, `sed -n 'X,Yp'`,
    // `grep`, `egrep`, `fgrep`, or `rg` on a single file with no pipes or
    // redirects."* Credited only on a successful foreground run, and only for
    // the unambiguous four — see `bareFileViewerOperand` for why the other seven
    // are deliberately not credited.
    if (commandResult.exitCode === 0) {
      const viewed = bareFileViewerOperand(command);
      if (viewed !== undefined) {
        // A viewer aimed outside the session scope resolves to nothing; such a
        // file cannot be written either, so there is nothing to credit.
        await this.scopedPath(viewed).then(
          resolved => { this.filesSeenThisSession.add(resolved); },
          () => {},
        );
      }
    }
    const content = [commandResult.stdout, commandResult.stderr].filter(Boolean).join('\n');
    // P2.366/P2.367 — the documented output limits, applied HERE because this is
    // the one place the command and its exit code are both in hand, and the
    // classification the page specifies needs both. Valid results pass through
    // untouched (`guardResult` below already gives them the file-plus-preview
    // tier); a failure gets the page's head-and-tail excerpt cut from the
    // `BASH_MAX_OUTPUT_LENGTH` read-back window, which is what makes that
    // operator variable mean anything on this runtime at all. See
    // `config/bash-output-limits.ts` for what is deliberately left alone.
    const shaped = applyBashOutputLimits({
      command,
      exitCode: commandResult.exitCode,
      text: content,
    });
    // P6.690 — the shell cwd reset, said out loud. Appended AFTER the output
    // shaping so the notice is never what a head-and-tail excerpt cuts.
    const reset = shellCwdResetNotice(command, cwd);
    return {
      ...result(reset === undefined ? shaped : `${shaped}\n\n${reset}`, commandResult.exitCode !== 0),
      ...processBinding(commandResult),
    };
  }

  private async mcp(
    operation: Extract<LocalToolOperation, { kind: 'mcp' }>,
    signal?: AbortSignal,
  ): Promise<LocalToolExecutionResult> {
    if (!this.options.mcpPool) {
      return result('MCP tool pool is not available', true);
    }
    if (!this.options.mcpPool.isProxyTool(operation.proxyName, this.options.mcpLeaserId)) {
      return result(`Unknown MCP proxy tool: ${operation.proxyName}`, true);
    }

    // Pass this session's persistence context + leaser identity so a SHARED
    // pool saves large/binary responses into THIS session's dir and enforces
    // the per-session call-authz guard. Absent a leaserId this is
    // byte-equivalent to the pre-sharing call (context falls back to the pool
    // default, which was this same session's path).
    const toolResult = await this.options.mcpPool.callTool(operation.proxyName, operation.args, signal, {
      ...(this.options.sessionPath ? { sessionPath: this.options.sessionPath } : {}),
      ...(this.options.summarizeLargeResult ? { summarize: this.options.summarizeLargeResult } : {}),
      ...(this.options.mcpLeaserId ? { leaserId: this.options.mcpLeaserId } : {}),
    });
    return result(toolResult.content ?? '', !!toolResult.isError, toolResult.structuredContent);
  }

  /**
   * Resolve a path through the captured session scope. An outside-root path
   * raises one structured approval request; on grant the EXACT suspended call
   * resumes (session-lifetime roots join the live scope, request-lifetime
   * roots authorize only this resolution). Denial rethrows with no side effect. F1.957: the asking call's `signal` rides the request, so the card leaves when the call ends first.
   */
  authorizePath(inputPath: string, access: 'read' | 'write' = 'read', signal?: AbortSignal): Promise<string> {
    return this.scopedPath(inputPath, access, signal);
  }

  private async scopedPath(inputPath: string, access: 'read' | 'write' = 'read', signal?: AbortSignal): Promise<string> {
    const scope = this.options.filesystemScope;
    try {
      return resolveScopedPath(inputPath, scope, { access });
    } catch (error) {
      if (!(error instanceof OutsideRootError) || !this.options.requestOutsideRootApproval) throw error;
      const approved = await this.options.requestOutsideRootApproval(error.canonicalTarget, access, signal);
      if (!approved) throw error;
      if (approved.expires === 'session') scope.additionalRoots.push(approved);
      return resolveScopedPath(inputPath, {
        ...scope,
        additionalRoots: [...scope.additionalRoots, approved],
      }, { access });
    }
  }

  private runCommand(
    command: string,
    cwd: string,
    options?: {
      timeout?: number;
      signal?: AbortSignal;
      semanticId?: string;
      isolationProfile?: 'read-only' | 'workspace' | 'networked';
      background?: boolean;
      executionId?: string;
    },
  ): Promise<CommandResult> {
    return this.options.runCommand?.(command, cwd, options) ?? runDefaultCommand(command, cwd, options);
  }

  private async guardResult(
    call: LocalToolCall,
    executionResult: LocalToolExecutionResult,
  ): Promise<LocalToolExecutionResult> {
    if (this.options.guardLargeResults === false
      || !this.options.sessionPath
      || executionResult.content.length === 0) {
      return executionResult;
    }

    // An MCP proxy result was already guarded inside `McpClientPool.callTool`
    // against the documented MCP output limit (`mcp.md:1040`) and the tool's own
    // `anthropic/maxResultSizeChars`. This second guard must re-decide it on the
    // SAME terms, and in particular WITHOUT `contextWindow`: `tokenLimitFor` can
    // only lower a limit, so the window would re-persist here exactly what the
    // pool legitimately kept inline.
    const mcpProxyName = call.operation.kind === 'mcp' ? call.operation.proxyName : undefined;
    const declaredResultSize = mcpProxyName
      ? this.declaredMcpResultSizeChars(mcpProxyName)
      : undefined;

    const guarded = await guardLargeResult(executionResult.content, {
      sessionPath: this.options.sessionPath,
      toolName: call.displayName,
      input: call.permission.input,
      summarize: this.options.summarizeLargeResult,
      ...(mcpProxyName
        ? { tokenLimit: mcpOutputTokenLimit() }
        : { contextWindow: this.options.contextWindow }),
      ...(declaredResultSize !== undefined ? { maxResultSizeChars: declaredResultSize } : {}),
    });

    return guarded ? { ...executionResult, content: guarded } : executionResult;
  }

  /**
   * The tool's own declared result allowance, when the injected pool can report
   * one. Probed as an OPTIONAL member rather than widened into
   * `LocalToolRuntimeOptions['mcpPool']`, the way the nestor-cloud executor
   * already carries an optional `getProxyName?` over its
   * `Pick<McpClientPool, …>` shape: a pool that does not implement the read
   * simply has no declared allowance to report, and the guard falls back to the
   * token limit.
   */
  private declaredMcpResultSizeChars(proxyName: string): number | undefined {
    const pool = this.options.mcpPool as
      (NonNullable<LocalToolRuntimeOptions['mcpPool']> & DeclaredResultSizeReader) | undefined;
    return pool?.declaredResultSizeCharsForProxyTool?.(proxyName, this.options.mcpLeaserId);
  }
}

/** See {@link LocalToolRuntime.declaredMcpResultSizeChars}. */
interface DeclaredResultSizeReader {
  declaredResultSizeCharsForProxyTool?(proxyName: string, leaserId?: string): number | undefined;
}

/**
 * POSIX shells exit 127 for "command not found", and `rg` itself never exits
 * 127 (0 = matched, 1 = no match, 2 = error), so the code alone is unambiguous
 * for the commands built in this file — each one is exactly `rg …`.
 */
const TOOL_NOT_FOUND_EXIT_CODE = 127;

/**
 * The non-127 spellings, kept narrow. `cmd.exe` reports a missing binary as
 * exit 1 with "is not recognized…", and a runner that resolves the binary
 * itself (rather than through a shell) reports the spawn ENOENT. Both branches
 * additionally require the tool's own name in stderr, because these phrases are
 * not unique to a missing tool the way exit 127 is.
 */
const TOOL_NOT_FOUND_STDERR = /command not found|not recognized as an internal or external command|ENOENT/i;

/**
 * P3.149 — the three search operations in this file (`search_files`, `grep`,
 * `find`) all shell out to ripgrep, and none of them checked that it is there.
 * Measured on a host with no `rg` on PATH, before this guard existed:
 *
 *   - `grep` and `search_files` returned `isError: false` with the shell's own
 *     `/bin/sh: rg: command not found` as the tool's CONTENT, so a missing
 *     binary reached the model as an ordinary result;
 *   - `find` was worse — it splits stderr into candidate paths and filters them
 *     through the caller's glob, which discards the error line, so it returned
 *     `isError: false` with an EMPTY body. A missing binary was indistinguishable
 *     from "this workspace contains no matching files": a confident, well-formed,
 *     wrong answer.
 *
 * The check is on the RESULT rather than a pre-flight probe of this process's
 * PATH, and that is deliberate. `runCommand` is injectable
 * (`LocalToolRuntimeOptions.runCommand`) and these calls carry an
 * `isolationProfile`, so the command need not run in this process's environment
 * at all — a host-side `existsSync`/`which` probe would answer for the wrong
 * environment and would be exactly the kind of wrong-looking-right verdict this
 * guard exists to remove. Reading the exit code asks the environment that
 * actually ran the command.
 *
 * Returns null when the result is not a missing-tool result, so a caller can
 * carry on with its own handling.
 */
function toolNotFoundResult(tool: string, commandResult: CommandResult): LocalToolExecutionResult | null {
  const notFound = commandResult.exitCode === TOOL_NOT_FOUND_EXIT_CODE
    || (commandResult.stderr.includes(tool) && TOOL_NOT_FOUND_STDERR.test(commandResult.stderr));
  if (!notFound) return null;

  // Tool-result contract text, English verbatim and never localized — same rule
  // as the R10 background handle below. It names the tool, the package this repo
  // already vendors it from (`resolveRipgrepPath`,
  // agent/backend/internal/runtime-resolver.ts, resolves that same binary for
  // the search service), and the two ways out, so the reader can act on it.
  return result(
    `This tool requires \`${tool}\` (ripgrep), which is not available on this host. `
    + 'Nessy vendors ripgrep as the `@vscode/ripgrep` package; install ripgrep or make '
    + `that binary reachable as \`${tool}\` on PATH. `
    + `Underlying failure: exit ${commandResult.exitCode}${commandResult.stderr.trim() ? `, ${commandResult.stderr.trim()}` : ''}`,
    true,
  );
}

function result(
  content: string,
  isError = false,
  structuredContent?: Record<string, unknown>,
): LocalToolExecutionResult {
  return {
    content,
    isError,
    ...(isError ? { error: content } : {}),
    ...(structuredContent ? { structuredContent } : {}),
  };
}

/**
 * The documented R10 handle for a command now running as a background task.
 *
 * WIRE/tool-result contract text (doc-verification § R10, `tools-reference.md`
 * §Background commands) — English verbatim, never localized:
 * - timeout transition: `Command did not complete within its <N>s timeout and
 *   was moved to the background`, with N equal to the APPLIED timeout;
 * - both shapes carry the task id (our `shell_id`, readable with
 *   `BashOutput`/`Read` and stoppable with `ProcessStop`), the output-file
 *   path, and the exact session-cwd sentence.
 */
export function formatBackgroundedBashResult(
  backgrounded: NonNullable<CommandResult['backgrounded']>,
  sessionCwd: string,
): string {
  const seconds = Math.round(backgrounded.timeoutMs / 1000);
  return [
    ...(backgrounded.timedOut
      ? [`Command did not complete within its ${seconds}s timeout and was moved to the background`]
      : ['Command is running in the background']),
    `shell_id: ${backgrounded.taskId}`,
    `output_file: ${backgrounded.outputFile}`,
    `Session cwd remains ${sessionCwd}; directory changes made by the backgrounded command do not apply to subsequent commands.`,
  ].join('\n');
}

function processBinding(command: CommandResult): Pick<LocalToolExecutionResult, 'isolationProfile' | 'environmentProfile' | 'environmentDigest'> {
  return {
    ...(command.isolationProfile ? { isolationProfile: command.isolationProfile } : {}),
    ...(command.environmentProfile ? { environmentProfile: command.environmentProfile } : {}),
    ...(command.environmentDigest ? { environmentDigest: command.environmentDigest } : {}),
  };
}

function requireString(value: unknown, key: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Missing string argument: ${key}`);
  }
  return value;
}

/**
 * The line window a `read` asks for — and the three things `tools-reference.md`
 * § *Read tool behavior* says about it that this function does not do (P6.347,
 * measured 2026-09-06). Written here rather than left implicit because the
 * divergence is invisible from the call site: a read that returns less than the
 * file looks exactly like a read that returned all of it.
 *
 * The page, verbatim:
 *
 * > By default, Read returns the file from the start. When a whole-file read
 * > exceeds the token limit, Read returns the first page with a `PARTIAL view`
 * > notice that tells Claude how much of the file it received and how to read
 * > more with `offset` and `limit`. A read that passes an explicit `offset` or
 * > `limit` and still exceeds the token limit returns an error.
 *
 * > A read with an explicit `limit` stops as soon as the selected lines exceed
 * > what the token limit could ever fit and returns an error without loading the
 * > rest of the range. … Before v2.1.208, Claude Code loaded the whole range
 * > into memory before rejecting it, so reading a file with an extremely long
 * > single line could run it out of memory.
 *
 * And § *Edit tool behavior*, which is the half that is a safety rule rather
 * than a convenience: "Claude reads the file in the current conversation before
 * editing it, and a read cut short with a `PARTIAL view` notice doesn't count."
 *
 * Measured 2026-09-06, when every clause below was open — and re-measured
 * 2026-09-12 (C3.149), where every one of them is CLOSED by the three rows named
 * further down. The original reading is kept in the past tense rather than
 * deleted, because the divergence it describes is what the code below now
 * exists to remove; the numbers beside it are re-taken, with the instrument
 * named, so a later reader does not carry a two-release-old reading forward:
 *
 * 1. **No `PARTIAL view` notice, in that spelling or any other.** `PARTIAL view`
 *    scored zero files over the tracked TypeScript sources (positive control:
 *    `permissionMode`, 232 files), while the vendored binary carried the
 *    string — so it is the runtime's own, not a doc-only idea. **Re-measured
 *    2026-09-12 against the bundle this tree ships** — both self-reports agree
 *    at `2.1.247` (`claudeCodeVersion` in the SDK package.json; `claude
 *    --version`) — the binary still scores exactly **1** occurrence of it
 *    (`grep -ao 'PARTIAL view' <binary> | wc -l`), with `permissionMode` at 369
 *    occurrences as the control that the probe reads the file and a fabricated
 *    spelling at 0 as the negative. Over this tree the zero is GONE: the same
 *    marker now scores **6** tracked files (`git grep -al … | wc -l` over
 *    `packages/**` + `apps/**` `*.ts`/`*.tsx`, control `permissionMode` 246
 *    files) — this function, {@link partialFileView}'s caller, its three suites
 *    and `config/file-read-output-limit.ts`. What existed
 *    instead is narrower and lives one layer up: `appendReadContinuation`
 *    (`pi-agent-server/src/local-tools/runtime-backed-tools.ts`) appends
 *    `[N more lines in file. Use offset=X to continue.]`, but ONLY when the call
 *    passed an explicit numeric `limit`. A whole-file read was never cut short
 *    here — the window below used to be the identity when both bounds are absent
 *    — so the case the page's notice exists for could not arise at this layer at
 *    all.
 * 2. **An over-large explicit range reproduced the pre-v2.1.208 defect exactly.**
 *    The caller slurped the whole file with `readFile(path, 'utf-8')` and only
 *    then sliced, so a range naming ten lines of a file with one enormous line
 *    loaded all of it. There was no error and no bound.
 * 3. **Nothing couples a partial read to a later write.** A `write_file` /
 *    `edit_file` on this runtime did not ask whether the file was ever read,
 *    let alone whether the read was complete.
 *
 * **CLOSED, P6.558's safety half:** clause 3's base rule now binds — see
 * `LocalToolRuntime.requireFileSeenBeforeMutation`, which refuses a mutation of
 * an existing file this session has not seen. The refinement clause 3 also names
 * — a read that was cut short does not count — had no subject on this runtime
 * when that half landed, for the reason clause 1 gives; the notice half below
 * created one, and decision 4 of
 * {@link LocalToolRuntime.requireFileSeenBeforeMutation}'s docblock is where the
 * gate records that it now enforces it.
 *
 * **CLOSED, P6.558's notice half (clause 1):** {@link partialFileView} spells the
 * page's `PARTIAL view` on the whole-file branch of {@link LocalToolRuntime.readFile},
 * and the over-limit explicit range is the error the same page sentence names.
 * The notice lands HERE rather than beside `appendReadContinuation`
 * (`pi-agent-server/.../runtime-backed-tools.ts`) and the two do not collide:
 * that one fires only when the call passed an explicit numeric `limit`, which is
 * precisely the branch that now errors instead of being cut short — so one
 * result can never carry both.
 *
 * **CLOSED, P6.742 (clause 2), and it was a different job.** This function used
 * to be `applyLineWindow`, a pure slice over a string the caller had already
 * slurped with `readFile(path, 'utf-8')`. It now READS the file itself, keeping
 * at most `charBudget` characters of the requested window, which is the page's
 * *"stops as soon as the selected lines exceed what the token limit could ever
 * fit"* expressed as something a reader can apply while it reads. Peak memory is
 * the budget plus one chunk, so the *"extremely long single line"* the
 * pre-v2.1.208 note names can no longer run the host out of memory.
 *
 * **C3.149 (2026-09-12) found nothing left to build, and that is the row's
 * result rather than a reason to skip it.** The row was funded from the owner's
 * QJ10=A answer against a ledger cell whose evidence is the 2026-09-06 reading
 * above, and every clause of its own *done means* — the notice saying how much
 * arrived and how to read more, an over-large explicit range erroring instead of
 * running the host out of memory, and a file whose only read was partial being
 * REFUSED by Write, each with a positive and a negative test — is landed and
 * green at HEAD: `read-before-write-coupling.test.ts`, `read-bounded-stream.test.ts`,
 * `read-empty-and-past-end-notices.test.ts` and
 * `pi-agent-server/src/local-tools/runtime-backed-tools.test.ts` run **28 pass /
 * 1 skip / 0 fail, 179 expect(), 4 files**. What C3.149 did change is the
 * numbers in clause 1, which had gone two releases stale.
 *
 * Three things worth a reviewer's eye:
 *
 * - **Why `tokenLimit * {@link MAX_CHARS_PER_TOKEN} + 1` is the right budget and
 *   not a guess.** {@link estimateTokens} is the LOOSEST estimator in
 *   {@link estimateTokensDensityAware} — the base64 correction only ever raises
 *   the count — so a window longer than `tokenLimit * 4` characters cannot fit
 *   under any of them. The `+ 1` is what makes reaching the budget proof that it
 *   does not fit, rather than merely suspicion. A test pins that relationship, so
 *   changing the 4-chars/token heuristic goes red here instead of silently
 *   cutting pages that would have fitted.
 * - **The whole-file branch still reaches EOF, and that is not the defect.** The
 *   defect was memory, not I/O: the notice quotes the file's own line count, so
 *   the reader keeps counting lines and characters after it stops RETAINING
 *   them. An explicit range needs no totals and therefore stops dead, which is
 *   the sentence the page writes for it.
 * - **`totalLines` / `totalChars` are exact only when `scanToEnd` was asked
 *   for.** The windowed branch stops early by design, and
 *   {@link partialFileView} — the caller that quotes them into the `PARTIAL
 *   view` notice — runs only on the whole-file branch. **P6.767 adds a second
 *   quoting caller on the windowed branch, and it is exact for a different
 *   reason:** the past-the-end notice can only be reached by a reader that ran
 *   to EOF without ever entering its window, so neither early break fired. See
 *   {@link BoundedLineWindow.pastEnd}.
 */
interface BoundedLineWindow {
  /** The requested window, truncated at the character budget. */
  text: string;
  /**
   * The window did not fit the budget: there was more of it than a result at
   * this token limit could ever carry. The last line of {@link text} may
   * therefore be cut mid-line.
   */
  overBudget: boolean;
  /**
   * Lines in the whole file — exact only when `scanToEnd` was asked for, or
   * when {@link pastEnd} is true (which can only be decided at EOF).
   *
   * P6.767 — a trailing newline TERMINATES the last line, it does not begin
   * another: `"a\nb\n"` is two lines, not the three its `split('\n')` has. The
   * count is quoted to the model by two notices now, and an off-by-one on the
   * commonest file shape there is would be visible in both.
   */
  totalLines: number;
  /** Characters in the whole file — exact only when `scanToEnd` was asked for. */
  totalChars: number;
  /**
   * P6.767 — the requested window starts past the file's last line, so not one
   * character of the file was read. Sound on both branches: reaching this state
   * requires the reader to have passed EOF without ever entering the window, and
   * neither early break can happen without the window having been entered
   * (`lineIndex >= end` implies `lineIndex >= start`, and `overBudget` implies
   * something in the window was kept).
   */
  pastEnd: boolean;
}

/**
 * The loosest chars-per-token any estimator in {@link estimateTokensDensityAware}
 * applies: {@link estimateTokens}'s 4-chars/token heuristic. The base64
 * correction divides by less, so it can only ever return MORE tokens for the
 * same characters — which makes 4 the safe direction for a bound that must not
 * cut a page that would have fitted.
 */
const MAX_CHARS_PER_TOKEN = 4;

async function readBoundedLineWindow(
  path: string,
  offset: number | undefined,
  limit: number | undefined,
  charBudget: number,
  scanToEnd: boolean,
): Promise<BoundedLineWindow> {
  const start = offset === undefined ? 0 : Math.max(0, Math.floor(offset) - 1);
  const end = limit === undefined ? Number.POSITIVE_INFINITY : start + Math.max(0, Math.floor(limit));
  const inWindow = (index: number): boolean => index >= start && index < end;

  const parts: string[] = [];
  let kept = 0;
  let overBudget = false;
  let lineIndex = 0;
  let totalChars = 0;
  let endsWithNewline = false;

  const keep = (text: string): void => {
    if (text.length === 0 || overBudget) return;
    if (kept + text.length >= charBudget) {
      parts.push(text.slice(0, charBudget - kept));
      kept = charBudget;
      overBudget = true;
      return;
    }
    parts.push(text);
    kept += text.length;
  };

  const stream = createReadStream(path, { encoding: 'utf-8' });
  try {
    for await (const chunk of stream) {
      const text = chunk as string;
      if (text.length > 0) endsWithNewline = text.endsWith('\n');
      totalChars += text.length;
      const segments = text.split('\n');
      for (let index = 0; index < segments.length; index += 1) {
        if (index > 0) {
          // A separator belongs to the window only when BOTH the line it ends
          // and the line it starts are inside it — which is also what keeps an
          // empty in-window line from collapsing into its neighbour.
          const previousWasInWindow = inWindow(lineIndex);
          lineIndex += 1;
          if (previousWasInWindow && inWindow(lineIndex)) keep('\n');
        }
        if (inWindow(lineIndex)) keep(segments[index] ?? '');
      }
      if (!scanToEnd && (overBudget || lineIndex >= end)) break;
    }
  } finally {
    stream.destroy();
  }

  // P6.767 — `lineIndex` counts SEPARATORS crossed, so the file's line count is
  // one more than that unless the last separator was the file's final character,
  // in which case it terminated the last line rather than starting a new one.
  const totalLines = totalChars === 0 ? 0 : (endsWithNewline ? lineIndex : lineIndex + 1);
  return { text: parts.join(''), overBudget, totalLines, totalChars, pastEnd: start >= totalLines };
}

/**
 * P6.690 — a `cd` never carries over on this runtime, and until now nothing said
 * so.
 *
 * `tools-reference.md#bash-tool-behavior`, the three sentences that own this,
 * verbatim: *"When Claude runs `cd` in the main session, the new working
 * directory carries over to later Bash commands as long as it stays inside the
 * project directory or an additional working directory you added with
 * `--add-dir`, `/add-dir`, or `additionalDirectories` in settings. Subagent
 * sessions never carry over working directory changes."* — *"If `cd` lands
 * outside those directories, Claude Code resets to the project directory and
 * appends `Shell cwd was reset to <dir>` to the tool result."* — *"To disable
 * this carry-over so every Bash command starts in the project directory, set
 * `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`."*
 *
 * Pi's behaviour is the THIRD sentence, permanently: every call is run with the
 * session cwd, so a `cd` applies inside the one invocation and is gone by the
 * next. That is a legitimate configuration of the documented feature — what was
 * missing is the SECOND sentence, the part that tells the model. A model that
 * runs `cd build` and then `make` gets a `make` in the project root and, before
 * this row, no way to know why.
 *
 * **The wording is the page's, unchanged, and that is the point.** A user or a
 * model that has met `Shell cwd was reset to …` on claude meets the same
 * sentence here, and it is true in exactly the same way: the next command starts
 * in the directory it names. Rewording it into something Pi-specific would make
 * the honest surface unrecognisable at the moment it matters, which is a runtime
 * switch.
 *
 * **What was NOT built, and why** (controller decision on the row, and the
 * owner's less-code rule): the carry-over itself. Making a `cd` persist means
 * per-call shell state for three runtimes inside an SDK-owned tool, and the
 * disclosure is what the row asked for.
 *
 * Conservative in both directions: {@link splitCompoundCommand} returning `null`
 * means the command could not be split safely, and an unparsed command earns no
 * claim about what it did — silence, not a guess. A `cd` inside a subshell is
 * likewise not claimed, because the split does not enter one.
 */
function shellCwdResetNotice(command: string, cwd: string): string | undefined {
  const parts = splitCompoundCommand(command);
  if (parts === null) return undefined;
  if (!parts.some(part => /^cd(\s|$)/.test(part.trim()))) return undefined;
  return `Shell cwd was reset to ${cwd}`;
}

/**
 * P6.558, the rendering half — the page's `PARTIAL view`, in the page's shape.
 *
 * `tools-reference.md#read-tool-behavior`, verbatim: *"By default, Read returns
 * the file from the start. When a whole-file read exceeds the token limit, Read
 * returns the first page with a `PARTIAL view` notice that tells Claude how much
 * of the file it received and how to read more with `offset` and `limit`. A read
 * that passes an explicit `offset` or `limit` and still exceeds the token limit
 * returns an error."*
 *
 * Three things the page does not settle, decided here and visible in the output
 * rather than only in this comment:
 *
 * 1. **A page is a whole number of LINES.** The page says "first page" without
 *    sizing one. Lines are the unit `offset`/`limit` already speak, so a page
 *    boundary that is not a line boundary would make the continuation offset the
 *    notice hands back a lie.
 * 2. **At least one line is always returned.** When not even the first line fits
 *    — a minified bundle on one line, the case `#read-tool-behavior`'s own
 *    pre-v2.1.208 note is about — an empty page plus a notice would tell the
 *    model nothing it could act on. **Amended by P6.742:** that line used to go
 *    out whole and over budget, which IS the pre-v2.1.208 defect; it is now cut
 *    at the budget like everything else, and the notice says so and names the
 *    page's own remedy for it (Grep), because `offset` cannot resume inside a
 *    line. For the same reason a cut last line is never chosen as the page
 *    boundary when there is a complete line to stop at instead.
 * 3. **The counts are ESTIMATES and say so** (`~`), because
 *    {@link estimateTokensDensityAware} is what the budget itself is measured
 *    with; quoting an exact-looking number from an estimator would be the more
 *    confident lie.
 *
 * The line count is found by binary search — the estimate is monotone in the
 * prefix, so this costs O(log n) estimates rather than one per line.
 */
function partialFileView(read: BoundedLineWindow, tokenLimit: number): string {
  const lines = read.text.split('\n');
  // A read stopped at the budget may have cut its LAST line mid-line, and
  // `offset` cannot resume inside a line — so that line is not a candidate page
  // boundary unless it is the only line the page has.
  const candidates = read.overBudget && lines.length > 1 ? lines.length - 1 : lines.length;
  let low = 0
  let high = candidates
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (estimateTokensDensityAware(lines.slice(0, mid).join('\n')) <= tokenLimit) low = mid
    else high = mid - 1
  }
  const shown = Math.max(1, low)
  const page = lines.slice(0, shown).join('\n')
  const cutMidLine = read.overBudget && lines.length === 1
  const continuation = cutMidLine
    ? 'Line 1 alone exceeds what the token limit could ever fit and was cut here. '
      + 'Use offset=2 to continue after it, or search the line with Grep.'
    : `Use offset=${shown + 1} to read the next page, with limit to bound it.`
  // The page's token count is an ESTIMATE and says so; the file's size is a
  // COUNT the reader made while reading, so it is stated as the fact it is
  // rather than dressed up as a second estimate of something never held whole.
  return `${page}\n\n[PARTIAL view: lines 1-${shown} of ${read.totalLines} `
    + `(~${estimateTokensDensityAware(page)} tokens of ${read.totalChars} characters, limit ${tokenLimit} tokens). `
    + continuation + ']';
}

function buildTextReplacements(content: string, edits: LocalToolTextEdit[]): TextReplacement[] {
  const replacements: TextReplacement[] = [];

  for (const edit of edits) {
    const oldText = requireString(edit.oldText, 'oldText');
    const newText = requireString(edit.newText, 'newText');
    if (oldText.length === 0) {
      throw new Error('Edit oldText must not be empty');
    }

    const matches = findAllOccurrences(content, oldText);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one match for edit oldText, found ${matches.length}`);
    }

    const start = matches[0];
    if (start === undefined) {
      throw new Error('Expected exactly one match for edit oldText, found 0');
    }
    replacements.push({ start, end: start + oldText.length, newText });
  }

  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted[index - 1];
    if (current && previous && current.start < previous.end) {
      throw new Error('Edit ranges overlap');
    }
  }

  return replacements;
}

function applyTextReplacements(content: string, replacements: TextReplacement[]): string {
  let next = content;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, replacement.start)}${replacement.newText}${next.slice(replacement.end)}`;
  }
  return next;
}

function findAllOccurrences(content: string, search: string): number[] {
  const matches: number[] = [];
  let index = content.indexOf(search);
  while (index !== -1) {
    matches.push(index);
    index = content.indexOf(search, index + search.length);
  }
  return matches;
}

/**
 * GRANT-GLOB-NEWLINE. No `s` flag, deliberately. This is a file-search filter
 * and decides no permission, so the decision recorded in
 * `config/__tests__/grant-glob-newline-policy.test.ts` applies unchanged.
 *
 * Upstream parity: Pi 0.85.1's own find (`@earendil-works/pi-coding-agent`
 * `dist/core/tools/find.js`) runs `fd --glob` with no case flag, whose dialect
 * is globset's with a literal separator, and Pi's fd 10.4.2 was measured on
 * 2026-09-26 and 2026-09-28 for every rule below (F1.859, F1.995, F1.1044):
 * - a pattern WITHOUT a `/` matches the whole basename, a plain one (no glob
 *   character) included — `root` does not find `root.ts`;
 * - a pattern WITH a `/` matches the ABSOLUTE path (`--full-path`), and gets a
 *   leading `**` + `/` unless it already starts with `/` or `**` + `/`, so
 *   `lib/*.ts` matches at any depth and a pattern naming the searched
 *   directory itself (`src/*.ts` with path `src`) finds its files;
 * - an empty pattern matches every file (fd skips the glob for it);
 * - a single `*` and `?` never cross a `/`; `**` is recursive only as a whole
 *   segment (`**` + `/` at the start of the pattern or of an alternative, or
 *   after a `/`: zero or more directories; `/` + `**` at the end: everything
 *   below), and any other `**` is a single `*`;
 * - `{a,b}` alternates (nesting allowed, an empty alternative is dropped),
 *   `[ab]`, `[a-c]`, `[!ab]` and `[^ab]` are character classes (a class may
 *   match `/`, as globset's does), and a backslash makes the next character
 *   literal;
 * - globset's regex is bytes-mode (`(?-u)`), so the pattern and the path are
 *   compared as UTF-8 BYTES: `?` is one byte (`?.txt` misses `я.txt`, `??.txt`
 *   finds it) and a non-ASCII character in a class is its bytes;
 * - smart case: the match ignores case unless the pattern has an upper-case
 *   letter, which fd reads from the compiled regex — any literal character,
 *   or the first or last character of a class range once the class is
 *   negated and its ranges merged (`[!A-Z]` has none; `[!Z]` has `Y`). Only
 *   ASCII letters fold, a class folds before it negates (`[!a]` excludes
 *   `A`), so `отчет*` does not find `Отчет.txt`;
 * - an unclosed `[` or `{`, or a `}` with no `{`, is an error naming the
 *   problem, as fd refuses the pattern rather than listing nothing.
 *
 * Kept on purpose (not upstream): the absolute path is the canonical search
 * root's, so a pattern naming an ancestor through a symlink does not match;
 * `/` is the only separator matched, where upstream Pi also accepts `\` on
 * Windows (unmeasured there).
 *
 * Named `matchesPattern` until F1.995; older records cite that name.
 */
function compileFindPattern(pattern: string): (root: string, path: string) => boolean {
  if (pattern === '') return () => true;
  const fullPath = pattern.includes('/');
  const effective = fullPath && !pattern.startsWith('/') && !pattern.startsWith('**/') && pattern !== '**'
    ? `**/${pattern}`
    : pattern;
  let regex: RegExp;
  try {
    const exact = globToRegexSource(utf8Bytes(effective), false);
    regex = new RegExp(`^${exact.hasUppercase ? exact.source : globToRegexSource(utf8Bytes(effective), true).source}$`);
  } catch (error) {
    const reason = error instanceof GlobSyntaxError ? error.message : 'invalid character range';
    throw new Error(`Invalid glob pattern '${pattern}': ${reason}.`);
  }
  return fullPath
    ? (root, path) => regex.test(utf8Bytes(join(root, path)))
    : (_root, path) => regex.test(utf8Bytes(basename(path)));
}

class GlobSyntaxError extends Error {}

/** One character per UTF-8 byte, so a regex without the `u` flag matches bytes as fd's does. */
function utf8Bytes(text: string): string {
  return Buffer.from(text, 'utf8').toString('latin1');
}

const isUppercase = (text: string) => /\p{Uppercase}/u.test(text);

/**
 * globset's translation (the crate fd uses), separator-literal, with its rules
 * for where `**` is recursive and its dropping of empty alternatives, over the
 * pattern's UTF-8 bytes. `hasUppercase` is fd's smart-case test; `foldCase`
 * adds the other ASCII case to every letter and class. See
 * {@link compileFindPattern}.
 */
function globToRegexSource(glob: string, foldCase: boolean): { source: string; hasUppercase: boolean } {
  let out = '';
  let literals = '';
  let classHasUppercase = false;
  // One frame per open `{`: the regex before it and its finished alternatives.
  const groups: Array<{ before: string; alternatives: string[] }> = [];
  const literal = (char: string) => {
    literals += char;
    const other = /[a-z]/i.test(char) && foldCase ? (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase()) : '';
    return other ? `[${char}${other}]` : escapeRegexChar(char);
  };
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    // Nothing emitted yet in this pattern or this alternative (globset's `have_tokens`).
    const branchStart = out === '';
    if (char === '\\' && i + 1 < glob.length) {
      out += literal(glob[++i]!);
    } else if (char === '*' && glob[i + 1] === '*') {
      const next = glob[i + 2];
      const endsBranch = next === undefined || (groups.length > 0 && (next === ',' || next === '}'));
      if ((branchStart || glob[i - 1] === '/') && next === '/') {
        out += '(?:.*/)?'; // zero or more whole directories
        i += 2;
      } else {
        // `**` alone, or `/**` closing a branch: everything below. Anywhere else, one `*`.
        out += (branchStart && next === undefined) || (glob[i - 1] === '/' && endsBranch) ? '.*' : '[^/]*';
        i += 1;
      }
    } else if (char === '*') {
      out += '[^/]*';
    } else if (char === '?') {
      out += '[^/]';
    } else if (char === '[') {
      let j = i + 1;
      let negated = false;
      if (glob[j] === '!' || glob[j] === '^') { negated = true; j++; }
      const ranges: Array<[number, number]> = [];
      // A `]` first in the class is a member, not the end.
      if (glob[j] === ']') { ranges.push([0x5d, 0x5d]); j++; }
      while (j < glob.length && glob[j] !== ']') {
        const to = glob[j + 2];
        if (glob[j + 1] === '-' && to !== undefined && to !== ']') {
          ranges.push([glob.charCodeAt(j), to.charCodeAt(0)]);
          j += 3;
        } else {
          ranges.push([glob.charCodeAt(j), glob.charCodeAt(j)]);
          j += 1;
        }
      }
      if (j >= glob.length) throw new GlobSyntaxError("unclosed character class; missing ']'");
      classHasUppercase ||= classRangeEnds(ranges, negated).some(end => isUppercase(String.fromCharCode(end)));
      const folded = foldCase ? ranges.flatMap(([from, to]) => [
        [Math.max(from, 0x61) - 0x20, Math.min(to, 0x7a) - 0x20],
        [Math.max(from, 0x41) + 0x20, Math.min(to, 0x5a) + 0x20],
      ] as Array<[number, number]>).filter(([from, to]) => from <= to) : [];
      const body = [...ranges, ...folded]
        .map(([from, to]) => from === to ? escapeRegexChar(String.fromCharCode(from))
          : `${escapeRegexChar(String.fromCharCode(from))}-${escapeRegexChar(String.fromCharCode(to))}`)
        .join('');
      out += `[${negated ? '^' : ''}${body}]`;
      i = j;
    } else if (char === '{') {
      groups.push({ before: out, alternatives: [] });
      out = '';
    } else if (char === ',' && groups.length > 0) {
      groups[groups.length - 1]!.alternatives.push(out);
      out = '';
    } else if (char === '}') {
      const group = groups.pop();
      if (!group) throw new GlobSyntaxError("unopened alternate group; missing '{'");
      const alternatives = [...group.alternatives, out].filter(alternative => alternative !== '');
      out = group.before + (alternatives.length > 0 ? `(?:${alternatives.join('|')})` : '');
    } else {
      out += literal(char);
    }
  }
  if (groups.length > 0) throw new GlobSyntaxError("unclosed alternate group; missing '}'");
  // fd reads a literal as UTF-8 text; the literal bytes of one character are always adjacent.
  return { source: out, hasUppercase: classHasUppercase || isUppercase(Buffer.from(literals, 'latin1').toString('utf8')) };
}

/**
 * The first and last byte of each range of a class as fd's regex engine
 * stores it: sorted, touching ranges merged, and complemented over the 256
 * bytes when negated. fd's smart case looks only at these.
 */
function classRangeEnds(ranges: ReadonlyArray<[number, number]>, negated: boolean): number[] {
  const merged: Array<[number, number]> = [];
  for (const [from, to] of [...ranges].filter(([from, to]) => from <= to).sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  if (!negated) return merged.flat();
  const complement: number[] = [];
  let next = 0;
  for (const [from, to] of merged) {
    if (from > next) complement.push(next, from - 1);
    next = to + 1;
  }
  if (next <= 0xff) complement.push(next, 0xff);
  return complement;
}

function escapeRegexChar(char: string): string {
  return /[.*+?^${}()|[\]\\/-]/.test(char) ? `\\${char}` : char;
}

function relativeToRoot(root: string, entry: string): string {
  if (!entry) return '';
  if (isAbsolute(entry)) return relative(root, entry);
  return entry.startsWith('./') ? entry.slice(2) : entry;
}

function limitLines(text: string, limit?: number): string {
  if (typeof limit !== 'number') return text;
  return applyLimit(text.split('\n'), limit).join('\n');
}

function applyLimit<T>(items: T[], limit?: number): T[] {
  if (typeof limit !== 'number') return items;
  return items.slice(0, Math.max(0, Math.floor(limit)));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runDefaultCommand(
  command: string,
  cwd: string,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<CommandResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  options?.signal?.addEventListener('abort', onAbort, { once: true });
  if (typeof options?.timeout === 'number' && options.timeout > 0) {
    timeout = setTimeout(() => controller.abort(), options.timeout);
  }

  try {
    const proc = Bun.spawn(['bash', '-lc', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } catch (error) {
    if (controller.signal.aborted) {
      return { stdout: '', stderr: 'Command aborted', exitCode: 130 };
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    options?.signal?.removeEventListener('abort', onAbort);
  }
}
